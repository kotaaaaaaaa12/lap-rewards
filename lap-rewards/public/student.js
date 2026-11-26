'use strict';
// Student views: home, rewards, history, account.

async function viewHome(root) {
  const [me, tx, red] = await Promise.all([api('GET', '/me'), api('GET', '/me/transactions?limit=5'), api('GET', '/me/redemptions')]);
  state.user = me.user;
  const pending = red.redemptions.filter((r) => r.status === 'pending');
  append(root, [
    h('section', { class: 'balance-card' },
      h('div', { class: 'balance-label' }, t('Your points')),
      h('div', { class: 'balance-value' }, String(me.user.balance)),
      h('div', { class: 'balance-sub' }, me.user.class_name ? t('Class {name}', { name: me.user.class_name }) : t('No class assigned yet'))),
    pending.length ? h('p', { class: 'notice' }, tn(pending.length, 'You have 1 reward request waiting to be handed out.', 'You have {n} reward requests waiting to be handed out.')) : null,
    h('div', { class: 'section-head' }, h('h2', null, t('Recent activity')), h('a', { href: '#/history' }, t('See all'))),
    tx.transactions.length ? h('ul', { class: 'list' }, tx.transactions.map((x) => txRow(x))) : empty(t('No activity yet. Pass a quiz or test to earn your first points!')),
    h('a', { class: 'btn primary block', href: '#/rewards' }, t('Browse rewards')),
  ]);
}

async function viewRewards(root) {
  const [me, rw, red] = await Promise.all([api('GET', '/me'), api('GET', '/rewards'), api('GET', '/me/redemptions')]);
  state.user = me.user;
  const balance = me.user.balance;
  const redeem = async (reward) => {
    const ok = await confirmModal(t('Redeem reward'), t('Redeem “{name}” for {cost} points? You currently have {balance} points.', { name: reward.name, cost: reward.cost, balance }), t('Redeem'));
    if (!ok) return;
    const res = await act(null, () => api('POST', '/me/redemptions', { reward_id: reward.id, key: newKey() }));
    if (res) { toast(t('Request sent. Your points have been deducted.'), 'success'); render(); }
  };
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Rewards')), h('span', { class: 'chip strong' }, t('{n} pts', { n: balance }))),
    rw.rewards.length ? h('ul', { class: 'list' }, rw.rewards.map((r) =>
      h('li', { class: 'row' },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, r.name), r.description ? h('div', { class: 'row-sub' }, r.description) : null),
        h('div', { class: 'row-side' },
          h('div', { class: 'pts' }, t('{n} pts', { n: r.cost })),
          h('button', { class: 'btn small primary', type: 'button', disabled: balance < r.cost, onclick: () => redeem(r) }, balance < r.cost ? t('Not enough') : t('Redeem')))))) : empty(t('No rewards are available right now.')),
    h('div', { class: 'section-head' }, h('h2', null, t('My requests'))),
    red.redemptions.length ? h('ul', { class: 'list' }, red.redemptions.map((r) =>
      h('li', { class: 'row' },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, r.reward_name), h('div', { class: 'row-meta' }, fmtDate(r.created_at))),
        h('div', { class: 'row-side' }, chip(statusLabel(r.status), r.status), h('div', { class: 'muted small' }, t('{n} pts', { n: r.cost_at_request })))))) : empty(t('You have not redeemed anything yet.')),
  ]);
}

async function viewHistory(root) {
  const list = h('ul', { class: 'list' });
  const more = h('button', { class: 'btn ghost block', type: 'button' }, t('Load more'));
  let before = null;
  const load = async () => {
    const res = await act(more, () => api('GET', '/me/transactions?limit=30' + (before ? '&before=' + before : '')));
    if (!res) return;
    res.transactions.forEach((x) => list.append(txRow(x)));
    if (res.transactions.length) before = res.transactions[res.transactions.length - 1].id;
    more.hidden = res.transactions.length < 30;
    if (!list.children.length) list.replaceWith(empty(t('No activity yet.')));
  };
  more.addEventListener('click', load);
  append(root, [h('div', { class: 'section-head' }, h('h2', null, t('Point history'))), list, more]);
  await load();
}

function passwordForm(forced) {
  const cur = input('pw_cur', 'password', { autocomplete: 'current-password' });
  const nw = input('pw_new', 'password', { autocomplete: 'new-password', minlength: 8, maxlength: 128 });
  const cf = input('pw_cf', 'password', { autocomplete: 'new-password', minlength: 8, maxlength: 128 });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Change password'));
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const res = await act(btn, () => api('POST', '/auth/change-password', {
      current_password: cur.value, new_password: nw.value, new_password_confirm: cf.value }));
    if (res) {
      toast(t('Password changed. Other devices have been signed out.'), 'success');
      if (forced) { state.user.must_change_password = false; render(); } else { form.reset(); }
    }
  } },
  field(forced ? t('Temporary password') : t('Current password'), cur),
  field(t('New password'), nw, t('At least 8 characters.')),
  field(t('Confirm new password'), cf), btn);
  return form;
}

async function viewAccount(root) {
  const u = state.user;
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Account'))),
    h('div', { class: 'card' },
      h('dl', { class: 'kv' },
        h('dt', null, t('Name')), h('dd', null, u.nickname),
        h('dt', null, t('Login ID')), h('dd', null, u.login_id),
        h('dt', null, t('Role')), h('dd', null, t(u.role)),
        u.role === 'student' ? [h('dt', null, t('Class')), h('dd', null, u.class_name || t('Not assigned'))] : null,
        h('dt', null, t('Language')), h('dd', null, langPicker()))),
    h('h3', null, t('Change password')),
    passwordForm(false),
    h('button', { class: 'btn ghost block', type: 'button', onclick: async (ev) => {
      await act(ev.currentTarget, () => api('POST', '/auth/logout', {}));
      state.user = null; location.hash = ''; render();
    } }, t('Sign out')),
  ]);
}
