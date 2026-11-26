'use strict';
// Administrator views.

const ADMIN_TABS = [
  ['#/admin', 'Overview'], ['#/admin/users', 'Accounts'], ['#/admin/rewards', 'Rewards'],
  ['#/admin/redemptions', 'Redemptions'], ['#/admin/audit', 'Activity log'], ['#/admin/backups', 'Backups'],
];

function adminTabs(current) {
  return h('nav', { class: 'subnav', 'aria-label': t('Administration') },
    ADMIN_TABS.map(([href, label]) => h('a', { href, class: href === current ? 'active' : '' }, t(label))));
}

function openAdjustFlow(student, onDone) {
  const key = newKey();
  formModal(t('Adjust points: {name}', { name: student.nickname }), [
    { name: 'amount', label: t('Amount (use a negative number to deduct)'), type: 'number', min: -100000, maxValue: 100000 },
    { name: 'reason', label: t('Reason'), max: 200 },
  ], t('Apply'), t('Current balance: {n} points.', { n: student.balance })).then(async (v) => {
    if (!v) return;
    const amount = Number(v.amount);
    if (!Number.isInteger(amount) || amount === 0) { toast(t('Enter a non-zero whole number.'), 'error'); return; }
    const res = await act(null, () => api('POST', '/admin/points/adjust', { student_id: student.id, amount, reason: v.reason.trim(), key }));
    if (res) { toast(t('Points adjusted.'), 'success'); onDone(); }
  });
}

function showTempPassword(login, password, title) {
  const pre = h('code', { class: 'secret' }, password);
  openModal(title, h('div', null,
    h('p', null, t('Give this temporary password to {name}. It is shown only once, and they must choose a new password when they sign in.', { name: login })),
    pre), [
    { label: t('Copy'), kind: '', onclick: async (btn) => {
      try { await navigator.clipboard.writeText(password); btn.textContent = t('Copied'); } catch { toast(t('Could not copy. Select the text instead.'), 'error'); }
    } },
    { label: t('Done'), kind: 'primary', onclick: (_b, m) => m.close() },
  ]);
}

async function viewAdminOverview(root) {
  const { overview: o } = await api('GET', '/admin/overview');
  const stat = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(value)), h('div', { class: 'stat-label' }, t(label)));
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Administration'))), adminTabs('#/admin'),
    h('div', { class: 'stats' },
      stat('Active students', o.students), stat('Active teachers', o.teachers), stat('Classes', o.classes),
      stat('Points held by students', o.total_balance), stat('Transactions (7 days)', o.transactions_7d),
      stat('Pending redemptions', o.pending_redemptions)),
  ]);
}

async function viewAdminUsers(root) {
  const search = h('input', { id: 'user_search', type: 'search', placeholder: t('Search by name or login ID'), autocomplete: 'off', 'aria-label': t('Search accounts') });
  const role = h('select', { id: 'role_filter', 'aria-label': t('Filter by role') }, h('option', { value: '' }, t('All roles')),
    ['student', 'teacher', 'admin'].map((r) => h('option', { value: r }, t(r))));
  const box = h('div');
  const load = async () => {
    const qs = new URLSearchParams({ limit: '100' });
    if (search.value.trim()) qs.set('q', search.value.trim());
    if (role.value) qs.set('role', role.value);
    const res = await act(null, () => api('GET', '/admin/users?' + qs));
    if (!res) return;
    clear(box);
    if (!res.users.length) { box.append(empty(t('No accounts match.'))); return; }
    box.append(h('ul', { class: 'list' }, res.users.map((u) => {
      const me = u.id === state.user.id;
      return h('li', { class: 'row' + (u.is_active ? '' : ' struck') },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, u.nickname, ' ', h('span', { class: 'muted' }, '@' + u.login_id)),
          h('div', { class: 'row-sub' }, chip(t(u.role), u.role === 'admin' ? 'strong' : ''), ' ', u.role === 'student' ? chip(u.class_name || t('Unassigned'), u.class_name ? '' : 'pending') : null, ' ', u.is_active ? '' : chip(t('inactive'), 'cancelled'), ' ', u.must_change_password ? chip(t('password change pending'), 'pending') : null),
          u.role === 'student' ? h('div', { class: 'row-meta' }, t('{n} points held', { n: u.balance })) : null),
        h('div', { class: 'row-side button-col' },
          u.role === 'student' ? h('a', { class: 'btn small', href: '#/students/' + u.id }, t('Open')) : null,
          h('button', { class: 'btn small', type: 'button', onclick: async () => {
            if (!(await confirmModal(t('Reset password'), t('Reset the password for {name}? They will be signed out everywhere.', { name: u.nickname }), t('Reset')))) return;
            const res2 = await act(null, () => api('POST', `/admin/users/${u.id}/reset-password`, {}));
            if (res2) { showTempPassword(u.login_id, res2.temporary_password, t('Temporary password')); load(); }
          } }, t('Reset password')),
          u.role !== 'admin' ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
            const to = u.role === 'student' ? 'teacher' : 'student';
            if (!(await confirmModal(t('Change role'), t('Make {name} a {role}? They will be signed out.', { name: u.nickname, role: t(to) }), t('Change')))) return;
            if (await act(null, () => api('PATCH', '/admin/users/' + u.id, { role: to }))) { toast(t('Role updated.'), 'success'); load(); }
          } }, u.role === 'student' ? t('Make teacher') : t('Make student')) : null,
          !me ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
            const next = !u.is_active;
            if (!next && !(await confirmModal(t('Deactivate account'), t('Deactivate {name}? They will not be able to sign in.', { name: u.nickname }), t('Deactivate'), true))) return;
            if (await act(null, () => api('PATCH', '/admin/users/' + u.id, { is_active: next }))) { toast(next ? t('Account activated.') : t('Account deactivated.'), 'success'); load(); }
          } }, u.is_active ? t('Deactivate') : t('Activate')) : null,
          !me ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
            const v = await formModal(t('Delete account'), [{ name: 'login_id', label: t('Type the login ID to confirm: {id}', { id: u.login_id }), max: 64 }], t('Delete account'),
              t('This permanently removes {name}. If the account has any history, the history is kept but made anonymous. This cannot be undone.', { name: u.nickname }));
            if (!v) return;
            const res3 = await act(null, () => api('DELETE', '/admin/users/' + u.id, { login_id: v.login_id.trim() }));
            if (res3) { toast(res3.mode === 'deleted' ? t('Account deleted.') : t('Account removed. Its history was kept anonymously.'), 'success'); load(); }
          } }, t('Delete')) : null));
    })));
  };
  search.addEventListener('input', debounce(load, 250));
  role.addEventListener('change', load);
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Accounts')),
      h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
        const v = await formModal(t('Add account'), [
          { name: 'nickname', label: t('Name'), max: 30 },
          { name: 'login_id', label: t('Login ID'), max: 32, help: t('Letters, digits, dots, hyphens and underscores.') },
          { name: 'role', label: t('Role'), type: 'select', value: 'teacher', options: [{ value: 'teacher', label: t('Teacher') }, { value: 'student', label: t('Student') }, { value: 'admin', label: t('Administrator') }] },
        ], t('Create'));
        if (!v) return;
        const res = await act(null, () => api('POST', '/admin/users', { nickname: v.nickname.trim(), login_id: v.login_id.trim(), role: v.role }));
        if (res) { showTempPassword(res.login_id, res.temporary_password, t('Account created')); load(); }
      } }, t('Add account'))),
    adminTabs('#/admin/users'), h('div', { class: 'toolbar' }, search, role), box]);
  await load();
}

async function viewAdminRewards(root) {
  const { rewards } = await api('GET', '/admin/rewards');
  const edit = async (r) => {
    const v = await formModal(r ? t('Edit reward') : t('Add reward'), [
      { name: 'name', label: t('Name'), value: r ? r.name : '', max: 60 },
      { name: 'description', label: t('Description'), type: 'textarea', value: r ? r.description : '', max: 300, required: false },
      { name: 'cost', label: t('Cost (points)'), type: 'number', value: r ? r.cost : '', min: 1, maxValue: 1000000 },
    ], t('Save'));
    if (!v) return;
    const body = { name: v.name.trim(), description: v.description.trim(), cost: Number(v.cost) };
    if (!Number.isInteger(body.cost) || body.cost < 1) { toast(t('Cost must be a positive whole number.'), 'error'); return; }
    const res = await act(null, () => (r ? api('PATCH', '/admin/rewards/' + r.id, body) : api('POST', '/admin/rewards', body)));
    if (res) { toast(t('Reward saved.'), 'success'); render(); }
  };
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Rewards')), h('button', { class: 'btn small primary', type: 'button', onclick: () => edit(null) }, t('Add reward'))),
    adminTabs('#/admin/rewards'),
    rewards.length ? h('ul', { class: 'list' }, rewards.map((r) => h('li', { class: 'row' + (r.is_active ? '' : ' struck') },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, r.name + (r.is_active ? '' : ' ' + t('(hidden)'))), r.description ? h('div', { class: 'row-sub' }, r.description) : null),
      h('div', { class: 'row-side button-col' }, h('div', { class: 'pts' }, t('{n} pts', { n: r.cost })),
        h('button', { class: 'btn small', type: 'button', onclick: () => edit(r) }, t('Edit')),
        h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
          if (await act(null, () => api('PATCH', '/admin/rewards/' + r.id, { is_active: !r.is_active }))) render();
        } }, r.is_active ? t('Hide') : t('Show')))))) : empty(t('No rewards yet. Add the first one.')),
  ]);
}

async function viewAdminRedemptions(root, query) {
  const status = query.get('status') ?? 'pending';
  const { redemptions } = await api('GET', '/admin/redemptions' + (status ? '?status=' + status : ''));
  const filter = h('div', { class: 'subnav' }, [['pending', 'Pending'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['', 'All']].map(([v, l]) =>
    h('a', { href: '#/admin/redemptions?status=' + v, class: v === status ? 'active' : '' }, t(l))));
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Redemptions'))), adminTabs('#/admin/redemptions'), filter,
    redemptions.length ? h('ul', { class: 'list' }, redemptions.map((r) => h('li', { class: 'row' },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, r.reward_name), h('div', { class: 'row-sub' }, nm(r.student_nickname), ' ', h('span', { class: 'muted' }, '@' + r.student_login_id)), h('div', { class: 'row-meta' }, fmtDate(r.created_at), ' · ', t('{n} pts', { n: r.cost_at_request }))),
      h('div', { class: 'row-side button-col' }, chip(statusLabel(r.status), r.status),
        r.status === 'pending' ? [
          h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
            if (await act(null, () => api('POST', `/admin/redemptions/${r.id}/complete`, {}))) { toast(t('Marked as completed.'), 'success'); render(); }
          } }, t('Complete')),
          h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
            const v = await formModal(t('Cancel redemption'), [{ name: 'reason', label: t('Reason'), max: 200 }], t('Cancel and refund'), t('{n} points will be returned to {name}.', { n: r.cost_at_request, name: r.student_nickname }));
            if (v && (await act(null, () => api('POST', `/admin/redemptions/${r.id}/cancel`, { reason: v.reason.trim() })))) { toast(t('Cancelled and refunded.'), 'success'); render(); }
          } }, t('Cancel'))] : null,
        r.status === 'completed' ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
          const v = await formModal(t('Invalidate redemption'), [{ name: 'reason', label: t('Reason'), max: 200 }], t('Invalidate and refund'),
            t('{n} points will be returned to {name}. The reward was already marked as handed out.', { n: r.cost_at_request, name: nm(r.student_nickname) }));
          if (v && (await act(null, () => api('POST', `/admin/redemptions/${r.id}/cancel`, { reason: v.reason.trim() })))) { toast(t('Invalidated and refunded.'), 'success'); render(); }
        } }, t('Invalidate')) : null)))) : empty(t('Nothing here.')),
  ]);
}

async function viewAdminAudit(root) {
  const list = h('ul', { class: 'list' });
  const more = h('button', { class: 'btn ghost block', type: 'button' }, t('Load more'));
  let before = null;
  const load = async () => {
    const res = await act(more, () => api('GET', '/admin/audit-logs?limit=50' + (before ? '&before=' + before : '')));
    if (!res) return;
    res.logs.forEach((l) => list.append(h('li', { class: 'row' },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, actionLabel(l.action)), h('div', { class: 'row-sub' }, l.actor_nickname, l.target_type ? ` → ${l.target_type}${l.target_id ? ' #' + l.target_id : ''}` : ''),
        l.detail ? h('div', { class: 'row-meta mono' }, l.detail) : null),
      h('div', { class: 'row-side muted small' }, fmtDate(l.created_at)))));
    if (res.logs.length) before = res.logs[res.logs.length - 1].id;
    more.hidden = res.logs.length < 50;
  };
  more.addEventListener('click', load);
  append(root, [h('div', { class: 'section-head' }, h('h2', null, t('Activity log'))), adminTabs('#/admin/audit'), list, more]);
  await load();
}

async function viewAdminBackups(root) {
  const { backups } = await api('GET', '/admin/backups');
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Backups')),
      h('button', { class: 'btn small primary', type: 'button', onclick: async (ev) => {
        if (await act(ev.currentTarget, () => api('POST', '/admin/backups/run', {}))) { toast(t('Backup created.'), 'success'); render(); }
      } }, t('Back up now'))),
    adminTabs('#/admin/backups'),
    h('p', { class: 'muted' }, t('A backup runs automatically every day and is stored in a private R2 bucket. Restore steps are in docs/BACKUP-RESTORE.md.')),
    backups.length ? h('ul', { class: 'list' }, backups.map((b) => h('li', { class: 'row' },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title mono' }, b.key.replace('backups/', '')), h('div', { class: 'row-meta' }, fmtDate(b.uploaded))),
      h('div', { class: 'row-side muted small' }, kb(b.size))))) : empty(t('No backups yet.')),
  ]);
}
