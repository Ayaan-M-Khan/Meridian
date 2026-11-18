import { AdapterError, addDays } from '../util.js';

const BASE = 'https://api.openai.com/v1/organization';
const dayOfUnix = (s) => new Date(s * 1000).toISOString().slice(0, 10);

/** `input_tokens` includes cached tokens, so cached ones are split out to avoid counting them twice. */
export function mapUsageBuckets(buckets) {
  const out = [];
  for (const b of buckets) {
    for (const r of b.results ?? []) {
      const cached = r.input_cached_tokens ?? 0;
      out.push({
        day: dayOfUnix(b.start_time),
        model: r.model ?? '(all models)',
        input_tokens: Math.max(0, (r.input_tokens ?? 0) - cached),
        cache_read_tokens: cached,
        output_tokens: r.output_tokens ?? 0,
        requests: r.num_model_requests ?? 0,
      });
    }
  }
  return out;
}

/** Costs are reported per day without a model breakdown. */
export function mapCostBuckets(buckets) {
  return buckets.map((b) => ({
    day: dayOfUnix(b.start_time),
    model: '',
    cost_usd: (b.results ?? []).reduce((sum, r) => sum + Number(r.amount?.value ?? 0), 0),
  }));
}

async function getPages(path, params, key, fetchImpl = fetch) {
  const out = [];
  let page = null;
  for (let i = 0; i < 50; i++) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
    if (page) qs.set('page', page);
    let res;
    try {
      res = await fetchImpl(`${BASE}${path}?${qs}`, { headers: { Authorization: `Bearer ${key}` } });
    } catch {
      throw new AdapterError('Could not reach api.openai.com. Check the network connection.');
    }
    if (res.status === 401 || res.status === 403)
      throw new AdapterError('OpenAI rejected the key. Usage and costs need an Admin key (sk-admin…) from your organization settings.');
    if (res.status === 429) throw new AdapterError('OpenAI rate-limited the request. It will retry on the next sync.');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AdapterError(`OpenAI returned an error (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    out.push(...(json.data ?? []));
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }
  return out;
}

export default {
  id: 'openai',
  name: 'OpenAI API',
  vendor: 'OpenAI',
  kind: 'api',
  description: 'Completions token usage by model and daily cost for your OpenAI organization.',
  credential: {
    label: 'Admin key',
    placeholder: 'sk-admin-…',
    help: 'Create one in the OpenAI platform under Organization → Admin keys.',
  },
  capabilities: { usage: 'api', cost: 'api', limits: 'manual', tasks: 'webhook', control: 'none' },
  notes: [
    'Usage comes from the organization Usage API (completions) and cost from the Costs API, which reports whole days without a per-model split.',
    'ChatGPT Plus, Pro and Team message limits are not available through any OpenAI API.',
    'The limit shown is the monthly budget you set here.',
    'Tasks appear only if your own agents report them with this tool’s ingest token.',
  ],

  async test({ secret, fetchImpl }) {
    await getPages('/usage/completions', { start_time: Math.floor(addDays(new Date(), -1) / 1000), limit: 1 }, secret, fetchImpl);
    return { ok: true, detail: 'Connected.' };
  },

  async sync({ secret, since, fetchImpl }) {
    const start = Math.floor(since.getTime() / 1000);
    const usage = await getPages(
      '/usage/completions',
      { start_time: start, bucket_width: '1d', group_by: 'model', limit: 31 },
      secret,
      fetchImpl,
    );
    const costs = await getPages('/costs', { start_time: start, bucket_width: '1d', limit: 31 }, secret, fetchImpl);
    return { rows: [...mapUsageBuckets(usage), ...mapCostBuckets(costs)], dataRefreshedAt: null };
  },
};
