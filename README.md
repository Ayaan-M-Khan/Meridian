# AI Command Center

One dashboard for your AI tools: what's running, what's next, what you've spent, and what needs attention. It shows only data a tool actually reports. Anything a provider doesn't expose is marked as unavailable, never filled in.

## Desktop app (Windows)

Download `AI-Command-Center-Setup-<version>.exe` from the Releases page, or build it yourself (below), and run it. It installs AI Command Center with a Start Menu entry and a desktop shortcut. Open it like any other app; closing the window quits it. On first launch, choose a username and password.

The app isn't code-signed yet, so Windows SmartScreen may warn you the first time. Choose **More info → Run anyway**.

The desktop app keeps its data in `%APPDATA%\AI Command Center\data`. It syncs, raises alerts and accepts task reports only while it's open. Its local server listens on port 4317, or a free port if 4317 is taken.

Build the installer:

```bash
npm install
npm run dist
```

The installer is written to `dist/`. Use `npm run app` to open the desktop app without packaging it, and `npm run icons` to regenerate the icons from `assets/icon.svg`.

## Sign in with your account (no API key)

Claude Code, Codex and Gemini CLI connect through the app on your computer and the account it's signed in with, so you don't need an API key:

| App | Account | What the app reads from its logs |
| --- | --- | --- |
| Claude Code | Claude (Pro or Max) | Tokens by day and model, sessions (including the Claude desktop app's) |
| Codex | ChatGPT (Plus, Pro or Team) | Tokens by day and model, sessions, and your plan's usage limits |
| Gemini CLI | Google | Tokens by day and model, sessions |

Choose **Connect a tool** (the **+** beside Connected in the sidebar). The app looks for each one on this computer and shows whether it's installed and signed in. Once you connect one, it appears in the sidebar with a status dot, and its own page opens. If it still needs installing or signing in, that page walks you through it: **Install** and **Sign in with your account** open a console window that runs the app's own installer or sign-in (`npm install -g …`, `claude auth login`, `codex login`, or `gemini`). Signing in happens in your browser, on the provider's own page. The app never sees your password.

Usage figures come from each app's own session logs, so token counts are exact. Cost isn't shown because plan usage isn't priced per token. Local apps are re-read every 2 minutes. Sessions active in the last 3 minutes show as running tasks. Codex's plan limits are as of its last session.

Signing in to claude.ai or chatgpt.com directly from this app isn't possible: neither offers sign-in for other apps. Going through their own command-line apps is the supported way to use your account here. These run on your computer with your own account, for your own use.

## The assistant

The **Assistant** page, the command bar on the overview, and **Ask** on each tool's page all go to one assistant. It runs through the first one ready of Claude Code, a Claude API key, Codex and Gemini CLI, or the one you pick in **Settings → Assistant** or in the chat. The same choice runs:

- **The chat.** It reads your tools, tasks, spending and alerts through the app's own functions and answers from what they return. It can also set budgets and the monthly ceiling, mark alerts read, sync tools, and start, cancel or rerun background tasks, but only when you ask. It can't add or remove tools, change keys, or control tasks or sessions that other tools run.
- **Background tasks.** Choose **New assistant task** on the Tasks page, or ask for one in the chat. It works through the task on its own and reports its progress, so the Tasks page shows a live progress bar, the current step and an expected finish. The result is saved on the task. Two run at a time; others wait in the queue. They stop if you close the app.
- **The daily summary** on the overview.

When it runs through Claude Code, Codex or Gemini CLI, the app's functions are offered to that app as an MCP server (`server/local/mcp-bridge.cjs`). That server only relays calls back to this app, with a token that works for that one run. The CLI's own tools are switched off (Claude Code) or limited to read-only (Codex), and the CLI runs in its own folder inside the app's data folder, so its sessions stay apart from yours. Its usage is counted under that tool from its logs.

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
| Claude API (Admin key) | API, by model | API, by model | Your budget | Your scripts |
| OpenAI API (Admin key) | API, by model | API, daily total | Your budget | Your scripts |
| Custom agent / automation | Your scripts | Your scripts | Your budget | Your scripts |
| Claude Pro/Max, ChatGPT plans, Gemini, Perplexity, Cursor, Copilot | You log it | You log it | Your budget | Your scripts |

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
- `server/runner.js`: background tasks the assistant carries out, with a queue and cancel/retry.
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
- Task names, errors and results that come from other tools are passed to Claude as data, and its instructions say to treat them that way. Background tasks get only read access plus progress reporting, so text inside a reported task can't make one change your settings.
