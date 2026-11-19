/**
 * Integration registry. To add a service, write a module with this shape and list it below:
 *
 *   id, name, vendor, description
 *   kind:          'api'    the app pulls data with a key you paste in
 *                  'local'  an app on this computer, signed in with your own account (see local.js)
 *                  'manual' you or your scripts supply data
 *   credential:    { label, placeholder, help } | null
 *   capabilities:  { usage, cost, limits, tasks, control }, each one of
 *                  'api'     read from the provider's official API
 *                  'local'   read from the app's own files on this computer
 *                  'manual'  entered by you in this app
 *                  'webhook' reported by your own scripts with the ingest token
 *                  'app'     measured or controlled by this app itself (built-in assistant only)
 *                  'none'    not available for this service
 *   notes:         plain-language limits of the integration, shown in the UI
 *   test({ secret })?          -> { ok, detail }   throws AdapterError with a readable message
 *   sync({ secret, since })?   -> { rows: [{ day, model, input_tokens?, output_tokens?, cache_read_tokens?,
 *                                            cache_write_tokens?, requests?, cost_usd? }], dataRefreshedAt }
 *   Local adapters also have status(), engine, cli and may return sessions and meta from sync().
 */
import anthropic from './anthropic.js';
import openai from './openai.js';
import { LOCAL_ADAPTERS } from './local.js';

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

/** Built in: the assistant working inside this app (chat, background tasks, AI summary). Added automatically. */
export const CLAUDE_ASSISTANT = {
  id: 'claude-assistant',
  name: 'Assistant (built in)',
  vendor: 'AI Command Center',
  kind: 'builtin',
  description: 'The assistant working inside this app: the chat, background tasks and the AI summary.',
  credential: null,
  capabilities: { usage: 'app', cost: 'none', limits: 'none', tasks: 'app', control: 'app' },
  notes: [
    'Background tasks the assistant runs are listed under this tool, whichever AI ran them.',
    'Tokens are counted here only for requests made with the Claude API key in Settings, from each response. When the assistant runs through Claude Code, Codex or Gemini CLI, that usage appears under that tool instead.',
    'Cost is not shown here because the API response does not include a price. If you also add the Claude API (Admin key) integration, your real spend appears there, and these tokens are left out of the totals so they are not counted twice.',
    'Background tasks run while the app is open. Closing the app stops any that are still running.',
  ],
};

const list = [
  ...LOCAL_ADAPTERS,
  anthropic,
  openai,
  tracked('custom-agent', 'Custom agent or automation', 'Your own', [
    'Your agent or workflow reports tasks and usage to this app with its ingest token.',
  ], { usage: 'webhook', cost: 'webhook', limits: 'manual', tasks: 'webhook', control: 'none' }),
  tracked('perplexity', 'Perplexity', 'Perplexity AI', [
    'Perplexity has no sign-in that other apps can use and no command-line app, and its API doesn’t report usage, so it can only be tracked by hand here.',
  ]),
];

/**
 * Tracked-by-hand entries from earlier versions. Each now has a sign-in connection, so they're no longer offered,
 * but tools added with them keep working and their page points to the sign-in version.
 */
const replaced = (id, name, vendor, by, why) => ({ ...tracked(id, name, vendor, [why]), replacedBy: by });
const legacy = [
  replaced('claude-plan', 'Claude (Pro / Max plan)', 'Anthropic', 'claude-code', 'Your Claude plan can now be connected by signing in through Claude Code, which also reads its usage automatically.'),
  replaced('chatgpt-plan', 'ChatGPT (Plus / Pro / Team)', 'OpenAI', 'codex', 'Your ChatGPT plan can now be connected by signing in through Codex, which also reads its usage and plan limits.'),
  replaced('gemini', 'Gemini', 'Google', 'gemini-cli', 'Your Google account can now be connected by signing in through Gemini CLI, which also reads its usage.'),
  replaced('cursor', 'Cursor', 'Anysphere', 'cursor-cli', 'Your Cursor account can now be connected by signing in through the Cursor CLI.'),
  replaced('github-copilot', 'GitHub Copilot', 'GitHub', 'copilot-cli', 'Your GitHub account can now be connected by signing in through GitHub Copilot CLI.'),
];

export const adapters = Object.fromEntries([...list, ...legacy, CLAUDE_ASSISTANT].map((a) => [a.id, a]));

export const catalog = () =>
  list.map(({ id, name, vendor, kind, description, credential, capabilities, notes, account, cli }) => ({
    id,
    name,
    vendor,
    kind,
    description,
    credential,
    capabilities,
    notes,
    account: account ?? null,
    install: cli?.install?.text ?? null,
    can_sync: Boolean(adapters[id].sync),
  }));
