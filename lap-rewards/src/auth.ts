import type { Env, SessionUser } from './types.ts';
import { HttpError } from './http.ts';

const enc = new TextEncoder();

// ---------- encoding helpers ----------
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (b: Uint8Array) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const safeEqualStr = (a: string, b: string) => timingSafeEqual(enc.encode(a), enc.encode(b));

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- password hashing (PBKDF2-SHA256, Web Crypto) ----------
// Workers cap PBKDF2 at 100,000 iterations, so that is the default and the maximum.
const MAX_ITERATIONS = 100_000;

export function iterationsFor(env: Env): number {
  const n = Number(env.PBKDF2_ITERATIONS);
  if (!Number.isInteger(n) || n < 1) return MAX_ITERATIONS;
  return Math.min(n, MAX_ITERATIONS);
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, it, salt, hash] = stored.split('$');
  const iterations = Number(it);
  if (alg !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || !salt || !hash) return false;
  const got = await derive(password, fromB64(salt), Math.min(iterations, MAX_ITERATIONS));
  return timingSafeEqual(got, fromB64(hash));
}

let dummy: Promise<string> | null = null;
/** Burns the same CPU as a real check so unknown login IDs are not distinguishable by timing. */
export async function fakeVerify(env: Env, password: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password', iterationsFor(env));
  await verifyPassword(password, await dummy);
}

export function validatePassword(pw: unknown, loginId?: string): string {
  if (typeof pw !== 'string') throw new HttpError(400, 'bad_request', 'Password is required.');
  if (pw.length < 8 || pw.length > 128) {
    throw new HttpError(400, 'weak_password', 'Password must be between 8 and 128 characters.');
  }
  if (loginId && pw.toLowerCase() === loginId.toLowerCase()) {
    throw new HttpError(400, 'weak_password', 'Password must not be the same as your login ID.');
  }
  return pw;
}

/** Random temporary password (no look-alike characters). */
export function tempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

// ---------- sessions ----------
export const SESSION_COOKIE = 'lap_session';
const SESSION_TTL = 14 * 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256Hex(token), userId, nowSec() + SESSION_TTL)
    .run();
  return token;
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Strict`;
export const clearCookie = () => `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function loadSession(env: Env, req: Request): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare(
      `SELECT u.id, u.login_id, u.nickname, u.role, u.class_id, c.name AS class_name, u.balance,
              u.must_change_password, u.is_active, s.expires_at, s.token_hash
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN classes c ON c.id = u.class_id
       WHERE s.token_hash = ?1`,
    )
    .bind(hash)
    .first<SessionUser & { is_active: number; expires_at: number }>();
  if (!row || !row.is_active || row.expires_at < nowSec()) return null;
  if (row.expires_at - nowSec() < SESSION_TTL / 2) {
    // Sliding expiration.
    await env.DB
      .prepare('UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2')
      .bind(nowSec() + SESSION_TTL, hash)
      .run();
  }
  const { is_active: _a, expires_at: _e, ...user } = row;
  return user;
}

export const deleteUserSessions = (env: Env, userId: number) =>
  env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId);

// ---------- rate limiting ----------
async function count(env: Env, key: string, windowSec: number): Promise<number> {
  const r = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1 AND at > ?2')
    .bind(key, nowSec() - windowSec)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function recordAttempt(env: Env, key: string): Promise<void> {
  await env.DB.prepare('INSERT INTO auth_attempts (key, at) VALUES (?1, ?2)').bind(key, nowSec()).run();
}

export async function clearAttempts(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?1').bind(key).run();
}

/** Throws 429 when `key` already has `max` or more recorded attempts inside the window. */
export async function assertNotLimited(env: Env, key: string, max: number, windowSec: number): Promise<void> {
  if ((await count(env, key, windowSec)) >= max) {
    throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a while and try again.');
  }
}
