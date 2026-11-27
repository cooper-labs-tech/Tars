-- Reverses 004_session_start.up.sql. It drops what started each session, the demand it lost and the requests'
-- cancels the installs sent; every other value stays.
ALTER TABLE requests DROP COLUMN IF EXISTS cancel;
ALTER TABLE sessions DROP COLUMN IF EXISTS lost_demand;
ALTER TABLE sessions DROP COLUMN IF EXISTS start;
