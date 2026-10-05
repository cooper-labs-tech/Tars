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
- **Nothing is ever pushed upstream.** The fork lives at `JeanBrasse/Dorothy`; `GITHUB_REPO` in `electron/constants/index.ts` points there so an upstream build can never be offered as an update to a fork install.

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

**At quit** (`endAllTerminals`, `core/pty-manager.ts`), each terminal's process tree is read from `ps` first, while the parents that tie it together live; the shells get their hangup as before, which bash relays to its jobs; the quit is held (`before-quit`, two passes) while the event loop turns until every process of those trees has ended and node-pty has delivered every exit, 1.5 s at most; then what is left, in those trees only, gets SIGKILL. Measured: a CLI that ignores SIGHUP and SIGTERM, and its child, outlived 8 quits of 8 before, and none after; a quit with a real claude takes about 1 s instead of 0.4. The exits used to come after a synchronous `before-quit`, and one delivered during Electron's final cleanup aborted the app (SIGABRT in `pty.node`'s ThreadSafeFunction, #231's proof). From the moment the quit begins (`beginQuit`, `core/quit-state.ts`), nothing new is spawned: `spawnAgentSession` answers 503 with `quitting: true`, `spawnAgentPty`, the ACP client, `delegateOverAcp` and every `pty.spawn` refuse, and a terminal's exit is neither its agent's completion nor its error (`agentStatusOnExit`, in each of the six exit handlers). The user's own shell panels get the hangup only: a job left there with nohup or disown survives the quit, and only a shell that ignores the hangup is itself SIGKILLed. `endAllTerminals` runs before the delegated runs' synchronous grace, so the two graces overlap. `e2e/quit-ends-agents.spec.ts` drives it in the app: a CLI deaf to SIGHUP and its child are gone 1.8 s into the quit, a `/start` 200 ms in gets 503, and the agent is not saved `completed`; on main the CLI outlives the quit and the agent is saved `completed`.

`writeProgrammaticInput(pty, data, bracketPaste)` is the only sanctioned way to inject text into a running agent:

- `bracketPaste: false` means plain `data + '\r'`, for the initial shell command. A command holding a tab or a newline is never typed: bash's readline reads a typed tab as the completion key (macOS's /bin/bash 3.2 has no bracketed paste to protect it), and a task with a tab reached the CLI with its tabs eaten. Such a command is written to a file of its own (`tars-launch-*` under the temp folder, `0700`, the file `0600`) whose first line removes it, and the shell is given `. '<file>'` (`shellLine`, `core/pty-manager.ts`). Before each reuse the folder must still be a directory, not a link, owned by this user and closed to others, or a new one is made (a multi-user /tmp that is cleaned let another user make one of that name, the Audit's gate of #224); it goes when Tars quits, if it is still ours. A file whose command never runs stays until then, or until the temp folder is cleaned if Tars is killed. A command with neither is typed as it is, so the terminal shows what was launched.
- `bracketPaste: true` is for a live Claude Code TUI. Input over 200 chars or containing a newline is wrapped in `\x1b[200~ … \x1b[201~`. **The carriage return is always a separate write delayed 300 ms**, because the TUI treats a rapid `text\r` burst as one paste event: the text lands in the box as `[Pasted text]` and is never submitted.

It must never be used for keystroke passthrough from an xterm.js terminal.

Every agent terminal also has a mirror, `electron/core/terminal-mirror.ts`: a headless xterm 5.3 (`xterm-headless` at the renderer's version, with the Dashboard's `convertEol`) that `spawnAgentPty` attaches before any caller subscribes, and that parses each chunk as it arrives. `agent:get` hands a panel `terminalSnapshot()` of it as its `output`, one chunk: RIS, both screens as the serialize addon writes them (the normal one with 1000 lines of history, then the alternate one when it is active), and what the addon leaves out: the SGR mouse encoding, the cursor's visibility, a scroll region, the cursor put back absolutely. A panel that remounts, back from another page or from another project's tab, is shown the screen itself instead of a replay of the kept chunks, which after a few minutes of a fullscreen turn held no frame: the Audit measured 856 visible characters in a panel before leaving the Dashboard and 37 after coming back, on 2026-09-23. One mirror per PTY, runtime only, nothing persisted. A terminal with no mirror falls back to the kept chunks. An agent with no terminal is handed nothing and no `ptyId`: `agent:get` opens no terminal. Until 2026-09-24 it opened a login shell for any agent looked at, whose banner ("The default interactive shell is now zsh.") went into the agent's output and read as its last line in the Chat's fleet list; the Dashboard shows such an agent as `(Session idle)`, and a start opens its terminal.

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
| `create_agent` | Defaults to the caller's project |
| `start_agent` / `send_message` | Both route to `POST /dispatch`; `send_message` accepts `message` or `prompt` so the LLM doesn't trip on naming |
| `stop_agent` / `remove_agent` | `stop_agent` requires a one-line `reason`; the agent then reads `stopped`, with `stoppedBy` (the caller's name) and the reason (see Stopping an agent) |
| `wait_for_agent` | Single long-poll against `/wait`, no polling loop |
| `delegate_task` | The composite. ACP first, terminal dispatch as fallback |
| `room_post` / `room_read` | The bus: publish into the caller's project room, or catch up on it. Every bound (three rounds, ten agent messages, silence markers, rotation, the session barrier) is applied by the server in `bus-store`, so writing faster buys nothing |
| `send_telegram` / `send_slack` / `send_discord` | Reply to whichever channel the request came from: for Telegram, only a chat authorized in Settings (the app's route and mcp-telegram alike); for Slack, the channel of the last allowed user who wrote; for Discord, the channel the message named, if Settings detected it or an allowed member wrote from it |
| `ask_user` | For a project's orchestrator only (JeanBrasse's rule of 2026-10-01; a worker gets `403` and asks its orchestrator): ask the user a question on their Telegram through their Hermes, with the relay on (`POST /api/user/ask`, `services/user-questions.ts`), from the agent's own terminal token only (not the shared token, not a delegated run's). The question goes as plain text under the agent's and the project's names, every line of the agent's words quoted (`> `) so none can pass for Tars's own, secrets masked, cut to what Telegram takes. Hermes down: it waits, the tool says it has not reached the user yet, and it goes when Hermes takes it. The user's reply to that message, which the relay checks against Tars's own list of what it sent, is typed into the asking agent's CLI through the writer (dialog guard included) after `Message from the user via Telegram: `, a sender line only Tars makes, with their answer alone: never the question, which the agent wrote. An agent with no CLI running is not typed into, and the user is told; an answer held for the terminal and dropped because the CLI stopped meanwhile reopens the question. One open question per agent, 20 in 24 hours for the fleet, 4 hours to answer, after which the agent is told there was no answer, or that the question never reached the user, by the time it asked and never in its words. Kept in `~/.tars-private/user-questions.json` (`0600`). With the relay off: `503` |

Auth: `Authorization: Bearer <token>`, the agent's own `CLAUDE_MGR_API_TOKEN` when the process was started with one and `~/.dorothy/api-token` otherwise, plus `X-Tars-Client: mcp` and caller identity headers. The server takes the caller from the token alone: an id header naming another agent is refused, and on the shared token the call has no agent identity at all. Timeouts: 30 s normally, 600 s on `/wait`, or an explicit override: a caller passing `timeoutSeconds` sends `(timeout + 30) * 1000` so the client never gives up before the server-side long-poll resolves.

`delegate_task` in full:

1. `POST /api/agents/:id/run-task` with `(timeoutSeconds + 60) * 1000` client timeout. While it waits it sends the caller an MCP progress notification every minute (`keepCallerListening`): Claude Code abandons an MCP call silent for 30 minutes ("sent no response or progress for 1811s; aborting", four delegations of the Parallel project on 2026-09-23), and progress resets that clock. The route answers 200 whenever the run started, `started: true`, however it ended, and 502 only when it could not start. For a run that started, return the agent's answer with a metadata line: `ended: <stopReason> | tools: … | <n> tokens | $<cost>`, then the reason when it failed (`turn_limit`: stopped at its limit, with what it said and did before it) and `stopped when the run ended: …` for the background work its turn left behind (`backgroundStopped`).
2. When no run started (`retryWithDispatch`, a launch that failed), `POST /dispatch` → `GET /wait`. Never after a run that started, and never when this call's own wait ran out (the run may still be working): either one typed the same brief into the terminal as well, and the task ran twice.
3. If the agent lands in `waiting` with `waitingReason: 'permission'`, stop. A blocking permission dialog expects arrow keys and Enter; a typed message cannot answer it and the delayed `\r` could *accept* the pending permission.

**Nothing Tars types goes into a dialog its CLI shows** (`agentTakesTyping`, `core/agent-launch.ts`). A dialog is what the PermissionRequest hook reported (`waiting`, `permission`: a permission, an AskUserQuestion, which fires that hook in bypass too, an ExitPlanMode), or a screen whose last rows end on "Esc to cancel", before that hook arrives (`dialogOnScreen`, `core/terminal-mirror.ts`; the hook came 3 to 648 ms after the dialog was drawn). The writer itself refuses, at the moment it would write (`writeProgrammaticInput`, through `setDialogProbe`, wired in main.ts): a message queued before the dialog opened does not go in after, whoever queued it, the bus, a delegation note, "send held", a bot. It waits in the terminal's queue (a bus delivery stays `queued`) and goes in once the dialog is gone. A key a person types while one is up answers the dialog and is not read as a key in the field behind it. The screen only ever adds a dialog. A refusal, with "No" or Esc, sends no hook (the turn ends interrupted: no Stop, and no idle prompt in 90 s), so the dialog is closed from the transcript: `waiting`/`permission` counts only while no `[Request interrupted by user` entry is recorded after the moment it opened (`dialogSince`, `lastInterruptAt`). Measured in the app: a post held by the dialog went in 1.5 s after an Esc and 1.2 s after "4. No". The dialog is dated by the hook script itself (`opened_at`, jq's clock, the same on macOS and Linux; bounded to the last minute), not by the post's arrival, so a refusal made before a late post still closes it. A turn ended by Esc sends no hook either: agent-watch reads an interrupt recorded after the turn began, after work was last handed over, and after the CLI now running was launched (a session resumed with `--fork-session` copies the old interruptions with their dates; the session's registration stands in only when no launch was noted, since claude registers again at every compaction), as that turn's end (`idle`, every 2 s, started by main.ts). Measured in the app: `idle` 307 ms after the Esc. What waited then still waits for the draft guard, since a person's lone Esc leaves the field unreadable to it (older than this), until the next submission. The Enter a message's paste is followed by waits out a dialog that opened in the 300 ms between them, and a person's keys meanwhile reach the dialog. A held message's reason names the dialog. Measured by the Audit on 1.8.0 with claude 2.1.280 before this: a room post said Yes to "Do you want to proceed?" and "Yes, delete it" to "Delete the build folder?" in bypass.
4. Any other `waiting`: auto-reply *"Yes, continue. Do not ask for confirmation…"* once, then wait again with `max(timeout - 30, 60)`.
5. On completion, fetch `lastCleanOutput` with 3 attempts 700 ms apart: the Stop hook posts output and status over separate HTTP calls, so the status event that resolves `/wait` can beat the output write.

### Atomic dispatch: `performDispatch()`

```
killStalePty(agent)                       // BUG 4: worktreePath changed after spawn
if live PTY && waiting on permission  → 409, refuse
if live PTY && a CLI runs in it       → writeProgrammaticInput, clear lastCleanOutput,
                                        status = running, mode 'message'
else                                  → spawnAgentSession(), mode 'start'
```

A CLI running in the terminal is read from the terminal (`cliRunningIn`, its foreground process), not from the status: every turn ends on `idle` (the Stop hook posts it) and a failed one on `error`, with the CLI still at its prompt. Taking those for "no session" spawned a new claude over it, which kills the terminal, with no `--resume` (the resume is spent once per run): a message to an agent that had just finished a turn ended its conversation. Nor does `running` or `waiting` type by itself: over a bare shell, left by a CLI that died without its SessionEnd, the message went into the shell, which ran it as a command. A session the API starts runs `bash -l -c "cd … && exec <cli>"`: the exec hands the terminal to the CLI, so node-pty names the CLI, and a terminal handed a command counts as a CLI's for as long as it can be read, which covers the moment before the exec while the shell reads its login files. Until 2026-09-23 there was no exec, node-pty named `bash` for the CLI's whole life, and every agent the API had started read as no CLI: `/dispatch` and `/start` ended their sessions and the Dashboard's Start typed its launch line into claude's field. `/message` follows the same rule, and starts a session rather than type into a bare shell. A launch on its way (a restart, a start from a window, a bot's cold start, a session the API starts) owns the terminal until its session is up: for `CLI_BOOT_MS` (15 s) whatever runs in it, and past that for as long as its CLI runs, up to `CLI_UP_MS` (180 s). `/dispatch`, `/message` and the bots wait for it and then type into its session, and agent-watch holds its notes (`sessionStarting`, `core/agent-launch.ts`). `/dispatch` and `/message` wait `SENDER_WAIT_MS` (20 s) at most, inside the 30 s the MCP tools wait for an answer, and a launch still starting then is answered `409` with `starting: true` and nothing typed. The 20 s count from the request, not from the agent's lock: counted from the lock, a sender queued behind another was answered up to 40 s after it asked, and typed after its caller had been told it timed out (the QA, gate of #158: `200` at 31.6 s). A sender refused `409` typed nothing and takes nothing either: the delegation link (`requestedBy`) is recorded only once the agent takes keys, so the note agent-watch owes stays with whoever gave the launch its task. Until 2026-09-23 the launch was given up at 15 s whatever ran: at a load average of 120 to 300, 5 of 18 launches took longer (the Database Engineer, re-gate of #134), the sender typed into a claude not yet taking keys, was answered `200` `message`, and the text was lost. A launch whose CLI is gone, or runs past 180 s without its session, is dropped, so a CLI that never comes up does not hold its agent. Up, for a CLI on the claude binary, is not the exec: claude 2.1.280 takes no keys for a moment after it execs, and a `/dispatch` 0.1 to 0.3 s after a `/start` was typed there and lost 4 times in 5 (the Audit, gate of #134). A launch with no task (a restart, a Dashboard start) is up at its SessionStart; one that carries a task at that task's `UserPromptSubmit`, because between the two claude submits its initial prompt from its own field, and a message typed then was lost once in five. Typed once the turn runs, claude queues it and takes it after: 8 of 8 delivered once in the app. A launch is marked before its terminal is opened (the bots mark it once they know no CLI is up), and dropped when it fails, is refused or its CLI exits, so nobody waits the 15 s for it. The SessionStart registration is announced as a fleet change, and a note agent-watch held for the terminal during the launch goes in then, to the session that registered in that terminal. Measured by the Audit before this: a dispatch 0.3 s after a restart started a session over the launch without `--resume` and lost the conversation, and at 0.49 s the killed CLI's late SessionStart also took the agent from the live one. `/start` answers `409` with `cliRunning: true` when a CLI is up, as `agent:start` does. Telegram `/start_agent`, Slack `start` and a message to the super agent from either type the task into a CLI that is up instead of typing a launch command into its field, and start one where none runs, whatever the status says. Where they start one, the launch line is typed once the shell is at its prompt: it has printed something, then been quiet for 150 ms (`shellReady`, `core/agent-pty.ts`, at most 5 s). Typed before, the line goes through the terminal's canonical mode, which holds about 1 KB on macOS (4 KB on Linux), and a launch carrying a long message was cut: measured at the QA gate of #155, 995 bytes typed at once ran and 1095 did not, and a Telegram message of 946 characters started no session in 60 s.

**A running agent that does nothing** (`services/stall-watch.ts`, every minute, started by main.ts) is marked `stalledSince` (its transcript's last write) when it is `running`, its Claude Code transcript has had no write for 30 minutes, and no process under its CLI is at work other than its MCP servers (a command naming `mcp` or `bundle.js`) and `caffeinate`, and no `caffeinate` there is live and under its 300 s: a renewed one is a sign of life, which is all an agent in a long MCP wait (`wait_for_agent`, `delegate_task`) or a subagent shows (the Audit's gate of #283). Linux has no `caffeinate`, and keeps the rest of the rule. Measured on 01/10 over 21 live claude processes: a turn keeps a `caffeinate -i -t 300` child, renewed; a Bash tool runs as a `<shell> -c source ...shell-snapshots...` child, so a long build writes nothing to the transcript and is not a stall. The frozen claude of 28/09 (main thread in `openat`, 0 % CPU) had only an unreaped zombie under it. The note goes, once per stall, to whoever handed it the work, else to its project's orchestrator (agent-watch, `kind: 'stalled'`); `/wait` and `wait_for_agent` carry it. A write, or any other status, clears it; it is not saved. Claude Code only, whose transcript Tars finds. `e2e/stall-signal.spec.ts` drives it in the app with stand-ins: the one running a `sleep` is not marked, the idle one is, and its orchestrator reads the note.

`spawnAgentSession()` is shared by `/start`, the `/message` reconnect path and `/dispatch`, so every entry point gets identical behaviour: the identity header, the skills prefix, the MCP config for flag-strategy providers, orchestrator instructions (`electron/resources/super-agent-instructions.md`) via `--append-system-prompt-file`, the tool block, trust pre-acceptance, stale-PTY kill, the `ptyCwd` invariant and the session-ownership reset.

The model on its command line is the one the call names, or else the agent's own, `agent.model`. The same rule holds for every launch from a window (`agent:start`, which the Kanban automation and the restart below call too, through `core/agent-launch.ts`), for Telegram and Slack, and for ACP. It is never the model the agent's previous session last answered on: that reading, from the transcript, comes back to the renderer as `sessionModel` on `agent:list`, for a screen that wants to show a `/model` typed into a terminal. Such a `/model` lasts for that session; the next launch uses the agent's model.

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
- Fallback: if `SessionStart` never arrived (API briefly down at boot), the first non-tombstoned session that reports in is adopted.
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

### Stopping an agent: `core/agent-stop.ts`

`POST /api/agents/:id/stop` (and `stop_agent`, which calls it) requires `reason`, one line (`oneLine`: controls and direction marks out, 200 characters at most); without one it answers 400 and touches nothing. The window's stop (`agent:stop`, `stop(id, reason?)`) files it under `you` with the reason it was given, if any. `stopAgent` ends the agent's delegated runs, records the stop (`status: 'stopped'`, `stoppedBy`: the calling agent's name, `Tars` for its own pass or `you`; `stoppedAt`; `stopReason`), tombstones the session, saves and announces, then ends the terminal's whole process tree as the quit does (`endTerminalTree`, `core/pty-manager.ts`: the hangup, 1.5 s, then SIGKILL to what is left of that tree). The API answers once the tree has ended. Measured in `e2e/stop-ends-agent.spec.ts`: a CLI deaf to SIGHUP and SIGTERM and its child gone 1.8 s after the call; before, a stop sent the hangup alone (on 28/09 two frozen CLIs survived `stop_agent`, reparented to launchd). `stopped` survives a restart of Tars (`loadAgents`), so the Dashboard does not resume it, and the kanban automation, which takes `idle` agents, does not hand it work; `/wait` and `wait_for_agent` say who stopped it and why. A new terminal (`initAgentPty`, `spawnAgentSession`) clears it. The window says it where an error gives its reason (frame `Agent stopped · who and why`): the word `stopped` in the idle ink, and one line, `Stopped by Project Lead at 14:02: <reason>` (`src/lib/stop-line.ts`), in place of the task on its card, of the branch in its pane's header and of the path in its window, under its name in an orchestrator's rail, and as the title of the word. The Agents page has a Stopped chip, the Projects page offers resume and start as for an idle agent, and the window offers no second stop, which would file it under you and replace who and why.

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

The permission mode is the agent's own on every launch, orchestrator or not. `agent:start` used to put every orchestrator in bypass whatever it was set to, so a permission mode changed in the Agents page never reached one, restart or not, and a worker switched to orchestrator was quietly given bypass. Two unattended launches still ask for bypass: the Kanban automation, and a Telegram message that has to start the super agent.

The contract: `role` on `agent:create` and `agent:update`, where anything but the two values is refused; `POST /api/agents` takes `worker` and refuses `orchestrator` with a `403`. `orchestratorMode`, the toggle's old field, is read as the same toggle when `role` is absent, and kept equal to `role` on every record, for the renderer until it reads `role`. `agents.json` is at version 3 since: a file below it is migrated once on load, `role` = toggle on, or the role stored from the name, or the name itself on a record older than the role field, so no orchestrator of that day changes. After that the name is never read. A team template member saved without a role gets the same migration.

### Cross-project scoping

`assertSameProject()` guards `/start`, `/dispatch`, `/run-task`, `/stop`, `/message` and `DELETE`. It reads the caller's project from a request header:

- No header **and** `X-Tars-Client: mcp` → 403. An agent's MCP always announces itself; if it does so with no identity its calls cannot be scoped, and defaulting to "allow" would let it drive every project's agents.
- Header matches the agent's `projectPath` → allow.
- Mismatch → 403 with the agent's project named, unless `allowCrossProject: true` is in the body (or the query string, for DELETE, which has no parsed body).
- No header at all (the renderer, `curl`) → unrestricted.

`GET /api/agents` uses the same header to filter the listing and reports `scopedToProject`. An orchestrator that only ever *sees* its own team cannot pick another project's agent id by mistake.

### What guarantees delivery, and what does not

**Guaranteed.**
- `/run-task`: the ACP turn either resolved (with `stopReason` and usage) or the call returned an error. This is the only path with a receipt.
- The dispatch decision is atomic: message-vs-spawn is made server-side under the event loop, so a stale client-held status can no longer route a prompt to a dead PTY. `ptyProcesses.delete(ptyId)` happens *immediately* in `onExit`, before the 1.5 s status delay, because `node-pty` `write()` on a dead PTY is a silent no-op.
- Stale hook posts cannot corrupt a live task's status or output.
- The orchestrator deny-list is enforced by the protocol on every ACP provider.

**Not guaranteed: be explicit about this.**
- `/dispatch` on the PTY path returns as soon as the bytes are written. There is no acknowledgement that the agent read the message, and none that it understood it as a task rather than as terminal noise. `mode: 'message'` means "typed into a live session", nothing more.
- A message into a field somebody is using is held, not typed (`held: true`, and `HELD:` from `send_message`, `start_agent` and `delegate_task`). It goes in when the field frees: at a pause in the typing, when what was typed is sent or cleared, or when the session transcript shows a slash command typed by hand has finished (`<command-name>` and `<local-command-stdout>`, written when a command closes, `lastLocalCommandAt`). Only when the last key typed there is the Enter or Esc that closed the panel: a key typed between the panel closing and its record went into the field. `/help`, and `/config` closed without a change, write no record; `/model` cancelled with Esc writes two `system` records of subtype `local_command`, which the reader skips on purpose, since the same pair is written when the "Switch model?" confirmation is backed out of with Esc while the picker stays open. Those three leave it held until the next key or Ctrl+C in that terminal. A terminal that exits drops what it held (`terminalExited`).
- A message typed into a CLI, short or pasted, comes after a line naming its sender as Tars verified it (`senderLine`, `core/pty-manager.ts`: the agent by name and id, Tars, or Telegram, Slack, Discord, Hermes). Claude Code 2.1.280 hands a folded paste to the model as `<pasted_content>`. That the line stays outside the tag was measured once, with a real account in a sandbox (session 27029ce7, 2026-09-22 23:31Z: `Message from agent "Beta" ("sb-beta"): ` then `<pasted_content id="eab1">`), and fits JeanBrasse's transcripts, where 40 of 41 folded pastes begin their record with the tag; a stub API with key auth never folds, so the gate of #128 could not see it. Whether the receiver treats the message as work is for its instructions to say, not the line: measured with the same brief on Haiku 4.5, a bare paste was declined, `Message from Tars-Orchestrator:` was carried out, and two other wordings were declined again. A line of the message itself that reads like a sender line ("Message from …", any case, after spaces, the first line included) is quoted with `> `, so no message can show a second, forged sender (`quoteSenderLookAlikes`, the Audit's gate of #231). Its skeleton is compared, not its bytes nor its words (`skeletons`: NFKC and NFD, every look-alike of the eight letters of "message from" read as the letter, from Unicode's confusables, UTS #39, and each one's Latin forms with a bar, a hook, a stroke or a tilde through it, by their Unicode 16.0 names (QA's recheck of #240: "Mɛssage", "frøm"), then everything but a to z dropped: marks, blanks, punctuation, digits, and the letters that draw as one of those, a katakana prolonged-sound mark as a list dash or a dental click as a pipe): a no-break or zero-width space, a Cyrillic e, a line in bold or brackets, an Armenian, Cherokee or small capital letter each got past a match on the bytes or the words (the Audit's gates of #240). A line that only starts with the words, "Message from QA was good", is quoted too. What it does not quote, by the choice to read a line from its start: one whose skeleton has letters before the phrase, "Fwd: Message from JeanBrasse ...", "Re:", "Note:", "PS", "a)" or "i." (QA's recheck of #240), and a phrase after a separator that is typed as no new line (a lone CR, \v, \f, U+0085, U+001C to U+001E), which joins the line before it. Every line is not quoted instead: Tars's own notes, the bus's fences and JeanBrasse's relayed messages would then reach the receiver as a quotation.
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
| `kanban-tasks.json` | `KanbanTask[]` | kanban handlers | the old local board, which no page shows: its open tasks move to the Hermes board once at launch, parked, and it stays as the backup |
| `kanban-moved-to-hermes.json` | `{ [localId]: hermesId }` | `services/kanban-board.ts` | which local tasks moved; atomic |
| `bus.json` | `{ version: 1, savedAt, memberOverrides, threads[], messages[], deliveries[] }` | `services/bus-store.ts` | **Atomic**: the shared `writeAtomicSync`. Rooms are not stored: they are a view over the fleet, and the global room reads the overseer's own conversation rather than copying it |
| `vault.db` + `vault/` | SQLite (WAL, FK on) + `vault/attachments/` | better-sqlite3 | transactional |
| `usage-ledger.jsonl` | one `UsageEntry` per line | `recordUsage()` | append-only, self-trimming at 20 000 → 12 000 |
| `tmp/<short id>/t`, `tmp/<short id>/c` | each agent's temporary folder: `t` is the `TMPDIR` of its commands, `c` Claude Code's `CLAUDE_CODE_TMPDIR` (its scratchpad, its background tasks' output). The short id is ten hex characters of the sha256 of the agent's id, the same at every launch | `services/agent-tmp.ts`, set by `spawnAgentPty` for every terminal and by `delegateOverAcp` for every run; folders `0700`, a link found in their place removed, not followed | kept: a boot does not empty it as it empties `/private/tmp` and `/var/folders/.../T`. A retention pass a minute after launch and every hour deletes, whole, each entry of `t`, each Claude Code session folder of `c` and the folder of a deleted agent, once nothing in it changed for 7 days, then the oldest first past 20 GB in all (10 GB with under 30 GB free on the disk); never anything of an agent whose terminal or delegated run is alive, never through a link, nothing when `tmp` itself is a link. Each deletion is a line of `logs/agent-tmp.log` |
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
| `relay-sent.json` | what the relay sent: message id, ref, kind, project, time, 30 days | `services/hermes-relay.ts` | **Atomic**, mode `0600`. The list a reply is checked against |
| `relay-outbox.json` | sends Hermes has not taken yet, each until its time is up | `services/hermes-relay.ts` | **Atomic**, mode `0600` |
| `relay-state.json` | the last reply taken and the id of the plugin's store it was taken in, so none is handed over twice and a store made again, numbering from 1, is started over | `services/hermes-relay.ts` | **Atomic**, mode `0600` |
| `claude-accounts.json` | `ClaudeAccountsSettings`: the option (off by default), the Claude accounts in order, the 5 h and weekly thresholds | `electron/handlers/claude-accounts-handlers.ts` | **Atomic**, mode `0600`. Its own file, not a key of `app-settings.json`, whose save merges whatever a page sends. Holds ids and names, never a credential and never a folder: an account's folder is `~/.claude-accounts/<id>`, derived from its id. A file that does not parse reads as account 1 alone and is never written over: every change is refused, and Settings says why |
| `run-state.json` | `{ version, pid, startedAt, lastWriteAt, cleanExit, resumed, working[] }` | `services/run-state.ts` | **Atomic**, mode `0600`. Rewritten at each change of the fleet and every minute, closed at a quit (After an abrupt stop, below). Here, not in `~/.dorothy`, because it says which agents Tars starts at the next launch: an agent that could write it could have any agent started, in any project |
| `carry-over.json` | `{ version, savedAt, notes[], kanban[] }` | `services/carry-over.ts` | **Atomic**, mode `0600`. Written a moment after what is owed changes, read once at launch. Here because what it holds is typed into agents; a note read back is checked field by field, and a sender read back is never typed as one |

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
| `<project>/.worktrees/<branch>` | git worktrees |

### `AgentStatus`: what survives a restart

`persistable()` strips `ptyId` and `pathMissing`, truncates `output` to the last 100 chunks, and demotes `running` to `idle`. `loadAgents()` additionally clears `ptyCwd`, `currentSessionId`, `lastKilledSessionId` and `waitingReason`, marks `pathMissing` for vanished directories, and runs two migrations: `skipPermissions: boolean → permissionMode`, and, on a file below version 3, the role from the Orchestrator toggle or else from the name, once (see The orchestrator role, §4). Every load then leaves one orchestrator per project.

Live output is bounded at 600 chunks, spliced back to 400 (`OUTPUT_CHUNK_CAP` / `OUTPUT_RETAIN`): five PTY handlers pushed into `agent.output` and none of them capped it, so a chatty CLI grew that array for the life of the app, once per agent. What is spliced off is read for the terminal modes it left set (alternate screen, mouse protocol and encoding, bracketed paste, focus events, application cursor keys, hidden cursor), and those go back in as the first chunk (`electron/utils/terminal-modes.ts`). Claude Code in fullscreen sets most of them once, at start: without that chunk, a panel mounted after a long turn replayed onto the normal screen with no mouse request and no bracketed paste. The panels no longer replay these chunks: they are shown the terminal's mirror (§1), and the carry now serves a terminal with no mirror and the quick terminal's own buffer. What `output` feeds is text: the status line, log search, `get_agent_output`, the overseer and Telegram. So the 100 chunks written to disk are read back for those, and after a restart a panel shows the new terminal, not the old tail replayed onto it. Fields mutated on every PTY chunk (`output`, `statusLine`, `lastActivity`) set a dirty flag flushed every 30 s, bounding what a crash loses.

### After an abrupt stop

`agents.json` cannot say who was working: it saves `running` as `idle`. So each run keeps its own record, `run-state.json` (`services/run-state.ts`): opened at launch with `cleanExit: false`, rewritten a quarter of a second after each change of the fleet and once a minute, holding the agents that work (`running`, or `waiting` for anything but their next prompt: a permission, a question) with their session, their task's first 200 characters and when their turn began, and closed with `cleanExit: true` as the last step of a quit. A record still open at the next launch is a run that stopped abruptly: a crash, a kill, a power cut, a reboot that did not quit Tars. One that cannot be read, or none, is not.

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
| `/review` | Review | What the agents actually changed. Per-worktree column, with the projects added in Tars that no agent works in, changed-file list with add/delete counts, real patches cut at 4000 lines with a note, a file's read error said. Refresh rereads the list. Replaced a 20-line `git diff --stat` | `Review · dark`, `Review · light`, `Review · states` |
| `/logs` | Logs | One search box for the whole fleet, over each agent's output as its terminal shows it (the live mirror, else its kept output replayed headless), a Claude agent's transcript first, since a full-screen session keeps no history. Plain substring, or `/regex/` when delimited | `Logs · dark` |
| `/usage` | Usage | Cost and tokens over one timeframe chosen in the header (24 hours, 14 days, 12 weeks, 12 months): four tiles, the provider rows, and cost, token and message charts on the same bars. Budget rows stay month to date and rate windows live. See §6, On the page | `Usage · dark` (14 days) / `· light` (12 months) / `· daily messages` / `· last 24 hours` |
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

`scheduleTick()` coalesces to one `agents:tick` broadcast per 500 ms carrying the whole roster: id, name, character, raw status, `displayStatus`, status line, current task, project name, last activity, provider, whether a CLI runs in the terminal (`cliRunning`), whether that CLI left fullscreen without telling its terminal (`leftFullscreen`, §1), when the status began (`statusSince`), what a waiting agent waits on (`waitingOn`) and whether a launch is on its way (`launching`). `statusSince` is stamped by the fleet's map itself, which turns each agent's `status` into an accessor: a different status stamps the time, the same one does not, and none of the forty lines that write a status has to remember; `lastActivity` could not serve, every repaint moves it. `waitingOn` is `{ kind: 'permission' | 'question', text }` from the PermissionRequest hook, which now sends the tool and its input: the command, the file or the tool for a permission, the first question for AskUserQuestion, on one line with controls and direction overrides removed, 200 characters at most; it goes as soon as the status changes, and the idle prompt has none. `launching` is `sessionStarting` (§5): a tick goes out when a launch begins or is abandoned, and the window is looked at every second while one is open, for a launch that came up or timed out by itself. `displayStatus` derives `working | waiting | done | error` from status, and splits `idle` into `ready` (a PTY exists) or `stopped`. The tray badge lights when any agent is `waiting`.

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

`electron/preload.ts` (905 lines) exposes exactly one object, `window.electronAPI`, over `contextBridge`. It is a hand-written façade: no `ipcRenderer` passthrough, no dynamic channel names. 214 `ipcMain.handle` channels sit behind it, grouped `pty:`, `agent:`, `app:`, `settings:`, `fs:`, `project:`, `shell:`, `template:`, `teamTemplate:`, `kanban:`, `vault:`, `memory:`, `obsidian:`, `models:`, `usage:`, `review:`, `logs:`, `mcp:`, `skill:`, `plugin:`, `hermes:`, `gws:`, `tasmania:`, `telegram:`, `slack:`, `discord:`, `jira:`, `xapi:`, `socialdata:`, `orchestrator:`, `dialog:`, `cliPaths:`, `tray:`, `bus:`, `overseer:`, `claude:`, `claude-accounts:`, `ollama:`, `provider:`. Every event subscription returns its own unsubscribe closure.

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

### Event reports: `services/event-reports.ts`, `services/github-watch.ts`

To the user's Telegram, through the relay while it is on: an agent gone to error (from `handleStatusChangeNotification`, after the 5 s it waits to be sure of a status, including an agent's first change after Tars starts), a PR merged and changes requested on an open PR in the GitHub repositories of the agents' projects (`gh pr list --json`, read-only, every 5 minutes while the reports go out, `gh` and `git` found through `buildFullPath` since an app opened from the Dock has a bare PATH; a repository's first poll, or one after an hour without polling, is a baseline and reports nothing; a PR event goes under the project its repository was found in). Grouped over 2 minutes into one plain text message per project, so that a reply reaches that project's orchestrator, each name, title and error text kept to its own line and its secrets masked (masked before an error text is cut to 300 characters); 40 messages a (local) day, counted across restarts, the events past that counted and said in the next day's first message; each event once (an agent is reported again only after leaving error). With the relay off, nothing is sent or kept.

### Error reports: `services/error-reports/`

Off by default (`errorReportsEnabled` in `app-settings.json`, written by Settings through `app:saveSettings`). Off, `@sentry/electron` is not even loaded. Turned on, at start or while Tars runs (`main.ts` calls `errorReports.sync()` whenever the settings are replaced), it is loaded and started once for the run, with none of its default integrations: only uncaught exceptions, unhandled rejections and the causes linked to an error. No native crash dumps, screenshots, breadcrumbs, sessions, tracing, OpenTelemetry, logs, replay or offline queue. Turned off again, nothing leaves from that moment: the setting is read at each event (`beforeSend`) and again as each envelope is about to leave (the transport), and a report already on its way is dropped.

What a report carries is built field by field (`report.ts`), never scrubbed from the SDK's event: `event_id`, `timestamp`, `platform`, `level`, `release` (`tars@<version>`); up to 5 exceptions (the error and its causes), each with its `type`, its message (home folder as `~` wherever the name ends, in any case, behind `/private` and URL-encoded once or twice, the machine's name (`os.hostname()`, and its first label when it has 6 characters or more) as `<host>`, the user name alone as `<user>`, a macOS temp folder as `<tmp>`, secrets masked by `redactSecrets`, quoted text with a space and more than 24 characters replaced by its length, 1000 characters at most), its mechanism `{ type, handled }` and the 50 frames nearest the throw (`filename` with the same paths rewritten, `function`, `lineno`, `colno`, `in_app`); `tags.process` (`main` or `renderer`); `contexts.os` `{ name, version }`; `contexts.runtime` `{ name: Electron, version }`; `user.id`, a random id made on this machine. The transport sends error events only, rebuilt the same way, and drops every other item (sessions, attachments, replays, feedback, spans, logs, client reports): @sentry/electron hands some of a renderer's envelopes to it past `beforeSend`. The request carries the public DSN key in its URL, `User-Agent: sentry.javascript.electron/<v>` and `Accept-Language: en`; like any request, it reaches Sentry from the machine's IP address.

At most one report of the same error in 24 hours, and 20 in any 24 hours, per installation, across restarts (`~/.dorothy/error-reports.json`, `0600`, which holds the install id). The renderer's errors reach main through the preload's `__SENTRY_IPC__` bridge (the window is sandboxed and cannot load the SDK's own preload): only its start and its envelopes pass; its scope, feedback, logs, metrics and status go nowhere. Main takes the SDK's listeners on those channels behind a guard: an envelope that is not text or bytes, or is over 1,000,000 characters, never reaches the SDK, and what throws in its listener (a malformed envelope does, in the SDK's parser) is logged by name and dropped instead of becoming an uncaught exception in main. A development run may point reports at a stand-in with `DOROTHY_ERROR_REPORTS_DSN`; a packaged Tars ignores it.

### Residual risk

- Any process running as the user can read `~/.dorothy/api-token`, and every agent is such a process: its shell reads what the user can, a Claude agent has `~/.dorothy` in its `--add-dir`, and `venice` and `custom-openai` even put the token in its environment as `ANTHROPIC_API_KEY` for the OpenAI bridge. On that token a call has no agent identity, so the bus refuses it, and since 1.7.6 so do the routes that drive an agent: start, dispatch, run-task, stop, message, delete and create all need a caller with an identity of its own. It still **reads**: the listing, an agent's status, its output and its bootstrap are open to it, because `session-start.sh` fetches the bootstrap with it at the start of every session. A process holding the file can enumerate the fleet and read any agent's terminal, and no longer drive one.
- **An agent's own token is not secret from the other agents.** It lives in the environment of the agent's CLI and of its MCP servers, and `ps -Eww -p <pid>` prints the environment of those processes to any process of the same user. Only Apple's platform binaries, `/bin/zsh` among them, hide theirs, and neither `claude` nor `node` is one. An agent set on it can read a colleague's token and present it. Per-agent tokens end impersonation by naming, not impersonation by a process that reads the process table; only isolating agents from one another at the OS level would. A sandbox does not: measured under a deny-by-default `sandbox-exec` profile, a process still reads another's environment through `sysctl KERN_PROCARGS2`, and no rule in the profile language stopped it. `SECURITY.md` §3 has the four parades that were weighed and why none was written.
- The super chat conversation is stored in clear, and since 1.7.6 outside the directory the agents are handed: `~/.tars-private/overseer.json`, mode `0600`, migrated from `~/.dorothy/overseer.json` at startup. That takes it off the listing an agent gets for free and out of the reach of anything walking `~/.dorothy`; an agent that goes looking for the new path still reads it, because it runs as the user. Keeping the global room closed on the API protects the API path, not the file. The Telegram send routes, the Telegram MCP server and the vault's attach route refuse the private directory, which stops a one-call send or copy, not an agent with a shell.
- The Hermes webhook secret opens a route that dispatches to any agent of any project, by id or by name. It lives beside the conversation, in `~/.tars-private`, and is exactly as reachable: out of the directory an agent is handed, not out of the reach of an agent that goes looking. It was in `~/.dorothy` until 1.7.6 and moves with its value unchanged, so an agent that read it before still has it until it is rotated.
- `permissionMode: 'auto'` is the default for agents created over the API and maps to `--permission-mode auto` (only `bypass` emits `--dangerously-skip-permissions`), and `ensureProjectTrusted()` pre-accepts the workspace-trust dialog. An agent has the user's full filesystem authority inside its cwd and beyond.
- API keys for the ten alt providers are stored in plaintext in `app-settings.json` and passed to the CLI as `ANTHROPIC_API_KEY` in the PTY environment.

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
| Updates | `electron-updater` against `JeanBrasse/Tars` releases |
| Electron | 44.4 (Node 24.21, ABI 149, Chromium 152). Its `LSMinimumSystemVersion` is 13.0, so the app needs macOS 13 or later |
| Node | ≥22.12, Electron's own floor; `.nvmrc` pins 22 |

Tests: `vitest run` over `__tests__/**/*.test.ts` (node environment, `@` aliased to `src/`), with coverage scoped to `electron/{constants,utils,services,handlers,providers}` and the MCP server sources. Suites exist for the ACP client, the model catalogue, transcript usage, the memory hub, agent persistence, the PTY manager, four providers, delegation plumbing, and two dedicated security files.

E2E: Playwright, `testDir: ./e2e`, one worker, serial: one Electron instance drives every surface. Screenshots at `e2e/__screenshots__/`. `npm run e2e:guard` checks a hardcoded list of ten routes (`/`, `/agents`, `/kanban`, `/vault`, `/projects`, `/skills`, `/usage`, `/memory`, `/settings`, `/whats-new`) against the E2E manifest; `/crons`, `/review`, `/logs` and `/tray-panel` are not checked, and `design/UI-INVENTORY.md` is read only to count overlay entries.

---

## §13 Known limitations

- **Delivery over the PTY is confirmed for a spawn, and reported for a bus message.** A spawn carries its task until a turn actually starts: if none has begun fifteen seconds after the session registers, `armTaskStartWatch` types the task into the live session once, and marks the agent failed if that does not start one either. A bus message is confirmed the other way, by a delivery row that says queued, delivered, dropped or not sent, with a reason code. Everything else is fire-and-forget: `/dispatch` into a session that is already running returns when the bytes are written, and only `/run-task` returns a receipt.
- **The bus leaves two things out, on purpose, and interrupts only on a person's say.** Nothing writes into a turn Tars knows is running, except `bus:sendNow`, the composer's send now (JeanBrasse's choice, 2026-09-23): only for a member on the claude binary (`BusMember.canInterrupt`), it sends Esc and types the message once the transcript records `[Request interrupted by user` (Claude Code sends no Stop hook for an interrupt), 5 s at most, else the message queues for the turn's end. There is no heartbeat. And there is no ACP steering: a delegated run is cancelled only when its agent is stopped or deleted (the window, the API, Telegram, Slack, the kanban automation), by `stopAcpRuns` (acp/delegate.ts), which asks the run to cancel, gives it 1.5 s to end its turn, then ends every process group found among its processes' descendants (`ps -A -o pid=,ppid=,pgid=,stat=,etime=`, read before the first signal and again before the last; a known pid younger than the time since the first read, with a parent outside the run, is another process that took the id and is left out, and a zombie counts as gone), SIGTERM then SIGKILL two seconds on: Claude Code's Bash tool runs each command in a group of its own, and the run's own group alone left those commands alive when claude could not pass the stop on. Quitting Tars ends every delegated run before the app exits (`endAcpRunsOnQuit`, a before-quit step): each is asked to cancel, best effort, then the same process groups get SIGTERM, a wait of at most a second that ends as soon as none is left, and SIGKILL, all while the quit waits, since no timer outlives the app. Every read of ps in a quit shares one deadline, 1.5 s from its start: a ps that hangs held the quit 6.5 s with a 2 s timeout per read. Measured on 2026-09-24 with claude-agent-acp 0.81.1: a run that still answered, one whose adapter was SIGSTOPped and one whose claude was, all gone with Tars about 1.4 s after `app.quit()`. Before this, a run whose claude was SIGSTOPped was whole 14.7 s after the quit, reparented to launchd. The run's caller is answered "the run was stopped: the agent was stopped". Before this (the Audit's table, #6), a stopped agent's run went on working for up to its hour. None of these is inferred from silence: idleness detection is deliberately absent.
- **A message behind somebody's draft reads `held`.** The terminal has taken it and Tars never types across a draft, so it waits for that person to send or clear the field: `held` with `reasonCode: 'draft'` and `heldAt`, `delivered` when it goes in, `dropped` if the terminal exits first. Stop does not drop a `held` message: its terminal already holds it and will type it. `listRooms` counts what waits in each room (`pending`), and a change of members carries who came and went as data (`systemData`).
- **A message to a CLI with no end of turn is held, not lost.** amp, codex, grok, opencode and pi never leave `running` in an interactive session, so nothing is queued for them and the delivery reads NOT SENT with its reason and the time it was refused. `bus:releaseNotSent(agentId)` is the way out, and only a human calls it: it writes what is held into that terminal, oldest first, and the messages become `delivered`. Tars still refuses to do this by itself, because it cannot know the state of that session. Two deliberate exceptions live here: the session barrier does not apply, so an agent killed and relaunched between the button being drawn and the click receives them in its new session, because a person is aiming at the agent and not at a session id; and one release runs at a time per agent, a second refused with its reason rather than queued, because two would interleave their writes into one terminal.
- **Status lifecycle depends on hooks, which four providers do not have.** `codex`, `grok`, `opencode` and `pi` only ever transition on PTY exit. `wait_for_agent` and `lastCleanOutput` are effectively unavailable for them on the terminal path.
- **A changed model or effort restarts only the CLIs on the claude binary.** codex, gemini, grok, opencode, pi and amp report no end of turn, so they take new settings at their next launch.
- **The `/run-task` status event name does not match what `/wait` listens on.** `emit('status', …)` vs `` `status:${agentId}` ``.
- **`pi` has no ACP fallback entry.** If the ACP registry has never been reachable, `pi` has no ACP mode at all.
- **Some of Tars's own files are still written in place.** `templates.json` (after a backup copy), `team-templates.json` and `cli-paths.json`, and the caches and generated files. `agents.json`, `app-settings.json`, `hermes-connection.json`, `projects.json` and `kanban-tasks.json` are written to a temp file and renamed over. Claude's own files, `~/.claude.json`, `~/.claude/settings.json` and `~/.claude/mcp.json`, go through `updateSharedJsonSync`, which also keeps their mode and never writes over a file that is not JSON: `claude-files-writers.test.ts` fails if anything in the main process or the MCP servers writes them another way.
- **`agent.output` retains 600 chunks live and 100 on disk.** `/logs` searches only what is retained; there is no persistent log store.
- **A panel's history reaches back 1000 lines.** That is what a terminal's mirror keeps above the screen, where a panel that never unmounted keeps 10000. And a cursor parked past the last column (xterm waiting to wrap) comes back on the last column, since no cursor move reaches past it: 2 chunks in 4269 across twelve recordings of Claude Code, the content identical.
- **The left-fullscreen flag is only watched for the `claude` binary.** Its signature was measured on Claude Code's two renderers; another fullscreen CLI that climbs its frame with `CSI A` in every chunk would be taken for inline, so none is watched. Tars reports the state and sends the program nothing: what a panel does about the wheel is the renderer's decision.
- **The API token is a single flat credential.** No per-agent scoping, no rotation UI.
- **The webhook is the only surface designed to leave the machine**, and it needs an operator-provided tunnel; nothing in the app opens one.
- **`installBundledSkills()` currently ships nothing.** Its only remaining job is deleting stale `world-builder` copies left by older versions, and only when the file content is recognizably ours.
- **macOS 13 or later only.** Electron 44 declares 13.0 as its minimum, so a Mac on 12 cannot open the app, nor the update to it. `electron-builder` targets `--mac`, and the code stays Linux compatible (JeanBrasse, 2026-09-24): the CI runs the tests on ubuntu, and a macOS-only path has a Linux branch or fails cleanly. Opening a project in a terminal (`shell:open-terminal`) uses Terminal.app on macOS and on Linux the first of `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm` that is installed, started in the directory with no shell (`utils/open-terminal.ts`); elsewhere it says it cannot. A terminal Tars opens with `SHELL` unset runs `/bin/zsh` on macOS and `/bin/bash` elsewhere (`defaultShell`, `utils/default-shell.ts`); agent terminals run `/bin/bash` everywhere. The status line reads a file's age with BSD's `stat -f%m`, then GNU's `stat -c%Y`. A notification sound goes through `afplay` on macOS, `paplay` then `aplay` on Linux.
- **The code stays Linux compatible** (JeanBrasse, 2026-09-24). Only the packaging is macOS: the CI runs the tests on ubuntu, and a macOS-only code path has a Linux one or fails cleanly.
- **An Amp update leaves `amp` missing for a few seconds.** npm removes the old package before the new one is unpacked: measured, 3.3 to 9.3 s with the tarballs already downloaded, which Tars makes sure of first, then under a second on a placeholder that prints "Amp native binary not installed". Tars waits for every running `amp` to end before it starts, but nothing holds a launch back during those seconds, and one that falls in them fails. A claude update has no such window.
- **A claude session that outlives two newer releases can lose its binary file.** The native installer's cleanup keeps the two newest versions and any version whose lock is held, and only the first session on a version holds that lock. Measured: once that session had exited, the cleanup deleted the file under a second session on the same version, and that session's next turn still answered, but its Grep and Glob tools do not: native claude runs its embedded ripgrep by starting its own file again, as `rg`. With no `rg` on PATH every later search fails (`posix_spawn 'rg'`, ENOENT); with Homebrew's on PATH, as in a Tars terminal on JeanBrasse's machine, the first search fails with a misleading "ripgrep not found on PATH" and the next ones go through the system `rg`. A `claude` started from inside it fails too. A restart ends it. `USE_BUILTIN_RIPGREP=0`, with `rg` on PATH, kept Grep and Glob working when QA measured it, and is for a later change. The cleanup is claude's own: every session's housekeeping runs it, not only an update.
- **Agents started before a claude update finishes stay on the version they started with** until they are restarted. The pass runs 5 s after launch and takes about 10 s, while the agents set to start with the app may already be starting.
