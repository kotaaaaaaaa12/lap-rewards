import type { Env } from './types.ts';
import { ensureSchema } from './db.ts';
import { loadSession } from './auth.ts';
import { HttpError, json } from './http.ts';
import { Router, readJson } from './router.ts';
import type { Ctx } from './router.ts';
import { authRoutes } from './routes/auth.ts';
import { studentRoutes } from './routes/student.ts';
import { staffRoutes } from './routes/staff.ts';
import { adminRoutes } from './routes/admin.ts';
import { pruneBackups, runBackup } from './backup.ts';

const router = new Router();
authRoutes(router);
studentRoutes(router);
staffRoutes(router);
adminRoutes(router);

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

  try {
    // CSRF defence in depth (cookies are also SameSite=Strict): state-changing requests
    // must come from this same origin.
    if (UNSAFE.has(req.method) && req.headers.get('origin') !== url.origin) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed.');
    }
    await ensureSchema(env.DB);
    const user = await loadSession(env, req);
    const ctx: Ctx = {
      req, env, url, params: {}, user,
      ip: req.headers.get('cf-connecting-ip') ?? 'unknown',
      body: <T>() => readJson<T>(req),
    } as Ctx;
    const res = await router.handle(ctx);
    return res ?? json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error('Unhandled error', e);
    return json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500);
  }
}

export async function runScheduled(env: Env): Promise<void> {
  await ensureSchema(env.DB);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM auth_attempts WHERE at < ?1').bind(now - 86_400),
  ]);
  await runBackup(env);
  await pruneBackups(env);
}

export default {
  fetch: (req: Request, env: Env) => handleRequest(req, env),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
