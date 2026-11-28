// Push notifications: which events produce a message, how messages are queued and delivered.
//
// Design
//  - Events are *derived from rows that already exist*: the append-only point ledger (awards,
//    deductions, cancellations, refunds) and the audit log (a redemption was completed). A cursor per
//    table (app_settings) remembers how far we have read, so every event is announced exactly once and
//    no route handler has to know about notifications.
//  - Each event becomes one `push_outbox` row per registered device. Rows are delivered right after the
//    request that caused them (ExecutionContext.waitUntil) and, as a safety net, by a cron job every
//    minute. Delivery that fails for a transient reason is retried with a back-off; a device whose
//    push service says "gone" (404/410) is removed.
//  - A Worker invocation may only make a limited number of subrequests (50 on the free plan), so one
//    drain sends at most IN_REQUEST_MAX / CRON_MAX messages and leaves the rest for the next minute.

import type { Env } from './types.ts';
import type { Exec } from './router.ts';
import { chunk } from './http.ts';
import { generateVapidKeys, sendWebPush } from './webpush.ts';
import type { VapidKeys } from './webpush.ts';

export const PUSH_CRON = '* * * * *';
/** Messages sent right after a request (it already used some of its subrequest budget). */
export const IN_REQUEST_MAX = 12;
/** Messages sent per minute by the cron job. */
export const CRON_MAX = 40;
const MAX_ATTEMPTS = 4;
/** Seconds to wait before attempt n+1, indexed by the number of attempts made so far. */
const BACKOFF = [0, 60, 300, 900];
const LEASE_SECONDS = 120;
const CONCURRENCY = 8;

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- background work ----------
/**
 * Runs `work` after the response when an ExecutionContext exists (production), otherwise the caller
 * awaits it (tests). Failures are logged, never thrown: notifications must not break a request.
 */
export function defer(c: { exec?: Exec }, work: Promise<unknown>): Promise<void> {
  const safe = work.then(
    () => undefined,
    (e) => console.error('push: background task failed', e),
  );
  if (c.exec) {
    c.exec.waitUntil(safe);
    return Promise.resolve();
  }
  return safe;
}

// ---------- VAPID identity ----------
const vapidCache = new WeakMap<object, Promise<VapidKeys>>();

/** The key pair that identifies this server to push services: from the environment, or generated once and kept in D1. */
export function getVapidKeys(env: Env): Promise<VapidKeys> {
  let p = vapidCache.get(env.DB);
  if (!p) {
    p = loadVapidKeys(env).catch((e) => {
      vapidCache.delete(env.DB);
      throw e;
    });
    vapidCache.set(env.DB, p);
  }
  return p;
}

async function loadVapidKeys(env: Env): Promise<VapidKeys> {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim() };
  }
  const read = async (): Promise<VapidKeys | null> => {
    const { results } = await env.DB
      .prepare(`SELECT key, value FROM app_settings WHERE key IN ('vapid_public','vapid_private')`)
      .all<{ key: string; value: string }>();
    const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
    return m.vapid_public && m.vapid_private ? { publicKey: m.vapid_public, privateKey: m.vapid_private } : null;
  };
  let keys = await read();
  if (!keys) {
    const fresh = await generateVapidKeys();
    // One statement inserts both values; if two requests race, the first pair wins and both read it back.
    await env.DB
      .prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('vapid_public', ?1), ('vapid_private', ?2)`)
      .bind(fresh.publicKey, fresh.privateKey)
      .run();
    keys = await read();
  }
  if (!keys) throw new Error('Could not load the Web Push keys.');
  return keys;
}

/** Remembers this site's origin; it becomes the contact (`sub`) in VAPID tokens. */
export async function rememberOrigin(env: Env, origin: string): Promise<void> {
  if (!origin.startsWith('https://')) return;
  await env.DB
    .prepare(`INSERT INTO app_settings (key, value) VALUES ('site_origin', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(origin)
    .run();
}

async function vapidSubject(env: Env): Promise<string> {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'site_origin'`).first<{ value: string }>();
  return row?.value ?? 'mailto:admin@localhost.invalid';
}

// ---------- message text ----------
export type Lang = 'en' | 'ja';

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping the notification leads (a path inside the app). */
  url: string;
  tag?: string;
}

const clip = (v: unknown, max: number) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

const POINT_TITLES: Record<string, [string, string]> = {
  'tx.award': ['Points awarded', 'ポイントが付与されました'],
  'tx.deduction': ['Points deducted', 'ポイントが減算されました'],
  'tx.award_cancel': ['Award cancelled', '付与が取り消されました'],
  'tx.correction': ['Points corrected', 'ポイントが訂正されました'],
};

/** Turns a queued event into the text shown on the device, in the language the device registered with. */
export function renderMessage(kind: string, data: Record<string, unknown>, lang: Lang): PushMessage | null {
  const ja = lang === 'ja';
  const amount = Number(data.amount ?? 0);
  const reward = clip(data.reward, 60);

  if (kind in POINT_TITLES) {
    const parts = [`${signed(amount)} ${ja ? 'pt' : 'pts'}`];
    const reason = clip(data.reason, 80);
    if (reason) parts.push(reason);
    if (typeof data.balance === 'number') parts.push(`${ja ? '残高' : 'Balance'} ${data.balance}`);
    return { title: POINT_TITLES[kind][ja ? 1 : 0], body: parts.join(' · '), url: '/#/history' };
  }
  switch (kind) {
    case 'tx.redeem_cancel':
      return {
        title: ja ? '景品リクエストが取り消されました' : 'Reward request cancelled',
        body: ja ? `${reward}: ${amount}ポイントが返却されました` : `${reward}: ${amount} points were returned`,
        url: '/#/rewards',
      };
    case 'redeem.completed':
      return {
        title: ja ? '景品の交換が完了しました' : 'Reward redemption completed',
        body: reward,
        url: '/#/rewards',
      };
    case 'test':
      return {
        title: 'LAP Rewards',
        body: ja ? 'この端末で通知が届いています。' : 'Notifications are working on this device.',
        url: '/',
        tag: 'lap-test',
      };
    default:
      return null;
  }
}

// ---------- detecting events ----------
// Both statements only run while the cursor still holds the value we read (?4), so two overlapping
// runs can never announce the same rows twice. They are executed in one batch with the cursor update.
const TX_EVENTS_SQL = `
  INSERT INTO push_outbox (subscription_id, kind, data, next_attempt_at, created_at)
  SELECT s.id, 'tx.' || t.type,
         json_object('amount', t.amount, 'reason', t.reason, 'balance', t.balance_after, 'reward', w.name),
         ?1, ?1
  FROM point_transactions t
  JOIN users u ON u.id = t.student_id AND u.is_active = 1
  JOIN push_subscriptions s ON s.user_id = t.student_id
  LEFT JOIN notification_prefs p ON p.user_id = t.student_id
  LEFT JOIN redemptions r ON t.type = 'redeem_cancel' AND r.transaction_id = t.ref_transaction_id
  LEFT JOIN rewards w ON w.id = r.reward_id
  WHERE t.id > ?2 AND t.id <= ?3
    AND t.type IN ('award','deduction','award_cancel','correction','redeem_cancel')
    AND COALESCE(CASE t.type WHEN 'redeem_cancel' THEN p.redemptions ELSE p.points END, 1) = 1
    AND (SELECT value FROM app_settings WHERE key = 'push_tx_cursor') = ?4`;

// "Completed" leaves no ledger row, so it is read from the audit log. Only the first entry per
// redemption counts (a double click writes a second one), and only if it really is completed now.
const COMPLETED_EVENTS_SQL = `
  INSERT INTO push_outbox (subscription_id, kind, data, next_attempt_at, created_at)
  SELECT s.id, 'redeem.completed', json_object('reward', w.name), ?1, ?1
  FROM audit_logs a
  JOIN redemptions r ON r.id = a.target_id AND r.status = 'completed'
  JOIN rewards w ON w.id = r.reward_id
  JOIN users u ON u.id = r.student_id AND u.is_active = 1
  JOIN push_subscriptions s ON s.user_id = r.student_id
  LEFT JOIN notification_prefs p ON p.user_id = r.student_id
  WHERE a.id > ?2 AND a.id <= ?3
    AND a.action = 'redemption.complete' AND a.target_type = 'redemption'
    AND COALESCE(p.redemptions, 1) = 1
    AND NOT EXISTS (SELECT 1 FROM audit_logs a0 WHERE a0.action = a.action AND a0.target_id = a.target_id AND a0.id < a.id)
    AND (SELECT value FROM app_settings WHERE key = 'push_audit_cursor') = ?4`;

/** Queues messages for everything that happened since the last run. Returns the number of queued messages. */
export async function enqueueNewEvents(env: Env): Promise<number> {
  const db = env.DB;
  const [cur, max] = await db.batch([
    db.prepare(`SELECT key, value FROM app_settings WHERE key IN ('push_tx_cursor','push_audit_cursor')`),
    db.prepare(
      `SELECT (SELECT COALESCE(MAX(id), 0) FROM point_transactions) AS tx,
              (SELECT COALESCE(MAX(id), 0) FROM audit_logs) AS audit`,
    ),
  ]);
  const cursors = Object.fromEntries((cur.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const top = max.results[0] as { tx: number; audit: number };
  const txLo = cursors.push_tx_cursor;
  const auditLo = cursors.push_audit_cursor;
  if (txLo === undefined || auditLo === undefined) return 0;

  const now = nowSec();
  const advance = (key: string, to: number, from: string) =>
    db.prepare(`UPDATE app_settings SET value = ?1 WHERE key = ?2 AND value = ?3`).bind(String(to), key, from);
  const stmts: D1PreparedStatement[] = [];
  let queued = 0;
  const countAt: number[] = [];
  if (top.tx > Number(txLo)) {
    countAt.push(stmts.length);
    stmts.push(db.prepare(TX_EVENTS_SQL).bind(now, Number(txLo), top.tx, txLo), advance('push_tx_cursor', top.tx, txLo));
  }
  if (top.audit > Number(auditLo)) {
    countAt.push(stmts.length);
    stmts.push(db.prepare(COMPLETED_EVENTS_SQL).bind(now, Number(auditLo), top.audit, auditLo), advance('push_audit_cursor', top.audit, auditLo));
  }
  if (!stmts.length) return 0;
  const res = await db.batch(stmts);
  for (const i of countAt) queued += res[i].meta?.changes ?? 0;
  return queued;
}

// ---------- delivery ----------
interface Claimed {
  id: number;
  subscription_id: number;
  kind: string;
  data: string;
  attempts: number;
}
interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: Lang;
  is_active: number;
}

// Claiming leases the rows for a while, so an overlapping run (request + cron) does not send them twice,
// and rows of a run that died come back by themselves.
const CLAIM_SQL = `
  UPDATE push_outbox SET attempts = attempts + 1, next_attempt_at = ?1 + ${LEASE_SECONDS}
  WHERE id IN (SELECT id FROM push_outbox WHERE next_attempt_at <= ?1 ORDER BY id LIMIT ?2)
  RETURNING id, subscription_id, kind, data, attempts`;

const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

export interface DrainResult {
  sent: number;
  retried: number;
  dropped: number;
  removedDevices: number;
}

/** Sends up to `max` queued messages. */
export async function drainOutbox(env: Env, max: number, fetchImpl?: typeof fetch): Promise<DrainResult> {
  const db = env.DB;
  const now = nowSec();
  const out: DrainResult = { sent: 0, retried: 0, dropped: 0, removedDevices: 0 };

  const { results: claimed } = await db.prepare(CLAIM_SQL).bind(now, max).all<Claimed>();
  if (!claimed.length) return out;

  const subIds = [...new Set(claimed.map((r) => r.subscription_id))];
  const { results: subs } = await db
    .prepare(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth, s.lang, u.is_active
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id
       WHERE s.id IN (${placeholders(subIds.length)})`,
    )
    .bind(...subIds)
    .all<SubRow>();
  const byId = new Map(subs.map((s) => [s.id, s]));

  const keys = await getVapidKeys(env);
  const subject = await vapidSubject(env);

  const finished: number[] = [];
  const goneDevices = new Set<number>();
  const retry: [id: number, at: number][] = [];

  const fail = (row: Claimed, endpoint: string, why: string) => {
    console.warn(`push: delivery to ${new URL(endpoint).host} failed (${why}), attempt ${row.attempts}`);
    if (row.attempts >= MAX_ATTEMPTS) {
      finished.push(row.id);
      out.dropped++;
    } else {
      retry.push([row.id, now + BACKOFF[Math.min(row.attempts, BACKOFF.length - 1)]]);
      out.retried++;
    }
  };

  const sendOne = async (row: Claimed) => {
    const sub = byId.get(row.subscription_id);
    if (!sub || !sub.is_active) return void finished.push(row.id); // device or account is gone
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      /* keep empty */
    }
    const message = renderMessage(row.kind, data, sub.lang);
    if (!message) return void finished.push(row.id);
    try {
      const res = await sendWebPush(sub, message, { keys, subject, fetchImpl });
      if (res.ok) {
        out.sent++;
        finished.push(row.id);
      } else if (res.gone) {
        goneDevices.add(sub.id);
        finished.push(row.id);
      } else {
        fail(row, sub.endpoint, `HTTP ${res.status}`);
      }
    } catch (e) {
      fail(row, sub.endpoint, String((e as Error)?.message ?? e));
    }
  };

  for (const part of chunk(claimed, CONCURRENCY)) await Promise.all(part.map(sendOne));

  const stmts: D1PreparedStatement[] = [];
  for (const ids of chunk(finished, 50)) {
    stmts.push(db.prepare(`DELETE FROM push_outbox WHERE id IN (${placeholders(ids.length)})`).bind(...ids));
  }
  if (goneDevices.size) {
    const ids = [...goneDevices];
    stmts.push(db.prepare(`DELETE FROM push_subscriptions WHERE id IN (${placeholders(ids.length)})`).bind(...ids));
    out.removedDevices = ids.length;
  }
  for (const [id, at] of retry) stmts.push(db.prepare('UPDATE push_outbox SET next_attempt_at = ?1 WHERE id = ?2').bind(at, id));
  if (stmts.length) await db.batch(stmts);
  return out;
}

/** Detect new events, queue them, and send what fits into this invocation's budget. */
export async function dispatchPushEvents(env: Env, max = IN_REQUEST_MAX, fetchImpl?: typeof fetch): Promise<void> {
  await enqueueNewEvents(env);
  await drainOutbox(env, max, fetchImpl);
}

/** Every minute: a safety net for anything the request-time dispatch could not finish. */
export const runPushCron = (env: Env) => dispatchPushEvents(env, CRON_MAX);

/** Statements for the daily clean-up (used by runScheduled). */
export function pushCleanupStmts(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    // Messages older than the 24 h TTL are useless.
    db.prepare('DELETE FROM push_outbox WHERE created_at < ?1').bind(now - 86_400),
    // Anonymized accounts keep their row, so the foreign key does not remove their devices.
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE '~deleted-%')`),
  ];
}
