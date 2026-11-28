import type { Router } from '../router.ts';
import { requireAuth } from '../router.ts';
import { bad, conflict, json, reqStr } from '../http.ts';
import { assertNotLimited, recordAttempt } from '../auth.ts';
import { IN_REQUEST_MAX, defer, drainOutbox, getVapidKeys, rememberOrigin } from '../push.ts';
import { b64uDecode, isB64u } from '../webpush.ts';

/** Devices one person may register (the oldest are dropped first). */
const MAX_DEVICES = 10;

// The server POSTs to whatever endpoint a client registers, so only the push services run by
// browser vendors are accepted. This stops the feature being used to make the Worker call arbitrary URLs.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com', '.push.services.mozilla.com'];

export function checkEndpoint(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

interface ParsedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: 'en' | 'ja';
}

/** Validates the JSON form of a browser PushSubscription (`subscription.toJSON()`), plus the UI language. */
export function parseSubscription(body: Record<string, unknown>): ParsedSubscription {
  const keys = body.keys as Record<string, unknown> | undefined;
  const invalid = () => bad('The notification subscription is invalid.');
  if (typeof body.endpoint !== 'string' || !keys || typeof keys !== 'object') throw invalid();
  const { p256dh, auth } = keys;
  if (!isB64u(p256dh) || !isB64u(auth) || p256dh.length > 100 || auth.length > 40) throw invalid();
  try {
    const pub = b64uDecode(p256dh);
    if (pub.length !== 65 || pub[0] !== 4 || b64uDecode(auth).length !== 16) throw invalid();
  } catch {
    throw invalid();
  }
  if (!checkEndpoint(body.endpoint)) throw bad('Notifications are not supported for this browser.');
  return { endpoint: body.endpoint, p256dh, auth, lang: body.lang === 'ja' ? 'ja' : 'en' };
}

export function pushRoutes(r: Router) {
  // The public half of the VAPID key: the browser needs it to create a subscription.
  r.get('/api/push/key', requireAuth, async (c) => {
    await rememberOrigin(c.env, c.url.origin);
    return json({ public_key: (await getVapidKeys(c.env)).publicKey });
  });

  r.get('/api/me/notifications', requireAuth, async (c) => {
    const uid = c.user!.id;
    const db = c.env.DB;
    const [prefs, devices] = await db.batch([
      db.prepare('SELECT points, redemptions FROM notification_prefs WHERE user_id = ?1').bind(uid),
      db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1').bind(uid),
    ]);
    const p = prefs.results[0] as { points: number; redemptions: number } | undefined;
    return json({
      prefs: { points: p ? !!p.points : true, redemptions: p ? !!p.redemptions : true },
      devices: (devices.results[0] as { n: number }).n,
    });
  });

  r.put('/api/me/notifications', requireAuth, async (c) => {
    const body = await c.body();
    const pick = (v: unknown) => {
      if (v === undefined) return null;
      if (typeof v !== 'boolean') throw bad('Notification settings must be true or false.');
      return v ? 1 : 0;
    };
    const points = pick(body.points);
    const redemptions = pick(body.redemptions);
    if (points === null && redemptions === null) throw bad('Nothing to update.');
    await c.env.DB
      .prepare(
        `INSERT INTO notification_prefs (user_id, points, redemptions) VALUES (?1, COALESCE(?2, 1), COALESCE(?3, 1))
         ON CONFLICT(user_id) DO UPDATE SET points = COALESCE(?2, points), redemptions = COALESCE(?3, redemptions)`,
      )
      .bind(c.user!.id, points, redemptions)
      .run();
    return json({ ok: true });
  });

  // Register (or refresh) this device. An endpoint belongs to one person: registering it again moves it.
  r.post('/api/me/push/subscribe', requireAuth, async (c) => {
    const sub = parseSubscription(await c.body());
    const uid = c.user!.id;
    const key = `pushsub:${uid}`;
    await assertNotLimited(c.env, key, 30, 3600);
    await recordAttempt(c.env, key);
    const db = c.env.DB;
    await db.batch([
      db
        .prepare(
          `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, lang) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
             auth = excluded.auth, lang = excluded.lang, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(uid, sub.endpoint, sub.p256dh, sub.auth, sub.lang),
      db
        .prepare(
          `DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN
             (SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2)`,
        )
        .bind(uid, MAX_DEVICES),
      db.prepare('INSERT OR IGNORE INTO notification_prefs (user_id) VALUES (?1)').bind(uid),
    ]);
    await rememberOrigin(c.env, c.url.origin);
    return json({ ok: true }, 201);
  });

  // Does this device belong to the signed-in person? (The browser may hold another account's subscription.)
  r.post('/api/me/push/status', requireAuth, async (c) => {
    const endpoint = reqStr((await c.body()).endpoint, 'Endpoint', 1, 2048);
    const row = await c.env.DB
      .prepare('SELECT lang FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2')
      .bind(endpoint, c.user!.id)
      .first<{ lang: string }>();
    return json({ subscribed: !!row, lang: row?.lang ?? null });
  });

  r.post('/api/me/push/unsubscribe', requireAuth, async (c) => {
    const endpoint = reqStr((await c.body()).endpoint, 'Endpoint', 1, 2048);
    await c.env.DB
      .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2')
      .bind(endpoint, c.user!.id)
      .run();
    return json({ ok: true });
  });

  // "Send a test notification": lets a person check that their device really receives messages.
  r.post('/api/me/push/test', requireAuth, async (c) => {
    const uid = c.user!.id;
    const key = `pushtest:${uid}`;
    await assertNotLimited(c.env, key, 5, 600);
    await recordAttempt(c.env, key);
    const now = Math.floor(Date.now() / 1000);
    const res = await c.env.DB
      .prepare(
        `INSERT INTO push_outbox (subscription_id, kind, data, next_attempt_at, created_at)
         SELECT id, 'test', '{}', ?2, ?2 FROM push_subscriptions WHERE user_id = ?1`,
      )
      .bind(uid, now)
      .run();
    const devices = res.meta?.changes ?? 0;
    if (!devices) throw conflict('no_devices', 'Turn on notifications on this device first.');
    await defer(c, drainOutbox(c.env, IN_REQUEST_MAX));
    return json({ ok: true, devices });
  });
}
