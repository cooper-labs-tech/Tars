-- The first trace wave (27/11): a session's environment (the machine and the system at its start, exact values, the
-- keys batch.ts allows and no other) and its power events, and each request's count of sessions live when it
-- was sent. All three are NULL when the uploading Tars did not send them: never guessed, never defaulted.
-- They sit on the rows they describe, so every delete of a session or an install takes them with it.
ALTER TABLE sessions ADD COLUMN environment jsonb;
ALTER TABLE sessions ADD COLUMN events jsonb;
ALTER TABLE requests ADD COLUMN live_sessions int;
