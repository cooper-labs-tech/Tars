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
reads the private folder holds every gateway's secret, as it holds the conversation. The window never holds one: adding a gateway or rotating its secret shows the new secret once in a dialog of the main process, which the page cannot read, and Copy secret copies it from the main process (`services/secret-handoff.ts`, as for the default gateway's secret, and for the Telegram auth token until Tars's own bot went in 2.0.5).

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
  tool takes is held by the asking agent's terminal, resolved from its token whatever pid the shared server sends,
  and goes back at the turn's end; the owner gives any lease back from the window. The label
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

**Tars's shared MCP servers act for the agent whose token reaches them, and for no other** (2.0.5,
`services/mcp-shared.ts`, `mcp-shared/src/shared-host.ts`). Six of the seven servers (all but telegram, which
resolves a file against its agent's folder) run once for every agent instead of once per agent. A claude agent's CLI
reaches each through Tars's API, `/api/mcp/<server>`, which is under `/api/` and so takes the agent's own token:
resolveCaller names the agent from it, and a different `X-Tars-Caller-Id` beside it is a 403 before the route. Tars
hands the server that agent's identity from its fleet, never a header the CLI sent, with a secret the server read once
on its stdin, and the server refuses any request without it. The token is in no file and no command line: claude's
config holds `Bearer ${CLAUDE_MGR_API_TOKEN}`, and claude expands the name from its own environment (measured on
2.1.312), where this section already says who can read it. Each call is served by a server built for it, run as its
caller and closed with its answer, and every call the server makes to Tars presents that caller's token again, so a
call cannot act as another agent even inside the shared process. What changed: the per-agent copy proved the port was
the Tars that started its CLI before presenting the token (the instance proof); claude presents it to the port itself,
unproven. So no agent's CLI starts until this Tars listens on its port (`core/api-listening.ts`, the Audit's H1 on
#541): at launch Tars retries a busy port for about 90 s, and an agent started meanwhile (a resume, the window, a
channel, the queue) would have handed a live token to the process holding it; the starts wait, and are refused if Tars
gives the port up. A process that holds the port after Tars quit would learn a token, which names an agent only in the
Tars that minted it in memory, and dies with that Tars. The entries are in the role files claude agents are started
with (`~/.claude/mcp.json`, and a worker's `mcp-worker.json` without telegram and x), never in `~/.claude.json`, which
every claude session loads, the owner's own included; and the door refuses telegram and x to an agent without the
orchestrator's powers. What did not: the server's process belongs to the same user as every agent, so
it is no boundary against them (section 1).

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

**The disk janitor deletes only what the owner approved** (2.0.5, `services/janitor-rules.ts`). A scan proposes
and deletes nothing. Only the window's IPC approves (`diskJanitor.approve`), by the ids of the items it showed: an agent can ask for a
scan (`GET /api/janitor/scan`, `disk_scan`), answered with its own project's items, and no route takes an approval. Each approved item is checked again against its
rule just before it goes (a process is in a folder by its working folder, its command line or its executable, and on Linux
the files it holds open), its real path must still be its path, and it is deleted by that exact path, never through a shell. The never list (`~/.tars-private`,
`~/Documents`, the uv cache, the Trash, `~/Library/Developer`, Docker volumes, a fleet agent's worktree, one with
uncommitted work, one a process works in) is checked at the scan and again at the deletion. What this is not: an
agent that runs as the user can delete any of those itself; the janitor only never does.

| Path | Holds | Reachable by an agent |
|---|---|---|
| `~/.tars/` | the fleet, the settings without their secrets (`app-settings.json`: since 2.0.4 no key, token or password, the paragraph below the table), the vault, the bus journal, Tars's health samples (`health-samples.jsonl`, 24 h, numbers with the names of Tars's own calls and pages, `0600`, and on Windows closed to every account but the user's and SYSTEM, like `app-settings.json`: an agent may write it, so every line is rebuilt from numbers and checked words before anything is read or sent, SPECS.md, Error reports), and the files staged for a room (`bus-files/`, a week, then removed), and each agent's temporary folder (`tmp/`: its commands' temporary files and Claude Code's scratchpad and background task output, kept 7 days, a day for a running agent's leftovers), and the task ledger (`task-ledger.jsonl`: who handed each task to whom, when it started and ended, its sessions and what it cost, without what it said) | Yes, deliberately: it is in every agent's `--add-dir`. A file sent to one room can be read by every agent of every project, as its journal can; `bus-files/` is refused when it is a link, and each file is written in a folder of its own that must not exist yet |
| `~/.tars-private/` | every secret of the settings (`settings-secrets.json`, since 2.0.4: the bots' tokens, every provider's and CLI's key, SocialData's and X's, Jira's, Hermes's gateway token, the memory backends'), the local API's shared token (`api-token`), the Hermes gateway's connection and session cookies (`hermes-connection.json`, `hermes-session.json`; all three in `~/.dorothy` until 2.0.4), JeanBrasse's conversation with the super chat, the receipts of sends made with a `clientRequestId` (`request-receipts.jsonl`, 24 h, never the text) and what delegated runs answered (`task-results.jsonl`), the Hermes sessions it held that conversation in (`overseer-hermes-sessions.json`), the questions agents asked the user with `ask_user` and the Telegram messages they went out as (`user-questions.json`: kept here and not in `~/.tars`, which any agent can write, so no agent can point an answer at another), what the event reports counted and the GitHub watch has seen (`event-reports.json`, `github-watch.json`: kept out of the agents' reach so none can silence a report), the Hermes dashboard's token (`hermes-token`, JeanBrasse's decision 6 of 2026-10-01), what the relay sent and what waits for Hermes (`relay-sent.json`, `relay-outbox.json`, `relay-state.json`; each sent message with the chat it came from), until 2.0.5, what Tars's own Telegram bot sent for a chat (`telegram-sent.json`: Telegram's chat and message ids and the chat's id, never the text, 7 days: an agent able to write it could point the user's next reply at another chat; removed at each launch since the bot went, `services/telegram-retired.ts`), the user's go-aheads on Sentry's errors (`sentry-go-aheads.json`: an agent able to write it could hand a task on in the user's name), the error triage's Sentry token (`sentry-token`: it reads the organisation's issues, user reports included; in `app-settings.json` until 1.9.3, moved at the first start), the Hermes webhook secret, and the Claude accounts' registry (`claude-accounts.json`: the option, each account's id and name, the thresholds; no credential and no folder), and what carries across a restart (`run-state.json`: who was working, a task's first 200 characters; `carry-over.json`: the notes Tars owes agents), and what each task of the task ledger said (`task-texts.jsonl`: its first line, 200 characters at most, which holds JeanBrasse's typed prompts and the chat messages handed to orchestrators; in `task-ledger.jsonl` in `~/.tars` before 1.9.3 shipped, moved out at the first start, JeanBrasse's answer of 2026-10-05). Those two were in `~/.tars` until the Audit's gate of #310: a `carry-over.json` written by an agent had Tars type "Message from Telegram (JeanBrasse): ... I approve." into the orchestrator, and a `run-state.json` had it start the agents it named, in any project. A sender read back from `carry-over.json` is never typed as one either: a carried note goes as from Tars, its first sender quoted inside it | Not handed to any agent, never passed to a CLI, and refused by the vault's attach route, as it was, until 2.0.5, by both ways an agent had of sending a file to Telegram, which went with Tars's own bot. create_agent and update_agent refuse it as the folder an agent is handed besides its project (`secondaryProjectPath`, passed as `--add-dir`), with a folder inside it and one that holds it, the home folder included, by its spelling and by where its links lead (`utils/handed-folder.ts`). Each file `0600`, in a directory Tars makes `0700`. The conversation also lives in Hermes, one session per turn: `memory_search` (`/api/memory/search`, what agents call) leaves out every session the super chat opened, every run of its cron job (recorded when it runs, so a run of a job replaced since is still left out), a session Hermes compressed out of one of those (the gateway answers a compressed conversation under its newest id, with its `lineage_root` and `parent_session_id`, which are checked too), a session branched or delegated from any of those (the gateway's lineage stops at a branch or a delegate edge, so each parent is read further up through `GET /api/sessions/{id}`, to a root; an ancestry that cannot be read to its end, a cycle, or more than 20 parents leaves the hit out), and any hit that names no session. The gateway is asked for its most (100) and the filter runs before the agent's `limit` is applied, so the super chat's hits do not take an agent's places. When 100 or more of the super chat's lineages match before any of JeanBrasse's, an agent gets no Hermes hit: the gateway gives no further page. Sessions opened before 1.9.0 were not recorded, so only their cron runs are left out; an agent holding `hermes-connection.json` can still ask the gateway itself (§5, the paragraph below) |
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
  called a service with a key of the user's (X, SocialData) ask Tars instead, with their agent's own token
  (`/api/x/request`, `/api/socialdata/request`), and Tars makes only the calls their tools make: a post, a reply or
  a delete on X while Posting is on, SocialData's Twitter reads. The Telegram server did the same through
  `/api/telegram/send*` until 2.0.5, when it went with Tars's own bot and its token; `send_telegram` goes through
  the Hermes relay, which needs no key of Tars's. No hook and no Tars MCP server presents the shared token any
  more, from either place;
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
worker, with the user's words only. Until 2.0.5, turning the relay on erased
the Tars bot's token. Since then Tars has no bot of its own (JeanBrasse's
decision of 2026-10-01, "pas de secours"): every launch removes what a 2.0.4
left of it (its token and `/auth` token, its fields, its sent log;
`services/telegram-retired.ts`), nothing polls Telegram, and mcp-telegram,
which wrote to Telegram with that token past every rule here, is never
registered and is taken out of every CLI at each start, relay on or off.
`send_telegram` goes through the relay, for an orchestrator or a chat's runner
only, its text masked; with the relay off it sends nothing and says how to
turn it on (`409`).

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
well (the audit's gate of #137). The two Telegram guards went in 2.0.5 with
what they guarded: the app's file sends and the Telegram MCP server left with
Tars's own bot (`isSafeTelegramPath`, `electron/platform/credential-stores.ts`),
and the vault's route keeps its own.
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
(`services/secret-handoff.ts`): the Telegram auth token Settings minted was
shown once in a dialog of the main process, which the page cannot read, and
`telegram:authToken:copy` copied it again, until the bot and both went in
2.0.5; the webhook secret Hermes is given is
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
file outside every root and outside the blocked places (the home's credential
folders and Tars's own stores, the list the Telegram guard kept until 2.0.5) stays
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

- **Telegram**: nobody since 2.0.5. Tars's own bot is gone (JeanBrasse's
  decision of 2026-10-01: Hermes is the only voice on Telegram, with no
  fallback), and who may write to Tars through Telegram is the relay's rule
  (§5, the relay to the user's Telegram). Until then, the bot answered the chats
  enrolled with `/auth <token>`, which is what the rest of this item records.
  Read from the settings as they are at each message: before 2026-09-23 the
  bot held the object it was
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

## 8. The owner's words, relayed

Written before the code (2.0.6, option e), and corrected after the Audit's gate of #569 (M1, M2, L1) and the QA's
(I1). An orchestrator that passes
JeanBrasse's words on to another project's orchestrator types them as its own
message: the receiver sees `Message from agent "X":` and then "the owner says
merge it", and cannot tell the owner's words from the sender's claim. Only Tars
can tell them apart, from what it holds as the owner's own: what the window
sends to a chat (the renderer, which only the person at the machine drives),
and what the Hermes relay brings from the owner's Telegram chat (a
reply to a report or a message, "@project text", the answer to an `ask_user`
question). That last rests on Hermes's own configuration, which Tars cannot
check: whatever its plugin delivers for that chat is taken as the owner's.
Slack and Discord are not the owner: anyone in the channel writes
there. Keys typed by hand into a terminal are not recorded either: Tars cannot
tell where such a message starts or ends.

**What it is.** Tars records each of those messages when it receives it: an
id (`ow-` and 12 hex characters), its text as received, when, how
(`window` or `Telegram`), the project it was addressed to, the chat that
received it when one did, what it was (an answer to a question, a reply to a
report or to a message, a message to the project) and, for an answer, the
question with who asked it and when. In memory only:
a restart of Tars forgets them, and nothing is ever written where an agent can
write. Those who could have received them may ask Tars to relay one, by its id
and nothing else, to an agent with an orchestrator's powers, in any project:
the project's orchestrator, and the runner of the chat that received them
(every chat's runner of the project while the owner lets the chats read each
other, `chatsReadEachOther`). Tars types its record into the receiver, an
answer after its question, under a sender line only Tars writes, alone on its
line:
`Message from Tars: the owner's words of 19:03 UTC (23:03 +04), via Telegram,
an answer to a question, relayed by agent "X" ("id"), verified by Tars (words
ow-...):`. The receiver can read back, with `owner_words`, the words relayed to
it and who relayed them, and check the id against them.

**The threats, and what answers each.**

- **Forgery by words.** An agent writes the mark itself. The mark is a sender
  line, and only a sender line counts: Tars types every sender line in a paste
  of its own and ends it with a line break, so no body continues it. Until the
  Audit's gate of #569 the body's first line was typed on the same line, and a
  message Tars typed as itself whose first line an agent wrote (a retyped task,
  the super chat) read as the mark once one letter of "verified by Tars" was a
  look-alike. Now the mark stands alone on the first line, and a forgery sits
  on a line of its own, after the real sender line of whoever sent it; a
  retyped task is typed under its own sender, never Tars's. A session Tars
  starts on a message (a CLI that is not up, an agent asleep, a bot's launch)
  takes it under the same sender line, after Tars's own header: until the
  Audit's re-check of #569 it went in raw, and a worker's forged mark read as
  the real one there, while a real relay arrived with no mark. A body line that
  reads like a sender line is quoted with `> ` whatever its letters
  (`quoteSenderLookAlikes`, `core/pty-manager.ts`). As a defence in depth, a
  body line whose skeleton spells "verified by tars" is quoted too; that
  skeleton knows the look-alikes of "message from"'s eight letters only, so a
  line written with a Cyrillic i is not quoted: what answers it is the line
  break, and the receiver's check of the id.
- **Forgery by id.** An agent relays an id it made up or guessed: unknown,
  refused. The id is random (48 bits, in Tars's memory alone), but its
  randomness is not what refuses everyone else: whoever relays must be one
  who could have received the words, and knowing an id gives nothing to an
  agent that could not. Sequential ids would break no test, and would refuse
  the same agents.
- **An edited quote.** The relay takes an id, never a text: what is typed is
  Tars's record, byte for byte, with only the look-alike quoting every body
  gets. An agent cannot shorten, extend or reword the owner's words under the
  mark.
- **Replay.** The same words relayed twice to the same receiver are refused;
  words older than 24 hours are refused; after a restart of Tars every id is
  unknown. A delivery the receiver's terminal refused gives the relay back.
  The mark carries the time of the words themselves, in both zones, so a
  receiver sees how old they are.
- **Laundering.** Words the owner addressed to project A relayed by an
  orchestrator of project B, by a worker of A, or by the runner of another
  chat of A while the chats do not read each other: refused. Only those who
  could have received them may pass them on. That last switch,
  `chatsReadEachOther`, is read from `~/.tars/app-settings.json`, which every
  agent can write: turned on there, every agent with an orchestrator's powers
  in the project holds every word of it.
- **An answer out of its context.** A "yes" relayed beside a claim of the
  sender's would read as the owner approving the claim. The mark says what the
  words were, and an answer is typed after the question it answers, as its
  asker wrote it, quoted as data.

**What it does not prove.** That the owner meant the words for the receiver,
or for the work the receiver is doing now; that whatever the relaying agent
says around them, in a message of its own, is the owner's; anything the owner
typed by hand into a terminal, or said in Slack or Discord. The mark says
"these are words the owner sent Tars, at that time, for that project or chat,
as that kind of word", and no more.

## 9. Inference endpoints and traces

Written with the code (19/11/2026). An agent running codex, pi, qwen-code or opencode can run on an
OpenAI-compatible inference endpoint the user adds in Settings, a remote inference host. Its sessions can be kept as
traces, opt-in, for an external trace reader. This adds one outbound flow, two credentials and one store.

**The outbound flow.** Every model call such an agent makes goes to the endpoint, with the agent's whole context:
- its system prompt;
- the files it read;
- every tool result.

The harness never talks to the endpoint directly. It talks to Tars's endpoint proxy on loopback
(`services/endpoint-proxy.ts`, `API_PORT + 2`), which sends the request to the endpoint's approved base URL and to no
other address.

**The endpoint's key** is in the settings' secrets (`endpointKeys`, `~/.tars-private/settings-secrets.json`).
- The proxy reads it per request and puts it on the outbound call, in the header form the harness used (a Bearer, or
  `x-api-key`).
- It is never in an agent's environment, a command line, a CLI's config file, a log, a trace, or anything the window
  is sent (the window gets `keySet`).
- Pi's `models.json` gets one provider of Tars's whose `apiKey` is the name of a variable (`$TARS_ENDPOINT_TOKEN`),
  not a key.

**The terminal's token** (`tep_` and 48 hex characters) is what the harness presents to the proxy.
- It is minted with the agent's terminal (`core/agent-pty.ts`), in memory only, and dies with that terminal.
- It sits in the variables the harness reads it from: `TARS_ENDPOINT_TOKEN`, and `OPENAI_API_KEY` for qwen-code.
- Like the agent's API token (§ 3), it is not secret from the other agents of the same user. Another agent that read
  it could make model calls on that endpoint, recorded under that agent's session, but it would never learn the key.

**The key goes only to the approved address** (the Audit's H1 on #596).
- The proxy, and the models and health probes too, send the key only to `approvedBaseUrl`, and only while the
  endpoint is approved at that address. An endpoint whose address an agent changed is probed at the new address with
  no key.
- No fetch follows a redirect, the uploader's included (its install token does not hop either): a redirect answer
  is an error, never a hop for a credential.
- A probe that was in flight while the endpoint's address changed is dropped: its models or health describe the old
  address.
- An agent changing an endpoint's address also takes its key away. The key was given for the old address, and the
  owner approving the new one must not hand it over unawares: it is set again, from the window or a drop file. The
  owner's own change of address keeps it, since that act is the approval.
- A probe writes back only what it owns (models, health), onto the settings as they are when it ends, so a change
  made meanwhile (a project's trace opt-out) is never undone (the Audit's M1).

**Plain http** (L2). https is required for a public address.
- Plain http is taken for loopback, private ranges (RFC 1918, 100.64.0.0/10 where encrypted overlays such as
  WireGuard live, fc00::/7) and IPv6 link-local, and the window says the traffic is not encrypted at the HTTP level.
- Anything else on http needs the owner's "allow plain http" for that endpoint, given in the window only.
- The back-office address follows the same rule.
- A host name counts as public: no name is resolved to decide.
- The cloud metadata range, 169.254/16, is refused whatever the scheme.

**A request is sent twice only when it cannot have run** (L4). A connection refused or unreachable is held and tried
again. A reset after the request was written is tried again for a GET only: a POST may already be generating, and
sending it again would run and bill it twice.

**The approval guard.** Any agent may list the endpoints, add one, change one, rotate a key, read the models and check
the health: the API's `/api/endpoints` and the `endpoint_*` tools of mcp-orchestrator. That is the owner's decision of
19/11, so agents can tune other projects' agents.
- An endpoint an agent adds, or whose base URL an agent changes, is unusable until the owner approves it once in the
  window. The proxy answers `403 endpoint_not_approved`, and an agent cannot be set on it.
  - The reason: it is where an agent's whole context would go, and an injected agent could otherwise point any agent
    at its own server in two calls.
  - No API route approves: `endpoints:approve` is the window's alone.
- Extra headers an agent adds or changes wait for the owner's approval the same way (the owner's decision of 26/11):
  they go out with the owner's key, and a header can route or bill the requests at the endpoint. The key stays, since
  the address does not change.
- Approval stays apart from saving (found in the window's work, 27/11). The owner's save of another field (traces,
  the name, the hold) leaves an agent's change pending: it never approves what the owner has not looked at. An
  approval names the address and the extra headers the window showed, and is refused when an agent changed either
  again since. An address or headers the owner types in the window, or the approved values put back, are the owner's
  own, approved by that act. "Typed" is measured against what the form showed when it opened (`shown`), never
  against the record: a save from a form an agent changed the endpoint under is refused, nothing written (the Audit's
  M-b), so an earlier value of the agent's sent back by a stale form is never taken for the owner's.
- A key, the models, the name or the hold ceiling keep the approval.
- An agent may turn traces off for an endpoint, never on.

**The key drop folder.** An agent hands a key to Tars through a file, never through a prompt or a tool argument.
- It writes the key, one line, into `~/.tars/endpoint-keys/<name>.key`, and names the file in `endpoint_set_key`.
- The name must be `[A-Za-z0-9._-]{1,64}.key`, with no separator.
- The folder must be a plain folder, not a link (lstat).
- The file is opened with `O_NOFOLLOW` and checked by fstat against its lstat: a plain file with one link, 8 KiB at
  most, one printable line.
- Then Tars takes the key into the private folder and deletes the file, only once the settings that hold the key
  are written, and only that very file (the same inode). A save that fails leaves the drop file exactly as it was,
  and the agent is answered the reason, which never holds the key: the drop file is how the owner hands Tars a
  production key, and until this a failed save lost it.
- A file that fails a check is left as it is, and only its name is reported.
- Tars reads a key from no other path, so no argument can make it read `~/.tars-private`, `~/.ssh` or anything else
  and send it out as a Bearer.
- The macOS keychain is not read either: the key path is the same on every system.

**The trace reader's token**, `~/.tars-private/traces-reader-token` (0600), opens `GET /api/traces/*` and nothing
else.
- `resolveCaller` reads it only on those paths, as it reads a Hermes gateway's secret only on its webhook.
- No other credential opens those paths: not an agent's token (one agent would read every other's sessions), not the
  shared token, not a gateway's secret.
- It is rotated or revoked in the window, and shown once when made. A revoke applies first: the token is refused in
  memory at once, then its file is unlinked, or else emptied, which reads as no token at the next start, and the
  window is answered ok only once one of the two holds. A rotation drops the old token the same way before it writes
  the new one, so a write that fails (a full disk) leaves no token, never the old one.
- Emptying or changing the back-office address takes the upload consent back first, in memory and off the disk, then
  writes the rest: on settings that cannot be written, sharing has still stopped, and the window is told so.
- The other revokes of sharing made in the window apply first too: a project opted out, a pair removed, closed
  models left out, an endpoint's traces turned off, an endpoint removed. Each holds in memory at once, then is
  written, and is tried again every minute and once more as Tars quits (not on a crash, a forced kill or a power
  loss), until it holds, the window told. What is sent follows the trace gate as it is at sending, so each also holds
  back what was recorded before it. While such a write does not hold, the consent's file is dropped (unlinked or
  emptied, which needs no free space): nothing is shared meanwhile, and a start before the write holds reads no
  consent and takes it for a deletion, which fails closed. The
  file is put back once the settings hold. When the file can be neither removed nor emptied, a restart before the
  write holds shares again what the revoke stopped, and the window is told so. The grants opposite to these are
  written first, and so is an endpoint's address moved in the same save. An agent's own change through the local API
  (its endpoint's traces off, its address moved) is written first as well, and refused with the reason when the write
  fails: applied first, it could drop the owner's consent.
- The API listens on loopback. Offering the routes to a host on a tailnet is not built; it is the owner's call. It
  would take a second listener bound to the tailnet address alone, serving these routes and nothing else, behind a
  switch that is off by default. A port forward would carry every route of the API, leaving the token as the only
  guard.

**The stored traces**, `~/.tars/traces/traces.db` (0600, in a 0700 folder).
- They hold sessions in full: prompts, files read, tool results.
- They also hold the versions of each file a traced turn changed, compressed, to count how many of its lines last.
  Those never leave the store: not in the export, not in the read API, not in the upload. They are deleted with
  their session and count against the cap.
- Reading the agent's checkout for that never writes into it: every git call goes through safeGit with
  `--no-optional-locks` (no index refresh, no index.lock) and only reads (`rev-parse`, `ls-files`, `diff-files`,
  `cat-file`, `ls-tree`, `merge-base`, `show-ref`); a dirty file is read and hashed by Tars, never written as an
  object. Each call is bounded in time.
- `~/.tars` is in every agent's `--add-dir`, so any agent can read every traced session, as it can already read every
  transcript under `~/.claude` and `~/.codex`.
- Nothing is masked on this machine. Masking secrets and pseudonymising is the reader's job, on its side.
- The endpoint's key never enters a trace: the proxy records the request body, never its headers (it reads one, codex's
  `session-id`, for the session's own id).
- A harness's installation id, a stable id of the computer, is never stored: codex 0.170 sends it in its body
  (`client_metadata`, under its own name and inside its turn metadata) and in its `x-codex-turn-metadata` header,
  which go on to the endpoint as codex sent them; the store takes it out of the request first (`trace-wire.ts`
  withoutInstallIds), and the export and the upload are read from the store.
- A session's environment (`services/session-environment.ts`) is read from the system's files and a few commands, never
  a serial number or a hardware uuid, the computer's name, the user's or an address. A harness's version, when its
  package does not say it, is asked in a throwaway folder, which is its working folder, its home and its npm prefix,
  removed after the probe. On Windows, the machine's model is read by `%SystemRoot%\System32\reg.exe`, never `reg`
  by its bare name, which Windows looks for in the working folder first.
- What opened each turn is matched to who typed it: Tars's own writes, and, for a traced session only, the words the
  owner sends from an agent's pane (the field's words when Enter is pressed alone), kept beside them: those older than
  7 days go whenever the next words are noted, and all of a session's go with it. The upload sends a turn's author by kind and what was done to the turn (its
  interventions: kinds, times, delays), never these words apart from the messages they are.
- What is kept is bounded: off by default for every project and every agent, a size cap and a retention set in
  Settings, and a delete in the back-office.
- A deleted session leaves a tombstone: its id, why it went (user, retention, cap) and when, nothing of its content.
  The reader's token lists them at `GET /api/traces/deletions`, so the reader deletes its copies. They are kept 365
  days; one still owed to the back-office stays until it is sent.

**Who is traced** (`services/trace-gate.ts`). A session is traced only when all of these hold:
- an approved endpoint that allows traces;
- the project's switch and the agent's both on;
- the harness and model pair on the owner's list, which ships empty;
- with the default on, the model is not a closed one (Claude, GPT, o-series, Gemini).

The owner can turn that default off in Settings. The window warns that the providers' terms may forbid training on
their outputs.

**Session headers.** `X-Session-Id` and `X-Agent-Id` name the agent and its session to the endpoint. The proxy adds
them only for an endpoint whose "send session headers" option is on, which is off by default.

**Install header** (trace feature A4). An endpoint may keep its own copy of every request it serves, uploaded or not.
With the owner's "send install id" switch on for that endpoint, the proxy adds `X-Install-Id` to every request: the
install's back-office id, a pseudonymous uuid the back-office gave at registration, in lower case, so that a deletion of the whole
install at the back-office can be passed on to that copy. What leaves, and what does not:
- the id only, never the install's token, its HMAC secret, a machine id or anything else;
- only from the window: an agent's save that turns it on is refused, and turning it on is a grant like the session
  headers (written before it applies);
- only with the session headers: a save asking for it without them is refused, and turning them off turns it off;
- only while sharing is on, since the upload notice the user agreed to is what names it, and the install is registered
  with the back-office the settings name now (`currentInstallId` in `services/trace-upload.ts`): an install never
  registered sends nothing;
- never while a deletion is owed, never an install deleted or forgotten (a 401), and never one registered before the
  latest deletion's moment, so an install file a full or read-only folder kept after a deletion is not told again
  after a restart either, nor one the back-office forgot (a 401 takes the consent back). A new registration sends the
  new id;
- a harness's own `X-Install-Id` is always dropped, whatever the switches, and no extra header may set it: no
  harness or agent names an install;
- the value's contract: **a lower-case canonical uuid** (8-4-4-4-12 hex), the only value the endpoint reads. A
  canonical uuid with capitals goes lower-cased. Any other id, though the upload itself takes it (any id the
  back-office gives; both agree only because the back-office issues `randomUUID()`), sends no header, and the log
  says so once in a line that names no id: a new id format fails where it is seen, rather than silently stop
  install-wide deletions from reaching the endpoint's copy.
What it does not do: the endpoint's own purge is the endpoint's. Tars tells it the id; it cannot make it delete.
One case is left open: an install the back-office forgot (a 401, not a deletion of yours) whose file could be neither
removed nor emptied, with sharing given again and Tars restarted before a pass. Its id goes until that pass, whose 401
takes the consent back again. The deletion's moment does not date it, since no deletion was asked for.

**Extra headers.** An endpoint may carry up to 16 fixed headers, sent with every request to it and with its probes,
to the approved address only. They are not a secret: they are kept in `app-settings.json` with the endpoint, and every
agent reads them, so a credential never goes there (the key has its own path, above). None may name the credential
(Authorization, x-api-key, Cookie), the connection's own headers or the body's framing, the session headers or the
install header, and a
name or value holding CR or LF is refused; the proxy skips a refused name again when it sends.

**The upload** (`services/trace-upload.ts`). Opted-in sessions go to the back-office address the user sets, empty by
default. Nothing goes before the user has read, in the window, what leaves the machine, with one session shown as it
would be sent.
- Every string is scrubbed first (`services/trace-scrub.ts`, whose header says what it catches and what it cannot):
  secrets, home paths (anyone's, with the user name in them), e-mail addresses, IP addresses, phone numbers and the
  names Tars knows. Each becomes a typed placeholder numbered within its session (`<SECRET_n>`, `<HOME_n>`,
  `<EMAIL_n>`, `<IP_n>`, `<PHONE_n>`, `<PERSON_n>`): the same value takes the same number in every message, row and
  batch of a session and in every upload of it, and numbering starts again in the next session, so a number links
  nothing across sessions. The numbers a session gave are kept with it in the local store, each value by a hash,
  never as written, and go when the session is deleted. Each session carries `maskingVersion` and `maskCounts`, the
  placeholders inserted by type.
- The names Tars knows (`services/trace-person-names.ts`): the authors and committers of the project's git history,
  read through safe-git, and the account's own name (git's `user.name`, the full name macOS's `id -F` or Linux's
  passwd entry gives, the login name; none read on Windows but git's and the login). Another person's name is masked
  when written whole ("First Last" or "Last, First"); the account's own by its parts too. So a given name or a family
  name that is also a word ("Will this compile?", a class Price) stays, and so does another person's name written
  alone by its given or family name, which the notice says. Not used: GitHub handles, co-authors in commit messages,
  names typed in chats or channels, agents' names, an address book. A name Tars does not know passes, and the notice
  says so. They are read before a session is built and before its preview, so the preview is the document sent; the
  consent is read again after that read, before the session goes.
- Projects and endpoints go as HMAC keys of a secret that never leaves the install, never their paths or addresses.
- Neither the agent's name nor the endpoint's goes: both are free labels that may name a person or a host (L1).
- A turn's author goes by kind (user, orchestrator, agent), never a name.
- A session's environment goes as exact values (the owner's decision of 27/11): the machine's model, chip, cores and
  memory, the system, Tars's version, the locale and the time zone, each on its own line of the notice.
- A gate's verdict (`POST /api/verdicts`, the tool `record_verdict`) is recorded by an agent with its own token, in
  its own name and for its own project: the shared token, Tars's pass and a gateway's secret are refused, and so is a
  body naming another agent. Any agent of a project may record a `qa` or `audit` verdict, never on its own work (one of
  its traced turns committed the judged head or a commit it holds, whatever branch the verdict names), and the record keeps who did, with its name and role from
  the fleet. `ci` is Tars's alone. It goes up in the outcome's `gates` without its report's path or its recorder's
  name, which stay here.
- The own-work check trusts git's committer dates (`%ct`), which the committer sets: a recorder that dates its
  commits outside its turns gets past it. For any other agent, the worst it does is refuse a verdict, never record a
  false one.
- **What a verdict is not:** verdicts live in `traces.db`, which agents can write, like every trace row. A verdict is
  a label from a cooperative fleet, held by the route and the tool, not a proof against an agent that edits the
  file. A list of gate agents the owner designates would be the stronger form; it is the owner's to ask for.
- A turn's workspace goes as numbers and hashes only: the commits at its start and end as git names them (as the
  session's outcome already sends its head), two tree hashes that name no file, its files and lines counted, and
  their survival. Never a path or a line of the files.
- The install's token and that secret are in `~/.tars-private/traces-install.json` (0600).
- Only sessions whose project and agent are opted in at the moment of sending go.
- One action in the window asks the back-office to delete everything the install sent, then forgets the install and
  takes the consent back. Without that, the next pass would register again and send everything back, undoing the
  deletion. Sharing starts again only when the user consents again.
- The deletion withdraws the consent first, so sending stops at once. A DELETE that fails or never goes leaves sharing
  off and the deletion shown as owed, until it is done.
- A deletion is the user's word: sharing again sends only the sessions started after it, and the consent says so.
  Its moment is never earlier than the newest session it covers, so a clock moved backward lets none through.
- An owed deletion holds only while its install is still here: with the install file lost, it is cleared. The user
  can also give up a deletion an old back-office never confirmed. Tars stops asking it, and what was recorded before
  the deletion is still never sent.
- A pass under way is stopped and waited for before the deletion, and every pass reads the consent again before
  each session and before any registration, so nothing it sends lands after a deletion or a withdrawn consent.
- A session sent and then deleted here, by the user or by retention, is deleted at the back-office too
  (`DELETE /v1/sessions/{id}`, the install's token), first in each pass and retried as every other call. It goes with
  sharing off as well, since it carries only the id of a session the back-office already holds, and only to the
  install the session went to, at the address set; never while a whole deletion is owed or under way. A session the
  cap removes stays there: the cap frees this disk and says nothing of the data. "Sent" starts at the session's first
  upload call, so one deleted while its batches land, or after a pass that failed half way, is owed its delete too. A
  new install, a whole deletion that went through, or an install that is gone forgets the deletes owed to the old one.

**Training consent** (trace feature A5). Uploading is consent to storage, not to training. A second switch, "May be
used to train models", stands beside sharing. What leaves, and who decides:
- Each session carries `consent: { training }`, as the switch stood while it ran: off at any moment, false for good.
  Turned off while a session runs, the session goes again with false. A session recorded before the switch existed
  reads false.
- Trainable is a positive, private fact. `~/.tars-private/traces-training-allowed.json` (0600) lists the sessions
  Tars opened while training was on; a session leaves it when the switch goes off while it runs. A session is
  trainable only when that list names it and its stamp in the trace store says yes. The store is under `~/.tars`,
  which every agent is handed: an agent that sets a stamp back to yes, or copies a session under a new id, makes
  nothing trainable. One rule decides it wherever the field leaves (`trace-store.ts` summaryOf): the external
  reader's session document and change list, the export, the upload and the preview.
- The list is read once per run and held in memory. A change is written at once, and again every minute until a write
  holds, and the window is told while it does not. A list that cannot be read is set aside (`.unreadable-<time>`) and
  a new one started: none of the sessions recorded before counts as trainable, and the window is told. The sweep
  prunes it with the sessions it names.
- The restart case, as for the switch: a write of the list refused, then Tars stopped before a retry holds. A session
  added then is on no list after the restart, so it is not trainable (it fails closed). A session taken off then is
  still listed after the restart; it stays not trainable through its stamp alone, which the off set to no in the store
  at the same moment (unless that write failed too), and since the store is under `~/.tars` an agent could write that
  stamp back to yes: this is the one case the list does not cover.
- The install's current value goes to the back-office on every change (`PUT /v1/installs/me/consent` with
  `{ training }` alone and the install token), and with the registration. It covers the sessions already sent. A change
  the back-office has not taken stays owed across a restart, is sent again until a 2xx, and goes with sharing off
  too, since it carries no session.
- On by default (`TRAINING_DEFAULT` in `services/traces-runtime.ts`, the owner's ruling of 11/11).
- Only the window's `traces:setTraining` sets it. It lives in `~/.tars-private/traces-training.json` (0600), which
  no agent is handed, and which neither the settings' save nor an agent writing `app-settings.json` reaches. No API
  route reads or writes it. A file that cannot be read as one counts as off.
- Off is a revoke and applies at once. On a disk that refuses the write, it holds for the run and is written again
  every minute, and the window is told. A restart before that write holds reads the switch as it was: this one case
  does not fail closed. On is a grant: written first, and refused when it cannot be.
- What it does not do: what a reader of the back-office does with the value is the reader's. Tars records it and
  sends it; it cannot make anyone honour it.
- When the back-office no longer knows the install (a 401: the user's deletion, or its operator's), Tars never
  registers again on its own. Uploads stop, the local traces stay, the consent is withdrawn, and the window says so.
  Registering again is the user's own act.
- A consent stands only while its own file, `~/.tars-private/traces-upload-consent` (0600, no agent is handed it),
  holds the very time the settings say. Giving it writes that file, then the settings; either failing answers the
  window with the reason, and nothing is given. A withdrawal holds in memory at once, then unlinks that file, or else
  empties it, then writes the settings. Measured on macOS 26 (APFS): a full volume refuses a write, a rename and a
  truncate but takes an unlink, and a folder that may not be written refuses an unlink but takes a truncate. A start
  whose settings still say consent with no such file, a partial one or another time has none (it fails closed).
  That start also takes it for a deletion it could not write down, since a deletion's moment and its owed DELETE
  live in the settings alone: the moment becomes the latest of the one kept, the start and the newest session, and
  the DELETE is owed again while the install file is there. So a deletion on settings that cannot be written, then a
  quit, still never lets what was recorded before it go, unless its consent's file could be neither unlinked nor
  emptied as well. That is the one case that brings the consent back at the next start: the file can be neither
  unlinked nor emptied (a volume remounted read-only, an immutable file, a full volume with a folder that may not be
  written) and no write of the settings holds before Tars quits. The old consent then stands, the deletion's moment
  is lost with the settings that held it, and what was recorded before the deletion may go. The log says so, and the
  window meanwhile. The deletion's moment and its owed mark are written with the withdrawal, in one write, so no stop
  between two writes leaves the consent standing with a deletion owed, or neither. The install file goes the same way, unlinked or else emptied, so a 401, a deletion that went
  through or a deletion given up never throws on a folder that refuses the unlink, and a 401 withdraws the consent
  before it touches the file.
  Settings that could not be written after a withdrawal or a deletion are tried again every minute, the window told
  (`unsaved`), and nothing uploads meanwhile. Until this, both were held in memory and saved by a write that swallowed
  its error: a consent given on a full disk was answered as given, and a withdrawal came back at the next start.
- The scrubbing applies to what is uploaded only: the endpoint the agent talked to, and the local store, saw the
  session as it was.

**The load window** (`services/load-window.ts`, `handlers/load-handlers.ts`). Agents write the pools under
`~/.tars/load-pools`; only the owner starts a window from one, and what is approved is what runs.
- **Only the owner's click.** `load:approve`, `load:grant`, `load:notNow` and `load:stop` are IPC channels of the
  window. Each is refused unless it comes from the main window's own web contents. No API route, MCP tool, agent token
  or message reaches them. Nothing else in the main process holds the window's runtime or writes a grant.
- **Kept where agents are not handed.** The grants (`~/.tars-private/load-grants.json`, 0600), the approvals
  (`load-approved.json`, 0600) and the pools set aside (`load-set-aside.json`, 0600). A run record under
  `~/.tars/load-runs`, which any agent can write, is a log, read for no decision. A run counts only when the private
  file names its id. Its pool, sha256, approved task lines, window and stop are read from there. Its tasks and planned
  arrivals are derived from the verified snapshot. A record whose stop an agent removes stays stopped, and a stop an
  agent writes there stops nothing. A record whose tasks or planned arrivals were changed stops its run with an error.
- **The main window's top frame.** The handlers check the sender's frame as well as its web contents. A subframe
  shares the window's web contents.
- **What was shown is what is approved.** Approve carries the pool's sha256 and the proposal's id. A pool or a
  proposal changed since is refused as stale, and shown again. The approved bytes are the run's snapshot, and nothing
  reads the live pool after them. A snapshot that no longer matches the approved sha256 stops its run with an error.
- **A private repository is not sent to an endpoint by accident.** A project runs only when gh says its repository
  is public, or when the owner allowed it by name. A gh that cannot tell refuses the project. Nothing is fetched: a
  base_commit must already be in the project.
- What it does not stop: an agent can write a pool that the owner approves without reading it. The card shows every
  setup line and test command as they will run, and each project's repository and verdict.

Measured by:
- `__tests__/electron/endpoint-proxy.test.ts` (the token swap, both ids, no buffering, the holds);
- `inference-endpoints.test.ts` (the approval guard, the drop file);
- `services/trace-reader-token.test.ts` (the door);
- `trace-gate.test.ts`;
- `trace-scrub.test.ts`, `trace-scrub-personal.test.ts` (its failures listed first: what passes, what must stay, the
  overlaps with secrets, the numbering, Unicode) and `trace-upload.test.ts` (the upload, against a stand-in
  back-office);
- `e2e/trace-personal-data.spec.ts` (the window's preview of a real session holding personal data);
- `e2e/traces-native.spec.ts` (the whole chain against a stand-in endpoint on loopback);
- `__tests__/electron/load-approval-boundary.test.ts` (who reaches the approval and the grants), `services/load-window.test.ts`,
  and `e2e/load-window-approval.spec.ts` (an agent's token, a forged run record and a stale hash, in the real app).
