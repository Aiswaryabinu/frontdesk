'use strict';
// Customer page: send a request, follow it, reply, reopen. It only ever talks to /api/public/*.
const root = document.getElementById('root');
const token = new URLSearchParams(location.search).get('t');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || res.statusText); e.code = data.error && data.error.code; throw e; }
  return data;
}
const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';

function newForm(relatedToken, err) {
  const f = {
    name: h('input', { maxlength: 100, autocomplete: 'name' }),
    email: h('input', { type: 'email', maxlength: 200, autocomplete: 'email' }),
    subject: h('input', { maxlength: 200 }),
    body: h('textarea', { maxlength: 10000 }),
    priority: h('select', {},
      h('option', { value: 'high' }, 'I cannot work at all'),
      h('option', { value: 'medium', selected: true }, 'Something is broken, but I can still work'),
      h('option', { value: 'low' }, 'I have a question or a small request')),
  };
  const form = h('form', { class: 'card', style: 'max-width:620px;margin:0 auto', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/public/tickets', { name: f.name.value, email: f.email.value, subject: f.subject.value, body: f.body.value, priority: f.priority.value, relatedToken });
      location.href = '/customer?t=' + r.token;
    } catch (ex) { root.replaceChildren(newForm(relatedToken, ex.message)); }
  } },
    h('h2', {}, relatedToken ? 'Open a new request' : 'How can we help?'),
    relatedToken ? h('p', { class: 'hint' }, 'We will link it to your earlier request.') : null,
    err ? h('p', { class: 'chip late' }, err) : null,
    h('label', {}, 'Your name'), f.name, h('label', {}, 'Your email'), f.email,
    h('label', {}, 'How bad is it?'), f.priority,
    h('label', {}, 'Short title'), f.subject,
    h('label', {}, 'What is happening?'), f.body,
    h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Send request')));
  return form;
}

async function showTicket() {
  let v;
  try { v = await api('GET', '/api/public/tickets/' + token); } catch (e) { root.replaceChildren(h('div', { class: 'card' }, 'We could not find this request. Check the link.')); return; }
  const ta = h('textarea', { 'aria-label': 'Your reply', maxlength: 10000 });
  const msg = h('p', {});
  const send = h('button', { class: 'primary', onclick: async () => {
    try { await api('POST', `/api/public/tickets/${token}/reply`, { body: ta.value }); showTicket(); }
    catch (e) {
      if (e.code === 'closed' || e.code === 'reopen_window_passed') root.replaceChildren(h('div', { class: 'card', style: 'max-width:620px;margin:0 auto' }, h('p', {}, e.message), h('p', {}, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); root.replaceChildren(newForm(token)); } }, 'Open a new request about this'))));
      else msg.replaceChildren(h('span', { class: 'chip late' }, e.message));
    }
  } }, v.reopensTicket ? 'Reopen with this message' : 'Send reply');
  root.replaceChildren(h('div', { style: 'max-width:760px;margin:0 auto' },
    h('div', { class: 'card' },
      h('div', { class: 'meta' }, h('span', {}, v.id), h('span', { class: 'chip neutral' }, v.statusLabel)),
      h('h2', {}, v.subject),
      v.status === 'resolved' ? h('p', { class: 'hint' }, `Not happy with the result? You can reopen this until ${fmt(v.reopenUntil)}.`) : null,
      v.status === 'waiting_on_customer' ? h('p', { class: 'chip paused' }, 'We asked you a question and are waiting for your answer.') : null,
      h('p', {}, h('a', { href: `/api/public/tickets/${token}/export` }, 'Download this conversation')),
      h('p', { class: 'hint' }, 'Keep this page address. It is your private link to this request.')),
    h('div', { class: 'thread' }, v.messages.map((m) => h('div', { class: 'msg ' + m.from },
      h('div', { class: 'by' }, h('b', {}, m.name), h('span', {}, fmt(m.at))), h('div', { class: 'body' }, m.body)))),
    v.canReply ? h('div', { class: 'card' }, ta, msg, h('p', {}, send)) : h('div', { class: 'card' }, h('p', {}, v.status === 'closed' ? 'This request was closed because we did not hear back.' : 'This request can no longer be changed.'),
      h('p', {}, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); root.replaceChildren(newForm(token)); } }, 'Open a new request about this')))));
}

if (token) showTicket(); else root.replaceChildren(newForm());
