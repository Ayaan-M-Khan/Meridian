/**
 * Integration registry. To add a service, write a module with this shape and list it below:
 *
 *   id, name, vendor, description
 *   kind:          'api' (the app pulls data) | 'manual' (you or your scripts supply data)
 *   credential:    { label, placeholder, help } | null
 *   capabilities:  { usage, cost, limits, tasks, control }, each one of
 *                  'api'     read from the provider's official API
 *                  'manual'  entered by you in this app
 *                  'webhook' reported by your own scripts with the ingest token
 *                  'app'     measured or controlled by this app itself (built-in Claude assistant only)
 *                  'none'    not available for this service
 *   notes:         plain-language limits of the integration, shown in the UI
 *   test({ secret })?          -> { ok, detail }   throws AdapterError with a readable message
 *   sync({ secret, since })?   -> { rows: [{ day, model, input_tokens?, output_tokens?, cache_read_tokens?,
 *                                            cache_write_tokens?, requests?, cost_usd? }], dataRefreshedAt }
 */
import anthropic from './anthropic.js';
import openai from './openai.js';

const manual = { usage: 'manual', cost: 'manual', limits: 'manual', tasks: 'webhook', control: 'none' };

function tracked(id, name, vendor, notes, capabilities = manual) {
  return {
    id,
    name,
    vendor,
    kind: 'manual',
    description: 'Tracked from usage you log here and tasks your scripts report.',
    credential: null,
    capabilities,
    notes,
  };
}

/** Built in: Claude working inside this app (the assistant, background tasks and the AI summary). Added automatically. */
export const CLAUDE_ASSISTANT = {
  id: 'claude-assistant',
  name: 'Claude assistant',
  vendor: 'Anthropic',
  kind: 'builtin',
  description: 'Claude working inside this app: the assistant, background tasks and the AI summary.',
  credential: null,
  capabilities: { usage: 'app', cost: 'none', limits: 'none', tasks: 'app', control: 'app' },
  notes: [
    'Tokens and requests are measured by this app from each Claude response, using the Claude API key in Settings.',
    'Cost is not shown here because the API response does not include a price. If you also add the Claude API (Admin key) integration, your real spend appears there, and these tokens are left out of the totals so they are not counted twice.',
    'Background tasks run while the app is open. Closing the app stops any that are still running.',
  ],
};

const list = [
  anthropic,
  openai,
  tracked('custom-agent', 'Custom agent or automation', 'Your own', [
    'Your agent or workflow reports tasks and usage to this app with its ingest token.',
  ], { usage: 'webhook', cost: 'webhook', limits: 'manual', tasks: 'webhook', control: 'none' }),
  tracked('claude-plan', 'Claude (Pro / Max plan)', 'Anthropic', [
    'Plan usage limits on claude.ai are not available through an API. For API spend, add “Claude API” instead.',
  ]),
  tracked('chatgpt-plan', 'ChatGPT (Plus / Pro / Team)', 'OpenAI', [
    'Plan message limits are not available through an API. For API spend, add “OpenAI API” instead.',
  ]),
  tracked('gemini', 'Gemini', 'Google', [
    'Not connected to an API yet. Gemini API spend is billed through Google Cloud Billing, which this app does not read yet.',
  ]),
  tracked('perplexity', 'Perplexity', 'Perplexity AI', ['Not connected to an API yet. Log usage here or report it from your scripts.']),
  tracked('cursor', 'Cursor', 'Anysphere', ['Not connected to an API yet. Log usage here or report it from your scripts.']),
  tracked('github-copilot', 'GitHub Copilot', 'GitHub', [
    'Not connected to an API yet. Copilot plans have no remaining-quota figure this app can read.',
  ]),
];

export const adapters = Object.fromEntries([...list, CLAUDE_ASSISTANT].map((a) => [a.id, a]));

export const catalog = () =>
  list.map(({ id, name, vendor, kind, description, credential, capabilities, notes }) => ({
    id,
    name,
    vendor,
    kind,
    description,
    credential,
    capabilities,
    notes,
    can_sync: Boolean(adapters[id].sync),
  }));
