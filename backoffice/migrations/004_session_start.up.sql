-- The second trace wave (27/11): what started a session (its trigger by kind, its task's queue times, the commit it
-- started from), the tasks that left its agent's queue never to start, and, on a request, who cut it and why. All
-- three are NULL when the uploading Tars did not send them, and sit on the rows they describe, so every delete of a
-- session or an install takes them with it.
ALTER TABLE sessions ADD COLUMN start jsonb;
ALTER TABLE sessions ADD COLUMN lost_demand jsonb;
ALTER TABLE requests ADD COLUMN cancel jsonb;
-- The task a turn's instruction came from, by its ref (t- and 8 hex).
ALTER TABLE turns ADD COLUMN task_ref text;
