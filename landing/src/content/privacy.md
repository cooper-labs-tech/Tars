# Tars Privacy Policy

Last updated: 2026-10-15.

This policy covers two things: the Tars desktop app, and the website that offers it for download.

## The short version

- Tars is a desktop app that runs on your Mac. There is no Tars server and no Tars account, and the app collects no analytics.
- Error reports are off unless you turn them on. Turned on, Tars sends Sentry a short report when it meets an error it did not expect: what failed, where in Tars's own code, the version, your system and a random id for your installation. Reports are built to leave out your code, prompts and keys, but an error's message can name a file or folder. The same switch sends a short note at the next launch after Tars ended abruptly, and lets you send a diagnostic from Settings: Tars's health numbers of the last 24 hours, which it keeps on your machine. They are numbers only: no content, no file path, no name.
- What Tars stores, it stores in folders in your home directory, on your machine.
- Data leaves your machine only toward services you connect yourself: the AI providers whose command-line tools or API keys you use, integrations such as Telegram, Slack or Discord that you turn on, and Sentry if you turn error reports on. Each of them receives data under its own terms, not ours.
- The website uses Vercel Web Analytics, which sets no cookies, and counts downloads from GitHub's own release figures.

## Who runs what

Tars is open-source software published by Cooper Labs (contact@cooperlabs.xyz). When you run Tars, you run it: the app, the agents it starts and the data they handle are on your computer, under your macOS account. Nobody operating this project receives your prompts, your code, your files, your keys or your usage. We have no server that could receive them. The one thing we can receive is the error reports you choose to send, described below.

## What stays on your machine

Tars keeps its data in these places:

- **`~/.dorothy/`** (the folder keeps the project's former name). It holds:
  - your settings, including the API keys, bot tokens and passwords you enter (`app-settings.json`);
  - your agents and the last part of each agent's terminal output (`agents.json`, with a backup copy);
  - projects and templates;
  - the kanban tasks of the local board Tars used before 1.8.1, kept as a backup since the board moved to Hermes;
  - the vault: your documents and their attachments (`vault.db`, `vault/`);
  - the chat rooms between agents (`bus.json`), and the files you attach to a room message (`bus-files/`), removed after a week;
  - a usage ledger of tokens and cost per turn (`usage-ledger.jsonl`);
  - a log of what your agents did, per project: commands they ran and file changes, shortened (`observations/`);
  - files received from Telegram (`telegram-downloads/`);
  - the model catalogue cache;
  - Claude rate-limit and token counters;
  - a log of CLI updates;
  - the token that local programs use to talk to Tars;
  - if you turned error reports on, the random id of your installation and when the last reports left (`error-reports.json`);
  - Tars's health numbers, one sample every 5 minutes while it runs, the last 24 hours and at most 256 KB, readable by your account only (`health-samples.jsonl`): what a sample holds is listed under Error reports, below.

  At every start, Tars closes this folder to the other accounts on your Mac: the folder and its subfolders can be opened by your user account only, and the files directly in it are readable by your account only.
- **`~/.tars-private/`**: your conversation with the super chat (the fleet overseer), the list of Hermes sessions that conversation was held in, the Hermes webhook secret, and, if you use several Claude accounts, their list: each account's name, its place in the order and the thresholds, never a credential. This folder is readable by your user account only, and Tars does not point the agents it starts at it. When an agent searches memory, the super chat's Hermes sessions are left out of what it gets back.
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
- **Telegram**, if you turn it on and enter a bot token. Messages you exchange with the bot go through Telegram: the agents' replies, and the files they send. The bot answers only the chats you enrolled with its secret token, and refuses a chat for a while after too many wrong tokens. Messages from other chats are ignored. Before sending the super agent's replies, Tars removes text that looks like an API key or token. Other messages are sent as the agents wrote them. A chat you remove in Settings stops receiving messages at once.
- **Slack**, if you turn it on and enter its tokens. Messages in the workspace the bot is part of, and the agents' replies. The bot answers only the members you list in Settings, and tells anyone else their Slack ID.
- **Discord**, if you turn it on and enter a bot token. Discord delivers to the bot the messages of the channels it can see and the direct messages sent to it. In a server channel, Tars acts only on a message that mentions the bot, unless you turn that requirement off, and only from the members you list in Settings; it does not store the others. It tells anyone else who mentions it or writes to it directly their Discord ID. The agents' replies and the orchestrator's answers go back through Discord as they were written, and every message the bot posts asks Discord to notify nobody. The invite link Tars gives asks Discord to let the bot see channels and send messages, in channels, threads and direct messages, and nothing else.
- **X and SocialData**, if you enter their credentials. Agents can then search through SocialData with your key and, while the Posting switch in Settings is on, post, reply to and delete posts on the X account you connected.
- **Hermes.** Tars talks to the gateway saved in Settings > Hermes. Until one is saved it contacts no gateway, not even one at the default address on your own Mac, 127.0.0.1:9119, unless you press Test connection or Sign in on that page, which reach the address the form shows. The gateway receives:
  - your conversation with the super chat, together with a snapshot of the fleet: each agent's name, project, status and recent output, and the files you attach to your messages;
  - the agents' kanban tasks, which live on the Hermes board, and the kanban and scheduling calls you make;
  - memory searches, and the memory notes your agents write there.
- **Memory services** (Honcho, gbrain), if you enable them. Memory notes and searches go to the address you enter.
- **Google Workspace**, if you set up the `gws` tool from Settings. Your agents can then use Gmail, Drive, Calendar, Sheets and Docs through Google, under your authorization.
- **Jira**, if you enter your details. Tars only checks the connection against your Jira site.
- **Claude in Chrome**, if you turn it on. Claude Code can then drive your Chrome browser.
- **models.dev**, and its mirror on GitHub. Tars downloads the public list of models and prices about every six hours. The request carries no personal data beyond your network address.
- **GitHub, for updates.** Tars checks this project's GitHub releases 5 seconds after launch and every 30 minutes. An update is downloaded only when you choose to.
- **Updates of your CLIs.** Every 30 minutes Tars checks for new versions of Claude Code and Amp and installs them when no session is using them: Claude Code through its own updater, Amp through the npm registry. It respects the update opt-outs set in those tools' own configuration. The one Check for updates switch in Settings turns off both this and the check for Tars's own updates.
- **Error reports, to Sentry**, if you turn on "Send error reports" in Settings > Preferences. It is off until you do, and while it is off the error reporting code is not even loaded. When it is on and Tars meets an error it did not handle, in its main process or in its window, it sends Sentry a report made from this list and nothing else:
  - the error's type and message, and those of up to four errors that caused it;
  - when it happened, how serious it was, and whether Tars caught it;
  - where in the code it happened: the names of the files of Tars and of the libraries it ships, function names, line and column numbers, for the 50 places nearest the error;
  - Tars's version, whether the error came from the main process or the window, the name and version of your operating system, and the version of Electron;
  - a random id made on your Mac for this installation, so that repeats of one problem can be told apart from many people meeting it.

  Before a report leaves, Tars writes your home folder as `~`, your user name as `<user>` and a macOS temporary folder as `<tmp>`, masks text that looks like an API key or token, and replaces any quoted passage longer than 24 characters that contains a space by its length. An error's message can still name a file, a folder or your computer, or hold a short piece of text Tars was handling when it failed.

  A report never holds the contents of your files, your code or your conversations as such, screenshots, memory dumps, a record of what you did before the error, your computer's language or time zone, your email or account names, sessions, performance traces, recordings of the window, or any other file. At most one report of the same error leaves in 24 hours, and at most 20 in any 24 hours.

  The same switch sends two more kinds of report, built the same way, each saying which kind it is and carrying a report's usual fields: Tars's version, the name and version of your operating system, the version of Electron, the random id and the time. At the next launch after a run of Tars that did not quit (a crash, a kill, a power cut), a note saying so: the version that stopped, how many minutes it ran, on macOS the exception type macOS recorded for the crash and nothing else of its report, and the last health sample. And when you press Send a diagnostic in Settings > Preferences, the health samples of the last 24 hours. Tars records a sample every 5 minutes whether the switch is on or not, and keeps them on your machine; they leave it only in these two reports. A sample holds these numbers and nothing else:

  - when it was taken;
  - the memory Tars's main process uses: its heap, used and total, and its resident memory, in megabytes;
  - how late its event loop ran: the median and the 95th percentile, in milliseconds;
  - its three slowest calls of those 5 minutes: the name of each one's channel, such as `usage:tasks`, and how long it took;
  - how many agents there were, and how many ran;
  - the path of the page open in the window, such as `/usage`.

  A note or a sample never holds a memory dump, a stack, a file path, a name, your computer's name or any content. Each of the two kinds leaves at most once in 24 hours, inside the limit of 20 reports in any 24 hours; a send that fails is not counted, and quitting Tars sends nothing. Neither is sent on Windows, where error reports are not available yet.

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
- Error reports are off until you turn them on, and turning them off stops them at once. Deleting `~/.dorothy/error-reports.json` gives your installation a new random id the next time reports are on. To have the reports you already sent deleted, write to contact@cooperlabs.xyz with the id that file holds. Tars's health numbers stay in `~/.dorothy/health-samples.jsonl`; deleting it removes the samples kept so far.
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
