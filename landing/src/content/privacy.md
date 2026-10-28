# Tars Privacy Policy

Last updated: 2026-10-28.

This policy covers two things: the Tars desktop app, and the website that offers it for download.

## The short version

- Tars is a desktop app that runs on your Mac. There is no Tars server and no Tars account, and the app collects no analytics.
- Error reports are off unless you turn them on. Turned on, Tars sends Sentry a short report when it meets an error, whether it caught it or not, and when it refuses a tool call of one of your agents: what failed, where in Tars's own code, the version, your system and a random id for your installation. For an error Tars caught, its message is never sent: only its kind and its system codes. For one it did not catch, its message is sent with your home folder, your user and machine names and keys taken out, and it can still name a file, a folder, a command or an address.
- What Tars stores, it stores in folders in your home directory, on your machine.
- Data leaves your machine only toward services you connect yourself: the AI providers whose command-line tools or API keys you use, integrations such as Slack or Discord that you turn on, your own Hermes, through which Tars reaches your Telegram, and Sentry if you turn error reports on. Each of them receives data under its own terms, not ours.
- The website uses Vercel Web Analytics, which sets no cookies, and counts downloads from GitHub's own release figures.

## Who runs what

Tars is open-source software published by Cooper Labs (contact@cooperlabs.xyz). When you run Tars, you run it: the app, the agents it starts and the data they handle are on your computer, under your macOS account. Nobody operating this project receives your prompts, your code, your files, your keys or your usage. We have no server that could receive them. The one thing we can receive is the error reports you choose to send, described below.

## What stays on your machine

Tars keeps its data in these places:

- **`~/.dorothy/`** (the folder keeps the project's former name). It holds:
  - your settings (`app-settings.json`), which since 2.0.4 hold none of your keys, tokens or passwords;
  - your agents and the last part of each agent's terminal output (`agents.json`, with a backup copy);
  - projects and templates;
  - the kanban tasks of the local board Tars used before 1.8.1, kept as a backup since the board moved to Hermes;
  - the vault: your documents and their attachments (`vault.db`, `vault/`);
  - the chat rooms between agents (`bus.json`), and the files you attach to a room message (`bus-files/`), removed after a week;
  - a usage ledger of tokens and cost per turn (`usage-ledger.jsonl`);
  - a log of what your agents did, per project: commands they ran and file changes, shortened (`observations/`);
  - if you used the Telegram bot of versions before 2.0.5, the files it received (`telegram-downloads/`): Tars no longer has a bot of its own and leaves this folder for you to keep or delete;
  - the model catalogue cache;
  - Claude rate-limit and token counters;
  - a log of CLI updates;
  - if you turned error reports on, the random id of your installation and when the last reports left, and Sentry's answer to the last one (`error-reports.json`).

  At every start, Tars closes this folder to the other accounts on your Mac: the folder and its subfolders can be opened by your user account only, and the files directly in it are readable by your account only.
- **`~/.tars-private/`**: the API keys, bot tokens and passwords you enter in Settings (`settings-secrets.json`), the token that local programs use to talk to Tars, your Hermes connection and its sign-in, your conversation with the super chat (the fleet overseer), the list of Hermes sessions that conversation was held in, the Hermes webhook secret, and, if you use several Claude accounts, their list: each account's name, its place in the order and the thresholds, never a credential. This folder is readable by your user account only, and Tars does not point the agents it starts at it. Settings says whether a key is set and never shows it back, and Tars shows the secrets it creates, such as a Hermes webhook secret, in a window of its own. When an agent searches memory, the super chat's Hermes sessions are left out of what it gets back.
- **`~/.claude/` and your other CLIs' settings.** So that it can follow your agents, Tars adds entries to the configuration of the command-line tools it runs:
  - hooks in `~/.claude/settings.json`, which run in every Claude Code session on your account, including sessions you start outside Tars. They report only to Tars's local address, 127.0.0.1;
  - its own MCP servers, and a "trusted folder" mark for each project folder, in `~/.claude.json`. Tars never marks your home folder, the root of the disk or a folder above your home;
  - hooks in `~/.gemini/settings.json`.

  Claude Code writes its own conversation transcripts in `~/.claude/projects/`. Tars reads them to show usage and past sessions, and does not send them anywhere.
- **`~/.claude-accounts/`**: if you use several Claude accounts, one Claude Code folder for each account after the first. Each signs in through Claude Code's own login, and the sign-in stays Claude Code's, in your keychain on macOS: Tars never reads it. The agents started on an account run in its folder, and its transcripts and history are kept with those of `~/.claude`.
- **Hook logs.** The hooks append agent and session identifiers, tool names and short status lines to `~/.dorothy/logs/hooks.log` and `~/.dorothy/logs/hooks-debug.log`, readable by your account only. Versions before 1.8.0 wrote them to `/tmp/dorothy-hooks.log` and `/tmp/dorothy-hooks-debug.log` instead, and those files stay until you delete them.
- **The app's own browser profile**, in `~/Library/Application Support/Tars/`: window state and interface preferences such as the theme.

Local traffic stays local. Tars listens on 127.0.0.1 only: port 31415 for its hooks and tools, and 31416 for its OpenAI-compatible bridge. It does not accept connections from other machines.

The agents Tars starts run as your user account, so an agent that can run shell commands can read any file your account can read, these folders included.

## What leaves your machine, and to whom

Nothing below happens unless you set it up, except where a sentence says otherwise. Each service receives the data it needs to do what you asked, under its own privacy policy and terms.

- **AI coding CLIs you installed** (Claude Code, Codex, Gemini CLI, Grok, OpenCode, Amp, Pi). Tars starts them in your project folders. Your prompts, your code and their tool output then go to that CLI's vendor, under the account you are signed in with. Tars adds its own instructions to the prompts it sends, such as the agent's name and project. For CLIs other than Claude Code, it also adds a digest of the project's memory.
- **AI providers you add with an API key** (OpenRouter, DeepSeek, Moonshot/Kimi, MiniMax, Xiaomi MiMo, Zhipu, Qwen, Venice, NVIDIA, Nous Portal, Ollama Cloud, or any OpenAI-compatible address you enter). Tars points the Claude Code program at that provider with your key, so prompts, code and tool output go to that provider. For OpenRouter, Tars also sends its name and the address of its source repository as attribution.
- **Delegation over the Agent Client Protocol.** To run a delegated task, Tars downloads and runs the matching adapter package from the npm registry (`npx`).
- **Telegram, through your own Hermes**, if you turn on Telegram through Hermes in Settings > Hermes. Tars has no Telegram bot of its own and holds no Telegram token: your orchestrators' messages and questions, and the event reports (an agent gone to error, a pull request merged or with changes requested), go as plain text to your Hermes gateway, which delivers them to you on Telegram with its own bot, and your replies come back the same way. Tars removes text that looks like an API key or token before sending them. While this is off, nothing reaches Telegram. Versions before 2.0.5 had a bot of their own: at its first launch, 2.0.5 removes that bot's token and settings from your machine, and you can revoke the token with Telegram's BotFather.
- **Slack**, if you turn it on and enter its tokens. Messages in the workspace the bot is part of, and the agents' replies. The bot answers only the members you list in Settings, and tells anyone else their Slack ID.
- **Discord**, if you turn it on and enter a bot token. Discord delivers to the bot the messages of the channels it can see and the direct messages sent to it. In a server channel, Tars acts only on a message that mentions the bot, unless you turn that requirement off, and only from the members you list in Settings; it does not store the others. It tells anyone else who mentions it or writes to it directly their Discord ID. The agents' replies and the orchestrator's answers go back through Discord as they were written, and every message the bot posts asks Discord to notify nobody. The invite link Tars gives asks Discord to let the bot see channels and send messages, in channels, threads and direct messages, and nothing else.
- **X and SocialData**, if you enter their credentials. Agents can then search through SocialData with your key and, while the Posting switch in Settings is on, post, reply to and delete posts on the X account you connected.
- **Hermes.** Tars talks to the gateway saved in Settings > Hermes. Until one is saved it contacts no gateway, not even one at the default address on your own Mac, 127.0.0.1:9119, unless you press Test connection or Sign in on that page, which reach the address the form shows. The gateway receives:
  - your conversation with the super chat, together with a snapshot of the fleet: each agent's name, project, status and recent output, and the files you attach to your messages;
  - the agents' kanban tasks, which live on the Hermes board, and the kanban and scheduling calls you make;
  - memory searches, and the memory notes your agents write there;
  - if you turn on Telegram through Hermes, the messages Tars sends you on Telegram and your replies to them (see Telegram above).
- **Memory services** (Honcho, gbrain), if you enable them. Memory notes and searches go to the address you enter.
- **Google Workspace**, if you set up the `gws` tool from Settings. Your agents can then use Gmail, Drive, Calendar, Sheets and Docs through Google, under your authorization.
- **Jira**, if you enter your details. Tars only checks the connection against your Jira site.
- **Claude in Chrome**, if you turn it on. Claude Code can then drive your Chrome browser.
- **models.dev**, and its mirror on GitHub. Tars downloads the public list of models and prices about every six hours. The request carries no personal data beyond your network address.
- **GitHub, for updates.** Tars checks this project's GitHub releases 5 seconds after launch and every 30 minutes. An update is downloaded only when you choose to.
- **Updates of your CLIs.** Every 30 minutes Tars checks for new versions of Claude Code and Amp and installs them when no session is using them: Claude Code through its own updater, Amp through the npm registry. It respects the update opt-outs set in those tools' own configuration. The one Check for updates switch in Settings turns off both this and the check for Tars's own updates.
- **Error reports, to Sentry**, if you turn on "Send error reports" in Settings > Preferences. It is off until you do, and while it is off the error reporting code is not even loaded. When it is on and Tars meets an error in its main process or in its window, one it caught as well as one it did not, it sends Sentry a report made from this list and nothing else:
  - for an error Tars did not catch, its type and message, and those of up to four errors that caused it; for an error Tars caught, its type and its system codes instead of its message (such as `ENOENT` and the system call that failed, or a program's exit status), and the same for up to four errors that caused it;
  - when it happened, how serious it was, and whether Tars caught it;
  - where in the code it happened: the names of the files of Tars and of the libraries it ships, function names, line and column numbers, for the 50 places nearest the error;
  - Tars's version, whether the error came from the main process or the window, the name and version of your operating system, and the version of Electron;
  - a random id made on your Mac for this installation, so that repeats of one problem can be told apart from many people meeting it.

  Before a report leaves, Tars writes your home folder as `~`, your user name as `<user>`, your computer's name as `<host>` and a macOS temporary folder as `<tmp>`, masks text that looks like an API key or token, and replaces any quoted passage longer than 24 characters that contains a space by its length. The message of an error Tars did not catch can still name a file, a folder, a command or an address, or hold a short piece of text Tars was handling when it failed. An error Tars caught sends no message at all.

  When Tars refuses a tool call one of your agents made to it (a message it would not deliver, a task it would not hand on), or a task an agent handed on never starts, it sends a shorter report: the code of its answer (for example `403 worker_may_not_order`), the name of the Tars tool, the name of the command-line tool the agent runs (such as claude or codex), Tars's version and the random id. Nothing the agent wrote, no task, no agent or project name, no path.

  A report never holds the contents of your files, your code or your conversations as such, screenshots, memory dumps, a record of what you did before the error, your computer's language or time zone, your email or account names, sessions, performance traces, recordings of the window, or any other file. At most one report of the same error leaves in 24 hours, and at most 20 in any 24 hours, of which at most 10 for agents' tool calls.

  Like any connection, the report reaches Sentry from your network address; the report itself does not carry it, and Sentry is set not to store it. Sentry stores reports in its European Union data region. Cooper Labs uses them only to find and fix bugs in Tars. Turn the switch off and nothing more is sent from that moment, without restarting.
- **Marketplaces and installs.** Opening the Extensions page reads the public skills.sh catalogue and plugin lists on GitHub. Installing a skill or a plugin downloads it from GitHub or npm.

## The website

The download site is separate from the app.

- **Vercel Web Analytics** measures page views without cookies. Vercel, which hosts the site, processes the request, including your network address, to serve it.
- **The download counter** shows GitHub's own count of release downloads. The site keeps no log of who downloads.
- **Fonts** are served by the site itself.
- **Downloads** come from GitHub Releases, so GitHub serves the file you download.
- The site has no forms, no accounts and no cookies of its own.

## What you control, and how to delete it

- Every integration is off until you set it up. Turn it off, or remove its credentials, in Settings.
- Error reports are off until you turn them on, and turning them off stops them at once. Deleting `~/.dorothy/error-reports.json` gives your installation a new random id the next time reports are on. To have the reports you already sent deleted, write to contact@cooperlabs.xyz with the id that file holds.
- To remove everything Tars stored, quit Tars and delete:
  - `~/.dorothy/` and `~/.tars-private/`;
  - `~/Library/Application Support/Tars/`;
  - from versions before 1.8.0, the hook logs in `/tmp/` (named above).
- To remove Tars's entries from your CLIs:
  - in `~/.claude/settings.json`, delete the hooks whose command points inside the Tars app;
  - in `~/.claude.json`, delete the MCP servers whose names start with `claude-mgr-`, `tars-` or `dorothy-`;
  - in `~/.gemini/settings.json`, delete the hooks Tars added.
- Data that a provider or service received is held by that service. Ask them to delete it, under their terms.

## Changes

If this policy changes, the new version will be published on the website and in the repository, with its date.

## Contact

Cooper Labs, contact@cooperlabs.xyz.
