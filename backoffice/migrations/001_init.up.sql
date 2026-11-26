-- The trace back-office, schema 1. Metadata only: content lives in the blob store on disk, by hash.
-- Every table an install writes is keyed by (install_id, ...) and cascades from installs, so
-- deleting an install deletes everything it sent in one statement.

CREATE SEQUENCE change_seq;  -- one increasing order for every change a reader can see

CREATE TABLE settings (
  k text PRIMARY KEY,
  v jsonb NOT NULL
);

CREATE TABLE installs (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  first_upload_at timestamptz,
  client_name text,
  client_version text,
  platform text,
  blocked_at timestamptz,
  max_stored_bytes bigint,            -- the operator's override of the default quota
  stored_bytes bigint NOT NULL DEFAULT 0
);

CREATE TABLE readers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE blobs (                  -- one row per distinct content, whoever sent it
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL,               -- decoded bytes
  stored_size bigint NOT NULL,        -- bytes on disk
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE install_blobs (          -- which install sent which content; answers "missing" per install
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  hash text NOT NULL REFERENCES blobs(hash),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, hash)
);
CREATE INDEX install_blobs_hash ON install_blobs (hash);

CREATE TABLE batches (
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  batch_id text NOT NULL,
  body_sha256 bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  counts jsonb NOT NULL,
  bytes bigint NOT NULL,              -- the decoded body, counted in the install's stored bytes while kept
  PRIMARY KEY (install_id, batch_id)
);

CREATE TABLE sessions (
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  agent_id text, project_key text,
  harness text NOT NULL, harness_version text, native_session_id text,
  endpoint_key text, endpoint_name text,
  model text NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz,
  final_status text NOT NULL,
  turn_count int NOT NULL, request_count int NOT NULL,
  tokens_in bigint NOT NULL, tokens_cached bigint NOT NULL, tokens_out bigint NOT NULL,
  mixed boolean NOT NULL DEFAULT false, unknown_turns int NOT NULL DEFAULT 0,
  outcome jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  changed_seq bigint NOT NULL,
  PRIMARY KEY (install_id, session_id)
);
CREATE UNIQUE INDEX sessions_changed ON sessions (changed_seq);
CREATE INDEX sessions_started ON sessions (started_at);
CREATE INDEX sessions_harness ON sessions (harness, started_at);
CREATE INDEX sessions_model ON sessions (model, started_at);
CREATE INDEX sessions_project ON sessions (install_id, project_key);
CREATE INDEX sessions_agent ON sessions (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX sessions_age ON sessions ((coalesce(ended_at, started_at)));

CREATE TABLE turns (
  install_id uuid NOT NULL,
  turn_id text NOT NULL,
  session_id text NOT NULL,
  turn_index int NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz, gap_before_ms bigint,
  request_count int NOT NULL, tool_call_count int NOT NULL, tool_error_count int NOT NULL,
  tool_ms bigint, model_ms bigint,
  tokens_in bigint NOT NULL, tokens_cached bigint NOT NULL, tokens_out bigint NOT NULL,
  final_status text, final_finish_reason text, author text, author_detail text,
  PRIMARY KEY (install_id, turn_id),
  FOREIGN KEY (install_id, session_id) REFERENCES sessions (install_id, session_id) ON DELETE CASCADE
);
CREATE INDEX turns_session ON turns (install_id, session_id, turn_index);

CREATE TABLE requests (
  install_id uuid NOT NULL,
  request_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  seq int NOT NULL,
  upstream_request_id text,
  surface text NOT NULL,
  model_requested text, model_served text,
  params jsonb, tools_hash text,
  started_at timestamptz NOT NULL, ttft_ms bigint, total_ms bigint,
  tokens_in bigint, tokens_cached bigint, tokens_out bigint,
  status int, error text, finish_reason text, streamed boolean,
  req_bytes bigint, resp_bytes bigint,
  PRIMARY KEY (install_id, request_id),
  FOREIGN KEY (install_id, session_id) REFERENCES sessions (install_id, session_id) ON DELETE CASCADE
);
CREATE INDEX requests_session ON requests (install_id, session_id, seq);
CREATE INDEX requests_upstream ON requests (upstream_request_id) WHERE upstream_request_id IS NOT NULL;
CREATE INDEX requests_tools ON requests (install_id, tools_hash) WHERE tools_hash IS NOT NULL;

CREATE TABLE request_messages (
  install_id uuid NOT NULL,
  request_id text NOT NULL,
  position int NOT NULL,
  hash text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('input', 'output')),
  PRIMARY KEY (install_id, request_id, position),
  FOREIGN KEY (install_id, request_id) REFERENCES requests (install_id, request_id) ON DELETE CASCADE
);
CREATE INDEX request_messages_hash ON request_messages (install_id, hash);

CREATE TABLE messages (               -- metadata of a message blob, per install
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  hash text NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL,
  size bigint NOT NULL,
  tool_call_count int, has_thinking boolean,
  PRIMARY KEY (install_id, hash)
);

CREATE TABLE tombstones (             -- what readers must delete: their feed of deletions
  seq bigint PRIMARY KEY,
  install_id uuid NOT NULL,           -- no foreign key: the install may be gone
  session_id text,                    -- null: every session of the install
  reason text NOT NULL CHECK (reason IN ('install_deleted', 'operator', 'retention')),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deletion_log (           -- the operator's record that a deletion happened; never content
  receipt text PRIMARY KEY,
  install_id uuid NOT NULL,
  reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  counts jsonb NOT NULL
);

CREATE TABLE admin_sessions (
  id_hash bytea PRIMARY KEY,
  csrf text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE registrations (          -- per source address, for the registration limit; address hashed
  addr_hash bytea NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registrations_at ON registrations (at);
CREATE INDEX registrations_addr ON registrations (addr_hash, at);
