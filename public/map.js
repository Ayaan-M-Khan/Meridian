/**
 * The AI map: your command center in the middle and the AI tools you connected around it as places, grouped into
 * regions by company. Routes show where your requests go, moving dashes show work running now, and a ring around a
 * place shows how much of its plan limit is used. The closer a place is to the center, the more you used it this month.
 *
 * Drag to move, scroll or use + and − to zoom, search to jump to a place, and switch layers on and off. Everything on
 * the map comes from data the app already has: a place or route with nothing reported is drawn as quiet, never guessed.
 */
export const MAP_LAYERS = { routes: 'Routes', live: 'Live work', team: 'Team hand-offs', limits: 'Plan limits', regions: 'Companies' };
const MIN_K = 0.3;
const MAX_K = 3.2;
const HUB_R = 38;
const LAND = 44; // how far a company's land reaches around each of its places

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (n) => Math.round(n * 10) / 10;

// ── Model: places and routes in map coordinates ──────────────────────────────────────────────────────────────────
function engineIdOf(t) {
  if (t.kind === 'builtin') return 'claude-api';
  return t.engine?.id ?? t.adapter;
}

/** Work running on each AI: tasks this app runs through it, AI team stages it's doing now, and its live sessions. */
function runningByEngine(data) {
  const out = new Map();
  const add = (id, n = 1) => id && out.set(id, (out.get(id) ?? 0) + n);
  for (const t of data.tasks ?? []) {
    if (t.status !== 'running') continue;
    if (t.team) {
      for (const s of t.team.stages ?? []) if (s.status === 'running') add(s.engine);
    } else if (t.runner && t.runner !== 'team') add(t.runner);
  }
  return out;
}

/** How often work passed from one AI to another inside AI team tasks and Ask all. */
function teamHandoffs(data) {
  const pairs = new Map();
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    const k = [a, b].sort().join('|');
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  };
  for (const t of data.tasks ?? []) {
    const stages = (t.team?.stages ?? []).filter((s) => s.status === 'done' || s.status === 'running');
    if (!stages.length) continue;
    if (t.team.mode === 'compare') {
      const merge = stages.find((s) => s.key === 'merge');
      if (merge) for (const s of stages) if (s.key !== 'merge') add(s.engine, merge.engine);
    } else {
      for (let i = 1; i < stages.length; i++) add(stages[i - 1].engine, stages[i].engine);
    }
  }
  return [...pairs.entries()].map(([k, count]) => {
    const [a, b] = k.split('|');
    return { a, b, count };
  });
}

export function buildMapModel(data, stats, h) {
  const apiReady = data.engines?.some((e) => e.id === 'claude-api' && e.ready);
  const tools = data.tools.filter((t) => t.enabled !== false && (t.kind !== 'builtin' || apiReady));
  const routed = new Map((stats?.asks?.by_engine ?? []).map((e) => [e.id, e.count]));
  const perf = new Map((stats?.performance ?? []).map((p) => [p.id, p]));
  const running = runningByEngine(data);
  const engines = new Map((data.engines ?? []).map((e) => [e.id, e]));
  const maxTokens = Math.max(1, ...tools.map((t) => t.tokens_mtd ?? 0));
  const maxRouted = Math.max(1, ...routed.values());

  // Companies in a stable order (busiest first), each a contiguous arc around the center.
  const byVendor = new Map();
  for (const t of tools) {
    const v = t.kind === 'builtin' ? 'Anthropic' : t.vendor ?? 'Other';
    if (!byVendor.has(v)) byVendor.set(v, []);
    byVendor.get(v).push(t);
  }
  const vendors = [...byVendor.entries()]
    .map(([vendor, list]) => ({ vendor, list: list.sort((a, b) => (b.tokens_mtd ?? 0) - (a.tokens_mtd ?? 0) || a.name.localeCompare(b.name)), tokens: list.reduce((s, t) => s + (t.tokens_mtd ?? 0), 0) }))
    .sort((a, b) => b.tokens - a.tokens || a.vendor.localeCompare(b.vendor));
  const gap = vendors.length > 1 ? 0.6 : 0;
  const slots = tools.length + gap * vendors.length;
  const step = slots ? (Math.PI * 2) / slots : 0;

  const nodes = [];
  let slot = gap / 2;
  for (const v of vendors) {
    for (const t of v.list) {
      const angle = -Math.PI / 2 + (slot + 0.5) * step;
      slot += 1;
      const share = t.tokens_mtd ? Math.sqrt(t.tokens_mtd / maxTokens) : 0;
      // More use this month: closer to the center. Nothing reported: out at the edge.
      const dist = t.tokens_mtd ? 170 + 190 * (1 - share) : 390;
      const engineId = engineIdOf(t);
      const eng = engines.get(engineId);
      const lim = t.limits ? Math.max(t.limits.primary?.used_percent ?? -1, t.limits.secondary?.used_percent ?? -1) : -1;
      nodes.push({
        key: `t${t.id}`,
        tool: t,
        name: t.kind === 'builtin' ? 'Claude API' : t.name,
        vendor: v.vendor,
        hue: h.hueOf(t.kind === 'builtin' ? 'Anthropic' : t.vendor),
        engineId,
        engine: eng ?? null,
        status: h.toolStatus(t),
        tokens: t.tokens_mtd ?? null,
        tokensToday: t.tokens_today ?? null,
        routed: routed.get(engineId) ?? 0,
        routedW: routed.get(engineId) ? Math.log1p(routed.get(engineId)) / Math.log1p(maxRouted) : 0,
        perf: perf.get(engineId) ?? null,
        running: (running.get(engineId) ?? 0) + (t.sessions_running ?? 0),
        limitPct: lim >= 0 ? lim : null,
        attention: ['error', 'signin', 'missing'].includes(t.status),
        x: r1(Math.cos(angle) * dist),
        y: r1(Math.sin(angle) * dist),
        r: r1(19 + 15 * share),
        angle,
      });
    }
    slot += gap;
  }

  const byEngine = new Map(nodes.map((n) => [n.engineId, n]));
  const team = teamHandoffs(data).filter((p) => byEngine.has(p.a) && byEngine.has(p.b)).map((p) => ({ ...p, from: byEngine.get(p.a), to: byEngine.get(p.b) }));

  const regions = vendors.map((v) => {
    const ns = nodes.filter((n) => n.vendor === v.vendor).sort((a, b) => a.angle - b.angle);
    const cx = ns.reduce((s, n) => s + n.x, 0) / ns.length;
    const cy = ns.reduce((s, n) => s + n.y, 0) / ns.length;
    const a = Math.atan2(cy, cx) || ns[0].angle;
    const out = Math.max(...ns.map((n) => Math.hypot(n.x, n.y) + n.r)) + LAND + 22;
    return {
      vendor: v.vendor,
      hue: ns[0].hue,
      land: ns.map((n) => ({ x: n.x, y: n.y, r: r1(n.r + LAND) })),
      bridges: ns.slice(1).map((n, i) => ({ x1: ns[i].x, y1: ns[i].y, x2: n.x, y2: n.y })),
      lx: r1(Math.cos(a) * out),
      ly: r1(Math.sin(a) * out + 4),
      count: ns.length,
    };
  });

  const totals = {
    tools: nodes.length,
    running: nodes.reduce((s, n) => s + n.running, 0),
    routed: stats?.asks?.total ?? null,
    attention: nodes.filter((n) => n.attention).length,
  };
  return { nodes, team, regions, totals };
}

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────
const roadPath = (n) => `M0 0 Q${r1(n.x / 2 - n.y * 0.14)} ${r1(n.y / 2 + n.x * 0.14)} ${n.x} ${n.y}`;
function arcPath(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const len = Math.hypot(mx, my);
  const [cx, cy] = len > 30 ? [mx * 1.45, my * 1.45] : [mx - (b.y - a.y) * 0.35, my + (b.x - a.x) * 0.35];
  return `M${a.x} ${a.y} Q${r1(cx)} ${r1(cy)} ${b.x} ${b.y}`;
}
/** Wobbly closed rings around the center, like contour lines around a summit. Decorative only. */
function contour(R) {
  const pts = [];
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r = R + 9 * Math.sin(3 * a + R / 40) + 6 * Math.sin(5 * a + R / 23) + 4 * Math.cos(7 * a + R / 17);
    pts.push(`${r1(Math.cos(a) * r)} ${r1(Math.sin(a) * r)}`);
  }
  return `M${pts.join(' L')}Z`;
}
const nested = (icon, size) => icon.replace('<svg ', `<svg x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" `);

function worldSvg(m, layers, sel, h) {
  const { esc } = h;
  const parts = [];
  parts.push('<rect class="map-sea" x="-4000" y="-4000" width="8000" height="8000" fill="url(#map-grid)"/>');
  parts.push(`<g class="map-contours" aria-hidden="true">${[95, 165, 235, 305, 375, 445, 530, 620].map((R) => `<path d="${contour(R)}"/>`).join('')}</g>`);
  parts.push(`<g class="map-rings" aria-hidden="true">${[170, 270, 390].map((R, i) => `<circle r="${R}"/><text x="${R + 6}" y="-6">${['busiest', '', 'quiet'][i]}</text>`).join('')}</g>`);
  if (layers.regions) {
    parts.push(`<g class="map-regions">${m.regions.map((g) => `<g style="--h: var(--hue-${g.hue})">
      <g class="map-land-edge">${g.land.map((c) => `<circle cx="${c.x}" cy="${c.y}" r="${r1(c.r + 1.5)}"/>`).join('')}${g.bridges.map((b) => `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke-width="${2 * LAND + 3}"/>`).join('')}</g>
      <g class="map-land">${g.land.map((c) => `<circle cx="${c.x}" cy="${c.y}" r="${c.r}"/>`).join('')}${g.bridges.map((b) => `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke-width="${2 * LAND}"/>`).join('')}</g>
      <text class="map-region-label" x="${g.lx}" y="${g.ly}" text-anchor="middle">${esc(g.vendor.toUpperCase())}</text></g>`).join('')}</g>`);
  }
  if (layers.routes) {
    parts.push(`<g class="map-roads">${m.nodes.map((n) => {
      const w = r1(1.4 + 7 * n.routedW);
      const cls = n.status.dot === 'ok' ? 'ok' : n.status.dot === 'err' ? 'err' : n.status.dot === 'warn' ? 'warn' : 'idle';
      return `<path class="map-road-casing" d="${roadPath(n)}" stroke-width="${r1(w + 4)}"/><path class="map-road ${cls} ${n.routed ? '' : 'unused'}" d="${roadPath(n)}" stroke-width="${w}"/>`;
    }).join('')}</g>`);
  }
  if (layers.team && m.team.length) {
    const max = Math.max(...m.team.map((t) => t.count));
    parts.push(`<g class="map-team">${m.team.map((t) => `<path class="map-handoff" d="${arcPath(t.from, t.to)}" stroke-width="${r1(1.4 + 3.5 * (t.count / max))}"><title>${esc(`${t.from.name} and ${t.to.name} handed work to each other ${t.count} time${t.count === 1 ? '' : 's'} in AI team tasks`)}</title></path>`).join('')}</g>`);
  }
  if (layers.live) {
    parts.push(`<g class="map-traffic-layer">${m.nodes.filter((n) => n.running).map((n) => {
      const mx = r1(n.x / 2 - n.y * 0.07);
      const my = r1(n.y / 2 + n.x * 0.07);
      return `<path class="map-traffic" d="${roadPath(n)}"/><g class="map-badge" transform="translate(${mx} ${my})"><rect x="-26" y="-10" width="52" height="20" rx="10"/><text dy="0.35em" text-anchor="middle">${n.running} live</text></g>`;
    }).join('')}</g>`);
  }

  // The center: you and your command center.
  parts.push(`<g class="map-node map-hub ${sel === 'hub' ? 'sel' : ''}" data-key="hub" tabindex="0" role="button" aria-label="${esc(`Your command center: ${m.totals.tools} AI tools${m.totals.running ? `, ${m.totals.running} running now` : ''}`)}">
    <circle class="map-node-halo" r="${HUB_R + 9}"/><circle class="map-hub-glow" r="${HUB_R + 22}"/><circle class="map-hub-body" r="${HUB_R}"/>
    <g class="map-hub-icon">${nested(h.ICON.spark, 30)}</g>
    <text class="map-node-name" y="${HUB_R + 19}" text-anchor="middle">Command center</text>
    <text class="map-node-sub" y="${HUB_R + 33}" text-anchor="middle">You are here</text></g>`);

  for (const n of m.nodes) {
    const label = `${n.name}, ${n.vendor}. ${n.status.label}.${n.tokens != null ? ` ${h.fmtNum(n.tokens)} tokens this month.` : ' No usage reported this month.'}${n.running ? ` ${n.running} running now.` : ''}${n.limitPct != null ? ` ${Math.round(n.limitPct)}% of its plan limit used.` : ''}`;
    const sub = [n.tokens != null ? `${h.fmtNum(n.tokens)} tokens` : null, n.status.label].filter(Boolean).join(' · ');
    const C = 2 * Math.PI * (n.r + 5);
    const limCls = n.limitPct >= 90 ? 'err' : n.limitPct >= 70 ? 'warn' : 'ok';
    parts.push(`<g class="map-node st-${n.status.dot} ${sel === n.key ? 'sel' : ''} ${n.running ? 'busy' : ''}" data-key="${n.key}" transform="translate(${n.x} ${n.y})" tabindex="0" role="button" aria-label="${esc(label)}" style="--h: var(--hue-${n.hue})">
      <circle class="map-node-halo" r="${r1(n.r + 10)}"/>
      ${n.running ? `<circle class="map-node-pulse" r="${r1(n.r + 4)}"/>` : ''}
      ${layers.limits && n.limitPct != null ? `<circle class="map-limit-track" r="${r1(n.r + 5)}"/><circle class="map-limit ${limCls}" r="${r1(n.r + 5)}" stroke-dasharray="${r1((C * Math.min(100, n.limitPct)) / 100)} ${r1(C)}" transform="rotate(-90)"/>` : ''}
      <circle class="map-node-body" r="${n.r}"/>
      <text class="map-node-mono" dy="0.36em" text-anchor="middle">${esc(h.mono(n.tool))}</text>
      <text class="map-node-name" y="${r1(n.r + 20)}" text-anchor="middle">${esc(n.name)}</text>
      <text class="map-node-sub" y="${r1(n.r + 34)}" text-anchor="middle">${esc(sub)}</text>
      ${n.attention ? `<g class="map-pin" transform="translate(${r1(n.r * 0.72)} ${r1(-n.r * 0.95)})"><path d="M0 4 C-7 -3 -7 -14 0 -14 C7 -14 7 -3 0 4Z"/><text y="-5.5" text-anchor="middle">!</text></g>` : ''}
    </g>`);
  }
  return parts.join('');
}

function cardHtml(m, key, h, data) {
  const { esc } = h;
  const stat = (label, value, sub = '') => `<div class="map-stat"><span>${esc(label)}</span><b>${value == null ? '<span class="faint">Not reported</span>' : esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  if (key === 'hub') {
    const next = (data.automations ?? []).filter((a) => a.enabled && a.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
    return `<div class="map-card-head"><span class="logo sm hue-brand">${h.ICON.spark}</span><div class="min0"><b>Command center</b><span class="faint small block">You are here</span></div>
        <button class="btn icon-btn ghost" data-map="close" aria-label="Close">${h.ICON.close}</button></div>
      <div class="map-stats">
        ${stat('AI tools on the map', String(m.totals.tools))}
        ${stat('Running now', String(m.totals.running))}
        ${stat('Requests routed', m.totals.routed == null ? null : String(m.totals.routed), 'Last 30 days')}
        ${stat('Need attention', String(m.totals.attention))}
      </div>
      ${next ? `<p class="small">Next automation: <b>${esc(next.name)}</b> ${esc(h.rel(next.next_run_at))}.</p>` : ''}
      <p class="fine">Every request starts here and takes a route to the AI best suited to it. Routes get wider the more requests take them.</p>
      <div class="form-actions"><a class="btn small" href="#stats">${h.ICON.pulse}Statistics</a><a class="btn small" href="#tasks">${h.ICON.tasks}Tasks</a></div>`;
  }
  const n = m.nodes.find((x) => x.key === key);
  if (!n) return '';
  const t = n.tool;
  const p = n.perf;
  return `<div class="map-card-head">${h.logo(t, 'sm')}<div class="min0"><b>${esc(n.name)}</b><span class="faint small block">${esc(n.vendor)} · ${esc(h.accountLine(t) ?? h.kindLabel(t))}</span></div>
      <button class="btn icon-btn ghost" data-map="close" aria-label="Close">${h.ICON.close}</button></div>
    <div class="pill-row"><span class="pill ${n.status.cls}">${esc(n.status.label)}</span>${n.running ? `<span class="pill s-running">${n.running} running now</span>` : ''}</div>
    ${t.last_error ? `<div class="callout err small">${esc(t.last_error)}</div>` : ''}
    <div class="map-stats">
      ${stat('Tokens this month', n.tokens == null ? null : h.fmtNum(n.tokens))}
      ${stat('Tokens today', n.tokensToday == null ? null : h.fmtNum(n.tokensToday))}
      ${stat('Requests routed here', String(n.routed), 'Last 30 days')}
      ${stat('Finished well', p ? `${Math.round(p.success_pct)}%` : null, p ? `${p.runs} run${p.runs === 1 ? '' : 's'} here` : 'No runs here yet')}
    </div>
    ${t.limits ? `<div class="map-limits">${h.limitMeters(t)}</div>` : ''}
    <p class="fine">${n.tokens != null ? 'Closer to the center means more use this month.' : 'Out at the edge: no usage reported this month.'}</p>
    <div class="form-actions"><a class="btn small" href="#tool-${t.id}">${h.ICON.chevron}Open</a>${n.engine?.ready && !data.demo ? `<button class="btn small primary" data-action="map-chat" data-engine="${esc(n.engineId)}">${h.ICON.chat}Chat with it</button>` : ''}</div>`;
}

/** The same places as a table, for screen readers and anyone who prefers a list. */
export function mapListHtml(m, h) {
  const { esc } = h;
  if (!m.nodes.length) return '';
  return `<div class="table-wrap"><table class="map-table"><thead><tr><th>Place</th><th>Company</th><th>Status</th><th class="num">Tokens this month</th><th class="num">Requests routed (30 days)</th><th class="num">Running now</th><th class="num">Plan limit used</th></tr></thead><tbody>
    ${m.nodes.map((n) => `<tr><td><a href="#tool-${n.tool.id}">${esc(n.name)}</a></td><td>${esc(n.vendor)}</td><td>${esc(n.status.label)}</td><td class="num">${n.tokens == null ? '<span class="faint">Not reported</span>' : esc(h.fmtNum(n.tokens))}</td><td class="num">${n.routed}</td><td class="num">${n.running}</td><td class="num">${n.limitPct == null ? '<span class="faint">Not reported</span>' : `${Math.round(n.limitPct)}%`}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ── The interactive map ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * Mounts the map into `el`. `state` ({ view, sel, layers }) lives with the caller, so the map keeps its place across
 * refreshes. Returns { update(data, stats), destroy() }.
 */
export function mountMap(el, { data, stats, state, h }) {
  const { esc, ICON } = h;
  state.layers ??= { routes: true, live: true, team: true, limits: true, regions: true };
  let model = buildMapModel(data, stats, h);
  let curData = data;
  let W = el.clientWidth || 800;
  let H = el.clientHeight || 560;

  el.innerHTML = `
    <svg class="map-svg" id="map-svg" role="group" aria-label="Map of your AI tools. Drag to move, scroll to zoom." xmlns="http://www.w3.org/2000/svg">
      <defs><pattern id="map-grid" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" class="map-grid-line"/></pattern></defs>
      <g id="map-world"></g>
    </svg>
    <div class="map-top">
      <div class="map-search" role="search"><span aria-hidden="true">${ICON.map}</span><input id="map-q" type="search" placeholder="Search the map" autocomplete="off" aria-label="Search the map for a tool" aria-controls="map-results"><div class="map-results" id="map-results" role="listbox" hidden></div></div>
      <div class="map-layers" role="group" aria-label="Map layers">${Object.entries(MAP_LAYERS).map(([k, v]) => `<button type="button" class="map-chip" data-map="layer" data-layer="${k}" aria-pressed="${Boolean(state.layers[k])}">${esc(v)}</button>`).join('')}</div>
    </div>
    <div class="map-controls" role="group" aria-label="Zoom">
      <button type="button" class="map-ctl" data-map="zoom-in" aria-label="Zoom in" title="Zoom in (+)">${ICON.plus}</button>
      <span class="map-zoom-level" id="map-zoom" aria-live="polite"></span>
      <button type="button" class="map-ctl" data-map="zoom-out" aria-label="Zoom out" title="Zoom out (−)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 8h10"/></svg></button>
      <button type="button" class="map-ctl map-compass" data-map="fit" aria-label="Show the whole map" title="Show the whole map (0)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" class="cmp-ring"/><path d="M12 3.5l2.6 8.5L12 20.5 9.4 12z" class="cmp-s"/><path d="M12 3.5l2.6 8.5H9.4z" class="cmp-n"/><text x="12" y="2.6" text-anchor="middle" class="cmp-t">N</text></svg></button>
    </div>
    <div class="map-mini" aria-hidden="true"><svg id="map-mini"></svg></div>
    <details class="map-legend" ${state.legend === false ? '' : 'open'}><summary>Legend</summary>
      <ul>
        <li><span class="lg lg-road"></span>Route: wider means more requests went there in the last 30 days</li>
        <li><span class="lg lg-traffic"></span>Moving dashes: work running there now</li>
        <li><span class="lg lg-handoff"></span>Team hand-offs between AIs</li>
        <li><span class="lg lg-limit"></span>Ring: share of the plan limit used</li>
        <li><span class="lg lg-near"></span>Closer to the center: more use this month</li>
        <li><span class="lg lg-pin"></span>Pin: needs your attention</li>
      </ul></details>
    <aside class="map-card" id="map-card" aria-live="polite" hidden></aside>
    ${model.nodes.length ? '' : `<div class="map-empty"><b>Your map is empty</b><span>Connect an AI tool and it appears here as a place.</span><button class="btn small primary" data-action="add-tool">${ICON.plus}Connect a tool</button></div>`}`;

  const svg = el.querySelector('#map-svg');
  const world = el.querySelector('#map-world');
  const mini = el.querySelector('#map-mini');
  const card = el.querySelector('#map-card');
  const zoomLabel = el.querySelector('#map-zoom');

  function bounds() {
    const xs = [-HUB_R - 60, HUB_R + 60];
    const ys = [-HUB_R - 60, HUB_R + 60];
    for (const n of model.nodes) {
      xs.push(n.x - n.r - 70, n.x + n.r + 70);
      ys.push(n.y - n.r - 30, n.y + n.r + 50);
    }
    if (state.layers.regions) for (const g of model.regions) {
      for (const c of g.land) {
        xs.push(c.x - c.r, c.x + c.r);
        ys.push(c.y - c.r, c.y + c.r);
      }
      xs.push(g.lx - 50, g.lx + 50);
      ys.push(g.ly - 16, g.ly + 8);
    }
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  function fitView() {
    const b = bounds();
    const top = W < 760 ? 100 : 58;
    const left = W >= 760 && state.legend !== false ? 40 : 0;
    const k = clamp(Math.min((W - left - 40) / (b.x1 - b.x0), (H - top - 24) / (b.y1 - b.y0)), MIN_K, 1.4);
    return { k, x: left + (W - left) / 2 - ((b.x0 + b.x1) / 2) * k, y: top + (H - top) / 2 - ((b.y0 + b.y1) / 2) * k };
  }
  state.view ??= fitView();

  function applyView() {
    const v = state.view;
    world.setAttribute('transform', `translate(${r1(v.x)} ${r1(v.y)}) scale(${v.k.toFixed(3)})`);
    zoomLabel.textContent = `${Math.round(v.k * 100)}%`;
    el.style.setProperty('--map-k', v.k.toFixed(3));
    el.classList.toggle('far', v.k < 0.6);
    drawMiniView();
  }

  function drawWorld() {
    world.innerHTML = worldSvg(model, state.layers, state.sel, h);
    drawMini();
    applyView();
  }

  let miniB = null;
  function drawMini() {
    const b = bounds();
    const pad = 60;
    miniB = { x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + 2 * pad, h: b.y1 - b.y0 + 2 * pad };
    mini.setAttribute('viewBox', `${r1(miniB.x)} ${r1(miniB.y)} ${r1(miniB.w)} ${r1(miniB.h)}`);
    mini.innerHTML = `${model.regions.map((g) => `<g class="mm-region" style="--h: var(--hue-${g.hue})">${g.land.map((c) => `<circle cx="${c.x}" cy="${c.y}" r="${c.r}"/>`).join('')}${g.bridges.map((b) => `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke-width="${2 * LAND}"/>`).join('')}</g>`).join('')}
      ${model.nodes.map((n) => `<path class="mm-road" d="${roadPath(n)}"/>`).join('')}
      <circle class="mm-hub" r="${HUB_R}"/>${model.nodes.map((n) => `<circle class="mm-node st-${n.status.dot}" cx="${n.x}" cy="${n.y}" r="${Math.max(14, n.r)}"/>`).join('')}
      <rect class="mm-view" id="mm-view"/>`;
  }
  function drawMiniView() {
    const r = mini.querySelector('#mm-view');
    if (!r) return;
    const v = state.view;
    r.setAttribute('x', r1(-v.x / v.k));
    r.setAttribute('y', r1(-v.y / v.k));
    r.setAttribute('width', r1(W / v.k));
    r.setAttribute('height', r1(H / v.k));
  }

  function showCard() {
    if (!state.sel || (state.sel !== 'hub' && !model.nodes.some((n) => n.key === state.sel))) {
      state.sel = null;
      card.hidden = true;
      card.innerHTML = '';
      return;
    }
    card.innerHTML = cardHtml(model, state.sel, h, curData);
    card.hidden = false;
  }
  function select(key, { fly = false } = {}) {
    state.sel = key;
    for (const g of world.querySelectorAll('.map-node')) g.classList.toggle('sel', g.dataset.key === key);
    showCard();
    if (fly && key) {
      const n = key === 'hub' ? { x: 0, y: 0 } : model.nodes.find((x) => x.key === key);
      if (n) flyTo(n.x, n.y, Math.max(state.view.k, 1));
    }
  }

  let anim = 0;
  function flyTo(x, y, k = state.view.k) {
    // Leave room for the place card on the right when it's open.
    const offset = card.hidden || W < 700 ? 0 : 150;
    const target = { k, x: W / 2 - offset - x * k, y: H / 2 - y * k };
    cancelAnimationFrame(anim);
    if (reducedMotion()) {
      state.view = target;
      return applyView();
    }
    const from = { ...state.view };
    const t0 = performance.now();
    const stepF = (now) => {
      const p = Math.min(1, (now - t0) / 320);
      const e = 1 - (1 - p) ** 3;
      state.view = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      applyView();
      if (p < 1) anim = requestAnimationFrame(stepF);
    };
    anim = requestAnimationFrame(stepF);
  }
  function zoomAt(px, py, factor) {
    const v = state.view;
    const k = clamp(v.k * factor, MIN_K, MAX_K);
    state.view = { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
    applyView();
  }
  const pan = (dx, dy) => {
    state.view = { ...state.view, x: state.view.x + dx, y: state.view.y + dy };
    applyView();
  };

  // Dragging to move, with a click on a place selecting it. Two fingers pinch to zoom.
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: state.view.k };
      drag = null;
      return;
    }
    drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false, key: e.target.closest('.map-node')?.dataset.key ?? null };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const rect = svg.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, (pinch.k * (d / pinch.d)) / state.view.k);
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    el.classList.add('dragging');
    state.view = { ...state.view, x: drag.vx + dx, y: drag.vy + dy };
    applyView();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && e.type === 'pointerup') select(drag.key === state.sel ? null : drag.key);
    if (!pointers.size) {
      drag = null;
      el.classList.remove('dragging');
    }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
  }, { passive: false });

  // Keyboard: arrows move, + and − zoom, 0 shows everything, Enter opens a focused place, Escape closes its card.
  el.addEventListener('keydown', (e) => {
    if (e.target.id === 'map-q') {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.querySelector('#map-results [data-key]')?.click();
      } else if (e.key === 'Escape') {
        e.target.value = '';
        search('');
      }
      return;
    }
    if (e.target.closest('.map-card, .map-legend, .map-top, .map-controls') && !['Escape'].includes(e.key)) return;
    const node = e.target.closest?.('.map-node');
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      return select(node.dataset.key, { fly: true });
    }
    const moves = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
    if (moves[e.key] && !node) {
      e.preventDefault();
      return pan(...moves[e.key]);
    }
    if (e.key === '+' || e.key === '=') return zoomAt(W / 2, H / 2, 1.25);
    if (e.key === '-' || e.key === '_') return zoomAt(W / 2, H / 2, 0.8);
    if (e.key === '0') {
      cancelAnimationFrame(anim);
      state.view = fitView();
      return applyView();
    }
    if (e.key === 'Escape' && state.sel) {
      e.stopPropagation();
      select(null);
    }
  });

  // Map controls (kept apart from the app's own data-action buttons).
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-map]');
    if (!b) return;
    const act = b.dataset.map;
    if (act === 'zoom-in') zoomAt(W / 2, H / 2, 1.3);
    else if (act === 'zoom-out') zoomAt(W / 2, H / 2, 1 / 1.3);
    else if (act === 'fit') {
      const f = fitView();
      flyTo((W / 2 - f.x) / f.k, (H / 2 - f.y) / f.k, f.k);
    } else if (act === 'close') select(null);
    else if (act === 'layer') {
      state.layers[b.dataset.layer] = !state.layers[b.dataset.layer];
      b.setAttribute('aria-pressed', String(state.layers[b.dataset.layer]));
      drawWorld();
    } else if (act === 'goto') {
      el.querySelector('#map-q').value = '';
      search('');
      select(b.dataset.key, { fly: true });
    }
  });
  el.querySelector('.map-legend').addEventListener('toggle', (e) => {
    state.legend = e.target.open;
    h.remember?.('acc-map-legend', e.target.open ? '1' : '0');
  });

  // Clicking the minimap moves the view there.
  mini.addEventListener('pointerdown', (e) => {
    const rect = mini.getBoundingClientRect();
    const scale = Math.max(miniB.w / rect.width, miniB.h / rect.height);
    const ox = (rect.width * scale - miniB.w) / 2;
    const oy = (rect.height * scale - miniB.h) / 2;
    const wx = miniB.x + (e.clientX - rect.left) * scale - ox;
    const wy = miniB.y + (e.clientY - rect.top) * scale - oy;
    flyTo(wx, wy);
  });

  function search(q) {
    const box = el.querySelector('#map-results');
    const s = q.trim().toLowerCase();
    if (!s) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const hits = [{ key: 'hub', name: 'Command center', vendor: 'You' }, ...model.nodes]
      .filter((n) => `${n.name} ${n.vendor}`.toLowerCase().includes(s))
      .slice(0, 6);
    box.innerHTML = hits.length
      ? hits.map((n) => `<button type="button" role="option" data-map="goto" data-key="${n.key}"><b>${esc(n.name)}</b><span>${esc(n.vendor)}</span></button>`).join('')
      : '<div class="map-noresult">No place by that name. Connect it on the AI Tools page.</div>';
    box.hidden = false;
  }
  el.querySelector('#map-q').addEventListener('input', (e) => search(e.target.value));

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    const hh = el.clientHeight;
    if (!w || !hh || (w === W && hh === H)) return;
    // Keep the same point in the middle when the window changes size.
    const v = state.view;
    state.view = { ...v, x: v.x + (w - W) / 2, y: v.y + (hh - H) / 2 };
    W = w;
    H = hh;
    applyView();
  });
  ro.observe(el);

  drawWorld();
  showCard();

  return {
    model: () => model,
    update(nextData, nextStats) {
      curData = nextData;
      model = buildMapModel(nextData, nextStats, h);
      const focused = document.activeElement?.closest?.('.map-node')?.dataset.key;
      drawWorld();
      showCard();
      if (focused) world.querySelector(`.map-node[data-key="${focused}"]`)?.focus({ preventScroll: true });
    },
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(anim);
    },
  };
}
