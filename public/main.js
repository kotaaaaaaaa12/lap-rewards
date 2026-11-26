'use strict';
// Router, navigation and the sign-in screens.

const NAV = {
  student: [['#/', 'Home'], ['#/rewards', 'Rewards'], ['#/history', 'History'], ['#/account', 'Account']],
  teacher: [['#/students', 'Students'], ['#/classes', 'Classes'], ['#/awards', 'Awards'], ['#/account', 'Account']],
  admin: [['#/students', 'Students'], ['#/classes', 'Classes'], ['#/awards', 'Awards'], ['#/admin', 'Admin'], ['#/account', 'Account']],
};

/** Language selector; the choice is remembered in this browser. */
function langPicker() {
  const sel = h('select', { id: 'lang_select', 'aria-label': t('Language') },
    Object.entries(LANGS).map(([code, name]) => h('option', { value: code, selected: code === lang }, name)));
  sel.addEventListener('change', () => { setLang(sel.value); render(); });
  return sel;
}

function authScreen() {
  let mode = 'login';
  const box = h('div', { class: 'auth' });
  const draw = () => {
    clear(box);
    const tabs = h('div', { class: 'tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', class: mode === 'login' ? 'active' : '', onclick: () => { mode = 'login'; draw(); } }, t('Sign in')),
      h('button', { type: 'button', role: 'tab', class: mode === 'register' ? 'active' : '', onclick: () => { mode = 'register'; draw(); } }, t('Create account')));
    box.append(h('div', { class: 'lang-corner' }, langPicker()),
      h('div', { class: 'brand' }, h('img', { src: '/icons/icon.svg', alt: '', width: 72, height: 72 }), h('h1', null, 'LAP Rewards'), h('p', { class: 'muted' }, t('Earn points for learning. Exchange them for rewards.'))), tabs);
    if (state.setupNeeded) {
      box.append(h('p', { class: 'notice' }, t('No administrator exists yet.'), ' ', h('a', { href: '#/setup' }, t('Set up the first administrator'))));
    }
    if (mode === 'login') {
      const id = input('login_id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
      const pw = input('login_pw', 'password', { autocomplete: 'current-password' });
      const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Sign in'));
      box.append(h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        const res = await act(btn, () => api('POST', '/auth/login', { login_id: id.value, password: pw.value }));
        if (res) { state.user = res.user; location.hash = ''; render(); }
      } }, field(t('Login ID'), id), field(t('Password'), pw), btn));
    } else {
      const nick = input('reg_nick', 'text', { maxlength: 30, autocomplete: 'nickname' });
      const id = input('reg_id', 'text', { maxlength: 32, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
      const pw = input('reg_pw', 'password', { minlength: 8, maxlength: 128, autocomplete: 'new-password' });
      const cf = input('reg_cf', 'password', { minlength: 8, maxlength: 128, autocomplete: 'new-password' });
      const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Create account'));
      box.append(h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        const res = await act(btn, async () => {
          await api('POST', '/auth/register', { nickname: nick.value, login_id: id.value, password: pw.value, password_confirm: cf.value });
          return api('POST', '/auth/login', { login_id: id.value, password: pw.value });
        });
        if (res) { state.user = res.user; toast(t('Welcome! Ask your teacher to add you to a class.'), 'success'); location.hash = ''; render(); }
      } }, field(t('Name shown in the app'), nick), field(t('Login ID'), id, t('Letters, digits, dots, hyphens and underscores.')), field(t('Password'), pw, t('At least 8 characters.')), field(t('Confirm password'), cf), btn));
    }
  };
  draw();
  return box;
}

function setupScreen() {
  const token = input('setup_token', 'password', { autocomplete: 'off' });
  const nick = input('setup_nick', 'text', { maxlength: 30 });
  const id = input('setup_id', 'text', { maxlength: 32, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'username' });
  const pw = input('setup_pw', 'password', { minlength: 8, maxlength: 128, autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Create administrator'));
  return h('div', { class: 'auth' },
    h('div', { class: 'lang-corner' }, langPicker()),
    h('div', { class: 'brand' }, h('h1', null, t('First-time setup')), h('p', { class: 'muted' }, t('Create the first administrator account.'))),
    !state.setupNeeded ? h('p', { class: 'notice' }, t('Setup is already complete.'), ' ', h('a', { href: '#/' }, t('Go to sign in'))) :
      !state.setupTokenConfigured ? h('p', { class: 'notice' }, t('The SETUP_TOKEN secret is not configured yet. Add it to the Worker (Settings → Variables and Secrets), then reload this page.')) :
        h('form', { class: 'card', onsubmit: async (e) => {
          e.preventDefault();
          const res = await act(btn, () => api('POST', '/setup', { token: token.value, nickname: nick.value, login_id: id.value, password: pw.value }));
          if (res) {
            state.setupNeeded = false;
            const r2 = await act(null, () => api('POST', '/auth/login', { login_id: id.value, password: pw.value }));
            if (r2) { state.user = r2.user; toast(t('Administrator created.'), 'success'); location.hash = '#/admin'; render(); }
          }
        } }, field(t('Setup token'), token, t('The SETUP_TOKEN secret you configured for this Worker.')), field(t('Name'), nick), field(t('Login ID'), id), field(t('Password'), pw, t('At least 8 characters.')), btn));
}

function shell(content, path) {
  const items = NAV[state.user.role];
  const active = (href) => {
    const p = href.replace('#', '');
    return p === '/' ? path === '/' : path === p || path.startsWith(p + '/');
  };
  return h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-title' }, h('img', { src: '/icons/icon.svg', alt: '', width: 28, height: 28 }), 'LAP Rewards'),
      h('div', { class: 'topbar-user' }, state.user.nickname, ' ', chip(t(state.user.role)))),
    h('nav', { class: 'tabbar', 'aria-label': 'Main' }, items.map(([href, label]) => h('a', { href, class: active(href) ? 'active' : '', 'aria-current': active(href) ? 'page' : null }, t(label)))),
    h('main', { class: 'content' }, content));
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const app = document.getElementById('app');
  const { path, query } = parseHash();

  if (!state.user) {
    clear(app);
    app.append(path === '/setup' ? setupScreen() : authScreen());
    return;
  }
  if (state.user.must_change_password) {
    clear(app);
    app.append(h('div', { class: 'auth' }, h('div', { class: 'lang-corner' }, langPicker()), h('div', { class: 'brand' }, h('h1', null, t('Choose a new password')), h('p', { class: 'muted' }, t('You are using a temporary password. Please set your own password to continue.'))), passwordForm(true)));
    return;
  }

  const role = state.user.role;
  const content = h('div', { class: 'page' }, h('p', { class: 'boot' }, t('Loading…')));
  clear(app);
  app.append(shell(content, path));

  let view;
  const m = path.match(/^\/students\/(\d+)$/);
  if (role === 'student') {
    view = { '/': viewHome, '/rewards': viewRewards, '/history': viewHistory, '/account': viewAccount }[path];
  } else {
    if (path === '/account') view = viewAccount;
    else if (path === '/students') view = (r) => viewStudents(r, query);
    else if (m) view = (r) => viewStudent(r, m[1]);
    else if (path === '/classes') view = viewClasses;
    else if (path === '/awards') view = viewAwards;
    else if (role === 'admin' && path === '/admin') view = viewAdminOverview;
    else if (role === 'admin' && path === '/admin/users') view = viewAdminUsers;
    else if (role === 'admin' && path === '/admin/rewards') view = viewAdminRewards;
    else if (role === 'admin' && path === '/admin/redemptions') view = (r) => viewAdminRedemptions(r, query);
    else if (role === 'admin' && path === '/admin/audit') view = viewAdminAudit;
    else if (role === 'admin' && path === '/admin/backups') view = viewAdminBackups;
    else { location.replace('#/students'); return; }
  }
  if (!view) { location.replace('#/'); return; }

  const root = h('div', { class: 'page' });
  try {
    await view(root);
  } catch (e) {
    if (seq !== renderSeq) return;
    handleApiError(e);
    clear(root);
    root.append(h('p', { class: 'notice' }, t('This page could not be loaded.'), ' ', h('a', { href: location.hash || '#/', onclick: () => render() }, t('Try again'))));
  }
  if (seq !== renderSeq) return; // a newer navigation took over
  content.replaceWith(root);
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    const me = await api('GET', '/me');
    state.user = me.user;
  } catch {
    state.user = null;
    try {
      const s = await api('GET', '/setup/status');
      state.setupNeeded = s.needed;
      state.setupTokenConfigured = s.token_configured;
    } catch { /* offline: the sign-in screen still shows */ }
  }
  render();
}

window.addEventListener('hashchange', render);
boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
