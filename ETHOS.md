# Tars Builder Ethos

These principles shape how we build Tars and how agents prioritize decisions.
Read this before any architecture or prioritization decision.

---

## 1. Boil the Lake

AI-assisted coding makes the marginal cost of completeness near-zero. When the
complete implementation costs minutes more than the shortcut, do the complete thing.

**Lake vs. ocean:** A lake is boilable: every hole an audit confirmed, closed in
one pass; every provider in `electron/providers/` taught the same trick; the
exact escape you just found, written down as a way the code fails before the fix
that closes it. An ocean is not: replacing the
PTY layer wholesale, rewriting the renderer. Boil lakes. Flag oceans as out of scope.

**An ocean can usually be re-cut as a lake.** Delegation over ACP could have been
"rip out terminal dispatch". Instead `delegate_task` prefers the protocol and falls
back to the PTY for CLIs that have no ACP mode, so nothing that worked stopped
working and the new path could ship the same day.

**Completeness is cheap.** When choosing between approach A (full, ~150 LOC) and
approach B (90%, ~80 LOC), prefer A. The 70-line delta costs seconds with AI coding.
"Ship the shortcut" is legacy thinking from when human engineering time was the
bottleneck.

**LOW findings are lakes.** If a finding from an audit fits in a sprint, it ships in
the sprint. The perf round shipped the three costs that dominated everything, then
came back for the five remaining ones rather than filing them.

**Anti-patterns:**
- "Let's defer tests to a follow-up PR." (Tests are the cheapest lake to boil. The
  worktree path-traversal fix shipped with eight, including the exact escape.)
- "This edge case is rare, skip it." (`humanReset` printed "1h 60m" for 7199s.)
- "Good enough for now." (Now costs seconds. Later costs a bug report.)

---

## 2. Search Before Building

Before building anything involving unfamiliar patterns, infrastructure, or runtime
capabilities, stop and search first. The cost of checking is near-zero. The cost
of not checking is reinventing something worse.

### Three Layers of Knowledge

**Layer 1: Tried and true.** Standard patterns, battle-tested approaches. You
probably already know these. Check anyway: once in a while, questioning the
obvious answer is where the best decisions happen.

**Layer 2: New and popular.** Current best practices, recent ecosystem trends.
Search for these. But scrutinize: the crowd can be wrong about new things.
Search results are inputs to your thinking, not answers.

**Layer 3: First principles.** Original observations derived from reasoning about
the specific problem at hand. These are the most valuable. The best architecture
decisions in Tars came from understanding what everyone else does (L1+L2) and
finding a clear reason why the conventional approach doesn't fit (L3).

The goal of searching is not to find a solution to copy. It is to understand
the landscape well enough to see what everyone else missed.

**Searching also means checking that the thing you'd hardcode is published.**
Model ids and prices were compiled in, and the table had already drifted: Gemini 3
Pro listed at $1.25/$10 against a real $2/$120. models.dev publishes both for 193
providers, syncs hourly, is MIT licensed and supports conditional GET, so the usual
refresh is one 304 and no body. The ACP launch commands are the same story: the
public registry publishes one manifest per agent, so `electron/services/acp/registry.ts`
keeps only a small hand-written `FALLBACK` for when the registry is unreachable.

**Anti-patterns:**
- Rolling a custom protocol when ACP already returns a stop reason and a token
  count. (L1 miss)
- Adopting something because it is 2026's answer without probing it. (ACP was
  verified against `claude-agent-acp` on this machine: session up in 4.3s, our MCP
  servers injected through `session/new`, $0.33 reported for the turn, before
  `delegate_task` was pointed at it.) (L2 mania)
- Assuming the obvious architecture is right without questioning the premise.
  (L3 blindness)

---

## 3. User Sovereignty

AI agents recommend. The user decides. This overrides everything else.

Two agents agreeing on a change is a strong signal. It is not a mandate. The user
always has context that agents lack: product direction, UX intuitions, constraints
not yet shared. When agents align on "merge these two things" and the user says
"keep them separate," the user is right. Always. The accent rules came out of the
design because JeanBrasse said "c'est pas possible", not because a metric moved; 79 of
them, everywhere, in one commit.

**This principle is also the product's threat model.** Tars runs on the user's
machine, and the renderer holds the whole `electronAPI` bridge, so anything that
reaches it runs with the user's privileges. That is why `shell:exec` (an arbitrary
renderer-supplied string through a login shell) is gone, replaced by named handlers
using `execFile` with an argv array; why `local-file://` is confined to `~/.dorothy`,
`~/.claude` and the user's own project roots instead of serving `~/.ssh/id_rsa`; and
why a marketplace manifest's `installCommand` is rebuilt here from validated parts
rather than executed verbatim. Autonomy is the one place the code still decides for the
user: `create_agent` defaults `skipPermissions` to true, and the kanban path in
`electron/main.ts` hardcodes `claude --dangerously-skip-permissions`. That is a debt
against this principle, not an expression of it.

**The rule for agents building Tars:** Present recommendations with reasoning. State
what context you might be missing. Ask. Never act on a judgment call without surfacing it.

**Anti-patterns:**
- Making an architecture change "because it's clearly better" without flagging it.
- Merging related tickets silently because they seem connected.
- Framing your assessment as settled fact. (Present both sides. Let the user decide.)
- Shipping a capability that acts on the user's filesystem without a mode they set.

---

## 4. Nothing Works Only for Claude

Tars orchestrates fifteen CLI providers. A feature that works for `claude` and
degrades silently for the other fourteen is not a feature, it is a trap: the user
picked Codex or Grok for that agent and got a worse app without being told.

This principle exists because it kept being violated, in the same shape every time.
`AgentCard` shipped a `PROVIDER_ICONS` map with three entries. `McpSection` typed
its provider union as `'claude' | 'codex' | 'gemini' | 'grok'`. Memory reached only
claude-binary agents while the Brain page said "Connected" for backends nothing had
ever spoken to. "Usage by Provider" showed nothing because it read
`~/.dorothy/token-stats.json`, a file only our own statusline writes, and the
statusline is off by default. Five providers exported `DOROTHY_AGENT_ID` while the
orchestrator MCP and the hooks read `CLAUDE_AGENT_ID`, so those agents had no
identity and `list_agents` fell back to every project's agents: the exact
cross-project confusion the scoping was added to prevent.

**Parity is a shape, not a promise.** You get it by making the general path the only
path: `PROVIDER_REGISTRY` / `getProviderDef()` instead of an inline array; a bundled
`tars-memory` MCP server registered with every provider's own config; a
`usage-ledger` that records every ACP turn with its transport instead of parsing
Claude's transcripts.

**Where parity genuinely does not exist, say so in the code.** `configureHooks` is a
real no-op in seventeen of nineteen providers (only Claude and Gemini configure hooks)
and five of them say why. The other eight are a bare empty body with nothing above it,
and OpenRouter's comment says the opposite of the rule ("uses the same Claude CLI, so
hooks work normally") while doing nothing: that is the debt, not the standard.
`getProvider()` falls back to Claude for an unknown id, which is a deliberate choice
with a comment on it. Naming the gap is honest. Rendering a green "Connected" over it
is not.

**Anti-patterns:**
- A provider array typed inline in a component. (Every one of them was wrong.)
- A new env var, flag or file named after one vendor and read by everything.
- A status that reports success because the happy path is Claude's.
- Adding a sixteenth provider without running the delegation plumbing test.

---

## 5. A Delegated Task Must Return

An orchestrator that types into a PTY and assumes success is the failure this
project keeps fixing.

The terminal path has no receipt. `performDispatch` writes the task into the target
agent's PTY: bracketed paste, then the carriage return on a 300ms delay, because
Claude Code's TUI buffers a rapid `text\r` burst as a paste and never submits it,
and the HTTP 200 goes out before that `\r` is ever written. The only way to learn the
outcome was to poll a status that four of our CLIs never report. So `delegate_task`
could hand a task to opencode, open an empty TUI because the provider built its
command and returned without ever appending the prompt, report `mode: start`, and
lose the text.

ACP is what a receipt looks like. `session/prompt` resolves with a stop reason, the
agent's text, the tool calls it made in order, its token usage and what the turn
cost. Tool calls, plans and permission requests arrive as structured events instead
of ANSI text to be scraped. Three things that only ever worked for Claude fall out of
it: permission arbitration (`session/request_permission` is answered here, so an
orchestrator's deny list is enforced by the protocol on every agent rather than by a
Claude-only `--disallowed-tools` flag), per-session MCP injection, and cost
accounting for providers that never had any.

**The rule:** if you add a way to make an agent do something, it returns what
happened, or it says out loud that it cannot. `usage-ledger` types every entry's
`transport` as `'acp' | 'pty'` for exactly this reason, but `delegateOverAcp` is the
only writer and it always passes `'acp'`, so the ledger holds reported numbers only and
the PTY half of the story is still missing.

**Anti-patterns:**
- Returning 200 for "the bytes left the process."
- Inferring completion from terminal output. (Scraping is not a protocol.)
- A guardrail implemented as a CLI flag one vendor happens to support.
- Fire-and-forget between agents. If nothing can fail visibly, everything fails silently.

---

## 6. Measure, Don't Eyeball

"Looks fine" is not a result. The design and performance work here is done with
computed numbers, and the numbers are kept in the file where the value lives.

Light mode had been shipping the *dark* value for `--text-muted`: `#9B9B9B` on the
`#FAF9F7` page is 2.64:1, and 2.47:1 inside a raised panel: every hint line, every
timestamp, every unit label at half the required contrast, and nobody saw it.
`--primary-foreground` was white on the tangerine at 3.65:1. The fixes were solved
for, not guessed: `#898989` is the darkest grey that still clears 4.5 on all three
dark surfaces at once, and `src/app/globals.css` carries the computed ratio beside
each of those three failing tokens so the next person cannot quietly undo them. The
same round found 261 controls ranging 21..47px tall and snapped them to two values,
26 and 32.

Performance is the same discipline. The statusline renders on every turn for every
agent and each field cost its own echo-into-`jq`: 32 subprocesses per render.
One `jq` pass emitting TSV: 115ms down to 49ms, measured.

**Then make the measurement a guard.** `npm run lint:design` fails on inline
border-radius, drop shadows, gradients, `animate-ping` and any raw Tailwind palette
colour outside `src/components/ui/`. `npm run e2e:guard` fails when one of the ten
routes hardcoded in `e2e/check-coverage.mjs` has no E2E surface: its overlay report
matches a line format `design/UI-INVENTORY.md` no longer uses, so it prints "3 / 0"
and names nothing. 733 tests, `tsc` clean on both projects, design lint clean; that
is the bar, but only `npm test` runs in CI; both guards are still typed by hand, and a
guard you have to remember is half a guard.

**Anti-patterns:**
- A colour picked because it "reads as muted."
- An optimisation with no before-and-after number.
- Fixing the instances and not adding the check that stops them coming back.
- A build step whose exit code is swallowed. (`| tail` in the export script is why
  the packaged app shipped a five-month-old renderer, silently, for months.)

---

## 7. The User's Data Outlives the App

`~/.dorothy/agents.json` is the only durable record of what the user set up. Losing
it means they rebuild their fleet by hand. Treat every file the app writes that way.

It used to be an unversioned bare array written straight over itself. Three ways to
lose it, all closed: the write is a temp file renamed into place, so a crash
mid-write leaves the previous file intact rather than a truncated one; the backup is
taken only from content that just parsed successfully, so a corrupt file can no
longer overwrite the last good copy; and a parse failure keeps the original as
`agents.json.corrupt` and refuses to continue with an empty map, which the next save
used to write over it. Fields mutated on every PTY chunk reached disk only when some
unrelated action happened to trigger a save, so they are flushed on a 30s dirty
timer. The file carries a version now, and still reads the legacy bare array.

**Migrate, don't rename.** The rebrand touched every user-facing string and left
three things alone on purpose: the `~/.dorothy` data directory, the fork URL, and
this checkout's folder, so projects, agents and settings survive the change of name.
The previous rename came with `migrateFromClaudeManager()`, which copies from
`~/.claude-manager` only what does not already exist at the destination before
removing the old directory. Where a value genuinely must be dropped, it is a decision
with a reason: `dorothy-dark-mode` is deliberately *not* migrated to `tars-theme`,
because a stale `false` in it was opening the app in light mode.

**A pointer to someone else's release is user data too.** The updater and
`electron-builder` both pointed at the upstream repository, which would have offered
an upstream build as an update to a fork install and overwritten it. `GITHUB_REPO` is
the fork; upstream's push remote is set to `DISABLED-no-push`.

**Anti-patterns:**
- `writeFileSync` straight onto the live file. (Rename into place.)
- A schema with no version field. ("We'll add one when we need it" is the moment you
  needed it.)
- Reading a corrupt file, getting nothing, and carrying on with an empty state.
- Dropping a stored key during a rename without deciding, in writing, what happens to
  the users who have one.

## 8. Fix the Class, Not the Instance

Three audits and two sweeps in one night, and the individual findings mattered less
than the shape they kept taking. This is the one to internalise, because it produced
the worst bug in the app's history.

**The correct guard is usually sitting next to the missing one.** `local-file://`
resolves its path and checks containment; the `app://` handler nine lines above it did
not, so a percent-encoded traversal read every provider API key out of a vault note
with no click. `registerMcpServer` was fixed to use `execFileSync`; `removeMcpServer`
was left on a shell string in three separate providers, each one directly under the
comment explaining why the sibling had been changed. `loadAgents` normalises a missing
`output` array with a comment describing exactly that class of crash; `skills`, two
lines away, was not, and no agent with an older record could start. `/status`,
`/output` and `/task-completed` check session ownership; `/agent-stopped` and
`/notification` on the same router did not.

So: **when a fix lands on a function, read its siblings in the same file before you
call the class of bug closed.** Not "consider whether"; read them. It costs two
minutes and it is the difference between a fix and the appearance of one.

**Success is assumed rather than confirmed.** The new-agent form reset every field
before `onSubmit` resolved, so a failure lost everything typed. The permission-mode
control moved its displayed value outside its own success check, which is the one
place in this app where being wrong about the state is dangerous. In every case a
`.catch` or an `if (success)` was already sitting in a sibling function in the same
file. The fix is never a new capability; it is finishing the existing one.

**"No current caller passes hostile data" means "safe until the next caller."** That
is a note to write down, not a reason to skip the guard.

**Verify with something that cannot lie to you.** `grep` on this machine is `ugrep`,
where `\|` is a literal, and `/usr/bin/grep` is BSD with no `-P`. Both answer "nothing
found" on a file full of em dashes, and three separate sweeps "passed" over
twenty-nine of them. That is why `scripts/check-dashes.mjs` exists and why
`npm run check:dashes` is in the release checklist. If a check can quietly succeed on
a broken input, it is not a check.

**Anti-patterns:**
- Fixing the reported instance and closing the ticket.
- A comment that says a class of bug was addressed, next to an instance that was not.
- Trusting a search tool's silence.
- A test that checks a mock was called, or restates a constant, instead of driving the feature and reading what it did.
