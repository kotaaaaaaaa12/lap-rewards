'use strict';
// Push notifications, browser side: the "Notifications" card on the student's Account page and two small
// helpers that student.js calls. Everything here is optional: if the browser has no push support, or the
// person says no, the app works exactly as before.
//
// A device is only registered after the person taps "Turn on notifications" (browsers require that tap for
// the permission prompt). Signing out removes the device again, so on a shared tablet the next person does
// not see the previous person's notifications.

const PUSH_WAIT_MS = 5000;

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function pushIsIos() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** True when the app was opened from the Home Screen / installed, not from a browser tab. */
function pushIsInstalled() {
  return navigator.standalone === true || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
}

const pushWait = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
const pushReady = () => pushWait(navigator.serviceWorker.ready, PUSH_WAIT_MS);

function pushKeyBytes(b64u) {
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** What the server needs to know about a subscription, plus the language to write messages in. */
function pushBody(sub) {
  const j = sub.toJSON();
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, lang };
}

/**
 * Where this device stands: unsupported | ios (needs installing first) | blocked | off | on.
 * A subscription that exists in the browser but belongs to someone else (another account used this browser
 * before) is removed, so it can never show that person's notifications.
 */
async function pushState() {
  if (!pushSupported()) return { mode: pushIsIos() && !pushIsInstalled() ? 'ios' : 'unsupported' };
  if (Notification.permission === 'denied') return { mode: 'blocked' };
  const reg = await pushReady();
  const sub = await reg.pushManager.getSubscription();
  if (Notification.permission !== 'granted' || !sub) return { mode: 'off' };
  const st = await api('POST', '/me/push/status', { endpoint: sub.endpoint });
  if (!st.subscribed) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    return { mode: 'off' };
  }
  if (st.lang !== lang) await api('POST', '/me/push/subscribe', pushBody(sub)); // messages follow the app language
  const n = await api('GET', '/me/notifications');
  return { mode: 'on', prefs: n.prefs };
}

/** Must be called straight from a tap: the permission prompt only appears for user gestures. */
async function pushEnable() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast(t('Notifications were not allowed.'), 'error');
    return false;
  }
  const { public_key } = await api('GET', '/push/key');
  const reg = await pushReady();
  const old = await reg.pushManager.getSubscription();
  if (old) { try { await old.unsubscribe(); } catch { /* ignore */ } } // always start fresh so the key matches
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(public_key) });
  try {
    await api('POST', '/me/push/subscribe', pushBody(sub));
  } catch (e) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    throw e;
  }
  return true;
}

async function pushDisable() {
  const reg = await pushReady();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api('POST', '/me/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

function pushFail(e, fallback) {
  if (e && e.status) handleApiError(e);
  else toast(fallback, 'error');
}

/** The card shown on the Account page. */
function pushCard() {
  const box = h('div', { class: 'card' }, h('p', { class: 'muted' }, '…'));

  const draw = async () => {
    let st;
    try { st = await pushState(); } catch { st = { mode: 'error' }; }
    clear(box);
    append(box, [content(st)]);
  };

  const savePref = async (name, el) => {
    const res = await act(null, () => api('PUT', '/me/notifications', { [name]: el.checked }));
    if (!res) el.checked = !el.checked;
  };

  const content = (st) => {
    switch (st.mode) {
      case 'ios':
        return h('p', { class: 'notice' }, t('On iPhone and iPad, add this app to your Home Screen (Share → Add to Home Screen) and open it from there to turn on notifications.'));
      case 'unsupported':
        return h('p', { class: 'muted' }, t('This browser does not support notifications. You can still use all other features.'));
      case 'blocked':
        return h('p', { class: 'notice' }, t('Notifications are blocked. Allow them for this site in your browser settings, then reload this page.'));
      case 'error':
        return h('p', { class: 'muted' }, t('Could not load the notification settings.'));
      case 'off':
        return [
          h('p', { class: 'muted' }, t('Get notified when you receive points or your reward request is updated.')),
          h('button', { class: 'btn primary block', type: 'button', onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              if (await pushEnable()) toast(t('Notifications turned on.'), 'success');
            } catch (e) {
              pushFail(e, t('Could not turn on notifications.'));
            }
            await draw();
          } }, t('Turn on notifications')),
        ];
      default: // on
        return [
          h('p', null, h('strong', null, t('Notifications are on for this device.'))),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: st.prefs.points, onchange: (ev) => savePref('points', ev.target) }), t('Point changes')),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: st.prefs.redemptions, onchange: (ev) => savePref('redemptions', ev.target) }), t('Reward requests')),
          h('div', { class: 'button-row' },
            h('button', { class: 'btn small ghost', type: 'button', onclick: async (ev) => {
              const res = await act(ev.currentTarget, () => api('POST', '/me/push/test', {}));
              if (res) toast(t('Test notification sent.'), 'success');
            } }, t('Send a test notification')),
            h('button', { class: 'btn small ghost', type: 'button', onclick: async (ev) => {
              ev.currentTarget.disabled = true;
              try {
                await pushDisable();
                toast(t('Notifications turned off.'), 'success');
              } catch (e) {
                pushFail(e, t('Could not turn off notifications.'));
              }
              await draw();
            } }, t('Turn off notifications'))),
          h('p', { class: 'muted small' }, t('Signing out also turns off notifications on this device.')),
        ];
    }
  };

  draw();
  return box;
}

/** Called before signing out: forget this device, and never let signing out wait on it. */
async function pushOnSignOut() {
  if (!pushSupported()) return;
  try {
    const reg = await pushWait(navigator.serviceWorker.ready, 2000);
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('POST', '/me/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  } catch { /* best effort */ }
}

let pushSyncedFor = null;

/**
 * Once per page load, after a student's home page opened: if this browser holds a subscription that does not
 * belong to the signed-in student (a session ended without signing out, someone else signed in), remove it;
 * if it does, refresh the language the messages are written in.
 */
async function pushSync() {
  const u = state.user;
  if (!u || u.role !== 'student' || pushSyncedFor === u.id || !pushSupported()) return;
  pushSyncedFor = u.id;
  try {
    if (Notification.permission !== 'granted') return;
    const reg = await pushReady();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const st = await api('POST', '/me/push/status', { endpoint: sub.endpoint });
    if (!st.subscribed) await sub.unsubscribe();
    else if (st.lang !== lang) await api('POST', '/me/push/subscribe', pushBody(sub));
  } catch { /* best effort */ }
}
