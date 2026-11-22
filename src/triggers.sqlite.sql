-- History can be added to but never edited or deleted (SQLite, local tests only).
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS messages_no_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'messages is append-only'); END;
CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'messages is append-only'); END;
CREATE TRIGGER IF NOT EXISTS internal_notes_no_update BEFORE UPDATE ON internal_notes
BEGIN SELECT RAISE(ABORT, 'internal_notes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS internal_notes_no_delete BEFORE DELETE ON internal_notes
BEGIN SELECT RAISE(ABORT, 'internal_notes is append-only'); END;
