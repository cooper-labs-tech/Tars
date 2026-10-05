## Project Context

- **App**: Tars, an Electron desktop app that runs many AI coding-agent CLIs in parallel, each in its own PTY terminal, and orchestrates them
- **Goal**: one window where a fleet of agents (Claude Code, Codex, Gemini, Grok, OpenCode, Pi, and thirteen API-key providers) work on your projects at once, are delegated to, report back, and are billed
- **Repo**: https://github.com/JeanBrasse/Tars, a fork of `Charlie85270/Dorothy`, renamed to Tars. Nothing is ever pushed upstream; `git remote get-url --push upstream` returns `DISABLED-no-push`
- **Bundle**: `xyz.cooperlabs.tars`, product name `Tars`, macOS only (`electron-builder --mac`, dmg + zip). Updates are published to and fetched from the fork: `GITHUB_REPO` in `electron/constants/index.ts` and `build.publish` in `package.json` both say `JeanBrasse/Tars`. The code stays Linux compatible (JeanBrasse, 2026-09-24): the CI runs the tests on ubuntu, and no macOS-only code path ships without a Linux one or a clean failure.
- **Docs**: all four exist and are current. `DESIGN.md` (tokens + components) before touching a pixel, `SPECS.md` (what it is), `OPERATIONS.md` (runbook), `ETHOS.md` (how decisions get made). This line used to say only DESIGN.md had been written; the other three were added on 2026-08-23 and the README links to all of them. A fifth, `SECURITY.md`, was added on 2026-09-18: what is a boundary, what only looks like one, and the measurements behind each

## Stack

- **Shell**: Electron 44 (Node 24.21, Chromium 152, macOS 13 or later), main process in `electron/` (~47k lines TypeScript, compiled to `electron/dist/` by `tsc -p electron/tsconfig.json`, CommonJS, ES2022)
- **Renderer**: Next.js 16.3 App Router, React 19, TypeScript, Tailwind CSS 4, `~44k` lines in `src/`. Packaged as a static export (`output: 'export'` when `ELECTRON_BUILD=1`) and served over a custom `app://` protocol
- **Terminals**: `node-pty` + `xterm` 5 / `xterm-addon-fit`
- **State**: React hooks over IPC (`src/hooks/`), plus a small `zustand` store (`src/store/`) for sidebar/vault UI state
- **Local API**: a plain `node:http` server on **31415**, bearer-token authenticated, so the CLIs' hooks and the bundled MCP servers can call back into the app
- **MCP**: seven servers in `mcp-*/`, each bundled to `dist/bundle.js` and shipped in `extraResources`: orchestrator, memory, telegram, kanban, vault, socialdata, x
- **Delegation**: two transports: keystrokes written into the PTY (`/dispatch`), and the Agent Client Protocol (`electron/services/acp/`), which actually returns a result
- **Storage**: JSON + SQLite under `~/.dorothy/` (`better-sqlite3` for the vault). No server, no cloud, no database migrations. One exception: `~/.tars-private/` holds what the agents are not handed, which today is JeanBrasse's conversation with the super chat, the Hermes webhook secret and the Claude accounts' registry (`claude-accounts.json`: ids, names, thresholds, never a credential). `~/.dorothy` is in every agent's `--add-dir`; nothing under `~/.tars-private` is ever passed to a CLI. Each Claude account after the first is a Claude Code folder of its own, `~/.claude-accounts/<id>`, which the agents started on it run in
- **Tests**: E2E first: `@playwright/test` drives the real Electron app (`e2e/`), and every run leaves an artefact. `vitest` (`__tests__/`) is the regression net and the home of units tested in isolation, written failures first. The rules are in Workflow Rule 3
- **Node**: 22, pinned in `.nvmrc`. Run `nvm use` first. `package.json` `engines` declares `>=22.12.0`, Electron's own floor since 43, and CI runs 22

## Key Files

| Path | What lives there |
|---|---|
| `electron/main.ts` | Entry point. Wires window, agent state, IPC, Telegram/Slack bots, the HTTP API, the tray, the MCP orchestrator, and the model catalogue |
| `electron/preload.ts` | The only bridge to the renderer: `contextBridge.exposeInMainWorld('electronAPI', …)`. Every new IPC channel is declared here first |
| `electron/constants/index.ts` | `DATA_DIR` = `~/.dorothy`, `PRIVATE_DIR` = `~/.tars-private` (what agents are not handed), `API_PORT` = 31415, the file paths for agents/settings/kanban/vault/token, `GITHUB_REPO`, the MIME map used by the `app://` handler |
| `electron/types/index.ts` | `AgentStatus`, `AppSettings`, `CLIPaths`, `AgentProvider`, `AgentPermissionMode`, `AgentEffort`. A new setting or provider starts here |
| `electron/core/agent-manager.ts` | The agent `Map`, persistence to `agents.json`, `initAgentPty`, `ensureProjectTrusted` (pre-writes `hasTrustDialogAccepted` in `~/.claude.json`), `killStalePty` |
| `electron/core/pty-manager.ts` | Four PTY maps (agent / quick / skill / plugin), `killAllPty`, and `writeProgrammaticInput`: the bracket-paste + delayed `\r` dance Claude Code's TUI requires |
| `electron/core/window-manager.ts` | `BrowserWindow` (1600×1000, `hiddenInset`, `#121212`), window hardening, and the `app://` and `local-file://` protocol handlers |
| `electron/handlers/ipc-handlers.ts` | 3007 lines, nearly every `ipcMain.handle`. Start here when a renderer call has no backend |
| `electron/providers/cli-provider.ts` | The `CLIProvider` contract: interactive / scheduled / one-shot command builders, PTY env, hook config, `readAppSettingsFromDisk()` |
| `electron/providers/index.ts` | Registry of the 19 providers. Unknown ids (and `local`) fall back to Claude |
| `electron/services/api-server.ts` | The 31415 server. Token generated into `~/.dorothy/api-token` at `0600`; 4 MB body cap; only `/api/local-file` and `/api/health` are exempt from auth; `/api/hooks/*` takes the posting agent's own token, for that agent only. `resolveCaller` decides who is calling from the token presented: an agent's own token (`electron/core/agent-tokens.ts`) names that agent, and a different `X-Tars-Caller-Id` alongside it is a 403. The shared token names no agent, no header is read with it, and it drives no agent: the routes that start, stop, message, dispatch to, delete or create one need a caller with an identity. Tars's own pass, minted in memory and written nowhere, is what the super chat presents on the loopback; the Hermes webhook secret (`~/.tars-private/hermes-webhook-secret`) opens its own route and no other, and that route opens to nothing else. `SECURITY.md` says what each of these is and is not |
| `electron/services/api-routes/agent-routes.ts` | `spawnAgentSession()`, the **single** path for API-driven sessions, plus `/start`, `/dispatch`, `/message`, `/delegate`, `/bootstrap`, `/health`, and the cross-project guard |
| `electron/services/api-routes/hooks-routes.ts` | The session-ownership contract: SessionStart registers via the `source` field; posts from any other session, or from the `lastKilledSessionId` tombstone, are rejected as `stale` |
| `electron/services/acp/` | `client.ts`, `delegate.ts`, `registry.ts`. Delegation that returns: stop reason, tools used, tokens, cost |
| `electron/services/mcp-orchestrator.ts` | Resolves the seven bundled servers under `process.resourcesPath` and writes them into each CLI's MCP config |
| `electron/services/model-catalog.ts` | Live model list and per-million-token prices from models.dev, cached at `~/.dorothy/model-catalog.json`, with a compiled-in floor. Never let a network failure zero a price |
| `electron/services/usage-ledger.ts`, `transcript-usage.ts` | The two token sources: ACP turns recorded as they happen (covers every CLI), and `~/.claude/projects/**/*.jsonl` reconstructed after the fact (Claude only) |
| `electron/services/memory-hub.ts` | The Brain page's backends (Hermes, gbrain, Honcho) over MCP HTTP |
| `electron/services/git-review.ts` | The Review page. Every git call goes through `execFile` with an argv array, never a shell |
| `electron/utils/worktree-path.ts` | Where an agent's worktree is allowed to live. The traversal guard: read the comment before relaxing anything |
| `src/types/electron.d.ts` | Renderer-side mirror of the preload surface. Must be updated in the same commit as `preload.ts` |
| `src/app/globals.css` | The entire token system (`--bg-*`, `--text-*`, `--accent-*`, `--success/warning/danger/info`, `--chart-*`) for light and `.dark` |
| `src/components/ui/index.ts` | `Button`, `Label/Input/Select/Textarea`, `Dropdown`, `StatusBadge`, `Loading`, `PageHeader`. The only directory allowed to define raw appearance |
| `src/components/ClientLayout.tsx` | The shell: sidebar + header, and the theme boot (`tars-theme` in `localStorage`, dark unless explicitly `light`) |
| `src/components/TerminalsView/` | The xterm grid that is the Dashboard, including the scroll-lock and multi-terminal hooks |
| `src/lib/providers.ts` | Frontend provider registry: icon, badge, models, default model. One entry per provider; NewChatModal and Settings both read it |
| `design/tars-redesign.pen` | Pencil source of truth, 117 root frames. Written by the `pen` CLI as plain JSON: draw through the CLI (Workflow Rule 1), never the `pencil` MCP tools |
| `design/chat-design.pen` | 72 of the same frames (71 with the same ids; `Agent error · reason` was drawn into both after the fork, so its ids differ), the two panel history frames `tars-redesign.pen` dropped with the history view, plus the 11 frames of the Chat room, which exist nowhere else: 85 in all. A fork, not a companion. Its room frames describe the Chat before its redesign: draw anything for the Chat in `chat-redesign-a.pen`, and anything else in `tars-redesign.pen` |
| `design/chat-redesign-a.pen` | The Chat page's redesign, direction A (chosen by JeanBrasse on 2026-09-17), with its composer: the room and Hermes pages in every state a user can meet, and sheets for the team, the thread, Hermes, the composer and the room head, dark and light. What the Chat implements since #165 (merged 2026-09-24) |
| `design/landing.pen` | The site in `landing/`: its page, its 404, its privacy and terms pages, and the picture link previews show. Forked from `tars-redesign.pen` on 2026-09-23, which no longer carries the landing |
| `design/UI-INVENTORY.md` | Every surface the app can render. The E2E guard reads it. Its header names both Pencil documents and says which one owns what |
| `e2e/surfaces.mjs` | Executable manifest: 18 pages, 18 settings sections, 3 overlays = 39 surfaces |
| `scripts/design-lint.sh` | The design guardrail. Bans inline `borderRadius`, `shadow-*`, `bg-gradient`, `animate-ping`, the raw Tailwind palette and hardcoded hex colours outside `src/components/ui/`, in the `.ts`, `.tsx` and `.css` files under `src/`. A grep that could not search fails it |
| `scripts/sandbox.sh` | A second Tars beside your real one: `HOME=~/Tars-sandbox`, API port 31499 |
| `hooks/` | Shell hooks installed into the CLIs. `session-start.sh` registers the session and injects `/bootstrap` + memory context; `user-prompt-submit.sh`, `on-stop.sh` and `stop-failure.sh` own the status lifecycle |

## Environment Variables

There is no `.env` file and there never will be one. Every secret (bot tokens, provider API keys, Hermes tokens) lives in `~/.dorothy/app-settings.json`, written by the Settings pages and read by `readAppSettingsFromDisk()`. Do not add a dotenv loader.

The variables the code actually reads:

```
NODE_ENV              # 'development' → load DOROTHY_DEV_URL + open DevTools; otherwise app://-/index.html
DOROTHY_DEV_URL       # override the dev renderer URL (default http://localhost:3000; e2e uses :3100)
DOROTHY_API_PORT      # override the local API port (default 31415; sandbox 31499, e2e 31498)
DOROTHY_E2E           # '1' suppresses DevTools so screenshots are clean
ELECTRON_BUILD        # '1' switches next.config.ts to output: 'export' for packaging
PATH SHELL HOME       # read when composing the PTY environment (buildFullPath, cli-paths detection)
APPLE_ID              # notarization; unset → scripts/notarize.js uses the 'Tars' keychain profile
APPLE_APP_PASSWORD
APPLE_TEAM_ID
```

Injected by Tars **into** the processes it spawns, never set them yourself:

```
CLAUDE_AGENT_ID       # PTY + MCP child env; the MCP client sends it as X-Tars-Caller-Id, a claim the server checks against the token
CLAUDE_AGENT_NAME     # used by mcp-vault as the document author
CLAUDE_PROJECT_PATH   # sent as X-Tars-Caller-Project, which scopes nothing: the project is the token's agent's, from the fleet
CLAUDE_SKILLS         # comma-separated skill list for the session
CLAUDE_MGR_API_URL    # read by mcp-orchestrator; defaults to http://127.0.0.1:31415
CLAUDE_MGR_API_TOKEN  # minted per terminal by spawnAgentPty and per ACP run by delegateOverAcp, in memory only; mcp-orchestrator, mcp-memory and mcp-vault present it instead of ~/.dorothy/api-token
ANTHROPIC_BASE_URL    # every alt provider runs the claude binary with these two rewritten
ANTHROPIC_API_KEY     # from app-settings.json, per provider
ANTHROPIC_MODEL
CLAUDE_CONFIG_DIR     # with several Claude accounts on (Settings), the folder of the account an agent's CLI and its ACP runs start on, and of the account Settings signs in, checks or signs out (`claude auth login`, `auth status`, `auth logout`); removed for account 1 (~/.claude). Never set otherwise
TARS_CLAUDE_ACCOUNT   # the same account's id ('default' for account 1), read by the status line to file that account's 5 h and weekly counters
TMPDIR                # ~/.dorothy/tmp/<short id>/t, the agent's own temporary folder, which a boot does not empty (services/agent-tmp.ts)
CLAUDE_CODE_TMPDIR    # ~/.dorothy/tmp/<short id>/c, where Claude Code keeps the agent's scratchpad and background task output
```

---

## Agent Roles & Boundaries

Four roles work this tree. They map to the long-lived branches `feat/frontend`, `feat/backend`, `feat/qa`. Never modify files outside your domain. If you need a change on the other side of the IPC boundary, say so and let the other agent make it.

### Frontend Agent
- **Owns**: `src/app/`, `src/components/`, `src/hooks/`, `src/lib/`, `src/store/`, `landing/`
- **Never touches**: `electron/`, `mcp-*/`, `hooks/`, `__tests__/`, `e2e/`
- **Design rule**: the frames in `design/tars-redesign.pen`, plus `design/chat-redesign-a.pen` for the Chat and `design/landing.pen` for the landing site, and the tokens in `DESIGN.md` are the specification. Never invent a layout, a colour, or a control height. Controls are **26px** (small) or **32px** (standard), nothing else. The shell is identical on every page: sidebar 240 wide (72 collapsed), header 84 tall with padding `22/26/14/26`, content `0/26/22/26`
- **Never** mark an active state with an accent rule: no 2px orange line under a tab, beside a menu item, or under a button. Active is a **box**: tinted fill, or surface plus border
- **Never** hardcode a hex or a raw Tailwind palette class outside `src/components/ui/`. `npm run lint:design` will catch you
- The mark is the orange square grid (`public/icon.svg`, `src/components/Splash.tsx`), never a `>_` terminal prompt
- Adding an IPC-backed feature: you may *consume* `window.electronAPI`, but the channel and its type in `src/types/electron.d.ts` come from the Backend Agent

### Backend Agent
- **Owns**: `electron/`, `mcp-*/`, `hooks/`, `scripts/`
- **Never touches**: `src/components/`, `src/app/`, `design/`
- **Owns the contract**: `electron/preload.ts` and `src/types/electron.d.ts` change together, in one commit, or the renderer breaks silently
- **Spawn rule**: `spawnAgentSession()` in `electron/services/api-routes/agent-routes.ts` is the only place an API-driven session is started: the skills prefix, MCP config, model flag, `--disallowed-tools`, workspace trust, identity header and `--add-dir ~/.dorothy` all live there. Underneath it, `initAgentPty()` in `electron/core/agent-manager.ts` is the one function that spawns a PTY; `main.ts`, `ipc-handlers.ts` and the Telegram/Slack bots already call it directly. Route new work through one of those two. Do not add a third way in
- **Session rule**: status, output and task-completed posts are authoritative only from `agent.currentSessionId`. Anything from another session, or matching `lastKilledSessionId`, is `stale` and must be dropped. Never clear `currentSessionId` on idle
- **Shell rule**: no `exec`/`execSync` with an interpolated string. `execFile` with an argv array, as in `git-review.ts`. Paths derived from user input go through the guards in `electron/utils/worktree-path.ts`
- **Auth rule**: exactly two routes are exempt from the bearer token: `/api/local-file` and `/api/health`. Anything you add under `/api/` is authenticated. `/api/hooks/*` was exempt until 2026-09-23 and now takes the agent's own token (`CLAUDE_MGR_API_TOKEN`, which the hooks inherit from the CLI they run in), for the `agent_id` it names and no other: the shared token is refused there, and so is a delegated ACP run's token (`isTerminalToken`), and a terminal's token dies with its terminal. It was four until `/api/kanban/complete` was removed: unauthenticated, uncalled, and it deleted agents

### QA Agent
- **Owns**: `__tests__/`, `e2e/`, `vitest.config.mts`, `playwright.config.ts`
- **Read-only** everywhere else: report defects, do not patch them
- **Done when**: both `tsc` passes are clean, `npm test` is green, `npm run lint` and `npm run lint:design` are clean, `npm run e2e:auto` shows no new visual diff and no page error, and a feature's own E2E spec passes and leaves its artefact (Workflow Rule 3)
- **Refused at the gate**: a unit test written after the code it tests, a test that restates a constant, a test that only checks a mock was called, and a spec nobody has seen turn red on the old build or a mutant
- `npm run e2e:auto` decides from the diff whether the surfaces can have moved, and runs the full suite whenever they can. It skips only when every changed file is outside the running app (`__tests__/`, `mcp-*/`, `hooks/`, `scripts/`, root markdown), and says so at length when it does. Anything it cannot classify runs. `electron/` always runs: the suite boots the real app against a seeded home, so a main process change can and does move a screenshot
- Reach for `npm run e2e` directly to force the full suite, and `npm run e2e:guard` when a surface was added
- A visual diff is a finding, not a licence to re-record. `npm run e2e:update` is only run when the design was deliberately changed and the Pencil frame already reflects it

### Orchestrator
- **Writes no product code.** Splits work by domain, dispatches, merges, reports
- Delegates through the project's own agents rather than doing the work inline; only trivial one-line fixes and pure merge/report work are done directly
- Runs QA after every implementation step and before every merge
- Owns the branch and PR lifecycle described below

---

## Workflow Rules

### 1. Pencil first, always

> **Mandatory again as of 2026-08-24.** Pencil was suspended for a day while its
> MCP access sat on another project. JeanBrasse has handed it back and made it a
> requirement: "tu peux maintenant ré-utiliser Pencil à ta guise, et c'est
> obligatoire de le faire pour toute modification de design, donc tu le notes
> bien." Draw the frame before writing the TSX, every time.
>
> This paragraph has been reverted once by a verifying agent that read the
> reversal as an unexplained directive flip. It is not: it is JeanBrasse's instruction,
> quoted above. Do not restore the "Suspended" wording.

Every design or feature change goes through, in this order:

1. **The Pencil document**: the frame exists and is correct before any TSX is written. `design/tars-redesign.pen`, except for the Chat, whose frames (direction A and its composer) live in `design/chat-redesign-a.pen`, and the landing site, drawn in `design/landing.pen`; `design/chat-design.pen` keeps the room as it was before. Looking for them in the wrong file and finding nothing is how three passes of design nearly went unnoticed
2. **The app**: `src/` implements the frame, not an approximation of it
3. **The landing page**: `landing/` picks up the change
4. **`README.md`**: last

Never the other way round. Do not "build it then draw it". If a surface is new, add it to `design/UI-INVENTORY.md` and to `e2e/surfaces.mjs` in the same change, or `npm run e2e:guard` fails.

**And every user-visible change carries five more edits with it**, in the same PR. JeanBrasse asks for these every time they are missed:

| What | Where | When |
|---|---|---|
| Changelog entry + version bump | `src/data/changelog.ts`, `package.json` | Every change a user would notice. **Once a version has been released, it is frozen** - bump the patch (1.5.0 → 1.5.1 → 1.5.2) and add a new entry rather than editing the shipped one. Only extend the top entry while `gh release list` shows it has never been cut |
| Download link | `landing/src/app/api/download/route.ts` | It resolves the latest GitHub release at request time, so it needs **no edit**, but a new version is only downloadable once it has actually been published, and publishing goes through `npm run release`, never `gh release create` by hand. Check `gh release list --repo JeanBrasse/Tars` before claiming a version is available |
| The docs that are now wrong | `README.md`, `SPECS.md`, `OPERATIONS.md`, `DESIGN.md` | Whichever ones the change falsified. A version number in the Tech Stack table, a file path in the structure tree, a limitation in §13 that is no longer true |
| No em dashes | everywhere | `—` and `–` never appear in anything a user reads: interface copy, the changelog, the agent prompts Tars writes, the landing page, or the repo's own documents. JeanBrasse has asked for this twice. Rewrite the sentence rather than swapping in ` - ` every time. The one exception is the `next dev` block at the tail of this file, which is regenerated on every run |
| Screenshots | `screenshots/` | If a surface changed. They come from `npx playwright test --update-snapshots`, which photographs the real app against a seeded sandbox, never hand-made or reused from an older UI |

**Draw through the `pen` CLI, not the `pencil` MCP tools.** Measured on 2026-09-11: the
MCP server is launched `--app desktop`, so it is bound to whatever document the Pen window
happens to have open, and its `filePath` argument is accepted and then ignored. Passing
`design/tars-redesign.pen` to it returned the 27 frames of an unrelated document that was
open at the time. It is now a *required* parameter, so it looks honoured when it is not: a
mutation sent that way writes your frames into somebody else's file.

The CLI binds a session to a file instead, and saves without a human:

```bash
nvm use 22                       # the CLI needs >=22.19; under Node 18 it dumps its own
                                 # minified source instead of failing cleanly
pen interactive --in design/tars-redesign.pen --out design/tars-redesign.pen
pen > execute({ input: 'Get((n,c)=>{c.skipChildren();Print(n.id,n.name)})' })
pen > save()
pen > exit()
```

Verified: that session reads the 72 Tars frames while the desktop app sits on another
document, and `save()` writes the `.pen` to disk unattended. Installed with
`npm install -g @pen.dev/cli` (`@pencil.dev/cli` is deprecated), authenticated per user in
`~/.pencil/session-cli.json`, separate from the desktop app's session.

Pencil traps that will cost you an afternoon:
- `save()` is explicit. An agent that forgets it loses the whole session's work with no error
- The headless session is a **separate engine** from the desktop app. Never edit the same
  `.pen` in both at once: the last one to save wins and the other's work is gone
- Insert the whole tree in **one** `Insert` with nested `children`. Parent-then-child inserts read back fine and export black
- Text needs `textGrowth: "fixed-width"` with a width; `width` alone wraps nothing
- Helpers do not persist between `execute` calls. Re-inject the prelude every time
- `stroke`/`strokeWidth` cannot be nulled: use `strokeWidth: 0`

### 2. Delivery

- Work on a feature branch. Never commit to `main` directly
- Deliver as a **PR into `JeanBrasse/Tars` `main`**, then merge it
- **Never push to `Charlie85270/Dorothy`.** Its push URL is deliberately set to `DISABLED-no-push`. If a command would push there, stop. You have the wrong remote
- Commit subjects say what changed for the user, in lowercase, prefixed `feat:` / `fix:` / `chore:` / `perf:` / `security:` / `test:` / `design:`
- `.worktrees/` and `.claude/worktrees/` are embedded checkouts of other branches. They are gitignored and eslint-ignored. Never edit a file inside them and never commit one

### 3. Verify before done

> **The testing rules, JeanBrasse's instruction of 2026-09-23.** "Ajuste le CLAUDE.md et les .md
> pertinents avec ca: https://x.com/anshnanda/status/2101627891721371971". The post opens an
> AGENTS.md with three lines: never write unit tests after the code; prefer E2E tests as the
> sole testing mechanism, each ending on a verifiable and repeatable artefact; to test a system
> in isolation, first write all the ways it could fail, then write the code. What that means in
> this repo is below. It is JeanBrasse's rule, not an agent's preference: do not revert it.

1. **E2E first.** A feature is proven by an E2E spec that drives the real app: Playwright and `launchSandboxed` from `e2e/fixture.mjs`, real claude or the recording fake CLI through the agent's `cliPath`, a sandbox `HOME`, `--user-data-dir` and `CFFIXED_USER_HOME` (the fixture sets the last two)
2. **Every E2E run leaves an artefact** another agent can re-run and compare: the app's own trace (`E2E_TRACE=on`), the screenshots and a JSON of the values asserted, in one run directory, with the one command that reproduces it. OPERATIONS.md, "Tests and guardrails", says how
3. **A unit tested in isolation is written failures first.** A parser, `electron/core/input-draft.ts`, `src/lib/usage-window.ts`, the worktree path guard: the PR first writes down every way the unit can fail, in the test file's header, then the tests, then the code. No unit test is written after the code it tests
4. **The vitest suite stays the regression net.** Nobody deletes tests to comply. A test that only restates a constant or asserts a mock call may go during the cleanup, with QA's agreement, in the same PR as the code it covered
5. **A test is shown to bite**, E2E specs included: the old build or a mutant turns it red (negative witness, mutation bench)

Two E2E runs share the machine when each takes its own `E2E_PORT_OFFSET` (`e2e/ports.mjs`): it moves `next dev` (3100) and every suite's API port together. Unset, nothing moves.

Nothing is complete until all of these pass. Run them from the repo root on Node 22:

```bash
nvm use                                  # 22, per .nvmrc
npx tsc --noEmit                         # renderer + shared
npx tsc -p electron/tsconfig.json        # main process (also emits electron/dist, needed by e2e)
npm test                                 # vitest, __tests__/**/*.test.ts
npm run lint                             # eslint
npm run lint:design                      # radius / shadows / gradients / raw palette / hex
npm run e2e:guard                        # every inventory page is covered by the manifest
npm run e2e                              # Playwright drives the real Electron app, 39 surfaces
```

`npm run e2e` boots Electron in a sandbox through `launchSandboxed` (`e2e/fixture.mjs`). `HOME` pointed at a temp dir moves `~/.dorothy` and `~/.claude` and nothing else: Electron finds its profile through macOS, so until 2026-09-16 every run opened `~/Library/Application Support/tars`, the installed Tars's own profile. `--user-data-dir` and `CFFIXED_USER_HOME` move it now, and the launch fails if the app reports any of its folders outside the sandbox. It asserts zero uncaught page errors per surface as well as the screenshot. Re-run `tsc -p electron/tsconfig.json` before it or you test a stale main process. `npm test` runs in a throwaway `HOME` too (`__tests__/setup/home-isolation.ts`), and fails a file that writes into the real one.

To see a change in a real packaged build without disturbing your live instance: `npm run electron:pack` then `npm run sandbox`.

### 4. Plan first, then execute autonomously

- Enter plan mode for anything with 3+ steps or an architectural decision. Write the problem, the constraints and the chosen approach before the first line of code
- Then just do it. No "shall I proceed?": the answer is always yes
- Given a bug report, fix it: point at the log, the error, the failing test, resolve it
- If something goes sideways, stop and re-plan rather than pushing on

### 5. Root causes only

- No temporary fixes, no `// TODO: proper fix later`, no swallowing an error to make a symptom disappear
- Every change touches the minimum number of files. If a diff is growing sideways, you are solving the wrong problem
- New behaviour that another feature depends on is not done until an E2E spec drives the whole chain in the real app (Rule 3), not until a unit test shows a mock was called

### 6. Worktrees through `scripts/worktree.mjs`

> **JeanBrasse's rule of 2026-10-01**, after the Mac crashed on a full disk (68 MB free):
> `.worktrees/` held 46 GB across 59 worktrees, most with a full `npm ci` and a `.next`
> of their own, and nothing ever removed one.

Every agent creates and removes its worktrees with the tool, from any checkout of the
repository that has it, never with `git worktree add` or `npm ci` by hand:

```bash
nvm use 22
node scripts/worktree.mjs new <name> --branch <branch> --agent <you> --task <PR or task>
node scripts/worktree.mjs remove <name>        # as soon as its PR is opened and gated, merged, or abandoned
node scripts/worktree.mjs status               # free space, count, owner, idle days, uncommitted, merged, behind
node scripts/worktree.mjs prune --dry-run      # what the cleanup would remove, and why it keeps the rest
```

- **`new`** refuses under 30 GB free and past 20 worktrees (`TARS_WORKTREE_MIN_FREE_GB`,
  `TARS_WORKTREE_MAX`), counting every worktree of the repository, one `new` at a time
  (`.worktrees/.lock`). It also refuses while the main checkout is off `main` or has uncommitted
  changes, then fetches and fast-forwards it, and starts the worktree from that fresh `origin/main`:
  Tars shows each agent the branch of the folder it works in. Its `node_modules` is an APFS
  clone of an installed one (9.8 s and about 65 MB of real space for 1.2 GB, measured 01/10),
  reconciled by `npm install` when the lock differs. Never a symlink: `next dev` refuses one
- **`remove`** refuses a dirty worktree (commit, or `--save` to keep the work on `wip/<name>`), one
  any process works in (your own shell excepted, for `remove` only), a locked one, one with a
  rebase, merge, cherry-pick or bisect in progress, the worktree of one of Tars's own agents
  (`~/.dorothy/agents.json`), and one holding ignored files other than rebuildable caches
  (`node_modules`, `.next`, `electron/dist`, `mcp-*/dist`...): move an e2e run directory you named in
  a PR under `~/Documents` first. Git is never told `--force`. The branch stays, and
  `.worktrees/.removed.log` records its head
- **`prune`** runs before every `new`, so the cleanup needs no schedule. Under the same rules it
  removes a worktree whose PR is merged or closed (an hour after its HEAD last moved), one merged
  into origin/main (a day after), and one idle for 7 days. `git worktree lock --reason <why>`
  keeps one out of it
- Delete your benches and your `.next` when you are done. Whatever must survive (briefs, reports,
  verdicts, benches worth keeping) goes under `~/Documents/Tars-revue-2026-09-24/`: `/private/tmp`
  is wiped at every reboot
- Never delete with a variable or a glob in the path, only a literal absolute one

---

## Memory System

Tars exposes Claude Code's **native memory** (`~/.claude/projects/*/memory/`) via the Memory page. No custom storage: it reads real Claude Code memory files. Project directory names use path-as-folder-name encoding (slashes → dashes); see `electron/utils/decode-project-path.ts`.

## Memory

Use auto memory (`~/.claude/projects/.../memory/`) actively on this project:
- Save architectural decisions, key file locations, and debugging insights to `MEMORY.md`
- Create topic files (e.g. `patterns.md`, `debugging.md`) for detailed notes: keep `MEMORY.md` under 200 lines
- At session start, review `MEMORY.md` for relevant context before diving in
- After any correction or new discovery, update memory so the next session benefits

## Autonomy

When you are delegated a task by Tars or an orchestrator agent, **always act autonomously**:
- Do NOT ask for confirmation before proceeding: just do the work and report results
- Do NOT ask "Would you like me to continue?" or "Shall I proceed?": the answer is always yes
- If a task is ambiguous, make reasonable assumptions and state them in your report
- Complete the full task and return your findings/output directly

---

## Core Principles

`ETHOS.md` carries the long form. These three are the short one, and they apply to every diff:

- **Simplicity first**: make every change as simple as it can be, and touch as little as possible
- **No laziness**: find the root cause, senior-developer standards, no temporary fixes
- **Prove it**: never mark a task complete without the checks in Workflow Rule 3, and never a feature without the E2E spec that drives it and the artefact it leaves

---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
