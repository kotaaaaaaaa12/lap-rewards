import type { Env, SessionUser } from './types.ts';
import { ensureSchema } from './db.ts';
import { loadSession } from './auth.ts';
import { HttpError, json } from './http.ts';
import { Router, readJson } from './router.ts';
import type { Ctx, Exec } from './router.ts';
import { authRoutes } from './routes/auth.ts';
import { studentRoutes } from './routes/student.ts';
import { staffRoutes } from './routes/staff.ts';
import { adminRoutes } from './routes/admin.ts';
import { pushRoutes } from './routes/push.ts';
import { pruneBackups, runBackup } from './backup.ts';
import { PUSH_CRON, defer, dispatchPushEvents, pushCleanupStmts, runPushCron } from './push.ts';

const router = new Router();
authRoutes(router);
studentRoutes(router);
staffRoutes(router);
adminRoutes(router);
pushRoutes(router);

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Requests that can create a notification-worthy event (a ledger row or a completed redemption).
const EVENT_PATHS = /^\/api\/(points\/|admin\/(points|redemptions)\/)/;

export async function handleRequest(req: Request, env: Env, exec?: Exec): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

  let user: SessionUser | null = null;
  try {
    // CSRF defence in depth (cookies are also SameSite=Strict): state-changing requests
    // must come from this same origin.
    if (UNSAFE.has(req.method) && req.headers.get('origin') !== url.origin) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed.');
    }
    await ensureSchema(env.DB);
    user = await loadSession(env, req);
    const ctx: Ctx = {
      req, env, url, params: {}, user,
      ip: req.headers.get('cf-connecting-ip') ?? 'unknown',
      body: <T>() => readJson<T>(req),
      exec,
    } as Ctx;
    const res = await router.handle(ctx);
    // Announce what this request did. It runs after the response is sent (waitUntil) and never fails the request.
    if (res && res.status < 400 && UNSAFE.has(req.method) && EVENT_PATHS.test(url.pathname)) {
      await defer(ctx, dispatchPushEvents(env));
    }
    return res ?? json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error('Unhandled error', e);
    // Administrators also get the underlying error text, so failures can be diagnosed from the UI.
    const detail = user && user.role === 'admin' ? String((e as Error)?.message ?? e).slice(0, 300) : undefined;
    return json({ error: { code: 'internal_error', message: 'Something went wrong.', detail } }, 500);
  }
}

export async function runScheduled(env: Env): Promise<void> {
  await ensureSchema(env.DB);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM auth_attempts WHERE at < ?1').bind(now - 86_400),
    ...pushCleanupStmts(env.DB, now),
  ]);
  await runBackup(env);
  await pruneBackups(env);
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => handleRequest(req, env, ctx),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Two schedules: every minute delivers pending notifications, daily does maintenance and the backup.
    ctx.waitUntil(event.cron === PUSH_CRON ? ensureSchema(env.DB).then(() => runPushCron(env)) : runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
