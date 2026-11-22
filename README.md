# Frontdesk

Support ticket system for Arvo Systems: Node.js backend, PostgreSQL, one plain-JavaScript screen for agents, and a small page for customers. No build step. The only runtime dependency is `pg`.

Short note on what is unfinished: see [NOTE.md](NOTE.md).

## Run it locally

You need Node 22.13+ and a PostgreSQL database.

```bash
createdb frontdesk
export DATABASE_URL=postgres://localhost/frontdesk
npm install
npm start            # http://localhost:3000
```

Tables, triggers and the nine agent accounts are created on first start.

- Agents sign in at `/` with `<name>@arvo.test` and the password `frontdesk-demo` (change it with `SEED_PASSWORD` before the first start). Names: meera (support lead, can edit holidays), arjun, priya, rohan, anita, kiran, sana, vikram, divya.
- Customers use `/customer` to send a request. They get a private link to follow it.

Without `DATABASE_URL` the app falls back to SQLite so you can try it with zero setup (`SQLITE_PATH=file.sqlite` to keep data). That mode exists for the tests; use Postgres for anything real.

```bash
npm test             # 17 tests, no database server needed
```

## Exact local browser check

Use these steps to verify the application from start to finish on Windows PowerShell:

```powershell
cd C:\Users\LENOVO\frontdesk
npm install
$env:SQLITE_PATH = "frontdesk.sqlite"
npm start
```

Leave that terminal running. Open these URLs in a browser:

1. **Customer page:** http://localhost:3000/customer
2. Enter a name, email, subject, description, and priority, then submit the request.
3. Copy the private ticket link shown after submission, then open the agent page: http://localhost:3000/
4. Sign in with `meera@arvo.test` and `frontdesk-demo`.
5. Confirm the new ticket appears in the dashboard. Open it, claim it, add a private note, reply to the customer, and resolve it.
6. Open the private customer link again and confirm that the customer can see the public reply but not the private note.
7. Check http://localhost:3000/healthz. It should display `{"ok":true}`.

To run the automated checks separately:

```powershell
npm test
```

The dashboard initially shows zero tickets because it starts empty. Using
`$env:SQLITE_PATH = "frontdesk.sqlite"` keeps tickets between server restarts.

## Live deployed application

The application is deployed at:

- https://frontdesk-pnil.onrender.com/
- Customer page: https://frontdesk-pnil.onrender.com/customer
- Health check: https://frontdesk-pnil.onrender.com/healthz

### Check the complete workflow

1. Open the [customer page](https://frontdesk-pnil.onrender.com/customer).
2. Enter the customer's name and email, a subject, a description, and a priority.
3. Submit the request.
4. Copy the private ticket link that appears after submission. This link is where the customer can view replies and send a follow-up.
5. Open the [agent page](https://frontdesk-pnil.onrender.com/).
6. Sign in with `meera@arvo.test` and the password configured for `SEED_PASSWORD` on Render. If `SEED_PASSWORD` was not set, use `frontdesk-demo`.
7. Open the new ticket, claim it, add a private note, and send a public reply.
8. Open the customer's private ticket link. Confirm that the public reply is visible and the private note is not visible.
9. Resolve the ticket from the agent page. The customer link can also be used to reply to it and reopen it within the reopen window.

All nine agent accounts use `<name>@arvo.test`, for example `arjun@arvo.test`, and the same `SEED_PASSWORD`. Meera is the support lead and can manage holidays.

## Put it online (Render, free)

1. Push this folder to a GitHub repository.
2. Render: **New > PostgreSQL** (free). Copy its *Internal Database URL*.
3. Render: **New > Web Service**, pick the repository. Build command `npm install`, start command `npm start`.
4. Environment variables: `DATABASE_URL` = the URL from step 2, `SEED_PASSWORD` = a password you choose.
5. Open the service URL. Check `/healthz` says `{"ok":true}`.

If you use an external Postgres URL that needs TLS, also set `PGSSL=require`. Free Render services sleep when idle and free Postgres expires after a while: open the page before the reviewers do, and keep it running for the week.

## Rules I found in the story

Where the story was silent, I chose, and the choice is written here.

| Source | Rule in Frontdesk |
|---|---|
| Meera: "depends on how bad" | Three priorities. **High** = customer cannot work. **Medium** = something broken. **Low** = question or small request. The customer picks with plain words; an agent can change it. |
| High | Reply in 2 working hours. Fix the same working day (end of day 18:30; if it arrives after hours or on a weekend, the end of the next working day). |
| Medium | Reply in half a working day (4h 30m). Fix in 3 working days. |
| Low | Reply in 1 working day. Finish in 1 working week (5 working days). |
| "Working hours 9:30 to 6:30, Mon-Fri, no festival holidays" | Calendar in `src/sla.js`, fixed India time (UTC+05:30). A Low ticket arriving Friday 6 PM is due Monday 6 PM, so it is **not** late on Sunday (test included). Holidays are a table, editable by the manager. |
| "Waiting for the customer is not our fault" | Replying with "I am asking the customer a question" puts the ticket in *Waiting on customer* and pauses the fix clock. When the customer answers, the waited working time is added to the deadline. Shown on screen as *paused*. |
| "No reply for one working week, we close it" | Waiting for 5 working days closes the ticket automatically (history shows the system did it). The customer can always open a new ticket, linked to the old one. Closing is not counted as late. |
| "Reopen for about one week" | A resolved ticket reopens (by the customer replying, or by an agent) within 5 working days. After that it is refused and a new, linked ticket is needed. Reopening starts a new fix cycle; the earlier cycle's lateness stays in the history and the report. |
| "Agents see tickets on one screen, which are late, which are waiting" | The screen: filter chips (Mine, Unassigned, Late, Waiting on customer, All open, Done), late tickets first, each row shows its clock. Ticket view: reply to customer or private note. |
| "What happens to the timer if we change urgent in the middle?" (nobody knew) | **My decision:** deadlines are recalculated from the *original* start of the ticket using the new priority, keeping paused time out. Nothing restarts, so raising to High on an old ticket can make it late at once, and lowering cannot hide a first reply that was already missed. Old and new deadlines are recorded in the history with the reason. |
| INC-0291: two agents took the same ticket | Taking a ticket is a single atomic database step (row lock + `WHERE assignee_id IS NULL`); the second agent gets "Already taken by X". Only the owner can reply, resolve or release. Others may add private notes. |
| INC-0304: private note sent to the customer | Private notes are stored in their **own table** that no customer-facing query reads. The customer page, customer API and customer export only read the public `messages` table. The note text is also not copied into the history. A test checks the customer page, API and export for a planted note. |
| INC-0318: nobody could prove who replied when | Every action (created, taken, reply, note, priority, pause, resume, resolve, reopen, auto-close) is written in the same transaction as the change, with server time, who did it (taken from the login, never from the browser), and details. Database triggers refuse any UPDATE or DELETE on history, messages and notes. Each event is also hash-chained to the previous one, so a change made by someone with direct database access is detected; the History panel shows "verified" or a warning. |
| "Managers asked which problems were late and why" | **Late report** screen: per ticket, which clock was late, by how much, why (for example "Nobody took it for 300 working minutes", "waited on customer 540 min"). |

For a stronger guarantee in production, also run the app with a database user that has no UPDATE/DELETE right on `audit_events`, `messages` and `internal_notes`.

## Layout

```
src/sla.js       working-time calendar and deadline rules
src/service.js   all business rules and the audit log
src/db.js        Postgres adapter (and SQLite for tests)
src/server.js    HTTP routes and static files
src/schema.sql   tables      src/triggers.*.sql   append-only guards
public/          agent screen (index.html, app.js) and customer page
test/            SLA maths, the three incidents, pause/close/reopen, report
```

## API (agents send `Authorization: Bearer <token>` from `POST /api/login`)

`GET /api/tickets?view=mine|unassigned|late|waiting|all|done`, `GET /api/tickets/:id`, `POST /api/tickets/:id/{claim,release,reply,note,resolve,reopen,priority}`, `GET /api/reports/late?days=30`, `GET|PUT /api/holidays`, `DELETE /api/holidays/:day`.
Customers: `POST /api/public/tickets`, `GET /api/public/tickets/:token`, `POST /api/public/tickets/:token/reply`, `GET /api/public/tickets/:token/export`.
