-- History can be added to but never edited or deleted (PostgreSQL).
CREATE OR REPLACE FUNCTION fd_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fd_forbid_change();

DROP TRIGGER IF EXISTS messages_immutable ON messages;
CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION fd_forbid_change();

DROP TRIGGER IF EXISTS internal_notes_immutable ON internal_notes;
CREATE TRIGGER internal_notes_immutable BEFORE UPDATE OR DELETE ON internal_notes
  FOR EACH ROW EXECUTE FUNCTION fd_forbid_change();
