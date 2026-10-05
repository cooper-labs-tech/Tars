# Security notes

What Tars defends against, what it does not, and which of the two a given
change is. Measured, dated, and written down when the measurement says a
defence is not one: a lid that reads like a boundary is worse than an open door
nobody mistook for closed.

Everything here was measured on JeanBrasse's machine, macOS 26.6.1 (Darwin 25.6.0),
on `main` at `b17db0f`, between the 17th and the 18th of September 2026, except
where a passage names `bad8c97`: the first version of the 1.7.6 work, which an
audit read on the 18th and found holes in.

---

## 1. The threat this app actually has

One user account. One person. Every agent Tars starts runs as that person, with
that person's shell, that person's keychain and that person's files. Nothing in
the API, in a file mode or in a `--add-dir` flag changes that, because none of
them is enforced against a process that simply opens the file.

So there are two different questions, and they are answered in two different
places:

- **Which agent is this, and may it do that?** A question about mistakes and
  about crossing wires: an orchestrator picking the wrong id out of a global
  listing, an MCP client that started without a token, a browser tab reaching
  `127.0.0.1`. This is answerable, and the local API answers it.
- **Can agent A obtain what agent B holds?** A question about isolation. On one
  user account, with no sandbox, the answer is yes, always, whatever the API
  does. It is not answerable by a check in a route.

Confusing the two is how a defence becomes theatre. The rest of this file keeps
them apart.

---

## 2. What the local API decides (and what it cannot)

Since the identity work of 1.7.x an agent is named by the token Tars minted for
its process, never by a header. Since 1.7.6 the routes that **drive** an agent
(start, dispatch, run-task, stop, message, delete, and create) refuse a caller
that is nobody, and the Hermes webhook, which drives one too, opens to Hermes
alone:

| Credential | Who it is | What it opens |
|---|---|---|
| An agent's token (`CLAUDE_MGR_API_TOKEN`, minted in memory per terminal and per ACP run) | that agent | its own project's agents, and a new agent in its own project, never an orchestrator (`POST /api/agents` refuses the role to every caller: only the Agents page makes one); another project's only with `allowCrossProject`. Not the webhook |
| Tars's own pass (minted in memory, written nowhere) | the main process | every agent of every project: it is JeanBrasse's super chat, which drives every project by design. Not the webhook |
| `~/.tars-private/hermes-webhook-secret` | Hermes | `POST /api/webhooks/hermes` and nothing else, and through it any agent of any project, named by id or by name |
| `~/.dorothy/api-token`, the shared token | nobody | reads, and the exempt routes. It drives no agent, and does not open the webhook |

Measured before the change, on `b17db0f`: a call presenting the shared token
with **no** `x-tars-client` header stopped, started, dispatched to and DELETEd
an agent of any project and got a `200`. The guard refused only a caller that
*volunteered* `x-tars-client: mcp`, which is a header the caller writes about
itself. Every agent can read that token file, so the fleet was open to any of
them; it could not simply be refused, because the super chat authenticated the
same way. It no longer does.

Measured again on `bad8c97`, the first version of that change, by the audit that
read it: the webhook still let the shared token drive the fleet. It took the
master token as a fallback, "so an existing setup keeps running"; with no secret
file it skipped its own check altogether, so an agent's own token went through
too; and it hands its target to `performDispatch`, which checks nothing, after
resolving it by name across every project. The shared token with a secret
configured, and the shared token or an agent's token with none, each got a
`200` and had the message typed into the agent it named, the agent's token into
another project's. The route now opens to the webhook secret and to nothing
else, and no secret configured means no way in. The same audit found creation
held to an identity but not to a project, while the table above already said
its own project: an agent created one in any project it named, with a `200`.
Creation now follows the rule the other routes follow.

**What this is.** A guard against mistakes, and against a *casual* reader of the
token file. It is not isolation: see §3.

**What it leaves open, deliberately.** The read routes (`GET /api/agents`, and
per-agent status, output, health, wait, bootstrap) still accept the shared
token. So a process holding that file can still enumerate the fleet and read any
agent's terminal output. The hooks no longer need it: since 2026-09-23 they
present the token of the CLI they run in, for the bootstrap and memory reads and
on `/api/hooks/*`, where nothing else is accepted (below). Closing the reads to
the shared token is now a change to routes only.

**What the hook routes take.** `/api/hooks/*` sets an agent's status and output and
registers the session that owns it, so until 2026-09-23 anybody on the loopback could
post for any agent with no credential: the Audit registered one agent's session for
another and got its conversation back through a restart (`--resume`), and a killed
CLI's late SessionStart took its agent from the live session by accident. The hooks
run inside the agent's CLI and inherit its `CLAUDE_MGR_API_TOKEN`, minted for that
terminal: a post now carries it, and the route takes nothing else (not the shared
token, not Tars's pass, not the token of a delegated ACP run, which names the agent
too) and only for the `agent_id` it names. The Audit's gate of #135 posted a
SessionStart with a run's token: it registered a session over the live terminal's,
which then had every post refused as stale. A terminal replaced by a restart or a new
start, or one that has ended, takes its token with it: the old CLI's late posts are a
401, where a stopped CLI's token used to last until the agent's next launch.
A hook sends that token only to the Tars that spawned its CLI (the Audit's table,
#11). While Tars is down any process of any account may hold its port, and got every
token posted to it: measured on 2026-09-24 with a listener on the port after the quit,
the 1.9.0 hook sent it `Bearer <the terminal's token>`. Tars now mints an instance id
per run (`tarsInstanceId`, in memory, never written) and hands it to each CLI beside the
token (`TARS_INSTANCE_ID`). As it starts, a hook sends a fresh random challenge to
`/api/health` and sends the token only when the answer is sha256 of the id and the
challenge; with no id, no answer within 5 s (longer than any post waits: a Tars whose main thread is held a few seconds still gets its token) or a wrong one, it posts without a token.
The same listener got the challenge and a post with no Authorization. The id is as
readable as the token by a process of the same user (`ps -Eww`), and no more: this
closes the port to other accounts and to a replay, not to that.
Upgrading from 1.7.9: quitting kills every agent terminal, so no CLI started by 1.7.9
outlives the update, and each is relaunched with a token and the new scripts (they sit
in the app bundle). One that survives anyway posts without a token, or with one this
Tars never minted, and is refused: stop and start it from Tars. The hook logs moved
from `/tmp` (readable by every user, shared by every Tars on the machine) to
`~/.dorothy/logs/`, `0600`, and Tars removes the two old files at startup
(`removeLegacyHookLogs`): only regular files the user owns, and only when `HOME` is the
user's own, so a sandbox never deletes the logs of a Tars still on 1.7.9 beside it.

**What the webhook secret is.** The reach of JeanBrasse's own chat, handed to Hermes,
so it lives where JeanBrasse's conversation lives, in `~/.tars-private`, and not in
`~/.dorothy`, where it was minted until 1.7.6. It moves at the first start that
finds it there, value unchanged, so a Hermes job that holds it keeps working.
That takes it out of the directory every agent is pointed at. It does not take
it out of an agent's reach: an agent that goes looking reads `~/.tars-private`
like any other file of JeanBrasse's (§1, §5), and with the secret drives any agent of
any project through the webhook. And an agent that read it before the move
still has it. Rotating it is deleting `~/.tars-private/hermes-webhook-secret`,
opening Settings > Hermes, which mints a new one, and giving Hermes that.

---

## 3. An agent's token is not secret from the other agents

`CLAUDE_MGR_API_TOKEN` travels to the CLI, and from the CLI to every MCP server
it starts, in the environment. The environment of a process is readable by any
other process of the same user.

Measured on 2026-09-18: six live `mcp-orchestrator` node processes on this
machine, every one of them exposing `CLAUDE_MGR_API_TOKEN` and
`CLAUDE_AGENT_ID` to `ps -Eww`. A canary in a `node` process is readable; the
same canary in `/bin/sleep` is not, because Apple's platform binaries hide
theirs and neither `claude` nor `node` is one.

Four parades were considered, and **none was written**:

| Parade | What it would do | Measured verdict |
|---|---|---|
| A `0600` file instead of the environment | | Moves it. Every agent runs as the same user, so `cat` reads it. `~/.dorothy/api-token` is already `0600` and is exactly the secret this replaced |
| An inherited file descriptor | Pass the token on an fd rather than in the environment | Not implementable. Tars starts the CLI through `node-pty`, whose `spawn` inherits the tty and nothing else, and the token has to reach the MCP servers, which the **CLI** starts, from its own environment. There is no fd route that does not go through Claude Code |
| A one-shot token exchanged at startup | Redeem the environment token once for a session token held in memory | Breaks the fleet. The same variable is what a respawned MCP server and the shell hooks present later; spending it on first use logs them out. And a sibling can read it before it is spent: a race, not a boundary |
| A unix socket per agent | Address the API through a per-agent socket | Moves it. The socket path is in the same environment, and filesystem permissions are per user, so any agent of that user connects. macOS has no abstract socket namespace |

And the sandbox, which is the one that sounds like it would work:

**It does not.** Measured under the strictest `sandbox-exec` profile in §4, a
five-line Python calling `sysctl KERN_PROCARGS2` still read another process's
environment. `(deny sysctl-read (sysctl-name "kern.procargs2"))` does not stop
it. `(deny process-info*)` does not stop it either, and kills the reader's own
interpreter, `git` and `npm` with it; `(deny process-info* (target others))`
leaves the toolchain alive and still does not stop it. What every profile does
stop is `/bin/ps`, which is setuid root and therefore cannot be executed under
any sandbox at all: the convenient route is closed, the syscall behind it is
not.

**The honest statement.** Per-agent tokens ended impersonation *by naming*: an
agent can no longer become a colleague by writing a header. They do not, and
cannot, end impersonation by a process that reads the process table. Closing
that needs agents in separate user accounts, or separate VMs. It is not a
line of TypeScript, and nothing in this repo pretends otherwise.

---

## 4. A sandbox for a Tars agent: what it would really buy

JeanBrasse decides this; nothing here is implemented, and no agent is confined by
anything Tars ships today. This is the measurement, so the decision has numbers
under it.

`claude` runs unconfined: its Bash reads everything JeanBrasse reads. `--add-dir` sets
**tool permissions**, not an access boundary, and on this machine 37 of the 42
agents in the fleet run with `--dangerously-skip-permissions`, where the flag
decides nothing at all.

### What was measured

A real `claude` (2.1.273), under `sandbox-exec`, on a disposable project, with a
disposable HOME and the login keychain reached by symlink. Its own report, in
full:

```
1. hello.txt - written successfully, contains `confined`.
2. git status --short - succeeded: `?? f.txt` and `?? hello.txt`
3. ls /Users/you/Documents - failed: ls: /Users/you/Documents: Operation not permitted
4. ps -Eww -p 39401 - failed: (eval):1: operation not permitted: ps
```

So: it did its work, and it could not read JeanBrasse's home. Separately measured
under the same profile: `~/.dorothy/api-token` denied, `/Users/you/tars`
denied, the loopback API reachable, `api.anthropic.com` reachable, `git`,
`node` and `npm` working.

### The profile that does it

This is the one the run above was made under, with `PROJECT` the agent's
working directory and `AGENTHOME` its HOME. It is not a proposal to adopt as
written: it is what it took to get a working agent, so that the cost is
visible.

```scheme
(version 1)
(deny default)

; --- what any program needs to start at all -------------------------------
(allow process-exec process-fork)
(allow file-map-executable)
(allow file-read-metadata)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-ioctl)

; --- the system, read only -------------------------------------------------
(allow file-read* (literal "/")
                  (subpath "/usr") (subpath "/bin") (subpath "/sbin")
                  (subpath "/System") (subpath "/Library") (subpath "/opt")
                  (subpath "/private/etc") (subpath "/private/var/db")
                  (subpath "/private/var/select") (subpath "/dev")
                  (subpath "/Applications"))
(allow file-write-data (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))

; --- the toolchain, wherever the user installed it -------------------------
; On this machine node, npm and claude itself all live under $HOME, so a
; profile that allows only /usr and /opt starts nothing.
(allow file-read* (subpath "/Users/you/.nvm")
                  (subpath "/Users/you/.local/bin")
                  (subpath "/Users/you/.local/share/claude")
                  (subpath "/Users/you/.config/git")
                  (literal "/Users/you/.gitconfig")
                  (literal "/Users/you/.gitignore_global")
                  (literal "/Users/you/.npmrc"))

; --- the credential store -------------------------------------------------
; Measured: without this the CLI answers "Not logged in · Please run /login".
; The OAuth token lives in the login keychain, so a profile that walls off the
; user's Library walls off the agent's own account with it.
(allow file-read* file-write* (subpath "/Users/you/Library/Keychains"))

; --- the agent's own world, read and write ---------------------------------
(allow file-read* file-write* (subpath "PROJECT"))
(allow file-read* file-write* (subpath "AGENTHOME"))
(allow file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))

; --- the network: the model, and Tars on the loopback ----------------------
(allow network-outbound)
(allow network-bind (local ip "localhost:*"))
```

What it took to get there, none of it obvious:

- `(deny default)` plus a list of allowed subpaths **is not enough for `/bin/sh`
  to run**: it also reads the root directory, so `(literal "/")` is required.
  Without it every command dies at exec with no message.
- The toolchain has to be named, because on this machine it lives under `$HOME`:
  `~/.nvm` (node and npm), `~/.local/bin` and `~/.local/share/claude` (the CLI
  itself). A profile allowing only `/usr` and `/opt` starts nothing.
- `git` reads `~/.gitconfig` and `~/.config/git/ignore`. Denied, it fails
  outright on the first and warns on the second.
- **The credential store has to be allowed.** Without
  `~/Library/Keychains`, the CLI answers `Not logged in - Please run /login`.
  A profile that walls off the user's `Library` walls off the agent's account
  with it.
- The network can be allowed or denied, and not much in between:
  `network-outbound` filters take an `ip "host:port"`, not a DNS name, so
  "only api.anthropic.com" is not expressible. Loopback-only was measured:
  the model becomes unreachable (`curl` to Anthropic returns nothing at all).
- A `(deny …)` rule is an `EPERM` by default and a kill with
  `(with send-signal SIGKILL)`. The kill matters when the caller swallows the
  error; `log show` does not report these refusals, so it is no use as a
  detector.

### What JeanBrasse gains

- An agent cannot read `~/Documents`, `~/.ssh`, another project's source, or
  `~/.dorothy` (the fleet's settings, every provider API key, the shared token,
  the vault). Measured, not assumed.
- An agent cannot write outside its project and the paths it is given. That is
  the failure mode with teeth: a confused agent `rm -rf`ing the wrong tree.
- It is per agent and per profile, so a read-only reviewer agent is expressible.

### What JeanBrasse loses

- **`ps` stops working entirely**, in every profile, confined or not, because it
  is setuid root. An agent debugging a stuck process loses its tool.
- Every path an agent legitimately needs must be named in advance: a second
  project, a worktree elsewhere, a scratch directory, a global npm cache. A
  missing path is a refusal, and often a silent one.
- `sandbox-exec` is deprecated by Apple. It works on macOS 26.6.1 and has worked
  for a decade; it carries no promise about the next release.
- Nothing may wrap the E2E suite in it: Chromium installs its own sandbox and a
  process already confined fails to start.
- **It does not close §3.** An agent under this profile still reads a
  colleague's token out of the process table. The sandbox is a filesystem
  boundary, not a process boundary.

### The shape it would take in Tars, if JeanBrasse wants it

`initAgentPty` is the one line every PTY starts on. A confined spawn would be
`sandbox-exec -f <profile> <the command it already builds>`, with the profile
written per agent next to its worktree from a template: the project path, the
worktree, the agent's own scratch, plus the fixed system and toolchain block
above. Opt-in per agent, defaulting to off, or every existing agent breaks on
the first path nobody thought to list.

---

## 5. What is where on disk

| Path | Holds | Reachable by an agent |
|---|---|---|
| `~/.dorothy/` | the fleet, settings, the shared token, the vault, the bus journal, the Hermes gateway's connection (`hermes-connection.json`, without its token since 1.9.3), and the files staged for a room (`bus-files/`, a week, then removed), and each agent's temporary folder (`tmp/`: its commands' temporary files and Claude Code's scratchpad and background task output, kept 7 days) | Yes, deliberately: it is in every agent's `--add-dir`. A file sent to one room can be read by every agent of every project, as its journal can; `bus-files/` is refused when it is a link, and each file is written in a folder of its own that must not exist yet |
| `~/.tars-private/` | JeanBrasse's conversation with the super chat, the Hermes sessions it held that conversation in (`overseer-hermes-sessions.json`), the questions agents asked the user with `ask_user` and the Telegram messages they went out as (`user-questions.json`: kept here and not in `~/.dorothy`, which any agent can write, so no agent can point an answer at another), what the event reports counted and the GitHub watch has seen (`event-reports.json`, `github-watch.json`: kept out of the agents' reach so none can silence a report), the Hermes dashboard's token (`hermes-token`, JeanBrasse's decision 6 of 2026-10-01), what the relay sent and what waits for Hermes (`relay-sent.json`, `relay-outbox.json`, `relay-state.json`), the Hermes webhook secret, and the Claude accounts' registry (`claude-accounts.json`: the option, each account's id and name, the thresholds; no credential and no folder), and what carries across a restart (`run-state.json`: who was working, a task's first 200 characters; `carry-over.json`: the notes Tars owes agents). Those two were in `~/.dorothy` until the Audit's gate of #310: a `carry-over.json` written by an agent had Tars type "Message from Telegram (JeanBrasse): ... I approve." into the orchestrator, and a `run-state.json` had it start the agents it named, in any project. A sender read back from `carry-over.json` is never typed as one either: a carried note goes as from Tars, its first sender quoted inside it | Not handed to any agent, never passed to a CLI, and refused by both ways an agent has of sending a file to Telegram and by the vault's attach route. Each file `0600`, in a directory Tars makes `0700`. The conversation also lives in Hermes, one session per turn: `memory_search` (`/api/memory/search`, what agents call) leaves out every session the super chat opened, every run of its cron job (recorded when it runs, so a run of a job replaced since is still left out), a session Hermes compressed out of one of those (the gateway answers a compressed conversation under its newest id, with its `lineage_root` and `parent_session_id`, which are checked too), a session branched or delegated from any of those (the gateway's lineage stops at a branch or a delegate edge, so each parent is read further up through `GET /api/sessions/{id}`, to a root; an ancestry that cannot be read to its end, a cycle, or more than 20 parents leaves the hit out), and any hit that names no session. The gateway is asked for its most (100) and the filter runs before the agent's `limit` is applied, so the super chat's hits do not take an agent's places. When 100 or more of the super chat's lineages match before any of JeanBrasse's, an agent gets no Hermes hit: the gateway gives no further page. Sessions opened before 1.9.0 were not recorded, so only their cron runs are left out; an agent holding `hermes-connection.json` can still ask the gateway itself (§5, the paragraph below) |
| `~/.claude-accounts/<id>/` | each Claude account after the first, with several on: a Claude Code folder of its own, with its own `.claude.json` (the account's identity) and a copy of `~/.claude/settings.json`, its transcripts, history, sessions, CLAUDE.md, skills, agents, commands, plugins and output styles being links to `~/.claude`. The sign-in is Claude Code's, in the keychain item named after the folder (`.credentials.json` on Linux): Tars never opens it | Not in any agent's `--add-dir`; the agents started on an account run in its folder (`CLAUDE_CONFIG_DIR`), as account 1's run in `~/.claude`, and a folder that is not Tars's own is refused, never repaired |

So what the kanban tools let an agent do on the Hermes board (since #183, delete
only a task it filed that nobody claimed, or one it claimed) is a rule of Tars's
own tools, not a barrier: an agent that holds the dashboard's token can call the
gateway with it and edit or delete any task (the audit's gate of #183). Since
1.9.3 that token is in `~/.tars-private/hermes-token`, out of the folder every
agent is handed; an agent in bypass, which runs as the user, can still read it
there (no confinement, JeanBrasse's decision of 2026-09-23).

**The relay to the user's Telegram** (`services/hermes-relay.ts`, on with
`hermesRelayEnabled`). Who can reply: the tars-relay plugin on the Hermes server
keeps a message for Tars only from the one user its settings name, in their
private chat, replying to a message the relay sent or starting with "@project"
for one of the projects Tars registered with it;
Hermes's own allowlist turns strangers away before that. Tars then takes a reply
only when it answers a message id on its own list (`relay-sent.json`), which the
plugin cannot write: whoever holds the dashboard token can make the plugin send,
and read or delete the replies it keeps, never make Tars type a reply to a
message Tars did not send. What Tars types goes after `Message from the user via
Telegram:`, a line only Tars writes, to a project's orchestrator only, never to a
worker, with the user's words only. With the relay on, the Tars bot's token is
erased, and mcp-telegram, which wrote to Telegram with it past every rule here,
is taken out of every CLI; `send_telegram` goes through the relay, for an
orchestrator only, its text masked.

The same token opens the routes of the tars-relay plugin once that plugin is installed on the Hermes
server (`hermes-plugins/tars-relay`, installed nowhere yet). Whoever holds it can then write to JeanBrasse
through Hermes's Telegram bot, as Tars, read or delete his replies before Tars takes them, and name
the projects whose `@name` messages are kept from Hermes. The plugin decides what it can on its own:
the recipient is the user id in the server's own config, never one the caller names; at most 60
messages go out in an hour, each counted before it goes out, so sends made at once do not pass it; and
it keeps only JeanBrasse's messages in his private chat. What it does not decide: a reply to Tars that JeanBrasse
sends while Hermes answers him, or right after another message, reaches Hermes's model too (Hermes
takes it as a correction, or merges it), and Tars gets it all the same from the plugin's observer;
keeping it from the model would mean replacing Hermes's Telegram adapter. Hence JeanBrasse's decision of
2026-10-01 that the token moves to `~/.tars-private`: the plugin goes in with that move, not before it.

What an agent waits on (`waitingOn`, the command or question of an open dialog) is kept in memory only: it is not written to `agents.json`. While the dialog is open, another agent can read it through `GET /api/agents/:id?full=true`, as it can read the rest of that agent's record; a command typed with a secret in it is visible there for that long. The hook sends only the fields that name the dialog, each cut at 1000 characters, never a tool's whole input.

`~/.tars-private/overseer.json` used to be `~/.dorothy/overseer.json`: 148,654
bytes, 344 messages, mode `0644`, in the directory every agent is pointed at.
Reading it took no API call and no token.

Moving it is worth exactly what it is worth, and no more: it leaves the
directory an agent is handed and the listing it gets for free, and the `0600`
closes it to the other accounts on the machine. An agent that goes looking for
`~/.tars-private` still reads it, because §1. Closing that is §4, or nothing.

The move first took it off a list, which the audit of `bad8c97` caught on the
app's Telegram send routes, and which held for the agents' Telegram MCP server
too: both refuse `~/.dorothy` by name, and refused nothing under
`~/.tars-private`, so the conversation could be sent from where it had landed
with one call. Both refuse the private directory now. The vault's attach route
was a third way, measured on the same branch: it copies the file its caller
names into `~/.dorothy/vault/attachments`, where `/api/local-file` serves it
with no token, and it took a file from `~/.tars-private` on the shared token.
It refuses the private directory now too, by what the file is and not by how
it is named: on 2026-09-23 the audit's lead #21 was reproduced in a sandbox
app, where `~/.TARS-PRIVATE/...` (the volume ignores case) and
`/System/Volumes/Data/...` (the Data volume's firmlink) both copied the webhook
secret in and `/api/local-file` served it. The route and the app's Telegram send
routes now compare the real path, and each directory above it, with the private
directory by device and inode (`electron/utils/path-identity.ts`), so a case
variant, the firmlink or a symlink is refused like the plain name; the agents'
Telegram MCP server compares segments in any case and checks the real path too.
A hard link has no path back to the file it names, so a link made elsewhere to
a private file passed all of that; all three guards now look for its inode among
the files of the private directory, and the two Telegram ones in `~/.ssh` as
well (the audit's gate of #137).
It still copies any other file its caller names, `~/.ssh` included; that is older than 1.7.6, and closing it means
deciding what an agent may attach. Each of these is a refusal of the one-call
route, not a wall: an agent with a shell copies the file somewhere else first,
because §1.

The renderer's file channels (`fs:read-text-file`, `fs:write-text-file`,
`fs:read-project-files`, `local-file://`) confine a path to a list of roots:
`~/.dorothy`, the CLIs' folders and the projects. Until 1.9.2 a root could be
the home or a folder above it (a project added as `~` or `/Users`, or written
into `projects.json`), and the path was judged as spelled while the read or
the write followed links: one symlink under `~/.dorothy` or in a cloned
repository to the home opened `~/.ssh`, `~/.tars-private` and the shell's
startup files, to read and to write. A root that is the home or above it is
now refused, by spelling and by device and inode, and the path must really
lie, links followed, under the real location of a root
(`electron/utils/home-root.ts`, `real-target.ts`). One file link to a markdown
file outside every root and outside the Telegram guard's blocked places stays
allowed on the three IPC channels, for a CLAUDE.md kept in a dotfiles
repository. `/api/local-file`, which takes no token, got the same real-path
test without that exception, and refuses a file with a second name, since an
attachment is a copy the vault made: before, one symlink or hard link planted
in `~/.dorothy/vault/attachments` served, to any process on the loopback,
another account's included, the file it named or every file under the folder
it led to. What is left:
the check and the read are two calls, so a link swapped in between is
followed, by a process that could open the file itself (§1).

Made on a new install by the first save, the directory came out `0755`, since
only the migration asked for `0700`. Whichever write makes it now, the
migration or the first save of the conversation or of the webhook secret, makes
it `0700`. A directory that already exists at another mode is left as it is.

## 6. Who the bots answer

Each bot is a way into the fleet from outside the machine, so each answers a
list JeanBrasse keeps in Settings, and nobody when the list is empty.

- **Telegram**: the chats enrolled with `/auth <token>`. Read from the settings
  as they are at each message: before 2026-09-23 the bot held the object it was
  started with, every Settings save replaced main's, and a chat removed or a
  token regenerated kept working until a restart (the audit's lead #19). The
  app's own `/api/telegram/send*` go only to those chats, as mcp-telegram's do:
  `send_telegram`, in every agent, forwarded a chat id chosen by the model
  (lead #20). And what the bot sends of its own accord, the super agent's
  replies and errors and the status notices, goes only to a chat Settings
  allows at the moment it is sent: the chat that last asked was remembered and
  never checked again, so a chat removed after asking kept receiving all three
  (the audit's gate of #137). It is forgotten now, and what it would have
  received goes to the chats that are allowed. Since 2026-09-24, `/auth` takes
  five wrong tokens from a chat, and twenty from all chats together, in any
  fifteen minutes (the Audit's gate of #176); past that it answers "Too many
  attempts" without comparing, the same to a right token as to a wrong one. The
  token Tars generates is 128 random bits: the limit is for a token set by hand,
  and against a bot that answers a stranger for ever. The count from all chats
  is a lock-out anyone who finds the bot can cause: twenty wrong tokens in
  fifteen minutes keep every new chat out, JeanBrasse's included (chats already
  enrolled are not affected). Kept for 1.9.0 on purpose (the Audit's gate of
  #200), with its way out said in the refusal itself: "Try again at HH:MM, or
  turn Telegram off and on in Tars's Settings". The toggle restarts the bot,
  which starts the count again. Only toggling Telegram in Settings or
  restarting Tars clears it: the count lives in memory, no API route restarts
  the bot and nothing watches app-settings.json.
- **Slack**: the member ids in Settings > Slack (`slackAllowedUserIds`). Before
  it, anyone who could mention or message the bot could list agents and project
  paths, start, stop and brief them, and move the channel agents post to
  (lead #15). A sender not on the list is told its own id, in a mention or a
  direct message, so the owner can add it; other channel messages are ignored
  without a word.
- **Discord**: the user ids in Settings > Discord (`discordAllowedUserIds`), and
  in a server channel only a message that mentions the bot, unless Require
  @mention is off. A stranger is told its id where it addressed the bot. Nothing
  the bot posts can ping (`allowedMentions` with nothing in it). Its invite asks
  for View Channels and Send Messages and nothing else: until the Audit's gate
  of #195 it asked for Read Message History too, which the bot never uses.
