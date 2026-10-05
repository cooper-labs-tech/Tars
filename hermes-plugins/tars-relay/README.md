# tars-relay, a Hermes plugin

Tars writes to its user through the Telegram bot of his own Hermes, and gets back what he answers. The plugin
runs inside Hermes, on the server where Hermes runs, never in Tars.

- **Out.** Tars calls `POST /send` on the Hermes dashboard. The text goes, as written and in plain text, to the
  one Telegram user named in the plugin's settings on the server. Tars cannot name anybody else.
- **Back.** A message from that user in his private chat with the bot is kept for Tars when it replies to a
  message the relay sent (same chat, same message id) or starts with `@project` for one of the projects Tars
  registered (`POST /projects`). Tars reads them with `GET /replies`, with the store's id, and deletes what it took
  with `POST /ack`. Every other message goes to Hermes as usual, `@hermes what is the weather` included.
  - The plugin sees each message from its own observer, a python-telegram-bot handler in a group of its own (100),
    before Hermes merges messages or turns one into a correction of the answer it is giving: each is kept once, on
    its own, in order. The observer only looks: it never stops or changes an update, and Hermes's own observer
    (group 99) runs as before.
  - A message kept for Tars that Hermes admits on its own never reaches Hermes's model. One Hermes merged with other
    words of his, or took as a correction while it was answering, reaches the model too, as Hermes handed it; it
    reaches Tars all the same.
- **The model's copy.** Hermes's model gets a read-only copy of what Tars sent, attached once to the user's next
  turn in that same private chat and marked as Tars's, so that he can ask Hermes about it. Every line of it is
  quoted, cut at any line break and not only the line feed, and a control character in it is shown (`\x1b`) rather
  than passed on. The model can neither act on it nor answer it for him: an answer reaches Tars only when he replies
  on Telegram himself.

Why a plugin rather than the model: whoever relays the user's words decides where they go. A model can be talked
into "answering" in his name, by a PR title or an error message written for that. The plugin only moves real
Telegram messages from him.

## Install on the Hermes server

Install it together with the Tars release that reads it, and once Tars keeps the dashboard token in
`~/.tars-private` (SECURITY.md, section 5). Until that Tars has registered its projects, a message of yours that
starts with `@word` goes to Hermes, as it did before the plugin.

From a checkout of this repository, at the tag of that release:

```bash
scp -r hermes-plugins/tars-relay <server>:~/.hermes/plugins/tars-relay
ssh <server>
hermes plugins validate ~/.hermes/plugins/tars-relay      # Hermes's own checks: manifest, hooks, security scan
hermes plugins enable tars-relay
```

Then, in `~/.hermes/config.yaml`, your Telegram user id (the one in `TELEGRAM_ALLOWED_USERS`):

```yaml
plugins:
  entries:
    tars-relay:
      settings:
        user_id: 123456789
```

Restart both the gateway and the dashboard: each loads its half of the plugin when it starts. Then, from the Mac,
through the tunnel Tars already uses:

```bash
curl -s -H "X-Hermes-Session-Token: $TOKEN" http://127.0.0.1:9119/api/plugins/tars-relay/status
# {"plugin": "tars-relay", "version": "1.0.0", "configured": true, "sends_last_hour": 0, "waiting_replies": 0,
#  "projects": []}
```

`"configured": false` means the user id is missing or is not a positive number: nothing is sent or kept then.

To remove it: `hermes plugins disable tars-relay`, restart both, and delete `~/.hermes/plugins/tars-relay`. Its
store is `~/.hermes/plugin-data/tars-relay/relay.db`.

## Routes

Under `/api/plugins/tars-relay/` on the dashboard, behind its session token like every dashboard route.

| Route | Body | Answer |
|---|---|---|
| `GET /status` | | `configured`, `sends_last_hour`, `waiting_replies`, `projects` (the names Tars registered) |
| `POST /send` | `{text, kind, ref?, project?}`: `kind` is `question`, `report` or `sentry`; `ref` up to 200 printable characters, no spaces; `project` one word | `{message_id}`. 400 for a request it refuses, 503 with no user id, 429 past 60 sends in an hour, 502 when Telegram does not take it. A send takes its place in the 60 before it goes out, so sends made at once cannot pass them, and gives it back when Telegram refuses it |
| `GET /replies?after=N` | | `{replies: [...]}`, oldest first, from after `seq` N, at most 100: `seq`, `kind` (`reply` or `project`), `ref` and `project` (of the message replied to, or the `@project` name), `text`, the ids |
| `POST /ack` | `{through: N}` | `{deleted}`: every reply up to `seq` N |
| `POST /projects` | `{projects: [name, ...]}`: one word each, at most 500 | `{projects: n}`. From now on `@name` is Tars's for these names alone, in any case, in place of the last ones. 400 for a list it refuses |

A text longer than Telegram takes (4096 UTF-16 units, an emoji counts two) is refused, not cut.

## What it keeps

`relay.db` (SQLite: the gateway and the dashboard are two processes), in a folder only its owner can open, the
file `0600`:

- what was sent: chat, message id, kind, ref and project, for 30 days, so a late reply still reaches Tars. A reply
  to anything older goes to Hermes like any message;
- the text of what was sent, until the model has had its copy, or 7 days;
- the replies, until Tars takes them, or 7 days;
- the names of Tars's projects, as Tars last registered them.

Deleted rows are overwritten (`secure_delete`), and the default rollback journal is used rather than a
write-ahead log, so a text once copied or taken is not left in the file.

## Limits

- Text only. A photo, a voice note or a sticker sent in reply to Tars goes to Hermes, as any message does.
- No acknowledgement in Telegram: a reply kept for Tars gets no answer from Hermes. Tars says when it has passed
  it on.
- Sent while Hermes answers, or within a fraction of a second of another message, a reply to Tars also reaches
  Hermes's model, as a correction or merged with the other message (Hermes's own handling, which a plugin cannot
  change without replacing Hermes's Telegram adapter). Tars gets it on its own all the same.
- The observer's group, 100, is the plugin's: another plugin that observes in the same group would silence one of
  the two (python-telegram-bot runs one handler per group).
- On a Hermes without plugin handlers (`ctx.register_platform_handler`, older than 0.21.4), the plugin keeps
  messages from Hermes's dispatch hook alone, and a message Hermes merges or takes as a correction does not reach
  Tars; the gateway logs it at start.

## Tests

- `python3 -m unittest discover -s tests`, from this folder: the rules, without Hermes, failure modes first. The
  repo's `npm test` runs them too (`__tests__/hermes-plugins/tars-relay.test.ts`) with the first of `python3`,
  `python` and `py -3` that is a Python 3.9 or later. With none, it says so and skips them; on CI it fails.
- End to end, Hermes's own gateway and dashboard (its deployed commit, 536802c) run the plugin in a sandbox, with a
  fake Telegram and a fake model: sends, sends made at once, replies, the `@project` prefix and the registered
  projects, the model's copy and its quoting, a stranger the allowlist lets through, a group, the store, and
  messages sent while Hermes answers or right after another, in each of Hermes's three busy modes.
  That bench lives outside the repo, beside the design it proves.
