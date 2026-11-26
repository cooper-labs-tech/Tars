-- Reverses 002_request_side.up.sql. It drops the side marks the installs sent.
ALTER TABLE requests DROP COLUMN IF EXISTS side;
