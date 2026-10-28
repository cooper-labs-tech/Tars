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
(start, dispatch, run-task, stop, message, delete, create, and since 2.0.4 update) refuse a caller
that is nobody, and the Hermes webhook, which drives one too, opens to Hermes
alone:

| Credential | Who it is | What it opens |
|---|---|---|
| An agent's token (`CLAUDE_MGR_API_TOKEN`, minted in memory per terminal and per ACP run) | that agent | its own project's agents, and a new agent in its own project, never an orchestrator (`POST /api/agents` refuses the role to every caller: only the Agents page makes one); another project's only with `allowCrossProject`. It changes another agent's settings (`POST /api/agents/:id/update`, 2.0.4) only with the orchestrator's powers, in its own project whatever `allowCrossProject` says, never the role, and never an orchestrator's or a chat's runner's. Not the webhook |
| Tars's own pass (minted in memory, written nowhere) | the main process | every agent of every project: it is JeanBrasse's super chat, which drives every project by design. Not the webhook |
| A Hermes gateway's secret: `~/.tars-private/hermes-webhook-secret` for the default gateway, `hermes-webhook-<id>.secret` for another (2.0.4) | that gateway | its own webhook route and nothing else, and through it the agents of the projects the user allowed that gateway, none until they do, in their own mode or a narrower one |
| `~/.tars-private/api-token`, the shared token | nobody | reads, and the exempt routes. It drives no agent, and does not open the webhook |

The new agent an agent makes runs on any provider of the registry and on any CLI binary it names (`cliPath`, refused unless it is an absolute path to an executable file). This is not a boundary Tars gives away: `POST /api/agents` took a `cliPath` and any permission mode from every agent before 2.0.2, and a permission mode does not confine the agent that asks (see the ceiling below). What the API refuses is what could not start, or would not run as asked: an unknown provider, an API-key provider without its key, a `cliPath` that is not an executable file, and plan on a provider that has none, which would run as normal (2.0.2, JeanBrasse: "ça doit supporter n'importe quel provider/cli"; the Audit's gate of #407). An agent its orchestrator changes afterwards (`update_agent`, 2.0.4) is held to the same checks, and the change never ends a CLI at work.

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

**Who hands work, and who stops (2.0.4).** After the project, the routes that hand an
agent work (`/start`, `/run-task`, a `/dispatch` carrying a task, a `steer`, and the
kanban's claim for another agent, `assign_task` with `agent_id`) and those
that end its CLI (`/stop`, `DELETE /api/agents/:id`, a `restart`) ask the caller's
role (`core/one-task.ts`): Tars's own pass, an agent with the orchestrator's powers,
or the agent itself; a worker is refused, and what it sends another worker is typed
in as a labelled note once that agent's turn ends. The role
is read from the fleet, which the token names, never from a header. It is still a
guard against an agent's mistake, not a boundary: a worker that edits
`~/.tars/agents.json` can give itself the orchestrator's role for the next
launch, as below for a chat's runner, and `intent: 'task'` is a word the caller
writes, so a worker that leaves it out gets a note through, never a task.

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
The same listener got the challenge and a post with no Authorization. Until 2026-10-12 the reads
a hook makes with the token (the agent's bootstrap and its memory context at SessionStart, the memory
post after a write, in both runners) went out without that check: the squatter got the token there
(the Audit's Info on #355). They take the same check now (`TARS_READ_TOKEN`, `tokenForReads`); a
CLI whose port does not prove its instance reads nothing, and not with the shared token either. The bundled
MCP servers the CLI starts (orchestrator, memory, kanban, vault) presented the same token to the same port
with no check until 2026-10-13, so a CLI that outlived a quit handed it to whatever held the port with its
next tool call (the Audit's Info on #370). They ask the same challenge before every call (`tokenToPresent`,
mcp-shared), never keeping a proof, so a squatter that takes the port after a call gets nothing with the
next one; unproven, they call without a token, and never with the shared file instead. The id is as
readable as the token by a process of the same user (`ps -Eww`), and no more: this
closes the port to other accounts and to a replay, not to that.
Upgrading from 1.7.9: quitting kills every agent terminal, so no CLI started by 1.7.9
outlives the update, and each is relaunched with a token and the new scripts (they sit
in the app bundle). One that survives anyway posts without a token, or with one this
Tars never minted, and is refused: stop and start it from Tars. The hook logs moved
from `/tmp` (readable by every user, shared by every Tars on the machine) to
`~/.tars/logs/`, `0600`, and Tars removes the two old files at startup
(`removeLegacyHookLogs`): only regular files the user owns, and only when `HOME` is the
user's own, so a sandbox never deletes the logs of a Tars still on 1.7.9 beside it.

**What the webhook secret is.** The reach of a Hermes gateway into the fleet, so it
lives where JeanBrasse's conversation lives, in `~/.tars-private`, and not in
`~/.tars`, where it was minted until 1.7.6. It moves at the first start that
finds it there, value unchanged, so a Hermes job that holds it keeps working.
That takes it out of the directory every agent is pointed at. It does not take
it out of an agent's reach: an agent that goes looking reads `~/.tars-private`
like any other file of JeanBrasse's (§1, §5), and with a secret drives what that
gateway reaches. And an agent that read it before the move still has it.

**What a gateway reaches, since 2.0.4** (`services/hermes-gateways.ts`, the Audit's
NOW-3 and R4.1 to R4.3). Until then one secret opened the webhook for whoever held
it, a gateway or anyone on the tailnet who read its config, and reached any agent of
any project in any mode: the body's `permission_mode` won over the agent's own, so it
started any agent in bypass, and its 404 listed every agent with its project and
status. Now:
- each gateway has its own secret (32 random bytes, a `0600` file of the private
  folder) and its own route, and one gateway's secret on another's route is a 403; a
  secret is rotated or removed from Settings > Hermes, and the old value opens nothing;
- it reaches the projects the user allowed it there, none until they do, and the list
  is in the private folder too (`hermes-gateways.json`): an agent that could widen it
  would widen the gateway's reach;
- its message may keep an agent's mode or lower it for the session it starts, never
  raise it (403, before anything is typed), and the same holds for `/start` and
  `/dispatch` (`modeRefusal`);
- no refusal names an agent, a project or a mode: an agent outside its projects is a
  404 like one that does not exist.
What it is not: a gateway's message is still typed into an agent that may run in
bypass by the user's choice, and does there what the agent may do; and an agent that
reads the private folder holds every gateway's secret, as it holds the conversation. The window never holds one: adding a gateway or rotating its secret shows the new secret once in a dialog of the main process, which the page cannot read, and Copy secret copies it from the main process (`services/secret-handoff.ts`, as for the Telegram auth token and the default gateway's secret).

**What the ceiling for delegated runs was, and is not** (1.9.6, `core/permission-ceiling.ts`).
Since 2.0.4 a delegated task is no run: `delegate_task` and `/run-task` type it into the
target's own terminal, where it works in the target's own mode, whatever its asker's, its
sender line marked when the asker runs in a narrower one (`modeGapMark`), as any message is.
A delegated task runs in the permission mode of the agent that receives it: the
maintainer's decision of 2026-10-18, made with delegation into the permanent terminal. An
asker in plan therefore does not hold the task it delegates to plan: the mark asks, it
does not bind. Until 2.0.4 a run over ACP took the narrower of its asker's permission mode
and the target agent's own, in the order plan < normal < auto < bypass. What that bound,
measured:

- **plan binds.** The session is set to plan, and every permission request of the run
  is refused, the request to leave plan included (Claude leaves it through
  `ExitPlanMode`, which claude-agent-acp 0.70.0 sends as a permission request whose
  options switch the mode: Tars answers "No, keep planning"). A session that leaves plan
  anyway is cut at once and its asker answered `permission_escalation_denied`; so is a run
  held to plan on an agent that offers no plan mode. Until the Audit's gate of #364, Tars
  approved that request itself, and a plan-held run left plan and edited.
- **normal, auto and bypass differ little.** Tars answers an ACP run's permission requests
  itself, so a run in normal has what it asks for approved, once at a time, short of the
  deny list. Below plan, the order narrows the session's starting mode and little else.
- **A target with no ACP mode** was not a run: `delegate_task` typed the task into its
  terminal, where it worked in its own mode, whatever its asker's. Since 2.0.4 every target is.

And it is **not a boundary**. A persistent worker keeps the mode JeanBrasse gave it, which is its
configuration and not the asker's grant: `send_message` and `/dispatch` to a worker in
bypass have it do anything a worker in bypass may do, whatever mode the sender runs in.
The message only carries a mark after its sender line, "(sender in plan mode, you in
bypass mode)", so the worker and the transcript show the gap. The ceiling keeps a
delegated run from working in a broader mode than plan when its asker is in plan; it does
not confine the asker.

**What steer and restart respect, and what they do not.** An agent may interrupt
(`steer`) or restart a worker only when the work in hand is its own or there is none, and
may restart it only when no other asker's request waits in its queue (a stop ends them
all). A turn JeanBrasse typed into the worker's terminal has no asker Tars knows of: any agent
of the project may interrupt or restart it, as it could already stop the agent.

**What the receipts hold** (1.9.6, `services/request-receipts.ts`). A send with a
`clientRequestId` leaves a receipt in `~/.tars-private/request-receipts.jsonl` (0600,
24 h): who sent it, the id, a SHA-256 of what was sent and the outcome's ids and states,
never the text. A receipt answers only its own caller: the key is the agent the token
names. A hash is not secret from a guess: an agent that can read the file can confirm a
text it already suspects. It is out of the directory every agent is handed, and no
further out of reach than the rest of `~/.tars-private` (§5).

**The heavy-run slot (2.0.5, `/api/heavy-slot`, `services/heavy-slot.ts`).**
- **The routes.** An ask, a ticket and a give-back take an agent's own token: the lease is that agent's, and another
  agent can neither read its ticket nor give it back. The status lists who holds the slot and who waits (agent
  names, project folder names, labels) to any authenticated caller: every agent of every project reads the queue,
  which is the point of one queue for the machine.
- **What a lease is held by.** A pid, which must be under the asking agent's terminal where `ps` can be read (macOS,
  Linux). So an agent cannot hold the slot forever on pid 1, nor end its lease with another agent's process. On
  Windows the pid is taken as given, and the lease still ends with that process. On every system, an agent with no
  terminal is refused, and so is Tars's own process or one of its parents (found through the table where it can be
  read; Tars's own pid and its parent's on Windows). A lease nests only in a lease of the same agent. A lease the MCP
  tool takes is the CLI's and goes back at the turn's end; the owner gives any lease back from the window. The label
  is masked before every agent reads it.
- **Who may jump the queue.** `gate` is an orchestrator's; anyone else asking for it gets `normal`.
- **Nothing is ever ended.** The slot never ends a process: an alert is only said.
- **The shim is not a boundary.** `~/.tars/bin/tars-slot` is in every agent's reach, like `tars-mcp-node`: an agent
  can rewrite it, being the same user (section 3). It names no path of the app, and runs the script the terminal's
  environment names.
- **What a file in `~/.tars/bin` can shadow.** Every agent writes in `~/.tars` without a prompt (`--add-dir`), and
  Tars leaves any other file in that folder alone. So `~/.tars/bin` comes **last** on an agent terminal's PATH (the
  Audit's M1 on #537; it came first until then): a file there runs only for a name no folder before it has, never
  instead of `node`, `git`, `npm`, `claude` or any CLI that is installed. It can still answer for a command that is
  missing from the machine, for every agent: a `gemini` placed there runs where gemini is not installed. A login
  shell that sets PATH anew drops the folder; `"$TARS_SLOT"` names the shim without it.

**Tars never answers allow by itself** (2.0.5, #538). The state mod asks Tars instead of Claude Code's dialog, and
Tars holds the question for the owner: the window shows it, and the owner allows or refuses it. Nobody answering within
the owner's delay (`permissionAskMinutes`), it is refused with a reason the agent reads, and never handed back to a
native dialog nobody would answer at night. Tars allowed some questions itself for a while on #538, and the Audit's
three gates found each rule it tried reaching outside the agent's folders: a reader of shell commands of its own
(six forms in bash, then thirteen in zsh, the agents' shell on macOS, and in both shells), then a path rule for file
tools that a dangling or a hard link led into `.claude/settings.json` (the hooks Claude Code runs), outside, or
`~/.tars-private`. In bypass, Claude Code only asks about the paths it guards or does not know, which is where such
links lead, so an allow by Tars had almost no honest use and kept that surface open. What the window may allow is only
what it shows whole: a shell command. A file tool is asked by its path alone, its content withheld (the mod sends no
content, and the route marks every file tool withheld whatever the request says): the window may refuse it or hand it
back, never allow it. So is any call the window cannot show whole, a field it does not show, past 2,000 characters
or not text, which the mod sends withheld with the fields it shows and why the rest is not (the Audit's M1 on #538),
and the mod takes no allow for it either. Such a question is held only for an agent in bypass, autonomous, whose
nights this is for, and refused at the owner's delay; any other agent's goes straight to Claude Code's own dialog,
where its owner chose to be asked. Every decision goes to
`~/.tars/logs/permissions.log`, masked, which any agent can write, being the same user: a record for the owner, not
evidence against a hostile agent.

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
| A `0600` file instead of the environment | | Moves it. Every agent runs as the same user, so `cat` reads it. `~/.tars-private/api-token` is already `0600` and is exactly the secret this replaced |
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

**codex hands its MCP servers what it is told to, by name.** Measured on codex-cli 0.163.0: a server gets HOME, PATH, TERM and the variables its config lists in `env_vars`, nothing else. Tars lists, in its own servers' sections of codex's config.toml, the names they read, the token among them: names only, so the token reaches them from the codex process's environment, where this section already says who can read it, and is written in no file and no command line.

**A codex session posts as an agent only on evidence that it is the agent's.** Tars reads codex's turns from its session logs and posts them with the agent's own token (`services/codex-sessions.ts`). Until the Audit's gate of #465, the first session begun in a codex agent's folder after its launch was taken for the agent's: a codex its user ran in that folder had its turns posted as the agent's, a delegated task could be answered by it, and its id became the session the agent resumed after a restart or a wake. A session is bound now on the agent's identity line in its first message, on the agent's own codex holding its file open, or as a fork of the agent's own session its launch began; a first message naming another agent never is, and where a process's open files cannot be read (Windows), a session that names nobody stays nobody's. What this does not stop: whoever can type into the agent's terminal, or write its codex's rollout, can still make text read as the agent's turn. The boundary is the account, as everywhere in this file.

**Gemini's redaction is let through on purpose.** Gemini CLI withholds from
the processes it starts every variable whose name looks like a secret, and
`CLAUDE_MGR_API_TOKEN` matches. Without it a Gemini agent's hooks could not
report to Tars at all, so Tars adds that one name to
`security.environmentVariableRedaction.allowed` in `~/.gemini/settings.json`
(`allowAgentToken`, `electron/utils/gemini-node-hooks.ts`): on win32 since
#355, on every platform since 1.9.6. What that exposes: the agent's token now
reaches Gemini's hooks, the commands its shell tool runs, and every stdio MCP
server Gemini starts, third-party ones included, which Gemini always withheld
it from before. No narrower option exists: the allowance is one list in one
settings file shared by every Gemini agent, and anything a hook is given
from that file is the same for all of them, so it cannot carry a token minted
per terminal. It
is no loss under this section: every one of those processes runs as the same
user and could already read the token from the CLI's environment, as measured
above.

**Never in a command line.** The arguments of a process are another matter:
every account on the machine reads them (`ps`; `/proc/<pid>/cmdline` on Linux),
where the environment is read by this user's own processes only. A delegated
run handed its MCP servers its token in the list of servers ACP carries, and
the claude adapter writes that list into the `--mcp-config` JSON of the claude
it starts: measured on 2026-10-17, and again on 2026-10-18, with
claude-agent-acp 0.93.0, the run's token was in that process's arguments.
Since 2.0.4 the list carries `CLAUDE_MGR_API_TOKEN_FILE`, the path of a `0600`
file in a `0700` folder of the run's own, removed when the run ends, and the
servers read the token there (`mcp-shared/src/tars-api.ts`). A folder a run or a
crash left goes at Tars's next start; it names the Tars that made it, so another
Tars's run under way keeps its own (`services/acp/run-token-file.ts`). Measured the same
way: the path is in the arguments, the token is not. This is the one place a
`0600` file buys something: nothing against this user's processes, which read
it as they read the environment, but out of the other accounts' sight. A
terminal's token never went there: spawnAgentPty puts it in the environment,
and the shell hooks hand it to curl with `-H @<(printf ...)`, a builtin, never
an argument.

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
  `~/.tars` (the fleet's settings, every provider API key, the shared token,
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

**What a repository's own configuration can no longer run** (2.0.4, the Audit's Hole 3, `utils/safe-git.ts`).
Any agent of a project, or anything it runs, can write that project's `.git/config`, and git runs the
programs it names: `core.fsmonitor` on a status, `diff.external`, a diff command or a textconv on a diff, a
filter's clean, smudge or process when a file meets the index, the hooks on a checkout, a commit or a ref
update, `gpg.program` on a signed commit, and the verifier of each signature format (`gpg.program` or
`gpg.openpgp.program`, `gpg.ssh.program`, `gpg.x509.program`) on a log or a show of a signed commit, which
`log.showSignature` asks for every time (the Audit's M1 on #463). Opening Review ran them inside Tars's main process, outside every
CLI's permission mode. Every git call the main process makes now switches them off on its command line,
which git reads after every configuration file, so neither the repository's, the user's nor the system's
configuration can turn one back on; submodules are not entered; Review reads no file through a link out of
the repository; git gets an environment of Tars's own. Measured with a repository that names a program at
each of these places (`__tests__/fixtures/hostile-repo.ts`): on main its fsmonitor, its submodule's, a hook
and its filter ran on Review's first status and diff; now none does, in the unit tests and in the real app
(`e2e/review-hostile-repo.spec.ts`). What it is not: an agent's own CLI runs git with the repository's
configuration, in its own permission mode, as it always did.

Review reads only what Tars found (2.0.4, the Audit's R2.4): a repository a scan
found in a project Tars knows (its list, its agents' folders), a project, or an
agent's folder. `review:diff`, `review:file` and `review:repo` took any path the
window named, and ran git there. The scan of a project follows no link, so a
link to the home in a project brings none of its repositories in, and reads no
file outside git; the search matches names and paths Tars already holds, so a
query is text, never an option or a pattern.

## 5. What is where on disk

| Path | Holds | Reachable by an agent |
|---|---|---|
| `~/.tars/` | the fleet, the settings without their secrets (`app-settings.json`: since 2.0.4 no key, token or password, the paragraph below the table), the vault, the bus journal, Tars's health samples (`health-samples.jsonl`, 24 h, numbers with the names of Tars's own calls and pages, `0600`, and on Windows closed to every account but the user's and SYSTEM, like `app-settings.json`: an agent may write it, so every line is rebuilt from numbers and checked words before anything is read or sent, SPECS.md, Error reports), and the files staged for a room (`bus-files/`, a week, then removed), and each agent's temporary folder (`tmp/`: its commands' temporary files and Claude Code's scratchpad and background task output, kept 7 days, a day for a running agent's leftovers), and the task ledger (`task-ledger.jsonl`: who handed each task to whom, when it started and ended, its sessions and what it cost, without what it said) | Yes, deliberately: it is in every agent's `--add-dir`. A file sent to one room can be read by every agent of every project, as its journal can; `bus-files/` is refused when it is a link, and each file is written in a folder of its own that must not exist yet |
| `~/.tars-private/` | every secret of the settings (`settings-secrets.json`, since 2.0.4: the bots' tokens, every provider's and CLI's key, SocialData's and X's, Jira's, Hermes's gateway token, the memory backends'), the local API's shared token (`api-token`), the Hermes gateway's connection and session cookies (`hermes-connection.json`, `hermes-session.json`; all three in `~/.dorothy` until 2.0.4), JeanBrasse's conversation with the super chat, the receipts of sends made with a `clientRequestId` (`request-receipts.jsonl`, 24 h, never the text) and what delegated runs answered (`task-results.jsonl`), the Hermes sessions it held that conversation in (`overseer-hermes-sessions.json`), the questions agents asked the user with `ask_user` and the Telegram messages they went out as (`user-questions.json`: kept here and not in `~/.tars`, which any agent can write, so no agent can point an answer at another), what the event reports counted and the GitHub watch has seen (`event-reports.json`, `github-watch.json`: kept out of the agents' reach so none can silence a report), the Hermes dashboard's token (`hermes-token`, JeanBrasse's decision 6 of 2026-10-01), what the relay sent and what waits for Hermes (`relay-sent.json`, `relay-outbox.json`, `relay-state.json`; each sent message with the chat it came from), what Tars's own Telegram bot sent for a chat (`telegram-sent.json`: Telegram's chat and message ids and the chat's id, never the text, 7 days: an agent able to write it could point the user's next reply at another chat), the user's go-aheads on Sentry's errors (`sentry-go-aheads.json`: an agent able to write it could hand a task on in the user's name), the error triage's Sentry token (`sentry-token`: it reads the organisation's issues, user reports included; in `app-settings.json` until 1.9.3, moved at the first start), the Hermes webhook secret, and the Claude accounts' registry (`claude-accounts.json`: the option, each account's id and name, the thresholds; no credential and no folder), and what carries across a restart (`run-state.json`: who was working, a task's first 200 characters; `carry-over.json`: the notes Tars owes agents), and what each task of the task ledger said (`task-texts.jsonl`: its first line, 200 characters at most, which holds JeanBrasse's typed prompts and the chat messages handed to orchestrators; in `task-ledger.jsonl` in `~/.tars` before 1.9.3 shipped, moved out at the first start, JeanBrasse's answer of 2026-10-05). Those two were in `~/.tars` until the Audit's gate of #310: a `carry-over.json` written by an agent had Tars type "Message from Telegram (JeanBrasse): ... I approve." into the orchestrator, and a `run-state.json` had it start the agents it named, in any project. A sender read back from `carry-over.json` is never typed as one either: a carried note goes as from Tars, its first sender quoted inside it | Not handed to any agent, never passed to a CLI, and refused by both ways an agent has of sending a file to Telegram and by the vault's attach route. create_agent and update_agent refuse it as the folder an agent is handed besides its project (`secondaryProjectPath`, passed as `--add-dir`), with a folder inside it and one that holds it, the home folder included, by its spelling and by where its links lead (`utils/handed-folder.ts`). Each file `0600`, in a directory Tars makes `0700`. The conversation also lives in Hermes, one session per turn: `memory_search` (`/api/memory/search`, what agents call) leaves out every session the super chat opened, every run of its cron job (recorded when it runs, so a run of a job replaced since is still left out), a session Hermes compressed out of one of those (the gateway answers a compressed conversation under its newest id, with its `lineage_root` and `parent_session_id`, which are checked too), a session branched or delegated from any of those (the gateway's lineage stops at a branch or a delegate edge, so each parent is read further up through `GET /api/sessions/{id}`, to a root; an ancestry that cannot be read to its end, a cycle, or more than 20 parents leaves the hit out), and any hit that names no session. The gateway is asked for its most (100) and the filter runs before the agent's `limit` is applied, so the super chat's hits do not take an agent's places. When 100 or more of the super chat's lineages match before any of JeanBrasse's, an agent gets no Hermes hit: the gateway gives no further page. Sessions opened before 1.9.0 were not recorded, so only their cron runs are left out; an agent holding `hermes-connection.json` can still ask the gateway itself (§5, the paragraph below) |
| `~/.claude-accounts/<id>/` | each Claude account after the first, with several on: a Claude Code folder of its own, with its own `.claude.json` (the account's identity) and a copy of `~/.claude/settings.json`, its transcripts, history, sessions, CLAUDE.md, skills, agents, commands, plugins and output styles being links to `~/.claude`. The sign-in is Claude Code's, in the keychain item named after the folder (`.credentials.json` on Linux): Tars never opens it | Not in any agent's `--add-dir`; the agents started on an account run in its folder (`CLAUDE_CONFIG_DIR`), as account 1's run in `~/.claude`, and a folder that is not Tars's own is refused, never repaired |

**The secrets out of `~/.dorothy` (2.0.4, JeanBrasse's decision of 2026-10-18).** Until 2.0.4
`app-settings.json` held every key of the app (the bots' tokens, each provider's key, each CLI's key,
SocialData's, X's four, Jira's, Hermes's gateway token, gbrain's and Honcho's), and `~/.tars` is in every
agent's `--add-dir`: any agent of any CLI read them with one `cat`, and its MCP servers read them on purpose.
They are in `~/.tars-private/settings-secrets.json` now (`services/settings-secrets.ts`, `0600` in a `0700`
folder, written atomically), and so are `api-token`, `hermes-connection.json` and `hermes-session.json`. The
first start of 2.0.4 moves them: each key of the live file and of every copy of it beside it (a `.bak`, a
`.tmp` a write left; a copy's key only where the private file has none) is written to the private file first,
then each copy is overwritten with zeros and removed, then the live file is written again without them. A stop
anywhere is finished by the next start; a private file that cannot be read is never written over, and a live
file that does not parse is left as it is. What it closes and what it does not:

- **Closed**: an agent reading a key out of the folder it is handed, and listing it there. The MCP servers that
  called a service with a key of the user's (Telegram, X, SocialData) ask Tars instead, with their agent's own
  token (`/api/telegram/send*`, `/api/x/request`, `/api/socialdata/request`), and Tars makes only the calls their
  tools make: a post, a reply or a delete on X while Posting is on, SocialData's Twitter reads, a send to a chat
  the user authorized. No hook and no Tars MCP server presents the shared token any more, from either place;
  a CLI Tars did not start reads nothing from Tars. The agents on Tars's OpenAI bridge (Venice, a custom endpoint) present the bridge's own token
  (`~/.tars-private/bridge-token`, `services/bridge-token.ts`), which the bridge alone takes and the API refuses:
  they were handed the shared token, and an agent in bypass read it in its environment (the Audit's L3 on #466).
- **Not closed**: an agent in bypass mode runs as the user and reads the whole disk, `~/.tars-private`
  included (§1: no confinement, JeanBrasse's decision of 2026-09-23). An agent's own key is in its environment,
  as its CLI needs it (a CLI's key, `ANTHROPIC_AUTH_TOKEN` for the providers on the claude binary), and so is
  readable to it and its children; a process's environment is the user's to read too: on macOS 26 `ps -E` and
  `ps eww` showed no other process's (measured on 2026-10-18), and on Linux `/proc/<pid>/environ` is readable by
  the same user (procfs's rule, not run here). gbrain's and Honcho's keys go into `~/.claude.json` as their MCP
  servers' `Authorization` header, since every claude agent's CLI calls them itself (`setupMemoryBackends`): any
  agent that reads that file reads them. An agent that read a key before 2.0.4 still has it: rotating it is the
  only cure. The zeros written over a copy land in new blocks on a copy-on-write disk (APFS, btrfs): the old
  blocks are freed, not wiped. A hard link made to the private file before a save keeps the old contents (a save
  writes a new file); the window's channels refuse a file linked into the private folder, which they can tell.

So what the kanban tools let an agent do on the Hermes board (since #183, delete
only a task it filed that nobody claimed, or one it claimed) is a rule of Tars's
own tools, not a barrier: an agent that holds the dashboard's token can call the
gateway with it and edit or delete any task (the audit's gate of #183). Since
1.9.3 that token is in `~/.tars-private/hermes-token`, out of the folder every
agent is handed; an agent in bypass, which runs as the user, can still read it
there (no confinement, JeanBrasse's decision of 2026-09-23).

**A key provider's key goes to Claude Code as `ANTHROPIC_AUTH_TOKEN`**
(`keyProviderEnv`, `electron/providers/cli-provider.ts`). Measured on claude
2.1.302 on 2026-10-18, in a throwaway home against a stand-in of the vendor: an
API key Claude Code finds in its environment is not used until someone answers
"Do you want to use this API key?" at launch, No preselected. Until 2.0.4 Tars
handed every key provider's key over that way, so the question waited in a
terminal nobody watches, and the first Enter typed there, Tars's own included,
answered No. The key was then refused for good in that folder's `.claude.json`,
and a session with a subscription signed in sent the subscription's OAuth token,
with its first request, to the vendor's URL. An auth token is never asked
about, wins over a signed-in subscription (the stand-in got the key, never the
OAuth token) and is written nowhere. `ANTHROPIC_API_KEY` is blanked: a key the
user's shell exports would bring the question back, and go out to the vendor as
`x-api-key`. Approving the key in `.claude.json` would have stopped the question
too, and left the key's last 20 characters there and in each backup Claude Code
makes of the file.

No scheduled task of Tars's hands a key to `claude -p` any more: the builders of
scheduled scripts each provider kept had no caller since 87507e03 removed the
Automations and Scheduled Tasks before 1.8.0 (the Schedules page drives Hermes's
crons), and they went in 2.0.4 with the key reading they carried (the QA's gate of
#458).

What Tars before 2.0.4 left of those keys is cleaned once, at the first load of
an `agents.json` from before it (`core/key-fragments.ts`): the question showed
the key's last 20 characters (`sk-ant-...` then those 20), which the agents'
kept output held in `agents.json` and `agents.backup.json`, in every agent's
reach; they are masked there, the rest of the output kept. And Tars's keys' last
20 characters are taken out of the `customApiKeyResponses.rejected` list of
`~/.claude.json` and of each account folder's, and of the copies Claude Code
keeps of each (its backups in the config home's `backups/`, one a minute at most,
the last five kept, and a write of its own it never finished, beside the file),
the user's own entries left, each file changed the way Tars writes its trust
there (`updateSharedJsonSync`). A key since replaced in Settings is masked in the output, which shows it under the
question's masking, but not found in a rejected list, which holds the 20
characters alone.

Nor is the line every task Tars files carries since 2.0.4 ("Tars task: it belongs to Tars's
agents, ..."): it is a label for whoever opens the task. Hermes's assistant, whose board listing does not
show a task's description (0.21.5), can still finish, block, unblock or send to review a Tars task,
and none of that starts anything on a `tars:` lane. What
keeps Hermes's dispatcher off a Tars task is Hermes's own rules, measured on 0.21.1 and 0.21.5: a
task parked `scheduled`, or `ready` on a `tars:` lane that is no Hermes profile, is neither
spawned, promoted nor decomposed. Whoever can move a task on the gateway can still put one where
Hermes acts.

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

The chats' records (`chats.json`) and the fleet (`agents.json`) are in `~/.tars` too, so the runner a chat's record names, and an agent's mark as a chat's runner (`kind: 'chat'`, which carries the orchestrator's powers), are claims. Tars types, launches, counts, puts to sleep or renames nothing for the agent a record names until the fleet agrees (`recordedRunner`: Main's runner is the project's orchestrator, any other chat's the runner made for it, in its project). At each launch an agent marked as a runner that no chat names goes back to a plain worker (`unconfirmedRunners`). An agent that edits both files can still mark itself a runner for the next launch, as it can give itself the orchestrator's role in `agents.json`: these checks are defence in depth, not a boundary (the Audit's L1 on #379).

What an agent waits on (`waitingOn`, the command or question of an open dialog) is kept in memory only: it is not written to `agents.json`. While the dialog is open, another agent can read it through `GET /api/agents/:id?full=true`, as it can read the rest of that agent's record; a command typed with a secret in it is visible there for that long. The hook sends only the fields that name the dialog, each cut at 1000 characters, never a tool's whole input.

`~/.tars-private/overseer.json` used to be `~/.tars/overseer.json`: 148,654
bytes, 344 messages, mode `0644`, in the directory every agent is pointed at.
Reading it took no API call and no token.

Moving it is worth exactly what it is worth, and no more: it leaves the
directory an agent is handed and the listing it gets for free, and the `0600`
closes it to the other accounts on the machine. An agent that goes looking for
`~/.tars-private` still reads it, because §1. Closing that is §4, or nothing.

The move first took it off a list, which the audit of `bad8c97` caught on the
app's Telegram send routes, and which held for the agents' Telegram MCP server
too: both refuse `~/.tars` by name, and refused nothing under
`~/.tars-private`, so the conversation could be sent from where it had landed
with one call. Both refuse the private directory now. The vault's attach route
was a third way, measured on the same branch: it copies the file its caller
names into `~/.tars/vault/attachments`, where `/api/local-file` serves it
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
`fs:read-project-files`, `local-file://`) confine a path to a list of roots.
Since 2.0.4 (the Audit's Holes 1 and 2, `electron/utils/window-file-access.ts`)
`fs:write-text-file` writes only the instruction files the Brain edits:
`~/.claude/CLAUDE.md`, `~/.tars/CLAUDE.md` and a project's `CLAUDE.md` or
`.claude/CLAUDE.md`; it wrote any text under `~/.dorothy`, the CLIs' folders and
the projects, `statusline.sh` (which Claude Code runs every turn) and
`bin/tars-mcp-node` (which every Tars MCP server runs on) included, so one call
from a compromised page ran code in every agent. `fs:read-text-file` reads the
CLIs' folders and the projects, and of `~/.tars` only its `CLAUDE.md`;
`local-file://`, which no page uses in 2.0.4, serves the vault's attachments,
the project-files folders and Claude Code's memory folders. None of them, nor
`fs:read-project-files`, hands the window a secret: nothing under
`~/.tars-private`, by spelling, by real path or by a hard link into it, and no
file named as one (the settings and their copies, `api-token`, the Hermes files,
`.credentials.json`, codex's `auth.json`, gemini's `oauth_creds.json`, `.env`
and every `.env.*`, `.netrc`, a key), no CLI settings that hold a key (Claude
Code's `settings.json` and `settings.local.json`, whose `env` may set one, Grok
CLI's `user-settings.json`), and nothing in a folder of credentials (`~/.ssh`,
`~/.gnupg`, `~/.aws`, `~/.config`, `~/.kube`, `~/.docker`), as spelled or where
it really lies, whatever names that folder as a project: a page could add any
folder as a project and then read it, GitHub's token in `~/.config/gh` or a
cluster's in `~/.kube` (the Audit's L1 on #466). `fs:add-custom-project` refuses
such a folder, and since the projects' list lives in `~/.tars`, which every
agent can write, each read judges its own target as well. `app:getSettings` and `settings:updated` carry no secret: a
set one is a mask of bullets and `secretsSet` says which are set; `secrets:set`
sets or clears one and answers whether it is set. Settings puts no mask in a
field (`components/Settings/SecretRow.tsx`): a set secret reads set, replace
opens an empty field, and no save sends a secret, so nothing typed after a mask
is ever taken for a new key (`lib/secret-settings.ts`). The last three the window
saw go through the main process since the Audit's L2 on #466
(`services/secret-handoff.ts`): the Telegram auth token Settings mints is shown
once in a dialog of the main process, which the page cannot read, and
`telegram:authToken:copy` copies it again; the webhook secret Hermes is given is
copied by `hermes:webhookSecret:copy`, and `hermes:getConnectionInfo` says only
that it is set; the Hermes form gets the dashboard's token as the mask, and a
save of the mask, or of nothing, keeps it. Each answer to the page holds none of
them: a page that read one kept a way in after it was fixed (an attacker's
Telegram authorized to drive agents, Hermes reconfigured, posts to Tars as
Hermes). Before 1.9.2 the roots were `~/.dorothy`, the CLIs' folders and
the projects. Until 1.9.2 a root could be
the home or a folder above it (a project added as `~` or `/Users`, or written
into `projects.json`), and the path was judged as spelled while the read or
the write followed links: one symlink under `~/.tars` or in a cloned
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
in `~/.tars/vault/attachments` served, to any process on the loopback,
another account's included, the file it named or every file under the folder
it led to. What is left:
the check and the read are two calls, so a link swapped in between is
followed, by a process that could open the file itself (§1).

The Vault's channels for each project's folder (2.0.4, `vault:project-folders`,
`vault:project-files`, `vault:project-file:read`, `vault:project-file:write`,
`vault:project-file:show`, and since 2.0.5 `vault:project-place`,
`electron/services/vault-project-files.ts`) take a folder's key, a place (a
list of at most 16 folder names, or `reports` or `tools` as in 2.0.4), and a
file name, never a path, each one segment (no separator, no colon, no NUL, not
hidden). A heavy folder (`node_modules`, `.git`, `.venv` and the like) is
named, never opened. Every folder and file is checked where it really lies, at
every level of the place and the whole path again at the end: a symbolic link,
a second name (a hard link) or a folder that is a link is never read, written
or gone through; a link is listed with its target as written, never followed.
Since 2.0.5 that holds for `~/.tars/project-files` itself too: a link in its
place (planted as `-> ~`, it would open the whole home folder) is refused, where
2.0.4 followed it into `reports/` and `tools/`. A heavy folder named in another
case, which a file system that folds case opens as itself, answers `heavy`.
The window
writes text and scripts only (`.md .txt .json .yaml .yml .sh .py .ts .js .mjs`),
1 MB at most, no NUL, to a new file of its own renamed over the old one, 0600
and never executable, and never over a file that changed since it was opened.
What a compromised window can still do there: write text into any folder of
the project folders Tars keeps (`reports/` and `tools/` until 2.0.5), which
that project's agents read
and may run (`bash tools/x.sh`), and nothing else under `~/.tars` or in a
repository. An agent of the project reads and writes the same folder (it is in
its `--add-dir`): the folder is shared with every agent of the project, and is
no boundary between them.

Made on a new install by the first save, the directory came out `0755`, since
only the migration asked for `0700`. Whichever write makes it now, the
migration or the first save of the conversation or of the webhook secret, makes
it `0700`. A directory that already exists at another mode is left as it is.

**A Qwen Code agent and the administrator's system settings (2.0.4, the Audit's M1 on #461).** Tars hands
each Qwen Code agent a settings file of its own through `QWEN_CODE_SYSTEM_SETTINGS_PATH` (its hooks, Tars's
MCP servers, its effort, qwen's updater off). That variable names qwen's system settings slot, the file through
which an administrator enforces controls over the user's and the project's settings: a tool denylist
(`permissions.deny`, `tools.disabled`), disabled slash commands, fixed MCP servers (qwen 0.25.2's
`docs/configuration/settings.md`). Its default is `/Library/Application Support/QwenCode/settings.json`,
`/etc/qwen-code/settings.json` or `C:\ProgramData\qwen-code\settings.json`, or what
`QWEN_CODE_SYSTEM_SETTINGS_PATH` names in the environment Tars was started with. Pointing the slot at Tars's file
dropped those controls without a word. Since this fix the administrator's file is read again at each launch and
merged over Tars's (`underAdministrator` in `services/qwen-code.ts`): their value wins wherever both set one, a
hook list is both lists (their hooks run, then Tars's), any other list is theirs alone (an allowlist is never
widened), and an MCP server they name is theirs whole. One that cannot be
read (not JSON, a folder, refused) stops the agent from starting, and the start says which file and why. What it
does not close: Tars's agent files sit in `~/.tars/qwen-code/agents`, which every agent can write, so an agent
can change another Qwen Code agent's file until its next launch rewrites it, as it can `statusline.sh`; and qwen's
own system defaults file (`system-defaults.json`, the lowest layer) is left to qwen, which reads it as before.

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

**Which chat a message reaches** (2.0.0, PR F). The bots and the relay take the
user's words to one chat of the project: the one a reply answers, read from the
logs in `~/.tars-private` (never from anything the reply carries), else the one
`#N` names at the very start, else the inbox. Nothing routes by content, and an
`#N` no chat has reaches nobody. A chat's runner gets the words after the
sender line Tars writes for the channel, as the orchestrator does, the
look-alike lines inside quoted; it gets the orchestrator's powers, not a wider
reach: a chat is not a boundary between JeanBrasse's conversations, they share the
team. `chats.json`, which names each chat's runner, is in `~/.tars` and an
agent can edit it: a record whose runner the fleet does not confirm gets
nothing typed or launched for it (PR D), and that holds for the senders too.

**The chats reading one another** (`chatsReadEachOther`, off by default) is an
option, not a boundary. On, a chat's CLI started after it gets `chat_list`,
the project's other chats by number, title, state and last activity; the route
reads the setting at every call and the caller's chat from its token, and
answers a chat's agent of the same project only. Off, the tool is not
registered at all. What a chat can do without it does not change: its CLI runs
as the user, and the runners' transcripts are files under `~/.claude` it can
read. The option decides what Tars hands it, not what it can reach.

## 7. Windows

What changes on Windows, measured on Windows 11 (26200) between the 25th of
September and the 13th of October 2026. Everything above holds there too: the
agents run as the user, and nothing here confines them.

**Secrets are closed by their access list, not by a mode.** `0o600` and `0o700`
do nothing on Windows: Node maps chmod to the read-only bit. A secret file and
`~/.tars-private` get an access list instead: the current user and SYSTEM, full
control, nothing inherited (`platform/owner-only.ts`, `utils/secret-file.ts`).
A secret is born closed: its temp file is made in `~/.tars-private/.staging`,
which holds that list before its first byte, then renamed into place. icacls and
whoami are run by their full path under `%SystemRoot%\System32`, the user named
by SID. What this keeps out is the other accounts on the machine, Codex's
sandbox accounts included (Codex adds `CodexSandboxUsers` to the folders its
sandbox reads); not the agents, which run as the user, and not an administrator,
who can take the file back. **A close that fails leaves the file with the list
it inherited, and says so in the log only** (`[secret-acl]`): the write goes on,
and nothing in the window says it.

**Paths that would reach the network or another namespace are refused.** A
notification sound must be a local `X:\...` `.wav`: a UNC path (`\host\...`)
would be opened, and opening it sends the account's NTLM hash to that host;
`\?\`, relative and drive-relative paths are refused too, and so is a link to a
share, a device or an NT path (`platform/sound.ts`). The file reaches a fixed
PowerShell script as data, in a variable, never pasted into code. SystemRoot,
and in the shell picker ComSpec, ProgramFiles and LOCALAPPDATA, count only as
plain absolute paths.

**Gemini's environment redaction lets the agent token through.** With
`security.environmentVariableRedaction.enabled` on, Gemini CLI drops every
variable whose name holds TOKEN from what its hooks get, and every hook post was
refused. Tars adds `CLAUDE_MGR_API_TOKEN` to
`security.environmentVariableRedaction.allowed` in Gemini's settings
(`utils/gemini-node-hooks.ts`), on every platform. The token is per terminal and
dies with it (§3); the user's own entries are kept.

**Nothing is looked up in a project's folder.** Node on Windows looks a bare
program name up in the folder it is started in before the PATH, and Tars starts
git in a project's folder: a repository carrying a git.exe of its own had it
run, by the status line every 5 s and as soon as the project was listed.
Measured on the 13th of October with Node 22 and Electron 44: a planted git.exe
ran; `NoDefaultCurrentDirectoryInExePath=1` in the child's environment did not
stop it, in the starting process's own did. So Tars runs the git.exe on the PATH
by its full path (`platform/git-command.ts`), the status line walks the PATH
itself, and `NoDefaultCurrentDirectoryInExePath=1` is set in Tars's own
environment at start and in every agent's (`core/agent-pty.ts`), whose CLIs look
up git and rg the same way. taskkill, icacls, whoami and PowerShell are always
run by their full path under `%SystemRoot%\System32`.

**The installer and the updates are not signed.** SmartScreen warns on the
installer's first run, and `electron-updater` installs an update without
checking a publisher: whoever can write to the releases of
`cooper-labs-tech/Tars` ships code to every Windows install. On macOS the
update must carry the app's own signature; on Windows nothing stands in for it.
