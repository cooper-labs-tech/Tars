# Trace back-office

A small server anyone can host. Tars installs whose users opted in upload their agent traces to it,
and readers the operator trusts read them back. It is generic: no reader is named or assumed, and
any Tars user can point their Tars at their own instance.

- `API.md`: the HTTP API, for the uploader in Tars and for readers. Its § 8 lists the fields added to v1 since
  its first draft, with the migration that stores each. A Tars that sends a field this server does not know is
  refused (422), so the server is updated before the Tars that send new fields.
- `deploy/`: a systemd unit, an nginx site and a backup script for one Linux server behind Cloudflare.
- The runbook is in the repository's `OPERATIONS.md` ("Trace back-office"), the boundaries in
  `SECURITY.md` (§ 9).

## Choices, and why

| Choice | Why |
|---|---|
| **Node 22.18+, plain `node:http`, TypeScript run as is** (type stripping, no build) | The same runtime as the rest of Tars, one dependency (`pg`), nothing to compile on the server |
| **PostgreSQL for the metadata** | Many installs upload at once, so it needs concurrent writers, row-level deletes, transactions that cover a whole batch, and online backups (`pg_dump`). SQLite has one writer at a time |
| **Blobs in a folder on disk, by hash** | They are immutable and addressed by content, so a file is all they need. Out of the database, the dumps stay small and fast, and the folder is backed up incrementally because a file never changes. One server needs no object store. Moving to an S3-compatible store means rewriting `src/blobstore.ts` (four functions) |
| **Blobs stored once, owned per install** | Two installs that send the same content share one file, but "which blobs are missing" only answers about the asking install's own. Otherwise one install could test whether anyone had sent a given text. Deleting an install removes the files only it held |
| **Projects as opaque keys** | The client sends `HMAC(installSecret, projectPath)`, never the path. Paths hold user names and private folder names; a reader only needs to group by project. Endpoints likewise |
| **Every write is idempotent** | Batches carry a client-chosen id, rows are upserts, blobs are named by their hash. An upload cut anywhere resumes by sending again |
| **One ordered change sequence, under a lock** | Readers pull by cursor. Changes commit in the order of their numbers (`src/db.ts`), so a reader never misses one that committed late |
| **Deletions are a feed** | A reader that keeps copies reads `/v1/read/deletions` and deletes what an install withdrew (all of it, or one session) or retention removed |
| **The owner's pages behind two locks** | Cloudflare Access in front (identity, MFA, checked here too through its signed assertion), and the app's own password login. Either holds alone if the other fails |

## Run it locally

```bash
cd backoffice && npm ci
initdb -D /tmp/tbo-db -U postgres --auth=trust && pg_ctl -D /tmp/tbo-db -l /tmp/tbo-db.log start
export PGHOST=/tmp PGUSER=postgres PGDATABASE=postgres BACKOFFICE_DATA_DIR=/tmp/tbo-blobs
node src/cli.ts migrate up
export BACKOFFICE_OWNER_PASSWORD_HASH="$(printf 'a long password here' | node src/cli.ts hash-password)"
node src/server.ts        # http://127.0.0.1:8787, pages at /admin
```

## Configuration (environment)

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | `postgres://...`; else the standard `PG*` variables |
| `BACKOFFICE_DATA_DIR` | The blob folder (required) |
| `BACKOFFICE_LISTEN` | `host:port`, default `127.0.0.1:8787` |
| `BACKOFFICE_OWNER_PASSWORD_HASH` | From `node src/cli.ts hash-password`. Unset: the pages stay closed |
| `BACKOFFICE_PUBLIC_ORIGIN` | `https://traces.example.com`. The owner's forms must come from it; with https, the session cookie is `Secure` |
| `BACKOFFICE_TRUST_PROXY` | `1` behind the local nginx: the client address is its `X-Real-IP` |
| `BACKOFFICE_ACCESS_ISSUER`, `BACKOFFICE_ACCESS_AUDIENCE` | The Cloudflare Access team URL and the application's audience tag. Set: `/admin` also requires a valid Access assertion |
| `BACKOFFICE_RETENTION_SWEEP_MS` | How often retention runs, default hourly; `0` = only from the pages or the CLI |

## Tests

`npm test` runs the units and the E2E. The E2E starts a throwaway Postgres (`initdb` into a
temporary folder, a unix socket only, set `PG_BIN` if `initdb` is not found) and the real server,
drives them over HTTP, and leaves `.runs/<time>/asserted.json`, `server.log` and `reproduce.txt`.
