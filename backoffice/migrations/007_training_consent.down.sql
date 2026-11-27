-- Reverses 007_training_consent.up.sql. It drops the installs' consent values, the sessions' and the consent feed;
-- every other value stays.
DROP TABLE IF EXISTS install_consent_changes;
ALTER TABLE sessions DROP COLUMN IF EXISTS consent;
ALTER TABLE installs DROP COLUMN IF EXISTS consent_at;
ALTER TABLE installs DROP COLUMN IF EXISTS consent_training;
