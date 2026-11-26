'use strict';
// Teacher and administrator views: students, classes, award history.

const MAX_AWARD = 100000;

/** Two-step flow: enter amount and reason, then confirm the selected students before submitting. */
function openAwardFlow(students, onDone) {
  const key = newKey(); // one key per submission: retries and double clicks cannot award twice
  const amount = input('aw_amount', 'number', { min: 1, max: MAX_AWARD, step: 1, inputmode: 'numeric' });
  const reason = h('input', { id: 'aw_reason', type: 'text', maxlength: 200, required: true, autocomplete: 'off', placeholder: t('e.g. Passed unit 3 quiz') });
  const form = h('form', { onsubmit: (e) => e.preventDefault() },
    h('p', { class: 'muted' }, t(students.length === 1 ? 'Awarding to {name}.' : 'Awarding to {n} students.', { name: students[0].nickname, n: students.length })),
    field(t('Points per student'), amount), field(t('Reason'), reason, t('Shown to the student and kept in the history.')));

  const toConfirm = (m) => {
    if (!form.reportValidity()) return;
    const n = Number(amount.value);
    const r = reason.value.trim();
    if (!Number.isInteger(n) || n < 1 || n > MAX_AWARD || !r) { toast(t('Enter a whole number of points and a reason.'), 'error'); return; }
    m.setBody(h('div', null,
      h('p', null, h('strong', null, t(students.length === 1 ? '{n} points each to {count} student:' : '{n} points each to {count} students:', { n, count: students.length }))),
      h('ul', { class: 'plain scroll' }, students.map((s) => h('li', null, s.nickname, ' ', h('span', { class: 'muted' }, '@' + s.login_id)))),
      h('p', null, t('Reason: {text}', { text: r })),
      h('p', { class: 'muted small' }, t('Please check the list. You can cancel an award later, but it will stay visible in the history.'))));
    m.setActions([
      { label: t('Back'), kind: 'ghost', onclick: () => { m.setBody(form); m.setActions(step1Actions); } },
      { label: t('Confirm and award'), kind: 'primary', onclick: async (btn) => {
        const res = await act(btn, () => api('POST', '/points/award', { student_ids: students.map((s) => s.id), amount: n, reason: r, key }));
        if (!res) return;
        m.close();
        toast(res.awarded
          ? t(res.awarded === 1 ? 'Awarded {n} points to {count} student.' : 'Awarded {n} points to {count} students.', { n, count: res.awarded })
          : t('Already submitted. Nothing was awarded twice.'), 'success');
        onDone();
      } },
    ]);
  };
  const step1Actions = [
    { label: t('Cancel'), kind: 'ghost', onclick: (_b, m) => m.close() },
    { label: t('Review'), kind: 'primary', onclick: (_b, m) => toConfirm(m) },
  ];
  const m = openModal(t('Award points'), form, step1Actions);
  form.addEventListener('submit', () => toConfirm(m));
  amount.focus();
}

async function pickClass(title, classes, current) {
  const options = [{ value: '', label: t('No class (unassigned)') }].concat(classes.map((c) => ({ value: c.id, label: c.name })));
  const v = await formModal(title, [{ name: 'class_id', label: t('Class'), type: 'select', options, value: current ?? '' }], t('Save'));
  return v ? (v.class_id === '' ? null : Number(v.class_id)) : undefined;
}

function openCancelFlow(x, onDone) {
  formModal(t('Cancel award'), [{ name: 'reason', label: t('Reason for cancelling'), max: 200 }], t('Cancel award'),
    t('This reverses {amount} points for {name}. The original entry stays in the history.', { amount: fmtPts(x.amount), name: x.student_nickname })).then(async (v) => {
    if (!v) return;
    const res = await act(null, () => api('POST', `/points/${x.id}/cancel`, { reason: v.reason.trim() }));
    if (res) { toast(t('Award cancelled.'), 'success'); onDone(); }
  });
}

const canCancelFn = (x) => (x.type === 'award' && !x.cancelled_by && (isAdmin() || x.operator_id === state.user.id))
  || (isAdmin() && x.type === 'deduction' && !x.cancelled_by);

// ---------------- students list ----------------
async function viewStudents(root, query) {
  const cl = await api('GET', '/classes');
  const selected = new Map();
  let students = [];
  const classSel = h('select', { id: 'class_filter', 'aria-label': t('Filter by class') },
    h('option', { value: '' }, t('All classes')), h('option', { value: 'none' }, t('Unassigned ({n})', { n: cl.unassigned_count })),
    cl.classes.map((c) => h('option', { value: c.id }, `${c.name} (${c.student_count})`)));
  classSel.value = query.get('class') || '';
  const search = h('input', { id: 'student_search', type: 'search', placeholder: t('Search by name or login ID'), autocomplete: 'off', 'aria-label': t('Search students') });
  const listBox = h('div');
  const bar = h('div', { class: 'action-bar', hidden: true });

  const refreshBar = () => {
    bar.hidden = selected.size === 0;
    clear(bar);
    append(bar, [
      h('span', { class: 'strong' }, t('{n} selected', { n: selected.size })),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => openAwardFlow([...selected.values()], () => { selected.clear(); load(); }) }, t('Award points')),
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        const cid = await pickClass(t('Move {n} students to…', { n: selected.size }), cl.classes);
        if (cid === undefined) return;
        const res = await act(null, () => api('POST', '/students/assign', { student_ids: [...selected.keys()], class_id: cid }));
        if (res) { toast(t('Class updated.'), 'success'); selected.clear(); render(); }
      } }, t('Move to class')),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { selected.clear(); draw(); } }, t('Clear')),
    ]);
  };

  const draw = (total) => {
    clear(listBox);
    if (!students.length) { listBox.append(empty(t('No students match.'))); refreshBar(); return; }
    const all = h('input', { type: 'checkbox', id: 'sel_all', 'aria-label': t('Select all shown'), checked: students.every((s) => selected.has(s.id)),
      onchange: (e) => { students.forEach((s) => (e.target.checked ? selected.set(s.id, s) : selected.delete(s.id))); draw(total); } });
    listBox.append(
      h('label', { class: 'select-all' }, all, ' ', t('Select all {n} shown', { n: students.length }), total > students.length ? t(' (of {total} — narrow the search to see the rest)', { total }) : ''),
      h('ul', { class: 'list' }, students.map((s) => h('li', { class: 'row' },
        h('input', { type: 'checkbox', 'aria-label': t('Select {name}', { name: s.nickname }), checked: selected.has(s.id),
          onchange: (e) => { if (e.target.checked) selected.set(s.id, s); else selected.delete(s.id); refreshBar(); } }),
        h('a', { class: 'row-main link', href: '#/students/' + s.id },
          h('div', { class: 'row-title' }, s.nickname, ' ', h('span', { class: 'muted' }, '@' + s.login_id)),
          h('div', { class: 'row-sub' }, s.class_name ? chip(s.class_name) : chip(t('Unassigned'), 'pending'))),
        h('div', { class: 'row-side' }, h('div', { class: 'pts' }, s.balance), h('div', { class: 'muted small' }, t('points')))))));
    refreshBar();
  };

  const load = async () => {
    const qs = new URLSearchParams({ limit: '200' });
    if (search.value.trim()) qs.set('q', search.value.trim());
    if (classSel.value) qs.set('class_id', classSel.value);
    const res = await act(null, () => api('GET', '/students?' + qs));
    if (!res) return;
    students = res.students;
    draw(res.total);
  };

  search.addEventListener('input', debounce(load, 250));
  classSel.addEventListener('change', load);
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Students'))),
    h('div', { class: 'toolbar' }, search, classSel), listBox, bar]);
  await load();
}

// ---------------- student detail ----------------
async function viewStudent(root, id) {
  const [st, cl] = await Promise.all([api('GET', '/students/' + id), api('GET', '/classes')]);
  const s = st.student;
  const list = h('ul', { class: 'list' });
  const more = h('button', { class: 'btn ghost block', type: 'button' }, t('Load more'));
  let before = null;
  const loadTx = async (reset) => {
    if (reset) { clear(list); before = null; }
    const res = await act(more, () => api('GET', `/points/transactions?student_id=${id}&limit=30` + (before ? '&before=' + before : '')));
    if (!res) return;
    res.transactions.forEach((x) => list.append(txRow(x, { canCancel: canCancelFn, onCancel: (y) => openCancelFlow(y, () => render()) })));
    if (res.transactions.length) before = res.transactions[res.transactions.length - 1].id;
    more.hidden = res.transactions.length < 30;
    if (!list.children.length) list.append(empty(t('No point history yet.')));
  };
  more.addEventListener('click', () => loadTx(false));
  append(root, [
    h('a', { href: '#/students', class: 'back' }, t('← Students')),
    h('section', { class: 'balance-card' },
      h('div', { class: 'balance-label' }, s.nickname + ' · @' + s.login_id),
      h('div', { class: 'balance-value' }, String(s.balance)),
      h('div', { class: 'balance-sub' }, s.class_name ? t('Class {name}', { name: s.class_name }) : t('No class assigned'), s.is_active ? '' : ' · ' + t('inactive'))),
    h('div', { class: 'button-row' },
      s.is_active ? h('button', { class: 'btn primary', type: 'button', onclick: () => openAwardFlow([s], () => render()) }, t('Award points')) : null,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const cid = await pickClass(t('Change class'), cl.classes, s.class_id);
        if (cid === undefined) return;
        const res = await act(null, () => api('POST', '/students/assign', { student_ids: [s.id], class_id: cid }));
        if (res) { toast(t('Class updated.'), 'success'); render(); }
      } }, t('Change class')),
      isAdmin() ? h('button', { class: 'btn', type: 'button', onclick: () => openAdjustFlow(s, () => render()) }, t('Adjust points')) : null),
    h('div', { class: 'section-head' }, h('h2', null, t('History'))), list, more,
  ]);
  await loadTx(true);
}

// ---------------- classes ----------------
async function viewClasses(root) {
  const cl = await api('GET', '/classes');
  const name = h('input', { id: 'new_class', type: 'text', maxlength: 40, required: true, placeholder: t('New class name, e.g. 1-A'), autocomplete: 'off', 'aria-label': t('Class name') });
  const addBtn = h('button', { class: 'btn primary', type: 'submit' }, t('Add class'));
  const form = h('form', { class: 'inline-form', onsubmit: async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    const res = await act(addBtn, () => api('POST', '/classes', { name: name.value.trim() }));
    if (res) { toast(t('Class created.'), 'success'); render(); }
  } }, name, addBtn);
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Classes'))), form,
    cl.classes.length ? h('ul', { class: 'list' }, cl.classes.map((c) => h('li', { class: 'row' },
      h('a', { class: 'row-main link', href: '#/students?class=' + c.id }, h('div', { class: 'row-title' }, c.name), h('div', { class: 'row-sub' }, t(c.student_count === 1 ? '1 student' : '{n} students', { n: c.student_count }))),
      h('div', { class: 'row-side button-col' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const v = await formModal(t('Rename class'), [{ name: 'name', label: t('Class name'), value: c.name, max: 40 }], t('Save'));
          if (!v) return;
          const res = await act(null, () => api('PATCH', '/classes/' + c.id, { name: v.name.trim() }));
          if (res) { toast(t('Class renamed.'), 'success'); render(); }
        } }, t('Rename')),
        h('button', { class: 'btn small ghost', type: 'button', disabled: c.student_count > 0, title: c.student_count ? t('Move all students out first') : '', onclick: async () => {
          if (!(await confirmModal(t('Delete class'), t('Delete {name}?', { name: c.name }), t('Delete'), true))) return;
          const res = await act(null, () => api('DELETE', '/classes/' + c.id));
          if (res) { toast(t('Class deleted.'), 'success'); render(); }
        } }, t('Delete')))))) : empty(t('No classes yet. Add one above.')),
    h('a', { class: 'btn block', href: '#/students?class=none' }, t('Students without a class ({n})', { n: cl.unassigned_count })),
  ]);
}

// ---------------- award history ----------------
async function viewAwards(root) {
  const list = h('ul', { class: 'list' });
  const more = h('button', { class: 'btn ghost block', type: 'button' }, t('Load more'));
  const mine = h('input', { type: 'checkbox', id: 'only_mine', checked: !isAdmin() });
  const type = h('select', { id: 'type_filter', 'aria-label': t('Filter by type') }, h('option', { value: '' }, t('All types')),
    Object.keys(TYPE_LABELS).map((v) => h('option', { value: v }, typeLabel(v))));
  let before = null;
  const load = async (reset) => {
    if (reset) { clear(list); before = null; }
    const qs = new URLSearchParams({ limit: '30' });
    if (mine.checked) qs.set('mine', '1');
    if (type.value) qs.set('type', type.value);
    if (before) qs.set('before', before);
    const res = await act(more, () => api('GET', '/points/transactions?' + qs));
    if (!res) return;
    res.transactions.forEach((x) => list.append(txRow(x, { showStudent: true, canCancel: canCancelFn, onCancel: (y) => openCancelFlow(y, () => load(true)) })));
    if (res.transactions.length) before = res.transactions[res.transactions.length - 1].id;
    more.hidden = res.transactions.length < 30;
    if (!list.children.length) list.append(empty(t('Nothing to show.')));
  };
  mine.addEventListener('change', () => load(true));
  type.addEventListener('change', () => load(true));
  more.addEventListener('click', () => load(false));
  append(root, [
    h('div', { class: 'section-head' }, h('h2', null, t('Award history'))),
    h('div', { class: 'toolbar' }, h('label', { class: 'check', for: 'only_mine' }, mine, ' ', t('Only my entries')), type), list, more]);
  await load(true);
}
