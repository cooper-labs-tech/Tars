-- Reverses 008_context_and_tool_calls.up.sql. It drops what the harnesses were given, their compactions, and the
-- requests' resets, gaps and tool calls the installs sent; every other value stays.
ALTER TABLE requests DROP COLUMN IF EXISTS tool_calls_omitted;
ALTER TABLE requests DROP COLUMN IF EXISTS tool_calls;
ALTER TABLE requests DROP COLUMN IF EXISTS gap;
ALTER TABLE requests DROP COLUMN IF EXISTS context_reset;
ALTER TABLE sessions DROP COLUMN IF EXISTS compactions;
ALTER TABLE sessions DROP COLUMN IF EXISTS auto_compaction;
ALTER TABLE sessions DROP COLUMN IF EXISTS output_cap_given;
ALTER TABLE sessions DROP COLUMN IF EXISTS context_window_given;
