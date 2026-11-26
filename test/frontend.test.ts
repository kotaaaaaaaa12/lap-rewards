// Runs the real front-end scripts against a tiny fake DOM and a mocked API.
// It catches runtime errors (typos, wrong property names, bad data handling) without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class FakeNode {}
class FakeText extends FakeNode { data: string; constructor(d: string) { super(); this.data = d; } get textContent() { return this.data; } }
class FakeEl extends FakeNode {
  tag: string; children: FakeNode[] = []; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {};
  className = ''; hidden = false; value = ''; open = false; parent: FakeEl | null = null;
  constructor(tag: string) { super(); this.tag = tag; }
  append(...kids: FakeNode[]) { for (const k of kids) { (k as any).parent = this; this.children.push(k); } }
  get firstChild() { return this.children[0] ?? null; }
  removeChild(c: FakeNode) { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f); }
  replaceWith(n: FakeNode) { if (this.parent) this.parent.children = this.parent.children.map((x) => (x === this ? n : x)); }
  remove() { if (this.parent) this.parent.removeChild(this); }
  querySelector() { return null; } focus() {} reset() {} reportValidity() { return true; }
  showModal() { this.open = true; } close() { this.open = false; (this.listeners.close ?? []).forEach((f) => f()); }
  get textContent(): string { return this.children.map((c: any) => c.textContent).join(' '); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => (c instanceof FakeEl ? c.all() : []))]; }
}

export function makeWindow() {
  const body = new FakeEl('body');
  const app = new FakeEl('div'); const toastEl = new FakeEl('div');
  const document = {
    documentElement: {} as Record<string, string>,
    body, createElement: (t: string) => new FakeEl(t), createElementNS: (_ns: string, t: string) => new FakeEl(t), createTextNode: (d: string) => new FakeText(d),
    getElementById: (id: string) => (id === 'app' ? app : toastEl), querySelector: () => null,
  };
  const ctx: any = {
    document, Node: FakeNode, console, setTimeout, clearTimeout, Intl, URLSearchParams, Number, String, Math, Date, Object, Array, Map, Set, Promise, JSON,
    location: { hash: '', replace(h: string) { this.hash = h; } },
    window: { addEventListener() {}, scrollTo() {} }, navigator: {}, crypto: { randomUUID: () => 'abcdef12-3456-7890-abcd-ef1234567890' },
    fetch: async () => { throw new Error('network disabled in tests'); },
  };
  ctx.window.location = ctx.location;
  vm.createContext(ctx);
  // `const`/`let` declarations are not exposed on the context object, so run a snippet that exports them.
  for (const f of ['i18n', 'core', 'student', 'staff', 'admin', 'main']) {
    vm.runInContext(readFileSync(`public/${f}.js`, 'utf8').replace(/^boot\(\);$/m, ''), ctx, { filename: f + '.js' });
  }
  return { ctx, app };
}

const tx = (o: any = {}) => ({ id: 5, created_at: '2026-11-25T01:00:00.000Z', student_id: 3, student_nickname: 'Alice <b>x</b>', student_login_id: 'alice', amount: 10, balance_after: 10, type: 'award', reason: '<img src=x onerror=alert(1)>', operator_id: 2, operator_nickname: 'Ms T', ref_transaction_id: null, cancelled_by: null, ...o });
const mock = (routes: Record<string, any>) => async (method: string, path: string) => {
  const key = `${method} ${path.split('?')[0]}`;
  if (!(key in routes)) throw new Error('unmocked API call: ' + key);
  const v = routes[key];
  return typeof v === 'function' ? v() : v;
};
const text = (el: FakeEl) => el.textContent.replace(/\s+/g, ' ');

test('every view renders with realistic data and never injects markup', async () => {
  const { ctx } = makeWindow();
  const run = (code: string) => vm.runInContext(code, ctx);
  const student = { id: 3, login_id: 'alice', nickname: 'Alice', role: 'student', class_id: 1, class_name: '1-A', balance: 25, must_change_password: false };
  const staffUser = { ...student, id: 2, role: 'teacher', nickname: 'Ms T', class_id: null, class_name: null };
  const adminUser = { ...staffUser, id: 1, role: 'admin', nickname: 'Admin' };
  const stu = { id: 3, login_id: 'alice', nickname: 'Alice', balance: 25, is_active: 1, class_id: 1, class_name: '1-A' };

  const routes: Record<string, any> = {
    'GET /me': { user: student }, 'GET /me/transactions': { transactions: [tx(), tx({ id: 6, type: 'redeem', amount: -5, cancelled_by: 9 })] },
    'GET /me/redemptions': { redemptions: [{ id: 1, status: 'pending', cost_at_request: 5, created_at: '2026-11-25T01:00:00Z', reward_name: 'Cookie' }] },
    'GET /rewards': { rewards: [{ id: 1, name: 'Cookie', description: 'Yum', cost: 5 }, { id: 2, name: 'Big prize', description: '', cost: 500 }] },
    'GET /classes': { classes: [{ id: 1, name: '1-A', student_count: 2 }], unassigned_count: 1 },
    'GET /students': { students: [stu, { ...stu, id: 4, login_id: 'bob', nickname: 'Bob', class_id: null, class_name: null }], total: 2 },
    'GET /students/3': { student: stu }, 'GET /points/transactions': { transactions: [tx()] },
    'GET /admin/overview': { overview: { students: 2, teachers: 1, classes: 1, total_balance: 50, pending_redemptions: 1, transactions_7d: 4 } },
    'GET /admin/users': { users: [{ id: 3, login_id: 'alice', nickname: 'Alice', role: 'student', balance: 25, is_active: 1, must_change_password: 0, class_id: 1, class_name: '1-A', created_at: '' }, { id: 1, login_id: 'admin', nickname: 'Admin', role: 'admin', balance: 0, is_active: 1, must_change_password: 0, class_id: null, class_name: null, created_at: '' }], total: 2 },
    'GET /admin/rewards': { rewards: [{ id: 1, name: 'Cookie', description: 'Yum', cost: 5, is_active: 1 }, { id: 2, name: 'Old', description: '', cost: 9, is_active: 0 }] },
    'GET /admin/redemptions': { redemptions: [{ id: 1, status: 'pending', cost_at_request: 5, created_at: '2026-11-25T01:00:00Z', updated_at: null, student_id: 3, student_nickname: 'Alice', student_login_id: 'alice', reward_name: 'Cookie' }] },
    'GET /admin/audit-logs': { logs: [{ id: 1, created_at: '2026-11-25T01:00:00Z', actor_id: 1, actor_nickname: 'Admin', action: 'points.award', target_type: 'student', target_id: null, detail: '{"amount":5}' }] },
    'GET /admin/backups': { backups: [{ key: 'backups/lap-20261125T180000Z.json.gz', size: 2048, uploaded: '2026-11-25T18:00:00Z' }] },
  };
  ctx.__mock = mock(routes);
  run('api = __mock');

  const render = async (user: any, fn: string, ...args: any[]) => {
    ctx.__user = user; ctx.__args = args;
    run('state.user = __user');
    const root = new FakeEl('div');
    ctx.__root = root;
    await run(`${fn}(__root, ...__args)`);
    return root;
  };

  let root = await render(student, 'viewHome');
  assert.match(text(root), /Your points 25/); assert.match(text(root), /Class 1-A/);
  root = await render(student, 'viewRewards');
  assert.match(text(root), /Cookie/); assert.match(text(root), /Not enough/);
  root = await render(student, 'viewHistory'); assert.match(text(root), /Points awarded/);
  root = await render(student, 'viewAccount'); assert.match(text(root), /alice/);

  // User-provided text must be a text node, never parsed as HTML.
  const all = root.all();
  root = await render(student, 'viewHistory');
  assert.ok(root.all().every((e) => e.tag !== 'img' && e.tag !== 'b'), 'no injected elements');
  assert.ok(text(root).includes('<img src=x onerror=alert(1)>'), 'raw text is shown verbatim');
  void all;

  const q = new URLSearchParams();
  ctx.__q = q;
  root = await render(staffUser, 'viewStudents', q); assert.match(text(root), /Alice/); assert.match(text(root), /Select all 2 shown/);
  root = await render(staffUser, 'viewStudent', '3'); assert.match(text(root), /Award points/); assert.doesNotMatch(text(root), /Adjust points/);
  root = await render(adminUser, 'viewStudent', '3'); assert.match(text(root), /Adjust points/);
  root = await render(staffUser, 'viewClasses'); assert.match(text(root), /1-A/); assert.match(text(root), /2 students/);
  root = await render(staffUser, 'viewAwards'); assert.match(text(root), /Award history/);

  root = await render(adminUser, 'viewAdminOverview'); assert.match(text(root), /Pending redemptions/);
  root = await render(adminUser, 'viewAdminUsers'); assert.match(text(root), /Make teacher/);
  root = await render(adminUser, 'viewAdminRewards'); assert.match(text(root), /Old \(hidden\)/);
  root = await render(adminUser, 'viewAdminRedemptions', new URLSearchParams()); assert.match(text(root), /Complete/);
  root = await render(adminUser, 'viewAdminAudit'); assert.match(text(root), /Points awarded/);
  root = await render(adminUser, 'viewAdminBackups'); assert.match(text(root), /2\.0 KB/);

  // Full render() path: shell, navigation, and the forced password change screen.
  const { ctx: c2, app } = makeWindow();
  c2.__mock = mock({ ...routes, 'GET /me': { user: student } });
  vm.runInContext('api = __mock; state.user = ' + JSON.stringify(student), c2);
  await vm.runInContext('render()', c2);
  assert.match(text(app), /Home Rewards History Account/);
  vm.runInContext('state.user = ' + JSON.stringify({ ...adminUser, must_change_password: true }), c2);
  await vm.runInContext('render()', c2);
  assert.match(text(app), /Choose a new password/);
  vm.runInContext('state.user = ' + JSON.stringify(adminUser) + '; location.hash = "#/admin"', c2);
  await vm.runInContext('render()', c2);
  assert.match(text(app), /Students Classes Awards Admin Account/);
  vm.runInContext('state.user = null', c2);
  await vm.runInContext('render()', c2);
  assert.match(text(app), /Sign in/);
});

test('Japanese: views render translated text with no unreplaced placeholders', async () => {
  const { ctx, app } = makeWindow();
  const run = (code: string) => vm.runInContext(code, ctx);
  run("setLang('ja')");
  assert.equal(ctx.document.documentElement.lang, 'ja-JP');
  const student = { id: 3, login_id: 'alice', nickname: 'Alice', role: 'student', class_id: 1, class_name: '1-A', balance: 25, must_change_password: false };
  ctx.__mock = mock({
    'GET /me': { user: student },
    'GET /me/transactions': { transactions: [tx({ type: 'redeem', reason: 'Redeemed: Cookie', amount: -5 })] },
    'GET /me/redemptions': { redemptions: [{ id: 1, status: 'pending', cost_at_request: 5, created_at: '2026-11-25T01:00:00Z', reward_name: 'Cookie' }] },
    'GET /rewards': { rewards: [{ id: 1, name: 'Cookie', description: '', cost: 5 }] },
  });
  run('api = __mock; state.user = ' + JSON.stringify(student));
  await run('render()');
  const home = text(app);
  assert.match(home, /あなたのポイント 25/);
  assert.match(home, /クラス 1-A/);
  assert.match(home, /交換: Cookie/, 'system-generated reason is translated');
  assert.match(home, /ホーム 景品 履歴 アカウント/);
  assert.match(home, /受け渡し待ちの景品リクエストが1件あります/);
  assert.doesNotMatch(home, /\{\w+\}/, 'no unreplaced placeholders');

  run('location.hash = "#/rewards"');
  await run('render()');
  assert.match(text(app), /ポイント不足|交換する/);

  // Language can be switched back.
  run("setLang('en')");
  await run('render()');
  assert.match(text(app), /Home Rewards History Account/);

  // Server validation messages with dynamic parts are translated by pattern.
  run("setLang('ja')");
  assert.equal(run("t('Amount must be an integer between 1 and 100000.')"), 'ポイント数は1〜100000の整数で入力してください。');
  assert.equal(run("t('Reason is required.')"), '理由を入力してください。');
  assert.equal(run("t('Unknown message from a future server')"), 'Unknown message from a future server', 'falls back to English');
});
