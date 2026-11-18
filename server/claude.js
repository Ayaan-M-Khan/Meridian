import Anthropic from '@anthropic-ai/sdk';
import { db, getRaw, addEvent } from './db.js';
import { decrypt } from './crypto.js';
import { CLAUDE_ASSISTANT } from './adapters/index.js';
import { HttpError, nowIso, utcDay } from './util.js';

export const MODEL = 'claude-opus-5-5';
export const CLAUDE_KEY_AAD = 'summary';

/** The regular Claude API key from Settings. It powers the summary, the assistant and background tasks. */
export function claudeKey() {
  const enc = getRaw('summary_key_enc');
  return enc ? decrypt(enc, CLAUDE_KEY_AAD) : null;
}

let clientCache = { key: null, client: null };
let testClient = null;
/** Tests replace the client with a scripted fake, so no request leaves the machine. */
export const setClaudeClientForTests = (c) => { testClient = c; };

export function claudeClient() {
  if (testClient) return testClient;
  const key = claudeKey();
  if (!key) throw new HttpError(400, 'Add a Claude API key in Settings to use Claude here.');
  if (clientCache.key !== key) clientCache = { key, client: new Anthropic({ apiKey: key, maxRetries: 3 }) };
  return clientCache.client;
}

/** The built-in "Claude assistant" tool row, created the first time Claude does something in the app. */
export function assistantIntegration() {
  const row = db.prepare('SELECT * FROM integrations WHERE adapter = ? ORDER BY id LIMIT 1').get(CLAUDE_ASSISTANT.id);
  if (row) return row;
  const { lastInsertRowid } = db
    .prepare("INSERT INTO integrations(adapter, name, status, created_at) VALUES(?, ?, 'tracked', ?)")
    .run(CLAUDE_ASSISTANT.id, CLAUDE_ASSISTANT.name, nowIso());
  addEvent(Number(lastInsertRowid), 'connection', `${CLAUDE_ASSISTANT.name} was added`);
  return db.prepare('SELECT * FROM integrations WHERE id = ?').get(Number(lastInsertRowid));
}

/** Adds one response's token counts to today's row for the built-in tool. These come from the API response, not estimates. */
export function recordUsage(usage, model = MODEL) {
  if (!usage) return;
  const integ = assistantIntegration();
  const cacheWrite = usage.cache_creation_input_tokens ?? null;
  db.prepare(
    `INSERT INTO usage_daily(integration_id, day, model, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests)
     VALUES(?, ?, ?, 'app', ?, ?, ?, ?, 1)
     ON CONFLICT(integration_id, day, model, source) DO UPDATE SET
       input_tokens = COALESCE(input_tokens, 0) + COALESCE(excluded.input_tokens, 0),
       output_tokens = COALESCE(output_tokens, 0) + COALESCE(excluded.output_tokens, 0),
       cache_read_tokens = COALESCE(cache_read_tokens, 0) + COALESCE(excluded.cache_read_tokens, 0),
       cache_write_tokens = COALESCE(cache_write_tokens, 0) + COALESCE(excluded.cache_write_tokens, 0),
       requests = COALESCE(requests, 0) + 1`,
  ).run(integ.id, utcDay(), model, usage.input_tokens ?? null, usage.output_tokens ?? null, usage.cache_read_input_tokens ?? null, cacheWrite);
}

/** A readable message for errors from the Claude API. */
export function claudeErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Claude API key in Settings was rejected.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This Claude API key is not allowed to do that.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate limiting this key. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` (${err.status})` : ''}: ${err.message}`;
  return err?.message ?? String(err);
}

export const isAbort = (err) => err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError';
