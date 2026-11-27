-- The fourth trace wave (27/11): the timings the endpoint's Server-Timing gave (a request's round trip, clock offset,
-- queue and upstream time, in milliseconds, fractional; a session's median round trip and its offset), and what a
-- turn changed in the repository (the heads and trees, the counts, the survival of its lines, which a later
-- upload updates). NULL when the uploading Tars did not send them, never 0; on the rows they describe.
ALTER TABLE sessions ADD COLUMN rtt_median_ms double precision;
ALTER TABLE sessions ADD COLUMN clock_offset_ms double precision;
ALTER TABLE requests ADD COLUMN rtt_ms double precision;
ALTER TABLE requests ADD COLUMN clock_offset_ms double precision;
ALTER TABLE requests ADD COLUMN queue_ms double precision;
ALTER TABLE requests ADD COLUMN upstream_ms double precision;
ALTER TABLE turns ADD COLUMN start_head text;
ALTER TABLE turns ADD COLUMN end_head text;
ALTER TABLE turns ADD COLUMN start_tree text;
ALTER TABLE turns ADD COLUMN end_tree text;
ALTER TABLE turns ADD COLUMN files_changed int;
ALTER TABLE turns ADD COLUMN lines_added int;
ALTER TABLE turns ADD COLUMN lines_removed int;
ALTER TABLE turns ADD COLUMN changed_lines int;
ALTER TABLE turns ADD COLUMN survived_lines int;
ALTER TABLE turns ADD COLUMN reverted boolean;
ALTER TABLE turns ADD COLUMN survival_basis text;
