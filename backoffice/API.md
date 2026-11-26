# Trace back-office: HTTP API, v1

The back-office is a small server anyone can host. A Tars install whose user opted in uploads its
agent traces to it, and readers the operator trusts read them back with a token the operator issued.
Nothing here names or assumes one reader: every field a reader may need to join traces with its own
records (an upstream request id, the session and agent ids) is a generic, optional field.

- Base URL: the instance's own, for example `https://traces.example.com`. Every path below starts
  with `/v1`.
- Bodies are JSON (`Content-Type: application/json`) unless said otherwise, UTF-8.
- A request body may be compressed with `Content-Encoding: gzip` or `Content-Encoding: zstd`.
- Times are integers, milliseconds since the Unix epoch, UTC.
- Hashes are SHA-256, 64 lowercase hex characters.
- Ids sent by an install (`sessionId`, `turnId`, `requestId`, `batchId`) match
  `^[A-Za-z0-9._:-]{1,128}$`.

## 1. Authentication

| Who | Credential | Opens |
|---|---|---|
| An install | `Authorization: Bearer tbi_...`, returned once by `POST /v1/installs` | `/v1/installs/me`, `/v1/blobs/*`, `/v1/batches/*`, and that install's data only |
| A reader | `Authorization: Bearer tbr_...`, issued by the operator in the back-office pages, shown once | `/v1/read/*`, read only |
| The operator | the back-office login (and Cloudflare Access in front, when configured) | `/admin/*` |

- A token opens only its own prefix. An install token on `/v1/read/*` and a reader token on any
  write get `401`.
- The server keeps only the SHA-256 of each token. A lost token cannot be shown again: the install
  registers anew, or the operator issues a new reader token.
- Revoked or unknown tokens get `401 {"error":"unauthorized"}`. A blocked install gets
  `403 {"error":"install_blocked"}`.

## 2. Errors and limits

Every error is `{"error": "<code>", "message"?: "<text>", ...}` with these statuses:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request`, `bad_json`, `bad_encoding`, `bad_id`, `bad_hash` | Malformed request |
| 401 | `unauthorized` | No token, an unknown or revoked one, or the wrong kind |
| 403 | `install_blocked`, `registration_closed` | The operator blocked the install, or registration is closed (it is, on a fresh deploy, until the operator opens it) |
| 404 | `not_found` | |
| 409 | `batch_conflict` | A `batchId` already applied with a different body |
| 413 | `too_large` | Body over the limit, before or after decompression |
| 422 | `hash_mismatch`, `unknown_session`, `invalid_batch` | The content does not match its hash, a row names a session the install never sent, or a field fails validation (`details` lists them) |
| 429 | `rate_limited`, `quota_exceeded` | Too many requests (`Retry-After` in seconds), or the install's stored bytes are at its quota |
| 503 | `unavailable` | The server is shutting down (`Retry-After`) |
| 507 | `disk_full` | The server is below its free-disk floor and takes no write, registrations included (`Retry-After`). Reads go on |

Default limits, each set by the operator (`GET /v1/installs/me` returns the ones that apply):

| Limit | Default |
|---|---|
| Requests per install | 120 per minute, bursts of 60 |
| Batch body | 8 MiB on the wire, 64 MiB decompressed |
| Blob | 16 MiB on the wire, 64 MiB decompressed |
| Stored bytes per install | 2 GiB (its blobs as stored, plus the batch bodies kept 30 days for replays) |
| Registrations | closed by default; once opened, 10 per hour per source address, 500 per hour in all |
| Free disk | writes stop under 5 GiB free on the blob disk (`507`) |

A client retries `429`, `503` and `507` after `Retry-After`, and retries network errors and other `5xx`
with backoff. Every write below is idempotent, so a retry never duplicates anything.

## 3. Register

### `POST /v1/installs` (no token)

```json
{ "client": { "name": "tars", "version": "2.0.7", "platform": "darwin" } }
```

`201`:

```json
{ "installId": "6f1c...-uuid", "token": "tbi_...", "limits": { ... }, "retentionDays": 90 }
```

- The token is returned once. Tars keeps it in `~/.tars-private`.
- This is the only write without a token. It is limited per source address and in all, and
  stays closed until the operator opens it (`403 registration_closed`): a fresh deploy takes no
  install. An install that has uploaded nothing 7 days
  after registering is removed.

### `GET /v1/installs/me`

```json
{
  "installId": "...", "createdAt": 1763500000000, "lastSeenAt": 1763590000000,
  "usage": { "storedBytes": 1048576, "sessions": 12, "requests": 340, "blobs": 512 },
  "limits": { "ratePerMinute": 120, "burst": 60, "maxBatchBytes": 8388608, "maxBatchDecodedBytes": 67108864,
              "maxBlobBytes": 16777216, "maxBlobDecodedBytes": 67108864, "maxStoredBytes": 2147483648 },
  "retentionDays": 90
}
```

### `DELETE /v1/installs/me`

Deletes everything the install sent (sessions, turns, requests, message metadata, its references to
blobs, and the blobs no other install references), revokes its token, and tells the readers (§ 6.4).
It answers only once the deletion is committed:

```json
{ "deleted": { "sessions": 12, "turns": 40, "requests": 340, "blobs": 512, "storedBytes": 1048576 },
  "deletedAt": 1763600000000, "receipt": "del_..." }
```

The `receipt` is kept in the operator's deletion log with the counts and the time, and never with
the content. Calling again with the same token gets `401`: the token went with the data.

## 4. Blobs: content, stored once

A blob is the exact bytes whose SHA-256 is its hash. For Tars: one message, as the canonical JSON the
client hashed, or one set of tool schemas. The server stores each blob once, and keeps a record of
which installs sent it.

### `POST /v1/blobs/missing`

```json
{ "hashes": ["<sha256>", "..."] }
```

At most 1,000 hashes. `200 {"missing": ["<sha256>", ...]}`: the ones this install has not sent yet.
The answer concerns this install only. Whether another install sent the same content is never
revealed.

### `PUT /v1/blobs/{hash}`

- Body: the blob's bytes, `Content-Type: application/octet-stream`, optionally compressed with
  `Content-Encoding: zstd` (preferred) or `gzip`.
- The server decompresses the body and checks that its SHA-256 equals `{hash}`. If it does not, it
  answers `422 hash_mismatch` and stores nothing.
- `201 {"stored": true, "size": 1234}` when this install had not sent it, `200 {"stored": false}`
  when it had. Sending a blob twice is harmless.
- It counts towards the install's stored bytes at its stored (compressed) size.

## 5. Batches: the metadata

### `PUT /v1/batches/{batchId}`

`batchId` is chosen by the client, unique per batch (a ULID is fine). The body:

```json
{
  "schema": 1,
  "sessions": [ Session, ... ],
  "turns": [ Turn, ... ],
  "requests": [ Request, ... ],
  "messages": [ Message, ... ]
}
```

Every array may be empty or absent. The batch is applied in one transaction, all or nothing.

- **Idempotent:** the same `batchId` with the same body (same SHA-256 once decompressed) answers
  `200` with `"replayed": true` and changes nothing. The same `batchId` with a different body is
  `409 batch_conflict`.
- **Rows are upserts** on their ids, scoped to the install. A session sent again replaces its
  earlier row (counters grow, `endedAt` arrives), and so do turns and requests. Uploads can resume
  from any batch, in any order, with one constraint: a turn or request must name a session the
  install has sent, in this batch or an earlier one (`422 unknown_session`).
- **Blobs may come before or after** the batch that names them. The answer lists the hashes the batch
  names that this install has not sent yet, so the client can send them:

```json
{ "batchId": "01J...", "replayed": false,
  "applied": { "sessions": 1, "turns": 3, "requests": 9, "messages": 21 },
  "missingBlobs": ["<sha256>", "..."] }
```

Recommended client loop: collect the hashes of the new rows, `POST /v1/blobs/missing`, `PUT` each
missing blob, then `PUT` the batch, and send any `missingBlobs` it reports.

### Session

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `sessionId` | id | yes | The trace session id. When the client sent it upstream as a session header, the same value |
| `agentId` | id | no | The agent's id, as the client sent it upstream, if it did |
| `projectKey` | hex ≤ 64 | no | An opaque key of the project, never its path (§ 7) |
| `harness` | string ≤ 40 | yes | The agent CLI: `codex`, `pi`, `qwen-code`, `opencode`, ... |
| `harnessVersion` | string ≤ 40 | no | |
| `nativeSessionId` | string ≤ 128 | no | The CLI's own session id |
| `endpointKey` | string ≤ 64 | no | An opaque key of the model endpoint the session used |
| `endpointName` | string ≤ 60 | no | |
| `model` | string ≤ 200 | yes | The model id as requested |
| `startedAt` | ms | yes | |
| `endedAt` | ms | no | Absent while the session is open |
| `finalStatus` | `open` `done` `failed` `abandoned` | yes | |
| `turnCount`, `requestCount` | int ≥ 0 | yes | |
| `tokensIn`, `tokensCached`, `tokensOut` | int ≥ 0 | yes | |
| `mixed` | bool | no | Text written by a model the client does not trace entered the session |
| `unknownTurns` | int ≥ 0 | no | Turns whose author the client could not attribute |
| `outcome` | object ≤ 16 KiB | no | Free-form evidence of how the session ended (task status, branch, head, tests, gates) |

### Turn

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `turnId` | id | yes | |
| `sessionId` | id | yes | |
| `index` | int ≥ 0 | yes | Unique per session |
| `startedAt` | ms | yes | |
| `endedAt` | ms | no | |
| `gapBeforeMs` | int ≥ 0 | no | |
| `requestCount`, `toolCallCount`, `toolErrorCount` | int ≥ 0 | yes | |
| `toolMs`, `modelMs` | int ≥ 0 | no | |
| `tokensIn`, `tokensCached`, `tokensOut` | int ≥ 0 | yes | |
| `finalStatus` | string ≤ 20 | no | |
| `finalFinishReason` | string ≤ 40 | no | |
| `author` | string ≤ 40 | no | `user`, `orchestrator`, `chat`, `relay`, `agent`, `tars`, `unknown` |
| `authorDetail` | string ≤ 128 | no | An agent or chat id; never a person's name |

### Request

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `requestId` | id | yes | The client's own id for the call |
| `sessionId`, `turnId` | id | yes | |
| `seq` | int ≥ 0 | yes | Order inside the session |
| `upstreamRequestId` | string ≤ 128 | no | The request id the model endpoint returned (an `X-Request-Id` header, for instance), for readers that join on it |
| `surface` | `openai_chat` `openai_responses` `anthropic_messages` `models` `other` | yes | The wire protocol |
| `modelRequested`, `modelServed` | string ≤ 200 | no | |
| `params` | object ≤ 16 KiB | no | temperature, top_p, max_tokens, tool names, reasoning |
| `toolsHash` | sha256 | no | The blob holding the tool schemas sent |
| `startedAt` | ms | yes | |
| `ttftMs`, `totalMs` | int ≥ 0 | no | |
| `tokensIn`, `tokensCached`, `tokensOut` | int ≥ 0 | no | |
| `status` | int | no | The HTTP status the endpoint answered |
| `error` | string ≤ 2,000 | no | |
| `finishReason` | string ≤ 40 | no | |
| `streamed` | bool | no | |
| `side` | bool | no | `true` for a harness's side request (a title request with no tools, a memory request with another system prompt), `false` for the agent's own loop. Leave it out when the client does not know. A request sent again without it keeps the mark it had |
| `reqBytes`, `respBytes` | int ≥ 0 | no | |
| `messages` | array ≤ 10,000 | yes | `{ "position": int, "hash": sha256, "direction": "input" \| "output" }`: what the request sent, in order, then what it produced |

### Message

Metadata of a message blob, sent once per hash (sending it again is harmless):

| Field | Type | Req. |
|---|---|---|
| `hash` | sha256 | yes |
| `role` | `system` `user` `assistant` `tool` `developer` | yes |
| `createdAt` | ms | yes |
| `size` | int ≥ 0 (bytes, uncompressed) | yes |
| `toolCallCount` | int ≥ 0 | no |
| `hasThinking` | bool | no |

Limits per batch: 1,000 sessions, 10,000 turns, 10,000 requests, 50,000 messages.

## 6. Reading (reader token)

### 6.1 `GET /v1/read/sessions`

Incremental by cursor: every write that adds or changes a session, or a turn or request of it, gives
the session a new place in a single increasing sequence. A reader that keeps `nextCursor` and calls
again gets every session that is new or grew since, each once per change, oldest change first.

| Query | Meaning |
|---|---|
| `cursor` | Opaque; absent for the start |
| `limit` | 1 to 500, default 100 |
| `harness`, `model` | Exact match |
| `install` | An install id |
| `project` | A `projectKey` |
| `agent` | An `agentId` |
| `from`, `to` | ms, on `startedAt`, `from` included, `to` excluded |

```json
{ "sessions": [ { "install": "...", "sessionId": "...", ...Session fields..., "receivedAt": 1763590000000 } ],
  "nextCursor": "...", "more": false }
```

`nextCursor` is returned even when the page is empty. Keep it: a filtered reader does not rescan.

### 6.2 `GET /v1/read/sessions/{install}/{sessionId}`

`200 {"session": Session, "turns": [Turn], "requests": [Request], "messages": [Message]}`, with
`requests` ordered by `seq`, and `messages` the metadata of every hash the requests name.

Every request read back, here and in § 6.5, carries `side`, always present:

- `true`: a side request;
- `false`: the agent's own loop;
- `null`: the uploading Tars did not say (one before the mark). A reader treats `null` as side,
  so a side request is never passed off as a main one. The server never turns a missing mark into
  `false`.

### 6.3 `GET /v1/read/blobs/{hash}`

- The blob's bytes, `Content-Type: application/octet-stream`, with its SHA-256 in `ETag`.
- With `Accept-Encoding: zstd`, the stored zstd bytes are sent as they are, `Content-Encoding: zstd`.
- `404` when no install that sent it still exists.

### 6.4 `GET /v1/read/deletions`

What was deleted, so a reader deletes its own copies:

```json
{ "deletions": [ { "install": "...", "sessionId": null, "reason": "install_deleted", "at": 1763600000000 },
                 { "install": "...", "sessionId": "...", "reason": "retention", "at": 1763600000000 } ],
  "nextCursor": "...", "more": false }
```

- `sessionId: null` means every session of the install.
- Reasons: `install_deleted` (the install asked), `operator` (the operator deleted it), `retention`.
- Same cursor rules as § 6.1. A reader that keeps copies must read this feed and act on it.

### 6.5 `GET /v1/read/requests?upstreamRequestId=...`

The requests carrying that upstream request id (normally one), each with its `install`, `sessionId`
and `turnId`, for a reader that starts from its own request id.

## 7. What a client sends, and does not

The server stores what it is given, so privacy is decided on the client:

- **Projects:** a `projectKey`, never a path. Tars sends `HMAC-SHA256(installSecret, projectPath)`
  in hex, with a secret that never leaves the install. Paths hold user names and private folder
  names; a reader only needs to group sessions by project, which the key allows. The same project
  on two installs gets two unrelated keys.
- **Endpoints:** an `endpointKey` of the same kind, and a display name. Never a base URL or a key.
- **Content:** message and tool blobs, after the client's own scrubbing of secrets.
- **Never:** API keys, tokens, environment variables, user names or email addresses as metadata,
  nor an agent's name (free text a person typed; the `agentId` is enough to join on, and a
  session that sends `agentName` is refused).

## 8. Versioning

`schema: 1` in a batch is this document. A later version adds a new number. The server accepts
the numbers it knows and refuses the others with `400 bad_request`. Unknown fields inside a known
schema are refused (`422 invalid_batch`), so a client mistake is seen at once rather than lost.

**Additive fields stay in v1.** A new optional field, such as a request's `side`, is added to
schema 1 and to `/v1` without a new number:

- an older client that leaves it out is still accepted, and its rows read back with the field's
  "unknown" value (`null` for `side`);
- a reader ignores fields it does not know, and finds every documented field on every read.

A new number is kept for changes that alter or remove what a field means. Because writes refuse
unknown fields, a client may send a new field only to a server that knows it: update the server
before the clients.

| Added | Field |
|---|---|
| 26/11/2026 | `side` on a request (§ 5, read back in §§ 6.2 and 6.5), migration `002_request_side` |
