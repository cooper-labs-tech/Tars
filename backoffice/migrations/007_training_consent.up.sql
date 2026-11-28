-- The training consent (27/11): each install's current value on its record, the value each session was recorded
-- under on the session, and a feed of every change for the readers, numbered from the same change sequence as the
-- deletions (never reused), whose rows go with their install.
ALTER TABLE installs ADD COLUMN consent_training boolean;
ALTER TABLE installs ADD COLUMN consent_at timestamptz;
ALTER TABLE sessions ADD COLUMN consent jsonb;
CREATE TABLE install_consent_changes (
  seq bigint PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  training boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX install_consent_changes_install ON install_consent_changes (install_id);
