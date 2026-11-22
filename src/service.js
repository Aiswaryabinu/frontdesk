'use strict';
const crypto = require('node:crypto');
const { WorkCalendar, computeSla, WEEK_MIN, MIN } = require('./sla');

const iso = (ms) => new Date(ms).toISOString();
const toMs = (s) => (s ? Date.parse(s) : null);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const PRIORITIES = ['high', 'medium', 'low'];
const ACTIVE = ['open', 'waiting_on_customer'];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (code, msg) => new HttpError(400, code, msg);
const conflict = (code, msg) => new HttpError(409, code, msg);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const clean = (v, max, field, { required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw bad('invalid_input', `${field} is required`);
  if (s.length > max) throw bad('invalid_input', `${field} is too long (max ${max} characters)`);
  return s;
};

const model = (r) => ({
  id: r.id,
  subject: r.subject,
  customerName: r.customer_name,
  customerEmail: r.customer_email,
  priority: r.priority,
  status: r.status,
  assigneeId: r.assignee_id,
  relatedTicketId: r.related_ticket_id,
  createdAt: toMs(r.created_at),
  cycleStartAt: toMs(r.cycle_start_at),
  firstResponseAt: toMs(r.first_response_at),
  pausedAt: toMs(r.paused_at),
  pausedMinutes: Number(r.paused_minutes),
  resolvedAt: toMs(r.resolved_at),
  closedAt: toMs(r.closed_at),
  reopenCount: Number(r.reopen_count),
  version: Number(r.version),
});

class Frontdesk {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.cal = new WorkCalendar([]);
    this._holidaysLoadedAt = 0;
  }

  // ---------------------------------------------------------------- setup
  async init({ seed = true } = {}) {
    await this.db.migrate();
    await this.db.tx(async (t) => {
      await t.query("INSERT INTO counters (name, value) VALUES ('ticket', 0) ON CONFLICT (name) DO NOTHING");
    });
    if (seed) await this.seed();
    await this.loadHolidays(true);
  }

  async seed() {
    const pw = process.env.SEED_PASSWORD || 'frontdesk-demo';
    await this.db.tx(async (t) => {
      const n = (await t.query('SELECT COUNT(*) AS c FROM agents')).rows[0].c;
      if (Number(n) > 0) return;
      const people = [
        ['Meera', 'manager'],
        ['Arjun', 'agent'],
        ['Priya', 'agent'],
        ['Rohan', 'agent'],
        ['Anita', 'agent'],
        ['Kiran', 'agent'],
        ['Sana', 'agent'],
        ['Vikram', 'agent'],
        ['Divya', 'agent'],
      ]; // nine agents; Meera is the support lead and can also manage holidays
      for (const [name, role] of people) {
        await t.query(
          'INSERT INTO agents (id, name, email, role, password_hash, created_at) VALUES (?,?,?,?,?,?)',
          [uid(), name, `${name.toLowerCase()}@arvo.test`, role, hashPassword(pw), iso(this.now())]
        );
      }
      // PLACEHOLDER festival holidays - the real list must come from Arvo (edit via API, see README).
      const hol = [
        ['2026-12-25', 'Christmas'],
        ['2027-01-26', 'Republic Day'],
      ];
      for (const [d, n2] of hol) {
        await t.query('INSERT INTO holidays (day, name) VALUES (?,?) ON CONFLICT (day) DO NOTHING', [d, n2]);
      }
    });
  }

  async loadHolidays(force = false) {
    const nowMs = Date.now();
    if (!force && nowMs - this._holidaysLoadedAt < 30000) return;
    const rows = await this.db.tx(async (t) => (await t.query('SELECT day FROM holidays')).rows);
    this.cal.setHolidays(rows.map((r) => r.day));
    this._holidaysLoadedAt = nowMs;
  }

  // ---------------------------------------------------------------- auth
  async login(email, password) {
    const row = await this.db.tx(async (t) => (await t.query('SELECT * FROM agents WHERE email = ?', [String(email || '').toLowerCase().trim()])).rows[0]);
    if (!row || !checkPassword(String(password || ''), row.password_hash)) {
      throw new HttpError(401, 'bad_login', 'Wrong email or password');
    }
    const token = crypto.randomBytes(32).toString('hex');
    await this.db.tx(async (t) => {
      await t.query('INSERT INTO sessions (token_hash, agent_id, expires_at) VALUES (?,?,?)', [
        sha(token),
        row.id,
        iso(this.now() + 12 * 3600 * 1000),
      ]);
    });
    return { token, agent: { id: row.id, name: row.name, role: row.role } };
  }

  async authenticate(token) {
    if (!token) return null;
    return this.db.tx(async (t) => {
      const r = (
        await t.query(
          'SELECT a.id, a.name, a.role, s.expires_at FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE s.token_hash = ?',
          [sha(token)]
        )
      ).rows[0];
      if (!r || toMs(r.expires_at) < this.now()) return null;
      return { id: r.id, name: r.name, role: r.role };
    });
  }

  async logout(token) {
    await this.db.tx(async (t) => {
      await t.query('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
    });
  }

  async listAgents() {
    return this.db.tx(async (t) => (await t.query('SELECT id, name, role FROM agents ORDER BY name')).rows);
  }

  // ---------------------------------------------------------------- audit
  async _audit(t, ticketId, actor, type, details, at) {
    const last = (
      await t.query('SELECT seq, hash FROM audit_events WHERE ticket_id = ? ORDER BY seq DESC LIMIT 1', [ticketId])
    ).rows[0];
    const seq = last ? Number(last.seq) + 1 : 1;
    const prev = last ? last.hash : 'GENESIS';
    const d = JSON.stringify(details || {});
    const atIso = iso(at);
    const hash = sha([prev, ticketId, seq, atIso, actor.kind, actor.id || '', actor.name, type, d].join('|'));
    await t.query(
      'INSERT INTO audit_events (ticket_id, seq, at, actor_kind, actor_id, actor_name, type, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [ticketId, seq, atIso, actor.kind, actor.id || null, actor.name, type, d, prev, hash]
    );
  }

  async verifyAudit(ticketId) {
    const rows = await this.db.tx(async (t) =>
      (await t.query('SELECT * FROM audit_events WHERE ticket_id = ? ORDER BY seq', [ticketId])).rows
    );
    let prev = 'GENESIS';
    for (const r of rows) {
      const h = sha([prev, r.ticket_id, Number(r.seq), r.at, r.actor_kind, r.actor_id || '', r.actor_name, r.type, r.details].join('|'));
      if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAtSeq: Number(r.seq) };
      prev = r.hash;
    }
    return { ok: true, events: rows.length };
  }

  // ---------------------------------------------------------------- helpers
  async _lock(t, id) {
    const r = (await t.query('SELECT * FROM tickets WHERE id = ?' + this.db.forUpdate, [id])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'Ticket not found');
    return model(r);
  }
  async _save(t, id, now, fields) {
    const keys = Object.keys(fields);
    const sql = `UPDATE tickets SET ${keys.map((k) => k + ' = ?').join(', ')}${keys.length ? ', ' : ''}version = version + 1, updated_at = ? WHERE id = ?`;
    await t.query(sql, [...keys.map((k) => fields[k]), iso(now), id]);
  }
  _asAgent(a) {
    return { kind: 'agent', id: a.id, name: a.name };
  }
  _sla(m, now) {
    return computeSla(this.cal, m, now);
  }
  _view(m, assigneeName, now) {
    const sla = this._sla(m, now);
    return {
      id: m.id,
      subject: m.subject,
      customerName: m.customerName,
      customerEmail: m.customerEmail,
      priority: m.priority,
      status: m.status,
      assigneeId: m.assigneeId,
      assigneeName: assigneeName || null,
      relatedTicketId: m.relatedTicketId,
      createdAt: iso(m.createdAt),
      firstResponseAt: m.firstResponseAt ? iso(m.firstResponseAt) : null,
      resolvedAt: m.resolvedAt ? iso(m.resolvedAt) : null,
      closedAt: m.closedAt ? iso(m.closedAt) : null,
      reopenCount: m.reopenCount,
      version: m.version,
      pausedAt: m.pausedAt ? iso(m.pausedAt) : null,
      reopenableUntil: m.status === 'resolved' ? iso(this.cal.addWorkingMinutes(m.resolvedAt, WEEK_MIN)) : null,
      autoCloseAt: m.status === 'waiting_on_customer' && m.pausedAt ? iso(this.cal.addWorkingMinutes(m.pausedAt, WEEK_MIN)) : null,
      sla: {
        state: sla.state,
        late: sla.late,
        first: this._clockOut(sla.first),
        resolution: this._clockOut(sla.resolution),
      },
    };
  }
  _clockOut(c) {
    return { dueAt: iso(c.dueAt), doneAt: c.doneAt ? iso(c.doneAt) : null, late: c.late, minutesLeft: Math.round(c.minutesLeft) };
  }
  async _assigneeName(t, id) {
    if (!id) return null;
    const r = (await t.query('SELECT name FROM agents WHERE id = ?', [id])).rows[0];
    return r ? r.name : null;
  }
  _resume(m, now) {
    return m.pausedMinutes + this.cal.workingMinutesBetween(m.pausedAt, now);
  }

  // ---------------------------------------------------------------- customer side
  async createTicket({ name, email, subject, body, priority, relatedToken }) {
    await this.loadHolidays();
    const f = {
      name: clean(name, 100, 'Name'),
      email: clean(email, 200, 'Email'),
      subject: clean(subject, 200, 'Subject'),
      body: clean(body, 10000, 'Description'),
    };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw bad('invalid_input', 'Email does not look right');
    if (!PRIORITIES.includes(priority)) throw bad('invalid_input', 'priority must be high, medium or low');
    const now = this.now();
    const token = crypto.randomBytes(24).toString('hex');
    return this.db.tx(async (t) => {
      let related = null;
      if (relatedToken) {
        const r = (await t.query('SELECT id FROM tickets WHERE customer_token = ?', [String(relatedToken)])).rows[0];
        if (r) related = r.id;
      }
      const n = (await t.query("UPDATE counters SET value = value + 1 WHERE name = 'ticket' RETURNING value")).rows[0].value;
      const id = 'FD-' + String(n).padStart(4, '0');
      await t.query(
        `INSERT INTO tickets (id, subject, customer_name, customer_email, customer_token, priority, status, related_ticket_id,
           created_at, cycle_start_at, paused_minutes, reopen_count, version, updated_at)
         VALUES (?,?,?,?,?,?,'open',?,?,?,0,0,1,?)`,
        [id, f.subject, f.name, f.email, token, priority, related, iso(now), iso(now), iso(now)]
      );
      const mid = uid();
      await t.query('INSERT INTO messages (id, ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?,?)', [
        mid, id, 'customer', null, f.name, f.body, iso(now),
      ]);
      await this._audit(t, id, { kind: 'customer', id: null, name: f.name }, 'ticket.created', { priority, relatedTicketId: related, messageId: mid }, now);
      return { ticketId: id, token };
    });
  }

  async _byToken(t, token) {
    const r = (await t.query('SELECT id FROM tickets WHERE customer_token = ?', [String(token || '')])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'Ticket not found');
    return this._lock(t, r.id);
  }

  async customerView(token) {
    await this.sweep();
    return this.db.tx(async (t) => {
      const m = await this._byToken(t, token);
      // Only the public `messages` table is read. Internal notes are never queried on this path.
      const msgs = (await t.query('SELECT id, author_kind, author_name, body, created_at FROM messages WHERE ticket_id = ? ORDER BY created_at, id', [m.id])).rows;
      const now = this.now();
      const label = { open: 'We are working on it', waiting_on_customer: 'Waiting for your reply', resolved: 'Marked as done', closed: 'Closed' }[m.status];
      const reopenUntil = m.status === 'resolved' ? this.cal.addWorkingMinutes(m.resolvedAt, WEEK_MIN) : null;
      return {
        id: m.id,
        subject: m.subject,
        status: m.status,
        statusLabel: label,
        createdAt: iso(m.createdAt),
        canReply: m.status === 'open' || m.status === 'waiting_on_customer' || (m.status === 'resolved' && now <= reopenUntil),
        reopensTicket: m.status === 'resolved',
        reopenUntil: reopenUntil ? iso(reopenUntil) : null,
        messages: msgs.map((x) => ({ id: x.id, from: x.author_kind, name: x.author_name, body: x.body, at: x.created_at })),
      };
    });
  }

  async customerExport(token) {
    const v = await this.customerView(token);
    const lines = [`Ticket ${v.id}: ${v.subject}`, `Status: ${v.statusLabel}`, ''];
    for (const m of v.messages) lines.push(`[${m.at}] ${m.name}:`, m.body, '');
    return lines.join('\n');
  }

  async customerReply(token, body) {
    await this.loadHolidays();
    const text = clean(body, 10000, 'Message');
    const now = this.now();
    return this.db.tx(async (t) => {
      const m = await this._byToken(t, token);
      const actor = { kind: 'customer', id: null, name: m.customerName };
      if (m.status === 'closed') throw conflict('closed', 'This ticket was closed because we did not hear back. Please open a new ticket.');
      if (m.status === 'resolved') {
        if (now > this.cal.addWorkingMinutes(m.resolvedAt, WEEK_MIN)) {
          throw conflict('reopen_window_passed', 'This ticket was marked done more than a week ago. Please open a new ticket.');
        }
        await this._reopen(t, m, actor, now);
      }
      const mid = uid();
      await t.query('INSERT INTO messages (id, ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?,?)', [
        mid, m.id, 'customer', null, m.customerName, text, iso(now),
      ]);
      await this._audit(t, m.id, actor, 'message.public', { messageId: mid, from: 'customer' }, now);
      if (m.status === 'waiting_on_customer') {
        const total = this._resume(m, now);
        await this._save(t, m.id, now, { status: 'open', paused_at: null, paused_minutes: total });
        await this._audit(t, m.id, actor, 'clock.resumed', { waitedWorkingMinutes: Math.round(this.cal.workingMinutesBetween(m.pausedAt, now)) }, now);
      }
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- agent actions
  async _reopen(t, m, actor, now) {
    await this._save(t, m.id, now, {
      status: 'open',
      resolved_at: null,
      cycle_start_at: iso(now),
      paused_at: null,
      paused_minutes: 0,
      reopen_count: m.reopenCount + 1,
    });
    await this._audit(t, m.id, actor, 'ticket.reopened', { previousResolvedAt: iso(m.resolvedAt), reopenCount: m.reopenCount + 1 }, now);
  }

  async claim(agent, id) {
    const now = this.now();
    return this.db.tx(async (t) => {
      const m = await this._lock(t, id);
      if (m.assigneeId === agent.id && ACTIVE.includes(m.status)) return this._view(m, agent.name, now);
      if (!ACTIVE.includes(m.status)) throw conflict('not_claimable', 'This ticket is not open');
      if (m.assigneeId) {
        const who = await this._assigneeName(t, m.assigneeId);
        throw conflict('already_taken', `Already taken by ${who}`);
      }
      // belt and braces: the WHERE clause itself refuses a second taker
      const r = await t.query('UPDATE tickets SET assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND assignee_id IS NULL', [agent.id, iso(now), id]);
      if (r.rowCount !== 1) throw conflict('already_taken', 'Already taken by someone else');
      await this._audit(t, id, this._asAgent(agent), 'ticket.claimed', { waitedUnclaimedWorkingMinutes: Math.round(this.cal.workingMinutesBetween(m.cycleStartAt, now)) }, now);
      return this._view(await this._lock(t, id), agent.name, now);
    });
  }

  async release(agent, id) {
    const now = this.now();
    return this.db.tx(async (t) => {
      const m = await this._lock(t, id);
      if (m.assigneeId !== agent.id) throw new HttpError(403, 'not_assignee', 'Only the agent who took this ticket can release it');
      if (!ACTIVE.includes(m.status)) throw conflict('not_active', 'This ticket is not open');
      await t.query('UPDATE tickets SET assignee_id = NULL, version = version + 1, updated_at = ? WHERE id = ?', [iso(now), id]);
      await this._audit(t, id, this._asAgent(agent), 'ticket.released', {}, now);
      return this._view(await this._lock(t, id), null, now);
    });
  }

  _requireAssignee(m, agent, what) {
    if (!m.assigneeId) throw conflict('not_claimed', `Take this ticket first before you ${what}`);
    if (m.assigneeId !== agent.id) throw new HttpError(403, 'not_assignee', `This ticket belongs to another agent, so you cannot ${what}. You can still add an internal note.`);
  }

  async reply(agent, id, { body, awaitCustomer }) {
    await this.loadHolidays();
    const text = clean(body, 10000, 'Reply');
    const now = this.now();
    return this.db.tx(async (t) => {
      const m = await this._lock(t, id);
      if (!ACTIVE.includes(m.status)) throw conflict('not_active', 'This ticket is not open. Reopen it first.');
      this._requireAssignee(m, agent, 'reply');
      const actor = this._asAgent(agent);
      const mid = uid();
      await t.query('INSERT INTO messages (id, ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?,?)', [
        mid, id, 'agent', agent.id, agent.name, text, iso(now),
      ]);
      const fields = {};
      if (!m.firstResponseAt) fields.first_response_at = iso(now);
      await this._audit(t, id, actor, 'message.public', { messageId: mid, from: 'agent', firstResponse: !m.firstResponseAt }, now);
      if (awaitCustomer && !m.pausedAt) {
        fields.status = 'waiting_on_customer';
        fields.paused_at = iso(now);
        await this._audit(t, id, actor, 'clock.paused', { reason: 'waiting_on_customer' }, now);
      } else if (!awaitCustomer && m.pausedAt) {
        fields.status = 'open';
        fields.paused_at = null;
        fields.paused_minutes = this._resume(m, now);
        await this._audit(t, id, actor, 'clock.resumed', { reason: 'agent_not_waiting_any_more' }, now);
      }
      await this._save(t, id, now, fields);
      return this._view(await this._lock(t, id), agent.name, now);
    });
  }

  async note(agent, id, { body }) {
    const text = clean(body, 10000, 'Note');
    const now = this.now();
    return this.db.tx(async (t) => {
      await this._lock(t, id);
      const nid = uid();
      await t.query('INSERT INTO internal_notes (id, ticket_id, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?)', [
        nid, id, agent.id, agent.name, text, iso(now),
      ]);
      // the note text is deliberately NOT copied into the audit log
      await this._audit(t, id, this._asAgent(agent), 'note.internal', { noteId: nid }, now);
      return { ok: true };
    });
  }

  async resolve(agent, id, { body } = {}) {
    await this.loadHolidays();
    const now = this.now();
    return this.db.tx(async (t) => {
      const m = await this._lock(t, id);
      if (!ACTIVE.includes(m.status)) throw conflict('not_active', 'This ticket is not open');
      this._requireAssignee(m, agent, 'resolve it');
      const actor = this._asAgent(agent);
      const fields = { status: 'resolved', resolved_at: iso(now) };
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text && !m.firstResponseAt) throw bad('message_required', 'Write a message to the customer before resolving: nobody has replied to them yet');
      if (text) {
        const mid = uid();
        await t.query('INSERT INTO messages (id, ticket_id, author_kind, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?,?)', [
          mid, id, 'agent', agent.id, agent.name, clean(text, 10000, 'Message'), iso(now),
        ]);
        await this._audit(t, id, actor, 'message.public', { messageId: mid, from: 'agent', firstResponse: !m.firstResponseAt }, now);
        if (!m.firstResponseAt) fields.first_response_at = iso(now);
      }
      let pausedMinutes = m.pausedMinutes;
      if (m.pausedAt) {
        pausedMinutes = this._resume(m, now);
        fields.paused_at = null;
        fields.paused_minutes = pausedMinutes;
        await this._audit(t, id, actor, 'clock.resumed', { reason: 'resolved' }, now);
      }
      const after = this._sla({ ...m, status: 'resolved', resolvedAt: now, pausedAt: null, pausedMinutes, firstResponseAt: m.firstResponseAt || now }, now);
      await this._save(t, id, now, fields);
      await this._audit(t, id, actor, 'ticket.resolved', {
        late: after.resolution.late,
        dueAt: iso(after.resolution.dueAt),
        lateByWorkingMinutes: after.resolution.late ? Math.round(-after.resolution.minutesLeft) : 0,
        waitedOnCustomerWorkingMinutes: Math.round(pausedMinutes),
      }, now);
      return this._view(await this._lock(t, id), agent.name, now);
    });
  }

  async reopen(agent, id) {
    await this.loadHolidays();
    const now = this.now();
    return this.db.tx(async (t) => {
      const m = await this._lock(t, id);
      if (m.status !== 'resolved') throw conflict('not_resolved', 'Only a resolved ticket can be reopened');
      if (now > this.cal.addWorkingMinutes(m.resolvedAt, WEEK_MIN)) {
        throw conflict('reopen_window_passed', 'More than a week has passed. This must be a new ticket.');
      }
      await this._reopen(t, m, this._asAgent(agent), now);
      return this._view(await this._lock(t, id), await this._assigneeName(t, m.assigneeId), now);
    });
  }

  /**
   * Changing priority while a ticket is open (the question nobody could answer in the meeting).
   * Decision: deadlines are re-derived from the ORIGINAL start of the clock using the new priority,
   * keeping the time already spent waiting on the customer out of it. Nothing restarts, so an
   * urgent ticket that has already waited long is late immediately, and downgrading cannot hide a miss
   * that already happened for the first reply. Old and new deadlines are written to the audit log.
   */
  async setPriority(agent, id, priority, reason) {
    await this.loadHolidays();
    if (!PRIORITIES.includes(priority)) throw bad('invalid_input', 'priority must be high, medium or low');
    const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    const now = this.now();
    return this.db.tx(async (t) => {
      const m = await this._lock(t, id);
      if (!ACTIVE.includes(m.status)) throw conflict('not_active', 'Priority can only change while the ticket is open');
      if (m.priority === priority) return this._view(m, await this._assigneeName(t, m.assigneeId), now);
      const before = this._sla(m, now);
      const after = this._sla({ ...m, priority }, now);
      await this._save(t, id, now, { priority });
      await this._audit(t, id, this._asAgent(agent), 'priority.changed', {
        from: m.priority,
        to: priority,
        reason: why,
        firstReplyDue: { from: iso(before.first.dueAt), to: iso(after.first.dueAt) },
        fixDue: { from: iso(before.resolution.dueAt), to: iso(after.resolution.dueAt) },
        lateNow: after.late,
      }, now);
      return this._view(await this._lock(t, id), await this._assigneeName(t, m.assigneeId), now);
    });
  }

  /** Close tickets whose customer has not answered for one working week. */
  async sweep() {
    await this.loadHolidays();
    const now = this.now();
    const candidates = await this.db.tx(async (t) =>
      (await t.query("SELECT id FROM tickets WHERE status = 'waiting_on_customer' AND paused_at IS NOT NULL")).rows
    );
    let closed = 0;
    for (const c of candidates) {
      await this.db.tx(async (t) => {
        const m = await this._lock(t, c.id);
        if (m.status !== 'waiting_on_customer' || !m.pausedAt) return;
        const closeAt = this.cal.addWorkingMinutes(m.pausedAt, WEEK_MIN);
        if (now < closeAt) return;
        await this._save(t, m.id, now, { status: 'closed', closed_at: iso(now) });
        await this._audit(t, m.id, { kind: 'system', id: null, name: 'System' }, 'ticket.auto_closed', {
          reason: 'customer did not reply for one working week',
          waitingSince: iso(m.pausedAt),
          dueToCloseAt: iso(closeAt),
        }, now);
        closed++;
      });
    }
    return closed;
  }

  // ---------------------------------------------------------------- reading (agent)
  async list(agent, { view = 'mine' } = {}) {
    await this.sweep();
    const now = this.now();
    return this.db.tx(async (t) => {
      let where = "t.status IN ('open','waiting_on_customer')";
      const params = [];
      if (view === 'mine') { where += ' AND t.assignee_id = ?'; params.push(agent.id); }
      else if (view === 'unassigned') { where = "t.status = 'open' AND t.assignee_id IS NULL"; }
      else if (view === 'waiting') { where = "t.status = 'waiting_on_customer'"; }
      else if (view === 'done') { where = "t.status IN ('resolved','closed')"; }
      const rows = (await t.query(
        `SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id WHERE ${where} ORDER BY t.created_at DESC LIMIT 500`,
        params
      )).rows;
      let out = rows.map((r) => this._view(model(r), r.assignee_name, now));
      if (view === 'late') out = out.filter((v) => v.sla.state === 'late');
      const rank = { late: 0, due_soon: 1, on_track: 2, paused: 3, done_late: 4, done: 5 };
      const nextDue = (v) => (v.sla.first.doneAt ? Date.parse(v.sla.resolution.dueAt) : Date.parse(v.sla.first.dueAt));
      if (view === 'done') out.sort((a, b) => (b.resolvedAt || b.closedAt || '').localeCompare(a.resolvedAt || a.closedAt || ''));
      else out.sort((a, b) => rank[a.sla.state] - rank[b.sla.state] || nextDue(a) - nextDue(b));
      return out;
    });
  }

  async counts(agent) {
    const now = this.now();
    return this.db.tx(async (t) => {
      const rows = (await t.query("SELECT * FROM tickets WHERE status IN ('open','waiting_on_customer')")).rows.map(model);
      const c = { mine: 0, unassigned: 0, all: rows.length, late: 0, waiting: 0 };
      for (const m of rows) {
        if (m.assigneeId === agent.id) c.mine++;
        if (!m.assigneeId && m.status === 'open') c.unassigned++;
        if (m.status === 'waiting_on_customer') c.waiting++;
        if (this._sla(m, now).state === 'late') c.late++;
      }
      return c;
    });
  }

  async get(agent, id) {
    await this.sweep();
    const now = this.now();
    const out = await this.db.tx(async (t) => {
      const m = await this._lock(t, id);
      const msgs = (await t.query('SELECT id, author_kind, author_name, body, created_at FROM messages WHERE ticket_id = ?', [id])).rows;
      const notes = (await t.query('SELECT id, author_name, body, created_at FROM internal_notes WHERE ticket_id = ?', [id])).rows;
      const audit = (await t.query('SELECT seq, at, actor_kind, actor_name, type, details FROM audit_events WHERE ticket_id = ? ORDER BY seq', [id])).rows;
      const thread = [
        ...msgs.map((x) => ({ kind: 'public', id: x.id, from: x.author_kind, name: x.author_name, body: x.body, at: x.created_at })),
        ...notes.map((x) => ({ kind: 'internal', id: x.id, from: 'agent', name: x.author_name, body: x.body, at: x.created_at })),
      ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      return {
        ticket: this._view(m, await this._assigneeName(t, m.assigneeId), now),
        thread,
        audit: audit.map((x) => ({ seq: Number(x.seq), at: x.at, actorKind: x.actor_kind, actorName: x.actor_name, type: x.type, details: JSON.parse(x.details) })),
      };
    });
    out.auditCheck = await this.verifyAudit(id);
    return out;
  }

  // ---------------------------------------------------------------- reports
  /** "Which problems were late and why?" - the question managers could not answer last quarter. */
  async lateReport({ days = 30 } = {}) {
    await this.sweep();
    const now = this.now();
    const since = iso(now - days * 86400000);
    return this.db.tx(async (t) => {
      const rows = (await t.query('SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id WHERE t.created_at >= ? ORDER BY t.created_at DESC', [since])).rows;
      const claims = (await t.query("SELECT ticket_id, MIN(at) AS at, MIN(details) AS details FROM audit_events WHERE type = 'ticket.claimed' GROUP BY ticket_id")).rows;
      const claimBy = Object.fromEntries(claims.map((c) => [c.ticket_id, c]));
      const resolved = (await t.query("SELECT ticket_id, at, details FROM audit_events WHERE type = 'ticket.resolved' ORDER BY seq")).rows;
      const resolvedBy = {};
      for (const r of resolved) (resolvedBy[r.ticket_id] ||= []).push({ at: r.at, ...JSON.parse(r.details) });
      const items = [];
      const byPriority = { high: { total: 0, late: 0 }, medium: { total: 0, late: 0 }, low: { total: 0, late: 0 } };
      for (const r of rows) {
        const m = model(r);
        const sla = this._sla(m, now);
        byPriority[m.priority].total++;
        const reasons = [];
        if (sla.first.late) {
          const claimedAt = claimBy[m.id] ? Date.parse(claimBy[m.id].at) : null;
          reasons.push({
            kind: 'first_reply',
            lateByWorkingMinutes: Math.round(-sla.first.minutesLeft),
            note: claimedAt
              ? `Nobody took it for ${Math.round(this.cal.workingMinutesBetween(m.createdAt, claimedAt))} working minutes`
              : 'Still not taken by anyone',
          });
        }
        // earlier fix cycles that were late before the ticket was reopened
        const cycles = resolvedBy[m.id] || [];
        const history = m.status === 'resolved' ? cycles.slice(0, -1) : cycles;
        for (const c of history) {
          if (c.late) reasons.push({ kind: 'fix_earlier_cycle', lateByWorkingMinutes: c.lateByWorkingMinutes, note: `Fix was late before the ticket was reopened (waited on customer ${c.waitedOnCustomerWorkingMinutes} working min)` });
        }
        if (sla.resolution.late) {
          reasons.push({
            kind: 'fix',
            lateByWorkingMinutes: Math.round(-sla.resolution.minutesLeft),
            note: `Waited on customer ${Math.round(m.pausedMinutes)} working min (not counted against Arvo)`,
          });
        }
        if (reasons.length) {
          byPriority[m.priority].late++;
          items.push({ id: m.id, subject: m.subject, priority: m.priority, status: m.status, assigneeName: r.assignee_name, createdAt: iso(m.createdAt), reasons });
        }
      }
      const total = rows.length;
      return { days, total, late: items.length, lateRate: total ? items.length / total : 0, byPriority, items };
    });
  }

  // ---------------------------------------------------------------- holidays
  async listHolidays() {
    return this.db.tx(async (t) => (await t.query('SELECT day, name FROM holidays ORDER BY day')).rows);
  }
  async addHoliday(agent, day, name) {
    if (agent.role !== 'manager') throw new HttpError(403, 'forbidden', 'Only a manager can change holidays');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || isNaN(Date.parse(day))) throw bad('invalid_input', 'day must look like 2026-12-25');
    const nm = clean(name, 100, 'Name');
    await this.db.tx(async (t) => {
      await t.query('INSERT INTO holidays (day, name) VALUES (?,?) ON CONFLICT (day) DO UPDATE SET name = excluded.name', [day, nm]);
    });
    await this.loadHolidays(true);
  }
  async removeHoliday(agent, day) {
    if (agent.role !== 'manager') throw new HttpError(403, 'forbidden', 'Only a manager can change holidays');
    await this.db.tx(async (t) => {
      await t.query('DELETE FROM holidays WHERE day = ?', [String(day)]);
    });
    await this.loadHolidays(true);
  }
}

module.exports = { Frontdesk, HttpError };
