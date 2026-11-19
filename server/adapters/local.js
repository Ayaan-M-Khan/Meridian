/**
 * Connections that use an AI app installed on this computer and signed in with your own account, so no API key is
 * needed: Claude Code (Claude account), Codex (ChatGPT account), Gemini CLI (Google account), GitHub Copilot CLI
 * (GitHub account) and the Cursor CLI (Cursor account).
 *
 * Each one can:
 *   status()  is it installed, and is it signed in? (asks the CLI itself where it can)
 *   sync()    usage, sessions and plan limits read from the CLI's own logs on this computer, where it keeps them
 *   engine    run a prompt through the CLI, with this app's functions available to it as an MCP server
 *   login / install   commands the app can open in a console window for you
 *
 * engine.invocation({ system, prompt, mcp, access }) builds one run. access is what the CLI may do in the folder it
 * runs in: 'none' (only this app's functions), 'read' (read files) or 'edit' (read, create and change files).
 */
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, resolveCli, runCli } from '../local/cli.js';
import { readClaudeCode, readCodex, readCopilot, readGemini, copilotHome, geminiHome } from '../local/logs.js';
import { AdapterError, nowIso } from '../util.js';

const STATUS_TTL_MS = 60_000;
const statusCache = new Map();

const tryJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0]?.trim() || null;
export const FAKE_CALLS = /<function_calls>|<invoke name=/;

function local({ id, statusCheck, ...def }) {
  const adapter = {
    id,
    kind: 'local',
    credential: null,
    ...def,
    resolve: () => resolveCli(def.cli.bin, def.cli.candidates, def.cli.skip),

    /** { installed, version, signed_in, account, detail, checked_at }. Cached for a minute unless fresh is set. */
    async status({ fresh = false } = {}) {
      const hit = statusCache.get(id);
      if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
      const cli = adapter.resolve();
      let value;
      if (!cli) {
        value = { installed: false, version: null, signed_in: false, account: null, detail: `${def.name} isn’t installed on this computer.` };
      } else {
        try {
          const [ver, st] = await Promise.all([
            runCli(cli, ['--version'], { timeoutMs: 15_000 }).catch(() => null),
            statusCheck(cli),
          ]);
          value = { installed: true, version: ver?.code === 0 ? firstLine(ver.stdout)?.replace(/\s*\(.*\)$/, '') ?? null : null, ...st };
        } catch (err) {
          value = { installed: true, version: null, signed_in: false, account: null, detail: `Couldn’t check the sign-in: ${err.message}` };
        }
      }
      value.checked_at = nowIso();
      value.path = cli?.path ?? null;
      statusCache.set(id, { at: Date.now(), value });
      return value;
    },
    forgetStatus: () => statusCache.delete(id),

    async sync({ since, workspace }) {
      let read = { rows: [], sessions: null };
      try {
        if (def.readLogs) read = def.readLogs({ since, workspace });
      } catch (err) {
        throw new AdapterError(`Couldn’t read ${def.name}’s logs: ${err.message}`);
      }
      const st = await adapter.status();
      return {
        rows: read.rows,
        sessions: read.sessions,
        meta: { account: st.account, version: st.version, limits: read.limits ?? null },
        localStatus: st,
        dataRefreshedAt: nowIso(),
      };
    },
  };
  return adapter;
}

const npmBin = (name) => (IS_WIN ? [`%APPDATA%\\npm\\${name}.cmd`] : ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, `~/.npm-global/bin/${name}`]);

// ── Claude Code ────────────────────────────────────────────────────────────
export const claudeCode = local({
  id: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  account: 'Claude account',
  description: 'Sign in with your Claude account (Pro or Max) through Claude Code. No API key.',
  capabilities: { usage: 'local', cost: 'none', limits: 'none', tasks: 'local', control: 'none' },
  notes: [
    'Uses the Claude Code app on this computer and the Claude account it is signed in with. The assistant, background tasks and the daily summary can run through it, so they count toward your plan instead of costing API tokens.',
    'Usage comes from Claude Code’s own session logs on this computer, including sessions from the Claude desktop app. Token counts are exact; cost is not shown because plan usage isn’t priced per token.',
    'Your Claude plan’s remaining limits aren’t written to those logs, so they are not shown.',
    'Sessions active in the last few minutes show as running tasks. They have no finish estimate because an interactive session has no set end.',
  ],
  cli: {
    bin: 'claude',
    candidates: [IS_WIN ? '~\\.local\\bin\\claude.exe' : '~/.local/bin/claude', ...npmBin('claude'), '~/.claude/local/claude'],
    install: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'], text: 'npm install -g @anthropic-ai/claude-code', url: 'https://docs.claude.com/en/docs/claude-code/setup' },
    login: { args: ['auth', 'login'], text: 'claude auth login', help: 'A browser window opens. Sign in with your Claude account and approve access.' },
  },
  async statusCheck(cli) {
    const r = await runCli(cli, ['auth', 'status', '--json'], { timeoutMs: 20_000 });
    const j = tryJson(r.stdout.trim());
    if (!j) return { signed_in: false, account: null, detail: firstLine(r.stderr) ?? 'Claude Code didn’t report its sign-in status.' };
    const signedIn = j.loggedIn === true;
    const method = j.authMethod && j.authMethod !== 'none' ? String(j.authMethod) : null;
    return {
      signed_in: signedIn,
      account: signedIn
        ? { email: j.email ?? j.account?.email ?? null, plan: j.subscriptionType ?? j.subscription ?? null, method, org: j.orgName ?? j.organization ?? null }
        : null,
      detail: signedIn ? null : 'Claude Code is installed but not signed in.',
    };
  },
  readLogs: readClaudeCode,
  engine: {
    label: 'Claude Code',
    via: 'your Claude account',
    modelArgs: (m) => ['--model', m],
    modelHint: 'opus, sonnet or haiku, or a full model name',
    invocation({ system, prompt, mcp, access = 'none' }) {
      // Built-in tools: none, read-only ones, or file edits too (accepted without asking). Never shell commands.
      const tools = { none: '', read: 'Read,Glob,Grep', edit: 'Read,Glob,Grep,Edit,Write' }[access] ?? '';
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--system-prompt', system, '--strict-mcp-config', '--tools', tools];
      if (access === 'edit') args.push('--permission-mode', 'acceptEdits');
      if (mcp) args.push('--mcp-config', mcp.claudeConfigPath, '--allowedTools', 'mcp__acc');
      return { args, input: prompt };
    },
    parser(emit) {
      let sawDelta = false;
      let messages = 0;
      let result = null;
      let mcpProblem = null;
      const texts = [];
      return {
        onLine(line) {
          const o = tryJson(line);
          if (!o) return;
          if (o.type === 'system' && o.subtype === 'init') {
            // Servers can still be "pending" here while they start; only a real failure is worth mentioning.
            const s = (o.mcp_servers ?? []).find((x) => x.name === 'acc');
            if (s && /fail|error|needs-auth/i.test(s.status ?? '')) mcpProblem = `The app’s functions didn’t connect (${s.status}).`;
          } else if (o.type === 'stream_event') {
            const ev = o.event ?? {};
            if (ev.type === 'message_start') {
              if (messages++ > 0) emit({ type: 'turn' });
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              sawDelta = true;
              emit({ type: 'text', delta: ev.delta.text });
            }
          } else if (o.type === 'assistant') {
            if (o.message?.model === '<synthetic>') return; // the CLI's own notices, such as "Not logged in"; reported via result
            const t = (o.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
            if (t) texts.push(t);
            if (!sawDelta && t) emit({ type: 'text', delta: t });
          } else if (o.type === 'result') {
            result = o;
          }
        },
        finish(run) {
          if (mcpProblem) emit({ type: 'notice', text: mcpProblem });
          if (result?.is_error || (result && result.subtype && result.subtype !== 'success')) {
            const msg = typeof result.result === 'string' && result.result ? result.result : `Claude Code stopped (${result.subtype ?? 'error'}).`;
            return { error: /log ?in|sign ?in|api key|authenticat|oauth/i.test(msg) ? 'Claude Code isn’t signed in. Open Claude Code in the sidebar and choose Sign in.' : msg };
          }
          if (!result) return { error: firstLine(run.stderr) ?? `Claude Code exited without a reply (code ${run.code}).` };
          return { text: typeof result.result === 'string' && result.result ? result.result : texts.at(-1) ?? '' };
        },
      };
    },
  },
});

// ── Codex (ChatGPT account) ────────────────────────────────────────────────
const toml = (v) => JSON.stringify(v); // JSON strings and arrays are valid TOML values

export const codex = local({
  id: 'codex',
  name: 'Codex',
  vendor: 'OpenAI',
  account: 'ChatGPT account',
  description: 'Sign in with your ChatGPT account (Plus, Pro or Team) through the Codex CLI. No API key.',
  capabilities: { usage: 'local', cost: 'none', limits: 'local', tasks: 'local', control: 'none' },
  notes: [
    'Uses the Codex CLI on this computer and the ChatGPT account it is signed in with. The assistant and background tasks can run through it.',
    'Usage and your plan’s usage limits come from Codex’s own session logs. Limits are as of the last Codex session, so they can be out of date until Codex runs again.',
    'Cost is not shown because plan usage isn’t priced per token.',
    'Codex runs read-only here: it can’t change files on this computer.',
  ],
  cli: {
    bin: 'codex',
    candidates: npmBin('codex'),
    install: { command: 'npm', args: ['install', '-g', '@openai/codex'], text: 'npm install -g @openai/codex', url: 'https://developers.openai.com/codex/cli' },
    login: { args: ['login'], text: 'codex login', help: 'A browser window opens. Sign in with your ChatGPT account.' },
  },
  async statusCheck(cli) {
    const r = await runCli(cli, ['login', 'status'], { timeoutMs: 20_000 });
    const text = `${r.stdout}\n${r.stderr}`.trim();
    const signedIn = r.code === 0 && !/not logged in/i.test(text);
    const method = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : null;
    return {
      signed_in: signedIn,
      account: signedIn ? { email: null, plan: null, method, org: null } : null,
      detail: signedIn ? null : 'Codex is installed but not signed in.',
    };
  },
  readLogs: readCodex,
  engine: {
    label: 'Codex',
    via: 'your ChatGPT account',
    modelArgs: (m) => ['-m', m],
    modelAt: 1, // after the exec subcommand
    modelHint: 'a model Codex lists for your plan',
    invocation({ system, prompt, mcp, access = 'none' }) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', access === 'edit' ? 'workspace-write' : 'read-only', '-c', 'approval_policy="never"'];
      if (mcp) {
        args.push('-c', `mcp_servers.acc.command=${toml(mcp.command)}`, '-c', `mcp_servers.acc.args=${toml(mcp.args)}`, '-c', 'mcp_servers.acc.tool_timeout_sec=180');
        if (Object.keys(mcp.env).length) args.push('-c', `mcp_servers.acc.env={${Object.entries(mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(', ')}}`);
      }
      args.push('-');
      return { args, input: `${system}\n\n---\n\n${prompt}` };
    },
    parser(emit) {
      const texts = [];
      let failed = null;
      let lastError = null;
      let done = false;
      return {
        onLine(line) {
          const o = tryJson(line);
          if (!o) return;
          if (o.type === 'item.completed' && o.item?.type === 'agent_message' && o.item.text) {
            if (texts.length) emit({ type: 'turn' });
            texts.push(o.item.text);
            emit({ type: 'text', delta: o.item.text });
          } else if (o.type === 'turn.failed') failed = o.error?.message ?? 'Codex couldn’t finish.';
          else if (o.type === 'error') lastError = o.message ?? null;
          else if (o.type === 'turn.completed') done = true;
        },
        finish(run) {
          if (failed) return { error: /log ?in|sign ?in|auth/i.test(failed) ? 'Codex isn’t signed in. Open Codex in the sidebar and choose Sign in.' : failed };
          if (!texts.length) return { error: lastError ?? firstLine(run.stderr) ?? `Codex exited without a reply (code ${run.code}).` };
          if (!done && lastError) emit({ type: 'notice', text: lastError });
          return { text: texts.at(-1) };
        },
      };
    },
  },
});

// ── Gemini CLI (Google account) ────────────────────────────────────────────
function geminiSignIn() {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { method: 'API key' };
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_CLOUD_PROJECT) return { method: 'Vertex AI' };
  const home = geminiHome();
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  } catch {
    settings = null;
  }
  const selected = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType ?? null;
  let email = null;
  try {
    const accounts = JSON.parse(fs.readFileSync(path.join(home, 'google_accounts.json'), 'utf8'));
    email = typeof accounts?.active === 'string' ? accounts.active : null;
  } catch {
    email = null;
  }
  if (fs.existsSync(path.join(home, 'oauth_creds.json'))) return { method: 'Google account', email };
  if (selected) return { method: String(selected), email };
  return null;
}

/** Google stopped serving personal accounts through Gemini CLI in June 2026; they use Antigravity CLI instead. */
const GEMINI_MOVED = /no longer supported for Gemini Code Assist for individuals|migrate to the Antigravity/i;

/** The first line of CLI output that says what went wrong, skipping start-up warnings. */
function errorLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const noise = /^(warning|security warning|ripgrep is not available|\(node:\d+\)|loaded cached credentials)/i;
  return lines.find((l) => !noise.test(l) && /error|not supported|no longer|denied|unauthori[sz]ed|authenticat|failed|invalid/i.test(l))
    ?? lines.find((l) => !noise.test(l)) ?? null;
}

export const geminiCli = local({
  id: 'gemini-cli',
  name: 'Gemini CLI',
  vendor: 'Google',
  account: 'Google account',
  description: 'For Google Workspace and paid Gemini accounts: sign in through the Gemini CLI. No API key. Personal Google accounts use “Gemini (Antigravity)” instead.',
  capabilities: { usage: 'local', cost: 'none', limits: 'none', tasks: 'local', control: 'none' },
  notes: [
    'Uses the Gemini CLI on this computer and the Google account it is signed in with. The assistant, background tasks and the AI team can run through it.',
    'Since June 2026, Google only serves Workspace and paid accounts through Gemini CLI. Free and Google One accounts get an error saying to move to Antigravity: connect “Gemini (Antigravity)” for those.',
    'Usage comes from Gemini CLI’s saved chats on this computer. Cost and plan limits are not in those files, so they are not shown.',
  ],
  cli: {
    bin: 'gemini',
    candidates: npmBin('gemini'),
    install: { command: 'npm', args: ['install', '-g', '@google/gemini-cli'], text: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
    login: { args: [], text: 'gemini', help: 'Gemini CLI opens in a console window. Choose “Sign in with Google”, finish in the browser, then type /quit.' },
  },
  async statusCheck() {
    const s = geminiSignIn();
    return {
      signed_in: Boolean(s),
      account: s ? { email: s.email ?? null, plan: null, method: s.method, org: null } : null,
      detail: s ? null : 'Gemini CLI is installed but not signed in.',
    };
  },
  readLogs: readGemini,
  engine: {
    label: 'Gemini CLI',
    via: 'your Google account',
    modelArgs: (m) => ['-m', m],
    modelHint: 'auto, pro, flash or a full model name',
    invocation({ system, prompt, mcp, access = 'none' }) {
      // --skip-trust trusts only the folder of this run, for this run, so project settings and tools load.
      const args = ['--output-format', 'json', '--skip-trust'];
      if (access === 'edit') args.push('--approval-mode', 'auto_edit'); // file edits only; shell commands still need approval, so they don't run
      // Windows Gemini CLI only accepts a system settings file from an administrator-owned folder, so the app's
      // functions come from a project settings file (.gemini/settings.json) in this run's own folder instead.
      if (mcp) args.push('--allowed-mcp-server-names', 'acc');
      return { args, input: `${system}\n\n---\n\n${prompt}`, cwd: mcp ? mcp.runDir : undefined };
    },
    parser() {
      return {
        onLine() {},
        finish(run) {
          const all = `${run.stdout}\n${run.stderr}`;
          if (GEMINI_MOVED.test(all)) return { error: 'Google no longer lets personal accounts use Gemini CLI. Connect “Gemini (Antigravity)” to use Gemini with this Google account.' };
          const start = run.stdout.indexOf('{');
          const j = start >= 0 ? tryJson(run.stdout.slice(start)) : null;
          if (j?.error) return { error: j.error.message ?? String(j.error) };
          if (typeof j?.response === 'string' && j.response.trim()) return { text: j.response, emitAll: true };
          return { error: errorLine(run.stderr) ?? `Gemini CLI exited without a reply (code ${run.code}).` };
        },
      };
    },
  },
});

// ── Gemini through Antigravity CLI (Google account) ───────────────────────
/**
 * Google's Antigravity CLI (`agy`), which personal Google accounts use for Gemini since June 2026. Its sign-in lives in
 * the OS keychain and it has no status command, so a run of the `/model` command (no model request) checks it.
 */
async function antigravitySignIn(cli) {
  if (IS_WIN) {
    const r = await runCli(sys('cmdkey'), ['/list'], { timeoutMs: 10_000 }).catch(() => null);
    if (r && /antigravity/i.test(r.stdout)) return { signedIn: true };
  }
  const r = await runCli(cli, ['-p', '/model', '--output-format', 'json'], { timeoutMs: 25_000 }).catch(() => null);
  if (!r) return { signedIn: false };
  const all = `${r.stdout}\n${r.stderr}`;
  const start = r.stdout.indexOf('{');
  const j = start >= 0 ? tryJson(r.stdout.slice(start)) : null;
  if (/authentication required|not (logged|signed) in|sign in/i.test(all)) return { signedIn: false };
  return { signedIn: r.code === 0 && (!j || j.status === 'SUCCESS' || !j.error) };
}

export const antigravityCli = local({
  id: 'antigravity-cli',
  name: 'Gemini (Antigravity)',
  vendor: 'Google',
  account: 'Google account',
  description: 'Sign in with your Google account to use Gemini through Google’s Antigravity CLI. This is how personal Google accounts use Gemini now. No API key.',
  capabilities: { usage: 'none', cost: 'none', limits: 'none', tasks: 'none', control: 'none' },
  notes: [
    'Uses Google’s Antigravity CLI (agy) on this computer and the Google account it is signed in with. Since June 2026 it replaces Gemini CLI for free and Google One accounts.',
    'In the chat it gets a read-only snapshot of your dashboard instead of the app’s functions, so it can answer questions but can’t change budgets or start tasks. It works fully as a member of the AI team.',
    'Antigravity doesn’t save usage on disk, so usage and sessions aren’t shown here.',
  ],
  cli: {
    bin: 'agy',
    candidates: IS_WIN ? ['%LOCALAPPDATA%\\agy\\bin\\agy.exe', '%LOCALAPPDATA%\\agy\\bin\\agy.cmd'] : ['~/.local/bin/agy', '/usr/local/bin/agy'],
    install: IS_WIN
      ? { command: 'powershell', args: ['-NoProfile', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'], text: 'irm https://antigravity.google/cli/install.ps1 | iex  (in PowerShell)', url: 'https://antigravity.google/docs/install/' }
      : { command: 'bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'], text: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', url: 'https://antigravity.google/docs/install/' },
    login: { args: [], text: 'agy', help: 'Antigravity opens in a console window and then your browser. Sign in with your Google account, then close the window.' },
  },
  async statusCheck(cli) {
    const s = await antigravitySignIn(cli);
    return {
      signed_in: s.signedIn,
      account: s.signedIn ? { email: null, plan: null, method: 'Google account', org: null } : null,
      detail: s.signedIn ? null : 'Antigravity CLI is installed but not signed in.',
    };
  },
  engine: {
    label: 'Gemini (Antigravity)',
    via: 'your Google account',
    modelArgs: (m) => ['--model', m],
    modelHint: 'a model from agy models',
    // Its MCP permissions can only be set in your global Antigravity settings, which the app doesn't change.
    mcp: false,
    invocation({ system, prompt, access = 'none' }) {
      const args = ['-p', clip(`${system}\n\n---\n\n${prompt}`), '--output-format', 'json', '--mode', access === 'edit' ? 'accept-edits' : 'plan'];
      return { args, input: null };
    },
    parser: () => ({
      onLine() {},
      finish(run) {
        const start = run.stdout.indexOf('{');
        const j = start >= 0 ? tryJson(run.stdout.slice(start).trim().split('\n').pop()) ?? tryJson(run.stdout.slice(start)) : null;
        const all = `${run.stdout}\n${run.stderr}`;
        if (/authentication required/i.test(all)) return { error: 'Gemini (Antigravity) isn’t signed in. Open it in the sidebar and choose Sign in.' };
        if (j?.status === 'SUCCESS' && typeof j.response === 'string' && j.response.trim()) return { text: j.response, emitAll: true, usage: j.usage ?? null };
        return { error: (typeof j?.error === 'string' ? j.error : j?.error?.message) ?? errorLine(run.stderr) ?? `Antigravity exited without a reply (status ${j?.status ?? run.code}).` };
      },
    }),
  },
});

// ── Shared by the CLIs that take the prompt as an argument (Copilot, Cursor) ─
// Windows limits a command line to 32,767 characters, so long prompts keep their start and end.
const ARG_LIMIT = 26_000;
function clip(text) {
  if (text.length <= ARG_LIMIT) return text;
  const keep = ARG_LIMIT / 2 - 40;
  return `${text.slice(0, keep)}\n\n[… ${text.length - 2 * keep} characters left out to fit …]\n\n${text.slice(-keep)}`;
}
const sys = (cmd) => ({ command: cmd, prefix: [], env: {} });
const plainReply = (name, signInHint) => ({
  onLine() {},
  finish(run) {
    const text = run.stdout.trim();
    if (run.code === 0 && text) return { text, emitAll: true };
    const err = errorLine(run.stderr) ?? errorLine(run.stdout) ?? `${name} exited without a reply (code ${run.code}).`;
    return { error: signInHint.test(`${run.stderr}\n${run.stdout}`) ? `${name} isn’t signed in. Open ${name} in the sidebar and choose Sign in.` : err };
  },
});

// ── GitHub Copilot CLI (GitHub account) ────────────────────────────────────
/** Copilot CLI reads a token from the environment, its own stored sign-in, or the GitHub CLI's, in that order. */
async function copilotSignIn() {
  for (const k of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) if (process.env[k]) return { method: 'a GitHub token', user: null };
  // A stored `copilot login` lives in the OS keychain under "copilot-cli". Only the entry's name is checked.
  if (IS_WIN) {
    const r = await runCli(sys('cmdkey'), ['/list'], { timeoutMs: 10_000 }).catch(() => null);
    if (r && /copilot-cli/i.test(r.stdout)) return { method: 'GitHub account', user: null };
  } else if (process.platform === 'darwin') {
    const r = await runCli(sys('security'), ['find-generic-password', '-s', 'copilot-cli'], { timeoutMs: 10_000 }).catch(() => null);
    if (r?.code === 0) return { method: 'GitHub account', user: null };
  }
  // Without a keychain the sign-in is kept in config.json (a JSON file that can have // comments).
  try {
    const raw = fs.readFileSync(path.join(copilotHome(), 'config.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(raw);
    const users = cfg.logged_in_users ?? cfg.loggedInUsers;
    const last = cfg.last_logged_in_user ?? cfg.lastLoggedInUser;
    if ((Array.isArray(users) && users.length) || last) return { method: 'GitHub account', user: last?.login ?? users?.[0]?.login ?? null };
  } catch {
    /* no config yet */
  }
  // Last, the GitHub CLI's sign-in, which Copilot CLI also uses. `gh auth status` never prints the token.
  const gh = resolveCli('gh', [IS_WIN ? '%ProgramFiles%\\GitHub CLI\\gh.exe' : '/opt/homebrew/bin/gh']);
  if (gh) {
    const r = await runCli(gh, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 }).catch(() => null);
    if (r?.code === 0) return { method: 'your GitHub CLI sign-in', user: `${r.stdout}\n${r.stderr}`.match(/account\s+([A-Za-z0-9-]+)/)?.[1] ?? null };
  }
  return null;
}

export const copilotCli = local({
  id: 'copilot-cli',
  name: 'GitHub Copilot',
  vendor: 'GitHub',
  account: 'GitHub account',
  description: 'Sign in with your GitHub account (Copilot plan) through GitHub Copilot CLI. No API key.',
  capabilities: { usage: 'local', cost: 'none', limits: 'none', tasks: 'local', control: 'none' },
  notes: [
    'Uses GitHub Copilot CLI on this computer and the GitHub account it is signed in with. The assistant, background tasks and the AI team can run through it.',
    'Each prompt it runs uses one of your plan’s premium requests (more for some models).',
    'Sessions come from Copilot CLI’s own folder. Its log format isn’t published, so token counts appear only where it records them; premium requests left aren’t written to disk, so they aren’t shown.',
    'VS Code’s copilot command installs Copilot CLI when it first runs, so this app doesn’t use it. Install Copilot CLI with the button here instead.',
  ],
  cli: {
    bin: 'copilot',
    candidates: IS_WIN ? [...npmBin('copilot'), '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\copilot.exe'] : [...npmBin('copilot'), '~/.local/bin/copilot'],
    skip: (p) => /[\\/]copilot-shim[\\/]/i.test(p),
    install: { command: 'npm', args: ['install', '-g', '@github/copilot'], text: 'npm install -g @github/copilot', url: 'https://docs.github.com/en/copilot/how-tos/copilot-cli' },
    login: { args: ['login'], text: 'copilot login', help: 'A browser window opens. Sign in with your GitHub account and approve GitHub Copilot CLI.' },
  },
  async statusCheck() {
    const s = await copilotSignIn();
    return {
      signed_in: Boolean(s),
      account: s ? { email: null, user: s.user, plan: null, method: s.method, org: null } : null,
      detail: s ? null : 'GitHub Copilot CLI is installed but not signed in.',
    };
  },
  readLogs: readCopilot,
  engine: {
    label: 'GitHub Copilot',
    via: 'your GitHub account',
    modelArgs: (m) => [`--model=${m}`],
    modelHint: 'a model your Copilot plan offers',
    invocation({ system, prompt, mcp, access = 'none' }) {
      const args = ['-p', clip(`${system}\n\n---\n\n${prompt}`), '-s', '--no-ask-user', '--deny-tool', 'shell'];
      args.push(access === 'edit' ? '--allow-tool' : '--deny-tool', 'write');
      if (mcp) {
        const server = { type: 'local', command: mcp.command, args: mcp.args, env: mcp.env, tools: ['*'] };
        args.push('--additional-mcp-config', JSON.stringify({ mcpServers: { acc: server } }), '--allow-tool', 'acc');
      }
      return { args, input: null };
    },
    parser: () => plainReply('GitHub Copilot', /not (logged|signed) in|log ?in|authenticat|unauthori[sz]ed|no (github )?token/i),
  },
});

// ── Cursor CLI (Cursor account) ────────────────────────────────────────────
export const cursorCli = local({
  id: 'cursor-cli',
  name: 'Cursor',
  vendor: 'Anysphere',
  account: 'Cursor account',
  description: 'Sign in with your Cursor account through the Cursor CLI (agent). No API key.',
  capabilities: { usage: 'none', cost: 'none', limits: 'none', tasks: 'none', control: 'none' },
  notes: [
    'Uses the Cursor CLI on this computer and the Cursor account it is signed in with. The assistant, background tasks and the AI team can run through it.',
    'The Cursor CLI doesn’t write usage or request counts to disk, so usage and sessions aren’t shown here. Prompts run from this app count toward your Cursor plan.',
    'This is the Cursor CLI, not the Cursor editor. The editor’s own usage isn’t available outside Cursor.',
  ],
  cli: {
    bin: ['cursor-agent', 'agent'],
    candidates: IS_WIN
      ? ['%LOCALAPPDATA%\\cursor-agent\\cursor-agent.cmd', '%LOCALAPPDATA%\\cursor-agent\\agent.cmd', '%LOCALAPPDATA%\\cursor-agent\\agent.exe', '~\\.local\\bin\\agent.exe', '~\\.local\\bin\\cursor-agent.exe']
      : ['~/.local/bin/cursor-agent', '~/.local/bin/agent'],
    skip: (p) => /[\\/](Microsoft VS Code|cursor[\\/]resources)[\\/]/i.test(p),
    install: IS_WIN
      ? { command: 'powershell', args: ['-NoProfile', '-Command', "irm 'https://cursor.com/install?win32=true' | iex"], text: "irm 'https://cursor.com/install?win32=true' | iex  (in PowerShell)", url: 'https://cursor.com/docs/cli/installation' }
      : { command: 'bash', args: ['-c', 'curl https://cursor.com/install -fsS | bash'], text: 'curl https://cursor.com/install -fsS | bash', url: 'https://cursor.com/docs/cli/installation' },
    login: { args: ['login'], text: 'agent login', help: 'A browser window opens. Sign in with your Cursor account.' },
  },
  async statusCheck(cli) {
    const r = await runCli(cli, ['status', '--format', 'json'], { timeoutMs: 20_000 });
    const start = r.stdout.indexOf('{');
    const j = start >= 0 ? tryJson(r.stdout.slice(start)) : null;
    const text = `${r.stdout}\n${r.stderr}`;
    let signedIn;
    if (j) signedIn = Boolean(j.isAuthenticated ?? j.authenticated ?? j.loggedIn ?? j.isLoggedIn ?? (j.email || j.user || j.account));
    else signedIn = r.code === 0 && !/not (logged|signed) in|unauthenticated|not authenticated/i.test(text) && /logged in|signed in|authenticated/i.test(text);
    const email = j?.email ?? j?.user?.email ?? j?.account?.email ?? text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null;
    return {
      signed_in: signedIn,
      account: signedIn ? { email, user: null, plan: j?.plan ?? j?.membershipType ?? null, method: 'Cursor account', org: null } : null,
      detail: signedIn ? null : 'The Cursor CLI is installed but not signed in.',
    };
  },
  engine: {
    label: 'Cursor',
    via: 'your Cursor account',
    modelArgs: (m) => ['--model', m],
    modelHint: 'a model from agent models',
    invocation({ system, prompt, mcp, access = 'none', cwd }) {
      const runIn = mcp?.runDir ?? cwd;
      const args = ['-p', clip(`${system}\n\n---\n\n${prompt}`), '--output-format', 'json', '--trust'];
      if (runIn) args.push('--workspace', runIn);
      if (mcp) args.push('--approve-mcps');
      else if (access !== 'edit') args.push('--mode', 'ask'); // read-only answers
      return { args, input: null, cwd: runIn };
    },
    parser: () => ({
      onLine() {},
      finish(run) {
        const start = run.stdout.indexOf('{');
        const j = start >= 0 ? tryJson(run.stdout.slice(start).trim().split('\n').pop()) ?? tryJson(run.stdout.slice(start)) : null;
        if (j && !j.is_error && typeof j.result === 'string' && j.result.trim()) return { text: j.result, emitAll: true };
        const msg = (j?.is_error && j.result) || errorLine(run.stderr) || `Cursor exited without a reply (code ${run.code}).`;
        return { error: /not (logged|signed) in|not authenticated|agent login/i.test(`${msg}\n${run.stderr}`) ? 'Cursor isn’t signed in. Open Cursor in the sidebar and choose Sign in.' : msg };
      },
    }),
  },
});

export const LOCAL_ADAPTERS = [claudeCode, codex, geminiCli, antigravityCli, copilotCli, cursorCli];

/** Where the CLIs run when the app uses them, so their sessions are kept apart from yours. */
export const workspaceDir = (dataDir) => path.join(dataDir, 'assistant-workspace');
