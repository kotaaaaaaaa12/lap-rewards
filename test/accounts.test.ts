import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, key, seed } from './helpers.ts';
import { FakeD1 } from './fake.ts';

test('role change, deactivate and nickname updates all work', async () => {
  const { admin, ids } = await seed();
  for (const body of [{ role: 'teacher' }, { role: 'student' }, { is_active: false }, { is_active: true }, { nickname: 'Renamed' }]) {
    assert.equal((await admin.patch(`/api/admin/users/${ids.alice}`, body)).status, 200, JSON.stringify(body));
  }
  assert.equal((await admin.get('/api/admin/users?q=Renamed')).data.users.length, 1);
});

test('delete: an account with no history is removed completely', async () => {
  const { env, admin } = await seed();
  const created = await admin.post('/api/admin/users', { login_id: 'newbie1', nickname: 'Newbie', role: 'student' });
  const id = created.data.id;
  assert.equal((await admin.call('DELETE', `/api/admin/users/${id}`, { login_id: 'wrong' })).status, 400, 'login ID must be retyped');
  const res = await admin.call('DELETE', `/api/admin/users/${id}`, { login_id: 'NewBie1' });
  assert.deepEqual([res.status, res.data.mode], [200, 'deleted']);
  const raw = (env.DB as unknown as FakeD1).raw;
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id)!.n, 0);
  assert.equal((await new Client(env, '2.2.2.2').login('newbie1', 'x')).status, 401);
  // the login ID can be reused
  assert.equal((await new Client(env, '2.2.2.3').post('/api/auth/register', { nickname: 'Again', login_id: 'newbie1', password: 'password12', password_confirm: 'password12' })).status, 201);
});

test('delete: an account with history is anonymized and the ledger stays intact', async () => {
  const { env, admin, teacher, alice, ids } = await seed();
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 12, reason: 'Quiz', key: key() });
  assert.equal((await admin.call('DELETE', `/api/admin/users/${ids.alice}`, { login_id: 'alice' })).data.mode, 'anonymized');

  assert.equal((await alice.get('/api/me')).status, 401, 'sessions are gone');
  assert.equal((await new Client(env, '2.2.2.4').login('alice', 'studentpass1')).status, 401);
  assert.equal((await admin.get('/api/admin/users?q=alice')).data.users.length, 0, 'hidden from the account list');
  assert.equal((await admin.get('/api/students?include_inactive=1&q=alice')).data.total, 0);
  const tx = (await admin.get('/api/points/transactions')).data.transactions;
  assert.equal(tx.length, 1, 'ledger row is still there');
  assert.deepEqual([tx[0].student_nickname, tx[0].amount], ['Deleted user', 12]);
  assert.ok(tx[0].student_login_id.startsWith('~deleted-'));
  // login ID is free again, and a deleted ID cannot be typed to log in
  assert.equal((await new Client(env, '2.2.2.5').post('/api/auth/register', { nickname: 'New Alice', login_id: 'alice', password: 'password12', password_confirm: 'password12' })).status, 201);
  assert.equal((await new Client(env, '2.2.2.6').login(tx[0].student_login_id, 'anything')).status, 401);
  assert.equal((await admin.call('DELETE', `/api/admin/users/${ids.alice}`, { login_id: tx[0].student_login_id })).status, 404, 'already removed');
});

test('delete: guards (self, last administrator, pending redemptions, permissions)', async () => {
  const { env, admin, teacher, alice, ids } = await seed();
  assert.equal((await admin.call('DELETE', '/api/admin/users/1', { login_id: 'admin' })).status, 400, 'cannot delete yourself');
  assert.equal((await teacher.call('DELETE', `/api/admin/users/${ids.bob}`, { login_id: 'bob' })).status, 403);

  // A second administrator can be deleted only while another active one remains.
  const second = await admin.post('/api/admin/users', { login_id: 'admin2', nickname: 'Admin Two', role: 'admin' });
  const a2 = new Client(env, '2.2.3.1');
  await a2.login('admin2', second.data.temporary_password);
  await a2.post('/api/auth/change-password', { current_password: second.data.temporary_password, new_password: 'adminpass22', new_password_confirm: 'adminpass22' });
  assert.equal((await admin.patch('/api/admin/users/1', { is_active: false })).status, 400, 'cannot deactivate yourself');
  assert.equal((await a2.patch('/api/admin/users/1', { is_active: false })).status, 200);
  assert.equal((await a2.call('DELETE', `/api/admin/users/${second.data.id}`, { login_id: 'admin2' })).status, 400, 'self');
  assert.equal((await a2.patch('/api/admin/users/1', { is_active: true })).status, 200);
  assert.equal((await admin.get('/api/me')).status, 401, 'deactivating signs the user out');
  await admin.login('admin', 'adminpass1');
  assert.equal((await admin.call('DELETE', `/api/admin/users/${second.data.id}`, { login_id: 'admin2' })).status, 200, 'another active admin remains');

  // Pending redemptions block deleting a student.
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 30, reason: 'r', key: key() });
  const rw = await admin.post('/api/admin/rewards', { name: 'Ticket', cost: 10 });
  await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: key() });
  assert.equal((await admin.call('DELETE', `/api/admin/users/${ids.alice}`, { login_id: 'alice' })).status, 409);
  const pending = (await admin.get('/api/admin/redemptions?status=pending')).data.redemptions[0];
  await admin.post(`/api/admin/redemptions/${pending.id}/complete`);
  assert.equal((await admin.call('DELETE', `/api/admin/users/${ids.alice}`, { login_id: 'alice' })).status, 200);
});

test('unexpected server errors: administrators see the cause, others do not', async () => {
  const { env, admin, teacher, ids } = await seed();
  const db = env.DB as unknown as FakeD1;
  const realBatch = db.batch.bind(db);
  db.batch = async () => { throw new Error('D1_ERROR: boom'); };
  const a = await admin.patch(`/api/admin/users/${ids.alice}`, { is_active: false });
  assert.equal(a.status, 500);
  assert.equal(a.data.error.detail, 'D1_ERROR: boom');
  const t = await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 1, reason: 'r', key: key() });
  assert.equal(t.status, 500);
  assert.equal(t.data.error.detail, undefined);
  db.batch = realBatch;
});
