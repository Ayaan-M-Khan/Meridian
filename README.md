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

## Claude in the app

Add a regular Claude API key under **Settings → Claude** (not the Admin key). The same key powers three things, all on Claude Opus 5.5:

- **Claude chat** (the Claude page, and **Ask Claude** on the overview). Claude reads your tools, tasks, spending and alerts through the app's own functions, and answers from what they return. It can also set budgets and the monthly ceiling, mark alerts read, sync API tools, and start, cancel or rerun background tasks, but only when you ask. It can't add or remove tools, change keys, or control tasks that other tools run.
- **Background tasks.** Choose **New Claude task** on the Tasks page, or ask for one in the chat. Claude works through it on its own and reports its progress as it goes. The task appears on the Tasks page with a live progress bar, the current step and an expected finish. The finished result is saved on the task, where you can copy it or run it again. Two run at a time; others wait in the queue. They stop if you close the app.
- **The daily summary** on the overview.

Every response's token counts are recorded under a built-in **Claude assistant** tool. Cost isn't shown there because the API response doesn't include a price. If you also connect the Claude API (Admin key) integration, your real spend appears under that integration, and the assistant's tokens are left out of the totals so they aren't counted twice. Web search is off by default and can be turned on in Settings; Anthropic bills searches on top of tokens.

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
| Claude API (Admin key) | API, by model | API, by model | Your budget | Your scripts |
| OpenAI API (Admin key) | API, by model | API, daily total | Your budget | Your scripts |
| Custom agent / automation | Your scripts | Your scripts | Your budget | Your scripts |
| Claude Pro/Max, ChatGPT plans, Gemini, Perplexity, Cursor, Copilot | You log it | You log it | Your budget | Your scripts |

- **Plan limits** (ChatGPT, Claude.ai, Cursor, Copilot) are not available through these providers' APIs, so they are not shown.
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
- `server/assistant.js`: the Claude chat. It runs the tool-use loop and streams replies to the browser as newline-delimited JSON.
- `server/assistant-tools.js`: the app functions Claude can call. Read-only tools are available everywhere; actions are available only in the chat.
- `server/runner.js`: background tasks Claude carries out, with a queue and cancel/retry.
- `server/eta.js`: progress history, finish estimates, and stall and overdue detection.
- `server/claude.js`: the shared Claude client, the built-in Claude assistant tool, and token recording.
- `scripts/dev-fake-claude.js`: development only. It runs the server against a scripted stand-in for Claude, so you can click through the chat without an API key.
- `server/state.js`: builds the single payload the UI renders. `server/demo.js` returns sample data in the same shape, flagged `demo: true`.
- `public/`: the frontend, plain JavaScript with Chart.js. Desktop gets a sidebar; phones get a bottom tab bar.

## Security notes

- Changes require the session cookie plus an `x-acc-request` header, which blocks cross-site requests.
- The ingest endpoint takes only its own bearer token, compared by hash.
- Content Security Policy allows scripts only from the app itself. All reported text is escaped before display.
- The server listens on localhost by default. Before exposing it beyond your machine, put it behind HTTPS.
- Task names, errors and results that come from other tools are passed to Claude as data, and its instructions say to treat them that way. Background tasks get only read access plus progress reporting, so text inside a reported task can't make one change your settings.
