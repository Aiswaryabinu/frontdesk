'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkCalendar, computeSla, dueFrom, SLA } = require('../src/sla');

// Dates are written in India time. 2026-11-23 is a Monday.
const ist = (s) => Date.parse(s.replace(' ', 'T') + ':00+05:30');
const show = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ');
const cal = new WorkCalendar(['2026-12-25']);

test('working minutes skip nights and weekends', () => {
  assert.equal(cal.workingMinutesBetween(ist('2026-11-23 09:30'), ist('2026-11-23 18:30')), 540);
  assert.equal(cal.workingMinutesBetween(ist('2026-11-27 18:00'), ist('2026-11-30 10:00')), 30 + 30);
  assert.equal(cal.workingMinutesBetween(ist('2026-11-28 10:00'), ist('2026-11-29 10:00')), 0);
});

test('Meera: a low ticket that arrives Friday 6 PM must NOT be late on Sunday morning', () => {
  const created = ist('2026-11-27 18:00'); // Friday
  const due = dueFrom(cal, created, SLA.low.reply);
  assert.equal(show(due), '2026-11-30 18:00'); // Monday evening
  const sla = computeSla(cal, { priority: 'low', status: 'open', createdAt: created, cycleStartAt: created, firstResponseAt: null, pausedAt: null, pausedMinutes: 0, resolvedAt: null }, ist('2026-11-29 09:00'));
  assert.equal(sla.late, false);
});

test('high priority: reply in 2 working hours, fix the same working day', () => {
  const mon10 = ist('2026-11-23 10:00');
  assert.equal(show(dueFrom(cal, mon10, SLA.high.reply)), '2026-11-23 12:00');
  assert.equal(show(dueFrom(cal, mon10, SLA.high.resolve)), '2026-11-23 18:30');
  // after hours -> next working day
  assert.equal(show(dueFrom(cal, ist('2026-11-23 19:00'), SLA.high.resolve)), '2026-11-24 18:30');
  // Saturday -> Monday
  assert.equal(show(dueFrom(cal, ist('2026-11-28 11:00'), SLA.high.resolve)), '2026-11-30 18:30');
  // 17:30 Friday: one hour left Friday, one hour Monday
  assert.equal(show(dueFrom(cal, ist('2026-11-27 17:30'), SLA.high.reply)), '2026-11-30 10:30');
});

test('medium: half a day to reply, three days to fix', () => {
  const mon10 = ist('2026-11-23 10:00');
  assert.equal(show(dueFrom(cal, mon10, SLA.medium.reply)), '2026-11-23 14:30');
  assert.equal(show(dueFrom(cal, mon10, SLA.medium.resolve)), '2026-11-26 10:00');
});

test('low: one day to reply, one working week to finish', () => {
  const mon10 = ist('2026-11-23 10:00');
  assert.equal(show(dueFrom(cal, mon10, SLA.low.reply)), '2026-11-24 10:00');
  assert.equal(show(dueFrom(cal, mon10, SLA.low.resolve)), '2026-11-30 10:00');
});

test('festival holidays are not working days', () => {
  // Thursday 24 Dec 18:00 + 1 working day: Friday 25 Dec is a holiday, so it lands on Monday
  assert.equal(show(dueFrom(cal, ist('2026-12-24 18:00'), SLA.low.reply)), '2026-12-28 18:00');
});

test('waiting on the customer does not count: paused working time moves the fix deadline', () => {
  const created = ist('2026-11-23 10:00');
  const base = { priority: 'medium', status: 'open', createdAt: created, cycleStartAt: created, firstResponseAt: ist('2026-11-23 11:00'), resolvedAt: null };
  // paused Monday 12:00 -> Wednesday 12:00 = 390 + 540 + 150 = 1080 working minutes
  const paused = cal.workingMinutesBetween(ist('2026-11-23 12:00'), ist('2026-11-25 12:00'));
  assert.equal(paused, 1080);
  const sla = computeSla(cal, { ...base, pausedAt: null, pausedMinutes: paused }, ist('2026-11-25 13:00'));
  assert.equal(show(sla.resolution.dueAt), '2026-11-30 10:00'); // Thursday 10:00 + 2 working days
  // still paused: never late because of waiting
  const live = computeSla(cal, { ...base, status: 'waiting_on_customer', pausedAt: ist('2026-11-23 12:00'), pausedMinutes: 0 }, ist('2026-12-02 10:00'));
  assert.equal(live.state, 'paused');
  assert.equal(live.late, false);
});

test('raising priority later makes an old ticket late straight away (nothing restarts)', () => {
  const created = ist('2026-11-23 10:00');
  const t = { priority: 'low', status: 'open', createdAt: created, cycleStartAt: created, firstResponseAt: ist('2026-11-23 10:30'), pausedAt: null, pausedMinutes: 0, resolvedAt: null };
  const now = ist('2026-11-24 12:00');
  assert.equal(computeSla(cal, t, now).late, false);
  assert.equal(computeSla(cal, { ...t, priority: 'high' }, now).late, true);
});
