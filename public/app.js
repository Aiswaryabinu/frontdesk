'use strict';
// Frontdesk agent screen. Plain JavaScript, no build step. All text is inserted with textContent (never innerHTML).

const WORK_DAY_MIN = 540;
const state = {
  token: localStorage.getItem('fd_token'),
  me: null,
  tab: 'tickets', // tickets | reports
  view: 'mine',
  counts: {},
  tickets: [],
  selectedId: null,
  detail: null,
  composeTab: 'reply',
  draft: { reply: '', note: '', await: false },
};
const root = document.getElementById('root');

// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') signOut();
    const e = new Error((data.error && data.error.message) || res.statusText);
    e.code = data.error && data.error.code;
    throw e;
  }
  return data;
}
function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : ''), role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4500);
}
const IST = { timeZone: 'Asia/Kolkata' };
const fmtDT = (iso) => new Date(iso).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';
function fmtWork(min) {
  min = Math.round(Math.abs(min));
  if (min < 1) return 'less than a minute';
  const d = Math.floor(min / WORK_DAY_MIN), hh = Math.floor((min % WORK_DAY_MIN) / 60), m = min % 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (hh) parts.push(hh + 'h');
  if (m && !d) parts.push(m + 'm');
  return parts.join(' ') || '0m';
}
const PRIO = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS = { open: 'Open', waiting_on_customer: 'Waiting on customer', resolved: 'Resolved', closed: 'Closed (no reply)' };

/** The clock an agent should care about right now. */
function activeClock(t) {
  const s = t.sla;
  if (t.status === 'resolved' || t.status === 'closed') return { name: 'Fix', c: s.resolution };
  return !s.first.doneAt ? { name: 'First reply', c: s.first } : { name: 'Fix', c: s.resolution };
}
function slaChip(t) {
  const s = t.sla;
  const { name, c } = activeClock(t);
  if (s.state === 'paused') return h('span', { class: 'chip paused' }, 'Waiting on customer - clock paused');
  if (t.status === 'resolved' || t.status === 'closed') {
    return h('span', { class: 'chip ' + (s.late ? 'done_late' : 'done') }, s.late ? 'Finished late' : 'Finished on time');
  }
  if (s.state === 'late') return h('span', { class: 'chip late' }, `${name} late by ${fmtWork(c.minutesLeft)}`);
  return h('span', { class: 'chip ' + s.state }, `${name} due in ${fmtWork(c.minutesLeft)}`);
}

// ------------------------------------------------------------------ data
async function refreshList() {
  const [list, counts] = await Promise.all([api('GET', '/api/tickets?view=' + state.view), api('GET', '/api/counts')]);
  state.tickets = list.tickets;
  state.counts = counts;
}
async function loadDetail(id) {
  state.selectedId = id;
  try {
    state.detail = await api('GET', '/api/tickets/' + encodeURIComponent(id));
  } catch (e) {
    state.detail = null;
    toast(e.message, true);
  }
}
function signOut() {
  localStorage.removeItem('fd_token');
  state.token = null;
  state.me = null;
  render();
}

// ------------------------------------------------------------------ views
function renderLogin(err) {
  const email = h('input', { type: 'email', autocomplete: 'username', value: '', placeholder: 'meera@arvo.test' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const form = h('form', { class: 'card login', onsubmit: async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', '/api/login', { email: email.value, password: pw.value });
      state.token = r.token;
      localStorage.setItem('fd_token', r.token);
      state.me = r.agent;
      await start();
    } catch (e) { renderLogin(e.message); }
  } },
    h('h2', {}, 'Frontdesk'),
    h('p', { class: 'hint' }, 'Arvo Systems support. Sign in with your agent account.'),
    err && h('p', { class: 'chip late' }, err),
    h('label', {}, 'Email'), email,
    h('label', {}, 'Password'), pw,
    h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Sign in')),
    h('p', { class: 'hint' }, 'Customers: open your private ticket link, or ', h('a', { href: '/customer' }, 'send a new request'), '.')
  );
  root.replaceChildren(form);
  email.focus();
}

function renderTopbar() {
  return h('div', { class: 'topbar' },
    h('b', {}, 'Frontdesk'),
    h('nav', {},
      h('button', { class: state.tab === 'tickets' ? 'on' : '', onclick: () => { state.tab = 'tickets'; render(); } }, 'Tickets'),
      h('button', { class: state.tab === 'reports' ? 'on' : '', onclick: () => { state.tab = 'reports'; render(); } }, 'Late report')),
    h('span', { class: 'who' }, state.me.name + (state.me.role === 'manager' ? ' (lead)' : ''),
      h('button', { onclick: async () => { try { await api('POST', '/api/logout'); } catch (_) {} signOut(); } }, 'Sign out')));
}

function renderSidebar() {
  const views = [['mine', 'Mine'], ['unassigned', 'Unassigned'], ['late', 'Late', true], ['waiting', 'Waiting on customer'], ['all', 'All open'], ['done', 'Done']];
  const keyOf = { mine: 'mine', unassigned: 'unassigned', late: 'late', waiting: 'waiting', all: 'all' };
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'views' }, views.map(([v, label, alert]) =>
      h('button', { class: (state.view === v ? 'on ' : '') + (alert && state.counts.late ? 'alert' : ''), onclick: async () => { state.view = v; await refreshList(); render(); } },
        label, keyOf[v] ? h('span', { class: 'n' }, String(state.counts[keyOf[v]] ?? 0)) : null))),
    h('div', { class: 'list' },
      state.tickets.length === 0 ? h('div', { class: 'empty' }, 'Nothing here.') :
      state.tickets.map((t) => h('button', { class: 'row' + (t.id === state.selectedId ? ' sel' : ''), onclick: async () => { await loadDetail(t.id); render(); } },
        h('div', { class: 'l1' }, h('span', { class: 'id' }, t.id), h('span', { class: 'subj' }, t.subject), h('span', { class: 'chip p-' + t.priority }, PRIO[t.priority])),
        h('div', { class: 'l2' }, slaChip(t), h('span', {}, t.assigneeName ? 'Owner: ' + t.assigneeName : 'Not taken'), h('span', {}, t.customerName))))));
}

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, true);
  }
  await refreshList().catch(() => {});
  if (state.selectedId) await loadDetail(state.selectedId);
  render();
}

function clockBox(title, c, paused) {
  const done = !!c.doneAt;
  const cls = 'clock' + (c.late ? ' late' : '') + (paused && !done ? ' paused' : '');
  let v, s;
  if (done) { v = c.late ? 'Missed' : 'Met'; s = `Done ${fmtDT(c.doneAt)} - target was ${fmtDT(c.dueAt)}`; }
  else if (paused) { v = 'Paused'; s = `Deadline moves while we wait. Currently ${fmtDT(c.dueAt)}`; }
  else if (c.late) { v = `Late by ${fmtWork(c.minutesLeft)}`; s = `Was due ${fmtDT(c.dueAt)} (working time)`; }
  else { v = `${fmtWork(c.minutesLeft)} left`; s = `Due ${fmtDT(c.dueAt)} (working time)`; }
  return h('div', { class: cls }, h('div', { class: 't' }, title), h('div', { class: 'v' }, v), h('div', { class: 's' }, s));
}

function renderDetail() {
  if (!state.detail) return h('main', { class: 'detail' }, h('div', { class: 'empty' }, 'Pick a ticket on the left.'));
  const { ticket: t, thread, audit, auditCheck } = state.detail;
  const mine = t.assigneeId === state.me.id;
  const active = t.status === 'open' || t.status === 'waiting_on_customer';
  const owner = t.assigneeName;
  const canReply = active && mine;
  const paused = t.status === 'waiting_on_customer';

  const prio = h('select', { 'aria-label': 'Priority', disabled: !active, onchange: (e) => {
    const reason = prompt('Why is the priority changing? (kept in the history)') || '';
    act(() => api('POST', `/api/tickets/${t.id}/priority`, { priority: e.target.value, reason }), 'Priority changed. Deadlines were recalculated from the start of the ticket.');
  } }, ['high', 'medium', 'low'].map((p) => h('option', { value: p, ...(p === t.priority ? { selected: true } : {}) }, PRIO[p] + (p === 'high' ? ' - cannot work' : ''))));

  const actions = h('div', { class: 'actions' },
    active && !t.assigneeId && h('button', { class: 'primary', onclick: () => act(() => api('POST', `/api/tickets/${t.id}/claim`), 'You took this ticket') }, 'Take this ticket'),
    active && mine && h('button', { onclick: () => act(() => api('POST', `/api/tickets/${t.id}/release`), 'Released') }, 'Release'),
    active && mine && h('button', { class: 'primary', onclick: () => {
      const msg = prompt('Message to the customer for closing this ticket (optional if you have already replied):', '') ;
      if (msg === null) return;
      act(() => api('POST', `/api/tickets/${t.id}/resolve`, { body: msg }), 'Marked as resolved');
    } }, 'Resolve'),
    t.status === 'resolved' && h('button', { onclick: () => act(() => api('POST', `/api/tickets/${t.id}/reopen`), 'Reopened') }, 'Reopen'),
    h('label', { style: 'margin:0;font-weight:400' }, 'Priority '), prio);

  const thr = h('div', { class: 'thread' }, thread.map((m) => h('div', { class: 'msg ' + (m.kind === 'internal' ? 'internal' : m.from) },
    h('div', { class: 'by' }, h('b', {}, m.name), h('span', {}, m.from === 'customer' ? 'customer' : 'agent'), h('span', {}, fmtDT(m.at)),
      m.kind === 'internal' && h('span', { class: 'private' }, 'PRIVATE NOTE - the customer never sees this')),
    h('div', { class: 'body' }, m.body))));

  // composer
  const ta = h('textarea', { 'aria-label': 'Message', placeholder: state.composeTab === 'reply' ? 'Write to the customer...' : 'Write a note for the team only...' });
  ta.value = state.composeTab === 'reply' ? state.draft.reply : state.draft.note;
  ta.addEventListener('input', () => { state.draft[state.composeTab] = ta.value; });
  const awaitBox = h('input', { type: 'checkbox', checked: state.draft.await, onchange: (e) => { state.draft.await = e.target.checked; } });
  const sendReply = () => {
    const body = ta.value;
    act(async () => {
      await api('POST', `/api/tickets/${t.id}/reply`, { body, awaitCustomer: state.draft.await });
      state.draft.reply = ''; state.draft.await = false;
    }, 'Reply sent to the customer');
  };
  const sendNote = () => {
    const body = ta.value;
    act(async () => { await api('POST', `/api/tickets/${t.id}/note`, { body }); state.draft.note = ''; }, 'Private note saved');
  };
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') (state.composeTab === 'reply' ? sendReply : sendNote)(); });
  const isNote = state.composeTab === 'note';
  const composer = h('div', { class: 'composer' + (isNote ? ' note-mode' : '') },
    h('div', { class: 'tabs' },
      h('button', { class: 'tab' + (!isNote ? ' on' : ''), onclick: () => { state.composeTab = 'reply'; render(); } }, 'Reply to customer'),
      h('button', { class: 'tab note' + (isNote ? ' on note' : ''), onclick: () => { state.composeTab = 'note'; render(); } }, 'Private note (team only)')),
    h('div', { class: 'inner' },
      isNote ? h('div', { class: 'banner warn' }, 'Only your team can see this. It is never shown to the customer, never included in their export.')
        : (!active ? h('div', { class: 'banner info' }, 'This ticket is ' + STATUS[t.status].toLowerCase() + '. ' + (t.status === 'resolved' ? 'Reopen it to reply.' : ''))
          : !t.assigneeId ? h('div', { class: 'banner info' }, 'Take this ticket first. Only the agent who owns it can reply, so two agents never answer the same customer.')
          : !mine ? h('div', { class: 'banner info' }, `${owner} owns this ticket, so only ${owner} can reply. You can add a private note.`) : null),
      ta,
      h('div', { class: 'foot' },
        isNote ? h('span', {}) : h('label', {}, awaitBox, 'I am asking the customer a question (pause the clock until they answer)'),
        isNote ? h('button', { class: 'primary', onclick: sendNote }, 'Save private note')
          : h('button', { class: 'primary', disabled: !canReply, onclick: sendReply }, 'Send to customer'))));

  const auditRows = audit.map((e) => h('tr', {}, h('td', {}, fmtDT(e.at)), h('td', {}, e.actorName), h('td', {}, e.type), h('td', {}, h('code', {}, Object.keys(e.details).length ? JSON.stringify(e.details) : ''))));
  const auditBox = h('details', { class: 'audit' },
    h('summary', {}, `History (${audit.length} events) - `, auditCheck.ok ? 'verified, unchanged' : 'WARNING: history has been tampered with'),
    h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Details'].map((x) => h('th', {}, x)))), h('tbody', {}, auditRows)));

  return h('main', { class: 'detail' },
    h('div', { class: 'head' },
      h('div', {},
        h('h2', {}, t.subject),
        h('div', { class: 'meta' }, h('span', {}, t.id), h('span', { class: 'chip p-' + t.priority }, PRIO[t.priority]),
          h('span', { class: 'chip neutral' }, STATUS[t.status]), h('span', {}, `${t.customerName} <${t.customerEmail}>`),
          h('span', {}, 'Owner: ' + (owner || 'nobody yet')), t.reopenCount ? h('span', {}, `Reopened ${t.reopenCount}x`) : null,
          t.relatedTicketId ? h('span', {}, 'Follow-up of ' + t.relatedTicketId) : null))),
    t.status === 'resolved' ? h('p', { class: 'hint' }, `The customer can reopen it until ${fmtDT(t.reopenableUntil)}; after that a new ticket is needed.`) : null,
    paused ? h('p', { class: 'hint' }, `If the customer stays silent, this ticket closes itself at ${fmtDT(t.autoCloseAt)}.`) : null,
    actions,
    h('div', { class: 'clocks' }, clockBox('First reply', t.sla.first, false), clockBox('Fix', t.sla.resolution, paused)),
    thr, composer, auditBox);
}

async function renderReports() {
  const data = await api('GET', '/api/reports/late?days=' + (state.reportDays || 30));
  const sel = h('select', { style: 'width:auto', onchange: (e) => { state.reportDays = Number(e.target.value); render(); } },
    [7, 30, 90].map((d) => h('option', { value: d, ...(d === (state.reportDays || 30) ? { selected: true } : {}) }, 'Last ' + d + ' days')));
  const kind = { first_reply: 'First reply was late', fix: 'Fix was late', fix_earlier_cycle: 'Earlier fix was late' };
  const rows = data.items.map((i) => h('tr', {},
    h('td', {}, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); state.tab = 'tickets'; state.view = 'all'; await refreshList(); await loadDetail(i.id); render(); } }, i.id), h('div', { class: 'hint' }, i.subject)),
    h('td', {}, h('span', { class: 'chip p-' + i.priority }, PRIO[i.priority])),
    h('td', {}, i.assigneeName || 'Nobody'),
    h('td', {}, i.reasons.map((r) => h('div', {}, h('b', {}, kind[r.kind] + ' by ' + fmtWork(r.lateByWorkingMinutes)), h('div', { class: 'hint' }, r.note))))));
  const pct = (x) => Math.round(x * 100) + '%';
  return h('div', { class: 'page reports' },
    h('div', { class: 'head', style: 'display:flex;justify-content:space-between;align-items:center' }, h('h2', {}, 'Which problems were late, and why?'), sel),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(data.total)), 'tickets'),
      h('div', { class: 'stat' }, h('b', {}, String(data.late)), 'late'),
      h('div', { class: 'stat' }, h('b', {}, pct(data.lateRate)), 'late rate'),
      ['high', 'medium', 'low'].map((p) => h('div', { class: 'stat' }, h('b', {}, `${data.byPriority[p].late}/${data.byPriority[p].total}`), PRIO[p] + ' late'))),
    data.items.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Ticket', 'Priority', 'Owner', 'Why it was late'].map((x) => h('th', {}, x)))), h('tbody', {}, rows))
      : h('div', { class: 'card empty' }, 'No late tickets in this period.'),
    h('p', { class: 'hint' }, 'Times are working time (Mon-Fri 09:30-18:30 India time, without holidays). Time spent waiting for the customer is not counted against us.'));
}

async function render() {
  if (!state.token || !state.me) return renderLogin();
  if (state.tab === 'reports') {
    try { root.replaceChildren(renderTopbar(), await renderReports()); } catch (e) { toast(e.message, true); }
    return;
  }
  const scroll = document.querySelector('.detail');
  const keepScroll = scroll ? scroll.scrollTop : 0;
  root.replaceChildren(renderTopbar(), h('div', { class: 'layout' }, renderSidebar(), renderDetail()));
  const d = document.querySelector('.detail');
  if (d) d.scrollTop = keepScroll;
}

async function start() {
  if (!state.token) return renderLogin();
  try {
    if (!state.me) state.me = (await api('GET', '/api/me')).agent;
    await refreshList();
    if (state.selectedId) await loadDetail(state.selectedId);
  } catch (e) { return renderLogin(); }
  render();
}

// Keep the list fresh, but never while someone is typing (a refresh must not eat a half-written reply).
setInterval(async () => {
  if (!state.me || state.tab !== 'tickets' || document.hidden) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
  try { await refreshList(); if (state.selectedId) await loadDetail(state.selectedId); render(); } catch (_) {}
}, 20000);

start();
