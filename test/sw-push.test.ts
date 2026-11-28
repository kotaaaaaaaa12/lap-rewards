// The service worker must show every push it receives and open the right page when a notification is tapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function loadSw(windows: { url: string; focus?: () => Promise<void>; navigate?: (u: string) => Promise<void> }[] = []) {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://school.example' },
    addEventListener: (t: string, f: (e: any) => void) => (listeners[t] = f),
    registration: { showNotification: async (title: string, options: any) => { shown.push({ title, options }); } },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (u: string) => { opened.push(u); } },
    skipWaiting: async () => {},
  };
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, URL, caches: {}, fetch: async () => {}, Response }, { filename: 'sw.js' });
  const dispatch = async (type: string, e: any) => {
    const waits: Promise<unknown>[] = [];
    listeners[type]({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { shown, opened, dispatch, listeners };
}
const pushEvent = (payload: unknown) => ({ data: payload === undefined ? null : { json: () => { if (payload instanceof Error) throw payload; return payload; } } });

test('the shell cache lists the notification scripts that index.html loads', () => {
  const sw = readFileSync('public/sw.js', 'utf8');
  const html = readFileSync('public/index.html', 'utf8');
  for (const m of html.matchAll(/<script src="(\/[^"]+)"/g)) assert.ok(sw.includes(`'${m[1]}'`), `${m[1]} missing from SHELL`);
});

test('a push is shown with its title, text, icon and target page', async () => {
  const sw = loadSw();
  await sw.dispatch('push', pushEvent({ title: 'Points awarded', body: '+10 pts', url: '/#/history' }));
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Points awarded');
  assert.equal(sw.shown[0].options.body, '+10 pts');
  assert.equal(sw.shown[0].options.icon, '/icons/icon-192.png');
  assert.deepEqual({ ...sw.shown[0].options.data }, { url: '/#/history' });
});

test('a push that is empty, unreadable or odd is still shown (browsers revoke silent subscriptions)', async () => {
  for (const payload of [undefined, new Error('not json'), {}, { title: 42, body: null, url: {} }]) {
    const sw = loadSw();
    await sw.dispatch('push', pushEvent(payload));
    assert.equal(sw.shown.length, 1);
    assert.equal(sw.shown[0].title, 'LAP Rewards');
    assert.equal(sw.shown[0].options.body, '');
    assert.equal(sw.shown[0].options.data.url, '/');
  }
});

test('tapping a notification focuses an open window and goes to the page, or opens the app', async () => {
  const calls: string[] = [];
  const win = { url: 'https://school.example/#/', focus: async () => { calls.push('focus'); }, navigate: async (u: string) => { calls.push('navigate ' + u); } };
  const sw = loadSw([win]);
  let closed = false;
  await sw.dispatch('notificationclick', { notification: { close: () => { closed = true; }, data: { url: '/#/rewards' } } });
  assert.ok(closed);
  assert.deepEqual(calls, ['focus', 'navigate https://school.example/#/rewards']);
  assert.deepEqual(sw.opened, []);

  const none = loadSw([]);
  await none.dispatch('notificationclick', { notification: { close() {}, data: { url: '/#/history' } } });
  assert.deepEqual(none.opened, ['https://school.example/#/history']);

  const other = loadSw([{ url: 'https://other.example/' }]);
  await other.dispatch('notificationclick', { notification: { close() {}, data: { url: '/' } } });
  assert.deepEqual(other.opened, ['https://school.example/'], 'windows of other sites are never used');

  const evil = loadSw([]);
  await evil.dispatch('notificationclick', { notification: { close() {}, data: { url: 'https://evil.example/phish' } } });
  assert.deepEqual(evil.opened, [], 'a target outside this site is ignored');
});
