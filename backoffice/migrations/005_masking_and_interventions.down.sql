-- Reverses 005_masking_and_interventions.up.sql. It drops the masking versions and counts and the turns'
-- interventions the installs sent; every other value stays.
ALTER TABLE turns DROP COLUMN IF EXISTS interventions;
ALTER TABLE sessions DROP COLUMN IF EXISTS mask_counts;
ALTER TABLE sessions DROP COLUMN IF EXISTS masking_version;
