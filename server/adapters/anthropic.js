import Anthropic from '@anthropic-ai/sdk';
import { AdapterError, addDays, startOfUtcDay } from '../util.js';

const dayOf = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

export function mapUsageRow(row) {
  const u = row.usage ?? {};
  const cw = u.cache_creation ?? {};
  return {
    day: dayOf(row.starting_at),
    model: row.group?.model ?? '(other)',
    input_tokens: u.uncached_input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_tokens: (cw.ephemeral_1h_input_tokens ?? 0) + (cw.ephemeral_5m_input_tokens ?? 0),
    requests: u.requests ?? 0,
  };
}

/** `amount` is a decimal string in cents. */
export function mapCostRow(row) {
  return {
    day: dayOf(row.starting_at),
    model: row.group?.model ?? '(other)',
    cost_usd: Number(row.cost?.amount ?? 0) / 100,
  };
}

/** Splits [since, now) into windows the API accepts: daily buckets up to today, hourly buckets for today. */
export function queryWindows(since, now = new Date()) {
  const today = startOfUtcDay(now);
  const windows = [];
  for (let start = since; start < today; ) {
    const end = new Date(Math.min(addDays(start, 30).getTime(), today.getTime()));
    windows.push({ starting_at: start.toISOString(), ending_at: end.toISOString(), time_bucket_width: '1d' });
    start = end;
  }
  if (now - today >= 3_600_000) {
    windows.push({ starting_at: today.toISOString(), ending_at: now.toISOString(), time_bucket_width: '1h' });
  }
  return windows;
}

function explain(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return new AdapterError('Anthropic rejected the key. Use an Admin API key (sk-ant-admin…); regular API keys cannot read usage.');
  if (err instanceof Anthropic.PermissionDeniedError)
    return new AdapterError('This key is not allowed to read usage and cost. Use an Admin API key from an organization admin.');
  if (err instanceof Anthropic.NotFoundError)
    return new AdapterError('The Usage and Cost Analytics API is not available to this organization.');
  if (err instanceof Anthropic.RateLimitError) return new AdapterError('Anthropic rate-limited the request. It will retry on the next sync.');
  if (err instanceof Anthropic.APIConnectionError) return new AdapterError('Could not reach api.anthropic.com. Check the network connection.');
  if (err instanceof Anthropic.APIError) return new AdapterError(`Anthropic returned an error (${err.status}): ${err.message}`);
  return err;
}

const client = (apiKey) => new Anthropic({ apiKey, maxRetries: 2 });

export default {
  id: 'anthropic',
  name: 'Claude API',
  vendor: 'Anthropic',
  kind: 'api',
  description: 'Token usage and cost for your Anthropic organization, by model.',
  credential: {
    label: 'Admin API key',
    placeholder: 'sk-ant-admin…',
    help: 'Create one in the Claude Console under Settings → Admin keys. Only organization admins can create it.',
  },
  capabilities: { usage: 'api', cost: 'api', limits: 'manual', tasks: 'webhook', control: 'none' },
  notes: [
    'Usage and cost come from the Usage and Cost Analytics API. New data usually arrives within 4 hours and can take up to 24, so today often looks low.',
    'Claude Pro and Max plan limits on claude.ai are not available through any API.',
    'The limit shown is the monthly budget you set here. Anthropic’s own spend limits are not read.',
    'Tasks appear only if your own agents report them with this tool’s ingest token.',
  ],

  async test({ secret }) {
    try {
      const page = await client(secret).beta.organization.analytics.usage.list({
        starting_at: addDays(startOfUtcDay(), -1).toISOString(),
        limit: 1,
      });
      return { ok: true, detail: `Connected. Data complete up to ${page.data_refreshed_at ?? 'not reported yet'}.` };
    } catch (err) {
      throw explain(err);
    }
  },

  async sync({ secret, since }) {
    const c = client(secret);
    const rows = new Map();
    const add = (r) => {
      const k = `${r.day}|${r.model}`;
      const cur = rows.get(k) ?? { day: r.day, model: r.model };
      for (const [f, v] of Object.entries(r)) if (typeof v === 'number') cur[f] = (cur[f] ?? 0) + v;
      rows.set(k, cur);
    };
    let dataRefreshedAt = null;
    try {
      for (const w of queryWindows(since)) {
        const params = { ...w, group_by: ['model'], limit: 1000 };
        const usage = await c.beta.organization.analytics.usage.list(params);
        dataRefreshedAt = usage.data_refreshed_at ?? dataRefreshedAt;
        for await (const row of usage) add(mapUsageRow(row));
        const cost = await c.beta.organization.analytics.cost.list(params);
        for await (const row of cost) add(mapCostRow(row));
      }
    } catch (err) {
      throw explain(err);
    }
    return { rows: [...rows.values()], dataRefreshedAt };
  },
};
