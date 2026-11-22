'use strict';
/**
 * Working-time calendar + SLA rules.
 *
 * Rules taken from Meera's notes (Section 3):
 *  - Working hours: 09:30-18:30, Monday-Friday, no weekends, no festival holidays.
 *    Timezone is fixed (Asia/Kolkata, UTC+05:30, no DST).
 *  - HIGH   (customer cannot work at all): reply in 2 working hours, fix the same working day.
 *  - MEDIUM:                               reply in half a working day, fix in 3 working days.
 *  - LOW    (questions, small requests):   reply in 1 working day,  finish in 1 working week.
 *  - Waiting for the customer stops the fix clock (see service.js for pause / resume).
 *  - One working week = 5 working days (used for auto-close and the reopen window).
 */

const MIN = 60000;
const DAY_MS = 86400000;
const DAY_START_MIN = 9 * 60 + 30;
const DAY_END_MIN = 18 * 60 + 30;
const WORK_DAY_MIN = DAY_END_MIN - DAY_START_MIN; // 540
const WEEK_MIN = 5 * WORK_DAY_MIN; // 2700
const IST_OFFSET_MIN = 330;

const SLA = {
  high: { reply: { minutes: 120 }, resolve: { endOfDay: true } },
  medium: { reply: { minutes: WORK_DAY_MIN / 2 }, resolve: { minutes: 3 * WORK_DAY_MIN } },
  low: { reply: { minutes: WORK_DAY_MIN }, resolve: { minutes: WEEK_MIN } },
};

class WorkCalendar {
  constructor(holidays = [], offsetMin = IST_OFFSET_MIN) {
    this.offset = offsetMin * MIN;
    this.holidays = new Set(holidays);
  }
  setHolidays(list) {
    this.holidays = new Set(list);
  }
  _dayStart(t) {
    return Math.floor((t + this.offset) / DAY_MS) * DAY_MS - this.offset;
  }
  _dayKey(dayStart) {
    return new Date(dayStart + this.offset).toISOString().slice(0, 10);
  }
  _isWorkingDay(dayStart) {
    const dow = new Date(dayStart + this.offset).getUTCDay();
    if (dow === 0 || dow === 6) return false;
    return !this.holidays.has(this._dayKey(dayStart));
  }
  /** t if t is inside working time, otherwise the next moment working time begins. */
  nextWorkingStart(t) {
    let ds = this._dayStart(t);
    for (let i = 0; i < 5000; i++) {
      if (this._isWorkingDay(ds)) {
        const s = ds + DAY_START_MIN * MIN;
        const e = ds + DAY_END_MIN * MIN;
        if (t < s) return s;
        if (t < e) return t;
      }
      ds += DAY_MS;
      t = ds;
    }
    throw new Error('no working day found (check holidays)');
  }
  /** Moment t + m working minutes. m <= 0 returns t unchanged. */
  addWorkingMinutes(t, m) {
    if (m <= 0) return t;
    let cur = this.nextWorkingStart(t);
    let remaining = m;
    for (let i = 0; i < 20000; i++) {
      const end = this._dayStart(cur) + DAY_END_MIN * MIN;
      const avail = (end - cur) / MIN;
      if (remaining <= avail) return Math.round(cur + remaining * MIN);
      remaining -= avail;
      cur = this.nextWorkingStart(end);
    }
    throw new Error('addWorkingMinutes overflow');
  }
  /** 18:30 of the working day that t falls in (or the next working day if t is outside working time). */
  endOfWorkingDay(t) {
    const cur = this.nextWorkingStart(t);
    return this._dayStart(cur) + DAY_END_MIN * MIN;
  }
  workingMinutesBetween(a, b) {
    if (!(b > a)) return 0;
    let ds = this._dayStart(a);
    let total = 0;
    while (ds < b) {
      if (this._isWorkingDay(ds)) {
        const lo = Math.max(a, ds + DAY_START_MIN * MIN);
        const hi = Math.min(b, ds + DAY_END_MIN * MIN);
        if (hi > lo) total += (hi - lo) / MIN;
      }
      ds += DAY_MS;
    }
    return Math.round(total * 1000) / 1000;
  }
}

function dueFrom(cal, start, spec, extraMinutes = 0) {
  if (spec.endOfDay) return cal.addWorkingMinutes(cal.endOfWorkingDay(start), extraMinutes);
  return cal.addWorkingMinutes(start, spec.minutes + extraMinutes);
}

function clockResult(cal, dueAt, doneAt, now) {
  const end = doneAt != null ? doneAt : now;
  const late = end > dueAt;
  const minutesLeft = late ? -cal.workingMinutesBetween(dueAt, end) : cal.workingMinutesBetween(end, dueAt);
  return { dueAt, doneAt: doneAt != null ? doneAt : null, late, minutesLeft };
}

/**
 * t: { priority, status, createdAt, cycleStartAt, firstResponseAt, pausedAt, pausedMinutes, resolvedAt }  (all ms)
 * Deadlines are always derived from these facts, never stored, so they cannot drift.
 */
function computeSla(cal, t, now) {
  const spec = SLA[t.priority];
  const first = clockResult(cal, dueFrom(cal, t.createdAt, spec.reply), t.firstResponseAt, now);

  const closed = t.status === 'closed';
  const livePause = t.pausedAt != null && t.resolvedAt == null && !closed;
  const extra = (t.pausedMinutes || 0) + (livePause ? cal.workingMinutesBetween(t.pausedAt, now) : 0);
  const resDue = dueFrom(cal, t.cycleStartAt, spec.resolve, extra);
  let resEnd = null;
  if (t.resolvedAt != null) resEnd = t.resolvedAt;
  else if (closed) resEnd = t.pausedAt != null ? t.pausedAt : now;
  const resolution = clockResult(cal, resDue, resEnd, now);

  const done = t.resolvedAt != null || closed;
  let state;
  if (done) state = first.late || resolution.late ? 'done_late' : 'done';
  else if (first.late && t.firstResponseAt == null) state = 'late';
  else if (resolution.late) state = 'late';
  else if (t.pausedAt != null) state = 'paused';
  else {
    const left = t.firstResponseAt == null ? first.minutesLeft : resolution.minutesLeft;
    state = left <= 120 ? 'due_soon' : 'on_track';
  }
  return { first, resolution, state, late: first.late || resolution.late };
}

module.exports = {
  WorkCalendar,
  SLA,
  computeSla,
  dueFrom,
  MIN,
  WORK_DAY_MIN,
  WEEK_MIN,
  IST_OFFSET_MIN,
};
