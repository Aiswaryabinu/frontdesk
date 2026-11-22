# Short note: what I did not finish, and why

**Not finished**

1. **Not deployed and not pushed to a repository.** I had no network access or hosting account in the environment where I built this, so there is no live URL yet. The README has the exact Render steps (about 10 minutes).
2. **Not run against PostgreSQL.** There was no Postgres server or `pg` driver available. All 17 automated tests ran on SQLite through the same SQL. The Postgres adapter (`src/db.js`), schema and triggers (`src/triggers.pg.sql`) are written but untested. First thing to do after deploying: open a ticket, take it, reply, resolve it, and check `/healthz` and the History panel.
3. **Festival holidays are placeholders.** I do not know Arvo's holiday list. Only 25 Dec 2026 and 26 Jan 2027 are seeded. Meera (manager account) adds the real dates through `PUT /api/holidays`. There is no screen for it yet.
4. **No lunch break, no per-agent shifts, no email sending.** Working time is 09:30-18:30 straight through. Customers write through their private link page; nothing is emailed.
5. **Rough edges in the UI:** Resolve and priority changes use the browser's built-in prompt box; no pagination beyond 500 tickets; no rate limiting on the public form.

**Decisions I made because the story did not say** (all listed in the README under "Rules I found")

- Priority change in the middle: deadlines are recalculated from the start of the ticket, not restarted. Questions the meeting left open are answered once, in code, and written to the history.
- "Half a day" = 4.5 working hours, "a week" = 5 working days.
- Only the agent who owns a ticket can reply to the customer. This is what stops INC-0291 from happening again.
