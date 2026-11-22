-- Frontdesk schema. Written to run unchanged on PostgreSQL and SQLite (SQLite is used for local tests only).
-- Timestamps are ISO-8601 UTC strings (YYYY-MM-DDTHH:MM:SS.sssZ): they sort correctly as text.

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'manager')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  day  TEXT PRIMARY KEY,           -- YYYY-MM-DD, India time
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id                TEXT PRIMARY KEY,                 -- FD-0001
  subject           TEXT NOT NULL,
  customer_name     TEXT NOT NULL,
  customer_email    TEXT NOT NULL,
  customer_token    TEXT NOT NULL UNIQUE,             -- secret link for the customer
  priority          TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  status            TEXT NOT NULL CHECK (status IN ('open', 'waiting_on_customer', 'resolved', 'closed')),
  assignee_id       TEXT REFERENCES agents(id),
  related_ticket_id TEXT,
  created_at        TEXT NOT NULL,
  cycle_start_at    TEXT NOT NULL,                    -- start of the current fix cycle (created, or last reopen)
  first_response_at TEXT,
  paused_at         TEXT,                             -- set while waiting on the customer
  paused_minutes    DOUBLE PRECISION NOT NULL DEFAULT 0, -- working minutes already spent waiting on the customer in this cycle
  resolved_at       TEXT,
  closed_at         TEXT,
  reopen_count      INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets(assignee_id);

-- Public conversation (the customer can see all of this).
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('customer', 'agent')),
  author_id   TEXT,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ticket_idx ON messages(ticket_id);

-- Private team notes live in their OWN table. Every customer-facing query reads only `messages`,
-- so a private note cannot leak by accident (INC-0304).
CREATE TABLE IF NOT EXISTS internal_notes (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  author_id   TEXT NOT NULL REFERENCES agents(id),
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_ticket_idx ON internal_notes(ticket_id);

-- Append-only, hash-chained history of everything that happens to a ticket (INC-0318).
CREATE TABLE IF NOT EXISTS audit_events (
  ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  seq        INTEGER NOT NULL,
  at         TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'customer', 'system')),
  actor_id   TEXT,
  actor_name TEXT NOT NULL,
  type       TEXT NOT NULL,
  details    TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  PRIMARY KEY (ticket_id, seq)
);
CREATE INDEX IF NOT EXISTS audit_type_idx ON audit_events(type);
