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
| An install | `Authorization: Bearer tbi_...`, returned once by `POST /v1/installs` | `/v1/installs/me`, `/v1/sessions/*`, `/v1/blobs/*`, `/v1/batches/*`, and that install's data only |
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

An id in the path (a session's, a batch's, a session read's) is percent-decoded only once the request's token was
checked: a request without a valid token gets `401` whatever its path holds, and with one, an id that is no valid
percent-encoding (`%E0%A4%A`) gets `400 bad_id`, as an id outside its pattern does.

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
{ "client": { "name": "tars", "version": "2.0.7", "platform": "darwin" }, "consent": { "training": false } }
```

`consent` is optional: the install's training consent as it registers (§ 3, consent). Anything but
`{training: boolean}` is a `400`.

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

### `PUT /v1/installs/me/consent`

The install's current training consent, `{ "training": true | false }` and nothing else (`400` otherwise). Send it
whenever the user changes it, and again until it is answered: setting the same value twice is harmless.

`200 {"training": false, "at": 1763600000000}`.

- The value is kept on the install, and shows as `installConsent` on every read of its sessions (§ 6.2).
- Each call adds one change to the readers' consent feed (§ 6.6), so a reader learns of a change even when the
  install sends nothing after it. The value given at registration is a change too.
- Only the install's own token sets it.

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

### `DELETE /v1/sessions/{sessionId}`

Deletes one session the install sent: its session, turns and requests, the install's references to
the blobs its requests named that no other request of the install names (with their message
metadata), and the blobs no install references any more. Readers are told (§ 6.4, `install_deleted`
with the `sessionId`). Tars sends it for a session it sent and then deleted, by its user or by its own
retention. It answers once the deletion is committed:

```json
{ "deleted": { "sessions": 1, "turns": 3, "requests": 12, "blobs": 20, "storedBytes": 81920 },
  "deletedAt": 1763600000000, "receipt": "del_..." }
```

- Idempotent: a session the install does not hold (never sent, already deleted, or another
  install's) answers `200` with zero counts and no `receipt`, and tells readers nothing. The answer
  is the same either way, so an install learns nothing of another's sessions.
- A batch's record (its id, its body's hash and counts, no content) is let go by the 30-day sweep,
  as every batch's is.
- `400 bad_id` for an id outside the pattern above.

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
| `environment` | Environment | no | The machine and the system at the session's start, exact values (below). Sent again without it, a session keeps the one it had |
| `events` | array ≤ 10,000 | no | Power events during the session, `{ "at": ms, "kind": "sleep" \| "wake" \| "battery" \| "ac" }`, no other key. The list as a whole: a session sent with it replaces the list it had, sent without it keeps it |
| `start` | Start | no | What started the session (below). Sent again without it, a session keeps it |
| `lostDemand` | array ≤ 1,000 | no | Tasks that left the agent's queue never to start while the session ran: `{ "kind": "queue_drop", "ref": task ref, "queuedAt": ms, "at": ms, "reason": "cancelled" \| "taken_back" \| "dropped_with_stop" \| "queue_cleared" \| "agent_removed" \| "not_handed_again" }`, all required, no other key. The list as a whole, kept when absent |
| `lostDemandOmitted` | int ≥ 0 | no | How many lost tasks the client left out of `lostDemand`, past its own bound. Kept when absent |
| `maskingVersion` | string ≤ 40 | no | The version of the masking the client applied to the content before upload. Kept when absent |
| `maskCounts` | object | no | What that masking replaced, by type: exactly `SECRET`, `EMAIL`, `IP`, `PERSON`, `HOME` and `PHONE`, each an int ≥ 0, all required, no other key. Kept when absent |
| `consent` | `{ "training": bool }` | no | The training consent the session was recorded under, no other key. Kept when absent |
| `contextWindowGiven` | int 1,024 to 10,000,000 | no | The context window Tars gave the harness at launch. Kept when absent |
| `outputCapGiven` | int 1 to 10,000,000 | no | The output cap Tars gave it. Kept when absent |
| `autoCompaction` | `"on"` \| `"off"` | no | Whether the harness compacts its history on its own; absent when not measured. Kept when absent |
| `compactions` | array ≤ 1,000 | no | One per compaction, by time: `{ "at": ms, "kind": "compact" \| "summarize" \| "truncate", "before"?: int ≥ 0, "after"?: int ≥ 0, "requestId"?: id, "source": "harness" \| "wire" }`, no other key. The list as a whole: sent with it, a session's list is replaced; sent without it, kept |
| `compactionsOmitted` | int ≥ 1 | no | How many compactions the client left out of `compactions`, past the newest it keeps (Tars keeps 200). Kept when absent |
| `rttMedianMs` | ms, a number from 0 to 10^10 | no | The median round trip of the session's requests, from the endpoint's Server-Timing. Kept when absent |
| `clockOffsetMs` | ms, a number from -10^10 to 10^10 | no | The endpoint's clock against the client's, from the lowest round trip. Kept when absent |

A *task ref* is `t-` and 8 lowercase hex characters. Every kind below is one of a closed list, the client's own: anything else refuses the batch.

**Start.** An object of these keys and no other:

| Key | Type |
|---|---|
| `trigger` | required: `owner`, `task`, `channel`, `restart`, `start`, `wake`, `redelegation` or `unknown` |
| `via` | how it came, by kind, never who: `window`, `chat`, `api`, `telegram`, `slack`, `discord`, `hermes`, `relay`, `settings`, `asked` or `tars` |
| `taskRef` | task ref |
| `taskId`, `requesterAgentId` | string ≤ 200 |
| `redelegatedFrom` | string ≤ 64: the session that had this task before |
| `queuedAt`, `handedAt`, `firstRequestAt` | ms |
| `commit` | 40 or 64 lowercase hex |
| `branch` | string ≤ 4,096 characters. The server keeps at most its first 255 bytes, cut at a character's edge: a longer name is cut, never refused (Tars does not bound it, and git hosts refuse refs over 255 bytes) |

**Environment.** An object of these keys and no other; a key may be left out. Any other key (a serial number,
a host name, a user name) refuses the batch.

| Key | Type |
|---|---|
| `osName`, `osVersion`, `kernel`, `arch`, `machineModel`, `chip`, `tarsVersion`, `locale`, `timeZone` | string ≤ 200, or null when the client could not read it |
| `tarsArch` | string ≤ 40, the architecture Tars itself runs as, or null |
| `cpuCores` | integer 0 to 4096, or null |
| `ramBytes` | integer ≥ 0, or null |
| `utcOffsetMinutes` | integer -840 to 840, the time zone's offset at the session's start, or null |
| `onBattery` | bool, or null when the system does not say |

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
| `taskRef` | task ref | no | The task the turn's instruction came from. Sent again without it, a turn keeps it |
| `interventions` | object | no | What was done to the turn, each key optional, no other: `interrupted {at, by, during: "answer" \| "tools"}`, `restarted {at, by}`, `next {by, delaySec}` (the next instruction's author kind and its delay in seconds, a number ≥ 0), `corrected: true`, `redelegated {to: a session id ≤ 64, at}`. Each `by` is a kind from its closed list: `interrupted`: `esc`, `ctrl_c`, `cli`, `stop`, `remove`, `quit`, `sleep`; `restarted`: `restart`, `replace`; `next`: `user`, `orchestrator`, `agent`, `relay`, `tars`, `unknown`. Kept when absent |
| `startHead`, `endHead` | 40 or 64 lowercase hex | no | The commit the turn started from and ended on, as git names them |
| `startTree`, `endTree` | 40 or 64 lowercase hex | no | The tree hashes at the turn's start and end |
| `filesChanged`, `linesAdded`, `linesRemoved`, `changedLines`, `survivedLines` | int ≥ 0 | no | What the turn changed, and how many of its changed lines survive |
| `reverted` | bool | no | |
| `survivalBasis` | `session_end` \| `merged` \| `deleted` | no | What the survival was measured against. A session uploaded again after a merge or a deleted branch updates these; one sent without them keeps them |

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
| `liveSessions` | int 0 to 1,000,000 | no | How many sessions were live on the install when the request was sent. Sent again without it, a request keeps the count it had |
| `cancel` | object | no | A request cut before the endpoint answered: `{ "by", "cause", "at": ms, "deliveredBytes": int }`, all required, no other key, the cause one of its `by`'s: `harness`: `esc`, `ctrl_c`, `cli_interrupt`, `abandoned_while_held`, `unknown`; `tars`: `stop`, `restart`, `sleep`, `remove`, `quit`, `replace`; `proxy`: `hold_ceiling`; `endpoint`: `stream_cut`. Kept when absent |
| `rttMs` | ms, a number from -10^10 to 10^10 | no | The round trip, kept as measured: the endpoint's span can read longer than the client's (clock rates, whole ms), so it may be negative. Absent when the endpoint sends no Server-Timing, never 0. Kept when absent |
| `queueMs`, `upstreamMs` | ms, a number from 0 to 10^10 | no | The endpoint's queue and upstream times from its Server-Timing. Absent when it sends no such header, never 0. Kept when absent |
| `contextReset` | object | no | On the first request after its history was rewritten: `{ "kind": "compact" \| "summarize" \| "truncate" \| "new", "droppedTokens"?: int ≥ 1 }`, no other key. Kept when absent |
| `gap` | object | no | The time before the request, split: `{ "ms": int ≥ 0, "toolMs", "inputWaitMs", "harnessMs": int ≥ 0 or null, "heldMs": int ≥ 0, "inputBy"?: "user" \| "orchestrator" \| "agent" \| "relay" \| "tars" \| "unknown" }`, no other key. `ms` and `heldMs` are required. The parts' sum is not checked here. Kept when absent |
| `toolCalls` | array ≤ 64 | no | The request's tool calls: `{ "toolCallId": string ≤ 128, "exit": int or null, "ms": int ≥ 0 or null, "denied", "timedOut", "failed", "truncated": bool (all four required), "truncatedBytes"?: int ≥ 1 }`, no other key. Kept when absent |
| `toolCallsOmitted` | int ≥ 1 | no | How many tool calls past the 64 sent. Kept when absent |
| `clockOffsetMs` | ms, a number from -10^10 to 10^10 | no | |
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

The fields added after a client may have been built without them are always present when read, with `null` for
"the uploading Tars did not send it":

- every session, here and in § 6.1: `environment`, `events`, `start`, `lostDemand`, `lostDemandOmitted`,
  `maskingVersion`, `maskCounts`, `rttMedianMs`, `clockOffsetMs`, `consent`, `contextWindowGiven`, `outputCapGiven`,
  `autoCompaction`, `compactions` and `compactionsOmitted`, each as sent; and `installConsent`, the install's current training consent,
  `{ "training": bool, "at": ms }`, or `null` when it has never set one;
- every request, here and in § 6.5: `liveSessions`, `cancel`, `rttMs`, `clockOffsetMs`, `queueMs`, `upstreamMs`, `contextReset`, `gap`, `toolCalls` and `toolCallsOmitted`;
- every turn, here: `taskRef`, `interventions`, and its workspace (`startHead` to `survivalBasis`).

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
- Reasons: `install_deleted` (the install asked: every session, or the one named, § 3), `operator`
  (the operator deleted it), `retention`.
- Same cursor rules as § 6.1. A reader that keeps copies must read this feed and act on it.

### 6.5 `GET /v1/read/requests?upstreamRequestId=...`

The requests carrying that upstream request id (normally one), each with its `install`, `sessionId`
and `turnId`, for a reader that starts from its own request id.

### 6.6 `GET /v1/read/install-consent`

Every change of an install's training consent, oldest first:

```json
{ "changes": [ { "install": "...", "training": false, "at": 1763600000000 } ], "nextCursor": "...", "more": false }
```

- One change per `PUT /v1/installs/me/consent`, and one for the value given at registration.
- Same cursor rules as § 6.1. A reader that keeps sessions must read this feed: an install that turns training
  off and then sends nothing would otherwise never be seen, and its sessions already read would stay eligible.
- A deleted install's changes go with it; its deletion is in § 6.4.

## 7. What a client sends, and does not

The server stores what it is given, so privacy is decided on the client:

- **Projects:** a `projectKey`, never a path. Tars sends `HMAC-SHA256(installSecret, projectPath)`
  in hex, with a secret that never leaves the install. Paths hold user names and private folder
  names; a reader only needs to group sessions by project, which the key allows. The same project
  on two installs gets two unrelated keys.
- **Endpoints:** an `endpointKey` of the same kind, and a display name. Never a base URL or a key.
- **The machine:** a session's `environment` holds exact values (the model, the chip, the cores, the memory, the
  system, the locale, the time zone), and only the keys of § 5's table, so no serial number, host name or user
  name can come with them. The server keeps them on the session's own row: every deletion of the session or the
  install takes them, and the operator's deletion log and the server's log never hold them.
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
| 27/11/2026 | `environment` and `events` on a session (read back in §§ 6.1 and 6.2), `liveSessions` on a request (§§ 6.2 and 6.5), migration `003_session_environment` |
| 27/11/2026 | `start` and `lostDemand` on a session, `taskRef` on a turn, `cancel` on a request (read back the same way), migration `004_session_start` |
| 27/11/2026 | `maskingVersion` and `maskCounts` on a session, `interventions` on a turn (read back the same way), migration `005_masking_and_interventions` |
| 27/11/2026 | the timings (`rttMedianMs`, `clockOffsetMs` on a session; `rttMs`, `clockOffsetMs`, `queueMs`, `upstreamMs` on a request) and a turn's workspace, migration `006_timing_and_workspace` |
| 27/11/2026 | the training consent: `consent` on registration and on a session, `PUT /v1/installs/me/consent`, `installConsent` on session reads, the feed `GET /v1/read/install-consent` (§ 6.6), migration `007_training_consent` |
| 28/11/2026 | what the harness was given and its compactions on a session (`contextWindowGiven`, `outputCapGiven`, `autoCompaction`, `compactions`, `compactionsOmitted`); `contextReset`, `gap`, `toolCalls` and `toolCallsOmitted` on a request, migration `008_context_and_tool_calls` |
