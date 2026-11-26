import { makeEnv } from './fake.ts';
import { handleRequest } from '../src/index.ts';

const ORIGIN = 'https://t.example';
let counter = 0;
export const key = () => `k${Date.now()}${++counter}`.padEnd(12, 'x');

export class Client {
  env: ReturnType<typeof makeEnv>;
  cookie = '';
  ip: string;
  constructor(env: ReturnType<typeof makeEnv>, ip = '1.1.1.1') {
    this.env = env;
    this.ip = ip;
  }
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { origin: ORIGIN, 'cf-connecting-ip': this.ip, ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await handleRequest(
      new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      this.env,
    );
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.startsWith('lap_session=;') ? '' : set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data: data as any };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b?: unknown) => this.call('POST', p, b ?? {});
  patch = (p: string, b?: unknown) => this.call('PATCH', p, b);
  del = (p: string) => this.call('DELETE', p);
  async login(login_id: string, password: string) {
    return this.post('/api/auth/login', { login_id, password });
  }
}

/** Environment with an admin (admin/adminpass1), a teacher and two students. */
export async function seed() {
  const env = makeEnv();
  const admin = new Client(env, '10.0.0.1');
  let r = await admin.post('/api/setup', { token: 'setup-token-for-tests', login_id: 'admin', nickname: 'Admin', password: 'adminpass1' });
  if (r.status !== 201) throw new Error('setup failed ' + JSON.stringify(r));
  await admin.login('admin', 'adminpass1');

  const t = await admin.post('/api/admin/users', { login_id: 'teacher1', nickname: 'Ms Teacher', role: 'teacher' });
  const teacher = new Client(env, '10.0.0.2');
  await teacher.login('teacher1', t.data.temporary_password);
  await teacher.post('/api/auth/change-password', {
    current_password: t.data.temporary_password, new_password: 'teacherpass1', new_password_confirm: 'teacherpass1',
  });

  const students: Client[] = [];
  for (const [i, name] of ['alice', 'bob'].entries()) {
    const c = new Client(env, `10.0.1.${i}`);
    r = await c.post('/api/auth/register', { nickname: name.toUpperCase(), login_id: name, password: 'studentpass1', password_confirm: 'studentpass1' });
    if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r));
    await c.login(name, 'studentpass1');
    students.push(c);
  }
  const list = await teacher.get('/api/students');
  const ids: Record<string, number> = {};
  for (const s of list.data.students) ids[s.login_id] = s.id;
  return { env, admin, teacher, alice: students[0], bob: students[1], ids };
}
