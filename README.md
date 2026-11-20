# AI Command Center

One dashboard for your AI tools: what's running, what's next, what you've spent, and what needs attention. It shows only data a tool actually reports. Anything a provider doesn't expose is marked as unavailable, never filled in.

## Desktop app (Windows)

Download `AI-Command-Center-Setup-<version>.exe` from the Releases page, or build it yourself (below), and run it. It installs AI Command Center with a Start Menu entry and a desktop shortcut. Open it like any other app. On first launch, choose a username and password.

The app isn't code-signed yet, so Windows SmartScreen may warn you the first time. Choose **More info → Run anyway**.

The desktop app keeps its data in `%APPDATA%\AI Command Center\data`. It syncs, raises alerts, runs tasks and accepts task reports only while it's running. Its local server listens on port 4317, or a free port if 4317 is taken.

- **Closing the window** quits the app, unless tasks are running: then it asks whether to keep them going in the background. **Settings → Desktop app** can keep it running in the system tray every time, and start it in the tray when you sign in to Windows.
- **Windows notifications** show new alerts while the app isn't in front, including "AI team finished" and "Task failed" for tasks you started. Click one to open it.
- **Backups:** **Settings → Backup** saves your tools, tasks and results, conversations, alerts and settings to a JSON file, and restores from one. Backups never include your password, API keys or ingest tokens, so the file is safe to keep; you add keys again after restoring. The code is on GitHub; your data stays on your computer and in the backups you save.
- **Updates:** the app checks this project's GitHub releases every few hours and lets you know when there's a new version. **Settings → Updates** shows what's new and installs it: the app downloads the installer, checks it against the release (size and GitHub's SHA-256 checksum), closes, updates in place and opens again, with your data kept. It won't install while tasks are running. Public releases are read directly; while the repository is private, the check and download use your GitHub CLI sign-in (`gh auth login`), and the app never handles the token. Turn the automatic check off under **Settings → Desktop app**.
- **Exports:** **Usage & Costs** downloads the last 30 days as CSV, and each task's result saves as a Markdown file.
- **Shortcuts:** Ctrl+K (or **/**) jumps to the overview's command bar. The Tasks page has a search box.

Build the installer:

```bash
npm install
npm run dist
```

The installer is written to `dist/`. Use `npm run app` to open the desktop app without packaging it, and `npm run icons` to regenerate the icons from `assets/icon.svg`.

## The map

**Map** in the sidebar shows your setup as a map you can explore:

- **The command center** sits in the middle ("You are here"). Your AI tools are places around it, grouped into regions by company: Anthropic, OpenAI, Google, GitHub and so on.
- **Distance means usage.** The closer a place is to the center, the more you used it this month. A tool with no usage reported sits out at the edge, so nothing is guessed.
- **Routes** run from the center to each place, wider the more requests smart routing sent there in the last 30 days, and colored by the tool's status. Dotted routes haven't been used.
- **Layers** you can switch on and off:
  - **Live work:** moving dashes and a "live" badge on a route while something runs there.
  - **Team hand-offs:** dashed arcs between AIs that passed work to each other in AI team tasks.
  - **Plan limits:** a ring around a place showing how much of its plan limit is used.
  - **Companies:** the regions.
- **Moving around:**
  - Drag to move, and scroll or pinch to zoom.
  - **+**, **−** and the compass (which shows the whole map again) sit at the bottom right. A minimap shows where you are; click it to jump.
  - **Search the map** finds a place and flies there.
- **Place cards:** click a place to open its card: status, tokens today and this month, requests routed there, how often its runs finished well, plan limits, and buttons to open it or chat with it.
- **Without a mouse:** with the map focused, the arrow keys move it, **+** and **−** zoom, **0** shows everything, Tab moves between places, Enter opens one and Escape closes its card. **Every place as a list** under the map has the same facts as a table.

## Privacy & data

AI Command Center keeps everything in one folder on your computer. There's no analytics, tracking or advertising, and nothing goes to the makers of this app. **Privacy & data** in the sidebar shows:

- **What's kept here:** counts of everything stored, the folder, and the database size. Only counts are shown, never the content.
- **Where data goes:**
  - To the AI you use, under your own account with that company, only when you chat, run a task or an automation, or the AI writes the summary. Ask all sends the same request to every connected AI.
  - To the usage APIs you connected with a key.
  - To GitHub for the update check.
  - Nowhere else.
- **Controls:**
  - **Keep finished work for** deletes finished tasks and their results, conversations, alerts, activity and routing notes older than 30, 90 or 180 days or a year, once a day. It asks first, saying how much goes now. Running work, automations, tools and the daily usage numbers stay.
  - **Sessions from AI apps** can be hidden, or listed without what you first typed in them.
- **Your copy:** download everything as a readable JSON file, without your password or keys.
- **Delete everything:** after your password and typing DELETE, erases your account, tools and keys, usage, tasks and results, conversations, alerts, automations, settings and the app's working folders, and compacts the database so nothing lingers in it. The app then starts over with a new setup code. The AI apps you connected keep their own history; manage that in each app.
- **About:**
  - AI-written content is labelled with the AI that wrote it (chat replies, task results, team work, merged answers, the summary), and can be wrong.
  - The app isn't affiliated with Anthropic, OpenAI, Google, GitHub, Microsoft, Anysphere or Perplexity. Their names identify the tools you connect, and the colored initials aren't their logos.
  - The open-source software it includes is listed with its licences.

The interface loads nothing from other sites. Its typeface (Inter, SIL Open Font License) ships with the app, so opening it never contacts a font service, and the Content Security Policy allows only the app's own origin.

**Accessibility:**
- **Keyboard:** a "Skip to content" link appears first when you press Tab, and every control works with the keyboard. Dialogs keep focus inside them and return it to where you were when they close.
- **Screen readers:** errors are announced right away, other messages politely, and the map has a table alternative.
- **Readability:** secondary text meets WCAG AA contrast in both themes.
- **Motion:** "Reduce motion" in Windows turns off the animations.

## Sign in with your account (no API key)

These connect through the provider's own command-line app on your computer and the account it's signed in with, so you don't need an API key:

| Connection | Account | Command-line app | What the app reads from its logs |
| --- | --- | --- | --- |
| Claude Code | Claude (Pro or Max) | `claude` | Tokens by day and model, sessions (including the Claude desktop app's) |
| Codex | ChatGPT (Plus, Pro or Team) | `codex` | Tokens by day and model, sessions, and your plan's usage limits |
| Gemini (Antigravity) | Google (personal and Google One) | `agy` | Nothing: Antigravity doesn't save usage on disk |
| Gemini CLI | Google (Workspace and paid) | `gemini` | Tokens by day and model, sessions |
| GitHub Copilot | GitHub (Copilot plan) | `copilot` | Sessions, and tokens where its logs record them |
| Cursor | Cursor | `agent` | Nothing: the Cursor CLI doesn't save usage on disk |

Choose **Connect a tool** (the **+** beside Connected in the sidebar). The app looks for each one on this computer and shows whether it's installed and signed in. Once you connect one, it appears in the sidebar with a status dot, and its own page opens. If it still needs installing or signing in, that page walks you through it: **Install** and **Sign in with your account** open a console window that runs the provider's own installer or sign-in (`npm install -g …`, the official install script, `claude auth login`, `codex login`, `copilot login`, `agent login`, or a first run of `gemini` or `agy`). Signing in happens in your browser, on the provider's own page. The app never sees your password.

Usage figures come from each app's own session logs, so token counts are exact. Cost isn't shown because plan usage isn't priced per token. Local apps are re-read every 2 minutes. Sessions active in the last 3 minutes show as running tasks. Codex's plan limits are as of its last session.

Notes:

- **Gemini:** since June 2026, Google serves free and Google One accounts through Antigravity CLI, not Gemini CLI. Gemini CLI now refuses those accounts with a message saying to move to Antigravity, and the app passes that on. Workspace and paid accounts can still use Gemini CLI.
- **GitHub Copilot:** VS Code's `copilot` command installs Copilot CLI when it first runs, so the app skips it and only uses a real install (from npm or WinGet). It treats you as signed in if Copilot CLI has a stored sign-in, a GitHub token is set, or the GitHub CLI (`gh`) is signed in, which Copilot CLI also uses.
- **Antigravity** changes MCP permissions only in your global settings, which the app leaves alone. So in the chat it gets a read-only snapshot of your dashboard instead of the app's functions: it answers questions but can't change anything. It takes part in the AI team fully.
- **Perplexity** has no sign-in other apps can use and no command-line app, so it stays tracked by hand. The old "track by hand" entries for Claude, ChatGPT, Gemini, Cursor and Copilot still work for tools you added before; their pages offer the sign-in version.

Signing in to claude.ai, chatgpt.com or gemini.google.com directly from this app isn't possible: none of them offers sign-in for other apps. Going through their own command-line apps is the supported way to use your account here. These run on your computer with your own account, for your own use.

## Smart routing

With the assistant on **Automatic** (Settings → Assistant), every request goes to the AI best suited to it, decided without asking an AI, so routing costs nothing:

1. **What kind of task it is:** coding, debugging, writing, research, analysis, planning or a quick question, from the words in the request.
2. **Who is strongest at it:** coding to Claude Code or Codex, planning to Codex, research to Gemini, quick questions to Copilot, writing to Claude (starting points in `server/router.js`).
3. **Credits:**
   - Plans you already pay for come before a pay-per-use API key.
   - An AI near its plan limit is used less, and one at its limit is skipped. Codex reports its limits; the others don't.
   - Among equally good AIs, the one used least today goes first, so no plan sits idle.
4. **Reliability:** an AI whose recent runs here failed (signed out, blocked, timing out) is tried after the others.

The command bar shows where a request will go as you type. A chat stays with the AI it started with, and shows which one Automatic picked and why. Background tasks and the AI team's roles are routed the same way. Pick a specific AI in Settings or the chat to turn routing off.

To steer it without turning it off, choose an AI for a kind of task under **Settings → Smart routing**, for example Codex for planning or Gemini for research. Your choice goes first unless it isn't ready or is at its plan limit; then Automatic picks the next best and says why.

## Automations

The **Automations** page keeps prompts that run on a schedule: every hour, every day, every weekday or once a week, at a time you choose (this computer's local time). Each one runs as an assistant task, an AI team task (optionally in a project folder) or Ask all.

- Every run goes through smart routing, shows up in Tasks with live progress, and alerts you when it finishes, like a task you start yourself.
- **Run now** tries one straight away; pausing keeps it without running it.
- Runs happen while the app is open or in the tray. A run that was due while the app was closed is skipped and noted, instead of starting late or several times at once.
- The overview's **Up next** lists the next runs. Start from one of the ideas on the page or write your own.

## Statistics

The **Statistics** page shows:

- Each tool's share of your tokens this month, and 30 days of usage with a 7-day average.
- How each AI did on the work it ran here: success rate, typical time, how often its work passed the first review, and approvals it gave.
- What kinds of requests you send and where Automatic sent them.
- How much input each tool reused from its cache, and recent routing decisions with their reasons.

Every figure comes from reported usage, runs here and routing decisions; nothing is estimated.

## Several AIs at once

The overview's command bar has three modes: **Ask** (the assistant), **AI team** (split the work) and **Ask all** (compare answers).

**Ask all** sends one request to every connected AI (up to six) at the same time. Each answers on its own, then the builder (Claude Code first) combines the answers into one, saying where they disagreed. The task keeps every AI's answer, so you can compare them. If combining fails, the separate answers are still saved.

### The AI team

Give one goal to several AIs that split the work. Switch the command bar to **AI team**, or choose **New AI team task** on the Tasks page. Your connected AIs split the work, each doing the part it's best suited to:

| Stage | Role | First choice, then |
| --- | --- | --- |
| Plan | Planner | Codex, Claude Code, Gemini, Copilot, Cursor |
| Build | Builder | Claude Code, Claude API, Cursor, Copilot, Codex |
| Review | Reviewer | Codex, Claude Code, Gemini, Copilot (a different AI from the builder when one is ready) |
| Debug | Debugger | Gemini CLI, Gemini (Antigravity), Claude Code, Codex, Copilot |
| Fix | Builder | The builder applies the reviewer's and debugger's fixes |
| Final check | Reviewer | One more look |

If the review approves the work, the debug and fix stages are skipped. If an AI can't do its part (signed out, blocked, timed out), the next one suited to that role takes over, and the task shows who did. Change who does what in **Settings → AI team**.

Without a folder, the result is text (a draft, a plan, code to copy), saved on the task. With a folder (**Choose…** opens a folder picker), the builder creates and changes files in it, while the planner, reviewer and debugger can only read them. None of them run shell commands, except Codex inside its own sandbox. Use a folder you have a copy of, such as a git project. Working in a folder needs AI apps on this computer; the Claude API can't read or change files.

Each team task shows on the Tasks page with live progress, an expected finish, and a timeline of the stages, including what each AI wrote. One team task runs at a time; others wait in the queue. The assistant can also start one when you ask it to have the team do something.

## The assistant

The **Assistant** page, the command bar on the overview, and **Ask** on each tool's page all go to one assistant. It runs through the first one ready of Claude Code, a Claude API key, Codex, Gemini CLI, Gemini (Antigravity), GitHub Copilot and Cursor, or the one you pick in **Settings → Assistant** or in the chat. The same choice runs:

- **The chat.** It reads your tools, tasks, spending and alerts through the app's own functions and answers from what they return. It can also set budgets and the monthly ceiling, mark alerts read, sync tools, and start, cancel or rerun background tasks, but only when you ask. It can't add or remove tools, change keys, or control tasks or sessions that other tools run.
- **Background tasks.** Choose **New assistant task** on the Tasks page, or ask for one in the chat. It works through the task on its own and reports its progress, so the Tasks page shows a live progress bar, the current step and an expected finish. The result is saved on the task. Two run at a time; others wait in the queue. They stop if you close the app.
- **The daily summary** on the overview.

**Follow-ups.** A finished or failed assistant task, AI team task or Ask all has **Continue from here** on its panel: write what to do next (“make it shorter”, “now add tests”) and a new task starts that runs the same way, in the same folder for an AI team, and gets the earlier request and result to build on. The earlier result is passed as material, not as instructions. The new task links back to the one it continues.

When it runs through a command-line app, the app's functions are offered to it as an MCP server (`server/local/mcp-bridge.cjs`). That server only relays calls back to this app, with a token that works for that one run. The CLI's own tools are switched off or limited: no shell commands, and no file changes outside AI team tasks with a folder. It runs in its own folder inside the app's data folder, so its sessions stay apart from yours, and its usage is counted under that tool from its logs. Runs the app starts also turn off the CLI's auto-update for that run, so a run never stops to update.

Each AI app's page has **Model for runs from this app** (for example `sonnet` in Claude Code), used for everything the app runs through it; a lighter model uses less of your plan. **Settings → Assistant** can also build the daily summary from fixed rules only, so it never uses an AI.

With a Claude API key instead (**Settings → Claude API key**, a regular key, not the Admin key), it uses Claude Opus 5.5 and each response's tokens are recorded under the built-in **Assistant** tool. If you also connect the Claude API (Admin key) integration, your real spend appears there, and the assistant's tokens are left out of the totals so they aren't counted twice. Web search is available with an API key only, is off by default, and is billed on top of tokens.

## Task ETAs and the watcher

For every running task, the app works out an expected finish and says what it's based on:

1. **Reported:** the task sent an `eta`.
2. **From its progress:** a line fitted through its recent `progress` reports, extended to 100%.
3. **From earlier runs:** the usual length of finished runs with the same name on the same tool.

If none of these is available, the app shows "No finish estimate yet" rather than a guess. Every minute it also checks for two kinds of problems and raises an alert for each one (both can be switched off in Settings):

- **Stalled:** a task that reports progress regularly has gone quiet for much longer than usual.
- **Overdue:** a task is well past its expected finish.

## Run it as a server

Requires Node.js 22.13 or later (it uses the built-in `node:sqlite`).

```bash
npm install
npm start
```

Open http://127.0.0.1:4317. On first run the server console prints a one-time **setup code**; enter it in the browser to create the single account. Server mode keeps its own data in `./data`, separate from the desktop app.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to open it from your phone on the same network, ideally behind HTTPS. |
| `ACC_MASTER_KEY` | generated into `data/master.key` | 32-byte key (64 hex chars or base64) that encrypts stored API keys. Back it up. |
| `ACC_DATA_DIR` | `./data` | Where the SQLite database lives |
| `ACC_TRUST_PROXY` | off | Set to `1` behind a reverse proxy so secure cookies work |

Run the tests with `npm test`. They are offline; provider APIs are mocked.

## What each integration can see

| Tool | Usage | Cost | Limits | Tasks |
| --- | --- | --- | --- | --- |
| Claude Code (your Claude account) | Its logs, by model | Not shown (plan) | Not available | Its sessions |
| Codex (your ChatGPT account) | Its logs, by model | Not shown (plan) | Plan limits from its logs | Its sessions |
| Gemini CLI (your Google account) | Its logs, by model | Not shown (plan) | Not available | Its sessions |
| Gemini (Antigravity) (your Google account) | Not available | Not shown (plan) | Not available | Not available |
| GitHub Copilot (your GitHub account) | Its logs, where recorded | Not shown (plan) | Not available | Its sessions |
| Cursor (your Cursor account) | Not available | Not shown (plan) | Not available | Not available |
| Claude API (Admin key) | API, by model | API, by model | Your budget | Your scripts |
| OpenAI API (Admin key) | API, by model | API, daily total | Your budget | Your scripts |
| Custom agent / automation | Your scripts | Your scripts | Your budget | Your scripts |
| Perplexity, and tools added by hand in earlier versions | You log it | You log it | Your budget | Your scripts |

- **Plan limits** (ChatGPT, Claude.ai, Cursor, Copilot) are not available through these providers' APIs, so they are not shown. The exception is Codex, which writes your ChatGPT plan's usage limits to its own logs.
- **Anthropic** data comes from the Usage and Cost Analytics API. It usually arrives within 4 hours and can take up to 24, so today's figures often look low. The app shows how recent the data is.
- **Tasks** are not exposed by any provider's usage API. They come from your own agents through the ingest endpoint below.
- **Task controls** (pause, resume, cancel, restart) are not supported by any integration yet. The UI shows them as unavailable.

## Reporting tasks and usage from your scripts

Each tool has an ingest token, shown once when you add the tool and replaceable from its detail panel.

```bash
curl -X POST http://127.0.0.1:4317/api/ingest/<tool-id> \
  -H "Authorization: Bearer <ingest-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {"id": "run-42", "name": "Nightly report", "status": "running", "progress": 40,
       "started_at": "2026-11-17T21:00:00Z", "eta": "2026-11-17T21:20:00Z"}
    ],
    "usage": [
      {"day": "2026-11-17", "model": "claude-opus-5-5", "input_tokens": 120000, "output_tokens": 30000, "requests": 42, "cost_usd": 1.85}
    ]
  }'
```

- `status` is one of `running`, `queued`, `scheduled`, `completed`, `failed`. Send `scheduled_for` with scheduled tasks and `error` with failed ones.
- Send `progress` (0–100) with each update of a running task so the app can estimate when it will finish and notice if it stalls. `eta`, `step` (what it's doing now) and `result` (text output, up to 20,000 characters) are optional.
- Re-sending the same task `id` updates it. A usage row sets that day's totals for that model. Rows don't add up.
- A single task can also be sent as `{"task": {...}}`.

## Adding an integration

Add a module in `server/adapters/` and list it in `server/adapters/index.js`. The comment at the top of that file describes the shape: metadata, a `capabilities` map that states honestly what the service exposes, plain-language `notes`, and optional `test()` and `sync()` functions that return daily rows. The UI, alerts and summary pick it up without other changes.

## How it fits together

- `electron/main.js`: the desktop shell. It starts the server inside the app, opens the window, and passes the first-run setup code straight to the window.
- `server/app.js`: Express server, security headers, routing. `server/index.js` runs it from the command line.
- `server/auth.js`: single account, scrypt passwords, HttpOnly SameSite=Strict session cookies, login throttling.
- `server/crypto.js`: AES-256-GCM encryption for stored keys. Keys are never sent back to the browser, only a short hint.
- `server/sync.js`: every minute, syncs API tools that are due (every 30 minutes by default), runs alerts, and refreshes the summary.
- `server/alerts.js`: budget warnings and limits, total-spend ceiling, spending spikes, upcoming scheduled tasks. Each alert is created only once.
- `server/summary.js`: the daily summary. With a Claude API key in Settings it is written by Claude Opus 5.5 (refusal fallback enabled). Without one, it is built from your data by fixed rules.
- `server/adapters/local.js`: Claude Code, Codex and Gemini CLI: sign-in checks, log reading, and how to run a prompt through each one.
- `server/local/cli.js`: finds and runs those apps without a shell (npm's `.cmd` launchers are unwrapped), and opens sign-in and install windows.
- `server/local/logs.js`: readers for their session logs. Each file is parsed once and cached until it changes.
- `server/local/mcp-bridge.cjs`: the MCP server a CLI starts to reach the app's functions during a run.
- `server/engine-list.js`, `server/engines.js`: which AI the assistant uses, and running a prompt through a CLI with the bridge.
- `server/assistant.js`: the chat. It runs the tool-use loop (API key) or a CLI run, and streams replies to the browser as newline-delimited JSON.
- `server/assistant-tools.js`: the app functions the assistant can call. Read-only tools are available everywhere; actions are available only in the chat.
- `server/runner.js`: background tasks the assistant carries out, with a queue, cancel/retry and follow-ups.
- `server/updates.js`: checks GitHub for a newer release, and downloads and verifies the installer for the desktop app to run.
- `server/privacy.js`: what the app keeps and where data goes, retention clean-up, session privacy, and erasing everything.
- `public/map.js`: the interactive map: its model (places, routes, regions, hand-offs) and the pan, zoom and search.
- `server/team.js`: AI team tasks (who does each role, the plan → build → review → debug → fix → final check stages, hand-overs when an AI fails) and Ask all (parallel answers, then a combined one).
- `server/backup.js`: backups as a JSON file (tools, tasks, conversations, alerts, automations and settings), without secrets, and restoring them.
- `server/automations.js`: saved prompts that run on a schedule; the scheduler in `server/sync.js` starts the ones that are due every minute.
- `server/router.js`: smart routing: what kind of task a request is, and which ready AI suits it best, weighed for plan headroom, cost, recent failures and spread.
- `server/stats.js`: the Statistics page's figures.
- `server/eta.js`: progress history, finish estimates, and stall and overdue detection.
- `server/claude.js`: the shared Claude API client, the built-in assistant tool, and token recording.
- `scripts/dev-fake-claude.js`: development only. It runs the server against a scripted stand-in for Claude, so you can click through the chat without an API key.
- `test/fixtures/fake-claude.mjs`: a stand-in for the Claude Code CLI that the tests run the whole sign-in path against, MCP bridge included.
- `server/state.js`: builds the single payload the UI renders. `server/demo.js` returns sample data in the same shape, flagged `demo: true`.
- `public/`: the frontend, plain JavaScript with Chart.js. Desktop gets a sidebar; phones get a bottom tab bar.

## Security notes

- Changes require the session cookie plus an `x-acc-request` header, which blocks cross-site requests.
- The ingest endpoint takes only its own bearer token, compared by hash. The MCP bridge endpoint takes only the random token of a run in progress, and stops working when the run ends.
- Content Security Policy allows scripts only from the app itself. All reported text is escaped before display.
- The server listens on localhost by default. Before exposing it beyond your machine, put it behind HTTPS.
- Passwords are stored as salted scrypt hashes; sign-in is rate-limited; session cookies are HttpOnly and SameSite=Strict (and Secure over HTTPS). Erasing all data asks for the password again.
- The interface makes no requests to other sites: fonts and the chart library ship with the app.
- Task names, errors and results that come from other tools are passed to Claude as data, and its instructions say to treat them that way. Background tasks get only read access plus progress reporting, so text inside a reported task can't make one change your settings.
