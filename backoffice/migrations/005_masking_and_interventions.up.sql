-- The third trace wave (27/11): how a session's content was masked on the client (the masking's version and its
-- six counts), and what was done to each turn (an interruption, a restart, the next instruction's author kind and
-- delay, a correction, the later session that took its task). NULL when the uploading Tars did not send them; on
-- the rows they describe, so every delete of a session or an install takes them with it.
ALTER TABLE sessions ADD COLUMN masking_version text;
ALTER TABLE sessions ADD COLUMN mask_counts jsonb;
ALTER TABLE turns ADD COLUMN interventions jsonb;
