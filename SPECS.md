# TARS: Specs v1.5.0

## Vision

A desktop app that runs a team of AI coding-agent CLIs on your own machine, in parallel, on your own repositories. Each agent is a real terminal process (`claude`, `codex`, `gemini`, `grok`, `opencode`, `pi`, or the `claude` binary re-pointed at another vendor) running in its own git worktree, with its own model, its own permission mode and its own PTY. Tars owns the process lifecycle, the orchestration path between agents, one shared memory, and the cost accounting.

Nothing runs in the cloud. No account, no server, no analytics. The state lives in `~/.dorothy`, the agents read and write your working tree, and the only network calls the app itself makes are the model catalogue, the ACP registry, the update feed, the update checks of the CLIs it runs, and whatever integration you switch on: error reports to Sentry among them, off unless you turn them on (§11, Error reports).

---

## Architecture Overview

### Data Flow

```
Electron 44 main process (Node 24.21, Chromium 152; electron/, ~47k LOC)
├── BrowserWindow  → Next.js 16.3 static export (src/, ~44k LOC)
│                     contextIsolation, nodeIntegration off, app:// protocol
│                     ↕ 214 IPC channels via contextBridge (electron/preload.ts)
│
├── PTY layer (node-pty)          agent PTYs · quick PTYs · skill PTYs · plugin PTYs
│     └─ one shell per agent, cwd = worktreePath ?? projectPath
│
├── Local HTTP API  127.0.0.1:31415  (electron/services/api-server.ts)
│     ├── Bearer token  (exempt: /api/health, /api/local-file;
│     │                  /api/hooks/*: the agent's own token only)
│     ├── Origin allowlist: app://-  |  http://localhost:3000
│     │
│     ├─◄ Claude Code hooks (hooks/*.sh)      status, output, notifications
│     ├─◄ bundled MCP servers (stdio, the app's Node)   orchestration + memory tools
│     └─◄ Hermes gateway webhook              external scheduler → dispatch
│
├── ACP layer (electron/services/acp/)
│     └─ spawn agent CLI in ACP mode → JSON-RPC over stdio → turn returns
│        { stopReason, usage, text, toolCalls }
│
└── Outbound: models.dev · ACP registry · GitHub releases · Hermes gateway
             · Telegram · Slack · Discord · gbrain / Honcho MCP
```

The orchestration loop, in full:

```
orchestrator agent's CLI
  └─ MCP tool  delegate_task(id, prompt)
       └─ POST 127.0.0.1:31415/api/agents/:id/run-task      ← preferred
       │     └─ AcpSession: spawn CLI, initialize, session/new,
       │        session/set_mode, session/prompt  → TurnResult
       │        → recordUsage()  → response carries text + cost
       │
       └─ fallback when the provider has no ACP mode, or the run failed:
             POST /api/agents/:id/dispatch     → PTY write or fresh spawn
             GET  /api/agents/:id/wait         → long-poll on status change
             GET  /api/agents/:id              → lastCleanOutput (3 retries)
```

### Key Design Decisions

- **Two transports, not one.** ACP returns a receipt; the PTY does not. `delegate_task` tries ACP first and degrades to terminal dispatch. Everything the user watches is still a real terminal.
- **The server decides message-vs-spawn.** `POST /api/agents/:id/dispatch` makes that call under the main process's single-threaded event loop. The earlier GET-status-then-POST pattern raced and could type into a dead PTY.
- **Session ownership is explicit.** A dispatch tombstones the old session id; only the session registered by `SessionStart` may drive status. Hooks of a killed PTY survive the kill by seconds and would otherwise flip the new task's status.
- **Providers are a strategy interface, not conditionals.** 19 methods on `CLIProvider`; 15 implementations. Adding a vendor is a file in `electron/providers/` plus one line in the registry.
- **Thirteen of the nineteen providers are the `claude` binary re-pointed.** `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` in the PTY environment, either at the vendor's Anthropic-compatible endpoint or through OpenRouter. They inherit Claude Code's hooks, skills and MCP config for free.
- **Model list and prices come from models.dev, not from the source.** A model released today is selectable after the next 6-hour refresh, with no release.
- **Memory is federated and provider-agnostic.** Six sources behind one hub, delivered two ways: a bundled MCP server every provider registers, and prompt injection for the CLIs with no session hook.
- **Tars has no scheduler.** Cron jobs, the task board and long-running automation live in the user's Hermes gateway; Tars is a client and exposes an inbound webhook.
- **Nothing is ever pushed upstream.** The repository lives at `cooper-labs-tech/Tars` (moved from `JeanBrasse/Tars` on 2026-10-07; the old URLs redirect); `GITHUB_REPO` in `electron/constants/index.ts` points there so an upstream build can never be offered as an update to a fork install.

---

## §1 Process model

### Main process

`electron/main.ts` (661 lines) is wiring only. On `app.whenReady()`, in order:

| # | Step | Notes |
|---|---|---|
| 1 | `ensureDataDir()` | creates `~/.dorothy` |
| 2 | `ensureTarsClaudeMd()` | writes `~/.dorothy/CLAUDE.md`, mounted into every agent via `--add-dir` |
| 3 | statusline install/remove | `~/.dorothy/statusline.sh` + `statusLine` key in `~/.claude/settings.json` |
| 4 | `migrateFromClaudeManager()` | moves `~/.claude-manager` → `~/.dorothy`, then deletes the old dir |
| 5 | `loadAgents()` + `startAgentAutosave()` | 30 s dirty-flush timer, `unref`'d |
| 6 | `setupProtocolHandler()` → `createWindow()` | `app://` and `local-file://` |
| 7 | `initTray()` | menu-bar popover rendering `/tray-panel` |
| 8 | IPC registration | 214 channels across 16 files: the 15 handler modules plus `mcp-orchestrator.ts` |
| 9 | `initVaultDb()` | better-sqlite3, WAL, foreign keys on |
| 10 | Telegram + Slack + Discord + `startApiServer()` | |
| 11 | `loadCatalog()` (not awaited) | stale disk copy answers immediately |
| 12 | `setupMcpOrchestrator()` (not awaited) | registering spawns CLIs; it used to hold the first paint |
| 13 | `configureStatusHooks()` (awaited) | |
| 14 | update check after 5 s, then every 30 min | `electron-updater`, `autoCheckUpdates !== false` read at each tick; the same switch governs the CLI updates |
| 15 | `startCliUpdates()` | claude and Amp brought up to date 5 s after launch, then every 30 min, one at a time. §2 *Keeping the CLIs current* |

`process.stdout` / `process.stderr` get an `EPIPE`-swallowing error handler at module load: a closed pipe from the launching shell would otherwise crash the app on the next `console.log`.

### PTY layer

Four maps in `electron/core/pty-manager.ts`: `ptyProcesses` (agents), `quickPtyProcesses` (the shell panel), `skillPtyProcesses`, `pluginPtyProcesses`. `killAllPty()` drains all four on `before-quit`.

**At quit** (`endAllTerminals`, `core/pty-manager.ts`), each terminal's process tree is read from `ps` first, while the parents that tie it together live, and held still while it is read again until a read adds no group (SIGSTOP, `ProcessTree.freeze`, as a delegated run's: a command the CLI started during the first read was left under launchd once the CLI died at the hangup); the shells get their hangup as before, which bash relays to its jobs, and every group of those trees gets it too, still held, then SIGCONT; the quit is held (`before-quit`, two passes) while the event loop turns until every process of those trees has ended and node-pty has delivered every exit, 1.5 s at most; then what is left, in those trees only, gets SIGKILL. Measured: a CLI that ignores SIGHUP and SIGTERM, and its child, outlived 8 quits of 8 before, and none after; a quit with a real claude takes about 1 s instead of 0.4. The exits used to come after a synchronous `before-quit`, and one delivered during Electron's final cleanup aborted the app (SIGABRT in `pty.node`'s ThreadSafeFunction, #231's proof). From the moment the quit begins (`beginQuit`, `core/quit-state.ts`), nothing new is spawned: `spawnAgentSession` answers 503 with `quitting: true`, `spawnAgentPty`, the ACP client, `delegateOverAcp` and every `pty.spawn` refuse, and a terminal's exit is neither its agent's completion nor its error (`agentStatusOnExit`, in each of the six exit handlers). The user's own shell panels get the hangup only: a job left there with nohup or disown survives the quit, and only a shell that ignores the hangup is itself SIGKILLed. `endAllTerminals` runs before the delegated runs' synchronous grace, so the two graces overlap. `e2e/quit-ends-agents.spec.ts` drives it in the app: a CLI deaf to SIGHUP and its child are gone 1.8 s into the quit, a `/start` 200 ms in gets 503, and the agent is not saved `completed`; on main the CLI outlives the quit and the agent is saved `completed`.

`writeProgrammaticInput(pty, data, bracketPaste)` is the only sanctioned way to inject text into a running agent:

- `bracketPaste: false` means plain `data + '\r'`, for the initial shell command. A command holding a tab or a newline is never typed: bash's readline reads a typed tab as the completion key (macOS's /bin/bash 3.2 has no bracketed paste to protect it), and a task with a tab reached the CLI with its tabs eaten. Such a command is written to a file of its own (`tars-launch-*` under the temp folder, `0700`, the file `0600`) whose first line removes it, and the shell is given `. '<file>'` (`shellLine`, `core/pty-manager.ts`). Before each reuse the folder must still be a directory, not a link, owned by this user and closed to others, or a new one is made (a multi-user /tmp that is cleaned let another user make one of that name, the Audit's gate of #224); it goes when Tars quits, if it is still ours. A file whose command never runs stays until then, or until the temp folder is cleaned if Tars is killed. A command with neither is typed as it is, so the terminal shows what was launched.
- `bracketPaste: true` is for a live Claude Code TUI. Input over 200 chars or containing a newline is wrapped in `\x1b[200~ … \x1b[201~`. **The carriage return is always a separate write delayed 300 ms**, because the TUI treats a rapid `text\r` burst as one paste event: the text lands in the box as `[Pasted text]` and is never submitted.

It must never be used for keystroke passthrough from an xterm.js terminal.

Every agent terminal also has a mirror, `electron/core/terminal-mirror.ts`: a headless xterm 5.3 (`xterm-headless` at the renderer's version, with the Dashboard's `convertEol`) that `spawnAgentPty` attaches before any caller subscribes, and that parses each chunk as it arrives. `agent:get` hands a panel `terminalSnapshot()` of it as its `output`, one chunk: RIS, both screens as the serialize addon writes them (the normal one with 2,500 lines of history, then the alternate one when it is active), and what the addon leaves out: the SGR mouse encoding, the cursor's visibility, a scroll region, the cursor put back absolutely. A panel that remounts, back from another page or from another project's tab, is shown the screen itself instead of a replay of the kept chunks, which after a few minutes of a fullscreen turn held no frame: the Audit measured 856 visible characters in a panel before leaving the Dashboard and 37 after coming back, on 2026-09-23. One mirror per PTY, runtime only, nothing persisted. A terminal with no mirror falls back to the kept chunks. An agent with no terminal is handed nothing and no `ptyId`: `agent:get` opens no terminal. Until 2026-09-24 it opened a login shell for any agent looked at, whose banner ("The default interactive shell is now zsh.") went into the agent's output and read as its last line in the Chat's fleet list; the Dashboard shows such an agent as `(Session idle)`, and a start opens its terminal.

`agent:resize` remembers each agent's panel size even when the agent has no PTY yet (`rememberPanelSize`), and `spawnAgentPty` spawns every new agent PTY at it rather than the caller's 120×30 or 120×40, which a PTY created after its panel's first fit used to keep.

The mirror of a `claude` PTY also watches how it is repainted. Fullscreen Claude Code positions absolutely (`CSI H`) and never moves the cursor up or back; inline, it climbs back over what it drew (`CSI A`, `CSI D`). An alternate screen repainted the second way over a window of 8 chunks is a CLI that left fullscreen without telling its terminal, which Claude Code 2.1.280 did twice among seventeen sessions on 2026-09-22: every panel kept the alternate screen and the mouse request, and the wheel reached nothing. The flag, `leftFullscreen`, rides on `agent:list`, `agent:get` and the tick, and clears when the terminal really leaves the alternate screen, when a program asks for it again, or with the PTY.

### Renderer

Next.js 16.3 App Router, static-exported (`ELECTRON_BUILD=1 next build` with `src/app/api` temporarily moved aside). React 19, Tailwind 4, Zustand, xterm 5.3, framer-motion. Served from `app://-/index.html` in production, `http://localhost:3000` in dev. The app:// scheme has the `codeCache` privilege: V8 keeps the compiled bundle in the profile, and a later launch does not compile it again (OPERATIONS.md, "Run the app").

---

## §2 Providers

### The contract

`electron/providers/cli-provider.ts` defines `CLIProvider`. Four readonly fields and 19 methods:

| Group | Members |
|---|---|
| Identity | `id`, `displayName`, `binaryName`, `configDir` |
| Models | `getModels(): ProviderModel[]`, `resolveBinaryPath(appSettings)` |
| Command building | `buildInteractiveCommand`, `buildScheduledCommand`, `buildOneShotCommand`, `buildScheduledScript` |
| Environment | `getPtyEnvVars(agentId, projectPath, skills, appSettings?)`, `getEnvVarsToDelete()` |
| Hooks | `getHookConfig(): { supportsNativeHooks, configDir, settingsFile }`, `configureHooks(hooksDir)` |
| MCP | `getMcpConfigStrategy(): 'flag' \| 'config-file'`, `registerMcpServer`, `removeMcpServer`, `isMcpServerRegistered` |
| Skills | `getSkillDirectories()`, `getInstalledSkills()`, `supportsSkills()` |
| Paths | `getMemoryBasePath()`, `getAddDirFlag()` |

`getProvider(id)` falls back to Claude for anything unknown, including `'local'` (Tasmania), which is a Claude sub-mode rather than a provider of its own. `isValidProvider` accepts `'local'` plus the 15 registry keys.

`safeEffort()` is exported from the same module and validates reasoning effort against `{low, medium, high, xhigh, max}` before it lands unquoted in a shell string. The value arrives over IPC, so it is validated at the point of use, not trusted from the caller. `effortFlag()` turns it into ` --effort <level>` for the fourteen providers on the claude binary, medium included: without the flag Claude Code starts at the effort it last saved for that model from any terminal (`/effort` writes `modelSettings.<model>.effortLevel` into `~/.claude/settings.json`), not at medium. An agent with no effort gets no flag, which is the one case that means the CLI's own.

### The registry (19 providers)

| id | Display name | Binary | Config dir | Reaches the model via |
|---|---|---|---|---|
| `claude` | Claude Code | `claude` | `~/.claude` | native |
| `codex` | Codex CLI | `codex` | `~/.codex` | native |
| `gemini` | Gemini CLI | `gemini` | `~/.gemini` | native |
| `grok` | Grok CLI | `grok` | `~/.grok` | native |
| `opencode` | OpenCode | `opencode` | `~/.opencode` | native |
| `pi` | Pi Terminal | `pi` | `~/.pi` | native |
| `openrouter` | OpenRouter | `claude` | `~/.claude` | `https://openrouter.ai/api` |
| `deepseek` | DeepSeek | `claude` | `~/.claude` | `https://api.deepseek.com/anthropic`, else OpenRouter |
| `moonshot` | MoonshotAI (Kimi) | `claude` | `~/.claude` | `https://api.moonshot.ai/anthropic`, else OpenRouter |
| `zhipu` | ZhipuAI (GLM) | `claude` | `~/.claude` | `https://open.bigmodel.cn/api/anthropic`, else OpenRouter |
| `minimax` | MiniMax | `claude` | `~/.claude` | `https://api.minimax.io/anthropic`, else OpenRouter |
| `qwen` | Qwen (Alibaba) | `claude` | `~/.claude` | OpenRouter only |
| `mimo` | MiMo (Xiaomi) | `claude` | `~/.claude` | OpenRouter only |
| `nvidia` | NVIDIA NIM | `claude` | `~/.claude` | OpenRouter only |
| `nous-portal` | Nous Portal | `claude` | `~/.claude` | OpenRouter only |

Plus `local`: the `claude` binary pointed at a running Tasmania server (`ANTHROPIC_BASE_URL` = the endpoint with any `/v1` suffix stripped, since the Claude Code SDK appends `/v1/messages` itself).

### Per-provider capabilities

| Capability | Value per provider |
|---|---|
| Native hooks | `true` for `claude` and all ten claude-binary providers (they share `~/.claude/settings.json`) and `gemini`; `false` for `codex`, `grok`, `opencode`, `pi` |
| MCP strategy | `flag` (`--mcp-config`) for the claude-binary family; `config-file` for `codex`, `gemini`, `grok`, `opencode`, `pi` |
| Skills | `true` everywhere except `pi`, which has packages rather than skills |
| Skill directories | claude family: `~/.claude/skills` + `~/.agents/skills`; `gemini`: `~/.gemini/skills`; `grok`: `~/.grok/skills` + `~/.agents/skills`; `codex`, `opencode`: `~/.agents/skills`; `pi`: `~/.pi/packages` |
| Memory base path | `<configDir>/projects` for the claude-binary family; `codex`, `gemini`, `grok`, `opencode` and `pi` return `configDir` itself, a placeholder; they have no Claude-like memory tree |
| Prompt-injected memory | every provider whose `configDir` is not `~/.claude` (see §5) |
| ACP mode | `claude`, `codex`, `gemini`, `grok`, `opencode`, `pi` (see §4) |
| Orchestrator tool block | Claude only enforces it as a CLI flag (`--disallowed-tools`); on every other provider it is enforced by ACP permission arbitration |

### Alt-provider safety gate

`spawnAgentSession` refuses to start a claude-binary alt provider that produced no `ANTHROPIC_BASE_URL`, which means no API key is configured, and the session would silently bill the user's Anthropic account:

```
No API key configured for provider "<id>". Add it (or an OpenRouter key) in Settings > AI Providers.   → HTTP 400
```

The `local` provider gets the same treatment: Tasmania not running → HTTP 409, never a silent fall-through to the cloud.

### Environment injected into every agent PTY

```
PATH        = buildFullPath(configured CLI dirs)   TERM = xterm-256color
CLAUDE_SKILLS, CLAUDE_AGENT_ID, CLAUDE_PROJECT_PATH, CLAUDE_PROVIDER
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = 1
+ provider env (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / Tasmania vars)
− everything in getEnvVarsToDelete()  (CLAUDECODE, so nested sessions don't inherit it)
```

`CLAUDE_AGENT_ID` and `CLAUDE_PROJECT_PATH` are re-asserted explicitly after the provider spread: MCP project scoping and every hook depend on them.

On the `claude` binary, the fourteen providers that run it get `managedCliEnv()` as well: `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`. Amp gets its update check turned off through the settings copy Tars hands it (`~/.dorothy/amp-settings.json`, `amp.updates.mode: "disabled"`). Neither CLI updates itself inside a Tars terminal: Tars does it, below.

### Keeping the CLIs current

`electron/services/cli-updater.ts`, started by `startCliUpdates()` 5 s after launch and every 30 minutes after, Claude Code's own cadence. One pass at a time, one CLI at a time, logged to `~/.dorothy/cli-updates.log`. A pass runs only while `autoCheckUpdates` is on, read at every pass: it is the one "Check for updates" switch, for Tars's own updates and the CLIs' (JeanBrasse, 2026-09-23). And it checks only the CLIs at least one agent runs, by each agent's provider (`clisInUse`): an agent with none, and the thirteen providers pointed at another vendor, run claude, so a fleet with no Amp agent never has Amp checked.

| CLI, installed as | What Tars runs | When it holds back |
|---|---|---|
| `claude`, native installer (`~/.local/bin/claude` → `~/.local/share/claude/versions/<version>`) | `claude update` | never for a running session: each version is its own file, a session keeps running the one it started from, and the link is swapped in one step. The verdict is read off the link, since `claude update` exits 0 when an administrator has disabled updates |
| `amp`, global npm package | `npm view <package> version`, then the new version downloaded into a scratch prefix, then `npm install --global --prefix <prefix> --prefer-offline <package>@<version>`, all three with a `--cache` in that scratch folder, which is deleted after: `~/.npm` is never pruned and kept 38 MB of every Amp release. One that cannot be deleted is named in the log and removed by a later pass once an hour old | while any process has the binary open (`lsof -t`), asked before the download and again before the install, because npm removes the old package before the new one is in place |

`<package>` is the one that owns the binary, read from where the launcher really points: `@sourcegraph/amp` on an install made before Amp's rename to `@ampcode/cli`, which `amp update` itself cannot update (it asks for `@ampcode/cli` and npm refuses with `EEXIST`).

Nothing is updated when its own switch says not to: for claude, `DISABLE_UPDATES`, `DISABLE_AUTOUPDATER` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in Tars's environment or in `~/.claude/settings.json`, or `autoUpdates: false` in `~/.claude.json` that the native installer did not write itself; for Amp, `amp.updates.mode: "disabled"` in `~/.config/amp/settings.json`. Nor is anything installed outside the home Tars runs in, which keeps a sandbox or a test run, whose `HOME` is a scratch folder, off the real CLIs, and nothing runs when `DOROTHY_E2E=1`.

codex, gemini, grok, opencode and pi are not updated, and neither is claude or Amp installed another way (npm for claude, Homebrew, a copied binary): the first pass after launch names each one an agent runs and found on the machine in the log. None of the five was installed where this was measured, so no update path for them could be checked.

---

## §3 Model and price catalogue

`electron/services/model-catalog.ts`.

Model lists and per-token prices used to be hardcoded, so a new model or a price change needed a release. [models.dev](https://models.dev) publishes both for 193 providers in USD per million tokens, re-syncs hourly, is MIT licensed, and supports conditional GET: the usual refresh costs one 304 and no body.

### Three tiers, in order

1. **Fresh fetch.** `https://models.dev/api.json`, then the mirror `https://raw.githubusercontent.com/anomalyco/models.dev/dev/models.json`. 20 s timeout, `If-None-Match` from `~/.dorothy/model-catalog.meta.json`. The payload is rejected unless it is an object with an `anthropic` key.
2. **Last-good copy on disk.** `~/.dorothy/model-catalog.json`, served whatever its age. Stale beats nothing: an old catalogue still prices yesterday's models.
3. **Compiled-in floor.** Four families in `FLOOR` (`fable`, `opus`, `sonnet`, `haiku`), matched by substring. Kept deliberately small: the catalogue is the source.

TTL 6 h, single in-flight promise, memoized. `loadCatalog()` never throws. `catalogSync()` is the synchronous view for hot paths.

### How a model released today becomes available

models.dev adds it → next `loadCatalog()` past the 6-hour TTL (or `models:refresh` from Settings) rewrites `model-catalog.json` → `modelsForProvider(id)` maps the Tars provider id through `PROVIDER_KEYS` and returns every model sorted by `release_date` descending → the picker shows it. No app release.

`PROVIDER_KEYS` maps 14 Tars ids to models.dev keys (`claude→anthropic`, `codex→openai`, `gemini→google`, `grok→xai`, `qwen→alibaba`, `zhipu→zai`, `mimo→xiaomi`, `moonshot→moonshotai`, plus identity mappings). A provider absent from the map has no catalogue entry and its picker falls back to the static `getModels()` list.

### Pricing lookup

`priceFor(modelId, providerId?)`:

1. Exact id in the provider's own catalogue section.
2. Longest-prefix match in either direction: transcripts carry dated ids like `claude-haiku-4-5-20251001` that the catalogue lists undated.
3. The same two steps across every catalogue key.
4. The `FLOOR` family substring.

`catalogStatus()` reports `{ loaded, fetchedAt, providers, models }` so the Usage page can say whether a figure is priced from the live catalogue or a fallback.

---

## §4 Orchestration

### The two transports

| | ACP (`/run-task`) | PTY (`/dispatch`) |
|---|---|---|
| Providers | 6 with an ACP mode | all 15 |
| Returns | agent's text, `stopReason`, tool calls, token usage, cost | `{ success, mode, previousStatus, agent }` |
| Delivery guarantee | the turn resolved or the call errored | bytes were written to a pty |
| Deny-list enforcement | protocol-level, every provider | `--disallowed-tools`, Claude only |
| Usage captured | yes, every provider | Claude only, after the fact from transcripts |
| Session lifetime | one turn, torn down after: what the turn left running in the background (a `run_in_background` command, a Monitor, a ScheduleWakeup) is stopped with it, and nothing brings the agent back for it; a turn still going at `timeoutSeconds` (at most one hour) is stopped mid-command | persists at the CLI prompt; a background job's notice starts a turn of its own |
| Visible in the UI terminal | no | yes |

### The ACP layer: `electron/services/acp/`

**`client.ts`: `AcpSession`.** JSON-RPC 2.0 over the child process's stdin/stdout, newline-delimited. `start()` sends `initialize` (protocolVersion 1, client capabilities `fs.readTextFile`/`fs.writeTextFile`, `terminal: false`), then `session/new` with cwd and MCP server specs, then `selectMode()`.

`selectMode()` matters more than it looks. The default on some agents is "deny anything not pre-approved", which silently blocks the very MCP tools Tars injects. Mode preference:

| Situation | Preference order |
|---|---|
| `denyTools` non-empty, or `permissionMode: 'normal'` | `default` → `auto` → `acceptEdits` |
| `permissionMode: 'bypass'` | `bypassPermissions` → `acceptEdits` → `default` |
| otherwise | `acceptEdits` → `default` → `auto` |

Choosing `default` puts arbitration back on the client: every risky call arrives as `session/request_permission` and Tars answers it. That is how the orchestrator deny-list ends up enforced identically on every agent instead of only on the one CLI with the right flag.

`answerPermission()` lowercases `"<toolCall.title> <toolCall.kind>"` and denies if any `denyTools` fragment is a substring, picking `reject_once`/`reject_always`; otherwise `allow_once` (normal) or `allow_always`/`allow_once`. Anything else the agent asks of the client gets an empty acknowledgement rather than silence, which would hang its turn.

Session updates handled: `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update` (including `cost.amount`), `plan`. Timeouts: `initialize` and `session/new` 90 s, `session/set_mode` 15 s, a turn 30 min by default.

**`registry.ts`.** Launch commands are fetched from the public ACP registry (`agentclientprotocol/registry`, one `agent.json` per agent) rather than hardcoded, and cached in `~/.dorothy/acp-registry.json` with a 24 h TTL. `PROVIDER_TO_ACP` maps six providers: `claude→claude-acp`, `codex→codex-acp`, `gemini`, `grok`, `opencode`, `pi`. `FALLBACK` covers five of the six: **`pi` has no fallback entry, so `pi` only has an ACP mode when the registry fetch has succeeded at least once.** Fetch failures are per-agent and never throw.

**`delegate.ts`: `delegateOverAcp()`.** Resolves the launch entry, checks the cwd (`worktreePath ?? projectPath`) exists, builds the session with provider env vars plus `CLAUDE_AGENT_ID`/`CLAUDE_PROJECT_PATH`, and attaches two MCP servers (`tars-memory` and `claude-mgr-orchestrator`) if their bundles exist. Orchestrators get `ORCHESTRATOR_DENY = ['write', 'edit', 'create file', 'multiedit', 'notebook']`. Once the session is open it sets the agent's model, then its effort, through `session/set_config_option`, when the agent offers those options (claude-agent-acp does, in 0.70 as in 0.79): a delegation used to run on the adapter's defaults, whatever the agent was set to. A value the agent refuses is logged and the turn runs anyway. On completion it calls `recordUsage()` and returns `{ ok: stopReason === 'end_turn', transport: 'acp', stopReason, text, toolCalls, usage, costUSD }`. The session is stopped in `finally`: a delegated task is a unit of work, not a conversation.

### The MCP orchestrator: `mcp-orchestrator/`

An stdio MCP server (`@modelcontextprotocol/sdk`) bundled into `extraResources` and registered with every provider under the name `claude-mgr-orchestrator`. It is a thin client of `127.0.0.1:31415`.

| Tool | Does |
|---|---|
| `whoami` | Identity handshake: reads `CLAUDE_AGENT_ID` / `CLAUDE_PROJECT_PATH` from its own environment, resolves the agent, returns the project roster |
| `list_agents` | Scoped to the caller's project by default; `all: true` for the global view |
| `get_agent` / `get_agent_output` | Detail and `lastCleanOutput` |
| `create_agent` | Defaults to the caller's project. Any provider of the registry (`provider`, with `model`, `effort`, `permissionMode`) and any CLI binary (`cliPath`, an absolute path to an executable file); an unknown provider, an API-key provider without its key and a `cliPath` that is not an executable file are refused with the reason (2.0.2) |
| `start_agent` / `send_message` | Both route to `POST /dispatch`; `send_message` accepts `message` or `prompt` so the LLM doesn't trip on naming, and a `mode` (see Receipts and send modes). Both send a `clientRequestId` |
| `stop_agent` / `remove_agent` | `stop_agent` requires a one-line `reason`; the agent then reads `stopped`, with `stoppedBy` (the caller's name) and the reason (see Stopping an agent) |
| `wait_for_agent` | Single long-poll against `/wait`, no polling loop |
| `delegate_task` | The composite. ACP first, terminal dispatch as fallback, one `clientRequestId` for both |
| `task_status` | A delegated task as the ledger keeps it, after a restart too: `GET /api/tasks/:id`, or `GET /api/tasks?clientRequestId=` for the caller's own receipt. Its asker, the agent that ran it, or Tars may read it; anybody else is answered `404` |
| `room_post` / `room_read` | The bus: publish into the caller's project room, or catch up on it. Every bound (three rounds, ten agent messages, silence markers, rotation, the session barrier) is applied by the server in `bus-store`, so writing faster buys nothing |
| `send_telegram` / `send_slack` / `send_discord` | Reply to whichever channel the request came from: for Telegram, only a chat authorized in Settings (the app's route and mcp-telegram alike); for Slack, the channel of the last allowed user who wrote; for Discord, the channel the message named, if Settings detected it or an allowed member wrote from it |
| `ask_user` | For a project's orchestrator only, or a chat's runner, which has its powers (JeanBrasse's rule of 2026-10-01; a worker gets `403` and asks its orchestrator): ask the user a question on their Telegram through their Hermes, with the relay on (`POST /api/user/ask`, `services/user-questions.ts`), from the agent's own terminal token only (not the shared token, not a delegated run's). The question goes as plain text under the agent's and the project's names, headed `[<project> #N <title>]` when a chat asks, every line of the agent's words quoted (`> `) so none can pass for Tars's own, secrets masked, cut to what Telegram takes. Hermes down: it waits, the tool says it has not reached the user yet, and it goes when Hermes takes it. The user's reply to that message, which the relay checks against Tars's own list of what it sent, is typed into the asking agent's CLI through the writer (dialog guard included) after `Message from the user via Telegram: `, a sender line only Tars makes, with their answer alone: never the question, which the agent wrote. An agent with no CLI running is not typed into, and the user is told, except a chat's runner asleep, which is woken with the answer, within the chats' limit; an answer held for the terminal and dropped because the CLI stopped meanwhile reopens the question. One open question per agent, 20 in 24 hours for the fleet, 4 hours to answer, after which the agent is told there was no answer, or that the question never reached the user, by the time it asked and never in its words. Kept in `~/.tars-private/user-questions.json` (`0600`). With the relay off: `503` |
| `chat_list` | Only in a chat's CLI started while `chatsReadEachOther` is on (off by default): the other chats of the caller's own project, each with its number, title, state and last activity (`GET /api/chats/list`). The setting is read again at every call, and the caller's chat from its own token; read only |

Auth: `Authorization: Bearer <token>`, the agent's own `CLAUDE_MGR_API_TOKEN` when the process was started with one and `~/.dorothy/api-token` otherwise, plus `X-Tars-Client: mcp` and caller identity headers. The server takes the caller from the token alone: an id header naming another agent is refused, and on the shared token the call has no agent identity at all. Timeouts: 30 s normally, 600 s on `/wait`, or an explicit override: a caller passing `timeoutSeconds` sends `(timeout + 30) * 1000` so the client never gives up before the server-side long-poll resolves.

`delegate_task` in full:

1. `POST /api/agents/:id/run-task` with `(timeoutSeconds + 60) * 1000` client timeout. While it waits it sends the caller an MCP progress notification every minute (`keepCallerListening`): Claude Code abandons an MCP call silent for 30 minutes ("sent no response or progress for 1811s; aborting", four delegations of the Parallel project on 2026-09-23), and progress resets that clock. The route answers 200 whenever the run started, `started: true`, however it ended, and 502 only when it could not start. For a run that started, return the agent's answer with a metadata line: `ended: <stopReason> | tools: … | <n> tokens | $<cost>`, then the reason when it failed (`turn_limit`: stopped at its limit, with what it said and did before it) and `stopped when the run ended: …` for the background work its turn left behind (`backgroundStopped`).
2. When no run started (`retryWithDispatch`, a launch that failed), `POST /dispatch` → `GET /wait`. Never after a run that started, and never when this call's own wait ran out (the run may still be working): either one typed the same brief into the terminal as well, and the task ran twice.
The run takes the narrower of its asker's mode and the target's own (see The ceiling for delegated runs). A run held to `plan` on an agent that offers no plan mode does not run: `/run-task` answers `409` with `code: 'permission_escalation_denied'`, and `delegate_task` does not fall back to the terminal, where the task would run in the agent's own, broader mode.

3. If the agent lands in `waiting` with `waitingReason: 'permission'`, stop. A blocking permission dialog expects arrow keys and Enter; a typed message cannot answer it and the delayed `\r` could *accept* the pending permission.

**Nothing Tars types goes into a dialog its CLI shows** (`agentTakesTyping`, `core/agent-launch.ts`). A dialog is what the PermissionRequest hook reported (`waiting`, `permission`: a permission, an AskUserQuestion, which fires that hook in bypass too, an ExitPlanMode), or a screen whose last rows end on "Esc to cancel", before that hook arrives (`dialogOnScreen`, `core/terminal-mirror.ts`; the hook came 3 to 648 ms after the dialog was drawn). The writer itself refuses, at the moment it would write (`writeProgrammaticInput`, through `setDialogProbe`, wired in main.ts): a message queued before the dialog opened does not go in after, whoever queued it, the bus, a delegation note, "send held", a bot. It waits in the terminal's queue (a bus delivery stays `queued`) and goes in once the dialog is gone. A key a person types while one is up answers the dialog and is not read as a key in the field behind it. The screen only ever adds a dialog. A refusal, with "No" or Esc, sends no hook (the turn ends interrupted: no Stop, and no idle prompt in 90 s), so the dialog is closed from the transcript: `waiting`/`permission` counts only while no `[Request interrupted by user` entry is recorded after the moment it opened (`dialogSince`, `lastInterruptAt`). Measured in the app: a post held by the dialog went in 1.5 s after an Esc and 1.2 s after "4. No". The dialog is dated by the hook script itself (`opened_at`, jq's clock, the same on macOS and Linux; bounded to the last minute), not by the post's arrival, so a refusal made before a late post still closes it. A turn ended by Esc sends no hook either: agent-watch reads an interrupt recorded after the turn began, after work was last handed over, and after the CLI now running was launched (a session resumed with `--fork-session` copies the old interruptions with their dates; the session's registration stands in only when no launch was noted, since claude registers again at every compaction), as that turn's end (`idle`, every 2 s, started by main.ts). Measured in the app: `idle` 307 ms after the Esc. What waited then still waits for the draft guard, since a person's lone Esc leaves the field unreadable to it (older than this), until the next submission. The Enter a message's paste is followed by waits out a dialog that opened in the 300 ms between them, and a person's keys meanwhile reach the dialog. A held message's reason names the dialog. Measured by the Audit on 1.8.0 with claude 2.1.280 before this: a room post said Yes to "Do you want to proceed?" and "Yes, delete it" to "Delete the build folder?" in bypass.
4. Any other `waiting`: auto-reply *"Yes, continue. Do not ask for confirmation…"* once, then wait again with `max(timeout - 30, 60)`.
5. On completion, fetch `lastCleanOutput` with 3 attempts 700 ms apart: the Stop hook posts output and status over separate HTTP calls, so the status event that resolves `/wait` can beat the output write.

### Receipts and send modes (1.9.6)

A send can carry a `clientRequestId` (8 to 128 of `A-Z a-z 0-9 . _ : -`; anything else is `400 clientRequestId_invalid`), on `/dispatch`, `/message` and `/run-task` (`services/request-receipts.ts`, ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 1). The tools of mcp-orchestrator send one per call, the agent's own when it passes one, and try a send again with the same id when Tars did not answer or could not be reached (two retries, 0.5 s and 1.5 s apart); the last failure names the id for the agent to call again with. Before, a call that timed out at 30 s was made again by the agent, and the worker got the work twice.

- **The key** is the caller, from its token, and the id; `tars` for Tars's own pass.
- **A retry** with the same payload (route, target, text, mode, model) is answered with the first outcome, `duplicate: true`, and nothing is typed or started again. One that arrives while the first is still being answered waits for that answer.
- **The same id with another payload** is refused: `409`, `code: 'clientRequestId_conflict'`, nothing sent.
- **An answer of 300 or more** did nothing and is not kept: a retry of it is tried.
- **The receipts** live in `~/.tars-private/request-receipts.jsonl` (0600, rewritten whole, entries older than 24 h dropped): the key, a SHA-256 of the payload, the time, and the outcome's ids and states (`success`, `mode`, `held`, `queued`, `interrupted`, `taskRef`, `taskId`, `started`, `ok`, `stopReason`, `outcome`, the agent's id, name and status). Never the message text: `~/.dorothy` is in every agent's `--add-dir`.
- **A delegated run** keeps its receipt from the moment it starts, with its `taskId`: a retry during the run is answered at once (`outcome: 'running'`), and `delegate_task` then says so and points at `task_status`.

`/dispatch` takes a `mode` (4.4 item 4), `auto` when absent:

| Mode | Does |
|---|---|
| `auto` | As before: typed at rest, typed into a running turn (which Claude Code takes as a steer), held behind a draft |
| `queue` | Written only once the agent's turn is over (`WriteOrigin.untilRest`, the writer's turn probe, looked at every second); answered `queued: true` while the turn runs. What is queued behind it in that terminal waits with it, in order |
| `steer` | A claude CLI only (`canInterrupt`): an Esc into the running turn, and the message once the transcript records the interrupt (`interruptTurn`, shared with the room's send now); not on record within 5 s, it waits for the turn's end, `interrupted: false`, `queued: true`. Into any other CLI: `409 not_steerable`, nothing typed |
| `restart` | The agent stopped (`stopAgent`, with the caller's `reason` or "restarted by X with a new message"), then started with the message |

`steer` and `restart` are refused while the agent works on a task another agent asked for (`409 worker_busy_for_other_requester`, `mayInterrupt`, `core/task-requests.ts`): its asker, Tars, or anybody when no task is in hand may. `restart` is refused too while another asker's request waits in the queue (`mayRestart`): the stop would end it. A turn JeanBrasse typed has no asker, and either may interrupt it. Chats (PR D) add their own rule there. `/message` stays an alias of `auto` for this version and refuses any other mode.

A message from an agent whose mode is narrower than the receiver's is marked after the sender line, in Tars's words: `Message from agent "Planner" ("p1"), task t-1a2b3c4d: (sender in plan mode, you in bypass mode) …` (`modeGapMark`, `core/permission-ceiling.ts`).

### The ceiling for delegated runs (1.9.6)

A run over ACP takes the narrower of its asker's mode and the target's own, in the order `plan < normal < auto < bypass` (`ceilingOf`, `core/permission-ceiling.ts`). Tars's own pass asks as nobody, and the run takes the target's mode; an asker that is no longer in the fleet asks as `plan`. A mode is read as a launch reads it: no `permissionMode` is `normal` (`auto` with the old `skipPermissions`), and an unknown value `normal`. `plan` is new in the main process: claude launches with `--permission-mode plan`, and an ACP run sets the session's `plan` mode or does not run; the other CLIs read it as `normal`, the narrowest they have. Held to plan, the run is refused every permission request, `ExitPlanMode` included ("No, keep planning"), and a `current_mode_update` away from plan cuts it at once (`breach`, `client.ts`; `delegate.ts` ends its processes): `409 permission_escalation_denied`, ended in the ledger with that stop reason. Below plan the order narrows little: Tars answers an ACP run's permission requests itself. The window's selector offers the other three. A persistent worker is not bound: it keeps its own mode, and a message to it is only marked (above). SECURITY.md says why this is not a boundary.

### Atomic dispatch: `performDispatch()`

```
killStalePty(agent)                       // BUG 4: worktreePath changed after spawn
if live PTY && waiting on permission  → 409, refuse
if live PTY && a CLI runs in it       → writeProgrammaticInput, clear lastCleanOutput,
                                        status = running, mode 'message'
else                                  → spawnAgentSession(), mode 'start'
```

A CLI running in the terminal is read from the terminal (`cliRunningIn`, its foreground process), not from the status: every turn ends on `idle` (the Stop hook posts it) and a failed one on `error`, with the CLI still at its prompt. Taking those for "no session" spawned a new claude over it, which kills the terminal, with no `--resume` (the resume is spent once per run): a message to an agent that had just finished a turn ended its conversation. Nor does `running` or `waiting` type by itself: over a bare shell, left by a CLI that died without its SessionEnd, the message went into the shell, which ran it as a command. A session the API starts runs `bash -l -c "cd … && exec <cli>"`: the exec hands the terminal to the CLI, so node-pty names the CLI, and a terminal handed a command counts as a CLI's for as long as it can be read, which covers the moment before the exec while the shell reads its login files. Until 2026-09-23 there was no exec, node-pty named `bash` for the CLI's whole life, and every agent the API had started read as no CLI: `/dispatch` and `/start` ended their sessions and the Dashboard's Start typed its launch line into claude's field. `/message` follows the same rule, and starts a session rather than type into a bare shell. A launch on its way (a restart, a start from a window, a bot's cold start, a session the API starts) owns the terminal until its session is up: for `CLI_BOOT_MS` (15 s) whatever runs in it, and past that for as long as its CLI runs, up to `CLI_UP_MS` (180 s). `/dispatch`, `/message` and the bots wait for it and then type into its session, and agent-watch holds its notes (`sessionStarting`, `core/agent-launch.ts`). `/dispatch` and `/message` wait `SENDER_WAIT_MS` (20 s) at most, inside the 30 s the MCP tools wait for an answer, and a launch still starting then is answered `409` with `starting: true` and nothing typed. The 20 s count from the request, not from the agent's lock: counted from the lock, a sender queued behind another was answered up to 40 s after it asked, and typed after its caller had been told it timed out (the QA, gate of #158: `200` at 31.6 s). A sender refused `409` typed nothing and takes nothing either: the delegation link (`requestedBy`) is recorded only once the agent takes keys, so the note agent-watch owes stays with whoever gave the launch its task. Until 2026-09-23 the launch was given up at 15 s whatever ran: at a load average of 120 to 300, 5 of 18 launches took longer (the Database Engineer, re-gate of #134), the sender typed into a claude not yet taking keys, was answered `200` `message`, and the text was lost. A launch whose CLI is gone, or runs past 180 s without its session, is dropped, so a CLI that never comes up does not hold its agent. Up, for a CLI on the claude binary, is not the exec: claude 2.1.280 takes no keys for a moment after it execs, and a `/dispatch` 0.1 to 0.3 s after a `/start` was typed there and lost 4 times in 5 (the Audit, gate of #134). A launch with no task (a restart, a Dashboard start) is up at its SessionStart; one that carries a task at that task's `UserPromptSubmit`, because between the two claude submits its initial prompt from its own field, and a message typed then was lost once in five. Typed once the turn runs, claude queues it and takes it after: 8 of 8 delivered once in the app. A launch is marked before its terminal is opened (the bots mark it once they know no CLI is up), and dropped when it fails, is refused or its CLI exits, so nobody waits the 15 s for it. The SessionStart registration is announced as a fleet change, and a note agent-watch held for the terminal during the launch goes in then, to the session that registered in that terminal. Measured by the Audit before this: a dispatch 0.3 s after a restart started a session over the launch without `--resume` and lost the conversation, and at 0.49 s the killed CLI's late SessionStart also took the agent from the live one. `/start` answers `409` with `cliRunning: true` when a CLI is up, as `agent:start` does. Telegram `/start_agent`, Slack `start` and a message to the super agent from either type the task into a CLI that is up instead of typing a launch command into its field, and start one where none runs, whatever the status says. Where they start one, the launch line is typed once the shell is at its prompt: it has printed something, then been quiet for 150 ms (`shellReady`, `core/agent-pty.ts`, at most 5 s). Typed before, the line goes through the terminal's canonical mode, which holds about 1 KB on macOS (4 KB on Linux), and a launch carrying a long message was cut: measured at the QA gate of #155, 995 bytes typed at once ran and 1095 did not, and a Telegram message of 946 characters started no session in 60 s.

**A running agent that does nothing** (`services/stall-watch.ts`, every minute, started by main.ts): a session that runs the state mod is marked `stalledSince` (its last heartbeat) when its heartbeat has been silent for 5 minutes (`MOD_SILENCE_MS`) while its CLI is still there, since a frozen event loop stops it and a long tool, an MCP wait or a subagent do not. Every other session is marked `stalledSince` (its transcript's last write) when it is `running`, its Claude Code transcript has had no write for 30 minutes, and no process under its CLI is at work other than its MCP servers (a command naming `mcp` or `bundle.js`) and `caffeinate`, and no `caffeinate` there is live and under its 300 s: a renewed one is a sign of life, which is all an agent in a long MCP wait (`wait_for_agent`, `delegate_task`) or a subagent shows (the Audit's gate of #283). Linux has no `caffeinate`, and keeps the rest of the rule. Measured on 01/10 over 21 live claude processes: a turn keeps a `caffeinate -i -t 300` child, renewed; a Bash tool runs as a `<shell> -c source ...shell-snapshots...` child, so a long build writes nothing to the transcript and is not a stall. The frozen claude of 28/09 (main thread in `openat`, 0 % CPU) had only an unreaped zombie under it. The note goes, once per stall, to whoever handed it the work, else to its project's orchestrator (agent-watch, `kind: 'stalled'`); `/wait` and `wait_for_agent` carry it. A write, or any other status, clears it; it is not saved. Claude Code only, whose transcript Tars finds. `e2e/stall-signal.spec.ts` drives it in the app with stand-ins: the one running a `sleep` is not marked, the idle one is, and its orchestrator reads the note.

`spawnAgentSession()` is shared by `/start`, the `/message` reconnect path and `/dispatch`, so every entry point gets identical behaviour: the identity header, the skills prefix, the MCP config for flag-strategy providers, orchestrator instructions (`electron/resources/super-agent-instructions.md`) via `--append-system-prompt-file`, the tool block, trust pre-acceptance, stale-PTY kill, the `ptyCwd` invariant and the session-ownership reset.

The model on its command line is the one the call names, or else the agent's own, `agent.model`. The same rule holds for every launch from a window (`agent:start`, which the restart below calls too, through `core/agent-launch.ts`), for Telegram and Slack, and for ACP. It is never the model the agent's previous session last answered on: that reading, from the transcript, comes back to the renderer as `sessionModel` on `agent:list`, for a screen that wants to show a `/model` typed into a terminal. Such a `/model` lasts for that session; the next launch uses the agent's model.

Every prompt is prefixed with an identity header, because agents that don't know who they are ask the orchestrator:

```
[Tars: you are agent "<name>" (id <id>), <role> of project <path>,
 working in worktree <path> (branch <branch>), stay inside this directory.
 Work autonomously without asking for confirmation and end with a clear report
 of your results: an orchestrator reads your final message.]
```

### Session ownership

The contract is documented at the head of `electron/services/api-routes/hooks-routes.ts` and enforced in three places:

- A dispatch kills the old PTY, copies `currentSessionId` into `lastKilledSessionId` (the tombstone), and clears `currentSessionId`.
- Only `session-start.sh` sends a `source` field. A post carrying `source` **registers** the session and never touches status: its startup `"idle"` would otherwise resolve the orchestrator's long-poll before the task began.
- `/api/hooks/status` refuses with a 400 a `session_id` that is not a UUID, the shape Claude Code and Gemini CLI give their sessions: the registered id becomes a transcript file name and a `--resume` argument, and `../../x` was registered until 1.9.0. On the other hook routes such an id is no proof of ownership, so the post is stale wherever there is an owner.
- Any post whose `session_id` equals `lastKilledSessionId` is dropped; any post whose `session_id` differs from the registered `currentSessionId` is dropped as stale. `currentSessionId` is *not* cleared on idle: the one-shot process is still alive at its prompt and its later hooks must keep matching.
- Fallback: if `SessionStart` never arrived (API briefly down at boot), the first non-tombstoned session that reports in is adopted, when its hooks name the terminal's own CLI (`X-Tars-Cli-Pid`; a post that names no CLI as before). A post from another CLI, a `claude -p` the agent's Bash tool started, is answered `stale` and drives nothing: not the session, not the turn, not the status. When the process table must be read to tell, the post waits for its answer before anything moves (the Audit's L4 and L5 on #380).

### The state mod

A claude agent at 2.1.289 or newer is launched with Tars's state mod (`mods/tars-state/`, shipped in `extraResources`; `spawnAgentPty` adds `CLAUDE_CODE_PLUGIN_DIRS` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` through `services/state-mod.ts`, the version read the way the updater reads it). The folder handed is not the shipped one: Claude Code writes `.claude-plugin/types/` and a tsconfig into a mod's folder at every load, which from `process.resourcesPath` is inside the signed Tars.app (the Audit's delta gate of #308, measured). At its first agent launch Tars copies the mod to `<userData>/mods/tars-state`, replacing the last run's copy and leaving out what claude wrote beside a shipped folder it could write to, with its files read-only and the two paths Claude Code writes, `.claude-plugin/types/` and `tsconfig.json`, there already as empty read-only folders (`installStateMod`): nothing can be written into the one or in place of the other, and an ordinary recursive delete still removes the copy, which a read-only tree refused. Measured live on 2.1.289, the mod loads and reports, and nothing is written. Not `~/.dorothy`, which every agent is handed. A copy that fails hands no mod. It is a hooks module of Claude Code's function hooks (an early-access API) that reports, and decides one thing (below): on the classic `SessionStart`, `UserPromptSubmit`, `Stop` and `StopFailure` events it posts what the four shell hooks post, with the same inputs, marked `via: 'mod'`, after the same instance proof (sha256 of `<TARS_INSTANCE_ID>:<challenge>` from `/api/health`), and every 15 s a heartbeat to `/api/hooks/mod-beat` naming the tool in flight. Its Stop counts what the agent leaves waiting inside its CLI as on-stop.sh does (`session_crons`, and the `background_tasks` not over) and sends it as `pending`: for a mod session the shell's post is set aside, and this count decides whether the sleep pass may end the agent (QA's gate of #322; `e2e/mod-rest-pending.live.spec.ts`). A post that fails or is answered with no 2xx is sent again after 1 s, then 3 s, in the mod's queue so the events keep their order, and given up after the third try: for a mod session Tars sets the shell hook's post aside, so a Stop's `idle` lost once left the agent `running` until its next turn (the Audit's gate of #308). Every hook hands its event on unchanged, so the shell hooks still run (and `session-start.sh` still injects the bootstrap and the memory context). Each of those four scripts names itself in `hook`; for a session the mod registered, Tars answers their posts `ignored: state-mod` and takes the mod's alone, so a late curl can never put a `Stop`'s idle after the next turn's running. A session the mod never registered (an older claude, another provider's CLI, a mod that could not load or could not prove the Tars it talks to) keeps the shell hooks, as before. Which sessions run the mod and their last heartbeat are kept in memory only.

**Permissions decided by Tars** (mods step 2, `services/permission-asks.ts`). The mod's `tool.check` hook lets Claude Code decide first (`next(e)`: the mode, the rules, PreToolUse). Only when that verdict is `ask`, the call that would open the permission dialog, does it ask Tars, with `POST /api/hooks/permission` (the agent's own token, after the same instance proof): the agent, its session, the tool, the call's id, the reason and the input's decisive fields only (`command`, `description`, `file_path`, `notebook_path`, `path`, `url`, `query`, `pattern`; never a file's content), whole: a field past 2,000 characters is not asked of Tars at all and goes to the dialog, which shows it whole, since an allow runs the whole call; and Claude Code's `reason` and `rule` (in bypass, the rule is the only reason Tars is asked). A question is bound to what the call does, not to its id alone: its fingerprint is sha256 of the tool and the asked fields sorted by name (`questionFingerprint`, computed the same way by the mod with `crypto.subtle`), an ask for the same id with other fields closes the first question and is shown afresh, an answer kept between two asks goes only to an ask of the same id and fingerprint, and every decision names the fingerprint, which the mod checks against its own call before it takes it. The agent's own shell holds the hook token and can read its next call's id from its transcript; without this, a post for that id with `ls` made JeanBrasse allow a `curl ... | sh` (the gate of #318, Medium 1, proven). An `AskUserQuestion` stays the person's, and so does any call whose input holds a field Tars does not show, whatever the tool: an edit's or a file's content, a tweet's text, a message, a delegated task, a subagent's prompt. Tars is asked only when every field of the input is one it shows (`command`, `description`, the path fields, `url`, `query`, `pattern`), each a string of at most 2,000 characters; otherwise the call stays with the terminal's dialog, which shows it all, since an allow from the window would approve what nobody saw (the Audit's rechecks of #318; the four edit tools were agreed by JeanBrasse on 05/10, the class found by the second); and a query with no call behind it is the engine's. Tars holds the question for 10 minutes from its first ask, answering each request `pending` after 20 s (`PERMISSION_POLL_MS`), and the mod asks again for the same call (`tool_use_id`), up to 40 times; a request that fails is asked again too, with the error as `after_error` (logged), and three failures in a row give the call back to Claude Code. Measured on 2.1.289: a single request held past about 30 s ended under the mod and Claude Code showed its dialog while Tars still held the question, and an answer given then reached nothing. A decision made between two asks is kept a minute for the next ask of that call. Meanwhile the agent reads `waiting` on a `permission` naming what is asked (`waitingOn`) with `permissionAsk`: the tool, `askedAt`, `until` (when Tars hands it back), `subject` (the command, path or address, whole), `fields`, `reason` and `rule`, on the agent, on every `agent:status` event (null once it ends) and on `agents:tick`; every end of a question is an event, the ones that come by themselves too (the bound, a new session, the turn's end, a dialog shown anyway, a stop, the quit). The window answers with `agent:answerPermission(id, 'allow' | 'deny' | 'ask', reason?)`. The window shows it where a person looks (frame `Permission asked of Tars`): a line under the agent's Dashboard panel header, the call whole at the top of its window's terminal column with when it was asked and, under it, Claude Code's `reason` and `rule`, each whole and only when it gave them (in bypass, an ask rule is the only reason a call comes to Tars), and the same line in place of the task on its Agents card; a file is named by its path, a tool with nothing to name by its own name. A panel offers allow only when the whole call fits its line: one cut there reads `show all`, which opens it whole in the panel, as the window shows it, with the three answers. deny first opens a field for a reason (200 characters, as main keeps), which may stay empty: Enter refuses, Esc goes back. An answer Tars no longer takes (`success: false`) reads `Tars no longer holds this question`. The pages take `permissionAsk` from the status event and the tick. Allow and deny are then Claude Code's decision, with no dialog and nothing typed into the terminal; the model reads `Permission to use Bash denied by plugin tars-state: the user refused it in Tars: <reason>`. `ask` hands the call back to the dialog, and so does Tars for a session that is not the agent's current one, a question nobody answers in 10 minutes (`PERMISSION_HOLD_MS`; measured: released at 601.9 s), the turn's end, a new session, a stop, a delete and the quit; the mod keeps Claude Code's own verdict too when Tars cannot be reached or answers anything else. Only the window answers: no API route takes an answer, since an agent that could would allow its own calls or a teammate's. Measured in `e2e/mod-permissions.live.spec.ts` (real claude 2.1.289, fake Messages API): a question held 45 s, past the hook's 10 s budget and the 30 s a single request lasted, then allowed, ran its command with no dialog opened (no `PermissionRequest`); without the `pending` answers the dialog opened and the allow reached nothing; a denied one did not, and its reason reached the model; a claude without the mod showed its dialog as before. The Hermes relay is not a way to answer yet: it is not on main (#280, #285).
- A restart for changed settings (below) kills the PTY and lays the tombstone the same way, then continues the conversation with `--resume <id> --fork-session`: the same conversation under a new session id. Every provider on the claude binary passes the flags (`resumeFlags` in `providers/cli-provider.ts`), the thirteen that point it at another vendor included: until the fix of #120 they had none, and a changed setting started them on a new conversation. Resumed under its own id, the restarted session would be the tombstone, and every one of its posts, registration included, would be dropped.
- Claude Code writes a forked session's transcript at its first turn, not before. Until then the agent keeps `forkedFromSessionId`, the session the fork continues, and `resolveResumeSessionId` falls back to it: a second restart, or an app restart, with no turn in between would otherwise find no transcript and start a fresh session.
- `loadAgents()` clears `currentSessionId`, `lastKilledSessionId`, `ptyId`, `ptyCwd` and `waitingReason`: session ownership is runtime state, and a persisted session would make the guard reject the next real session's hooks.

### Settings that apply at launch: `core/agent-restart.ts`

A CLI reads its model, its effort, its permission flag, its orchestrator restrictions and its `--add-dir` folders once, when it starts. When `agent:update` changes one of them (`model`, `effort`, `permissionMode`, the `role` the Orchestrator toggle sets, `secondaryProjectPath`, `obsidianVaultPaths`, the local provider's `localModel`), the agent's CLI is restarted on the new values through the same launch as `agent:start`, with no task, and continues its conversation (see Session ownership). When:

| The agent | What happens |
|---|---|
| no CLI running in its terminal | nothing; the next launch reads the new values |
| on a CLI other than claude (codex, gemini, grok, opencode, pi, amp) | nothing until its next launch: these report no end of turn, and their input field is not one the draft model follows |
| `running`, or `waiting` on a permission answer | restarted when the turn ends, on the status change that ends it |
| a note or room message held for it by agent-watch | restarted once that went in (it is bound to the session and would be dropped with it) |
| work its session left running in the background when the turn ended (a Bash command, a Monitor, an asynchronous Agent) | restarted once that work reported back and the turn it started ended (`pendingBackgroundWork` in `services/agent-truth.ts`, read from the transcript) |
| its field holds something typed and not sent, was typed in less than 5 s ago, holds queued messages, or Tars typed into it less than 3 s ago | restarted once the field is free (`fieldInUse` in `core/pty-manager.ts`) |
| between turns, field free | restarted at once |

After the restart the agent is `idle` at its prompt. Each decision is one `[restart] <agent>: ...` line in the main process log. A launch notes the settings its command carried, read when it built the command: `agent:start` then waits half a second for a new shell before typing, and a change saved in that half second is not in the command, so it restarts the CLI again once it is up. Noted after the wait, the change passed for launched, and the CLI stayed on the old values (the QA's gate of #123: a role taken back and given again 100 ms apart left an orchestrator by role that could edit). Skills are not a launch setting (they only preface a task); the provider, the CLI path, the project and the worktree already end the terminal when they change.

A restart that waits says so. `agent:restart-pending` is pushed to every window when an agent's restart starts waiting, waits on something else, or stops waiting (`pending: null`), with the settings it applies and what it waits on: `turn`, `permission`, `note`, `background`, `launch` (its CLI, restarted a moment ago, is still starting) or the field's `draft`, `typing`, `queued` and `writing`. `agent:pendingRestarts` answers the same state for a window that opened after the push. A restart that happens at once, or has nothing to restart, pushes nothing. Without it every wait looked like a change the agent had ignored.

`agent:restart` restarts an agent's CLI when somebody asks, at once and whatever it is doing, through the same restart: the conversation continues under a new session id. It is what the Dashboard's `restart` calls (the notice of a panel whose claude left fullscreen). The window's stop then start it replaces began a new conversation, since a start continues the last one only once per app run. A restart waiting on new settings is done by it and stops waiting. If it cannot launch, it answers the reason and leaves the agent in `error` with it.

A start with no task, which is every Dashboard start and autostart and every restart, leaves the agent `idle`. It used to set `running`, which nothing cleared until a turn the CLI never had came to an end, and agent-watch writes nothing to a `running` agent.

### A full disk: `core/disk-space.ts`

No agent terminal starts while the home folder's disk has less than 2 GB free (`LAUNCH_MIN_FREE_BYTES`, `statfs` of the home folder): `spawnAgentSession` answers 507 with `diskFull: true` and the reason, the space left included, and `spawnAgentPty`, under every other way in, throws it. On 2026-10-01 the Mac stopped on a full disk (68 MB free). A disk Tars cannot measure starts the agent.

### Stopping an agent: `core/agent-stop.ts`

`POST /api/agents/:id/stop` (and `stop_agent`, which calls it) requires `reason`, one line (`oneLine`: controls and direction marks out, 200 characters at most); without one it answers 400 and touches nothing. The window's stop (`agent:stop`, `stop(id, reason?)`) files it under `you` with the reason it was given, if any. `stopAgent` ends the agent's delegated runs, records the stop (`status: 'stopped'`, `stoppedBy`: the calling agent's name, `Tars` for its own pass or `you`; `stoppedAt`; `stopReason`), tombstones the session, saves and announces, then ends the terminal's whole process tree as the quit does (`endTerminalTree`, `core/pty-manager.ts`: the tree held still and read again, the hangup to it, 1.5 s, then SIGKILL to what is left of that tree). The API answers once the tree has ended. Measured in `e2e/stop-ends-agent.spec.ts`: a CLI deaf to SIGHUP and SIGTERM and its child gone 1.8 s after the call; before, a stop sent the hangup alone (on 28/09 two frozen CLIs survived `stop_agent`, reparented to launchd). `stopped` survives a restart of Tars (`loadAgents`), so the Dashboard does not resume it; `/wait` and `wait_for_agent` say who stopped it and why. A new terminal (`initAgentPty`, `spawnAgentSession`) clears it. An orchestrator may start again an agent the maintainer stopped, whenever it needs to, and a scheduled task too (the maintainer, 05/10): `spawnAgentSession` first copies the stop into `lastRestartAfterStop` (`stoppedBy`, `stoppedAt`, `stopReason`, plus `restartedBy`, the caller's name, and `restartedAt`; `noteRestartAfterStop`, `core/agent-stop.ts`), and `/start`, `/dispatch` and `/message` answer `restartedAfterStop` with the stop they undid, which `start_agent` and `send_message` put in their answer. The window says it where an error gives its reason (frame `Agent stopped · who and why`): the word `stopped` in the idle ink, and one line, `Stopped by Project Lead at 14:02: <reason>` (`src/lib/stop-line.ts`), in place of the task on its card, of the branch in its pane's header and of the path in its window, under its name in an orchestrator's rail, and as the title of the word. The Agents page has a Stopped chip, the Projects page offers resume and start as for an idle agent, and the window offers no second stop, which would file it under you and replace who and why. The pages read the agent's record again when its status event or the tick says `stopped`, as for `error` (`useElectronAgents`): neither carries who, when and why, and an agent stopped with no terminal ends none, so no `agent:complete` follows to make the read.

### An agent asleep: `services/agent-sleep.ts`, `core/agent-asleep.ts`

An agent with no turn for 30 minutes is put to sleep, and woken on its own conversation when it is needed; an orchestrator never sleeps (JeanBrasse's choices 5 and 6 of 2026-10-05, on RD-RAM.md 2.1: an agent gives back 265 to 600 MB asleep, and resuming took about a second). A pass runs every minute (`startSleepWatch`, stopped at a quit). It puts an agent to sleep only when all of these hold, and on any doubt it does not:
- not its project's orchestrator (`isSuperAgent`, the role);
- at rest: `idle`, `completed`, or `waiting` on its next prompt; a CLI in its terminal, and no launch on its way;
- its status, its last turn (`lastTurnStartedAt`) and the last work handed to it (`workHandedAt`) all 30 minutes old or more, and the status's time known;
- a conversation Tars can resume: a claude-binary provider, and a transcript on disk (`resolveResumeSessionId`), since woken, it must not start a new one;
- nothing owed to it: nothing held by agent-watch (`holdsFor`), no kanban note waiting for its rest, no room message waiting for it, no open question to the user (`openQuestionOf`). Each is bound to its session and would be dropped with it;
- nothing owed by others to it: no agent holding work it handed out (another's `requestedBy` names it, or a request of its is still in another's `taskQueue`, queued or written), no background work it left for its requester;
- its field free (`fieldInUse`): no draft, no write on its way, no pause in typing;
- nothing waiting inside its CLI, where no process shows it: no timer of its own (a ScheduleWakeup of `/loop`, a CronCreate) and no background task still running (a background Agent, a background Bash). Claude Code 2.1.289 hands its Stop hook `session_crons` and `background_tasks`; `hooks/on-stop.sh` posts their counts with the idle status (`pending: { crons, background }`, finished tasks left out), kept on the agent (`restPending`) until its next turn or session. A Stop hook that sent no count (an older claude) leaves it to the background work its transcript shows (`pendingBackgroundWork`), which cannot see a timer (QA's gate of #322);
- nothing alive under its CLI but its MCP servers: no tool, background task or dev server, no live `caffeinate` (stall-watch's reading of the process table), and a table that could be read.

Put to sleep, its last screen is taken from the terminal's mirror (`terminalSnapshot`), its terminal's whole tree ended as a stop ends it (`endTerminalTree`), and it reads `asleep` from `asleepSince`, its session a tombstone, its conversation kept: `resumeOnNextStart` makes the next start resume it, whatever started it earlier in the run. The log says `[sleep] <name>: asleep, no turn for 30 minutes; its CLI ends, its conversation is kept`. `asleep` survives a restart of Tars (`loadAgents`), and the Dashboard's start at launch, which takes `idle` agents, leaves it asleep. Its kept screen does not: it is in memory only, by choice. After a restart no agent at rest has a screen of its CLI, asleep or not, and a terminal's screen can hold what was typed or shown there, which Tars does not write to disk.

Whatever starts it wakes it: a message or a dispatch (`spawnAgentSession`, the message its first prompt), a room message (held for the session that wakes, as a carried one is, and typed at its first rest), a chat's cold start (Slack's included, which otherwise starts a fresh conversation), a kanban task, the window's start, `agent:wake`, or a key typed into its pane (`agent:input`, `wakesOnKey`). A lone Esc or Ctrl+C asks it to stop rather than to work, and wakes nothing; nor does a mouse or focus report or a terminal's reply. Every way an agent gets a terminal (`initAgentPty`, `spawnAgentSession`) calls `wakeFromSleep`, so none can wake it without saying so. Waking lifts the tombstone of the session it resumes, since `--resume` keeps the id. A stopped agent is not asleep, and the wake call refuses it, as it refuses an agent awake.

The contract the window reads (frame `Agent asleep · and how it wakes`):
- `status: 'asleep'` and `asleepSince` (ISO), on `agent:list`, `agent:get`, `agents:tick` and the API; `displayStatus: 'asleep'` on the tick;
- `waking: { by, via, since }` from the moment a wake starts its CLI until that CLI's session is up or its launch is given up (the launch window, `sessionStarting`), and `displayStatus: 'waking'` meanwhile. `by` is "you", "Tars", an agent's name or a chat's; `via` is `message`, `chat`, `wake`, `key` or `start`. Not saved. The status beside it is `idle` for a wake with nothing to do (a key, `wake`, a room message, which is typed once the session is up, the window's start with no task), and `running` for one that starts on a task (a message or a dispatch, a chat's cold start, a kanban task, the window's start with one): `waking` is shown whatever the status says;
- `agent:wake(id)`: `{ success }`, or `{ success: false, error }` for an agent that is not asleep or whose launch failed (it stays asleep);
- `agent:get`'s `output`, for an agent asleep, is the last screen of the CLI it slept in, as one chunk opening with RIS: the mirror's screen outlives the CLI;
- `/wait` and `wait_for_agent` answer at once for an agent asleep, with `asleepSince`.

What the window shows of it (`src/lib/asleep-line.ts`, `AgentStatusWord`): the word `asleep` in the idle ink after a hollow square, and `waking` in the waiting ink after a square of it, on its card, its Dashboard panel and its window; one line, `Asleep since 14:02: no turn for 30 minutes` or `Waking: a message from Orchestrator` (a chat message, woken, a key typed, started by), in place of the task on its card, of the branch in its panel's header, of the path in its window and under its name in an orchestrator's rail, which lists it under Asleep; `wake` in place of start, stop or restart, off while it comes back, there and on the Projects page; and the Agents page's own Asleep filter. Its panel and its window keep the screen it slept on and say over it, at the bottom, that a key typed there wakes it: over it rather than in the terminal, since the screen opens with a reset and a full-screen program's ends on its own cursor. The window does not give an asleep agent's terminal the focus, so Escape closes it: a terminal with the focus keeps Escape. A lone Escape or Ctrl+C wakes nothing anyway (`isKeystroke`), and the kept screen stays in memory only, by choice: after a restart of Tars a panel of an agent still asleep shows the hint alone. The pages read `asleepSince` and `waking` off the tick, and compare both when the list is read again.

### The orchestrator role: `core/agent-role.ts`

The Orchestrator toggle is the role, `role: 'orchestrator' | 'worker'` on the agent, and nothing else sets it: the name decides nothing, and renaming an agent never changes its role. An orchestrator gets, on every launch (Dashboard start and autostart, the API's `spawnAgentSession`, Telegram `/start_agent` and Slack `start`, the Telegram and Slack super agent, a restart):

| What | Where |
|---|---|
| the orchestration instructions, `--append-system-prompt-file super-agent-instructions.md` | every claude-binary launch |
| no editing tools: `--disallowed-tools "Edit" "Write" "NotebookEdit" "Task"` (no `MultiEdit`: claude 2.1.268 to 2.1.280 know no tool by that name and warn at every start) | the 14 claude-binary providers; over ACP the same tools are denied to an orchestrator, whatever its provider |
| "orchestrator of project" in the identity header, and the orchestration rules in `/bootstrap` | every session |
| a seat in the Chat's global room | `bus-store.ts`, read at each call |
| Telegram, Slack and Discord messages, and the relay's "@project" | `orchestratorForMessage` (`services/orchestrator-routing.ts`): the project the message names with `@project` (its folder's name, in any case, a dash for each space, @, colon or comma in it, as `@o'neil-project`), or the fleet's only orchestrator; with several and no name, or a name no project or two projects have, nobody gets it and the sender gets the list. It was the first orchestrator in the fleet, all projects considered (point E) |

A project has one orchestrator at most, and only the Agents page makes or unmakes one: `POST /api/agents` answers `403` to a request for the role, from any caller, since it would demote and restart the current orchestrator with none of the confirmation the page asks for. Through `agent:create` and `agent:update`, the agent being written takes the role from its project's current orchestrator, which becomes a worker: switching the toggle on, creating an orchestrator, or moving one into a project that has one. Both CLIs restart through `core/agent-restart.ts` (the `orchestrator` launch setting), at a moment that cuts nothing. On load, a file with two orchestrators in a project keeps the first and says so: `[role] <name> is a worker now: <project> had another orchestrator, and a project has one`.

The permission mode is the agent's own on every launch, orchestrator or not. `agent:start` used to put every orchestrator in bypass whatever it was set to, so a permission mode changed in the Agents page never reached one, restart or not, and a worker switched to orchestrator was quietly given bypass. One unattended launch still asks for bypass: a Telegram message that has to start the super agent.

The contract: `role` on `agent:create` and `agent:update`, where anything but the two values is refused; `POST /api/agents` takes `worker` and refuses `orchestrator` with a `403`. `orchestratorMode`, the toggle's old field, is read as the same toggle when `role` is absent, and kept equal to `role` on every record, for the renderer until it reads `role`. `agents.json` is at version 3 since: a file below it is migrated once on load, `role` = toggle on, or the role stored from the name, or the name itself on a record older than the role field, so no orchestrator of that day changes. After that the name is never read. A team template member saved without a role gets the same migration.

### Chats: `services/chats.ts`, `handlers/chat-handlers.ts`

A chat is one conversation with a project's orchestrator on one topic (ORCHESTRATOR-PER-CHAT.md v2.2; 2.0.0 builds it in steps). The records and their runners are in. Nothing in the window reads them yet: the chat pages come behind the "new interface" switch.

- **The record** (`chats.json`, §7):
  - the project's path as Tars saved it, its orchestrator's;
  - a number fixed within the project: #1 is Main, then 2, 3... The project's counter only goes up, so a deleted chat's number is never handed out again, and an old reply to "#3" cannot reach a newer chat;
  - its title: one line, 80 characters at most. It is "New chat" until named (`titleSource: 'auto'`), and `'user'` once named, which nothing replaces;
  - the agent that runs its conversation (`runnerId`), and every session that conversation went through (`sessionIds`, oldest first). Each session the runner registers is added, with the folder its CLI ran in (`sessionFolders`, by session id: the runner's worktree, else its project; the project or a folder inside it, and nothing else, since `chats.json` is agents' to write). A session is read from its recorded folder first, so Main still reads a former orchestrator's session, run in that one's own worktree, after the role moved;
  - `pinned`, `snoozedUntil`, `settledAt`;
  - `inbox`: the project's chat the bots, Hermes and Tars's notes post to (below, The senders), exactly one per project with chats;
  - its times.

  The conversation itself is not copied: it is the runner's transcripts.
- **The migration:** each project with an orchestrator gets chat #1, "Main", bound to it.
  - Main is the project's inbox, named by the user (never retitled), and holds the orchestrator's conversation (its `resumableSessionId`). It is created when the orchestrator was.
  - It runs once per project: the counter says it ran. A launch with nothing to make writes nothing, and a Main the user deleted stays deleted.
  - A project whose orchestrator is set later gets its Main at the next `chat:list` or `chat:create`. A project without an orchestrator has no chats (`no_orchestrator`).
  - Nothing else moves: the orchestrator keeps its record, its sessions, its tokens and its folder.
- **The channels:**
  - `chat:list` answers `{ seq, chats, problem }`, by project then number. Each chat comes with its runner as the fleet has it: status, waking, and `live` when its CLI holds a terminal.
  - `chat:create({ projectPath, title? })`. Another spelling of a project's folder (a link) is filed under the path Tars saved.
  - `chat:rename`, `chat:pin`, `chat:snooze({ until })` (a time to come, or `null`), `chat:settle`, and `chat:setInbox`, which moves the project's inbox.
  - `chat:delete` is refused for the inbox (`inbox`), and while the chat's runner has a request out at the team (`chat_has_work`, with each request: worker, id, queued or delivered, from PR A's queue). Otherwise the chat's own runner is stopped and removed with its worktree, its uncommitted work saved on `wip/` first (`core/agent-remove.ts`, the code `agent:remove` runs), and the record goes. Main's runner, the orchestrator, stays; transcripts stay.
  - `chat:send({ chatId, text })` answers `{ success, runnerId, how }`, `how` being `typed` (into a runner whose CLI runs), `held` (behind a draft in its field) or `launched`; or a refusal (`chat_limit`, `disk_full`, `provider_unsupported`, `no_orchestrator`, `runner_failed`). `clientRequestId` and the send modes come with PR B's receipts.
  - `chat:settle` puts the chat's own runner to sleep at once, or as soon as the rule allows it; `chat:rename` renames it.
  - `chat:history({ chatId, before?, limit? })` answers `{ seq, total, items }`: the chat's conversation read from its runner's transcripts (`services/chat-history.ts`, `services/chat-transcript.ts`), across its `sessionIds` in order, then its runner's own session when the mirror has not caught up. It looks in `~/.claude/projects` and each account's folder, under the project's path and the runner's worktree, every spelling (`transcriptRoots`). Items are numbered `n` by their place in the chat; `before` takes those under it, `limit` the last of them (500 by default, 1000 at most).
    - An item is the user's words (`user`), a message Tars typed from an agent or a channel (`message`, `from` its name), a note from Tars or from Claude Code (`note`: `[Tars]` lines, `<task-notification>` reports), the runner's text (`text`), one of its tool calls folded to one line of at most 120 characters (`tool`: `delegate_task -> Backend`, `Bash: git log -3`, `Read <path>`), a divider (a compaction, or the start of each session after the first), or one raw line of at most 200 characters for a line Tars does not know or cannot read (`raw`): never dropped.
    - Left out, by name: a tool's output, the runner's thinking, meta and compaction-summary user lines, a command's output (`<local-command-stdout>`), the attachments Claude Code keeps for the model (a message typed in during a turn, `queued_command`, excepted), and its bookkeeping lines (`mode`, `ai-title`, `file-history-*`, `queue-operation`...). The history a resumed session copies is shown once (by uuid). A session whose transcript is gone says so; the others are read. The last line, still being written, waits.
    - Proven failures first against real lines of claude 2.1.280, 2.1.289 and 2.1.296, their words replaced (`__tests__/fixtures/transcripts/`).
  - `chat:events`, an event to every window, `{ seq, chatId, type, ... }`: `item` (an item the live runner's transcript gained since the first `chat:history` snapshot of that chat, its files looked at each second while its CLI holds a terminal; a chat nobody asked for counts from when its runner is first seen live), `meta` (the chat as `chat:list` shows it, after each change, each session mirrored and each rebinding of Main), `deleted`, `removed` (`itemIds`: items told before that the chat no longer holds, a session's transcript gone, declared once and before the items that moved back are sent again), and `state` (its runner's status or `live` changed). `chat:list` and `chat:history` answer the seq they are a snapshot at; each event carries the next. On a gap, the window asks again.
  - `agent:queue(agentId)` answers `{ agentId, current, queue }`: the request in hand and the ones waiting (PR A's queue: id, asker and its name, state, when queued, `chatId: null` until chats have runners). An `agent:queue` event says when it changed, looked at on each fleet change and each second.

  Every refusal carries a sentence the window shows as it is. `seq` moves at each change written, in memory: a new run is a new snapshot. It is one counter for `chat:list`, `chat:history` and `chat:events`.
- **The limit:** `system:chatLimit` gives how many chats may have a live CLI at once, across every project, Main counted.
  - The rule: one per 5 GB of RAM (`os.totalmem()`, a GB being 2^30 bytes), from 1 to 8. 8 GB: 1, 16 GB: 3, 24 GB: 4, 32 GB: 6, 64 GB and more: 8.
  - With it: `ramGb`; `source`, which is `ram`, or `override` for the E2E's `TARS_CHAT_RAM_GB` (read only when `DOROTHY_E2E=1`); and `working`, the chats whose runner holds a terminal now, or a launch let through.
  - Enforced at each send that launches a runner (below), never by a silent wait.
- **The runners** (`services/chat-runners.ts`, PR D):
  - **What one is:** an agent record of its own, made at the chat's first send: `role: 'worker'`, `kind: 'chat'`, `chatId`, `teamOrchestratorId`, named "<orchestrator> · <chat title>" (a worker's sender line tells the chats apart). Main's runner is the orchestrator itself, and follows it: when the role moves to another agent (the toggle, a create), Main's record is rebound to the new orchestrator, its sessions kept as history and the new one's conversation added last, and the log says so (`followOrchestrators`, `services/chats.ts`; also at launch and on `chat:list`).
  - **Its powers, not its place:** `hasOrchestratorPowers()` (`core/agent-role.ts`) gives it the orchestrator's launch instructions, its `--disallowed-tools`, the ACP deny list, the right to write to and ask the user; every check that means "the project's orchestrator" (the bots' target, routing, `assignRole`, the stall fallback, the sleep refusal) reads the role and leaves runners out. A source test classifies each role site.
  - **Its configuration:** read from the project's orchestrator at each launch, whoever starts it (the slot gate takes it), never copied once (provider, model, effort, permission mode, skills, Claude account pin, CLI path, and its brief, the `savedPrompt` its bootstrap shows as its role). Saving the orchestrator, or pinning its account, passes it on, a live runner restarted on what changed (#120). A runner's own settings are refused from the window (`agent:update`, the account pin): they are the orchestrator's.
  - **Who it is told it is:** its bootstrap says it is the orchestrator of the project, in which chat (title and number), that the project's other chats may run at once, and that its workers answer it with `send_message` to "requester" (`core/chat-identity.ts`).
  - **Its worktree:** `<project>/.worktrees/chat-<8 hex of the chat's id>` on `chat/<the same>`, started from `origin/HEAD` (fetched first), else `origin/main` or `origin/master`, else the local `main` or `master`; never from the root's current branch. Its dependencies are cloned (#325), and the project's `.claude/settings.local.json` is copied once. Under 2 GB free (`core/disk-space.ts`) the first send answers with the reason and makes nothing. `scripts/worktree.mjs` counts and lists it as any worktree of the repository.
  - **A send:** a runner whose CLI runs gets the words typed as the user's own, with no sender line, once its launch takes keys and never into a dialog; that decision is taken before the lock, so it never waits behind another chat's runner being made. Otherwise it is launched with them as its prompt, its conversation resumed (`resumeOnNextStart`), which a sleep does not lose; a terminal whose CLI has ended is a bare shell, which holds no slot and is never typed into. The words are a turn, never kept as the agent's brief (`message`, `core/agent-launch.ts`): a send that starts Main's orchestrator leaves its brief as it was. A runner the user stopped goes on with its conversation too, under a new id (`--fork-session`, as a restart does): the stopped session's id is a tombstone, and a session resumed under it would have every hook dropped as stale.
  - **The slots:** one lock holds the count, the choice, the sleep and the launch together, so two sends cannot both take the last slot. Every start of a runner takes the gate: a send, a Start from the window, a bot, a wake, a restart. A full limit puts to sleep the least recently active runner the sleep rule allows, its 30 minutes aside, never Main's. A runner refused only for a moment is looked at again before anything is answered: its Stop hook's process still under its CLI after a turn, a process table that did not come, or a message Tars typed in less than 3 s ago (`WRITE_SETTLE_MS`). When none may sleep, the send answers `chat_limit` with `limit`, `ramGb`, the chats working and the sentence: "2 chats are already working, the most this Mac runs at once (10 GB of RAM, one chat per 5 GB). Wait for one to finish, or stop one: Main, Release."
  - **After an abrupt stop:** the runners that were working beyond what the limit leaves stay asleep, the least recently active first, and their next launch opens with why.
  - **Who they work for:** an orchestrator whose CLI cannot resume a conversation (a provider other than claude) gets Main and no other chat: `provider_unsupported` at creation, and at each launch or send of a chat other than Main once the orchestrator has moved to such a CLI. Its runners are neither copied onto that CLI nor restarted on it. From 2.0.1 a send to such a chat is refused even while its runner's claude still runs: that runner is left to finish, its turn ending as it would and the agents it gave work to still answering it (the sleep rule keeps it awake while it is owed), and the refusal says so. Stopping it at its turn's end would lose those answers, since a stopped runner cannot be started again while the orchestrator is off claude.
  - **A record is a claim:** `chats.json` sits in `~/.dorothy`, which every agent may write, so the runner a record names is checked against the fleet before anything is done for it (`recordedRunner`, `core/chat-slots.ts`; the Audit's Info on #361). Main's must be the project's orchestrator; any other chat's, the runner made for that chat, in its project. A record that names another agent shows no runner, holds no slot, and has nothing typed, launched, put to sleep or renamed for it: a send answers `runner_mismatch`. The other way round, an agent marked `kind: 'chat'` in `agents.json` that no chat names goes back to a plain worker at launch (`unconfirmedRunners`), so the mark alone gives no powers.
  - **Deleting a chat:** refused while its runner has work out; its runner is stopped, checked again for work it asked for meanwhile, then removed with its worktree, and the record goes. Its copy of the project's `.claude/settings.local.json` goes first (the grants were its own; the project keeps its file): Claude Code puts that file in the global git ignore, which made it an ignored file no commit keeps, and kept the whole worktree for it. Any other file git ignores that is not a cache still keeps the worktree, and the answer says so (`worktreeKept`).
- **Replies** (the Audit's R5): `/dispatch` and `/message` read the target `requester`, `orchestrator` or the orchestrator's name as whoever asked the caller for its current task when that is a chat's runner (`requester` reaches any asker), else the project's orchestrator, and answer with `deliveredTo`. An agent's id always reaches that agent (`core/reply-target.ts`).
- **The senders** (PR F, `core/chat-inbox.ts`, `services/chat-senders.ts`, `services/chat-addressing.ts`): whoever writes to "the project's orchestrator" reaches the project's **inbox** chat, Main unless the user made another chat the inbox (`chat:setInbox`). Main is the orchestrator itself, and what goes to it takes the path it always took; another chat's runner is reached through `chat:send`'s own path (its limit, its wake, `chat_limit`'s sentence), after its sender's line. A project with no chats has its orchestrator alone, and so does a project whose only chat is Main, as in 1.9.7: no chat prefix, no chat name in the room, and a message that starts with `#N` (an issue's number) goes to the orchestrator as typed. The rules below apply from a project's second chat on.
  - **The bots** (Telegram, Slack, Discord) and **the Hermes relay**: a message naming no chat goes to the inbox; `#N text` at the very start (or `@project #N text`) goes to chat N of the project; an `#N` the project has no chat for reaches nobody, and the sender gets the numbered list. A settled or asleep chat named so is woken, within the limit.
  - **A reply goes to the chat it answers, exactly:** through the relay, its sent log (`relay-sent.json`) keeps each message's chat id; through Tars's own Telegram bot, `telegram-sent.json` keeps the Telegram chat and message ids of what it sent for a chat, with that chat's id, 7 days. Slack and Discord have no reply-to routing: the number is their way.
  - **What a chat sends** to Telegram (bot or relay), Slack or Discord starts `[<project> #N <title>]`, Main's `#1 Main` included; so do the bot's receipts for a chat, and the questions a chat asks with `ask_user`.
  - **Notes**: a kanban task a worker files is noted in the inbox (none when a chat filed it); the error triage's note (`tellOrchestratorAsTars`) and a stall nobody asked for go to the inbox. A note never starts a CLI: an inbox whose runner is not running gets none, as an orchestrator not running got none.
  - **User questions**: any chat's runner asks; the question is headed by its chat, and the answer goes back to that runner, waking it through `chat:send` when it sleeps.
  - **The room** is unchanged: JeanBrasse's messages to a project go to its Main and its team, never to a chat's runner, which is no member. What a chat posts reaches the room under `the orchestrator of <project>, chat #N "<title>"`, and JeanBrasse's answer to it, mentioning that runner (or `bus:sendNow` to it), goes back to that chat.
- **Reading another chat** (4.4 item 5, PR F): `chatsReadEachOther` in the settings, off by default. On, a chat's CLI started after it gets `chat_list` (mcp-orchestrator, `TARS_CHATS_READ=1` in its environment): the other chats of its own project, by number, each with its id, title, state and last activity, from `GET /api/chats/list`, which reads the setting at every call and the caller's chat from its own token, never from the call. Off, the tool is not there, and the route answers `403 chats_read_off`. Nothing writes to another chat. `chat_read` comes once the chats' history (PR E) is on main.
- **Cancelling** (M1, R6): `POST /api/tasks/:ref/cancel` and the MCP tool `task_cancel` take back a request still queued at a worker, its waiting message withdrawn from the worker's terminal. Its requester may; the project's persistent orchestrator may with a reason, which the asking chat is told; anyone else gets `not_your_task`. A request already typed in answers `already_delivered` (`core/task-cancel.ts`).
- **Steer and restart across chats** (M1): PR B's rule refuses a `steer` or a `restart` that would cut another asker's work (`mayInterrupt`, `mayRestart`). When that asker runs a chat, the answer is `worker_busy_for_other_chat` and names it (`chat: { title, number }`, from `cutWorkOf` and `chatOfAsker`); no chat cuts another's work, Main's orchestrator included.

### Cross-project scoping

`assertSameProject()` guards `/start`, `/dispatch`, `/run-task`, `/stop`, `/message` and `DELETE`. It reads the caller's project from a request header:

- No header **and** `X-Tars-Client: mcp` → 403. An agent's MCP always announces itself; if it does so with no identity its calls cannot be scoped, and defaulting to "allow" would let it drive every project's agents.
- Header matches the agent's `projectPath` → allow.
- Mismatch → 403 with the agent's project named, unless `allowCrossProject: true` is in the body (or the query string, for DELETE, which has no parsed body).
- No header at all (the renderer, `curl`) → unrestricted.

`GET /api/agents` uses the same header to filter the listing and reports `scopedToProject`. An orchestrator that only ever *sees* its own team cannot pick another project's agent id by mistake.

### What guarantees delivery, and what does not

**Guaranteed.**
- `/run-task`: the ACP turn either resolved (with `stopReason` and usage) or the call returned an error. This is the only path that answers with what the agent did (the `clientRequestId` receipts of 1.9.6 say only that a send was made, never what came of it).
- The dispatch decision is atomic: message-vs-spawn is made server-side under the event loop, so a stale client-held status can no longer route a prompt to a dead PTY. `ptyProcesses.delete(ptyId)` happens *immediately* in `onExit`, before the 1.5 s status delay, because `node-pty` `write()` on a dead PTY is a silent no-op.
- Stale hook posts cannot corrupt a live task's status or output.
- The orchestrator deny-list is enforced by the protocol on every ACP provider.

**Not guaranteed: be explicit about this.**
- `/dispatch` on the PTY path returns as soon as the bytes are written. There is no acknowledgement that the agent read the message, and none that it understood it as a task rather than as terminal noise. `mode: 'message'` means "typed into a live session", nothing more.
- A message into a field somebody is using is held, not typed (`held: true`, and `HELD:` from `send_message`, `start_agent` and `delegate_task`). It goes in when the field frees: at a pause in the typing, when what was typed is sent or cleared, or when the session transcript shows a slash command typed by hand has finished (`<command-name>` and `<local-command-stdout>`, written when a command closes, `lastLocalCommandAt`). Only when the last key typed there is the Enter or Esc that closed the panel: a key typed between the panel closing and its record went into the field. `/help`, and `/config` closed without a change, write no record; `/model` cancelled with Esc writes two `system` records of subtype `local_command`, which the reader skips on purpose, since the same pair is written when the "Switch model?" confirmation is backed out of with Esc while the picker stays open. Those three leave it held until the next key or Ctrl+C in that terminal. A terminal that exits drops what it held (`terminalExited`). A terminal's reply is never a key (`input-draft.ts`, bug-held-forever-05-10.md): a CLI asks its terminal something, the panel's xterm answers in the input stream, and the panel passes the answer on with what is typed. Read as keys, xterm's answer to Claude Code's `ESC ] 11 ; ?` (`ESC ] 11 ; rgb:0f0f/0f0f/0f0f ST`, measured in the app) made the draft unknown and held every later message until a person cleared a field that was empty: three agents waited 2 h 20 to 2 h 40 on 04/10. OSC and DCS strings once ended (BEL or ST), and the CSI replies DA1, DA2, CPR, DSR, DECRPM and the window reports, are passed to the CLI and followed as nothing: they neither change the draft nor count as typing. An agent reads `running` once a message is in its terminal, not when it is held behind one. A message an agent sent that is still held three minutes on (`HELD_RETELL_MS`), its target at rest, is told to that agent again, once, as Tars: why it waits, and that only a person at that terminal ends the wait.
- A message typed into a CLI, short or pasted, comes after a line naming its sender as Tars verified it (`senderLine`, `core/pty-manager.ts`: the agent by name and id, with the id of the request it hands over, `, task t-xxxxxxxx` (`core/task-requests.ts`: the turn whose prompt carries it is bound to that request and its asker); Tars, or Telegram, Slack, Discord, Hermes). Claude Code 2.1.280 hands a folded paste to the model as `<pasted_content>`. That the line stays outside the tag was measured once, with a real account in a sandbox (session 27029ce7, 2026-09-22 23:31Z: `Message from agent "Beta" ("sb-beta"): ` then `<pasted_content id="eab1">`), and fits JeanBrasse's transcripts, where 40 of 41 folded pastes begin their record with the tag; a stub API with key auth never folds, so the gate of #128 could not see it. Whether the receiver treats the message as work is for its instructions to say, not the line: measured with the same brief on Haiku 4.5, a bare paste was declined, `Message from Tars-Orchestrator:` was carried out, and two other wordings were declined again. A line of the message itself that reads like a sender line ("Message from …", any case, after spaces, the first line included) is quoted with `> `, so no message can show a second, forged sender (`quoteSenderLookAlikes`, the Audit's gate of #231). Its skeleton is compared, not its bytes nor its words (`skeletons`: NFKC and NFD, every look-alike of the eight letters of "message from" read as the letter, from Unicode's confusables, UTS #39, and each one's Latin forms with a bar, a hook, a stroke or a tilde through it, by their Unicode 16.0 names (QA's recheck of #240: "Mɛssage", "frøm"), then everything but a to z dropped: marks, blanks, punctuation, digits, and the letters that draw as one of those, a katakana prolonged-sound mark as a list dash or a dental click as a pipe): a no-break or zero-width space, a Cyrillic e, a line in bold or brackets, an Armenian, Cherokee or small capital letter each got past a match on the bytes or the words (the Audit's gates of #240). A line that only starts with the words, "Message from QA was good", is quoted too. What it does not quote, by the choice to read a line from its start: one whose skeleton has letters before the phrase, "Fwd: Message from JeanBrasse ...", "Re:", "Note:", "PS", "a)" or "i." (QA's recheck of #240), and a phrase after a separator that is typed as no new line (a lone CR, \v, \f, U+0085, U+001C to U+001E), which joins the line before it. Every line is not quoted instead: Tars's own notes, the bus's fences and JeanBrasse's relayed messages would then reach the receiver as a quotation.
- **Status is hook-driven, and only the `~/.claude` family fires hooks.** `codex`, `grok`, `opencode` and `pi` declare `supportsNativeHooks: false`; `gemini` declares `true` but has its own hook shape. For those CLIs the only status transition is the PTY-exit handler, 1.5 s after the process dies. `wait_for_agent` against them effectively waits for process exit or times out, and `lastCleanOutput` is never populated.
- `/run-task` emits `agentStatusEmitter.emit('status', {…})`, while `/wait` listens on `` `status:${agentId}` ``. **An ACP run does not resolve a concurrent long-poll on the same agent.** In the normal `delegate_task` flow this is invisible, because ACP and the wait path are mutually exclusive; it bites anything that dispatches over ACP and waits separately.
- Project scoping follows the caller's token, never the `X-Tars-Caller-Project` header. An agent process started without `CLAUDE_MGR_API_TOKEN` (outside Tars, or under a CLI that does not hand its environment to its MCP servers) has no identity: its guarded calls get the no-identity 403, and the bus refuses it.
- The auto-continue in `delegate_task` fires once against any non-permission `waiting` state. If the agent was genuinely asking a question, it gets answered "yes, continue" without a human.
- `/wait` long-poll and `apiRequest`'s 600 s ceiling are independent of the ACP 30-minute turn timeout. A task can outlive its watcher.

---

## §5 Memory

`electron/services/memory-hub.ts`. One memory for every agent, whatever CLI it runs. Before this, only the first two sources existed in practice and only claude-binary CLIs ever saw them.

### The five federated sources

| id | Label | Backed by | Search |
|---|---|---|---|
| `project` | Project memory | `~/.claude/projects/<encoded>/memory/*.md`, `MEMORY.md` first | paragraph substring |
| `observations` | Session observations | `~/.dorothy/observations/<encoded>.jsonl` | line substring over the last 500 |
| `hermes` | Hermes memory | gateway `MEMORY.md` / `USER.md` + searchable session history | gateway-side |
| `gbrain` | gbrain | remote HTTP MCP endpoint | tool discovery, see below |
| `honcho` | Honcho | remote HTTP MCP endpoint | tool discovery, see below |

Project directory names are resolved by trying three encodings of the project path (`[^a-zA-Z0-9]→-`, `[/.]→-`, `/→-`): Claude Code's path-as-folder-name scheme has drifted.

Remote backends are probed rather than assumed. `pickSearchTool()` scans the endpoint's tool list for `memory_search`, `search_memory`, `honcho_search`, `search`, `recall`, `query`, `retrieve` (exact or `_`-suffixed), then anything matching `/search|recall|query|retriev/i`. The query parameter name is read off the tool's own input schema (`query`, `q`, `search`, `text`, `question`, default `query`).

`memoryStatus()` returns `{ configured, reachable, detail, tools }` per source, with `reachable` meaning *we spoke to it*, so an agent can tell "nothing recorded" apart from "a backend is down".

### Delivery mechanism 1: the bundled MCP server

`mcp-memory/` registers as `tars-memory` with **every** provider, not just Claude. Four tools:

| Tool | Purpose |
|---|---|
| `memory_search` | Federated search. Optional `sources[]` and `limit` (10 when none is named). Reports which sources could not answer |
| `memory_read` | The full digest for the project |
| `memory_write` | Append a durable fact. `file` defaults to `MEMORY.md`; topic files for detail |
| `memory_sources` | Per-backend reachability, so an empty search is diagnosable |

It calls `/api/memory/search`, `/api/memory/context`, `/api/memory/write` and `/api/memory/status` on the local API, resolving the project from `CLAUDE_PROJECT_PATH` when not given explicitly.

The two remote backends are *additionally* registered as HTTP MCP servers directly in `~/.claude.json` by `setupMemoryBackends()`, so every claude-binary agent gets the same tools the user's Hermes instance and claude.ai connectors use. That function writes the file the `claude mcp add -s user` command maintains, directly: no dependency on the `claude` binary being on the packaged app's PATH, and no CLI boot blocking the main process. It refuses to touch anything if the file won't parse, and on removal only deletes entries whose URL matches Tars's own settings.

### Delivery mechanism 2: prompt injection

```ts
needsPromptInjection(providerConfigDir) === (resolve(configDir) !== resolve(~/.claude))
```

Providers whose config dir is `~/.claude` inherit Claude Code's `SessionStart` hook, so the digest already reaches them. `codex`, `gemini`, `grok`, `opencode` and `pi` have no such hook; for them `spawnAgentSession` calls `assembleDigest`, which waits for Hermes no longer than every session start does (`HERMES_START_BUDGET_MS`, 1.5 s), and prepends the result, wrapped:

```
<project-memory>
What this project already knows. Treat it as established fact, and search
the memory tools before re-investigating anything mentioned here.
…
</project-memory>
```

Memory is context, not a precondition. Any failure (a slow gateway, an unreadable file) is swallowed and the agent starts anyway.

### The hook path

`hooks/session-start.sh` runs on every fresh Claude session and does three things in order:

1. Registers the session id (`POST /api/hooks/status` with `source`), retrying once after 1 s: a lost registration would make the stale-session guard ignore every later post from that session.
2. `GET /api/agents/:id/bootstrap`: identity, worktree, saved role prompt, the project's team roster with each teammate's status/branch/skills, and orchestration or working rules. This is what makes the "who am I / who is my team" handshake automatic instead of a ritual at the start of every session.
3. `GET /api/memory/context?project_path=…` for the digest.

Both are concatenated and returned as `hookSpecificOutput.additionalContext`. The API token is read from `~/.dorothy/api-token` and passed via `-H @<(printf …)` so it never appears in the process list.

`hooks/post-tool-use.sh` feeds `POST /api/memory/remember`, appending to the observation ledger (capped at 1000 lines, trimmed to 500). Content is truncated to 500 chars, type to 40.

### Digest budget

`MAX_SECTION_CHARS` 4000 per file, `MAX_OBSERVATIONS` 15, Hermes's two memory files read at once, each raced against `HERMES_START_BUDGET_MS`, 1.5 s, and kept if it came in time, for the hook's route and the prompt alike, and no caller may wait longer: under the hook's 3 s curl, so a Hermes that accepts the connection and never answers costs its own memory, never the project's. It was 4 s for the hook's route, and the hook gave up first: the agent started with no memory at all.

---

## §6 Usage accounting

Two independent ledgers, because no single source covers everything.

### Source A: transcript parsing (Claude only)

`electron/services/transcript-usage.ts`. Claude Code only writes `~/.claude/stats-cache.json` for some account types; without it the Usage page had no tokens and therefore no cost at all. Every assistant message in `~/.claude/projects/**/*.jsonl` carries its own `usage` block, so the numbers are read from there.

- Walks `~/.claude/projects` to depth 4, collecting `*.jsonl`.
- Cheap pre-filter: skip any line not containing `"usage"`.
- Keeps only `type === 'assistant'` entries with a `message.usage`.
- **De-duplication.** Resuming a session copies earlier assistant messages into the new transcript: on a real history that is over half the lines, so counting them twice would roughly double every cost on the page. Key: `` `${message.id}:${entry.requestId}` ``, skipped if already seen (the degenerate `":"` key is exempt).
- `modelUsage` is an `Object.create(null)` map. A transcript's model id is attacker-influenceable and `modelUsage[model] ||= …` on a plain object would let `"__proto__"` write onto `Object.prototype` inside the main process; `__proto__`, `constructor`, `prototype` and `<synthetic>` are rejected outright.
- 60 s memo, kept past the minute while no transcript moved (the path, the time and the size of each) and the catalogue is the one that priced it; a pass that could not read a transcript is never kept, since a file made readable again keeps its time and size.
- A model's price is looked up once per scan. `priceFor` walks the whole catalogue for a dated model id, and with no catalogue in memory it tried to read the missing cache file: at every turn, about 608 thousand on JeanBrasse's transcripts, the adding up took 5 to 16 s.
- The scan starts at launch (`prewarmClaudeStats`, once the IPC handlers are registered). `claude:getData` hands the page the stats as last computed, at once, and computes a memo older than the minute again behind it, one computation whatever the polls (`getClaudeStatsNow`); the page's 10 s poll picks the new numbers up. The bots' `/stats` wait for numbers no older than the minute (`getClaudeStats`).

**Cache-write pricing.** `usage.cache_creation` splits into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`; when the split is absent, the whole `cache_creation_input_tokens` figure is treated as 5-minute. models.dev publishes `input`, `output`, `cache_read` and the 5-minute `cache_write`. The 1-hour write is **derived**, not guessed: Anthropic prices the 5-minute write at 1.25× base and the 1-hour write at 2× base, so `cache1h = input * 2`. Missing `cache_read` falls back to `input * 0.1`.

```
cost = input/1e6·p.input + output/1e6·p.output
     + cacheRead/1e6·p.cacheRead
     + write5m/1e6·p.cache5m + write1h/1e6·p.cache1h
```

`web_search_requests` from `usage.server_tool_use` is counted but not priced. Daily buckets key on the **local** calendar day of `timestamp` (`localDateKey`), not on its first ten characters, which are the UTC day: a turn at 02:30 in Tbilisi belongs to that day, not to the one before.

**Per day.** Each entry of `dailyModelTokens` is one local day:

| Field | Per model, that day |
|---|---|
| `tokensByModel` | input + output |
| `breakdownByModel` | `{ input, output, cacheRead, cacheWrite }`, cache writes as one number |
| `messagesByModel` | distinct replies, counted off the dedup key |
| `costUSD` | (not per model) the day priced from its own tokens, cache included |
| `costByModel` | the same cost split by model: each turn's own price, 1h and 5m writes apart, added to the model that answered |

Two sums hold by construction and are tested (`transcript-usage.test.ts`, `handlers/usage-per-day.test.ts`): over a day's models, `costByModel` adds up to that day's `costUSD`; over the days, `costByModel[m]` adds up to `modelUsage[m].costUSD`, less the turns that carry no timestamp and so belong to no day. Measured on JeanBrasse's history on 2026-09-22 (25 days, $10,227.39, no undated turn): the first held to 5e-12 USD on every day, the second to 5e-11 USD on every model. `costByModel` cannot be rebuilt downstream from `breakdownByModel`, which does not say which writes were 1h: pricing them all at the 5m rate came out $656.84 (6.5 %) under on the same history.

`getClaudeStats()` reads `stats-cache.json`, else `statsig_user_metadata.json`, else computes from local files, and then scans the transcripts in every case. When the scan finds usage, its `modelUsage`, `dailyModelTokens` and `lastComputedDate` replace the cache's, and what only the cache counts (`totalSessions`, `totalMessages`, `dailyActivity`, `hourCounts`, `longestSession`, `firstSessionDate`) is kept. A `stats-cache.json` used to be reason enough to skip the scan, which left those machines with each day's input+output tokens and nothing else: no cost, no cache, no replies, and only as recent as the last `/stats`. The scan they pay now is the one every other machine pays: on 1.2 GB of transcripts, 4.3 to 6.3 s the first time, in slices, which starts at launch rather than when a page asks, then 73 to 167 ms a minute while a transcript moves. Days the cache holds from before the oldest transcript are no longer shown; they carried tokens only.

### Source B: the usage ledger (every provider)

`electron/services/usage-ledger.ts`, `~/.dorothy/usage-ledger.jsonl`.

No CLI other than Claude Code writes transcripts, which is why "Usage by Provider" showed nothing: it read a file only the statusline wrote, and the statusline is off by default. Every ACP turn reports its tokens, so `recordUsage()` writes them as they happen: the only source that covers Codex, Gemini, Grok and the rest.

```ts
interface UsageEntry {
  ts; agentId; provider; model?;
  inputTokens; outputTokens; cachedReadTokens?; cachedWriteTokens?;
  costUSD?; transport: 'acp' | 'pty';
}
```

When the agent did not report a cost, `recordUsage` prices the turn itself from `priceFor(model, provider)`, using the same `cache_read ?? input*0.1` / `cache_write ?? input*1.25` fallbacks. `ProviderTotals.measured` is meant to record whether at least one entry carried a cost from the agent rather than from the catalogue, but `providerTotals()` initialises it to `false` and nothing ever sets it.

Bounded: appended per turn, trimmed to the last 12 000 lines once it passes 20 000. A line with no `provider` or no parseable `ts` is dropped by every reader alike. `usageByProvider(sinceDays)` answers the `usage:by-provider` IPC channel from one read of the file:

| Field | What it holds |
|---|---|
| `providers` | `providerTotals(sinceDays)`: per provider, over the last `sinceDays` 24-hour periods back from now, or the whole file |
| `dailyCost` | cost per local day, every provider merged, over `sinceDays ?? 30` |
| `daily` | every turn in the file per local day, provider and model: `{ date, provider, model, inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, costUSD, turns }`, whatever `sinceDays` says. Per provider it adds up to `providerTotals()` |
| `oldest` | the first local day still in the file, which a trim moves later than the first turn ever recorded; `null` when the file is empty |

A `claude` row is a turn the transcripts count as well: the Claude ACP adapter runs the claude binary, which persists its session under `~/.claude/projects`, so adding the two double-counts it. Codex, Gemini, Grok and opencode rows exist nowhere else.

### Tasks and what each cost

`electron/services/task-ledger.ts`, `task-cost.ts`, `task-watch.ts`; `~/.dorothy/task-ledger.jsonl`, and each task's text apart in `~/.tars-private/task-texts.jsonl`, where no agent is handed it (JeanBrasse's answer of 2026-10-05); IPC `usage:tasks`.

A task is one piece of work in one agent: it opens at the first turn after a rest (`UserPromptSubmit`) and ends at the next rest, as `agent-watch.ts` reads one (idle, stopped, or waiting for the next prompt), or at `completed` or `error`. A permission prompt or a question is not a rest, and neither is a rest with background work still running (`pendingBackgroundWork`, which keeps the lines of a transcript it reads while the file is unchanged, so that task-watch and agent-watch, which both ask at a rest, read it once). The turns in between are counted in it, with every session they ran in.

What started it is the hand-off before that turn, within 15 minutes, noted where Tars hands work over: a message written into a terminal (`writeProgrammaticInput`, its sender naming an agent, Tars or a chat), a session started with a task (`spawnAgentSession`), a chat's launch (`bot-core.ts`). The first turn after a hand-off takes it, whichever task that turn belongs to. A turn nobody handed is `terminal`, named by its prompt. A hand-off from an agent records it as the requester, and the requester's task open at that moment as the parent, except when it is a report: a worker writing to the agent that handed it its task, or to its project's orchestrator, as #302 has it for the delegation link. The task that report starts has no parent, so a lead's next task and what it hands on after are not filed under the worker's (QA's gate of #305). A run over ACP (`/run-task`) is a task of its own from the moment it starts (`acpStarted`), ended with why its turn stopped, what it answered and the tokens and cost it reported (`acpEnded`); its answer, cut to 8,000 characters, is kept in `~/.tars-private/task-results.jsonl` (0600) beside the texts, never in the shared ledger. A run still open when Tars stopped is ended at the next launch as `stopped` with `stopReason: 'interrupted'`, and its asker is told once that it was cut and nothing was retried (`interruptedAtStart`, `tellDelegationCut`). `task_status` reads a task by its id after a relaunch as before it. With each task: the agent's provider, model, Claude account, project and worktree at its start, and its text, one line of at most 200 characters.

The file is append-only (a line per task opened, turn, end), rewritten to the newest 10 000 tasks once it passes 20 000 lines. A damaged line is skipped, and so is a line that parses but holds a field of the wrong type (the Audit's Low 2 on #305: the file is in `~/.dorothy`, which every agent can write): an id or agent that is not a string, a time that is not a number, turns that are not a count, a source or outcome Tars does not write, a session id that is not one (`[A-Za-z0-9_-]`, since it becomes a path), an ACP figure that is not a number. The text is cut to 200 characters when it is read as well as when it is written. A session id of another shape is not recorded. A task still open at the next launch was cut short by a quit, and ends `stopped` at the last moment the ledger heard of it.

Priced when asked, not when written: `readTaskCosts` reads each session's transcript (`<project or worktree, saved or real path>/<session>.jsonl`, through `transcriptRoots`) and its subagents' (`<session>/subagents/*.jsonl`), with the Usage page's own reader (`readUsageLines`) and prices (`pricingFor`, `costOf`). A reply belongs to the latest task of its session that had started when it was written; one written before them all (a resumed session copies its past in, with the old timestamps) belongs to none. The lines of one reply top each other up, as on the page. So over the same replies, the tasks add up to what the page bills (`task-cost.test.ts`, 16). A task none of whose sessions left a transcript (a CLI that writes none, a session never heard of) is not counted: `costUSD: null`, never 0.

Each turn's usage is in the ledger too (mods step 4, JeanBrasse's go of 2026-10-06): the state mod posts Claude Code's `turn.complete` usage (input, output, cache read and cache creation tokens, summed over the turn's requests, and its model) to `POST /api/hooks/turn-usage`, taken only from the agent's current session. It comes after the Stop that ended the turn's task (8 to 14 ms after, measured on 2.1.289), so the ledger files it under the agent's latest task in that session, ended or not (`turnUsage`, a `usage` line; `usageByModel` and `usageTurns` on the task). A task whose transcript is gone is priced from it (`from: 'turns'`), its cache writes at the 5-minute rate, as a transcript line without the split is. Where the transcript is there it stays the source (`from: 'transcript'`): Claude Code's per-turn usage does not say how the cache writes split between the 1-hour and the 5-minute cache, nor how many web searches a turn made (`turn.step` neither), and every cache write of the last 30 transcripts measured on JeanBrasse's machine was a 1-hour one, which costs more. So the figures do not move, and a task is no longer "not counted" because its transcript was cleaned up. A task priced from neither reads `from: null`.

The choice is made per session (the Audit's L1 on #333, since 1.9.4): each `usage` line names its session (`usageBySession` on the task), and a task over two sessions whose transcripts are only partly there is priced from the transcript of the one and the turns of the other (`from: 'mixed'`). A session that left neither marks the task `partial: true`, and its total `totalPartial`. With no transcript left at all, a session that recorded no turn makes the task partial too, when every turn named its session (`sessionedTurns`, the Audit's gate of #343). Turns recorded by 1.9.3 name no session: with no transcript at all they price the task as before, whole, since they cannot be told apart; beside a transcript they cannot be told from the other session's, and the session that lost its transcript reads missing, the task partial.

`usage:tasks({ since?, sinceDays?, projectPath?, agentId? })` answers `TaskReport` (`src/types/electron.d.ts`). `since` is an exact start in ms since the epoch, before `sinceDays` when both are given: a page whose window starts at a local midnight or at an hour asks for exactly that window, and the report's `averages` are then those of its tasks. The report holds the tasks started in the period, newest first, each with `costUSD`, `tokens`, `byModel`, `durationMs` (null while it runs), `totalCostUSD` (its own and every task handed on from it, down the line, loops cut) and `totalPartial` (a task under it is not counted); `averages.byAgent` and `averages.byModel` (`tasks`, `counted`, mean `costUSD` over the counted, mean `durationMs` over the ended; a task's model is the one its replies spent most on, or the one it was launched on when nothing was counted); `notCounted`; and the agents' names as they are now.

### The statusline

`electron/utils/statusline.ts` writes `~/.dorothy/statusline.sh` and points `statusLine` in `~/.claude/settings.json` at it. It renders context %, branch, session duration, lines changed and token throughput inside the Claude TUI, and caches quota data in `~/.dorothy/rate-limits.json`. Disabling it removes the script, the settings key and the cached quota so the Usage page stops showing a stale figure.

It also keeps `~/.dorothy/token-stats.json`, one entry per Claude session: `{ in, out, cost, model, extra, date, provider }`. `in`, `out` and `cost` are the session's running totals as Claude Code reports them, `date` is the local day of its last render, and `extra` says whether a quota stood above 100 % at that render. Anything in the file that is not one JSON object starts again from `{}`: until 2026-09-22 an empty file made jq print nothing, and that nothing was moved back over the file at every render, so it stayed empty for good.

For the Usage page the file is a label on part of the transcripts' spend, never more spend. Every session in it ran inside the claude binary, which writes a transcript, so its `cost` is already counted there, and adding `extraCost` to transcript or ledger cost counts it twice. It cannot be cut by day either: a session's whole running cost sits under its last day, and `extra` marks all of it once a quota passes 100 %.

### On the page

`src/app/usage/page.tsx` reads both sources per day, or per hour for 24 hours, and cuts them with one window, `usageWindow()` in `src/lib/usage-window.ts`: the current hour and the 23 before it (each source's `hourly` rows, the last 48 hours as #275 sends them, keyed by the hour's start floored since the epoch), the last 14 days, the last 12 Sunday-to-Saturday weeks, or the last 12 calendar months, the last bar being the hour, day, week or month that holds now. Every tile, provider row and bar is a sum over that window, so the total cost is the sum of the cost bars and of the provider rows, and the latest tile is today, this week or this month.

- **Cost**: `costByModel` from the transcripts, plus the ledger's `daily` (or `hourly`) rows of every provider but `claude`, which are Claude's ACP turns and already in its transcripts. Nothing from `token-stats.json`: its over-quota spend is printed under the total as a part of it (`of which ~$X over quota`), summed over the window's days, and not for 24 hours, which no day cuts.
- **Provider**: the one a model's sessions ran under, as the status line wrote it (`stats.providerByModel`), and the model's name only for a model no session speaks for (`providerOf`).
- **Tokens**: in is input, cache reads and cache writes, out is output, for the tiles, the provider rows, the tokens chart and its card.
- **Messages**: replies, which only the transcripts count.
- **Budget rows**: spend from the first of the month to today on the same definition of cost, whatever the timeframe; the Claude rate windows stay live. The panel says so. With two Claude accounts or more on, Claude's rows are each account's 5 h and weekly windows (`accountRateLimits`), in Settings' order, under `Claude · <name>`: a window null on an account that has reported says reset over an empty bar, and an account that has reported nothing yet has no rows. With the option off or a single account, they stay account 1's (`rateLimits`). Frame `Usage · limits per account`.
- **Where the records start**: the earliest transcript day or the ledger's `oldest`, whichever comes first. When the window starts before it, the header prints `records start <date>` beside the timeframe.
- **Tasks**: under the charts, `src/components/Usage/TaskCosts.tsx` over the same window, from `usage:tasks` (above). It asks a minute before the window's start, since the IPC counts back in 24-hour periods from main's clock, and cuts at that start (`src/lib/task-costs.ts`), and asks again when the window or the page's figures change. The tasks, newest first, twenty at a time: the text and who handed it over (`typed`, `from <agent>`, `from Tars`, a chat, `over ACP`), an error or a stop in its tone, the agent (`deleted agent` once its name is gone), the provider with the Claude account it ran on (`Claude · <name>`, from `accountRateLimits`), the model that did most of its work, start, end (`running` until it ends), time, turns, tokens (the cache included), its own cost and its total with the tasks handed on from it, `partial` when one is not counted. A task not counted reads `not counted`, never $0.00, and the panel says why. A project and an agent to pick, among the window's. Under it, the averages per agent and per model over the tasks listed, with the IPC's definitions (`averagesBy`, `dominantModel`). Frame `Usage · cost per task`.
- **By agent**: the switch at the head of the list, `By task (n)` and `By agent (n)`, shows the same tasks one row per agent (`src/lib/agent-costs.ts`, no other read than the tasks'): its project, the provider and Claude account of its latest task with any other under it, its tasks (`n running`), the time of those that ended, its tokens, and the sum of its tasks' own costs, never their totals, so work handed on counts once, in the agent that did it; `partial` when a task of it is not counted, `not counted` when none is. The dearest first, the uncounted last. The project picked applies, the agent picked steps aside and is kept for the task view, and the averages follow the tasks listed. The view last picked is kept in `localStorage` (`tars-usage-view`), by task the first time. A row adds up the agent's tasks begun in the timeframe, the task view's own rule (`inWindow`), each at its own cost from its first turn to its last, never its total with the work handed on. The charts above read every transcript under `~/.claude/projects`, by turn, so they also hold what no row does: a task begun earlier that still spends inside the timeframe, what came before the ledger (1.9.3), and Claude Code sessions Tars did not start, such as a claude run in a terminal of your own. Measured on 13/10 on four agents: since the ledger's first task, their tasks held every reply of their transcripts. The panel says it (the Audit's Low 1 on #408, and its words at #416's gate). Frame `Usage · cost per agent`.

A day of the legacy `stats-cache.json` shape, which the main process returns only when there is no transcript at all, carries no price and no cache, and adds nothing to these figures.

---

## §7 Persistence

Everything the app owns lives under `~/.dorothy` (`DATA_DIR`), except what its agents are not handed, which lives under `~/.tars-private` (`PRIVATE_DIR`, table below). `~/.claude-manager` is migrated in on first run and then deleted. Each start closes `~/.dorothy` to the other accounts on the machine (`narrowDataDir`): the directory and its subdirectories `0700`, each file in it down to its owner's bits, so the data files are `0600`. It was `0755` with its files at `0644` until 1.9.0.

| Path | Shape | Written by | Durability |
|---|---|---|---|
| `agents.json` | `{ version: 2, savedAt, agents: AgentStatus[] }` | `saveAgents()` | **Atomic**: temp file + `rename`. Backup taken only from content that just parsed successfully, so a corrupt file cannot overwrite the last good copy |
| `agents.backup.json` | same | `saveAgents()` | restored automatically when `agents.json` is unparseable or empty |
| `agents.json.corrupt` | verbatim copy | `loadAgents()` | kept for inspection instead of silently replaced |
| `app-settings.json` | `AppSettings` | `saveAppSettingsToFile()` | plain `writeFileSync`, non-atomic |
| `api-token` | 64 hex chars | `initApiToken()` | mode `0600`, regenerated if shorter than 32 chars |
| `hermes-connection.json` | `HermesConnection` without its token | `writeHermesConnection()` | non-atomic. The token is in `~/.tars-private/hermes-token` since 1.9.3; one found here is moved there at the first read |
| `projects.json` | `string[]` | `writeCustomProjects()` | also the allowlist for `local-file://` |
| `templates.json` / `templates.backup.json` | `{ user: AgentTemplate[], overrides }` | template handlers | backup pair. `template:import`, `template:create` and `template:update` refuse what the import review refuses: permissions Tars does not know, a folder that is not an absolute path, a skill that is not a skill name, an unknown provider or model, a prompt that is not text; an import is refused whole. Skill names are checked for every agent too (`utils/skill-name.ts`: `agent:create`, `agent:update`, `POST /api/agents`, and dropped from agents.json as it is read), since every task opens with them |
| `team-templates.json` | `{ user: TeamTemplate[] }` | team-template handlers | builtins are code, not data |
| `kanban-tasks.json` | `KanbanTask[]` | nothing; read at launch by `moveLocalKanbanToHermes` (`main.ts`) | the old local board, gone since 06/10: its open tasks move to the Hermes board once at launch, parked, and it stays as the backup |
| `kanban-moved-to-hermes.json` | `{ [localId]: hermesId }` | `services/kanban-board.ts` | which local tasks moved; atomic |
| `bus.json` | `{ version: 1, savedAt, memberOverrides, threads[], messages[], deliveries[] }` | `services/bus-store.ts` | **Atomic**: the shared `writeAtomicSync`. Rooms are not stored: they are a view over the fleet, and the global room reads the overseer's own conversation rather than copying it |
| `chats.json` | `{ version: 1, numbers: { [projectPath]: lastNumber }, chats: Chat[] }`: one record per chat of a project (§4, Chats) | `services/chats.ts`, through `handlers/chat-handlers.ts` | **Atomic** (`writeAtomicSync`), written only when something changed, whole and in one order, so the same chats are the same bytes. A file that is not the chats' is set aside as `chats.json.corrupt-<time>` and reported (`chat:list`'s `problem`), never reset; a record that does not hold is dropped, the file as it was set aside the same way; a newer Tars's file, or one that cannot be read, is left as it is and no chat changes until it can be. `numbers` only goes up. A field this version does not know is not kept: a later Tars that adds one writes version 2 |
| `vault.db` + `vault/` | SQLite (WAL, FK on) + `vault/attachments/` | better-sqlite3 | transactional |
| `usage-ledger.jsonl` | one `UsageEntry` per line | `recordUsage()` | append-only, self-trimming at 20 000 → 12 000 |
| `task-ledger.jsonl` | one line per task opened (`{ t: 'task', task }`, without its text), turn (`{ t: 'turn', id, at, sessionId }`) and end (`{ t: 'end', id, at, outcome }`) | `services/task-ledger.ts` | append-only; past 20 000 lines, rewritten atomically to one `task` line for each of the newest 10 000. Its texts are in `~/.tars-private/task-texts.jsonl` (below); a file with texts inline, written before they moved, is rewritten without them at the first start |
| `tmp/<short id>/t`, `tmp/<short id>/c` | each agent's temporary folder: `t` is the `TMPDIR` of its commands, `c` Claude Code's `CLAUDE_CODE_TMPDIR` (its scratchpad, its background tasks' output). The short id is ten hex characters of the sha256 of the agent's id, the same at every launch | `services/agent-tmp.ts`, set by `spawnAgentPty` for every terminal and by `delegateOverAcp` for every run; folders `0700`, a link found in their place removed, not followed | kept: a boot does not empty it as it empties `/private/tmp` and `/var/folders/.../T`. A retention pass a minute after launch and every hour deletes, whole, each entry of `t`, each Claude Code session folder of `c` and the folder of a deleted agent, once nothing in it changed for 7 days, or for a day when its agent's terminal or delegated run is alive (never the folder of the session that agent runs or would resume), then the oldest first past 20 GB in all (10 GB with under 30 GB free on the disk), nothing of a running agent there; never through a link, nothing when `tmp` itself is a link. A unit seen touched within the day is not walked again before its limit, its size weighed again every 6 hours. Each deletion is a line of `logs/agent-tmp.log` |
| `observations/<encoded>.jsonl` | one `Observation` per line | `/api/memory/remember` | append-only, 1000 → 500 |
| `model-catalog.json` + `.meta.json` | models.dev payload + `{ etag, fetchedAt }` | `writeCache()` | "a cache we cannot write is a slower app, not a broken one" |
| `acp-registry.json` | `{ fetchedAt, agents }` | `writeCache()` | same |
| `rate-limits.json` | quota snapshot of account 1 | `statusline.sh` | deleted when the statusline is disabled |
| `rate-limits.d/<account>.json` | `{ updatedAt, rate_limits }` per Claude account (`default` or `acct-<6 hex>`, from `TARS_CLAUDE_ACCOUNT`) | `statusline.sh` | temp file + `mv`; any other name writes nothing. Read by `services/claude-accounts/counters.ts`: names and numbers only, a counter older than 30 min counts as unknown when choosing. With the option on, each signed-in account is also read from Claude Code itself (`services/claude-accounts/usage-probe.ts`): `claude -p` over stream-json, with `--setting-sources ""` and `--strict-mcp-config` so that it runs none of the account's hooks and starts none of its MCP servers, answers a `get_usage` control request with the plan's 5 h, weekly and per-model weekly windows, 30 s after start, every 10 min and at each Settings refresh, one account at a time, with the account's own folder and without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (which empties the answer). Once it has answered, its input is closed and it exits by itself (0.7 s measured on a throwaway folder), removing the session file, key and `/tmp/cc-socks` socket it registers on start, which a SIGKILL left behind, 144 a day per account; one still there 3 s later is ended with its process group, as one that does not answer in 20 s is. Kept in memory; the newer of the probe and the file wins, and a probe with no reading never hides a file. Claude Code reads its own credential: Tars sends one control request and reads percentages back. `claude:getData` hands the Usage page one pair per account in use (`accountRateLimits`, Settings' order, a window past its reset as null), since only account 1 writes `rate-limits.json` |
| `token-stats.json` | `{ [sessionId]: { in, out, cost, model, extra, date, provider } }` | `statusline.sh` | temp file + `mv` under a `mkdir` lock that holds its owner's token and is released only by that owner; a lock over 5 s old is taken over by one render at a time, and only while it is still the one judged dead. Anything that is not one JSON object starts again from `{}` |
| `cli-paths.json` | per-binary overrides | CLI-paths handlers | |
| `skills-marketplace.json` | `{ skills, fetchedAt }`: the last skills.sh listing | `services/skills-marketplace.ts` | served at once to the Extensions page, fetched again behind it once an hour old; a failed fetch keeps it. Agents can write `~/.dorothy`, so every entry is checked on the way back as on the way in (`repo` is `owner/name` or `owner/name/skill`, no segment `.`, `..` or starting with `-`), and a file with no valid entry is fetched afresh |
| `cli-updates.log` (+ `.1`) | one line per CLI update result: time, CLI, outcome, versions, what it said | `services/cli-updater.ts` | append-only, moved to `.1` past 256 KB. A check that changes nothing is written once, a failure every time |
| `telegram-downloads/` | media from Telegram | Telegram bot | |
| `CLAUDE.md` | Tars's own agent instructions | `ensureTarsClaudeMd()` | mounted read-write into every agent via `--add-dir` |
| `statusline.sh` | generated bash | `enableStatusLine()` | mode `0755` |

Under `~/.tars-private`, which is in no agent's `--add-dir` and which Tars makes `0700`:

| Path | Shape | Written by | Durability |
|---|---|---|---|
| `overseer.json` | the super chat's conversation, job id and settings | `services/overseer.ts` | **Atomic**, mode `0600`. Moved out of `~/.dorothy` at startup |
| `hermes-webhook-secret` | 64 hex chars | `provisionWebhookSecret()` in `services/hermes-webhook-secret.ts` | **Atomic**, mode `0600`. The one credential published over the tailnet. Moved out of `~/.dorothy` at startup with its value unchanged |
| `overseer-hermes-sessions.json` | the ids of the Hermes sessions the super chat's turns ran in, the last 5000 | `rememberHermesSessions()` in `services/overseer-store.ts` | **Atomic**, mode `0600`. `memory_search` leaves these sessions out, so no agent is handed the super chat through Hermes |
| `hermes-token` | the Hermes dashboard's session token | `writeHermesConnection()` in `services/hermes-config.ts` | **Atomic**, mode `0600`. Moved out of `~/.dorothy/hermes-connection.json` at the first read |
| `relay-sent.json` | what the relay sent: message id, ref, kind, project, time, and the chat it came from or is about, 30 days | `services/hermes-relay.ts` | **Atomic**, mode `0600`. The list a reply is checked against, and the chat it goes back to |
| `telegram-sent.json` | `{ entries }`: what Tars's own Telegram bot sent for a chat, as Telegram's chat id and message id with the chat's id and the time, never the text; 7 days, the newest 2 000 | `services/chat-addressing.ts` (`createChatSentLog`), `services/chat-senders.ts` | mode `0600`. Read when a reply arrives: a reply to one of these goes to that chat |
| `relay-outbox.json` | sends Hermes has not taken yet, each until its time is up | `services/hermes-relay.ts` | **Atomic**, mode `0600` |
| `relay-state.json` | the last reply taken and the id of the plugin's store it was taken in, so none is handed over twice and a store made again, numbering from 1, is started over | `services/hermes-relay.ts` | **Atomic**, mode `0600` |
| `claude-accounts.json` | `ClaudeAccountsSettings`: the option (off by default), the Claude accounts in order, the 5 h and weekly thresholds | `electron/handlers/claude-accounts-handlers.ts` | **Atomic**, mode `0600`. Its own file, not a key of `app-settings.json`, whose save merges whatever a page sends. Holds ids and names, never a credential and never a folder: an account's folder is `~/.claude-accounts/<id>`, derived from its id. A file that does not parse reads as account 1 alone and is never written over: every change is refused, and Settings says why |
| `run-state.json` | `{ version, pid, startedAt, lastWriteAt, cleanExit, resumed, working[] }` | `services/run-state.ts` | **Atomic**, mode `0600`. Rewritten at each change of the fleet and every minute, closed at a quit (After an abrupt stop, below). Here, not in `~/.dorothy`, because it says which agents Tars starts at the next launch: an agent that could write it could have any agent started, in any project |
| `carry-over.json` | `{ version, savedAt, notes[], kanban[] }` | `services/carry-over.ts` | **Atomic**, mode `0600`. Written a moment after what is owed changes, read once at launch. Here because what it holds is typed into agents; a note read back is checked field by field, and a sender read back is never typed as one |
| `task-texts.jsonl` | one line per task of the task ledger: `{ id, text }`, its first line, 200 characters at most | `services/task-ledger.ts` | append-only, mode `0600`, rewritten with the ledger when it is. Here because it holds JeanBrasse's typed prompts and the chat messages handed to orchestrators (JeanBrasse's answer of 2026-10-05); what each task cost and how long it took stays in `~/.dorothy/task-ledger.jsonl`. A line that is not an id and a text is skipped, a text cut to 200 characters on reading |

Files Tars writes **outside** its own directory:

| Path | Why |
|---|---|
| `~/.claude.json` → `projects[path].hasTrustDialogAccepted` | `--dangerously-skip-permissions` skips *runtime* prompts; Claude Code's workspace-trust dialog is a separate gate keyed on this flag. Pre-writing it is the only way a bypass-mode agent never sees it. Never written for the root, the home directory or a directory above it, by the path given or the one it resolves to: Claude Code reads the flag for every directory above its own, so on `$HOME` it trusted everything the account owns. Claude Code asks there instead |
| `~/.claude.json` → `mcpServers.{gbrain,honcho}` | remote memory backends |
| `~/.claude/settings.json` → `hooks`, `statusLine` | eight hook types, merged rather than replaced |
| `~/.claude/mcp.json` | fallback when `claude mcp add` fails |
| `~/.local/share/claude/versions/`, `~/.local/bin/claude` | through `claude update`, which writes them itself |
| `<npm prefix>/lib/node_modules/<package>`, `<npm prefix>/bin/amp` | through `npm install --global`, for Amp |
| per-provider MCP config files | `codex`, `gemini`, `grok`, `opencode`, `pi` |
| `<project>/.worktrees/<branch>` | git worktrees. An agent's new worktree (`agent:create`, `agent:update`) gets its project's dependencies as a clone (`services/worktree-deps.ts`, JeanBrasse's choice 17 of 05/10): each package, the root and every folder one level down with a `package.json`, whose `node_modules` was installed for the worktree's `package-lock.json` (same versions and integrity) gets it with `cp -c` on macOS when both ends lie on one APFS volume (read from `mount`: onto another file system `cp -c` copies in full and exits 0, measured on HFS+; APFS shares the blocks: 1,185 MB in 23 s at load 130, no space measurably taken) or `cp --reflink=always` on Linux, or on Windows 11 24H2 and later a copy within one ReFS volume that is a drive of its own (a Dev Drive, its file system read with PowerShell's `DriveInfo`), where CopyFile, which `fs.cp` copies each file with, shares the file's blocks (`windowsClone`), and only where nothing is at the worktree's `node_modules`, a link included; anything else, another lock, a link, a file system that cannot clone, gets nothing and the agent installs as before, never a full copy. The window's Delete (`agent:remove`) first commits what the agent's worktree has not committed onto a new `wip/<name>` (`wip/<name>-2` and on when taken), through a throwaway index and `commit-tree` (`services/save-worktree-work.ts`): no hook runs, the agent's branch and files do not move. Then `git worktree remove --force`. A save that fails keeps the worktree, and so do files git ignores that are not rebuildable caches (a `.env`, an e2e run under `test-results/`; `node_modules`, `.next`, `electron/dist` and the like aside, the list `scripts/worktree.mjs` uses), which no commit keeps (the Audit's gate of #312), and so does a git repository the agent cloned or made inside it, which the save records only as a pointer to a commit in that repository's own `.git` (`nestedRepos`, QA's gate of #312), and so does a submodule checked out in it that holds commits on no remote-tracking branch (from any ref: a branch, a tag, a stash), changes not committed, or files git ignores that are not caches (a `.env`, which the worktree's own ignored-files check does not see inside a submodule), whose git store lives in the worktree's own (`.git/worktrees/<name>/modules/`) and goes with it (`submodulesWithWork`, the Info of #312's gate; one never checked out holds nothing): the answer says why (`worktreeKept`, naming up to five of them); one that saves names the branch (`savedTo`). JeanBrasse, 05/10. The API's DELETE does not remove a worktree. A folder there that no git worktree holds and no agent owns (git forgot it: its `.git` points to a gitdir that is gone; or it never had a `.git`) is listed in Settings · System with its project, size (`du`) and last change (`system:orphanFolders`, `services/orphan-folders.ts`, JeanBrasse's choice 16 of 05/10), walked into when it holds a live worktree at any depth, never through a link, and never removed on its own. What a folder is comes from its own `.git` (the Audit's gate of #334): a `.git` folder is a repository and a `.git` file whose gitdir exists a live worktree of some repository, neither ever listed, nor a folder with a `.git` anywhere below it (caches are not searched through, but a package checked out as a repository, `node_modules/<name>/.git` or `node_modules/@<scope>/<name>/.git`, counts; a folder below that cannot be read, or past 50,000 entries, keeps it); a project whose `git worktree list` fails offers nothing and is named in the listing's `unreadProjects`, git's own words going to the main process log only; every agent's `worktreePath`, `projectPath` and `secondaryProjectPath` is owned. `system:removeOrphanFolders(paths)`, which the window calls once it has confirmed, with the paths of the rows it showed, removes those and nothing else (a folder that became an orphan meanwhile was never shown, the Audit's gate of #336; an empty or malformed list removes nothing), reads the list again, keeps a path that is not an orphan now, checks each folder once more just before it goes, says why one could not be removed by the error's code and the path within the folder (`EACCES on locked/f`), never an absolute path, keeps a folder a process works in (`lsof -d cwd` read again before each, `/proc` on Linux, unknown when Tars's own process is not in it) and every one when the processes cannot be read, removes the rest one at a time with `fs.rm` (git is never asked, so never with `--force`), and tells each step (`system:orphanFolders:progress`); `system:disk` gives the home disk's free and total space and the 30 GB floor |
| `refs/heads/wip/<name>` | an agent's uncommitted work, kept when it was deleted |

### `AgentStatus`: what survives a restart

`persistable()` strips `ptyId`, `pathMissing` and `waking`, truncates `output` to the last 100 chunks, and demotes `running` to `idle`; `stopped` and `asleep` are kept, with who stopped it or since when it sleeps. `loadAgents()` additionally clears `waking`, `ptyCwd`, `currentSessionId`, `lastKilledSessionId` and `waitingReason`, marks `pathMissing` for vanished directories, and runs two migrations: `skipPermissions: boolean → permissionMode`, and, on a file below version 3, the role from the Orchestrator toggle or else from the name, once (see The orchestrator role, §4). Every load then leaves one orchestrator per project.

Live output is bounded at 600 chunks, spliced back to 400 (`OUTPUT_CHUNK_CAP` / `OUTPUT_RETAIN`): five PTY handlers pushed into `agent.output` and none of them capped it, so a chatty CLI grew that array for the life of the app, once per agent. What is spliced off is read for the terminal modes it left set (alternate screen, mouse protocol and encoding, bracketed paste, focus events, application cursor keys, hidden cursor), and those go back in as the first chunk (`electron/utils/terminal-modes.ts`). Claude Code in fullscreen sets most of them once, at start: without that chunk, a panel mounted after a long turn replayed onto the normal screen with no mouse request and no bracketed paste. The panels no longer replay these chunks: they are shown the terminal's mirror (§1), and the carry now serves a terminal with no mirror and the quick terminal's own buffer. What `output` feeds is text: the status line, log search, `get_agent_output`, the overseer and Telegram. So the 100 chunks written to disk are read back for those, and after a restart a panel shows the new terminal, not the old tail replayed onto it. Fields mutated on every PTY chunk (`output`, `statusLine`, `lastActivity`) set a dirty flag flushed every 30 s, bounding what a crash loses.

### After an abrupt stop

`agents.json` cannot say who was working: it saves `running` as `idle`. So each run keeps its own record, `run-state.json` (`services/run-state.ts`): opened at launch with `cleanExit: false`, rewritten a quarter of a second after each change of the fleet and once a minute, holding the agents that work (`running`, or `waiting` for anything but their next prompt: a permission, a question) with their session, their task's first 200 characters and when their turn began, and closed with `cleanExit: true` as the last step of a quit. A record still open at the next launch is a run that stopped abruptly: a crash, a kill, a power cut, a reboot that did not quit Tars. One that cannot be read, or none, is not. Nor is the record of a Tars that still runs (2.0.3, the Audit's M1 on #418): macOS and Linux hold no single-instance lock, so a second Tars can start on the same home (`open -n`, another copy, a second launch on Linux). The record keeps when its process started, as the OS says it (`platform/process-start.ts`: field 22 of `/proc/<pid>/stat` on Linux, `/bin/ps -o lstart=` on macOS). An open record's run is still going only if the process under its pid is the one that wrote it: alive (`platform/process-exists.ts`, signal 0), started when the record says (a crashed Tars's pid can be taken by any long-lived process of the user, which would otherwise stop the resume until it ends), the machine not rebooted since its last write (`os.uptime()`), and the pid not this process's own. A record with no pid or no start (written before 2.0.3) is a run that ended; a live pid whose start cannot be read is taken for another Tars, and logged. Windows keeps its single-instance lock: a second Tars ends there before it reads the record, so a live pid in it is always a reused one. Otherwise the second Tars reads no previous run, so it reports no abrupt end and resumes nobody, and it writes no record of its own: the first's stays whole, its clean quit or its crash read right at the next launch.

Then (`services/crash-resume.ts`, wired by `services/restart-recovery.ts` once the launcher and the API are up), each agent the record names is started again on its own conversation with a note from Tars as its first prompt, three at a time, each holding its slot until its session is up (20 together took 3.7 to 6.8 s each, RD-RAM). Its last request is never sent again. The note, one line in Tars's words: when Tars stopped, what the transcript says was cut (a tool call with no result, named: Claude Code records its outcome as unknown by itself; a prompt or a tool result with no reply; a reply written last), that its background tasks stopped with Tars, where its temporary folder is, and to check where things stand before redoing anything. An orchestrator's note also names the agents still holding work it handed them, each resumed too or at rest, and asks it to check with `get_agent` before handing anything again. An agent already running again (the Dashboard's start on launch got there first) is given the note in its session instead of a second launch. One deleted since, stopped since, or whose folder is gone is left alone, and said in the log (`[resume] ...`). A resumed agent's delegation link is bound to its new terminal, so its end reaches whoever handed it the work. Agents at rest when Tars stopped are not started: they sleep until something needs them. A run that resumed agents and stopped again within two minutes is not resumed again, so a resume that crashes Tars does not loop.

What Tars owes its agents goes across any restart, abrupt or not (`services/carry-over.ts`): the note that an agent finished, held for its requester while that one works (agent-watch), and the kanban notes held for an agent's rest are written to `carry-over.json` (in `~/.tars-private`, out of every agent's reach, like `run-state.json`) a moment after each change, and at the next launch each goes, once, into the queue of its recipient's first session that registers in that run, then at its first rest, said to be "owed since HH:MM, before Tars restarted". A carried kanban note is typed as from Tars, whoever first sent it: its first sender is named inside it, quoted, never typed as its sender line, since a file is not a verified sender. The names in a resume note (the agents handed work, the tool that was cut) are quoted the same way. News about work its agent was handed again since is not given. Room messages need no file: the journal kept their rows `queued` (or `held` behind a draft that died with its terminal), and `bus-delivery.ts` queues them again for the target's first registered session, where they turn `delivered` as any other. `not_sent`, `delivered` and `dropped` rows are left as they are.

---

## §8 Bundled MCP servers

Seven servers ship in `extraResources` as `<name>/dist/bundle.js` and are registered with every provider on boot by `setupMcpOrchestrator()`:

| Directory | Registered as | Provides |
|---|---|---|
| `mcp-orchestrator` | `claude-mgr-orchestrator` | agent lifecycle + delegation + messaging |
| `mcp-memory` | `tars-memory` | the four memory tools of §5 |
| `mcp-telegram` | `claude-mgr-telegram` | Telegram send (text/photo/video/document) |
| `mcp-kanban` | `claude-mgr-kanban` | the Hermes board, through Tars (`/api/kanban/*`, the agent's own token): an agent's task arrives parked, one agent claims it at a time |
| `mcp-vault` | `claude-mgr-vault` | documents, folders, search, attachments |
| `mcp-socialdata` | `dorothy-socialdata` | X/Twitter read |
| `mcp-x` | `dorothy-x` | X/Twitter post |

What the seven share is in `mcp-shared/`, which is not a server: the client to Tars's API (where it is, the token presented, the caller's identity), the tool table every server but `mcp-memory` registers its tools through, whose one guard words each tool's failures ("Error <what>: <message>"), one HTTP request read whole, the wait after which a silent host is said to have given "no answer within N s" (30 s for Tars, 60 s for SocialData, X and a Telegram message, 60 s for mcp-kanban's calls through Tars to Hermes; a file sent to Telegram is timed by its size instead, the time it takes at 10 KB/s plus that minute, since once its bytes sit in the kernel's send buffer silence is all a server sees while a slow link carries them), and the settings file as it is at the call. Each server's esbuild bundles it in. It imports node's builtins and nothing else, so each server keeps the SDK and zod its own lock pins (SDK 1.25 to 1.30 today). `__tests__/mcp/contracts/` records what the seven answer over stdio, `tools/list` and every tool along each of its answers, against a fake Tars.

Plus `tasmania` when `tasmaniaEnabled` and the configured path exists. `DOROTHY_MANAGED_MCPS` holds eight names: the six above plus `tasmania` and `google-workspace`; they are hidden from the Custom MCP settings UI. `tars-memory` is not in the set.

Registration is idempotent: `isMcpServerRegistered(name, expectedServerPath)` compares the last argv element. The Claude implementation checks both `~/.claude.json` (where `claude mcp add -s user` actually writes) and `~/.claude/mcp.json`; checking only the latter meant the answer was always `false` and every server was re-registered by spawning the CLI, once per claude-family provider, on every boot. The registration loop yields with `setImmediate` between servers: it runs on the main thread, the one that paints the window and pumps every PTY.

The program a server is registered with is not `node` but `~/.dorothy/bin/tars-mcp-node` (`mcpNodeCommand`, `electron/utils/mcp-node.ts`), a launcher Tars writes at each start, 0700, that runs the app's own binary with `ELECTRON_RUN_AS_NODE=1`: the servers run on the Node inside the app, whatever the machine has. Registered as `node`, the CLI looked it up on its PATH, and an agent's `/bin/bash -l` on macOS puts /etc/paths ahead of Tars's PATH (path_helper): measured on 2026-09-24, the live Tars's servers ran `/usr/local/bin/node`, Node 18.16, end of life, and a machine with no Node got no Tars tools. Only a packaged Tars at a lasting place writes the launcher, rewriting it when the app has moved: a dev run, a copy run from a disk image (`/Volumes/`) or translocated by macOS names the launcher already there and leaves it alone, or names `node` when there is none (a dev run on the real HOME had pointed every claude session's servers at a worktree's Electron, the Audit's gate of #201). On Linux it names the AppImage file (`$APPIMAGE`), not its mount point. The script falls back to the `node` on the PATH when the app it names is gone, and a symlinked `~/.dorothy/bin` or launcher is not written through. Since the registration check compares the server's path only, `~/.dorothy/mcp-servers-runtime.json` records the program and, per provider, which ones have every server on it; a packaged start removes and registers again the servers of any provider not recorded, so a provider that fails (a config file it cannot write) is tried again at the next start and the others are not. A move-over removes the entry and adds Tars's own again: whatever was added to a Tars server's entry by hand, an `env` say, is not kept. A start from a disk image or a translocated copy (`isTransientAppPath` of `process.resourcesPath`) registers no server at all, and the Settings button's `orchestrator:setup` refuses from it: each registration would name a path inside that copy, in every CLI's config, gone at unmount (measured on a mounted image: 7 entries each in `~/.claude.json`, `~/.claude/mcp.json` and the amp, codex, gemini, grok, opencode and pi configs). The registrations of the installed Tars and its record are left as they are. The delegated ACP runs get the same launcher, and their servers from the copy that runs them, since those end with the run. Windows keeps `node`. This relies on Electron's RunAsNode fuse, on by default and left on.

---

## §9 The Hermes gateway

Tars deliberately has no scheduler and no server-side task harness. Both live in the user's Hermes instance, and Tars is a client.

`electron/types/hermes.ts` models four connection modes:

| Mode | Base URL |
|---|---|
| `local` | `http://127.0.0.1:<localPort ?? 9119>` |
| `ssh` | `http://127.0.0.1:<ssh.localPort ?? ssh.remotePort ?? 9119>` (tunnel) |
| `remote` / `cloud` | the configured absolute URL |

Only a connection saved in `~/.dorothy/hermes-connection.json` (its token in `~/.tars-private/hermes-token`, JeanBrasse's decision 6 of 2026-10-01), readable and naming the address its mode needs, is called (`configuredHermesConnection`, `usableHermesConnection`); a missing or broken file is "not configured", never the default port, and `hermes:connection:get` then gives the pages no base URL to probe.

Two auth flavours, advertised on the public `GET /api/status`: a static `X-Hermes-Session-Token` header, or a real cookie sign-in via `POST /auth/password-login`. The header goes out only while the connection's auth is `token` (`sessionToken` in `electron/types/hermes.ts`): under `oauth` a token kept from token mode is not sent, as in Hermes Desktop. The cookie jar is a `Map` in the main process and never reaches the renderer; an empty `Set-Cookie` value deletes the entry rather than storing a blank.

Consumed surfaces: `/api/memory` (files, state, session search, source `hermes` in §5), `/api/plugins/kanban` (the board behind `/kanban`), and the cron endpoints behind `/crons`.

### Inbound webhook

`POST /api/webhooks/hermes` lets a Hermes cron job or automation blueprint drive a Tars agent.

- Auth: `~/.tars-private/hermes-webhook-secret`, and nothing else. This route is the one thing published over the tailnet, so it carries its own secret. Since 1.7.6 the door knows that secret, on this pathname and no other, and the route opens to it alone: not the shared token, which it used to accept as a fallback, not an agent's own token, not Tars's pass, and nobody at all while no secret is configured. Before 1.7.6 the secret itself was refused with a flat 401 at the door, and with no secret file the route skipped its own check, so whatever the door let in, an agent's token included, dispatched to any agent of any project.
- Body: `agent_id` **or** `agent_name` (case-insensitive exact match, narrowed by `project_path`; ambiguity → 409 listing the matches), `message`, optional `model` / `permission_mode` / `dry_run`.
- `dry_run: true` proves auth and agent resolution without dispatching.
- Otherwise it calls the same `performDispatch()` as `/api/agents/:id/dispatch`, so semantics are identical.
- Reachability from a VPS is the operator's job: `tailscale serve 31415` or an equivalent tunnel, since the API binds to `127.0.0.1`.

---

## §10 Surfaces

14 route files under `src/app/`. Cross-referenced with `design/UI-INVENTORY.md` (note that inventory's header says "Pages (13)" while its table lists 14 rows).

| Route | Name | What it is | Frame |
|---|---|---|---|
| `/` | Dashboard | The terminal grid. Every running agent as a live xterm pane, project tab bar, layout presets, add-agent dropdown. A pane in error shows the reason in its header | `Dashboard · dark` / `· light`, `Agent error · reason` |
| `/agents` | Agents | Roster grouped by project, in the order of the Dashboard's tabs: each project's name, path and agent count over its cards. A project picker narrows the page to one project, the status chips (All, Running, Waiting, Idle, Stopped, Error) count within it, with a completed agent counted as idle as its card says, and a filter field matches name, branch, project and task. None of the three filters outlives the visit. Management card per agent. A card in error shows the reason in place of the task | `Agents · dark`, `Agents · one project`, `Agents · project picker open`, `Agent error · reason` |
| `/projects` | Projects | Project registry (backed by `~/.dorothy/projects.json`), file browser, per-project agent view. 1153 lines | `Projects · dark` |
| `/kanban` | Kanban | The Hermes board, in Hermes's own eight columns. The agents' tasks sit there too: parked in `scheduled` on the Tars lane, claimed in `ready` on their agent's lane (OPERATIONS.md, "The agents' kanban") | `Kanban · dark` |
| `/crons` | Schedules | Hermes cron jobs: list, pause, resume, trigger, delete. Tars owns none of this | `Schedules · dark` |
| `/review` | Review | What the agents actually changed. Per-worktree column, with the projects added in Tars that no agent works in, changed-file list with add/delete counts read without the patches (`review:diff` with `listOnly`), a file's own patch once it is picked (`review:file`), cut at 4000 lines with a note, a file's read error said; with no file picked the panel asks for one. Refresh rereads the list. Replaced a 20-line `git diff --stat` | `Review · dark`, `Review · light`, `Review · states` |
| `/logs` | Logs | One search box for the whole fleet, over each agent's output as its terminal shows it (the live mirror, else its kept output replayed headless), a Claude agent's transcript first, since a full-screen session keeps no history. Plain substring, or `/regex/` when delimited | `Logs · dark` |
| `/usage` | Usage | Cost and tokens over one timeframe chosen in the header (24 hours, 14 days, 12 weeks, 12 months): four tiles, the provider rows, and cost, token and message charts on the same bars, then each task's own and total cost, or by agent each agent's, with the averages per agent and per model. Budget rows stay month to date and rate windows live. See §6, On the page | `Usage · dark` (14 days) / `· light` (12 months) / `· daily messages` / `· last 24 hours` / `· cost per task` / `· cost per agent` |
| `/memory` | Brain | The six sources of §5, in three tabs: Projects (native `~/.claude/projects/*/memory/` files, editable), Agents, Backends (probed status) | `Brain · Projects` / `· Agents` / `· Backends` |
| `/vault` | Vault | Agent reports and working documents in SQLite. Long-term memory lives in Brain, not here | `Vault · dark` |
| `/skills` | Extensions | Two tabs: Skills and Plugins, with marketplace fetch and an install terminal | `Extensions · Skills` / `· Plugins` |
| `/settings` | Settings | 6 groups, 18 sections (see below) | 18 frames |
| `/whats-new` | What's new | `src/data/changelog.ts`; marks itself seen in `localStorage` and fires a `whats-new-seen` event the sidebar listens for | `What's new · dark` |
| `/tray-panel` | Tray panel | Rendered inside the menu-bar popover window, fed by the `agents:tick` broadcast. Overrides xterm's viewport scrollbar so it overlays instead of stealing columns | `Tray panel` |

Settings groups: **General** (Preferences, Terminal, Notifications, System) · **AI & Providers** (Providers, Claude accounts, CLI Paths, Permissions) · **Hermes** (Connection) · **Integrations** (Telegram, Slack, Discord, X, Google Workspace) · **Extensions** (Skills & Plugins, Custom MCP, Tasmania) · **Workspace** (Git, Memory Backends).

15 overlays are inventoried separately: New agent (4 steps), Deploy team, the four template dialogs, three kanban dialogs, Start prompt, Agent terminal, Plugin install, Install terminal, and the Claude account dialogs (add and sign in, remove).

Every data surface must show five states: loading (nothing under 400 ms, then the mark filling over a line naming what loads, then a named slow operation), empty, error, needs-sign-in, permission-denied.

### The tick

`scheduleTick()` coalesces to one `agents:tick` broadcast per 500 ms carrying the whole roster: id, name, character, raw status, `displayStatus`, status line, current task, project name, last activity, provider, whether a CLI runs in the terminal (`cliRunning`), whether that CLI left fullscreen without telling its terminal (`leftFullscreen`, §1), when the status began (`statusSince`), what a waiting agent waits on (`waitingOn`) and whether a launch is on its way (`launching`). `statusSince` is stamped by the fleet's map itself, which turns each agent's `status` into an accessor: a different status stamps the time, the same one does not, and none of the forty lines that write a status has to remember; `lastActivity` could not serve, every repaint moves it. `waitingOn` is `{ kind: 'permission' | 'question', text }` from the PermissionRequest hook, which now sends the tool and its input: the command, the file or the tool for a permission, the first question for AskUserQuestion, on one line with controls and direction overrides removed, 200 characters at most; it goes as soon as the status changes, and the idle prompt has none. `launching` is `sessionStarting` (§5): a tick goes out when a launch begins or is abandoned, and the window is looked at every second while one is open, for a launch that came up or timed out by itself. An agent asleep carries `asleepSince`, and one waking `waking` (who woke it, how and when; An agent asleep, §4). `displayStatus` derives `working | waiting | done | error | asleep` from status, `waking` while a wake's launch is on its way, and splits `idle` into `ready` (a PTY exists) or `stopped`. The tray badge lights when any agent is `waiting`.

Every path that changes an agent announces it on both channels, the interface's IPC handlers, the hooks and the API's agent routes alike: `agent:status` for the transition, and a tick. They are not interchangeable. The Chat page's rail reloads the fleet on `agent:status`; the Agents page and the Dashboard redraw from the tick. The API routes announced nothing until 1.7.5, so an agent the super chat started, gave a task or stopped did not change on an open page until it was reloaded.

---

## §11 Security model

### Electron hardening

`electron/core/window-manager.ts`:

```ts
webPreferences: { preload, contextIsolation: true, nodeIntegration: false, webviewTag: false }
```

`hardenWindow()` applies three guards. The renderer holds the whole `electronAPI` bridge; a link in a vault note, a redirect from injected content or a `window.open` would otherwise land remote content in a renderer that can spawn PTYs and read the filesystem:

- `will-navigate`: anything not `app://`, `http://localhost:` or `http://127.0.0.1:` is prevented and handed to `shell.openExternal`.
- `setWindowOpenHandler`: always `{ action: 'deny' }`; `http(s)` URLs go to the system browser.
- `will-attach-webview`: prevented.

`certificate-error` is only overridden for `https://localhost`.

### The `local-file://` protocol

Registered as standard + secure + fetch-capable. Confined by `isUnderAllowedRoot()` to `~/.dorothy`, `~/.claude`, and the project roots read fresh from `~/.dorothy/projects.json` on every request (so a newly added project works at once). Containment is judged where the file really lies, links followed (`landsUnderSafeRoot`, `electron/utils/real-target.ts`), under a root that neither is nor covers the home: a project added as `~`, or a link under `~/.dorothy` or in a project, no longer opens the rest of the home. Unrestricted, this protocol served `~/.ssh/id_rsa` and `~/.aws/credentials` to anything that could put a URL in the renderer.

### The IPC boundary

`electron/preload.ts` (898 lines) exposes exactly one object, `window.electronAPI`, over `contextBridge`. It is a hand-written façade: no `ipcRenderer` passthrough, no dynamic channel names. 223 `ipcMain.handle` channels sit behind it, grouped `pty:`, `agent:`, `app:`, `settings:`, `fs:`, `project:`, `shell:`, `template:`, `teamTemplate:`, `vault:`, `memory:`, `obsidian:`, `models:`, `usage:`, `review:`, `logs:`, `mcp:`, `skill:`, `plugin:`, `hermes:`, `gws:`, `tasmania:`, `telegram:`, `slack:`, `discord:`, `jira:`, `xapi:`, `socialdata:`, `orchestrator:`, `dialog:`, `cliPaths:`, `tray:`, `bus:`, `overseer:`, `claude:`, `claude-accounts:`, `ollama:`, `provider:`, `system:`, `chat:`. Every event subscription returns its own unsubscribe closure.

### What is validated where

| Value | Where | Rule |
|---|---|---|
| Model name | `agent:create` IPC **and** `POST /api/agents` **and** each provider's `buildInteractiveCommand` | `/^[a-zA-Z0-9._\-\/:@]+$/` (IPC) and `/^[a-zA-Z0-9._:\/\[\]-]+$/` (provider, allowing `[1m]`); throws otherwise |
| Effort | `agent:create` IPC and `POST /api/agents` and `safeEffort()` | allowlist of five values, checked again at the point of use |
| Provider id | `POST /api/agents` | `isValidProvider()` |
| Branch name | `resolveWorktreePath()` | `/^[A-Za-z0-9][A-Za-z0-9._/-]*$/`, no `..`, no `//`, no trailing `/` `.` `.lock`, no `@{`, ≤200 chars, **plus** a resolved-path containment check against `<project>/.worktrees`. The old regex admitted `.` and `/` and therefore `../../..`; `path.join` resolved outside the project, the "worktree already exists, reusing it" branch never invoked git, and the agent was spawned with its cwd there. `../../../etc` was enough |
| Memory file name | `writeProjectMemory()` | `/^[A-Za-z0-9._-]+\.md$/` |
| Memory sources | `parseSources()` | allowlist of the five ids |
| Vault attachment path | `GET /api/local-file` | must resolve under `<VAULT_DIR>/attachments`, where the file really lies, links followed, and as the file's only name (`nlink` 1) |
| Transcript model id | `computeTranscriptUsage()` | null-prototype map; `__proto__` / `constructor` / `prototype` rejected |
| Request body | `api-server.ts` | 4 MB cap enforced *while streaming* (it reads before routing, and on auth-exempt hook paths, so an unbounded stream was a way to exhaust main-process memory with no credential at all); `__proto__` and `constructor` deleted from the parsed object |
| Git arguments | `git-review.ts` | `execFile` with an argv array: no shell, so a branch or path containing a quote or a semicolon is data, not syntax |
| A file the Review page opens | `git-review.ts` (`fileDiff`) | A path relative to the repository and inside it, once links are resolved: `../..`, an absolute path or a linked folder that points out is refused before git or the disk is asked, and a link is shown as its target path, never what it points to |

### The local API

| Control | Value |
|---|---|
| Bind | `127.0.0.1:31415` (`DOROTHY_API_PORT` overrides, for a sandboxed E2E instance) |
| Auth | `Authorization: Bearer <~/.dorothy/api-token>`, 32 random bytes, file mode `0600`, or an agent's own token, minted in memory for each terminal spawn and each delegated run, or Tars's own pass, minted in memory and written nowhere, which the super chat presents on the loopback, or on `/api/webhooks/hermes` alone the webhook secret. The agent's token decides who is calling; with it, an `X-Tars-Caller-Id` naming another agent is a 403. The shared token names no agent, no header is read with it, and it drives no agent, the webhook included |
| Auth-exempt | `/api/health` and `/api/local-file` |
| Hook routes | `/api/hooks/*` take the token of the CLI they run in (`CLAUDE_MGR_API_TOKEN`), for the `agent_id` they name: anything else is a 403, and a token whose terminal was replaced is a 401. Exempt until 2026-09-23: a post with no credential registered any session for any agent (the Audit resumed one agent's conversation in another through it), and a killed CLI's late SessionStart took its agent from the live session |
| Origin guard | any request with an `Origin` other than `app://-` or `http://localhost:3000` is 403'd **before** auth. A browser tab on any site can reach `127.0.0.1`; CORS hides the response but not the side effect |
| Body | 4 MB, prototype-pollution keys stripped |
| Route matching | first match wins; regex routes map their first capture group to `params.id` |

53 routes are registered across eleven modules: bus (2), health (1), hooks (5), agents (13), telegram (4), slack (1), discord (1), kanban (9), vault (10 + `local-file`), memory (5), webhooks (1).

### The relay to the user's Telegram, through their Hermes: `services/hermes-relay.ts`

Off unless `hermesRelayEnabled` is on (Settings, Hermes; read live). On, Hermes is the only voice on the user's Telegram (JeanBrasse's decisions of 2026-10-01, DESIGN-RELAIS-HERMES-V2.md):

- Tars sends through the tars-relay plugin installed on the user's Hermes server (`/api/plugins/tars-relay/send`, on the dashboard Tars already reaches, with its session token), as plain text, to the one user the plugin's settings name there. Each message id is kept in Tars's own list (`relay-sent.json`, `~/.tars-private`): a reply counts only when it answers a message on that list, whatever the plugin hands back with it.
- Hermes down, a send waits in `relay-outbox.json` and its caller is told it has not gone; it goes when Hermes takes it, until its time is up. Nothing falls back to anything else.
- Every 5 s while on: the plugin's status, the projects, what waits, then the user's replies, each handed once and acked, a lost ack caught at the next round (`relay-state.json`, with the id of the plugin's store: a store made again, which numbers its replies from 1, is started over rather than skipped). The plugin keeps `@name` for Tars only for the projects Tars registered with it (`/api/plugins/tars-relay/projects`): the fleet's names as the user writes them (a dash for each space, @, colon or comma), told again whenever they are not the ones the plugin lists. Any other `@word` is Hermes's.
- Routing (`services/hermes-relay-routing.ts`): a reply to a question goes to the agent that asked; to a report or to a project orchestrator's message, to that project's orchestrator; `@project text` to that project's orchestrator (an unknown or shared name, or a project with no orchestrator, gets the user the list or a word); to a Sentry request, to the handler its PR registers; to a word from Tars, nowhere. Each goes after `Message from the user via Telegram: `, with the user's words only, never a worker. A reply to a message Tars did not send reaches nobody, and the user is told. Each message handed on gets the user one short receipt through the relay, a line and never a reaction (JeanBrasse's answer 24 of 2026-10-05; `receiptFor` in `hermes-relay.ts`): `Passed to <agent>.`; when it waits in the terminal for a person, `Passed to <agent>: it waits for what is typed in its terminal to be sent or cleared.`, or for a dialog, `...: it waits for the permission or question its CLI shows to be answered.` (waiting a moment behind Tars's own previous write is not waiting, and is a plain pass); an orchestrator that was not running, `Passed to <agent>, which was not running: it was started with your message.`; a terminal that refuses it, `Not delivered: <agent>'s terminal is not taking messages.` An answer to an `ask_user` question gets the same receipt.
- Turning it on erases the Tars bot's token and keeps the bot off, and takes mcp-telegram out of every CLI (never registered again while on, `services/hermes-relay-switch.ts`). `send_telegram` then goes through the relay, for a project's orchestrator only, under its project, its text masked; the file sends answer `410`.
- Its state for Settings, Hermes: `hermes:relay:status` (invoke, and pushed on change): `off`, `ready`, `unreachable`, `not-configured` (the plugin has no user id on the server), `plugin-missing`, `unauthorized` (the token refused), `no-connection`, and how many sends wait.
- The switch is the Telegram through Hermes row of Settings, Hermes, Connection (`src/components/Settings/HermesRelayRow.tsx`): a click turns nothing on, it shows the warning with turn on and cancel, and only turn on saves `hermesRelayEnabled`; off saves at once. On, the row says the state as a word in its tone, with what to do and what waits (`src/lib/hermes-relay.ts`), and the page clears its own copy of the bot's token and switch as main did. While it is on, Settings, Telegram offers nothing to type or switch, since main refuses a token or the bot on as it saves: it says the bot is off, replaced by Telegram through Hermes, its one button opens Settings, Hermes, and the header has no action (`src/components/Settings/TelegramSection.tsx`). Frames `Settings · Connection`, `Settings · Connection · Telegram through Hermes` and `Settings · Telegram · Telegram through Hermes`.

### Event reports: `services/event-reports.ts`, `services/github-watch.ts`

To the user's Telegram, through the relay while it is on: an agent gone to error (from `handleStatusChangeNotification`, after the 5 s it waits to be sure of a status, including an agent's first change after Tars starts), a PR merged and changes requested on an open PR in the GitHub repositories of the agents' projects (`gh pr list --json`, read-only, every 5 minutes while the reports go out, `gh` and `git` found through `buildFullPath` since an app opened from the Dock has a bare PATH; a repository's first poll, or one after an hour without polling, is a baseline and reports nothing; a PR event goes under the project its repository was found in). Grouped over 2 minutes into one plain text message per project, so that a reply reaches that project's orchestrator, each name, title and error text kept to its own line and its secrets masked (masked before an error text is cut to 300 characters); 40 messages a (local) day, counted across restarts, the events past that counted and said in the next day's first message; each event once (an agent is reported again only after leaving error). With the relay off, nothing is sent or kept.

### Error reports: `services/error-reports/`

Off by default (`errorReportsEnabled` in `app-settings.json`, written by Settings through `app:saveSettings`). Off, `@sentry/electron` is not even loaded. Turned on, at start or while Tars runs (`main.ts` calls `errorReports.sync()` whenever the settings are replaced), it is loaded and started once for the run, with none of its default integrations: only uncaught exceptions, unhandled rejections and the causes linked to an error. No native crash dumps, screenshots, breadcrumbs, sessions, tracing, OpenTelemetry, logs, replay or offline queue. Turned off again, nothing leaves from that moment: the setting is read at each event (`beforeSend`) and again as each envelope is about to leave (the transport), and a report already on its way is dropped.

What a report carries is built field by field (`report.ts`), never scrubbed from the SDK's event: `event_id`, `timestamp`, `platform`, `level`, `release` (`tars@<version>`); up to 5 exceptions (the error and its causes), each with its `type`, its message (home folder as `~` wherever the name ends, in any case, behind `/private` and URL-encoded once or twice, the machine's name (`os.hostname()`, and its first label when it has 6 characters or more) as `<host>`, the user name alone as `<user>`, a macOS temp folder as `<tmp>`, secrets masked by `redactSecrets`, quoted text with a space and more than 24 characters replaced by its length, 1000 characters at most), its mechanism `{ type, handled }` and the 50 frames nearest the throw (`filename` with the same paths rewritten, `function`, `lineno`, `colno`, `in_app`); `tags.process` (`main` or `renderer`); `contexts.os` `{ name, version }`; `contexts.runtime` `{ name: Electron, version }`; `user.id`, a random id made on this machine. The transport sends error events only, rebuilt the same way, and drops every other item (sessions, attachments, replays, feedback, spans, logs, client reports): @sentry/electron hands some of a renderer's envelopes to it past `beforeSend`. The request carries the public DSN key in its URL, `User-Agent: sentry.javascript.electron/<v>` and `Accept-Language: en`; like any request, it reaches Sentry from the machine's IP address.

At most one report of the same error in 24 hours, and 20 in any 24 hours, per installation, across restarts (`~/.dorothy/error-reports.json`, `0600`, which holds the install id). The renderer's errors reach main through the preload's `__SENTRY_IPC__` bridge (the window is sandboxed and cannot load the SDK's own preload): only its start and its envelopes pass; its scope, feedback, logs, metrics and status go nowhere. Main takes the SDK's listeners on those channels behind a guard: an envelope that is not text or bytes, or is over 1,000,000 characters, never reaches the SDK, and what throws in its listener (a malformed envelope does, in the SDK's parser) is logged by name and dropped instead of becoming an uncaught exception in main. A development run may point reports at a stand-in with `DOROTHY_ERROR_REPORTS_DSN`; a packaged Tars ignores it.

**Tars's health (2.0.3, `services/health/`).** Every 5 minutes, on every platform and whatever the switch, the main process appends a sample to `~/.dorothy/health-samples.jsonl` (`0600`; on Windows, where Node ignores the mode, named at startup with the other owner-only files and written through `writeSecretFileSync`, so each write is born closed to every account but the user's and SYSTEM): its time, heap used and total and RSS (MB), the event loop's delay over the window (p50, p95, `perf_hooks.monitorEventLoopDelay`), the three slowest IPC handlers of the window (channel and ms, timed where each is registered: `timeIpcHandlers` wraps `ipcMain.handle` before any handler exists), the agents and how many run, and the window's page as a bare path (`/usage`). Each new sample rewrites the file with the last 24 hours only, 256 KB at most, oldest first out; every line is rebuilt field by field when read back (`cleanSample`), so a line an agent wrote carries nothing else. What leaves is read once more against what this Tars knows (`onlyKnown`): a channel only if this process registered it (`timeIpcHandlers` keeps the list), a page only if it is one of the app's (`health/pages.ts`, checked against `src/app` by a test), so a line an agent wrote can put no word of its own in a report. They leave in two cases only, both through this module, its switch and its budget, never on Windows:
- **An abrupt end.** The run record (`run-state.json`, which also drives the resume after a crash) now holds the app's version. At a launch whose previous run did not quit, one report of kind `abrupt-end` leaves: that version, how long it ran (to the later of the record's last write and its last sample), the crash type the OS gave without memory (macOS: the exception type of the newest `Tars-*.ips` of Tars's bundle in `~/Library/Logs/DiagnosticReports` since that run started, `platform/crash-type.ts`; none on Linux and Windows), and its last sample. Its message is fixed, so the budget lets one through a day.
- **A diagnostic** (`diagnostic:send`, "Send a diagnostic" in Settings): the last 24 hours of samples, once a day. Its answer says how many samples left and their first and last time, or why nothing did: Windows, the switch off, nothing recorded yet, already sent today, or Sentry not reached (no 2xx within 10 s), which gives the budget back.
Both are error events with an exception of their own type (`TarsEndedAbruptly`, `TarsDiagnostic`, mechanism `tars-health`) and a `tags.kind`; only those carry `contexts.tars`, rebuilt from numbers and checked words (`report.ts`, `healthEvent`). The SDK cuts any event below a depth of 3 before `beforeSend`, and a diagnostic's samples sit deeper, so `sendHealth` keeps each payload by its event id and `beforeSend` puts it back after that cut, for a health report only (`healthPayloads`, `options.ts`). A health event carries no `type`: the SDK runs `beforeSend` only for an event without one. A clean quit marks the record ended and sends nothing.

### The error triage: `services/error-triage.ts`

Tars asks Sentry about its own errors, since nothing outside can reach it. Every 15 minutes, the first a minute after launch, it lists the unresolved issues of the project its reports go to: `GET https://de.sentry.io/api/0/organizations/example-org/issues/?project=<the DSN's project id>&query=is:unresolved&sort=new&statsPeriod=14d&limit=100`, with `Authorization: Bearer <sentryAuthToken>`, 30 seconds at most, and no redirect followed, since one would carry the token. It needs five things and does nothing while one is missing: `sentryAuthToken` (a Sentry token with the `event:read` scope and nothing more), `errorReportsEnabled`, `sentryTriageProject` (the path of the project whose Hermes board gets the tasks), a configured Hermes (a `hermes-connection.json` that reads and names an address), and the relay to the user's Telegram (`hermesRelayEnabled`), through which the user is asked. The settings are read at each poll, so a change needs no restart.

Each issue not filed yet becomes a task on that project's board, titled `Sentry <short id>: "<title>"`: created on the Tars lane under the idempotency key `tars-sentry:<issue id>`, then parked (`scheduled` on `tars:unclaimed`), where Hermes never runs it. Its body quotes the error between two marked lines, one field per line (issue, title, culprit, level, first and last seen, events, link), each quoted, with what does not show written out as `[U+202E]`, and cut: the words of an error can come from outside Tars. Then it says what to do: QA or the Audit reproduces the error in a sandbox and reports with `mark_task_done` (reproduced or not, the cause, the severity, the file and line, the smallest fix), and nothing is changed for it. Its last line, `Filed by Tars (error triage).`, names no agent, so no agent deletes it as its filer. The link is the issue's permalink when that is an https page of sentry.io, and its page under `example-org.sentry.io` otherwise.

Nobody hears of the task until the user's go-ahead (JeanBrasse's decision 4 of 2026-10-01). The user is asked through the relay, one message per task, `kind: 'sentry'`, ref `sentry:<issue id>`: the short id, the number of events, every field the task quotes, the same lines as in its body (issue, title, culprit, level, first and last seen, events, link), each quoted as data on a line of its own with what does not show written out, and "oui" or "non" to reply. What the user says "oui" to is all the task carries of the error: a field anyone can forge with the public DSN, the culprit say, does not reach QA or the Audit unseen (the Audit's gate of #292; `errorLines` builds both). A request Hermes cannot take waits in the relay's outbox for 7 days, and is asked again if it expired unsent; one that could not go at all is asked at the next poll. The answer comes back through the relay's `sentry` handler, which Tars's own list of what it sent vouches for:

- **"oui"** (in any case, a final full stop or exclamation mark aside; "yes" too): the project's orchestrator is told, as Tars (`tellOrchestratorAsTars`, the landing note's queue: only into a CLI that runs, never mid-turn), which task to hand to QA or the Audit with `assign_task`, by Hermes id and Sentry short id. The note carries none of the error's words. It counts as given once it is written into the orchestrator's terminal, not before. Until then it is owed, in the go-aheads' file, and given again at each poll and whenever an agent's state changes, after a restart of Tars too: an orchestrator whose CLI does not run, a project with none, an orchestrator mid-turn or in a permission dialog, a dispatch refused, a write the terminal refuses or drops. Nothing waits in memory for it, so a quit loses nothing (the Audit's gate of #292: held for a turn's end, it was marked given and lost at a quit), and a note on its way is not given a second time while it goes.
- **"non"** ("no" too): the task is archived on the board (`PATCH status: "archived"`), and nobody is told. A board that refuses leaves it parked, and the user is told to reply "non" again.
- **Anything else**: nothing is decided, and the user is asked again, by a new message that starts `Reply "oui" or "non" to this message.`
- A second answer to a request already decided changes nothing. Each answer is answered: handed on to the orchestrator of the project, waiting for it, archived, or already decided.

The go-aheads are kept in `~/.tars-private/sentry-go-aheads.json` (`0600`), which no agent is handed: the user's "oui" hands a task on in their name, and an agent able to write that list could do it in their place. A decided one is kept 30 days, as long as the relay keeps what it sent.

At most 10 tasks in any 24 hours, the oldest issue first; the rest wait for room. `~/.dorothy/error-triage.json` (`0600`) keeps each issue filed with its task and when, and when each task of the last 24 hours was filed. Lost, the idempotency key hands back the task already on the board, which is marked and neither parked again nor asked about; one that cannot be read stops the triage until it is repaired or removed. A Sentry that fails and a Hermes that refuses mark nothing: the issue is tried again at the next poll, and the key hands back a task that was created and not parked. A development run may point the triage at a stand-in Sentry with `DOROTHY_SENTRY_API_URL` and poll every `DOROTHY_ERROR_TRIAGE_EVERY_MS` milliseconds (a second at least); a packaged Tars ignores both.

The token is kept in `~/.tars-private/sentry-token` (`0600`), not in `app-settings.json` (`services/sentry-token.ts`): `~/.dorothy` is in every agent's `--add-dir`, and the token reads the organisation's issues and events, user reports included. The settings the app holds carry it as before, so `app:getSettings` hands it to the page and `app:saveSettings` takes it; only the file changes. A token saved in `app-settings.json` before 1.9.3 moves out at the first start, and wins over the private one, since an older Tars wrote it last; a save never writes it back, and an empty one removes the private file. The Settings section that writes `sentryAuthToken` and `sentryTriageProject` is the Frontend's. Until it ships, the project is set in `app-settings.json` and the token in `~/.tars-private/sentry-token`, while Tars is closed.

### Residual risk

- Any process running as the user can read `~/.dorothy/api-token`, and every agent is such a process: its shell reads what the user can, a Claude agent has `~/.dorothy` in its `--add-dir`, and `venice` and `custom-openai` even put the token in its environment as `ANTHROPIC_API_KEY` for the OpenAI bridge. On that token a call has no agent identity, so the bus refuses it, and since 1.7.6 so do the routes that drive an agent: start, dispatch, run-task, stop, message, delete and create all need a caller with an identity of its own. It still **reads**: the listing, an agent's status, its output and its bootstrap are open to it, because `session-start.sh` fetches the bootstrap with it at the start of every session. A process holding the file can enumerate the fleet and read any agent's terminal, and no longer drive one.
- **An agent's own token is not secret from the other agents.** It lives in the environment of the agent's CLI and of its MCP servers, and `ps -Eww -p <pid>` prints the environment of those processes to any process of the same user. Only Apple's platform binaries, `/bin/zsh` among them, hide theirs, and neither `claude` nor `node` is one. An agent set on it can read a colleague's token and present it. Per-agent tokens end impersonation by naming, not impersonation by a process that reads the process table; only isolating agents from one another at the OS level would. A sandbox does not: measured under a deny-by-default `sandbox-exec` profile, a process still reads another's environment through `sysctl KERN_PROCARGS2`, and no rule in the profile language stopped it. `SECURITY.md` §3 has the four parades that were weighed and why none was written.
- The super chat conversation is stored in clear, and since 1.7.6 outside the directory the agents are handed: `~/.tars-private/overseer.json`, mode `0600`, migrated from `~/.dorothy/overseer.json` at startup. That takes it off the listing an agent gets for free and out of the reach of anything walking `~/.dorothy`; an agent that goes looking for the new path still reads it, because it runs as the user. Keeping the global room closed on the API protects the API path, not the file. The Telegram send routes, the Telegram MCP server and the vault's attach route refuse the private directory, which stops a one-call send or copy, not an agent with a shell.
- The Hermes webhook secret opens a route that dispatches to any agent of any project, by id or by name. It lives beside the conversation, in `~/.tars-private`, and is exactly as reachable: out of the directory an agent is handed, not out of the reach of an agent that goes looking. It was in `~/.dorothy` until 1.7.6 and moves with its value unchanged, so an agent that read it before still has it until it is rotated.
- `permissionMode: 'auto'` is the default for agents created over the API and maps to `--permission-mode auto` (only `bypass` emits `--dangerously-skip-permissions`), and `ensureProjectTrusted()` pre-accepts the workspace-trust dialog. An agent has the user's full filesystem authority inside its cwd and beyond.
- API keys for the ten alt providers are stored in plaintext in `app-settings.json` and passed to the CLI as `ANTHROPIC_API_KEY` in the PTY environment.
- The error triage's Sentry token is in `~/.tars-private/sentry-token` since 1.9.3, out of the directory the agents are handed, and exactly as reachable as the other files there: an agent that goes looking for the path still reads it, because it runs as the user. Its scope, `event:read`, lets it read the issues and events of the organisation and change nothing in Sentry.

---

## §12 Build and packaging

| | |
|---|---|
| App id | `xyz.cooperlabs.tars` · product name `Tars` |
| Entry | `electron/dist/main.js` (TypeScript compiled by `tsc -p electron/tsconfig.json`) |
| Renderer | `ELECTRON_BUILD=1 next build` with `src/app/api` and `src/app/icon.tsx` moved aside behind an `EXIT` trap, output to `out/` |
| MCP servers | each `mcp-*` bundled by its own esbuild from `src/index.ts`, `mcp-shared/` included (`tsc` only checks the types), shipped as `extraResources` filtered to `package.json` + `dist/bundle.js` |
| asarUnpack | `out/`, `hooks/`, `electron/resources/`, `better-sqlite3`, `node-pty` |
| Target | macOS dmg + zip, hardened runtime, `build/entitlements.mac.plist`, notarized via `@electron/notarize` |
| Updates | `electron-updater` against `cooper-labs-tech/Tars` releases |
| Electron | 44.4 (Node 24.21, ABI 149, Chromium 152). Its `LSMinimumSystemVersion` is 13.0, so the app needs macOS 13 or later |
| Node | ≥22.12, Electron's own floor; `.nvmrc` pins 22 |

Tests: `vitest run` over `__tests__/**/*.test.ts` (node environment, `@` aliased to `src/`), with coverage scoped to `electron/{constants,utils,services,handlers,providers}` and the MCP server sources. Suites exist for the ACP client, the model catalogue, transcript usage, the memory hub, agent persistence, the PTY manager, four providers, delegation plumbing, and two dedicated security files.

E2E: Playwright, `testDir: ./e2e`, one worker, serial: one Electron instance drives every surface. Screenshots at `e2e/__screenshots__/`. `npm run e2e:guard` checks a hardcoded list of ten routes (`/`, `/agents`, `/kanban`, `/vault`, `/projects`, `/skills`, `/usage`, `/memory`, `/settings`, `/whats-new`) against the E2E manifest; `/crons`, `/review`, `/logs` and `/tray-panel` are not checked, and `design/UI-INVENTORY.md` is read only to count overlay entries.

---

## §13 Known limitations

- **Delivery over the PTY is confirmed for a spawn, and reported for a bus message.** A spawn carries its task until a turn actually starts: if none has begun fifteen seconds after the session registers, `armTaskStartWatch` types the task into the live session once, and marks the agent failed if that does not start one either. A bus message is confirmed the other way, by a delivery row that says queued, delivered, dropped or not sent, with a reason code. Everything else is fire-and-forget: `/dispatch` into a session that is already running returns when the bytes are written, and only `/run-task` answers with what the agent did.
- **The bus leaves two things out, on purpose, and interrupts only on a person's say.** Nothing writes into a turn Tars knows is running, except `bus:sendNow`, the composer's send now (JeanBrasse's choice, 2026-09-23): only for a member on the claude binary (`BusMember.canInterrupt`), it sends Esc and types the message once the transcript records `[Request interrupted by user` (Claude Code sends no Stop hook for an interrupt), 5 s at most, else the message queues for the turn's end. There is no heartbeat. And there is no ACP steering: a delegated run is cancelled only when its agent is stopped or deleted (the window, the API, Telegram, Slack), by `stopAcpRuns` (acp/delegate.ts), which asks the run to cancel, gives it 1.5 s to end its turn, then ends every process group found among its processes' descendants (`ps -A -o pid=,ppid=,pgid=,stat=,etime=`, read before the first signal and again before the last; a known pid younger than the time since the first read, with a parent outside the run, is another process that took the id and is left out, and a zombie counts as gone), its groups first stopped (SIGSTOP) and read again until a read adds no group, five times at most, then SIGTERM with SIGCONT, then SIGKILL two seconds on: Claude Code's Bash tool runs each command in a group of its own, and the run's own group alone left those commands alive when claude could not pass the stop on. Stopped before it is read again, a parent starts nothing more and what it started is under it: a command started while the first ps ran was in no read, and with its parent dead at the SIGTERM it was left under launchd in a group of its own, tied to the run by nothing (the QA's B1 on #358: 22 runs out of 22 on its bench). Quitting Tars ends every delegated run before the app exits (`endAcpRunsOnQuit`, a before-quit step): each is asked to cancel, best effort, then the same process groups, stopped and read again the same way, get SIGTERM and SIGCONT, a wait of at most a second that ends as soon as none is left, and SIGKILL, all while the quit waits, since no timer outlives the app. Every read of ps in a quit shares one deadline, 1.5 s from its start: a ps that hangs held the quit 6.5 s with a 2 s timeout per read. Measured on 2026-09-24 with claude-agent-acp 0.81.1: a run that still answered, one whose adapter was SIGSTOPped and one whose claude was, all gone with Tars about 1.4 s after `app.quit()`. Before this, a run whose claude was SIGSTOPped was whole 14.7 s after the quit, reparented to launchd. The run's caller is answered "the run was stopped: the agent was stopped". Before this (the Audit's table, #6), a stopped agent's run went on working for up to its hour. None of these is inferred from silence: idleness detection is deliberately absent.
- **A message behind somebody's draft reads `held`.** The terminal has taken it and Tars never types across a draft, so it waits for that person to send or clear the field: `held` with `reasonCode: 'draft'` and `heldAt`, `delivered` when it goes in, `dropped` if the terminal exits first. Stop does not drop a `held` message: its terminal already holds it and will type it. `listRooms` counts what waits in each room (`pending`), and a change of members carries who came and went as data (`systemData`).
- **A message to a CLI with no end of turn is held, not lost.** amp, codex, grok, opencode and pi never leave `running` in an interactive session, so nothing is queued for them and the delivery reads NOT SENT with its reason and the time it was refused. `bus:releaseNotSent(agentId)` is the way out, and only a human calls it: it writes what is held into that terminal, oldest first, and the messages become `delivered`. Tars still refuses to do this by itself, because it cannot know the state of that session. Two deliberate exceptions live here: the session barrier does not apply, so an agent killed and relaunched between the button being drawn and the click receives them in its new session, because a person is aiming at the agent and not at a session id; and one release runs at a time per agent, a second refused with its reason rather than queued, because two would interleave their writes into one terminal.
- **Status lifecycle depends on hooks, which four providers do not have.** `codex`, `grok`, `opencode` and `pi` only ever transition on PTY exit. `wait_for_agent` and `lastCleanOutput` are effectively unavailable for them on the terminal path.
- **A changed model or effort restarts only the CLIs on the claude binary.** codex, gemini, grok, opencode, pi and amp report no end of turn, so they take new settings at their next launch.
- **The `/run-task` status event name does not match what `/wait` listens on.** `emit('status', …)` vs `` `status:${agentId}` ``.
- **`pi` has no ACP fallback entry.** If the ACP registry has never been reachable, `pi` has no ACP mode at all.
- **Some of Tars's own files are still written in place.** `templates.json` (after a backup copy), `team-templates.json` and `cli-paths.json`, and the caches and generated files. `agents.json`, `app-settings.json`, `hermes-connection.json` and `projects.json` are written to a temp file and renamed over. Claude's own files, `~/.claude.json`, `~/.claude/settings.json` and `~/.claude/mcp.json`, go through `updateSharedJsonSync`, which also keeps their mode and never writes over a file that is not JSON: `claude-files-writers.test.ts` fails if anything in the main process or the MCP servers writes them another way.
- **`agent.output` retains 600 chunks live and 100 on disk.** `/logs` searches only what is retained; there is no persistent log store.
- **A panel's history reaches back 5,000 lines while it stays mounted, and 2,500 when it comes back**: the Dashboard panel's xterm keeps 5,000 (#313), and a terminal's mirror, which a panel that comes back is handed, keeps 2,500 above the screen (JeanBrasse's choices of 05/10; the mirror kept 1,000 and the panel 10,000). And a cursor parked past the last column (xterm waiting to wrap) comes back on the last column, since no cursor move reaches past it: 2 chunks in 4269 across twelve recordings of Claude Code, the content identical.
- **The left-fullscreen flag is only watched for the `claude` binary.** Its signature was measured on Claude Code's two renderers; another fullscreen CLI that climbs its frame with `CSI A` in every chunk would be taken for inline, so none is watched. Tars reports the state and sends the program nothing: what a panel does about the wheel is the renderer's decision.
- **The API token is a single flat credential.** No per-agent scoping, no rotation UI.
- **The webhook is the only surface designed to leave the machine**, and it needs an operator-provided tunnel; nothing in the app opens one.
- **`installBundledSkills()` currently ships nothing.** Its only remaining job is deleting stale `world-builder` copies left by older versions, and only when the file content is recognizably ours.
- **macOS 13 or later only.** Electron 44 declares 13.0 as its minimum, so a Mac on 12 cannot open the app, nor the update to it. `electron-builder` targets `--mac`, and the code stays Linux compatible (JeanBrasse, 2026-09-24): the CI runs the tests on ubuntu, and a macOS-only path has a Linux branch or fails cleanly. Opening a project in a terminal (`shell:open-terminal`) uses Terminal.app on macOS and on Linux the first of `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm` that is installed, started in the directory with no shell (`utils/open-terminal.ts`); elsewhere it says it cannot. A terminal Tars opens with `SHELL` unset runs `/bin/zsh` on macOS and `/bin/bash` elsewhere (`defaultShell`, `utils/default-shell.ts`); agent terminals run `/bin/bash` everywhere. The status line reads a file's age with BSD's `stat -f%m`, then GNU's `stat -c%Y`. A notification sound goes through `afplay` on macOS, `paplay` then `aplay` on Linux.
- **The code stays Linux compatible** (JeanBrasse, 2026-09-24). Only the packaging is macOS: the CI runs the tests on ubuntu, and a macOS-only code path has a Linux one or fails cleanly.
- **An Amp update leaves `amp` missing for a few seconds.** npm removes the old package before the new one is unpacked: measured, 3.3 to 9.3 s with the tarballs already downloaded, which Tars makes sure of first, then under a second on a placeholder that prints "Amp native binary not installed". Tars waits for every running `amp` to end before it starts, but nothing holds a launch back during those seconds, and one that falls in them fails. A claude update has no such window.
- **A claude session that outlives two newer releases can lose its binary file.** The native installer's cleanup keeps the two newest versions and any version whose lock is held, and only the first session on a version holds that lock. Measured: once that session had exited, the cleanup deleted the file under a second session on the same version, and that session's next turn still answered, but its Grep and Glob tools do not: native claude runs its embedded ripgrep by starting its own file again, as `rg`. With no `rg` on PATH every later search fails (`posix_spawn 'rg'`, ENOENT); with Homebrew's on PATH, as in a Tars terminal on JeanBrasse's machine, the first search fails with a misleading "ripgrep not found on PATH" and the next ones go through the system `rg`. A `claude` started from inside it fails too. A restart ends it. `USE_BUILTIN_RIPGREP=0`, with `rg` on PATH, kept Grep and Glob working when QA measured it, and is for a later change. The cleanup is claude's own: every session's housekeeping runs it, not only an update.
- **Agents started before a claude update finishes stay on the version they started with** until they are restarted. The pass runs 5 s after launch and takes about 10 s, while the agents set to start with the app may already be starting.
