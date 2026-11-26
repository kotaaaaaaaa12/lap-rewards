import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, key, seed } from './helpers.ts';
import { FakeD1 } from './fake.ts';

test('setup works once and only with the token', async () => {
  const { env, admin } = await seed();
  const again = await new Client(env).post('/api/setup', { token: 'setup-token-for-tests', login_id: 'x1234', nickname: 'X', password: 'password12' });
  assert.equal(again.status, 409);
  const wrong = await new Client(env).post('/api/setup', { token: 'nope', login_id: 'x1234', nickname: 'X', password: 'password12' });
  assert.equal(wrong.status, 403);
  assert.equal((await admin.get('/api/me')).data.user.role, 'admin');
});

test('registration validation, uniqueness and forced role', async () => {
  const { env } = await seed();
  const c = new Client(env, '9.9.9.9');
  assert.equal((await c.post('/api/auth/register', { nickname: 'A', login_id: 'zed1', password: 'password12', password_confirm: 'different12' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { nickname: 'A', login_id: 'alice', password: 'password12', password_confirm: 'password12' })).status, 409);
  assert.equal((await c.post('/api/auth/register', { nickname: 'A', login_id: 'ALICE', password: 'password12', password_confirm: 'password12' })).status, 409, 'IDs are case-insensitive');
  const ok = await c.post('/api/auth/register', { nickname: 'Z', login_id: 'zed1', password: 'password12', password_confirm: 'password12', role: 'admin' });
  assert.equal(ok.status, 201);
  await c.login('zed1', 'password12');
  assert.equal((await c.get('/api/me')).data.user.role, 'student', 'role cannot be chosen at registration');
});

test('authorization is enforced server-side', async () => {
  const { alice, teacher, ids } = await seed();
  assert.equal((await alice.get('/api/students')).status, 403);
  assert.equal((await alice.post('/api/points/award', { student_ids: [ids.alice], amount: 5, reason: 'x', key: key() })).status, 403);
  assert.equal((await teacher.get('/api/admin/users')).status, 403);
  assert.equal((await teacher.post('/api/admin/points/adjust', { student_id: ids.alice, amount: 5, reason: 'x', key: key() })).status, 403);
  assert.equal((await new Client(alice.env).get('/api/me')).status, 401);
});

test('CSRF: cross-origin or origin-less writes are rejected', async () => {
  const { alice } = await seed();
  assert.equal((await alice.call('POST', '/api/auth/logout', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await alice.call('POST', '/api/auth/logout', {}, { origin: '' })).status, 403);
});

test('classes: create, assign (single and bulk), filter, search, delete rules', async () => {
  const { teacher, ids } = await seed();
  const c1 = await teacher.post('/api/classes', { name: '1-A' });
  assert.equal(c1.status, 201);
  assert.equal((await teacher.post('/api/classes', { name: '1-a' })).status, 409, 'class names are case-insensitive');
  assert.equal((await teacher.get('/api/students?class_id=none')).data.total, 2);

  const a = await teacher.post('/api/students/assign', { student_ids: [ids.alice], class_id: c1.data.id });
  assert.equal(a.status, 200);
  assert.deepEqual((await teacher.get(`/api/students?class_id=${c1.data.id}`)).data.students.map((s: any) => s.login_id), ['alice']);
  assert.equal((await teacher.get('/api/students?class_id=none')).data.total, 1);
  assert.deepEqual((await teacher.get('/api/students?q=bo')).data.students.map((s: any) => s.login_id), ['bob']);
  assert.equal((await teacher.get('/api/students?q=%25')).data.total, 0, 'LIKE wildcards are escaped');

  assert.equal((await teacher.del(`/api/classes/${c1.data.id}`)).status, 409, 'non-empty class cannot be deleted');
  await teacher.post('/api/students/assign', { student_ids: [ids.alice, ids.bob], class_id: null });
  assert.equal((await teacher.patch(`/api/classes/${c1.data.id}`, { name: '1-B' })).status, 200);
  assert.equal((await teacher.del(`/api/classes/${c1.data.id}`)).status, 200);
  assert.equal((await teacher.post('/api/students/assign', { student_ids: [ids.alice], class_id: 999 })).status, 404);
});

test('awards: bulk, balance, history, duplicate submissions', async () => {
  const { teacher, alice, bob, ids } = await seed();
  const k = key();
  const body = { student_ids: [ids.alice, ids.bob], amount: 10, reason: 'Passed quiz 1', key: k };
  const r1 = await teacher.post('/api/points/award', body);
  assert.deepEqual([r1.status, r1.data.awarded, r1.data.duplicates], [201, 2, 0]);
  const r2 = await teacher.post('/api/points/award', body); // double click / retry
  assert.deepEqual([r2.data.awarded, r2.data.duplicates], [0, 2]);
  assert.equal((await alice.get('/api/me')).data.user.balance, 10);
  assert.equal((await bob.get('/api/me')).data.user.balance, 10);

  const hist = (await alice.get('/api/me/transactions')).data.transactions;
  assert.equal(hist.length, 1);
  assert.deepEqual([hist[0].amount, hist[0].balance_after, hist[0].type, hist[0].reason], [10, 10, 'award', 'Passed quiz 1']);

  assert.equal((await teacher.post('/api/points/award', { ...body, key: key(), reason: '  ' })).status, 400, 'reason is required');
  assert.equal((await teacher.post('/api/points/award', { ...body, key: key(), amount: 0 })).status, 400);
  assert.equal((await teacher.post('/api/points/award', { ...body, key: key(), student_ids: [99999] })).status, 400);
  assert.equal((await teacher.post('/api/points/award', { ...body, key: 'short' })).status, 400);
});

test('students cannot see each other’s history', async () => {
  const { teacher, alice, bob, ids } = await seed();
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 7, reason: 'r', key: key() });
  assert.equal((await bob.get('/api/me/transactions')).data.transactions.length, 0);
  assert.equal((await alice.get('/api/me/transactions')).data.transactions.length, 1);
});

test('cancel: appends a reference row, only once, with owner rules and balance guard', async () => {
  const { teacher, admin, alice, ids, env } = await seed();
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 10, reason: 'r', key: key() });
  const tx = (await teacher.get('/api/points/transactions')).data.transactions[0];

  assert.equal((await teacher.post(`/api/points/${tx.id}/cancel`, {})).status, 400, 'reason required');
  const c1 = await teacher.post(`/api/points/${tx.id}/cancel`, { reason: 'Entered by mistake' });
  assert.equal(c1.status, 201);
  assert.equal((await teacher.post(`/api/points/${tx.id}/cancel`, { reason: 'again' })).status, 409);
  assert.equal((await alice.get('/api/me')).data.user.balance, 0);

  const all = (await admin.get('/api/points/transactions')).data.transactions;
  assert.equal(all.length, 2, 'original stays visible');
  const orig = all.find((t: any) => t.id === tx.id);
  const cancel = all.find((t: any) => t.id !== tx.id);
  assert.ok(orig.cancelled_by);
  assert.deepEqual([cancel.type, cancel.amount, cancel.ref_transaction_id, cancel.reason], ['award_cancel', -10, tx.id, 'Entered by mistake']);
  assert.equal(cancel.operator_nickname, 'Ms Teacher');
  assert.equal((await teacher.post(`/api/points/${cancel.id}/cancel`, { reason: 'x' })).status, 400, 'cancels are not cancellable');

  // Teachers can only cancel their own awards; admins can cancel any.
  const other = new Client(env, '10.0.0.9');
  const t2 = await admin.post('/api/admin/users', { login_id: 'teacher2', nickname: 'T2', role: 'teacher' });
  await other.login('teacher2', t2.data.temporary_password);
  await other.post('/api/auth/change-password', { current_password: t2.data.temporary_password, new_password: 'teacherpass2', new_password_confirm: 'teacherpass2' });
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 4, reason: 'r2', key: key() });
  const tx2 = (await teacher.get('/api/points/transactions')).data.transactions[0];
  assert.equal((await other.post(`/api/points/${tx2.id}/cancel`, { reason: 'x' })).status, 403);
  assert.equal((await admin.post(`/api/points/${tx2.id}/cancel`, { reason: 'x' })).status, 201);

  // Balance guard: points already spent cannot be clawed back into the negative.
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 10, reason: 'r3', key: key() });
  const tx3 = (await teacher.get('/api/points/transactions')).data.transactions[0];
  const rw = await admin.post('/api/admin/rewards', { name: 'Cookie', cost: 8 });
  await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: key() });
  assert.equal((await teacher.post(`/api/points/${tx3.id}/cancel`, { reason: 'x' })).status, 409);
});

test('the ledger is append-only at the database level', async () => {
  const { teacher, env, ids } = await seed();
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 10, reason: 'r', key: key() });
  const raw = (env.DB as unknown as FakeD1).raw;
  assert.throws(() => raw.exec('UPDATE point_transactions SET amount = 999'), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM point_transactions'), /append-only/);
});

test('rewards and redemptions: redeem, insufficient points, duplicates, cancel/refund, complete', async () => {
  const { teacher, admin, alice, ids } = await seed();
  const rw = await admin.post('/api/admin/rewards', { name: 'Cafeteria ticket', description: 'One meal', cost: 30 });
  assert.equal((await teacher.post('/api/admin/rewards', { name: 'x', cost: 1 })).status, 403);
  assert.equal((await alice.get('/api/rewards')).data.rewards.length, 1);

  const k = key();
  assert.equal((await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: k })).status, 409, 'no points yet');
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 50, reason: 'r', key: key() });
  const ok = await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: k });
  assert.equal(ok.status, 201);
  const dup = await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: k });
  assert.equal(dup.data.duplicate, true);
  assert.equal((await alice.get('/api/me')).data.user.balance, 20, 'charged exactly once');
  assert.equal((await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: key() })).status, 409, 'only 20 left');

  const reds = (await admin.get('/api/admin/redemptions?status=pending')).data.redemptions;
  assert.equal(reds.length, 1);
  assert.equal((await admin.post(`/api/admin/redemptions/${reds[0].id}/cancel`, { reason: 'Out of stock' })).status, 200);
  assert.equal((await alice.get('/api/me')).data.user.balance, 50, 'refunded');
  assert.equal((await admin.post(`/api/admin/redemptions/${reds[0].id}/cancel`, { reason: 'again' })).status, 409);
  assert.equal((await admin.post(`/api/admin/redemptions/${reds[0].id}/complete`)).status, 409);
  const types = (await alice.get('/api/me/transactions')).data.transactions.map((t: any) => t.type);
  assert.deepEqual(types, ['redeem_cancel', 'redeem', 'award']);

  await alice.post('/api/me/redemptions', { reward_id: rw.data.id, key: key() });
  const p2 = (await admin.get('/api/admin/redemptions?status=pending')).data.redemptions[0];
  assert.equal((await admin.post(`/api/admin/redemptions/${p2.id}/complete`)).status, 200);
  assert.equal((await admin.post(`/api/admin/redemptions/${p2.id}/cancel`, { reason: 'x' })).status, 409, 'completed cannot be cancelled');
  assert.equal((await alice.get('/api/me')).data.user.balance, 20);

  await admin.patch(`/api/admin/rewards/${rw.data.id}`, { is_active: false });
  assert.equal((await alice.get('/api/rewards')).data.rewards.length, 0);
});

test('admin adjust: add, deduct, floor at zero, duplicates', async () => {
  const { admin, alice, ids } = await seed();
  const k = key();
  assert.equal((await admin.post('/api/admin/points/adjust', { student_id: ids.alice, amount: 20, reason: 'Bonus', key: k })).status, 201);
  assert.equal((await admin.post('/api/admin/points/adjust', { student_id: ids.alice, amount: 20, reason: 'Bonus', key: k })).data.duplicate, true);
  assert.equal((await admin.post('/api/admin/points/adjust', { student_id: ids.alice, amount: -5, reason: 'Fix', key: key() })).status, 201);
  assert.equal((await admin.post('/api/admin/points/adjust', { student_id: ids.alice, amount: -500, reason: 'Too much', key: key() })).status, 409);
  assert.equal((await alice.get('/api/me')).data.user.balance, 15);
  const tx = (await admin.get('/api/points/transactions?type=deduction')).data.transactions;
  assert.equal(tx.length, 1);
  assert.equal((await admin.post(`/api/points/${tx[0].id}/cancel`, { reason: 'Undo' })).status, 201);
  assert.equal((await alice.get('/api/me')).data.user.balance, 20);
});

test('passwords: change invalidates other devices; admin reset forces change and signs out', async () => {
  const { env, admin, alice } = await seed();
  const phone = new Client(env, '5.5.5.5');
  await phone.login('alice', 'studentpass1');
  assert.equal((await phone.get('/api/me')).status, 200);

  assert.equal((await alice.post('/api/auth/change-password', { current_password: 'wrong-pass', new_password: 'newpassword1', new_password_confirm: 'newpassword1' })).status, 403);
  assert.equal((await alice.post('/api/auth/change-password', { current_password: 'studentpass1', new_password: 'newpassword1', new_password_confirm: 'mismatch123' })).status, 400);
  const ch = await alice.post('/api/auth/change-password', { current_password: 'studentpass1', new_password: 'newpassword1', new_password_confirm: 'newpassword1' });
  assert.equal(ch.status, 200);
  assert.equal((await phone.get('/api/me')).status, 401, 'other device is signed out');
  assert.equal((await alice.get('/api/me')).status, 200, 'this device stays signed in');
  assert.equal((await new Client(env, '6.6.6.6').login('alice', 'studentpass1')).status, 401);
  assert.equal((await new Client(env, '6.6.6.6').login('alice', 'newpassword1')).status, 200);

  const id = (await admin.get('/api/admin/users?q=alice')).data.users[0].id;
  const reset = await admin.post(`/api/admin/users/${id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await alice.get('/api/me')).status, 401, 'reset signs the user out');
  const again = new Client(env, '7.7.7.7');
  assert.equal((await again.login('alice', reset.data.temporary_password)).data.user.must_change_password, true);
  assert.equal((await again.get('/api/me/transactions')).status, 403, 'forced change blocks the rest of the API');
  assert.equal((await again.post('/api/auth/change-password', { current_password: reset.data.temporary_password, new_password: 'brandnewpass1', new_password_confirm: 'brandnewpass1' })).status, 200);
  assert.equal((await again.get('/api/me/transactions')).status, 200);
});

test('deactivated accounts cannot log in or keep sessions', async () => {
  const { admin, alice, ids } = await seed();
  assert.equal((await admin.patch(`/api/admin/users/${ids.alice}`, { is_active: false })).status, 200);
  assert.equal((await alice.get('/api/me')).status, 401);
  assert.equal((await new Client(alice.env, '8.8.8.8').login('alice', 'studentpass1')).status, 401);
  assert.equal((await admin.patch('/api/admin/users/1', { is_active: false })).status, 400, 'cannot deactivate yourself');
});

test('login rate limiting', async () => {
  const { env } = await seed();
  const c = new Client(env, '4.4.4.4');
  for (let i = 0; i < 8; i++) assert.equal((await c.login('alice', 'wrongwrong')).status, 401);
  assert.equal((await c.login('alice', 'studentpass1')).status, 429, 'locked even with the right password');
  assert.equal((await new Client(env, '4.4.4.5').login('alice', 'studentpass1')).status, 429, 'per-account limit applies across IPs');
  assert.equal((await new Client(env, '4.4.4.5').login('bob', 'studentpass1')).status, 200);
});

test('audit log records staff and admin actions', async () => {
  const { admin, teacher, ids } = await seed();
  const c = await teacher.post('/api/classes', { name: '2-C' });
  await teacher.post('/api/students/assign', { student_ids: [ids.alice], class_id: c.data.id });
  await teacher.post('/api/points/award', { student_ids: [ids.alice], amount: 3, reason: 'r', key: key() });
  const actions = (await admin.get('/api/admin/audit-logs')).data.logs.map((l: any) => l.action);
  for (const a of ['setup.first_admin', 'user.create', 'class.create', 'class.assign', 'points.award']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  assert.equal((await teacher.get('/api/admin/audit-logs')).status, 403);
});
