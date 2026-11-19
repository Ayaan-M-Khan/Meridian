/**
 * Readers for the session logs that Claude Code, Codex and Gemini CLI keep on this computer. Token counts come
 * straight from those logs: each one is what the provider returned for a request, so nothing here is estimated.
 * Parsing is defensive because the formats are not formal APIs: unknown lines are skipped, never guessed at.
 * Each file is parsed once and cached until it changes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkFiles } from './cli.js';

const cache = new Map(); // path -> { mtimeMs, size, parsed }

function parseFile(file, parser) {
  const hit = cache.get(file.path);
  if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size && hit.parser === parser) return hit.parsed;
  let text;
  try {
    text = fs.readFileSync(file.path, 'utf8');
  } catch {
    return null;
  }
  const parsed = parser(text, file);
  cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, parser, parsed });
  return parsed;
}

function* jsonLines(text) {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line || line[0] !== '{') continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* a partly written line at the end of a live log, or a corrupt one */
    }
  }
}

const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const dayOf = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(iso).toISOString().slice(0, 10) : null);
const isoOf = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** A readable session name from a first prompt: one line, no markup the CLIs add around commands. */
function titleFrom(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null;
  return t.length > 90 ? `${t.slice(0, 87)}…` : t;
}

const textOfContent = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const first = c.find((b) => b && (b.type === 'text' || b.type === 'input_text' || typeof b.text === 'string'));
    return first?.text ?? null;
  }
  return null;
};

function addRow(rows, day, model, u) {
  const key = `${day}|${model}`;
  const r = rows.get(key) ?? { day, model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, requests: 0 };
  r.input_tokens += n(u.input);
  r.output_tokens += n(u.output);
  r.cache_read_tokens += n(u.cacheRead);
  r.cache_write_tokens += n(u.cacheWrite);
  r.requests += 1;
  rows.set(key, r);
}

const under = (child, parent) => {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// ── Claude Code: <config>/projects/<project>/<session>.jsonl ─────────────
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function parseClaude(text, file) {
  const usage = [];
  const s = { id: null, cwd: null, first: null, last: null, title: null, prompt: null, model: null, tokens: 0, entrypoint: null };
  for (const o of jsonLines(text)) {
    s.id ??= o.sessionId ?? null;
    if (o.cwd) s.cwd ??= o.cwd;
    if (o.timestamp) {
      s.first ??= o.timestamp;
      s.last = o.timestamp;
    }
    s.entrypoint ??= o.entrypoint ?? null;
    if (o.type === 'custom-title' && o.customTitle) s.title = String(o.customTitle);
    else if (o.type === 'summary' && o.summary && !s.title) s.title = String(o.summary);
    else if (o.type === 'user' && !s.prompt && !o.isMeta && !o.isSidechain) s.prompt = titleFrom(textOfContent(o.message?.content));
    else if (o.type === 'assistant' && o.message?.usage) {
      const m = o.message;
      if (!m.model || m.model === '<synthetic>') continue;
      const day = dayOf(o.timestamp);
      if (!day) continue;
      const u = m.usage;
      usage.push({
        key: `${m.id ?? o.uuid}:${o.requestId ?? ''}`,
        day,
        model: m.model,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      });
      s.model = m.model;
    }
  }
  const sub = /[\\/]subagents[\\/]/.test(file.path);
  return { usage, session: sub || !s.id ? null : s };
}

export function readClaudeCode({ since, workspace } = {}) {
  const files = walkFiles(path.join(claudeHome(), 'projects'), '.jsonl', { since: since?.getTime?.() ?? 0 });
  const rows = new Map();
  const seen = new Set();
  const sessions = new Map();
  const sinceDay = since ? since.toISOString().slice(0, 10) : '';
  for (const f of files) {
    const p = parseFile(f, parseClaude);
    if (!p) continue;
    let tokens = 0;
    for (const u of p.usage) {
      // The same response is written once per content block, and a moved session can exist twice.
      if (seen.has(u.key)) continue;
      seen.add(u.key);
      const t = n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
      tokens += t;
      if (u.day >= sinceDay) addRow(rows, u.day, u.model, u);
    }
    const s = p.session;
    if (s && !sessions.has(s.id) && !under(s.cwd, workspace)) {
      sessions.set(s.id, {
        id: s.id,
        name: s.title ?? s.prompt ?? 'Claude Code session',
        where: s.cwd ? path.basename(s.cwd) : null,
        started_at: isoOf(s.first),
        last_at: isoOf(s.last) ?? new Date(f.mtimeMs).toISOString(),
        tokens,
        model: s.model,
      });
    }
  }
  return { rows: [...rows.values()], sessions: [...sessions.values()] };
}

// ── Codex: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl ───────────────
export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function parseLimits(rl, at) {
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => {
    if (!w || typeof w !== 'object' || !Number.isFinite(w.used_percent)) return null;
    let resets = null;
    if (Number.isFinite(w.resets_at)) resets = new Date(w.resets_at * (w.resets_at > 1e12 ? 1 : 1000)).toISOString();
    else if (Number.isFinite(w.resets_in_seconds) && at) resets = new Date(Date.parse(at) + w.resets_in_seconds * 1000).toISOString();
    return { used_percent: w.used_percent, window_minutes: Number.isFinite(w.window_minutes) ? w.window_minutes : null, resets_at: resets };
  };
  const primary = win(rl.primary);
  const secondary = win(rl.secondary);
  if (!primary && !secondary) return null;
  return { primary, secondary, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null, observed_at: at };
}

function parseCodex(text) {
  const usage = [];
  const s = { id: null, cwd: null, first: null, last: null, prompt: null, model: null, tokens: 0 };
  let limits = null;
  let prevTotal = null;
  let i = 0;
  for (const o of jsonLines(text)) {
    const at = o.timestamp ?? null;
    if (at) {
      s.first ??= at;
      s.last = at;
    }
    const p = o.payload ?? o;
    const type = o.type;
    if (type === 'session_meta') {
      s.id ??= p.id ?? p.meta?.id ?? null;
      s.cwd ??= p.cwd ?? p.meta?.cwd ?? null;
    } else if (type === 'turn_context' && p.model) {
      s.model = p.model;
    } else if ((type === 'event_msg' && p.type === 'user_message') || type === 'user_message') {
      s.prompt ??= titleFrom(p.message);
    } else if (type === 'response_item' && p.type === 'message' && p.role === 'user' && !s.prompt) {
      s.prompt = titleFrom(textOfContent(p.content));
    } else if ((type === 'event_msg' && p.type === 'token_count') || type === 'token_count') {
      const info = p.info ?? null;
      const l = parseLimits(p.rate_limits, at);
      if (l) limits = l;
      if (!info) continue;
      let u = null;
      const total = info.total_token_usage;
      if (total && Number.isFinite(total.total_tokens ?? total.input_tokens)) {
        const sum = n(total.input_tokens) + n(total.output_tokens);
        if (prevTotal && sum <= n(prevTotal.input_tokens) + n(prevTotal.output_tokens)) continue; // repeated report
        u = prevTotal
          ? Object.fromEntries(['input_tokens', 'cached_input_tokens', 'output_tokens'].map((k) => [k, n(total[k]) - n(prevTotal[k])]))
          : info.last_token_usage ?? total;
        prevTotal = total;
      } else {
        u = info.last_token_usage;
      }
      if (!u) continue;
      const day = dayOf(at);
      if (!day) continue;
      const cached = n(u.cached_input_tokens);
      usage.push({ key: `${i++}`, day, model: s.model ?? 'codex', input: Math.max(0, n(u.input_tokens) - cached), output: u.output_tokens, cacheRead: cached, cacheWrite: 0 });
    }
  }
  return { usage, session: s, limits, limitsAt: limits?.observed_at ?? null };
}

export function readCodex({ since, workspace } = {}) {
  const files = walkFiles(path.join(codexHome(), 'sessions'), '.jsonl', { since: since?.getTime?.() ?? 0 });
  const rows = new Map();
  const sessions = new Map();
  const sinceDay = since ? since.toISOString().slice(0, 10) : '';
  let limits = null;
  for (const f of files) {
    const p = parseFile(f, parseCodex);
    if (!p) continue;
    let tokens = 0;
    for (const u of p.usage) {
      tokens += n(u.input) + n(u.output) + n(u.cacheRead);
      if (u.day >= sinceDay) addRow(rows, u.day, u.model, u);
    }
    if (p.limits && (!limits || (p.limitsAt ?? '') > (limits.observed_at ?? ''))) limits = p.limits;
    const s = p.session;
    const id = s.id ?? path.basename(f.path, '.jsonl');
    if (!sessions.has(id) && !under(s.cwd, workspace)) {
      sessions.set(id, {
        id,
        name: s.prompt ?? 'Codex session',
        where: s.cwd ? path.basename(s.cwd) : null,
        started_at: isoOf(s.first),
        last_at: isoOf(s.last) ?? new Date(f.mtimeMs).toISOString(),
        tokens,
        model: s.model,
      });
    }
  }
  return { rows: [...rows.values()], sessions: [...sessions.values()], limits };
}

// ── Gemini CLI: <home>/.gemini/tmp/<project>/chats/session-*.jsonl ────────
export const geminiHome = () => (process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini'));

function parseGemini(text, file) {
  let meta = {};
  const messages = new Map();
  const apply = (m) => {
    if (!m || typeof m !== 'object' || !m.id) return;
    messages.set(m.id, { ...(messages.get(m.id) ?? {}), ...m });
  };
  if (file.path.endsWith('.json')) {
    try {
      const doc = JSON.parse(text);
      meta = doc;
      for (const m of doc.messages ?? []) apply(m);
    } catch {
      return null;
    }
  } else {
    let first = true;
    for (const o of jsonLines(text)) {
      if (first && o.sessionId && !o.type) meta = { ...o };
      else if (o.$set) meta = { ...meta, ...o.$set };
      else if (o.$patch && o.$patch.id) apply(o.$patch);
      else if (o.$rewindTo) {
        const keep = [...messages.keys()];
        const at = keep.indexOf(o.$rewindTo);
        if (at >= 0) for (const id of keep.slice(at)) messages.delete(id);
      } else if (o.id && o.type) apply(o);
      first = false;
    }
  }
  const usage = [];
  let prompt = null;
  let model = null;
  let last = meta.lastUpdated ?? null;
  for (const m of messages.values()) {
    if (m.timestamp && (!last || m.timestamp > last)) last = m.timestamp;
    if (m.type === 'user' && !prompt) prompt = titleFrom(textOfContent(m.content) ?? (Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join(' ') : null));
    if (m.type !== 'gemini' || !m.tokens) continue;
    const day = dayOf(m.timestamp);
    if (!day) continue;
    const t = m.tokens;
    const cached = n(t.cached);
    model = m.model ?? model;
    usage.push({ key: m.id, day, model: m.model ?? 'gemini', input: Math.max(0, n(t.input) - cached) + n(t.tool), output: n(t.output) + n(t.thoughts), cacheRead: cached, cacheWrite: 0 });
  }
  return {
    usage,
    session: { id: meta.sessionId ?? path.basename(file.path), projectHash: meta.projectHash ?? null, title: typeof meta.summary === 'string' ? meta.summary : null, prompt, first: meta.startTime ?? null, last, model },
  };
}

export function readGemini({ since, workspace } = {}) {
  const tmp = path.join(geminiHome(), 'tmp');
  const files = [
    ...walkFiles(tmp, '.jsonl', { since: since?.getTime?.() ?? 0 }),
    ...walkFiles(tmp, '.json', { since: since?.getTime?.() ?? 0 }),
  ].filter((f) => /[\\/]chats[\\/]/.test(f.path));
  const rows = new Map();
  const sessions = new Map();
  const sinceDay = since ? since.toISOString().slice(0, 10) : '';
  const ownHash = workspace ? crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex') : null;
  for (const f of files) {
    const p = parseFile(f, parseGemini);
    if (!p) continue;
    let tokens = 0;
    for (const u of p.usage) {
      tokens += n(u.input) + n(u.output) + n(u.cacheRead);
      if (u.day >= sinceDay) addRow(rows, u.day, u.model, u);
    }
    const s = p.session;
    if (!sessions.has(s.id) && (!ownHash || s.projectHash !== ownHash)) {
      sessions.set(s.id, {
        id: s.id,
        name: s.title ?? s.prompt ?? 'Gemini CLI session',
        where: null,
        started_at: isoOf(s.first),
        last_at: isoOf(s.last) ?? new Date(f.mtimeMs).toISOString(),
        tokens,
        model: s.model,
      });
    }
  }
  return { rows: [...rows.values()], sessions: [...sessions.values()] };
}
