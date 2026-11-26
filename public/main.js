'use strict';
// Router, navigation and the sign-in screens.

const NAV = {
  student: [['#/', 'Home', 'home'], ['#/rewards', 'Rewards', 'gift'], ['#/history', 'History', 'clock'], ['#/account', 'Account', 'user']],
  teacher: [['#/students', 'Students', 'users'], ['#/classes', 'Classes', 'grid'], ['#/awards', 'Awards', 'award'], ['#/account', 'Account', 'user']],
  admin: [['#/students', 'Students', 'users'], ['#/classes', 'Classes', 'grid'], ['#/awards', 'Awards', 'award'], ['#/admin', 'Admin', 'shield'], ['#/account', 'Account', 'user']],
};

/** Language selector; the choice is remembered in this browser. */
function langPicker() {
  const sel = h('select', { id: 'lang_select', 'aria-label': t('Language') },
    Object.entries(LANGS).map(([code, name]) => h('option', { value: code, selected: code === lang }, name)));
  sel.addEventListener('change', () => { setLang(sel.value); render(); });
  return sel;
}

function brandBlock() {
  return h('div', { class: 'brand' }, h('img', { src: '/icons/icon.svg', alt: '', width: 64, height: 64 }), h('h1', null, 'LAP Rewards'),
    h('p', { class: 'muted' }, t('Earn points for learning. Exchange them for rewards.')));
}

function forgotPasswordModal() {
  openModal(t('Forgot your password?'), h('p', null, t('Ask your teacher or an administrator to reset your password. They will give you a temporary password.')),
    [{ label: t('Done'), kind: 'primary', onclick: (_b, m) => m.close() }]);
}

const linkButton = (label, onclick) => h('button', { type: 'button', class: 'link-btn', onclick }, label);

function authInput(id, type, placeholder, extra) {
  return input(id, type, Object.assign({ placeholder, 'aria-label': placeholder }, extra || {}));
}

function authScreen() {
  let mode = 'login';
  const page = h('div', { class: 'auth-page' });

  const loginForm = () => {
    const id = authInput('login_id', 'text', t('Login ID'), { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
    const pw = authInput('login_pw', 'password', t('Password'), { autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Sign in'));
    return h('form', { class: 'auth-card', onsubmit: async (e) => {
      e.preventDefault();
      const res = await act(btn, () => api('POST', '/auth/login', { login_id: id.value, password: pw.value }));
      if (res) { state.user = res.user; location.hash = ''; render(); }
    } },
    h('h2', null, t('Sign in')), inputBox(id, 'user'), inputBox(pw),
    h('div', { class: 'auth-links' }, linkButton(t('Forgot password?'), forgotPasswordModal)), btn,
    h('p', { class: 'switch' }, t('No account yet?'), ' ', linkButton(t('Create one'), () => { mode = 'register'; draw(); })));
  };

  const registerForm = () => {
    const nick = authInput('reg_nick', 'text', t('Name shown in the app'), { maxlength: 30, autocomplete: 'nickname' });
    const id = authInput('reg_id', 'text', t('Login ID'), { maxlength: 32, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
    const pw = authInput('reg_pw', 'password', t('Password'), { minlength: 8, maxlength: 128, autocomplete: 'new-password' });
    const cf = authInput('reg_cf', 'password', t('Confirm password'), { minlength: 8, maxlength: 128, autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Create account'));
    return h('form', { class: 'auth-card', onsubmit: async (e) => {
      e.preventDefault();
      const res = await act(btn, async () => {
        await api('POST', '/auth/register', { nickname: nick.value, login_id: id.value, password: pw.value, password_confirm: cf.value });
        return api('POST', '/auth/login', { login_id: id.value, password: pw.value });
      });
      if (res) { state.user = res.user; toast(t('Welcome! Ask your teacher to add you to a class.'), 'success'); location.hash = ''; render(); }
    } },
    h('h2', null, t('Create account')), inputBox(nick, 'user'), inputBox(id, 'user'), inputBox(pw), inputBox(cf),
    h('p', { class: 'hint' }, t('Letters, digits, dots, hyphens and underscores.'), ' ', t('At least 8 characters.')), btn,
    h('p', { class: 'switch' }, t('Already have an account?'), ' ', linkButton(t('Sign in'), () => { mode = 'login'; draw(); })));
  };

  const draw = () => {
    clear(page);
    page.append(h('div', { class: 'lang-corner' }, langPicker()), brandBlock());
    if (state.setupNeeded) {
      page.append(h('p', { class: 'notice' }, t('No administrator exists yet.'), ' ', h('a', { href: '#/setup' }, t('Set up the first administrator'))));
    }
    page.append(mode === 'login' ? loginForm() : registerForm());
  };
  draw();
  return page;
}

function setupScreen() {
  const token = authInput('setup_token', 'password', t('Setup token'), { autocomplete: 'off' });
  const nick = authInput('setup_nick', 'text', t('Name'), { maxlength: 30 });
  const id = authInput('setup_id', 'text', t('Login ID'), { maxlength: 32, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'username' });
  const pw = authInput('setup_pw', 'password', t('Password'), { minlength: 8, maxlength: 128, autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Create administrator'));
  let body;
  if (!state.setupNeeded) {
    body = h('p', { class: 'notice' }, t('Setup is already complete.'), ' ', h('a', { href: '#/' }, t('Go to sign in')));
  } else if (!state.setupTokenConfigured) {
    body = h('p', { class: 'notice' }, t('The SETUP_TOKEN secret is not configured yet. Add it to the Worker (Settings → Variables and Secrets), then reload this page.'));
  } else {
    body = h('form', { class: 'auth-card', onsubmit: async (e) => {
      e.preventDefault();
      const res = await act(btn, () => api('POST', '/setup', { token: token.value, nickname: nick.value, login_id: id.value, password: pw.value }));
      if (res) {
        state.setupNeeded = false;
        const r2 = await act(null, () => api('POST', '/auth/login', { login_id: id.value, password: pw.value }));
        if (r2) { state.user = r2.user; toast(t('Administrator created.'), 'success'); location.hash = '#/admin'; render(); }
      }
    } },
    h('h2', null, t('First-time setup')), inputBox(token), inputBox(nick, 'user'), inputBox(id, 'user'), inputBox(pw),
    h('p', { class: 'hint' }, t('The SETUP_TOKEN secret you configured for this Worker.'), ' ', t('At least 8 characters.')), btn);
  }
  return h('div', { class: 'auth-page' }, h('div', { class: 'lang-corner' }, langPicker()), brandBlock(), body);
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
    h('nav', { class: 'tabbar', 'aria-label': 'Main' }, items.map(([href, label, ico]) => h('a', { href, class: active(href) ? 'active' : '', 'aria-current': active(href) ? 'page' : null }, svg(ico), h('span', null, t(label))))),
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
    app.append(h('div', { class: 'auth-page' }, h('div', { class: 'lang-corner' }, langPicker()), h('div', { class: 'brand' }, h('h1', null, t('Choose a new password')), h('p', { class: 'muted' }, t('You are using a temporary password. Please set your own password to continue.'))), passwordForm(true)));
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
