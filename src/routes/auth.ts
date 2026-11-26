import type { Router } from '../router.ts';
import { requireAuth } from '../router.ts';
import { HttpError, bad, conflict, json, reqStr, isUniqueError } from '../http.ts';
import {
  assertNotLimited, clearAttempts, clearCookie, createSession, deleteUserSessions, fakeVerify,
  hashPassword, iterationsFor, recordAttempt, safeEqualStr, sessionCookie, validatePassword,
  verifyPassword,
} from '../auth.ts';
import { auditStmt } from '../audit.ts';

const LOGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normalizeLoginId(v: unknown): string {
  const id = reqStr(v, 'Login ID', 3, 32).toLowerCase();
  if (!LOGIN_ID_RE.test(id)) {
    throw bad('Login ID may contain only letters, digits, dots, hyphens and underscores (3-32 characters).');
  }
  return id;
}

export const publicUser = (u: {
  id: number; login_id: string; nickname: string; role: string; class_id: number | null;
  class_name: string | null; balance: number; must_change_password: number;
}) => ({
  id: u.id, login_id: u.login_id, nickname: u.nickname, role: u.role, class_id: u.class_id,
  class_name: u.class_name, balance: u.balance, must_change_password: !!u.must_change_password,
});

export function authRoutes(r: Router) {
  r.get('/api/health', () => json({ ok: true }));

  // ---- first administrator ----
  r.get('/api/setup/status', async (c) => {
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).first<{ n: number }>();
    return json({ needed: (row?.n ?? 0) === 0, token_configured: !!c.env.SETUP_TOKEN });
  });

  r.post('/api/setup', async (c) => {
    const body = await c.body();
    if (!c.env.SETUP_TOKEN) throw new HttpError(503, 'setup_disabled', 'SETUP_TOKEN is not configured.');
    await assertNotLimited(c.env, `setup:${c.ip}`, 5, 900);
    if (typeof body.token !== 'string' || !safeEqualStr(body.token, c.env.SETUP_TOKEN)) {
      await recordAttempt(c.env, `setup:${c.ip}`);
      throw new HttpError(403, 'bad_setup_token', 'Invalid setup token.');
    }
    const loginId = normalizeLoginId(body.login_id);
    const nickname = reqStr(body.nickname, 'Nickname', 1, 30);
    const pw = validatePassword(body.password, loginId);
    const hash = await hashPassword(pw, iterationsFor(c.env));
    // The WHERE clause makes the "first admin only" rule race-free.
    const res = await c.env.DB
      .prepare(
        `INSERT INTO users (login_id, nickname, password_hash, role)
         SELECT ?1, ?2, ?3, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
      )
      .bind(loginId, nickname, hash)
      .run();
    if (!res.meta.changes) throw conflict('already_setup', 'An administrator already exists.');
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE login_id = ?1').bind(loginId).first<{ id: number }>();
    await auditStmt(c.env.DB, user!.id, 'setup.first_admin', 'user', user!.id).run();
    return json({ ok: true }, 201);
  });

  // ---- registration (students only) ----
  r.post('/api/auth/register', async (c) => {
    const body = await c.body();
    await assertNotLimited(c.env, `register:${c.ip}`, 10, 3600);
    await recordAttempt(c.env, `register:${c.ip}`);
    const nickname = reqStr(body.nickname, 'Nickname', 1, 30);
    const loginId = normalizeLoginId(body.login_id);
    const pw = validatePassword(body.password, loginId);
    if (body.password_confirm !== pw) throw bad('Password confirmation does not match.', 'password_mismatch');
    const hash = await hashPassword(pw, iterationsFor(c.env));
    try {
      await c.env.DB
        .prepare(`INSERT INTO users (login_id, nickname, password_hash, role) VALUES (?1, ?2, ?3, 'student')`)
        .bind(loginId, nickname, hash)
        .run();
    } catch (e) {
      if (isUniqueError(e)) throw conflict('login_taken', 'That login ID is already taken.');
      throw e;
    }
    return json({ ok: true }, 201);
  });

  // ---- login / logout ----
  r.post('/api/auth/login', async (c) => {
    const body = await c.body();
    const loginId = typeof body.login_id === 'string' ? body.login_id.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!loginId || !password || loginId.length > 64 || password.length > 128) {
      throw bad('Login ID and password are required.');
    }
    const ipKey = `login-ip:${c.ip}`;
    const idKey = `login-id:${loginId}`;
    await assertNotLimited(c.env, ipKey, 20, 900);
    await assertNotLimited(c.env, idKey, 8, 900);

    const row = await c.env.DB
      .prepare('SELECT id, password_hash, is_active FROM users WHERE login_id = ?1')
      .bind(loginId)
      .first<{ id: number; password_hash: string; is_active: number }>();
    const ok = row ? await verifyPassword(password, row.password_hash) : (await fakeVerify(c.env, password), false);
    if (!row || !ok || !row.is_active) {
      await recordAttempt(c.env, ipKey);
      await recordAttempt(c.env, idKey);
      throw new HttpError(401, 'invalid_credentials', 'Invalid login ID or password.');
    }
    await clearAttempts(c.env, idKey);
    const token = await createSession(c.env, row.id);
    const me = await c.env.DB
      .prepare(
        `SELECT u.id, u.login_id, u.nickname, u.role, u.class_id, c.name AS class_name, u.balance, u.must_change_password
         FROM users u LEFT JOIN classes c ON c.id = u.class_id WHERE u.id = ?1`,
      )
      .bind(row.id)
      .first<Parameters<typeof publicUser>[0]>();
    return json({ user: publicUser(me!) }, 200, { 'set-cookie': sessionCookie(token) });
  });

  r.post('/api/auth/logout', async (c) => {
    if (c.user) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(c.user.token_hash).run();
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  });

  // ---- change own password (allowed while a password change is forced) ----
  r.post('/api/auth/change-password', async (c) => {
    if (!c.user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
    const body = await c.body();
    const key = `chpw:${c.user.id}`;
    await assertNotLimited(c.env, key, 8, 900);
    const row = await c.env.DB
      .prepare('SELECT password_hash FROM users WHERE id = ?1')
      .bind(c.user.id)
      .first<{ password_hash: string }>();
    const current = typeof body.current_password === 'string' ? body.current_password : '';
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      await recordAttempt(c.env, key);
      throw new HttpError(403, 'invalid_credentials', 'Current password is incorrect.');
    }
    const pw = validatePassword(body.new_password, c.user.login_id);
    if (body.new_password_confirm !== pw) throw bad('Password confirmation does not match.', 'password_mismatch');
    if (pw === current) throw bad('The new password must be different from the current one.');
    const hash = await hashPassword(pw, iterationsFor(c.env));
    // Invalidate every session on every device, then issue a fresh one for this device.
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET password_hash = ?1, must_change_password = 0 WHERE id = ?2').bind(hash, c.user.id),
      deleteUserSessions(c.env, c.user.id),
    ]);
    await clearAttempts(c.env, key);
    const token = await createSession(c.env, c.user.id);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token) });
  });

  r.get('/api/me', (c) => {
    if (!c.user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
    return json({ user: publicUser(c.user) });
  });

  void requireAuth;
}
