'use strict';
// Core helpers shared by all views. Everything is rendered with textContent / DOM APIs,
// never innerHTML, so user-provided text cannot inject markup.

const state = { user: null, setupNeeded: false, setupTokenConfigured: false };

// ---------- DOM helpers ----------
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'type' || k === 'required' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const info = data && data.error;
    const err = new Error(info && info.message ? t(info.message) : t('Server error (HTTP {status}). Please try again.', { status: res.status }));
    err.code = info && info.code;
    err.detail = info && info.detail; // only sent to administrators, for diagnosing server problems
    err.status = res.status;
    throw err;
  }
  return data;
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');

// ---------- feedback ----------
let toastTimer = 0;
function toast(message, kind) {
  const el = document.getElementById('toast');
  clear(el);
  el.append(h('div', { class: 'toast ' + (kind || 'info') }, message));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(el), 4500);
}

/** Runs an async action, disables the button meanwhile, and reports errors. */
async function act(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    handleApiError(e);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

function handleApiError(e) {
  if (e.status === 401 && state.user) {
    state.user = null;
    toast(t('Your session has expired. Please sign in again.'), 'error');
    render();
  } else if (e.code === 'password_change_required' && state.user) {
    state.user.must_change_password = true;
    render();
  } else {
    toast((e.message || t('Something went wrong.')) + (e.detail ? ' [' + e.detail + ']' : ''), 'error');
  }
}

// ---------- modal ----------
function openModal(title, body, actions) {
  const dlg = h('dialog', { class: 'modal' });
  const close = () => { if (dlg.open) dlg.close(); };
  const bodyBox = h('div', { class: 'modal-body' }, body);
  const footer = h('div', { class: 'modal-actions' });
  const api2 = {
    dlg,
    close,
    setBody(node) { clear(bodyBox); append(bodyBox, [node]); },
    setActions(list) {
      clear(footer);
      for (const a of list) {
        footer.append(h('button', {
          type: 'button', class: 'btn ' + (a.kind || ''),
          onclick: (ev) => a.onclick(ev.currentTarget, api2),
        }, a.label));
      }
    },
  };
  api2.setActions(actions);
  dlg.append(h('h2', null, title), bodyBox, footer);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return api2;
}

function confirmModal(title, message, label, danger) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v, m) => { settled = true; resolve(v); m.close(); };
    const m = openModal(title, h('p', null, message), [
      { label: t('Cancel'), kind: 'ghost', onclick: (_b, mm) => done(false, mm) },
      { label, kind: danger ? 'danger' : 'primary', onclick: (_b, mm) => done(true, mm) },
    ]);
    m.dlg.addEventListener('close', () => { if (!settled) resolve(false); });
  });
}

/** Modal with a small form; resolves with the values or null if dismissed. */
function formModal(title, fields, submitLabel, intro) {
  return new Promise((resolve) => {
    let settled = false;
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      if (f.type === 'select') {
        input = h('select', { id: 'f_' + f.name }, f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { id: 'f_' + f.name, rows: 3, maxlength: f.max, value: f.value || '' });
      } else {
        input = h('input', { id: 'f_' + f.name, type: f.type || 'text', value: f.value ?? '', maxlength: f.max, min: f.min, max: f.maxValue, autocomplete: 'off', required: f.required !== false });
      }
      inputs[f.name] = input;
      return h('div', { class: 'field' }, h('label', { for: 'f_' + f.name }, f.label), input, f.help ? h('small', null, f.help) : null);
    });
    const submit = (mm) => {
      const values = {};
      for (const f of fields) values[f.name] = inputs[f.name].value;
      settled = true; resolve(values); mm.close();
    };
    const form = h('form', { onsubmit: (e) => e.preventDefault() }, intro ? h('p', { class: 'muted' }, intro) : null, rows);
    const m = openModal(title, form, [
      { label: t('Cancel'), kind: 'ghost', onclick: (_b, mm) => mm.close() },
      { label: submitLabel, kind: 'primary', onclick: (_b, mm) => { if (form.reportValidity()) submit(mm); } },
    ]);
    form.addEventListener('submit', () => { if (form.reportValidity()) submit(m); });
    m.dlg.addEventListener('close', () => { if (!settled) resolve(null); });
    const first = form.querySelector('input,select,textarea');
    if (first) first.focus();
  });
}

// ---------- formatting ----------
const dateFmts = {};
const fmtDate = (iso) => {
  if (!iso) return '';
  dateFmts[lang] ??= new Intl.DateTimeFormat(LANG_TAGS[lang], { dateStyle: 'medium', timeStyle: 'short' });
  return dateFmts[lang].format(new Date(iso));
};
const fmtPts = (n) => (n > 0 ? '+' + n : String(n));
const TYPE_LABELS = {
  award: 'Points awarded', deduction: 'Points deducted', award_cancel: 'Award cancelled',
  redeem: 'Reward redeemed', redeem_cancel: 'Redemption cancelled', correction: 'Correction',
};
const STATUS_LABELS = { pending: 'Pending', completed: 'Completed', cancelled: 'Cancelled' };
const ACTION_LABELS = {
  'setup.first_admin': 'Setup: first administrator', 'user.create': 'Account created', 'user.update': 'Account updated',
  'user.reset_password': 'Password reset', 'class.create': 'Class created', 'class.rename': 'Class renamed',
  'class.delete': 'Class deleted', 'user.delete': 'Account deleted', 'class.assign': 'Students assigned to class', 'points.award': 'Points awarded',
  'points.adjust': 'Points adjusted', 'points.cancel': 'Award cancelled', 'reward.create': 'Reward created',
  'reward.update': 'Reward updated', 'redemption.complete': 'Redemption completed', 'redemption.cancel': 'Redemption cancelled',
  'backup.run': 'Backup run',
};
/** Anonymized accounts are stored with an English placeholder name; show it in the current language. */
const nm = (n) => (n === 'Deleted user' ? t('Deleted user') : n);
const typeLabel = (x) => t(TYPE_LABELS[x] || x);
const statusLabel = (x) => t(STATUS_LABELS[x] || x);
const actionLabel = (x) => (ACTION_LABELS[x] ? t(ACTION_LABELS[x]) : x);

function chip(text, kind) { return h('span', { class: 'chip ' + (kind || '') }, text); }
function empty(text) { return h('p', { class: 'empty' }, text); }

/** One ledger row. opts: { showStudent, canCancel(t), onCancel(t) } */
function txRow(t0, opts) {
  const o = opts || {};
  const cancelled = !!t0.cancelled_by;
  // System-generated reasons are stored in English; show them in the current language.
  const reason = t0.type === 'redeem' && t0.reason.startsWith('Redeemed: ')
    ? t('Redeemed: {name}', { name: t0.reason.slice('Redeemed: '.length) }) : t0.reason;
  const meta = [fmtDate(t0.created_at), t('by {name}', { name: nm(t0.operator_nickname) })];
  if (cancelled) meta.push(t('cancelled'));
  if (t0.ref_transaction_id) meta.push(t('refers to #{id}', { id: t0.ref_transaction_id }));
  meta.push('#' + t0.id);
  return h('li', { class: 'row tx' + (cancelled ? ' struck' : '') },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, o.showStudent ? nm(t0.student_nickname) + ' ' : '', o.showStudent ? h('span', { class: 'muted' }, '@' + t0.student_login_id) : null),
      h('div', { class: 'row-sub' }, typeLabel(t0.type), ' · ', reason),
      h('div', { class: 'row-meta' }, meta.join(' · '))),
    h('div', { class: 'row-side' },
      h('div', { class: 'pts ' + (t0.amount > 0 ? 'pos' : 'neg') }, fmtPts(t0.amount)),
      h('div', { class: 'muted small' }, t('Balance {n}', { n: t0.balance_after })),
      o.canCancel && o.canCancel(t0) ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => o.onCancel(t0) }, t('Cancel')) : null));
}

function field(label, input, help) {
  return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, help ? h('small', null, help) : null);
}

function input(id, type, extra) {
  return h('input', Object.assign({ id, type, autocomplete: 'off', required: true }, extra || {}));
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

const isStaff = () => state.user && (state.user.role === 'teacher' || state.user.role === 'admin');
const isAdmin = () => state.user && state.user.role === 'admin';
