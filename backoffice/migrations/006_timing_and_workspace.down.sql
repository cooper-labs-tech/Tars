-- Reverses 006_timing_and_workspace.up.sql. It drops the timings and the turns' workspaces the installs sent;
-- every other value stays.
ALTER TABLE turns DROP COLUMN IF EXISTS survival_basis;
ALTER TABLE turns DROP COLUMN IF EXISTS reverted;
ALTER TABLE turns DROP COLUMN IF EXISTS survived_lines;
ALTER TABLE turns DROP COLUMN IF EXISTS changed_lines;
ALTER TABLE turns DROP COLUMN IF EXISTS lines_removed;
ALTER TABLE turns DROP COLUMN IF EXISTS lines_added;
ALTER TABLE turns DROP COLUMN IF EXISTS files_changed;
ALTER TABLE turns DROP COLUMN IF EXISTS end_tree;
ALTER TABLE turns DROP COLUMN IF EXISTS start_tree;
ALTER TABLE turns DROP COLUMN IF EXISTS end_head;
ALTER TABLE turns DROP COLUMN IF EXISTS start_head;
ALTER TABLE requests DROP COLUMN IF EXISTS upstream_ms;
ALTER TABLE requests DROP COLUMN IF EXISTS queue_ms;
ALTER TABLE requests DROP COLUMN IF EXISTS clock_offset_ms;
ALTER TABLE requests DROP COLUMN IF EXISTS rtt_ms;
ALTER TABLE sessions DROP COLUMN IF EXISTS clock_offset_ms;
ALTER TABLE sessions DROP COLUMN IF EXISTS rtt_median_ms;
