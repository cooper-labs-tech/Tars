-- Reverses 001_init.up.sql. It drops every trace: run it on a database you mean to empty.
DROP TABLE IF EXISTS registrations;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS deletion_log;
DROP TABLE IF EXISTS tombstones;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS request_messages;
DROP TABLE IF EXISTS requests;
DROP TABLE IF EXISTS turns;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS batches;
DROP TABLE IF EXISTS install_blobs;
DROP TABLE IF EXISTS blobs;
DROP TABLE IF EXISTS readers;
DROP TABLE IF EXISTS installs;
DROP TABLE IF EXISTS settings;
DROP SEQUENCE IF EXISTS change_seq;
