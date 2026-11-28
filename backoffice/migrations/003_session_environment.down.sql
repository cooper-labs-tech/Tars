-- Reverses 003_session_environment.up.sql. It drops the environments, the power events and the live counts the
-- installs sent; every other value stays.
ALTER TABLE requests DROP COLUMN IF EXISTS live_sessions;
ALTER TABLE sessions DROP COLUMN IF EXISTS events;
ALTER TABLE sessions DROP COLUMN IF EXISTS environment;
