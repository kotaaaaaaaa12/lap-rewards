// Guards translation coverage: every user-visible string in the front end and every static
// server message must have a Japanese entry, and placeholders must match.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';

const i18nSrc = readFileSync('public/i18n.js', 'utf8');
const ctx: any = { localStorage: undefined, navigator: {}, document: { documentElement: {} } };
vm.createContext(ctx);
vm.runInContext(i18nSrc, ctx);
// Feature files that add their own entries to the table (they load right after i18n.js in the page).
for (const f of ['i18n-push.js']) vm.runInContext(readFileSync(`public/${f}`, 'utf8'), ctx);
const JA: Record<string, string> = vm.runInContext('JA', ctx);

const unescape = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
const Q = `'((?:[^'\\\\]|\\\\.)*)'`;
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

function clientKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const f of readdirSync('public').filter((x) => x.endsWith('.js') && x !== 'i18n.js' && x !== 'i18n-push.js' && x !== 'sw.js')) {
    const src = readFileSync(`public/${f}`, 'utf8');
    const add = (k: string) => keys.set(unescape(k), f);
    for (const m of src.matchAll(new RegExp(`\\bt\\(\\s*${Q}`, 'g'))) add(m[1]);
    for (const m of src.matchAll(new RegExp(`\\bt\\([^()']*\\?\\s*${Q}\\s*:\\s*${Q}`, 'g'))) { add(m[1]); add(m[2]); }
    for (const m of src.matchAll(new RegExp(`\\btn\\([^,]+,\\s*${Q},\\s*${Q}`, 'g'))) { add(m[1]); add(m[2]); }
  }
  return keys;
}

test('every client string has a Japanese translation with the same placeholders', () => {
  const keys = clientKeys();
  assert.ok(keys.size > 150, `expected many strings, found ${keys.size}`);
  const missing = [...keys].filter(([k]) => !(k in JA)).map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(missing, []);
  for (const [k] of keys) assert.equal(ph(JA[k]), ph(k), `placeholder mismatch: ${k}`);
});

test('label tables (types, statuses, actions, navigation, tabs, roles) are translated', () => {
  const load = new Function('return 0');
  void load;
  const c: any = { document: { documentElement: {} }, navigator: {}, Intl, URLSearchParams };
  vm.createContext(c);
  for (const f of ['i18n', 'core', 'main', 'admin']) vm.runInContext(readFileSync(`public/${f}.js`, 'utf8').replace(/^boot\(\);$/m, '').replace(/^window\.addEventListener.*$/gm, ''), c);
  const values = JSON.parse(vm.runInContext(`JSON.stringify([
    ...Object.values(TYPE_LABELS), ...Object.values(STATUS_LABELS), ...Object.values(ACTION_LABELS),
    ...Object.values(NAV).flat().map((x) => x[1]), ...ADMIN_TABS.map((x) => x[1]), 'student', 'teacher', 'admin', 'Pending', 'Completed', 'Cancelled', 'All'])`, c));
  const missing = [...new Set<string>(values)].filter((v) => !(v in JA));
  assert.deepEqual(missing, []);
});

test('static server messages are translated', () => {
  const msgs = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(`${dir}/${e.name}`); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const src = readFileSync(`${dir}/${e.name}`, 'utf8');
      for (const m of src.matchAll(new RegExp(`\\b(?:bad|notFound|forbidden)\\(\\s*${Q}`, 'g'))) msgs.add(unescape(m[1]));
      for (const m of src.matchAll(new RegExp(`\\b(?:conflict|new HttpError)\\([^'\`]*?'[a-z_]+',\\s*${Q}`, 'g'))) msgs.add(unescape(m[1]));
      for (const m of src.matchAll(new RegExp(`\\bbad\\(\\s*${Q},\\s*'[a-z_]+'`, 'g'))) msgs.add(unescape(m[1]));
    }
  };
  walk('src');
  assert.ok(msgs.size > 30, `expected many messages, found ${msgs.size}`);
  const missing = [...msgs].filter((m) => !(m in JA));
  assert.deepEqual(missing, []);
});
