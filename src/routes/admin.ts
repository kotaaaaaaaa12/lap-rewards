import type { Router } from '../router.ts';
import { requireRole } from '../router.ts';
import {
  HttpError, bad, conflict, isUniqueError, json, notFound, qInt, reqInt, reqKey, reqStr,
} from '../http.ts';
import {
  assertNotLimited, deleteUserSessions, hashPassword, iterationsFor, recordAttempt, tempPassword,
} from '../auth.ts';
import { auditStmt } from '../audit.ts';
import { changed, insertRedeemRefund, insertTx } from '../ledger.ts';
import { normalizeLoginId } from './auth.ts';
import { listBackups, runBackup } from '../backup.ts';

const MAX_ADJUST = 100_000;

export function adminRoutes(r: Router) {
  const admin = requireRole('admin');

  r.get('/api/admin/overview', admin, async (c) => {
    const row = await c.env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE role = 'student' AND is_active = 1) AS students,
           (SELECT COUNT(*) FROM users WHERE role = 'teacher' AND is_active = 1) AS teachers,
           (SELECT COUNT(*) FROM classes) AS classes,
           (SELECT COALESCE(SUM(balance), 0) FROM users WHERE role = 'student') AS total_balance,
           (SELECT COUNT(*) FROM redemptions WHERE status = 'pending') AS pending_redemptions,
           (SELECT COUNT(*) FROM point_transactions WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) AS transactions_7d`,
      )
      .first();
    return json({ overview: row });
  });

  // ---------------- users ----------------
  r.get('/api/admin/users', admin, async (c) => {
    const role = c.url.searchParams.get('role');
    const q = (c.url.searchParams.get('q') ?? '').trim().slice(0, 50);
    const limit = qInt(c.url, 'limit', 50, 1, 200);
    const offset = qInt(c.url, 'offset', 0, 0, 100000);
    const where: string[] = [`u.login_id NOT LIKE '~deleted-%'`]; // hide removed (anonymized) accounts
    const binds: unknown[] = [];
    if (role) {
      if (!['student', 'teacher', 'admin'].includes(role)) throw bad('role is invalid.');
      where.push('u.role = ?');
      binds.push(role);
    }
    if (q) {
      where.push(`(u.nickname LIKE ? ESCAPE '\\' OR u.login_id LIKE ? ESCAPE '\\')`);
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      binds.push(like, like);
    }
    const w = where.join(' AND ');
    const { results } = await c.env.DB
      .prepare(
        `SELECT u.id, u.login_id, u.nickname, u.role, u.balance, u.is_active, u.must_change_password,
                u.class_id, c.name AS class_name, u.created_at
         FROM users u LEFT JOIN classes c ON c.id = u.class_id
         WHERE ${w} ORDER BY u.role, u.nickname, u.id LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all();
    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${w}`).bind(...binds).first<{ n: number }>();
    return json({ users: results, total: total?.n ?? 0 });
  });

  // Create a teacher / student / admin account. A temporary password is shown once.
  r.post('/api/admin/users', admin, async (c) => {
    const body = await c.body();
    const loginId = normalizeLoginId(body.login_id);
    const nickname = reqStr(body.nickname, 'Nickname', 1, 30);
    const role = body.role;
    if (role !== 'teacher' && role !== 'student' && role !== 'admin') throw bad('role is invalid.');
    const temp = tempPassword();
    const hash = await hashPassword(temp, iterationsFor(c.env));
    try {
      const res = await c.env.DB
        .prepare(`INSERT INTO users (login_id, nickname, password_hash, role, must_change_password) VALUES (?1, ?2, ?3, ?4, 1)`)
        .bind(loginId, nickname, hash, role)
        .run();
      const id = res.meta.last_row_id as number;
      await auditStmt(c.env.DB, c.user!.id, 'user.create', 'user', id, { login_id: loginId, role }).run();
      return json({ id, login_id: loginId, temporary_password: temp }, 201);
    } catch (e) {
      if (isUniqueError(e)) throw conflict('login_taken', 'That login ID is already taken.');
      throw e;
    }
  });

  r.patch('/api/admin/users/:id', admin, async (c) => {
    const id = Number(c.params.id);
    const body = await c.body();
    const target = await c.env.DB
      .prepare('SELECT id, role, is_active FROM users WHERE id = ?1')
      .bind(id)
      .first<{ id: number; role: string; is_active: number }>();
    if (!target) throw notFound('User not found.');
    const sets: string[] = [];
    const binds: unknown[] = [];
    const changes: Record<string, unknown> = {};
    if (body.nickname !== undefined) {
      const v = reqStr(body.nickname, 'Nickname', 1, 30);
      sets.push('nickname = ?'); binds.push(v); changes.nickname = v;
    }
    if (body.role !== undefined) {
      if (body.role !== 'student' && body.role !== 'teacher') throw bad('Only student and teacher roles can be assigned.');
      if (target.role === 'admin') throw bad('Administrator roles cannot be changed here.');
      sets.push('role = ?'); binds.push(body.role); changes.role = body.role;
      if (body.role === 'teacher') sets.push('class_id = NULL');
    }
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== 'boolean') throw bad('is_active must be true or false.');
      if (id === c.user!.id && !body.is_active) throw bad('You cannot deactivate your own account.');
      sets.push('is_active = ?'); binds.push(body.is_active ? 1 : 0); changes.is_active = body.is_active;
    }
    if (!sets.length) throw bad('Nothing to update.');
    const db = c.env.DB;
    const stmts = [
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id),
      auditStmt(db, c.user!.id, 'user.update', 'user', id, changes),
    ];
    // Deactivating or changing a role ends every session of that user.
    if (body.is_active === false || body.role !== undefined) stmts.push(deleteUserSessions(c.env, id));
    await db.batch(stmts);
    return json({ ok: true });
  });

  // Admin-initiated reset: sets a one-time temporary password and signs the user out everywhere.
  r.post('/api/admin/users/:id/reset-password', admin, async (c) => {
    const id = Number(c.params.id);
    await assertNotLimited(c.env, `reset:${c.user!.id}`, 30, 3600);
    await recordAttempt(c.env, `reset:${c.user!.id}`);
    const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first();
    if (!target) throw notFound('User not found.');
    const temp = tempPassword();
    const hash = await hashPassword(temp, iterationsFor(c.env));
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET password_hash = ?1, must_change_password = 1 WHERE id = ?2').bind(hash, id),
      deleteUserSessions(c.env, id),
      auditStmt(c.env.DB, c.user!.id, 'user.reset_password', 'user', id),
    ]);
    return json({ temporary_password: temp });
  });

  // Permanently remove an account. Accounts with no history are deleted outright. Accounts that appear
  // in the append-only ledger, redemptions or activity log cannot lose those rows, so they are
  // anonymized instead: the person can no longer sign in, the name and login ID are gone, and the
  // login ID becomes available again.
  r.delete('/api/admin/users/:id', admin, async (c) => {
    const id = Number(c.params.id);
    const body = await c.body();
    const db = c.env.DB;
    const target = await db
      .prepare('SELECT id, login_id, role FROM users WHERE id = ?1')
      .bind(id)
      .first<{ id: number; login_id: string; role: string }>();
    if (!target || target.login_id.startsWith('~deleted-')) throw notFound('User not found.');
    if (id === c.user!.id) throw bad('You cannot delete your own account.');
    if (typeof body.login_id !== 'string' || body.login_id.trim().toLowerCase() !== target.login_id) {
      throw bad('The login ID you typed does not match.');
    }
    if (target.role === 'admin') {
      const other = await db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?1`)
        .bind(id)
        .first<{ n: number }>();
      if (!other || other.n < 1) throw conflict('last_admin', 'At least one active administrator must remain.');
    }
    const pending = await db
      .prepare(`SELECT COUNT(*) AS n FROM redemptions WHERE student_id = ?1 AND status = 'pending'`)
      .bind(id)
      .first<{ n: number }>();
    if ((pending?.n ?? 0) > 0) {
      throw conflict('has_pending_redemptions', 'This student has pending redemptions. Cancel or complete them first.');
    }
    const hist = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM point_transactions WHERE student_id = ?1 OR operator_id = ?1)
              + (SELECT COUNT(*) FROM redemptions WHERE student_id = ?1)
              + (SELECT COUNT(*) FROM audit_logs WHERE actor_id = ?1) AS n`,
      )
      .bind(id)
      .first<{ n: number }>();
    const mode = (hist?.n ?? 0) > 0 ? 'anonymized' : 'deleted';
    await db.batch([
      deleteUserSessions(c.env, id),
      mode === 'deleted'
        ? db.prepare('DELETE FROM users WHERE id = ?1').bind(id)
        : db
            .prepare(
              `UPDATE users SET login_id = '~deleted-' || id, nickname = 'Deleted user', password_hash = '!',
                 is_active = 0, class_id = NULL, must_change_password = 0 WHERE id = ?1`,
            )
            .bind(id),
      auditStmt(db, c.user!.id, 'user.delete', 'user', id, { mode }),
    ]);
    return json({ ok: true, mode });
  });

  // ---------------- manual point adjustment ----------------
  r.post('/api/admin/points/adjust', admin, async (c) => {
    const body = await c.body();
    const studentId = reqInt(body.student_id, 'student_id', 1, Number.MAX_SAFE_INTEGER);
    const amount = reqInt(body.amount, 'Amount', -MAX_ADJUST, MAX_ADJUST);
    if (amount === 0) throw bad('Amount must not be zero.');
    const reason = reqStr(body.reason, 'Reason', 1, 200);
    const key = reqKey(body.key);
    const db = c.env.DB;
    const dup = await db.prepare('SELECT 1 AS x FROM point_transactions WHERE idempotency_key = ?1').bind(key).first();
    if (dup) return json({ ok: true, duplicate: true });
    const res = await db.batch([
      insertTx(db, { studentId, amount, type: amount > 0 ? 'award' : 'deduction', reason, operatorId: c.user!.id, key }),
      auditStmt(db, c.user!.id, 'points.adjust', 'student', studentId, { amount, reason }, key),
    ]);
    if (!changed(res[0])) {
      throw conflict('not_applied', 'Could not apply: the student is missing or inactive, or the balance would go below zero.');
    }
    return json({ ok: true }, 201);
  });

  // ---------------- rewards ----------------
  r.get('/api/admin/rewards', admin, async (c) => {
    const { results } = await c.env.DB.prepare('SELECT id, name, description, cost, is_active FROM rewards ORDER BY is_active DESC, cost, id').all();
    return json({ rewards: results });
  });

  r.post('/api/admin/rewards', admin, async (c) => {
    const body = await c.body();
    const name = reqStr(body.name, 'Name', 1, 60);
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '';
    const cost = reqInt(body.cost, 'Cost', 1, 1_000_000);
    const res = await c.env.DB.prepare('INSERT INTO rewards (name, description, cost) VALUES (?1, ?2, ?3)').bind(name, description, cost).run();
    const id = res.meta.last_row_id as number;
    await auditStmt(c.env.DB, c.user!.id, 'reward.create', 'reward', id, { name, cost }).run();
    return json({ id }, 201);
  });

  r.patch('/api/admin/rewards/:id', admin, async (c) => {
    const id = Number(c.params.id);
    const body = await c.body();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.name !== undefined) { sets.push('name = ?'); binds.push(reqStr(body.name, 'Name', 1, 60)); }
    if (body.description !== undefined) {
      sets.push('description = ?');
      binds.push(typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '');
    }
    if (body.cost !== undefined) { sets.push('cost = ?'); binds.push(reqInt(body.cost, 'Cost', 1, 1_000_000)); }
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== 'boolean') throw bad('is_active must be true or false.');
      sets.push('is_active = ?'); binds.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) throw bad('Nothing to update.');
    const res = await c.env.DB.prepare(`UPDATE rewards SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
    if (!res.meta.changes) throw notFound('Reward not found.');
    await auditStmt(c.env.DB, c.user!.id, 'reward.update', 'reward', id, Object.fromEntries(Object.entries(body))).run();
    return json({ ok: true });
  });

  // ---------------- redemptions ----------------
  r.get('/api/admin/redemptions', admin, async (c) => {
    const status = c.url.searchParams.get('status');
    const where = status ? 'WHERE r.status = ?1' : 'WHERE ?1 IS NULL';
    const { results } = await c.env.DB
      .prepare(
        `SELECT r.id, r.status, r.cost_at_request, r.created_at, r.updated_at, r.student_id,
                s.nickname AS student_nickname, s.login_id AS student_login_id, w.name AS reward_name
         FROM redemptions r JOIN users s ON s.id = r.student_id JOIN rewards w ON w.id = r.reward_id
         ${where} ORDER BY r.id DESC LIMIT 100`,
      )
      .bind(status)
      .all();
    return json({ redemptions: results });
  });

  r.post('/api/admin/redemptions/:id/complete', admin, async (c) => {
    const id = Number(c.params.id);
    const res = await c.env.DB.batch([
      c.env.DB
        .prepare(`UPDATE redemptions SET status = 'completed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND status = 'pending'`)
        .bind(id),
      auditStmt(c.env.DB, c.user!.id, 'redemption.complete', 'redemption', id),
    ]);
    if (!changed(res[0])) throw conflict('not_pending', 'Only pending redemptions can be completed.');
    return json({ ok: true });
  });

  r.post('/api/admin/redemptions/:id/cancel', admin, async (c) => {
    const id = Number(c.params.id);
    const reason = reqStr((await c.body()).reason, 'Reason', 1, 200);
    const db = c.env.DB;
    const res = await db.batch([
      insertRedeemRefund(db, { redemptionId: id, reason, operatorId: c.user!.id }),
      db
        .prepare(`UPDATE redemptions SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND status IN ('pending','completed')`)
        .bind(id),
      auditStmt(db, c.user!.id, 'redemption.cancel', 'redemption', id, { reason }, `redeem_cancel:${id}`),
    ]);
    if (!changed(res[0]) || !changed(res[1])) throw conflict('not_pending', 'Only pending or completed redemptions can be cancelled.');
    return json({ ok: true });
  });

  // ---------------- audit log & backups ----------------
  r.get('/api/admin/audit-logs', admin, async (c) => {
    const limit = qInt(c.url, 'limit', 50, 1, 100);
    const before = qInt(c.url, 'before', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const { results } = await c.env.DB
      .prepare(
        `SELECT a.id, a.created_at, a.actor_id, u.nickname AS actor_nickname, a.action, a.target_type, a.target_id, a.detail
         FROM audit_logs a JOIN users u ON u.id = a.actor_id WHERE a.id < ?1 ORDER BY a.id DESC LIMIT ?2`,
      )
      .bind(before, limit)
      .all();
    return json({ logs: results });
  });

  r.get('/api/admin/backups', admin, async (c) => json({ backups: await listBackups(c.env) }));

  r.post('/api/admin/backups/run', admin, async (c) => {
    await assertNotLimited(c.env, `backup:${c.user!.id}`, 6, 3600);
    await recordAttempt(c.env, `backup:${c.user!.id}`);
    const key = await runBackup(c.env);
    await auditStmt(c.env.DB, c.user!.id, 'backup.run', null, null, { key }).run();
    return json({ key }, 201);
  });

  void HttpError;
}
