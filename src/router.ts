import type { Env, SessionUser, Role } from './types.ts';
import { HttpError, bad, forbidden } from './http.ts';

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  user: SessionUser | null;
  ip: string;
  body<T = Record<string, unknown>>(): Promise<T>;
}

export type Handler = (c: Ctx) => Promise<Response | void> | Response | void;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handlers: Handler[];
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, ...handlers: Handler[]) {
    const keys: string[] = [];
    const pattern = path.replace(/:([A-Za-z_]+)/g, (_m, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${pattern}$`), keys, handlers });
  }
  get = (p: string, ...h: Handler[]) => this.add('GET', p, ...h);
  post = (p: string, ...h: Handler[]) => this.add('POST', p, ...h);
  put = (p: string, ...h: Handler[]) => this.add('PUT', p, ...h);
  patch = (p: string, ...h: Handler[]) => this.add('PATCH', p, ...h);
  delete = (p: string, ...h: Handler[]) => this.add('DELETE', p, ...h);

  async handle(c: Ctx): Promise<Response | null> {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(c.url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== c.req.method) continue;
      c.params = {};
      r.keys.forEach((k, i) => (c.params[k] = decodeURIComponent(m[i + 1])));
      for (const h of r.handlers) {
        const res = await h(c);
        if (res) return res;
      }
      throw new HttpError(500, 'no_response', 'Handler returned no response.');
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    return null;
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw bad('Content-Type must be application/json.');
  const text = await req.text();
  if (text.length > 65536) throw new HttpError(413, 'too_large', 'Request body is too large.');
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw bad('Request body must be a JSON object.');
  }
}

const passwordChangeRequired = () =>
  new HttpError(403, 'password_change_required', 'You must change your password first.');

/** Middleware: a valid session is required. */
export const requireAuth: Handler = (c) => {
  if (!c.user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  if (c.user.must_change_password) throw passwordChangeRequired();
};

/** Middleware: a session with one of the given roles is required. */
export const requireRole =
  (...roles: Role[]): Handler =>
  (c) => {
    if (!c.user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
    if (c.user.must_change_password) throw passwordChangeRequired();
    if (!roles.includes(c.user.role)) throw forbidden();
  };
