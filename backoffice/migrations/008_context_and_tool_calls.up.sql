-- C1 and C2 (28/11): what the harness was given at launch (its context window, its output cap, whether it compacts
-- on its own) and its compactions, on the session; and on each request, how its history was reset, the time before
-- it split into its parts, and its tool calls (at most 64, the rest counted). NULL when the uploading Tars did not
-- send them; on the rows they describe, so every delete of a session or an install takes them with it.
ALTER TABLE sessions ADD COLUMN context_window_given int;
ALTER TABLE sessions ADD COLUMN output_cap_given int;
ALTER TABLE sessions ADD COLUMN auto_compaction text;
ALTER TABLE sessions ADD COLUMN compactions jsonb;
ALTER TABLE requests ADD COLUMN context_reset jsonb;
ALTER TABLE requests ADD COLUMN gap jsonb;
ALTER TABLE requests ADD COLUMN tool_calls jsonb;
ALTER TABLE requests ADD COLUMN tool_calls_omitted int;
