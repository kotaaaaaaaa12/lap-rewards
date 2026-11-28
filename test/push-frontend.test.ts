// Runs the real front-end scripts for notifications against a fake DOM and a fake browser
// (service worker, PushManager, Notification), with the API mocked. It checks the behaviour a person sees:
// what the card says in each situation, what a tap does, and that another account's subscription is dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class FakeNode {}
class FakeText extends FakeNode { data: string; constructor(d: string) { super(); this.data = d; } get textContent() { return this.data; } }
class FakeEl extends FakeNode {
  tag: string; children: FakeNode[] = []; attrs: Record<string, string> = {}; listeners: Record<string, Function[]> = {};
  className = ''; hidden = false; value = ''; checked = false; disabled = false; type = ''; parent: FakeEl | null = null;
  constructor(tag: string) { super(); this.tag = tag; }
  append(...kids: FakeNode[]) { for (const k of kids) { (k as any).parent = this; this.children.push(k); } }
  get firstChild() { return this.children[0] ?? null; }
  removeChild(c: FakeNode) { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f); }
  get textContent(): string { return this.children.map((c: any) => c.textContent).join(' '); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => (c instanceof FakeEl ? c.all() : []))]; }
  async fire(type: string) { for (const f of this.listeners[type] ?? []) await f({ currentTarget: this, target: this }); }
}
const plain = (x: unknown) => JSON.parse(JSON.stringify(x)); // objects made inside the vm have another prototype
const text = (el: FakeEl) => el.textContent.replace(/\s+/g, ' ').trim();
const button = (root: FakeEl, label: string) => {
  const b = root.all().find((e) => e.tag === 'button' && text(e) === label);
  assert.ok(b, `button "${label}" not found in: ${text(root)}`);
  return b!;
};
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

interface Opts {
  supported?: boolean; permission?: 'default' | 'granted' | 'denied'; ua?: string; standalone?: boolean;
  existing?: string | null; // endpoint of a subscription the browser already holds
  grant?: boolean; role?: string; serverKnows?: string[]; serverLang?: string;
}

function makeBrowser(o: Opts = {}) {
  const log = { api: [] as [string, string, any][], subscribeOptions: [] as any[], requestPermission: 0, unsubscribed: [] as string[], toasts: [] as string[] };
  const server = {
    devices: new Set(o.serverKnows ?? []), lang: o.serverLang ?? 'en', prefs: { points: true, redemptions: true },
  };
  const makeSub = (endpoint: string) => ({
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'P256DH', auth: 'AUTH' } }),
    unsubscribe: async () => { log.unsubscribed.push(endpoint); reg.sub = null; return true; },
  });
  const reg: { sub: any; pushManager: any } = {
    sub: o.existing ? makeSub(o.existing) : null,
    pushManager: {
      getSubscription: async () => reg.sub,
      subscribe: async (opts: any) => { log.subscribeOptions.push(opts); reg.sub = makeSub('https://fcm.googleapis.com/fcm/send/new-device'); return reg.sub; },
    },
  };
  const supported = o.supported !== false;
  const notification: any = { permission: o.permission ?? 'default', requestPermission: async () => { log.requestPermission++; notification.permission = o.grant === false ? 'denied' : 'granted'; return notification.permission; } };
  const body = new FakeEl('body'); const app = new FakeEl('div'); const toastEl = new FakeEl('div');
  const document = {
    documentElement: {} as Record<string, string>, body,
    createElement: (t: string) => new FakeEl(t), createElementNS: (_n: string, t: string) => new FakeEl(t), createTextNode: (d: string) => new FakeText(d),
    getElementById: (id: string) => (id === 'app' ? app : toastEl),
  };
  const window: any = { addEventListener() {}, matchMedia: () => ({ matches: !!o.standalone }) };
  const navigator: any = { userAgent: o.ua ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', platform: 'Linux', maxTouchPoints: 0 };
  if (supported) { navigator.serviceWorker = { ready: Promise.resolve(reg) }; window.PushManager = function PushManager() {}; window.Notification = notification; }
  const ctx: any = {
    document, window, navigator, Node: FakeNode, console, Intl, URLSearchParams, Promise, JSON, Math, Date, Object, Array, Uint8Array, Error, atob,
    setTimeout: (f: () => void, ms: number) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout,
    location: { hash: '' }, crypto: { randomUUID: () => 'abcdef12-3456-7890-abcd-ef1234567890' },
  };
  if (supported) ctx.Notification = notification;
  vm.createContext(ctx);
  for (const f of ['i18n', 'i18n-push', 'core', 'student', 'push']) vm.runInContext(readFileSync(`public/${f}.js`, 'utf8'), ctx, { filename: f + '.js' });

  const routes: Record<string, (b: any) => any> = {
    'GET /push/key': () => ({ public_key: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4' }),
    'POST /me/push/status': (b) => ({ subscribed: server.devices.has(b.endpoint), lang: server.devices.has(b.endpoint) ? server.lang : null }),
    'POST /me/push/subscribe': (b) => { server.devices.add(b.endpoint); server.lang = b.lang; return { ok: true }; },
    'POST /me/push/unsubscribe': (b) => { server.devices.delete(b.endpoint); return { ok: true }; },
    'GET /me/notifications': () => ({ prefs: { ...server.prefs }, devices: server.devices.size }),
    'PUT /me/notifications': (b) => { Object.assign(server.prefs, b); return { ok: true }; },
    'POST /me/push/test': () => ({ ok: true, devices: server.devices.size }),
    'POST /auth/logout': () => ({ ok: true }),
  };
  ctx.__api = async (method: string, path: string, body?: any) => {
    log.api.push([method, path, body]);
    const f = routes[`${method} ${path}`];
    if (!f) throw new Error('unmocked API call: ' + method + ' ' + path);
    return f(body);
  };
  vm.runInContext('api = __api; render = () => {}', ctx);
  ctx.__user = { id: 3, login_id: 'alice', nickname: 'Alice', role: o.role ?? 'student', class_id: null, class_name: null, balance: 0, must_change_password: false };
  vm.runInContext('state.user = __user', ctx);
  const run = (code: string) => vm.runInContext(code, ctx);
  const card = async () => { const c = run('pushCard()') as FakeEl; await settle(); return c; };
  return { ctx, log, server, reg, notification, run, card, app, toastEl };
}

test('browsers without push support: a calm explanation, no server calls, the app is unaffected', async () => {
  const b = makeBrowser({ supported: false });
  const c = await b.card();
  assert.match(text(c), /This browser does not support notifications\. You can still use all other features\./);
  assert.equal(b.log.api.length, 0);
  assert.ok(!c.all().some((e) => e.tag === 'button'));
});

test('iPhone/iPad in Safari (not installed): tells how to add the app to the Home Screen', async () => {
  const b = makeBrowser({ supported: false, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  const c = await b.card();
  assert.match(text(c), /add this app to your Home Screen \(Share → Add to Home Screen\)/);
  // installed but still unsupported (an old iOS): the generic message instead
  const old = makeBrowser({ supported: false, standalone: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)' });
  assert.match(text(await old.card()), /does not support notifications/);
  // iPadOS 13+ reports itself as a Mac
  const ipad = makeBrowser({ supported: false, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' });
  ipad.ctx.navigator.platform = 'MacIntel'; ipad.ctx.navigator.maxTouchPoints = 5;
  assert.match(text(await ipad.card()), /Home Screen/);
});

test('permission blocked in the browser: explains where to change it, offers no button', async () => {
  const b = makeBrowser({ permission: 'denied' });
  const c = await b.card();
  assert.match(text(c), /Notifications are blocked\. Allow them for this site/);
  assert.ok(!c.all().some((e) => e.tag === 'button'));
  assert.equal(b.log.requestPermission, 0, 'never prompts on its own');
});

test('turning notifications on: asks permission on the tap, subscribes with the server key, registers the device', async () => {
  const b = makeBrowser({ permission: 'default' });
  let c = await b.card();
  assert.match(text(c), /Get notified when you receive points/);
  assert.equal(b.log.requestPermission, 0, 'nothing happens before the person taps');
  assert.equal(b.log.api.length, 0);

  await button(c, 'Turn on notifications').fire('click');
  await settle();
  assert.equal(b.log.requestPermission, 1);
  assert.equal(b.log.subscribeOptions.length, 1);
  assert.equal(b.log.subscribeOptions[0].userVisibleOnly, true);
  const key = b.log.subscribeOptions[0].applicationServerKey as Uint8Array;
  assert.equal(key.length, 65);
  assert.equal(key[0], 4, 'the server key, decoded from base64url');
  const sub = b.log.api.find(([m, p]) => m === 'POST' && p === '/me/push/subscribe')!;
  assert.deepEqual(plain(sub[2]), { endpoint: 'https://fcm.googleapis.com/fcm/send/new-device', keys: { p256dh: 'P256DH', auth: 'AUTH' }, lang: 'en' });
  assert.ok(b.server.devices.has('https://fcm.googleapis.com/fcm/send/new-device'));
  assert.match(b.toastEl.textContent, /Notifications turned on\./);
});

test('permission refused at the prompt: the app keeps working and nothing is registered', async () => {
  const b = makeBrowser({ permission: 'default', grant: false });
  const c = await b.card();
  await button(c, 'Turn on notifications').fire('click');
  await settle();
  assert.match(b.toastEl.textContent, /Notifications were not allowed\./);
  assert.equal(b.log.subscribeOptions.length, 0);
  assert.equal(b.server.devices.size, 0);
});

test('a failure while registering removes the half-made subscription', async () => {
  const b = makeBrowser({ permission: 'default' });
  const c = await b.card();
  b.ctx.api = async (m: string, p: string) => { if (p === '/me/push/subscribe') { const e: any = new Error('boom'); e.status = 500; throw e; } return b.ctx.__api(m, p); };
  await button(c, 'Turn on notifications').fire('click');
  await settle();
  assert.deepEqual(b.log.unsubscribed, ['https://fcm.googleapis.com/fcm/send/new-device']);
});

test('turned on: shows the switches, saves changes, sends a test, and turns off again', async () => {
  const ep = 'https://fcm.googleapis.com/fcm/send/mine';
  const b = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [ep] });
  let c = await b.card();
  assert.match(text(c), /Notifications are on for this device\./);
  assert.match(text(c), /Point changes/); assert.match(text(c), /Reward requests/);
  const boxes = c.all().filter((e) => e.tag === 'input');
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((x) => x.checked));

  boxes[0].checked = false; await boxes[0].fire('change');
  assert.deepEqual(plain(b.log.api.filter(([m]) => m === 'PUT').at(-1)), ['PUT', '/me/notifications', { points: false }]);
  assert.equal(b.server.prefs.points, false);

  // a failed save puts the switch back
  b.ctx.api = async (m: string, p: string, body?: any) => { if (m === 'PUT') { const e: any = new Error('nope'); e.status = 500; throw e; } return b.ctx.__api(m, p, body); };
  boxes[1].checked = false; await boxes[1].fire('change');
  assert.equal(boxes[1].checked, true, 'reverted');
  b.ctx.api = b.ctx.__api;

  await button(c, 'Send a test notification').fire('click');
  assert.match(b.toastEl.textContent, /Test notification sent\./);

  await button(c, 'Turn off notifications').fire('click');
  await settle();
  assert.deepEqual(b.log.unsubscribed, [ep]);
  assert.ok(!b.server.devices.has(ep));
  assert.match(b.toastEl.textContent, /Notifications turned off\./);
});

test('a subscription left in the browser by someone else is removed instead of shown as "on"', async () => {
  const ep = 'https://fcm.googleapis.com/fcm/send/not-mine';
  const b = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [] });
  const c = await b.card();
  assert.match(text(c), /Turn on notifications/);
  assert.deepEqual(b.log.unsubscribed, [ep]);
});

test('home page sync: foreign subscription is dropped once per page load; own one only refreshes the language', async () => {
  const ep = 'https://fcm.googleapis.com/fcm/send/shared-tablet';
  const foreign = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [] });
  await foreign.run('pushSync()'); await settle();
  assert.deepEqual(foreign.log.unsubscribed, [ep]);
  await foreign.run('pushSync()'); await settle();
  assert.equal(foreign.log.api.filter(([, p]) => p === '/me/push/status').length, 1, 'only once per page load');

  const own = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [ep], serverLang: 'en' });
  await own.run('pushSync()'); await settle();
  assert.deepEqual(own.log.unsubscribed, []);
  assert.equal(own.log.api.filter(([, p]) => p === '/me/push/subscribe').length, 0, 'same language: nothing to update');

  const ja = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [ep], serverLang: 'en' });
  ja.run("setLang('ja')");
  await ja.run('pushSync()'); await settle();
  assert.equal(ja.server.lang, 'ja', 'messages now follow the app language');

  const teacher = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [ep], role: 'teacher' });
  await teacher.run('pushSync()'); await settle();
  assert.equal(teacher.log.api.length, 0, 'only students are involved');

  const none = makeBrowser({ permission: 'default' });
  await none.run('pushSync()'); await settle();
  assert.equal(none.log.api.length, 0, 'no permission, no calls');
});

test('signing out removes this device first and never blocks', async () => {
  const ep = 'https://fcm.googleapis.com/fcm/send/mine';
  const b = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [ep] });
  await b.run('pushOnSignOut()');
  assert.deepEqual(b.log.api.map(([m, p]) => `${m} ${p}`), ['POST /me/push/unsubscribe']);
  assert.deepEqual(b.log.unsubscribed, [ep]);

  const broken = makeBrowser({ permission: 'granted', existing: ep });
  broken.ctx.api = async () => { throw new Error('offline'); };
  await broken.run('pushOnSignOut()'); // must resolve
  const unsupported = makeBrowser({ supported: false });
  await unsupported.run('pushOnSignOut()');
});

test('Account page: students get the Notifications card, staff do not; Japanese text is used in Japanese', async () => {
  const student = makeBrowser({ permission: 'default' });
  const root = new FakeEl('div');
  student.ctx.__root = root;
  await student.run('viewAccount(__root)'); await settle();
  assert.match(text(root), /Notifications/); assert.match(text(root), /Turn on notifications/);

  const staff = makeBrowser({ permission: 'default', role: 'teacher' });
  const r2 = new FakeEl('div'); staff.ctx.__root = r2;
  await staff.run('viewAccount(__root)'); await settle();
  assert.doesNotMatch(text(r2), /Notifications/);

  const ja = makeBrowser({ permission: 'default' });
  ja.run("setLang('ja')");
  const c = await ja.card();
  assert.match(text(c), /ポイントを受け取ったときや/);
  assert.ok(button(c, '通知をオンにする'));
  const blocked = makeBrowser({ permission: 'denied' });
  blocked.run("setLang('ja')");
  assert.match(text(await blocked.card()), /通知がブロックされています/);
});

test('sign-out button on the Account page forgets the device before signing out', async () => {
  const ep = 'https://fcm.googleapis.com/fcm/send/mine';
  const b = makeBrowser({ permission: 'granted', existing: ep, serverKnows: [ep] });
  const root = new FakeEl('div'); b.ctx.__root = root;
  await b.run('viewAccount(__root)'); await settle();
  b.log.api.length = 0;
  await button(root, 'Sign out').fire('click'); await settle();
  assert.deepEqual(b.log.api.map(([m, p]) => `${m} ${p}`), ['POST /me/push/unsubscribe', 'POST /auth/logout']);
});
