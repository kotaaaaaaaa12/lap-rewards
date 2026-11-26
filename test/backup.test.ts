import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { Client, key, seed } from './helpers.ts';
import { FakeD1, FakeR2, makeEnv } from './fake.ts';
import { ensureSchema } from '../src/db.ts';
import { listBackups, pruneBackups, runBackup } from '../src/backup.ts';
import { runScheduled } from '../src/index.ts';
// @ts-ignore plain JS script
import { backupToSql } from '../scripts/backup-to-sql.mjs';

test('backup -> restore into a fresh database reproduces everything', async () => {
  const { env, admin, teacher, alice, ids } = await seed();
  const cls = await teacher.post('/api/classes', { name: "O'Brien's class" }); // quote on purpose
  await teacher.post('/api/students/assign', { student_ids: [ids.alice], class_id: cls.data.id });
  await teacher.post('/api/points/award', { student_ids: [ids.alice, ids.bob], amount: 40, reason: "Won the 'quiz'", key: key() });
  const rw = await admin.post('/api/admin/rewards', { name: 'Ticket', cost: 15 });
  await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: key() });
  const tx = (await teacher.get('/api/points/transactions?student_id=' + ids.bob)).data.transactions[0];
  await teacher.post(`/api/points/${tx.id}/cancel`, { reason: 'oops' });

  const bk = await admin.post('/api/admin/backups/run');
  assert.equal(bk.status, 201);
  const obj = (env.BACKUPS as unknown as FakeR2).objects.get(bk.data.key)!;
  const json = JSON.parse(gunzipSync(Buffer.from(obj.body)).toString());
  assert.equal(json.format, 'lap-rewards-backup');
  assert.equal(JSON.stringify(json).includes('"sessions"'), false, 'sessions are not backed up');

  // Restore into a brand-new, empty database that only has the schema.
  const fresh = makeEnv();
  await ensureSchema(fresh.DB);
  const sql = backupToSql(json) as string;
  (fresh.DB as unknown as FakeD1).raw.exec(sql);

  const dump = async (e: any) => {
    const out: Record<string, unknown[]> = {};
    for (const t of ['classes', 'users', 'rewards', 'point_transactions', 'redemptions', 'audit_logs']) {
      // The 'backup.run' audit entry is written after the snapshot is taken, so it is not in the backup.
      const where = t === 'audit_logs' ? `WHERE action <> 'backup.run'` : '';
      out[t] = (await e.DB.prepare(`SELECT * FROM ${t} ${where} ORDER BY id`).all()).results;
    }
    return out;
  };
  assert.deepEqual(await dump(fresh), await dump(env));

  // The restored database works: log in with the restored password hash and keep awarding.
  const c = new Client(fresh, '3.3.3.3');
  assert.equal((await c.login('alice', 'studentpass1')).data.user.balance, 25);
  const t = new Client(fresh, '3.3.3.4');
  assert.equal((await t.login('teacher1', 'teacherpass1')).status, 200);
  assert.equal((await t.post('/api/points/award', { student_ids: [ids.alice], amount: 1, reason: 'after restore', key: key() })).status, 201);
});

test('retention: old backups are pruned, the newest is always kept', async () => {
  const env = makeEnv();
  await ensureSchema(env.DB);
  const r2 = env.BACKUPS as unknown as FakeR2;
  const day = 86_400_000;
  const now = new Date('2026-12-31T00:00:00Z');
  for (const [i, age] of [60, 45, 10, 1].entries()) {
    await runBackup(env, new Date(now.getTime() - age * day + i)); // distinct keys
    const k = [...r2.objects.keys()].sort().at(-1)!;
    void k;
  }
  // Align upload times with the simulated ages.
  [...r2.objects.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([, v], i) => {
    v.uploaded = new Date(now.getTime() - [60, 45, 10, 1][i] * day);
  });
  assert.equal((await listBackups(env)).length, 4);
  assert.equal(await pruneBackups(env, now), 2);
  assert.equal((await listBackups(env)).length, 2);

  const lonely = makeEnv();
  await ensureSchema(lonely.DB);
  await runBackup(lonely, new Date('2020-01-01T00:00:00Z'));
  (lonely.BACKUPS as unknown as FakeR2).objects.forEach((v) => (v.uploaded = new Date('2020-01-01T00:00:00Z')));
  assert.equal(await pruneBackups(lonely, now), 0, 'the only backup is never deleted');
});

test('scheduled job cleans expired data and writes a backup', async () => {
  const { env } = await seed();
  const raw = (env.DB as unknown as FakeD1).raw;
  raw.exec(`INSERT INTO auth_attempts (key, at) VALUES ('old', 1)`);
  raw.exec(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('expired', 1, 1)`);
  await runScheduled(env);
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM auth_attempts WHERE key = 'old'`).get()!.n, 0);
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'expired'`).get()!.n, 0);
  assert.equal((await listBackups(env)).length, 1);
});
