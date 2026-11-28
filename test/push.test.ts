// End-to-end tests of push notifications against the real Worker code and a fake push service.
// Events are triggered the way the app triggers them (award / redemption routes, ledger rows) and the
// messages that "arrive" are decrypted exactly as a browser would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, key } from './helpers.ts';
import { FakeD1, makeEnv } from './fake.ts';
import { decrypt, newBrowserSubscription } from './push-helpers.ts';
import { ensureSchema } from '../src/db.ts';
import { MIGRATIONS } from '../src/migrations.ts';
import { hashPassword } from '../src/auth.ts';
import { insertCancel, insertTx } from '../src/ledger.ts';
import { runScheduled } from '../src/index.ts';
import { CRON_MAX, IN_REQUEST_MAX, dispatchPushEvents, drainOutbox, enqueueNewEvents, runPushCron } from '../src/push.ts';
import { b64uDecode } from '../src/webpush.ts';

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };

/** Replaces the global fetch with a fake push service for the duration of one test. */
function pushService(t: { after(fn: () => void): void }) {
  const real = globalThis.fetch;
  const svc = {
    sent: [] as Sent[],
    status: (_url: string): number => 201,
  };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    svc.sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    return new Response(null, { status: svc.status(url) });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  return svc;
}

const browser = await newBrowserSubscription(); // one fake browser key pair is enough: endpoints differ per device
const endpointOf = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
const subBody = (n: number, lang: 'en' | 'ja' = 'en') => ({
  endpoint: endpointOf(n), keys: { p256dh: browser.p256dh, auth: browser.auth }, lang,
});
const read = (m: Sent) => decrypt(m.body, browser.d, browser.p256dh, browser.auth).then((s) => JSON.parse(s));

async function world() {
  const env = makeEnv();
  const raw = (env.DB as unknown as FakeD1).raw;
  const admin = new Client(env, '10.0.0.1');
  let r = await admin.post('/api/setup', { token: 'setup-token-for-tests', login_id: 'admin', nickname: 'Admin', password: 'adminpass1' });
  assert.equal(r.status, 201);
  await admin.login('admin', 'adminpass1');

  // A teacher, created directly in the database.
  raw.prepare(`INSERT INTO users (login_id, nickname, password_hash, role) VALUES ('teacher1', 'Ms Teacher', ?1, 'teacher')`)
    .run(await hashPassword('teacherpass1', 1000));
  const teacher = new Client(env, '10.0.0.2');
  assert.equal((await teacher.login('teacher1', 'teacherpass1')).status, 200);

  const people: Record<string, Client> = {};
  const ids: Record<string, number> = {};
  for (const [i, name] of ['alice', 'bob'].entries()) {
    const c = new Client(env, `10.0.1.${i}`);
    r = await c.post('/api/auth/register', { nickname: name, login_id: name, password: 'studentpass1', password_confirm: 'studentpass1' });
    assert.equal(r.status, 201);
    await c.login(name, 'studentpass1');
    people[name] = c;
    ids[name] = (raw.prepare('SELECT id FROM users WHERE login_id = ?1').get(name) as { id: number }).id;
  }
  const outbox = () => (raw.prepare('SELECT * FROM push_outbox ORDER BY id').all() as any[]);
  const devices = () => (raw.prepare('SELECT * FROM push_subscriptions ORDER BY id').all() as any[]);
  return { env, raw, admin, teacher, alice: people.alice, bob: people.bob, ids, outbox, devices };
}

test('registering a device validates the subscription and the push service host', async () => {
  const w = await world();
  const { alice } = w;
  assert.equal((await new Client(w.env).post('/api/me/push/subscribe', subBody(1))).status, 401, 'sign-in required');

  const bad = async (patch: object, status = 400) =>
    assert.equal((await alice.post('/api/me/push/subscribe', { ...subBody(1), ...patch })).status, status, JSON.stringify(patch));
  await bad({ endpoint: 'http://fcm.googleapis.com/fcm/send/x' });                 // not https
  await bad({ endpoint: 'https://evil.example/hook' });                            // not a push service
  await bad({ endpoint: 'https://fcm.googleapis.com.evil.example/x' });            // look-alike host
  await bad({ endpoint: 'https://user:pw@fcm.googleapis.com/x' });                 // credentials
  await bad({ endpoint: 'https://fcm.googleapis.com:8443/x' });                    // odd port
  await bad({ endpoint: 'https://127.0.0.1/x' });
  await bad({ keys: { p256dh: browser.p256dh, auth: 'AAAA' } });                   // auth must be 16 bytes
  await bad({ keys: { p256dh: 'AAAA', auth: browser.auth } });                     // key must be a 65-byte point
  await bad({ keys: { p256dh: 'not base64url!', auth: browser.auth } });
  await bad({ keys: undefined });
  assert.equal(w.devices().length, 0);

  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com', 'jp1.web.push.apple.com']) {
    const r = await alice.post('/api/me/push/subscribe', { ...subBody(1), endpoint: `https://${host}/token-${host}` });
    assert.equal(r.status, 201, host);
  }
  assert.equal(w.devices().length, 5);
});

test('a device belongs to one person, can be checked and removed, and is capped', async () => {
  const w = await world();
  assert.equal((await w.alice.post('/api/me/push/subscribe', subBody(1))).status, 201);
  assert.deepEqual((await w.alice.post('/api/me/push/status', { endpoint: endpointOf(1) })).data, { subscribed: true, lang: 'en' });
  assert.deepEqual((await w.bob.post('/api/me/push/status', { endpoint: endpointOf(1) })).data, { subscribed: false, lang: null });

  // Another person signing in on the same browser and enabling notifications takes the device over.
  assert.equal((await w.bob.post('/api/me/push/subscribe', subBody(1, 'ja'))).status, 201);
  assert.equal(w.devices().length, 1);
  assert.equal(w.devices()[0].user_id, w.ids.bob);
  assert.equal(w.devices()[0].lang, 'ja');
  assert.equal((await w.alice.post('/api/me/push/status', { endpoint: endpointOf(1) })).data.subscribed, false);

  // Removing someone else's device does nothing.
  await w.alice.post('/api/me/push/unsubscribe', { endpoint: endpointOf(1) });
  assert.equal(w.devices().length, 1);
  await w.bob.post('/api/me/push/unsubscribe', { endpoint: endpointOf(1) });
  assert.equal(w.devices().length, 0);

  // At most 10 devices per person; the least recently used are dropped first.
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  for (let n = 100; n < 110; n++) {
    assert.equal((await w.alice.post('/api/me/push/subscribe', subBody(n))).status, 201);
    await pause();
  }
  assert.equal(w.devices().filter((d) => d.user_id === w.ids.alice).length, 10);
  await w.alice.post('/api/me/push/subscribe', subBody(100)); // using the oldest device again makes it the newest
  await pause();
  await w.alice.post('/api/me/push/subscribe', subBody(110)); // the 11th device pushes out the least recently used one
  const mine = w.devices().filter((d) => d.user_id === w.ids.alice).map((d) => d.endpoint);
  assert.equal(mine.length, 10);
  assert.ok(mine.includes(endpointOf(100)) && mine.includes(endpointOf(110)));
  assert.ok(!mine.includes(endpointOf(101)), 'the least recently used device was dropped');
});

test('notification preferences default to on and can be changed', async () => {
  const w = await world();
  assert.deepEqual((await w.alice.get('/api/me/notifications')).data, { prefs: { points: true, redemptions: true }, devices: 0 });
  assert.equal((await w.alice.call('PUT', '/api/me/notifications', { points: false })).status, 200);
  assert.deepEqual((await w.alice.get('/api/me/notifications')).data.prefs, { points: false, redemptions: true });
  await w.alice.call('PUT', '/api/me/notifications', { redemptions: false });
  assert.deepEqual((await w.alice.get('/api/me/notifications')).data.prefs, { points: false, redemptions: false });
  await w.alice.call('PUT', '/api/me/notifications', { points: true });
  assert.deepEqual((await w.alice.get('/api/me/notifications')).data.prefs, { points: true, redemptions: false });
  assert.equal((await w.alice.call('PUT', '/api/me/notifications', {})).status, 400);
  assert.equal((await w.alice.call('PUT', '/api/me/notifications', { points: 'yes' })).status, 400);
  assert.deepEqual((await w.bob.get('/api/me/notifications')).data.prefs, { points: true, redemptions: true }, 'per person');
});

test('an award is delivered once, only to the awarded student\'s devices, encrypted and VAPID-signed', async (t) => {
  const svc = pushService(t);
  const w = await world();
  await w.alice.post('/api/me/push/subscribe', subBody(1));
  await w.alice.post('/api/me/push/subscribe', subBody(2)); // a second device
  // bob has no device

  const body = { student_ids: [w.ids.alice, w.ids.bob], amount: 10, reason: 'Passed the unit 3 quiz', key: key() };
  assert.equal((await w.teacher.post('/api/points/award', body)).status, 201);

  assert.equal(svc.sent.length, 2, 'two devices of alice, nothing for bob');
  assert.deepEqual(svc.sent.map((m) => m.url).sort(), [endpointOf(1), endpointOf(2)]);
  const m = await read(svc.sent[0]);
  assert.deepEqual(m, { title: 'Points awarded', body: '+10 pts · Passed the unit 3 quiz · Balance 10', url: '/#/history' });
  const h = svc.sent[0].headers;
  assert.equal(h['content-encoding'], 'aes128gcm');
  assert.match(h.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const claims = JSON.parse(Buffer.from(h.authorization.split('t=')[1].split('.')[1], 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://t.example', 'contact is this site');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
  assert.equal(w.outbox().length, 0, 'delivered rows are removed');

  // The same submission again changes nothing, so nothing is announced again.
  await w.teacher.post('/api/points/award', body);
  await dispatchPushEvents(w.env);
  assert.equal(svc.sent.length, 2);
});

test('the key the browser subscribes with is the key the messages are signed with', async (t) => {
  const svc = pushService(t);
  const w = await world();
  const { public_key } = (await w.alice.get('/api/push/key')).data;
  assert.equal(b64uDecode(public_key).length, 65);
  assert.equal((await w.alice.get('/api/push/key')).data.public_key, public_key, 'stable');
  assert.equal((await new Client(w.env).get('/api/push/key')).status, 401);
  await w.alice.post('/api/me/push/subscribe', subBody(1));
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice], amount: 1, reason: 'x', key: key() });
  assert.ok(svc.sent[0].headers.authorization.endsWith(`k=${public_key}`));
});

test('messages are written in the language the device registered with', async (t) => {
  const svc = pushService(t);
  const w = await world();
  await w.alice.post('/api/me/push/subscribe', subBody(1, 'ja'));
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice], amount: 5, reason: '課題提出', key: key() });
  assert.deepEqual(await read(svc.sent[0]), { title: 'ポイントが付与されました', body: '+5 pt · 課題提出 · 残高 5', url: '/#/history' });
});

test('a person who turned a category off does not receive it, the other category still works', async (t) => {
  const svc = pushService(t);
  const w = await world();
  await w.alice.post('/api/me/push/subscribe', subBody(1));
  await w.alice.call('PUT', '/api/me/notifications', { points: false });
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice], amount: 50, reason: 'bonus', key: key() });
  assert.equal(svc.sent.length, 0);

  // redemptions are still on
  const rw = w.raw.prepare(`INSERT INTO rewards (name, cost) VALUES ('Cookie', 20)`).run();
  await w.alice.post('/api/me/redemptions', { reward_id: Number(rw.lastInsertRowid), key: key() });
  const rid = (w.raw.prepare('SELECT id FROM redemptions').get() as { id: number }).id;
  await w.admin.post(`/api/admin/redemptions/${rid}/complete`);
  assert.equal(svc.sent.length, 1);
  assert.deepEqual(await read(svc.sent[0]), { title: 'Reward redemption completed', body: 'Cookie', url: '/#/rewards' });
});

test('every kind of point event and the redemption lifecycle', async (t) => {
  const svc = pushService(t);
  const w = await world();
  const db = w.env.DB as never as D1Database;
  await w.alice.post('/api/me/push/subscribe', subBody(1));
  const last = async () => read(svc.sent[svc.sent.length - 1]);

  // administrator adjustments
  await w.admin.post('/api/admin/points/adjust', { student_id: w.ids.alice, amount: 100, reason: 'Starter', key: key() });
  assert.equal((await last()).title, 'Points awarded');
  await w.admin.post('/api/admin/points/adjust', { student_id: w.ids.alice, amount: -30, reason: 'Late work', key: key() });
  assert.deepEqual(await last(), { title: 'Points deducted', body: '-30 pts · Late work · Balance 70', url: '/#/history' });

  // cancelling an award (no route needed: the ledger row is what counts)
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice], amount: 10, reason: 'Oops', key: key() });
  const awardId = (w.raw.prepare(`SELECT id FROM point_transactions WHERE reason = 'Oops'`).get() as { id: number }).id;
  await db.batch([insertCancel(db, { originalId: awardId, reason: 'mistake', operatorId: w.ids.alice })]);
  await dispatchPushEvents(w.env);
  assert.deepEqual(await last(), { title: 'Award cancelled', body: '-10 pts · mistake · Balance 70', url: '/#/history' });

  // cancelling a deduction is a correction
  const dedId = (w.raw.prepare(`SELECT id FROM point_transactions WHERE reason = 'Late work'`).get() as { id: number }).id;
  await db.batch([insertCancel(db, { originalId: dedId, reason: 'sorry', operatorId: w.ids.alice })]);
  await dispatchPushEvents(w.env);
  assert.deepEqual(await last(), { title: 'Points corrected', body: '+30 pts · sorry · Balance 100', url: '/#/history' });

  // redemption: asking is silent, completing and refunding are announced
  const before = svc.sent.length;
  const rw = Number(w.raw.prepare(`INSERT INTO rewards (name, cost) VALUES ('Ticket', 40)`).run().lastInsertRowid);
  assert.equal((await w.alice.post('/api/me/redemptions', { reward_id: rw, key: key() })).status, 201);
  await dispatchPushEvents(w.env);
  assert.equal(svc.sent.length, before, 'a student\'s own redemption does not notify them');

  const ids = (w.raw.prepare('SELECT id FROM redemptions ORDER BY id').all() as { id: number }[]).map((x) => x.id);
  await w.admin.post(`/api/admin/redemptions/${ids[0]}/complete`);
  assert.deepEqual(await last(), { title: 'Reward redemption completed', body: 'Ticket', url: '/#/rewards' });
  const afterComplete = svc.sent.length;
  assert.equal((await w.admin.post(`/api/admin/redemptions/${ids[0]}/complete`)).status, 409, 'double click');
  assert.equal(svc.sent.length, afterComplete, 'a repeated click does not notify again');

  await w.alice.post('/api/me/redemptions', { reward_id: rw, key: key() });
  const second = (w.raw.prepare('SELECT id FROM redemptions ORDER BY id DESC').get() as { id: number }).id;
  assert.equal((await w.admin.post(`/api/admin/redemptions/${second}/cancel`, { reason: 'out of stock' })).status, 200);
  assert.deepEqual(await last(), { title: 'Reward request cancelled', body: 'Ticket: 40 points were returned', url: '/#/rewards' });
});

test('failures: gone devices are removed, temporary errors are retried with back-off, then dropped', async (t) => {
  const svc = pushService(t);
  const w = await world();
  await w.alice.post('/api/me/push/subscribe', subBody(1));
  await w.alice.post('/api/me/push/subscribe', subBody(2));

  // one device is gone for good
  svc.status = (url) => (url === endpointOf(1) ? 410 : 201);
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice], amount: 1, reason: 'a', key: key() });
  assert.deepEqual(w.devices().map((d) => d.endpoint), [endpointOf(2)]);
  assert.equal(w.outbox().length, 0);

  // the push service is down
  svc.status = () => 503;
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice], amount: 1, reason: 'b', key: key() });
  let rows = w.outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 1);
  const wait = rows[0].next_attempt_at - Math.floor(Date.now() / 1000);
  assert.ok(wait > 50 && wait <= 61, `back-off of about a minute, got ${wait}s`);
  assert.equal(w.devices().length, 1, 'a temporary error does not remove the device');

  // not yet due: nothing is sent
  const calls = svc.sent.length;
  await drainOutbox(w.env, 10);
  assert.equal(svc.sent.length, calls);

  // due again, still failing: attempts grow until the message is dropped
  for (const attempts of [2, 3]) {
    w.raw.prepare('UPDATE push_outbox SET next_attempt_at = 0').run();
    await drainOutbox(w.env, 10);
    assert.equal(w.outbox()[0].attempts, attempts);
  }
  w.raw.prepare('UPDATE push_outbox SET next_attempt_at = 0').run();
  const res = await drainOutbox(w.env, 10);
  assert.equal(res.dropped, 1);
  assert.equal(w.outbox().length, 0);

  // a recovered service delivers a retried message
  svc.status = () => 503;
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice], amount: 1, reason: 'c', key: key() });
  svc.status = () => 201;
  w.raw.prepare('UPDATE push_outbox SET next_attempt_at = 0').run();
  assert.equal((await drainOutbox(w.env, 10)).sent, 1);
  assert.equal(w.outbox().length, 0);
});

test('a message is not sent twice when two workers drain at the same time', async (t) => {
  const svc = pushService(t);
  const w = await world();
  await w.alice.post('/api/me/push/subscribe', subBody(1));
  const db = w.env.DB as never as D1Database;
  await db.batch([insertTx(db, { studentId: w.ids.alice, amount: 5, type: 'award', reason: 'r', operatorId: w.ids.bob, key: key() })]);
  assert.equal(await enqueueNewEvents(w.env), 1);
  assert.equal(await enqueueNewEvents(w.env), 0, 'already announced');
  await Promise.all([drainOutbox(w.env, 10), drainOutbox(w.env, 10)]);
  assert.equal(svc.sent.length, 1);
});

test('too many messages for one request: the rest is delivered by the one-minute job', async (t) => {
  const svc = pushService(t);
  const w = await world();
  const total = IN_REQUEST_MAX + 8;
  const studentIds: number[] = [];
  for (let n = 0; n < total; n++) {
    const id = Number(w.raw.prepare(`INSERT INTO users (login_id, nickname, password_hash, role) VALUES (?1, ?1, 'x', 'student')`).run(`kid${n}`).lastInsertRowid);
    w.raw.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?1, ?2, ?3, ?4)`).run(id, endpointOf(1000 + n), browser.p256dh, browser.auth);
    studentIds.push(id);
  }
  await w.teacher.post('/api/points/award', { student_ids: studentIds, amount: 3, reason: 'class bonus', key: key() });
  assert.equal(svc.sent.length, IN_REQUEST_MAX, 'one request sends a limited batch');
  assert.equal(w.outbox().length, 8);
  await runPushCron(w.env);
  assert.equal(svc.sent.length, total);
  assert.equal(new Set(svc.sent.map((m) => m.url)).size, total, 'each device exactly once');
  assert.equal(w.outbox().length, 0);
  assert.ok(CRON_MAX >= IN_REQUEST_MAX);
});

test('history from before the upgrade is never announced, and devices registered later only hear new events', async (t) => {
  const svc = pushService(t);
  // A database as it was before this feature: migration 0001 applied, data present.
  const env = makeEnv();
  const raw = (env.DB as unknown as FakeD1).raw;
  raw.exec(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT '')`);
  for (const s of MIGRATIONS[0].statements) raw.exec(s);
  raw.exec(`INSERT INTO _migrations (id) VALUES ('${MIGRATIONS[0].id}')`);
  raw.exec(`INSERT INTO users (login_id, nickname, password_hash, role) VALUES ('t', 't', 'x', 'teacher'), ('s', 's', 'x', 'student')`);
  raw.exec(`INSERT INTO point_transactions (student_id, amount, balance_after, type, reason, operator_id, idempotency_key)
            VALUES (2, 10, 10, 'award', 'old', 1, 'k-old-1'), (2, 5, 15, 'award', 'older', 1, 'k-old-2')`);
  raw.exec(`INSERT INTO audit_logs (actor_id, action) VALUES (1, 'old.thing')`);

  await ensureSchema(env.DB);
  const cur = Object.fromEntries((raw.prepare(`SELECT key, value FROM app_settings`).all() as any[]).map((r) => [r.key, r.value]));
  assert.equal(cur.push_tx_cursor, '2');
  assert.equal(cur.push_audit_cursor, '1');

  raw.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (2, ?1, ?2, ?3)`).run(endpointOf(1), browser.p256dh, browser.auth);
  await dispatchPushEvents(env);
  assert.equal(svc.sent.length, 0, 'old history stays quiet');

  raw.exec(`INSERT INTO point_transactions (student_id, amount, balance_after, type, reason, operator_id, idempotency_key)
            VALUES (2, 1, 16, 'award', 'new', 1, 'k-new')`);
  await dispatchPushEvents(env);
  assert.equal(svc.sent.length, 1);
  assert.equal((await read(svc.sent[0])).body, '+1 pts · new · Balance 16');
});

test('inactive accounts, anonymized accounts and deleted users receive nothing and leave nothing behind', async (t) => {
  const svc = pushService(t);
  const w = await world();
  await w.alice.post('/api/me/push/subscribe', subBody(1));
  await w.bob.post('/api/me/push/subscribe', subBody(2));

  w.raw.prepare('UPDATE users SET is_active = 0 WHERE id = ?1').run(w.ids.alice);
  const db = w.env.DB as never as D1Database;
  await db.batch([insertTx(db, { studentId: w.ids.alice, amount: 5, type: 'award', reason: 'x', operatorId: w.ids.bob, key: key(), requireActive: false })]);
  await dispatchPushEvents(w.env);
  assert.equal(svc.sent.length, 0);

  // anonymized account: its device is removed by the daily job
  w.raw.prepare(`UPDATE users SET login_id = '~deleted-' || id, is_active = 0 WHERE id = ?1`).run(w.ids.bob);
  assert.equal(w.devices().length, 2);
  await runScheduled(w.env);
  assert.deepEqual(w.devices().map((d) => d.user_id), [w.ids.alice]);

  // a user without history is deleted outright: the foreign keys take the device and its queue along
  w.raw.prepare(`INSERT INTO push_outbox (subscription_id, kind, data, next_attempt_at, created_at) VALUES (?1, 'test', '{}', 0, 0)`).run(w.devices()[0].id);
  const carol = Number(w.raw.prepare(`INSERT INTO users (login_id, nickname, password_hash, role) VALUES ('carol', 'c', 'x', 'student')`).run().lastInsertRowid);
  w.raw.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?1, ?2, 'a', 'b')`).run(carol, endpointOf(9));
  w.raw.prepare('DELETE FROM users WHERE id = ?1').run(carol);
  assert.ok(!w.devices().some((d) => d.user_id === carol));
});

test('test notification: needs a device, goes to the person\'s own devices, and is rate limited', async (t) => {
  const svc = pushService(t);
  const w = await world();
  const r0 = await w.alice.post('/api/me/push/test');
  assert.equal(r0.status, 409);
  assert.equal(r0.data.error.code, 'no_devices');

  await w.alice.post('/api/me/push/subscribe', subBody(1));
  await w.bob.post('/api/me/push/subscribe', subBody(2));
  const r1 = await w.alice.post('/api/me/push/test');
  assert.equal(r1.status, 200);
  assert.equal(r1.data.devices, 1);
  assert.equal(svc.sent.length, 1);
  assert.equal(svc.sent[0].url, endpointOf(1), 'not bob\'s device');
  assert.deepEqual(await read(svc.sent[0]), { title: 'LAP Rewards', body: 'Notifications are working on this device.', url: '/', tag: 'lap-test' });

  // the test message ignores category switches
  await w.alice.call('PUT', '/api/me/notifications', { points: false, redemptions: false });
  assert.equal((await w.alice.post('/api/me/push/test')).status, 200);
  assert.equal(svc.sent.length, 2);

  // Attempts so far: the failed one and the two above = 3 (a failed try counts too). Two more fit into the limit of 5.
  assert.equal((await w.alice.post('/api/me/push/test')).status, 200);
  assert.equal((await w.alice.post('/api/me/push/test')).status, 200);
  assert.equal((await w.alice.post('/api/me/push/test')).status, 429, 'at most 5 tests per 10 minutes');
});

test('VAPID keys: generated once, shared by all isolates, or taken from the environment', async (t) => {
  pushService(t);
  const w = await world();
  const a = (await w.alice.get('/api/push/key')).data.public_key;
  const stored = (w.raw.prepare(`SELECT key FROM app_settings WHERE key LIKE 'vapid_%' ORDER BY key`).all() as any[]).map((r) => r.key);
  assert.deepEqual(stored, ['vapid_private', 'vapid_public']);

  // A second Worker instance with the same database (new env object) sees the same key.
  const sibling = { ...w.env, DB: w.env.DB } as never;
  const c = new Client(sibling, '10.0.1.0');
  await c.login('alice', 'studentpass1');
  assert.equal((await c.get('/api/push/key')).data.public_key, a);

  // Explicit keys win over the generated ones.
  const { generateVapidKeys } = await import('../src/webpush.ts');
  const own = await generateVapidKeys();
  const w2 = await world();
  (w2.env as any).VAPID_PUBLIC_KEY = own.publicKey;
  (w2.env as any).VAPID_PRIVATE_KEY = own.privateKey;
  assert.equal((await w2.alice.get('/api/push/key')).data.public_key, own.publicKey);
  assert.equal(w2.raw.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'vapid_%'`).get()!.n, 0, 'nothing stored');
});

test('without push subscribers the feature is invisible: no requests, no queue growth', async (t) => {
  const svc = pushService(t);
  const w = await world();
  await w.teacher.post('/api/points/award', { student_ids: [w.ids.alice, w.ids.bob], amount: 5, reason: 'x', key: key() });
  assert.equal(svc.sent.length, 0);
  assert.equal(w.outbox().length, 0);
  const cur = (w.raw.prepare(`SELECT value FROM app_settings WHERE key = 'push_tx_cursor'`).get() as { value: string }).value;
  assert.equal(cur, String((w.raw.prepare('SELECT MAX(id) AS m FROM point_transactions').get() as { m: number }).m), 'cursor moved on');
});
