/**
 * Smart routing: sends each request to the AI best suited to it, without asking an AI (so routing costs nothing).
 *
 * 1. classify()  reads what the request is about: coding, debugging, writing, research, analysis, planning or a quick
 *                question, from the words in it.
 * 2. Each ready AI gets a score: how strong it is at that kind of work (STRENGTHS), times
 *    - headroom:    Codex reports its plan limits; an AI near its limit is used less, one at its limit is skipped
 *    - reliability: an AI whose recent runs here failed (signed out, blocked, timing out) is used less
 *    - cost:        plans you already pay for come before a pay-per-use API key
 *    - spread:      among equally good AIs, the one used least today goes first, so no plan is left idle
 *    - fit:         in the chat, AIs that can use the app's functions come first
 * 3. The best score wins, with the reasons kept so the app can say why.
 *
 * STRENGTHS are starting points from what each AI is generally best at. Reliability learns from your own runs.
 */
import { db, getSettings } from './db.js';
import { listEngines } from './engine-list.js';
import { nowIso, utcDay } from './util.js';

export const CATEGORIES = {
  code: 'Coding',
  debug: 'Debugging',
  writing: 'Writing',
  research: 'Research',
  analysis: 'Analysis',
  planning: 'Planning',
  quick: 'Quick question',
  general: 'General',
};

const SIGNALS = {
  code: /\b(code|coding|program|function|method|script|refactor|implement|endpoint|api|class|component|module|library|typescript|javascript|python|java|kotlin|swift|c\+\+|c#|rust|golang|sql|regex|html|css|react|node|unit tests?|write tests?|compile|repo|pull request|commit|build (?:a|an|the|me)? ?(?:app|site|website|tool|cli|feature|page|game|bot))\b/gi,
  debug: /\b(debug|bug|\w*error|\w*exception|stack ?trace|traceback|crash(?:es|ing)?|failing|fails|broken|doesn'?t work|not working|segfault|undefined is not|null pointer|fix (?:the|this|a|my)? ?(?:bug|error|issue|crash|test))\b/gi,
  writing: /\b(write|draft|rewrite|reword|email|letter|post|blog|article|essay|copy|tweet|thread|announcement|newsletter|summary|summari[sz]e|proofread|tone|story|poem|caption|bio|cover letter|resume|speech|script for|headline|tagline)\b/gi,
  research: /\b(research|compare|comparison|find out|look up|latest|news|sources?|citations?|market|competitors?|alternatives?|pros and cons|which is better|recommend(?:ation)?s?|best (?:way|tool|option)s?|what is the current|state of the art)\b/gi,
  analysis: /\b(analy[sz]e|analysis|data|dataset|numbers|statistics|stats|trend|usage|spend(?:ing)?|costs?|budget|csv|spreadsheet|chart|graph|metrics?|kpis?|calculate|forecast|breakdown)\b/gi,
  planning: /\b(plan|planning|roadmap|strategy|steps|outline|schedule|prioriti[sz]e|architecture|design (?:a|the|an)|approach|break (?:it )?down|milestones?|timeline)\b/gi,
};

/** What a request is about, from its words. Ties go to the more specific kind of work. */
export function classify(text) {
  const t = String(text ?? '');
  const scores = Object.fromEntries(Object.entries(SIGNALS).map(([k, re]) => [k, (t.match(re) ?? []).length]));
  // Signs of a problem outweigh the technology named: "fix this error in my React code" is debugging.
  if (scores.debug) scores.debug = scores.debug * 2 + 0.5;
  const [best, n] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (n > 0) return { category: best, label: CATEGORIES[best] };
  const words = t.trim().split(/\s+/).filter(Boolean).length;
  if (words && words <= 14) return { category: 'quick', label: CATEGORIES.quick };
  return { category: 'general', label: CATEGORIES.general };
}

/** How strong each AI is at each kind of work, 1 to 5. Starting points, not measurements. */
export const STRENGTHS = {
  'claude-code': { code: 5, debug: 5, writing: 5, research: 3, analysis: 4, planning: 4, quick: 3, general: 4 },
  'claude-api': { code: 4, debug: 4, writing: 5, research: 3, analysis: 5, planning: 4, quick: 4, general: 4 },
  codex: { code: 5, debug: 4, writing: 3, research: 3, analysis: 4, planning: 5, quick: 3, general: 4 },
  'gemini-cli': { code: 4, debug: 4, writing: 4, research: 5, analysis: 4, planning: 4, quick: 4, general: 4 },
  'antigravity-cli': { code: 4, debug: 4, writing: 4, research: 5, analysis: 4, planning: 4, quick: 4, general: 4 },
  'copilot-cli': { code: 4, debug: 4, writing: 3, research: 2, analysis: 3, planning: 3, quick: 5, general: 3 },
  'cursor-cli': { code: 5, debug: 4, writing: 2, research: 2, analysis: 3, planning: 3, quick: 3, general: 3 },
};
const STRONGEST = { code: 'code', debug: 'debugging', writing: 'writing', research: 'research', analysis: 'analysis', planning: 'planning', quick: 'quick answers', general: 'general work' };

/** Plan headroom from what the AI itself reports. Only Codex writes its limits down. */
function headroom(engineId, metas) {
  const limits = metas.get(engineId)?.limits;
  if (!limits) return { factor: 1, note: null };
  const fresh = limits.observed_at && Date.now() - Date.parse(limits.observed_at) < 6 * 3_600_000;
  const used = Math.max(limits.primary?.used_percent ?? 0, fresh ? limits.secondary?.used_percent ?? 0 : 0);
  if (!fresh && (limits.primary?.resets_at && Date.parse(limits.primary.resets_at) < Date.now())) return { factor: 1, note: null };
  if (used >= 95) return { factor: 0.05, note: `${Math.round(used)}% of its plan limit used` };
  if (used >= 85) return { factor: 0.5, note: `${Math.round(used)}% of its plan limit used` };
  if (used >= 70) return { factor: 0.8, note: `${Math.round(used)}% of its plan limit used` };
  return { factor: 1, note: null };
}

let reliabilityCache = { at: 0, value: new Map() };
const CANCELLED = /^Cancelled/;

/** How the AIs' recent runs here went: background tasks and AI team stages over the last week. */
export function reliabilityByEngine() {
  if (Date.now() - reliabilityCache.at < 30_000) return reliabilityCache.value;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const out = new Map();
  const add = (id, ok, at, error) => {
    if (!id) return;
    const r = out.get(id) ?? { ok: 0, failed: 0, lastFailAt: null, lastError: null, lastAt: null };
    if (ok) r.ok += 1;
    else {
      r.failed += 1;
      if (!r.lastFailAt || at > r.lastFailAt) Object.assign(r, { lastFailAt: at, lastError: error });
    }
    if (!r.lastAt || at > r.lastAt) Object.assign(r, { lastAt: at, lastOk: ok });
    out.set(id, r);
  };
  const rows = db.prepare("SELECT runner, kind, status, error, detail, finished_at FROM tasks WHERE runner IS NOT NULL AND finished_at >= ? AND status IN ('completed', 'failed')").all(since);
  for (const t of rows) {
    if (t.runner === 'team') {
      let d = null;
      try {
        d = JSON.parse(t.detail ?? 'null');
      } catch {
        d = null;
      }
      for (const s of d?.stages ?? []) {
        if (s.status === 'done') add(s.engine, true, s.finished_at ?? t.finished_at);
        else if (s.status === 'failed' && !CANCELLED.test(s.error ?? '')) add(s.engine, false, s.finished_at ?? t.finished_at, s.error);
        // A hand-over note names an AI that failed before another took over.
        for (const m of String(s.note ?? '').matchAll(/(\S[^.]*?) couldn’t do it \(([^)]*)\)/g)) {
          const e = listEngines().find((x) => x.label === m[1].trim());
          if (e) add(e.id, false, s.finished_at ?? t.finished_at, m[2]);
        }
      }
    } else if (!(t.status === 'failed' && CANCELLED.test(t.error ?? ''))) {
      add(t.runner, t.status === 'completed', t.finished_at, t.error);
    }
  }
  reliabilityCache = { at: Date.now(), value: out };
  return out;
}

function reliability(engineId, rel) {
  const r = rel.get(engineId);
  if (!r) return { factor: 1, note: null };
  // The most recent run failed within the hour: probably signed out or blocked. Try others first.
  if (!r.lastOk && r.lastFailAt && Date.now() - Date.parse(r.lastFailAt) < 3_600_000) {
    return { factor: 0.2, note: `its last run here failed${r.lastError ? ` (${String(r.lastError).slice(0, 80)})` : ''}` };
  }
  const total = r.ok + r.failed;
  if (total >= 3 && r.ok / total < 0.6) return { factor: 0.7, note: `${Math.round((100 * r.ok) / total)}% of its runs here succeeded this week` };
  return { factor: 1, note: null };
}

/** Today's tokens per AI app, to spread work between equally good ones. */
function usageToday() {
  const rows = db.prepare(`SELECT i.adapter, SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)) AS t
    FROM usage_daily u JOIN integrations i ON i.id = u.integration_id WHERE u.day = ? GROUP BY i.adapter`).all(utcDay());
  return new Map(rows.map((r) => [r.adapter === 'claude-assistant' ? 'claude-api' : r.adapter, r.t ?? 0]));
}

function metasByEngine() {
  const out = new Map();
  for (const r of db.prepare('SELECT adapter, meta FROM integrations WHERE meta IS NOT NULL').all()) {
    try {
      out.set(r.adapter, JSON.parse(r.meta));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Ranks the ready AIs for a request. `blend` mixes kinds of work, e.g. a planner for a coding task:
 * [['planning', 0.6], ['code', 0.4]]. Returns { category, label, ranking: [{ engine, score, reasons, notes }] }.
 */
export function rankEngines(text, { needsTools = false, needsFiles = false, exclude = [], blend = null, category = null } = {}) {
  const c = category ? { category, label: CATEGORIES[category] } : classify(text);
  const mix = blend ?? [[c.category, 1]];
  const ready = listEngines().filter((e) => e.ready && !exclude.includes(e.id) && (!needsFiles || e.kind === 'cli'));
  const metas = metasByEngine();
  const rel = reliabilityByEngine();
  const today = usageToday();
  const maxToday = Math.max(1, ...ready.map((e) => today.get(e.id) ?? 0));
  const ranking = ready.map((e) => {
    const st = STRENGTHS[e.id] ?? {};
    const strength = mix.reduce((a, [k, w]) => a + (st[k] ?? 3) * w, 0) / mix.reduce((a, [, w]) => a + w, 0);
    const notes = [];
    let score = strength;
    let blocked = false;
    for (const f of [headroom(e.id, metas), reliability(e.id, rel)]) {
      score *= f.factor;
      if (f.note) notes.push(f.note);
      if (f.factor <= 0.2) blocked = true; // at its limit, or its last run just failed
    }
    if (e.kind === 'api') {
      score *= 0.85;
      notes.push('pay-per-use API key, used after your plans');
    }
    if (needsTools && e.tools === false) {
      score *= 0.85;
      notes.push('can’t use the app’s functions in the chat');
    }
    score *= 1 - 0.06 * ((today.get(e.id) ?? 0) / maxToday); // spread: a little less for the busiest today
    const strong = mix.map(([k]) => k).filter((k) => (st[k] ?? 0) >= 5);
    const reasons = strong.length ? [`one of the strongest for ${strong.map((k) => STRONGEST[k]).join(' and ')}`] : [`good at ${STRONGEST[mix[0][0]]}`];
    return { engine: e, score: Math.round(score * 100) / 100, reasons, notes, blocked };
  });
  ranking.sort((a, b) => b.score - a.score);

  // Your preferred AI for this kind of task goes first, unless it's at its limit or just failed.
  let pref = null;
  if (mix.length === 1) {
    const want = getSettings().route_prefs?.[mix[0][0]];
    if (want && want !== 'auto') {
      const i = ranking.findIndex((x) => x.engine.id === want);
      if (i < 0) pref = { id: want, label: listEngines().find((e) => e.id === want)?.label ?? want, skipped: 'it isn’t ready' };
      else if (ranking[i].blocked) pref = { id: want, label: ranking[i].engine.label, skipped: ranking[i].notes[0] };
      else {
        const [p] = ranking.splice(i, 1);
        ranking.unshift({ ...p, preferred: true, reasons: [`your choice for ${STRONGEST[mix[0][0]]}`] });
      }
    }
  }
  return { ...c, ranking, pref };
}

/** The best AI for a request, with a one-line reason, or null when none is ready. */
export function routeTask(text, opts = {}) {
  const r = rankEngines(text, opts);
  const top = r.ranking[0];
  if (!top) return null;
  // Name only the AIs that would have won on strength alone, so the reason says what changed the choice.
  const skipped = top.preferred ? [] : r.ranking.slice(1).filter((x) => x.notes.length && (STRENGTHS[x.engine.id]?.[r.category] ?? 0) > (STRENGTHS[top.engine.id]?.[r.category] ?? 0));
  const why = `${r.label}: ${top.engine.label}${top.preferred ? `, ${top.reasons[0]}` : ` is ${top.reasons[0]}`}${top.notes.length && !top.preferred ? ` (${top.notes.join('; ')})` : ''}.`
    + (r.pref ? ` Your choice, ${r.pref.label}, was skipped for now: ${r.pref.skipped}.` : '')
    + (skipped.length ? ` Skipped ${skipped.map((x) => `${x.engine.label}: ${x.notes[0]}`).join('; ')}.` : '');
  return { engine: top.engine, category: r.category, label: r.label, why, ranking: r.ranking.map((x) => ({ id: x.engine.id, label: x.engine.label, score: x.score, notes: x.notes })) };
}

/** Keeps the last 300 routing decisions for the Statistics page. */
export function logRoute(kind, decision, text) {
  if (!decision) return;
  db.prepare('INSERT INTO routing_log(at, kind, category, engine, why, preview) VALUES(?, ?, ?, ?, ?, ?)').run(
    nowIso(), kind, decision.category, decision.engine.id, decision.why, String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120));
  db.prepare('DELETE FROM routing_log WHERE id <= (SELECT MAX(id) - 300 FROM routing_log)').run();
}

export const forgetReliability = () => {
  reliabilityCache = { at: 0, value: new Map() };
};
