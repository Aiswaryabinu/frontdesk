'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { Frontdesk } = require('../src/service');
const { createServer } = require('../src/server');

const ist = (s) => Date.parse(s.replace(' ', 'T') + ':00+05:30');

async function setup(start = '2026-11-23 10:00') {
  const db = await openDb('sqlite');
  const svc = new Frontdesk(db);
  let clock = ist(start);
  svc.now = () => clock;
  await svc.init();
  const agents = Object.fromEntries((await svc.listAgents()).map((a) => [a.name, a]));
  return { db, svc, agents, set: (s) => (clock = ist(s)), advance: (s) => (clock = ist(s)) };
}
const newTicket = (svc, extra = {}) =>
  svc.createTicket({ name: 'Rita', email: 'rita@customer.test', subject: 'Cannot log in', body: 'Nothing works', priority: 'medium', ...extra });
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test('INC-0291: two agents click "take" at the same moment, exactly one wins', async () => {
  const { svc, agents } = await setup();
  const { ticketId } = await newTicket(svc);
  const results = await Promise.allSettled([svc.claim(agents.Arjun, ticketId), svc.claim(agents.Priya, ticketId)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.equal(lost.reason.status, 409);
  assert.match(lost.reason.message, /Already taken by/);
  const { ticket } = await svc.get(agents.Meera, ticketId);
  const winner = results.find((r) => r.status === 'fulfilled').value.assigneeName;
  assert.equal(ticket.assigneeName, winner);
});

test('INC-0291: only the agent who owns a ticket can reply to the customer', async () => {
  const { svc, agents } = await setup();
  const { ticketId } = await newTicket(svc);
  await rejects(svc.reply(agents.Arjun, ticketId, { body: 'hi' }), 'not_claimed');
  await svc.claim(agents.Arjun, ticketId);
  await rejects(svc.reply(agents.Priya, ticketId, { body: 'hi' }), 'not_assignee');
  await svc.reply(agents.Arjun, ticketId, { body: 'hello' });
});

test('INC-0304: private notes never reach the customer (screen, API, export)', async () => {
  const { svc, agents, db } = await setup();
  const { ticketId, token } = await newTicket(svc);
  await svc.claim(agents.Arjun, ticketId);
  await svc.note(agents.Arjun, ticketId, { body: 'TOP-SECRET-NOTE: this customer is difficult' });
  await svc.reply(agents.Arjun, ticketId, { body: 'We are on it' });
  const view = JSON.stringify(await svc.customerView(token));
  const exp = await svc.customerExport(token);
  assert.ok(!view.includes('TOP-SECRET'));
  assert.ok(!exp.includes('TOP-SECRET'));
  assert.ok(view.includes('We are on it'));
  // the agent can see it, marked internal
  const detail = await svc.get(agents.Priya, ticketId);
  assert.ok(detail.thread.some((m) => m.kind === 'internal' && m.body.includes('TOP-SECRET')));
  // and the audit log does not copy the note text
  assert.ok(!JSON.stringify(detail.audit).includes('TOP-SECRET'));

  // over real HTTP, using the customer endpoints
  const server = createServer(svc);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const p of [`/api/public/tickets/${token}`, `/api/public/tickets/${token}/export`]) {
    const txt = await (await fetch(base + p)).text();
    assert.ok(!txt.includes('TOP-SECRET'), p);
  }
  assert.equal((await fetch(`${base}/api/tickets/${ticketId}`)).status, 401); // agent API needs login
  server.close();
});

test('INC-0318: every action is recorded with who and when, and the record cannot be changed', async () => {
  const { svc, agents, db, advance } = await setup();
  const { ticketId } = await newTicket(svc);
  advance('2026-11-23 10:05');
  await svc.claim(agents.Arjun, ticketId);
  advance('2026-11-23 10:40');
  await svc.reply(agents.Arjun, ticketId, { body: 'First reply' });
  const d = await svc.get(agents.Meera, ticketId);
  const types = d.audit.map((e) => e.type);
  assert.deepEqual(types, ['ticket.created', 'ticket.claimed', 'message.public']);
  const reply = d.audit.find((e) => e.type === 'message.public' && e.details.from === 'agent');
  assert.equal(reply.actorName, 'Arjun');
  assert.equal(reply.at, new Date(ist('2026-11-23 10:40')).toISOString());
  assert.equal(d.auditCheck.ok, true);

  assert.throws(() => db.raw.exec("UPDATE audit_events SET actor_name = 'Someone Else'"), /append-only/);
  assert.throws(() => db.raw.exec('DELETE FROM audit_events'), /append-only/);
  assert.throws(() => db.raw.exec("UPDATE messages SET body = 'edited'"), /append-only/);

  // even someone with raw access who removes the guard is caught by the hash chain
  db.raw.exec('DROP TRIGGER audit_events_no_update');
  db.raw.exec("UPDATE audit_events SET actor_name = 'Priya' WHERE type = 'message.public' AND actor_kind = 'agent'");
  const check = await svc.verifyAudit(ticketId);
  assert.equal(check.ok, false);
});

test('customer reply resumes the clock; one silent working week closes the ticket', async () => {
  const { svc, agents, set } = await setup();
  const { ticketId, token } = await newTicket(svc);
  await svc.claim(agents.Arjun, ticketId);
  set('2026-11-23 12:00');
  let t = await svc.reply(agents.Arjun, ticketId, { body: 'Which browser?', awaitCustomer: true });
  assert.equal(t.status, 'waiting_on_customer');
  assert.equal(t.sla.state, 'paused');

  set('2026-11-25 12:00');
  await svc.customerReply(token, 'Chrome');
  t = (await svc.get(agents.Arjun, ticketId)).ticket;
  assert.equal(t.status, 'open');
  // 1080 working minutes were not counted: fix due moves from Thu 26 Nov 10:00 to Mon 30 Nov 10:00
  assert.equal(t.sla.resolution.dueAt, new Date(ist('2026-11-30 10:00')).toISOString());

  // second question, then silence
  await svc.reply(agents.Arjun, ticketId, { body: 'And the version?', awaitCustomer: true });
  set('2026-11-30 12:00'); // before Mon 7 Dec 12:00
  await svc.sweep();
  assert.equal((await svc.get(agents.Arjun, ticketId)).ticket.status, 'waiting_on_customer');
  set('2026-12-07 12:01');
  await svc.sweep();
  const closed = await svc.get(agents.Arjun, ticketId);
  assert.equal(closed.ticket.status, 'closed');
  assert.equal(closed.ticket.sla.late, false, 'waiting on the customer is not our lateness');
  assert.ok(closed.audit.some((e) => e.type === 'ticket.auto_closed' && e.actorKind === 'system'));
  await rejects(svc.customerReply(token, 'hello again'), 'closed');
  // "they can always contact us again": a new ticket that points at the old one
  const again = await newTicket(svc, { relatedToken: token });
  assert.equal((await svc.get(agents.Meera, again.ticketId)).ticket.relatedTicketId, ticketId);
});

test('reopen window: about one working week, then it is a new ticket', async () => {
  const { svc, agents, set } = await setup();
  const { ticketId, token } = await newTicket(svc);
  await svc.claim(agents.Arjun, ticketId);
  set('2026-11-24 14:00');
  await svc.resolve(agents.Arjun, ticketId, { body: 'Fixed' });
  set('2026-11-27 10:00');
  await svc.customerReply(token, 'Still broken'); // customer reopens
  let t = (await svc.get(agents.Arjun, ticketId)).ticket;
  assert.equal(t.status, 'open');
  assert.equal(t.reopenCount, 1);
  await svc.resolve(agents.Arjun, ticketId, { body: 'Fixed again' });
  assert.equal((await svc.get(agents.Arjun, ticketId)).ticket.status, 'resolved');
  set('2026-12-04 10:01'); // 5 working days after 27 Nov 10:00 is 4 Dec 10:00 (resolve happened at 10:00)
  await rejects(svc.customerReply(token, 'again'), 'reopen_window_passed');
  await rejects(svc.reopen(agents.Arjun, ticketId), 'reopen_window_passed');
});

test('changing priority in the middle re-derives deadlines from the original start and is recorded', async () => {
  const { svc, agents, set } = await setup();
  const { ticketId } = await newTicket(svc, { priority: 'low' });
  await svc.claim(agents.Arjun, ticketId);
  await svc.reply(agents.Arjun, ticketId, { body: 'Looking' });
  set('2026-11-24 12:00');
  assert.equal((await svc.get(agents.Arjun, ticketId)).ticket.sla.late, false);
  const t = await svc.setPriority(agents.Arjun, ticketId, 'high', 'customer is down');
  assert.equal(t.priority, 'high');
  assert.equal(t.sla.late, true); // high fix target was Mon 23 Nov 18:30
  const ev = (await svc.get(agents.Arjun, ticketId)).audit.find((e) => e.type === 'priority.changed');
  assert.equal(ev.details.from, 'low');
  assert.equal(ev.details.to, 'high');
  assert.equal(ev.details.fixDue.to, new Date(ist('2026-11-23 18:30')).toISOString());
});

test('managers can see which tickets were late and why', async () => {
  const { svc, agents, set } = await setup('2026-11-23 10:00');
  const { ticketId } = await newTicket(svc, { priority: 'high' });
  set('2026-11-23 15:00'); // 2h reply target missed (due 12:00)
  await svc.claim(agents.Arjun, ticketId);
  await svc.reply(agents.Arjun, ticketId, { body: 'Sorry for the wait' });
  const r = await svc.lateReport({ days: 30 });
  assert.equal(r.late, 1);
  assert.equal(r.items[0].reasons[0].kind, 'first_reply');
  assert.equal(r.items[0].reasons[0].lateByWorkingMinutes, 180);
  assert.match(r.items[0].reasons[0].note, /Nobody took it for 300 working minutes/);
});

test('resolving needs a message when the customer has not been answered yet; notes are open to any agent', async () => {
  const { svc, agents } = await setup();
  const { ticketId } = await newTicket(svc);
  await svc.claim(agents.Arjun, ticketId);
  await rejects(svc.resolve(agents.Arjun, ticketId, {}), 'message_required');
  await svc.note(agents.Priya, ticketId, { body: 'FYI same as last week' }); // not the owner, still fine
});
