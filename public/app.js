// ── Helpers ──────────────────────────────────────────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtUsd = (n) => (n == null ? null : n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);
const fmtNum = (n) =>
  n == null ? null : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
const fmtPct = (n) => (n == null ? null : `${Math.round(n)}%`);
const or = (v, label = 'Not available') => (v == null ? `<span class="faint">${esc(label)}</span>` : esc(v));
function rel(iso) {
  if (!iso) return null;
  const s = (Date.now() - Date.parse(iso)) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'just now';
  const v = a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return s < 0 ? `in ${v}` : `${v} ago`;
}
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
const utcToday = () => new Date().toISOString().slice(0, 10);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const reportingCost = (n) => `From ${plural(n, 'tool')} that report${n === 1 ? 's' : ''} cost`;

const ICON = {
  grid: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.4"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.4"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.4"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.4"/></svg>',
  tools: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="4" rx="1.2"/><rect x="2" y="10" width="12" height="4" rx="1.2"/><circle cx="5" cy="4" r=".6" fill="currentColor"/><circle cx="5" cy="12" r=".6" fill="currentColor"/></svg>',
  chart: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14h12"/><path d="M4 11V8M8 11V4M12 11V6.5"/></svg>',
  tasks: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8M6 8h8M6 12h8"/><path d="M2 4l.8.8L4 3.4M2 8l.8.8L4 7.4M2 12l.8.8L4 11.4"/></svg>',
  bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2a4.5 4.5 0 0 0-4.5 4.5V9L2.5 11h11l-1-2V6.5A4.5 4.5 0 0 0 8 2z"/><path d="M6.5 13.2a1.6 1.6 0 0 0 3 0"/></svg>',
  gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7-4.5z"/></svg>',
  clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.2l2 1.3"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.3l3 3 6-6.5"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l6 10.6H2z"/><path d="M8 6.5v2.8M8 11.2v.1"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6M8 5.2v.1"/></svg>',
  spark: '<svg viewBox="0 0 16 16"><path d="M8 1.2l1.7 4.6 4.6 1.7-4.6 1.7L8 13.8 6.3 9.2 1.7 7.5l4.6-1.7z"/></svg>',
};

const PAGES = {
  dashboard: { title: 'Overview', icon: 'grid', short: 'Home' },
  tools: { title: 'AI Tools', icon: 'tools', short: 'Tools' },
  usage: { title: 'Usage & Costs', icon: 'chart', short: 'Usage' },
  tasks: { title: 'Tasks', icon: 'tasks', short: 'Tasks' },
  notifications: { title: 'Alerts', icon: 'bell', short: 'Alerts' },
  settings: { title: 'Settings', icon: 'gear', short: 'Settings' },
};
const TASK_STATUS = {
  running: { label: 'Running', icon: 'play', pill: 's-running' },
  queued: { label: 'Queued', icon: 'clock', pill: 's-queued' },
  scheduled: { label: 'Scheduled', icon: 'clock', pill: 's-scheduled' },
  completed: { label: 'Completed', icon: 'check', pill: 's-completed' },
  failed: { label: 'Failed', icon: 'x', pill: 's-failed' },
};
const SEVERITY_ICON = { err: 'x', warn: 'warn', ok: 'check', info: 'info' };
const CAP_NAME = { usage: 'Usage', cost: 'Cost', limits: 'Limits', tasks: 'Tasks', control: 'Controls' };
const CAP_SHORT = { api: 'API', manual: 'You log it', webhook: 'Your scripts', none: 'None' };
const CAP_LONG = {
  api: 'Read automatically from the provider’s official API',
  manual: 'Entered by you in this app',
  webhook: 'Reported by your own scripts with the ingest token',
  none: 'Not available for this service',
};
const NOTIFY_LABELS = {
  task_failed: ['Failed tasks', 'When a reported task fails'],
  task_completed: ['Completed tasks', 'When a reported task finishes'],
  scheduled: ['Upcoming scheduled tasks', 'An hour before a scheduled task starts'],
  usage_warning: ['Budget warnings', 'When a tool or your total passes the warning level'],
  limit_reached: ['Budget reached', 'When a tool or your total reaches its budget'],
  connection: ['Connection failures', 'When a tool can’t sync from its API'],
  spike: ['Unusual spending', 'When a day costs far more than the previous week’s average'],
};

const S = {
  user: null,
  data: null,
  demo: readDemo(),
  page: pageFromHash(),
  taskFilter: 'all',
  catalog: null,
  add: null,
  charts: [],
  loadError: null,
  timer: null,
};

function readDemo() {
  try { return localStorage.getItem('acc-demo') === '1'; } catch { return false; }
}
function writeDemo(v) {
  try { localStorage.setItem('acc-demo', v ? '1' : '0'); } catch { /* storage unavailable */ }
}
function pageFromHash() {
  const h = location.hash.slice(1);
  return PAGES[h] ? h : 'dashboard';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-acc-request': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    S.user = null;
    await showAuth();
    throw new Error(json.error || 'Sign in to continue.');
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 3000);
}

// ── Auth ─────────────────────────────────────────────────────────────────
async function showAuth() {
  closeModal();
  clearInterval(S.timer);
  const st = await fetch('/api/auth/status').then((r) => r.json()).catch(() => ({ setupRequired: false }));
  const setup = st.setupRequired;
  const preset = new URLSearchParams(location.search).get('setup');
  const codeField = preset
    ? `<input type="hidden" name="setupCode" value="${esc(preset)}">`
    : '<div class="field"><label for="f-code">Setup code</label><input class="input" id="f-code" name="setupCode" autocomplete="one-time-code" required></div>';
  $('#root').innerHTML = `
  <div class="auth"><div class="card">
    <div class="brand-mark">${ICON.spark}</div>
    <h1>${setup ? 'Create your account' : 'Sign in'}</h1>
    <p>${setup ? `This is the only account for this AI Command Center.${preset ? '' : ' The setup code is printed in the server console.'}` : 'Sign in to AI Command Center.'}</p>
    <form class="form" data-form="${setup ? 'setup' : 'login'}">
      <div class="field"><label for="f-user">Username</label><input class="input" id="f-user" name="username" autocomplete="username" required></div>
      <div class="field"><label for="f-pass">Password</label><input class="input" id="f-pass" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 10 : 1}" required>${setup ? '<span class="help">At least 10 characters.</span>' : ''}</div>
      ${setup ? codeField : ''}
      <button class="btn primary" type="submit">${setup ? 'Create account' : 'Sign in'}</button>
      <div class="error-text" data-error></div>
    </form>
  </div></div>`;
  $('#f-user')?.focus();
}

// ── Shell ────────────────────────────────────────────────────────────────
function renderShell() {
  const nav = (key, cls = '') => `<a href="#${key}" data-nav="${key}" class="${cls}">${ICON[PAGES[key].icon]}<span>${PAGES[key].title}</span><span class="count" data-count="${key}" hidden></span></a>`;
  const tab = (key) => `<a href="#${key}" data-nav="${key}">${ICON[PAGES[key].icon]}<span>${PAGES[key].short}</span><span class="dot-badge" data-count="${key}" hidden></span></a>`;
  $('#root').innerHTML = `
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">${ICON.spark}</div><div class="brand-name">AI Command Center</div></div>
      <nav class="nav" aria-label="Main">
        ${nav('dashboard')}${nav('tools')}
        <div class="nav-label">Monitor</div>
        ${nav('usage')}${nav('tasks')}${nav('notifications')}
        <div class="nav-label">System</div>
        ${nav('settings')}
      </nav>
      <div class="sidebar-foot"><span class="who">Signed in as ${esc(S.user.username)}</span><button class="btn small ghost" data-action="logout">Sign out</button></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <h1 id="page-title"></h1>
        <span class="updated hide-sm" id="updated"></span>
        <button class="btn icon-btn ghost" data-action="reload" aria-label="Refresh">${ICON.refresh}</button>
        <a class="btn icon-btn ghost" href="#notifications" aria-label="Alerts">${ICON.bell}<span class="dot-badge" id="bell-count" hidden></span></a>
        <a class="btn icon-btn ghost" href="#settings" aria-label="Settings">${ICON.gear}</a>
      </header>
      <div class="demo-banner" id="demo-banner" hidden>
        <span>You’re looking at demo data. None of it comes from your accounts.</span>
        <button class="btn small" data-action="toggle-demo">Exit demo</button>
      </div>
      <main class="content" id="content"></main>
      <nav class="tabbar" aria-label="Main">${['dashboard', 'tools', 'usage', 'tasks', 'notifications'].map(tab).join('')}</nav>
    </div>
  </div>`;
}

function updateChrome() {
  const d = S.data;
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === S.page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('#page-title').textContent = PAGES[S.page].title;
  document.title = `${PAGES[S.page].title} · AI Command Center`;
  $('#demo-banner').hidden = !S.demo;
  $('#updated').textContent = S.loadError ? 'Couldn’t refresh' : d ? `Updated ${rel(d.generated_at)}` : '';
  const counts = d ? { tools: d.stats.needs_attention, tasks: d.stats.running, notifications: d.unread } : {};
  document.querySelectorAll('[data-count]').forEach((el) => {
    const n = counts[el.dataset.count];
    el.hidden = !n;
    el.textContent = n || '';
    el.classList.toggle('alert', el.dataset.count !== 'tasks');
  });
  const bell = $('#bell-count');
  bell.hidden = !d?.unread;
  bell.textContent = d?.unread || '';
}

async function load({ force = false } = {}) {
  try {
    S.data = await api(S.demo ? '/api/demo' : '/api/state');
    S.loadError = null;
  } catch (err) {
    S.loadError = err.message;
    if (!S.user) return;
  }
  updateChrome();
  const typing = document.activeElement?.closest?.('#content') && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (force || !(typing || (S.page === 'settings' && $('#content')?.dataset.page === 'settings'))) renderPage();
}

function renderPage() {
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
  const el = $('#content');
  if (!el) return;
  el.dataset.page = S.page;
  if (!S.data) {
    el.innerHTML = S.loadError ? `<div class="page"><div class="callout err">${esc(S.loadError)}</div></div>` : '<div class="empty">Loading…</div>';
    return;
  }
  el.innerHTML = `<div class="page">${S.loadError ? `<div class="callout err">Couldn’t refresh: ${esc(S.loadError)}</div>` : ''}${VIEWS[S.page]()}</div>`;
  AFTER[S.page]?.();
}

// ── Shared fragments ─────────────────────────────────────────────────────
const statusIcon = (status) => `<div class="status-ico ${TASK_STATUS[status].pill}">${ICON[TASK_STATUS[status].icon]}</div>`;
const pill = (cls, label) => `<span class="pill ${cls}">${esc(label)}</span>`;
const initials = (name) => esc(name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?');
const barCls = (pct, warnAt) => (pct >= 100 ? 'err' : pct >= warnAt ? 'warn' : '');
const bar = (pct, cls = '', thin = false) => `<div class="bar ${cls} ${thin ? 'thin' : ''}"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>`;

function toolStatus(t) {
  return {
    ok: { label: 'Synced', cls: 's-ok' },
    pending: { label: 'Waiting for first sync', cls: 's-info' },
    error: { label: 'Sync failed', cls: 's-err' },
    tracked: { label: 'Tracked manually', cls: 's-queued' },
    disabled: { label: 'Off', cls: 's-queued' },
  }[t.status] ?? { label: t.status, cls: 's-queued' };
}

function capShort(key, level) {
  if (key === 'limits' && level === 'manual') return 'Your budget';
  return CAP_SHORT[level] ?? level;
}

function taskWhen(t) {
  if (t.status === 'running') return t.started_at ? `Started ${rel(t.started_at)}` : 'Running';
  if (t.status === 'scheduled' && t.scheduled_for && Date.parse(t.scheduled_for) < Date.now())
    return `Was due ${when(t.scheduled_for)}, no update since`;
  if (t.status === 'scheduled') return t.scheduled_for ? `Scheduled ${when(t.scheduled_for)}` : 'Scheduled';
  if (t.status === 'queued') return `Queued ${rel(t.updated_at)}`;
  return t.finished_at ? `${TASK_STATUS[t.status].label} ${rel(t.finished_at)}` : TASK_STATUS[t.status].label;
}

function taskRow(t, { compact = false } = {}) {
  const prog = t.status === 'running' && t.progress != null;
  return `<button class="row" data-action="open-task" data-id="${t.id}">
    ${statusIcon(t.status)}
    <div class="row-main">
      <div class="row-title">${esc(t.name)}</div>
      <div class="row-sub">${esc(t.tool_name)} · ${esc(taskWhen(t))}${t.eta && t.status === 'running' ? ` · done ${esc(rel(t.eta))}` : ''}</div>
      ${prog ? `<div style="margin-top:7px;display:flex;align-items:center;gap:8px"><div style="flex:1">${bar(t.progress, 'info', true)}</div><span class="faint num" style="font-size:11.5px">${Math.round(t.progress)}%</span></div>` : ''}
      ${t.status === 'failed' && t.error && !compact ? `<div class="row-sub" style="color:var(--err)">${esc(t.error)}</div>` : ''}
    </div>
    ${compact ? '' : pill(TASK_STATUS[t.status].pill, TASK_STATUS[t.status].label)}
  </button>`;
}

function emptyBlock(title, text, action = '') {
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}${action ? `<div style="margin-top:12px">${action}</div>` : ''}</div>`;
}

function tile(label, value, sub, cls = '', naLabel = 'Not reported') {
  return `<div class="tile ${cls}"><div class="tile-label">${esc(label)}</div>
    ${value == null ? `<div class="tile-value na">${esc(naLabel)}</div>` : `<div class="tile-value">${esc(value)}</div>`}
    <div class="tile-sub">${esc(sub)}</div></div>`;
}

// ── Views ────────────────────────────────────────────────────────────────
const VIEWS = {
  dashboard() {
    const d = S.data;
    const s = d.stats;
    if (!d.demo && !d.tools.length) {
      return `<div class="card" style="padding:28px">
        <div class="page-head"><div><h2>Connect your first AI tool</h2>
        <p>Add an API integration to pull usage and cost automatically, or track a tool manually and have your scripts report its tasks.</p></div></div>
        <div class="form-actions" style="margin-top:18px"><button class="btn primary" data-action="add-tool">Add a tool</button><button class="btn" data-action="toggle-demo">Explore with demo data</button></div>
      </div>`;
    }
    const warnAt = d.settings.usage_warn_pct;
    const ceilPct = s.ceiling_usd && s.cost_mtd != null ? (s.cost_mtd / s.ceiling_usd) * 100 : null;
    const running = d.tasks.filter((t) => t.status === 'running');
    const budgeted = d.tools.filter((t) => t.enabled && t.budget_usd);
    const unbudgeted = d.tools.filter((t) => t.enabled && !t.budget_usd);
    const sm = d.summary;
    const smSource = !sm ? '' : sm.source === 'ai' ? 'Written by Claude from your data' : sm.source === 'demo' ? 'Sample summary' : 'Generated from your data';

    return `<div class="dash">
      <div class="tiles a-tiles">
        ${tile('Tools connected', s.connected, s.needs_attention ? `${s.active} active · ${s.needs_attention} need attention` : `${s.active} active now`, s.needs_attention ? 'warn' : '')}
        ${tile('Running tasks', s.running, `${s.queued} queued · ${s.scheduled} scheduled`, s.running ? 'info' : '')}
        ${tile('Spend today', fmtUsd(s.cost_today), s.cost_today == null ? 'API data can lag several hours' : reportingCost(s.tools_reporting_cost))}
        ${tile('Spend this month', fmtUsd(s.cost_mtd), ceilPct != null ? `${Math.round(ceilPct)}% of ${fmtUsd(s.ceiling_usd)} ceiling` : 'No monthly ceiling set', ceilPct == null ? '' : barCls(ceilPct, warnAt))}
        ${tile('Completed today', s.completed_today, 'Tasks your tools reported')}
        ${tile('Failed today', s.failed_today, s.failed_today ? 'Open Tasks to see why' : 'Nothing has failed', s.failed_today ? 'err' : '')}
      </div>

      <section class="card summary a-summary">
        <div class="card-head"><svg width="13" height="13" viewBox="0 0 16 16" fill="var(--accent)" aria-hidden="true"><path d="M8 1.2l1.7 4.6 4.6 1.7-4.6 1.7L8 13.8 6.3 9.2 1.7 7.5l4.6-1.7z"/></svg><h3>Daily summary</h3></div>
        <p>${esc(sm?.text ?? 'No summary yet. It is generated after the first sync, or you can generate one now.')}</p>
        <div class="meta">
          ${sm ? `<span>${esc(smSource)} · ${esc(rel(sm.generated_at))}</span>` : ''}
          ${sm?.error ? `<span style="color:var(--warn)">${esc(sm.error)}</span>` : ''}
          ${!d.demo ? '<button class="btn small ghost" data-action="refresh-summary">Regenerate</button>' : ''}
        </div>
      </section>

      <section class="card a-running">
        <div class="card-head"><h3>Running now</h3><a class="aside" href="#tasks">All tasks</a></div>
        ${running.length ? `<div class="rows">${running.slice(0, 6).map((t) => taskRow(t, { compact: true })).join('')}</div>` : emptyBlock('Nothing is running', 'Tasks show up here when your agents report them.')}
      </section>

      <section class="card a-upcoming">
        <div class="card-head"><h3>Up next</h3><span class="aside">${plural(d.upcoming.length, 'task')}</span></div>
        ${d.upcoming.length ? `<div class="rows">${d.upcoming.slice(0, 6).map((t) => taskRow(t, { compact: true })).join('')}</div>` : emptyBlock('Nothing is scheduled', 'Queued and scheduled tasks appear here.')}
      </section>

      <section class="card a-limits">
        <div class="card-head"><h3>Budgets and limits</h3><a class="aside" href="#usage">Usage</a></div>
        ${s.ceiling_usd ? `<div class="meter"><div class="meter-top"><span>All tools this month</span><b>${or(fmtUsd(s.cost_mtd), 'No cost data')} / ${esc(fmtUsd(s.ceiling_usd))}</b></div>${bar(ceilPct ?? 0, barCls(ceilPct ?? 0, warnAt))}</div>` : ''}
        ${budgeted.map((t) => `<div class="meter"><div class="meter-top"><span>${esc(t.name)}</span><b>${t.budget_pct == null ? '<span class="faint">No cost data</span>' : `${esc(fmtUsd(t.cost_mtd))} / ${esc(fmtUsd(t.budget_usd))}`}</b></div>${bar(t.budget_pct ?? 0, barCls(t.budget_pct ?? 0, warnAt))}</div>`).join('')}
        ${!budgeted.length && !s.ceiling_usd ? emptyBlock('No budgets set', 'Set a monthly budget on a tool, or a ceiling in Settings, to track limits here.') : ''}
        ${unbudgeted.length && (budgeted.length || s.ceiling_usd) ? `<p class="faint" style="font-size:12px;margin:10px 0 0">No budget set for ${esc(unbudgeted.map((t) => t.name).join(', '))}.</p>` : ''}
        <p class="faint" style="font-size:12px;margin:10px 0 0">Plan limits on ChatGPT, Claude.ai, Cursor and Copilot are not available through their APIs, so they don’t appear here.</p>
      </section>

      <section class="card a-activity">
        <div class="card-head"><h3>Recent activity</h3></div>
        ${d.feed.length ? `<div class="rows">${d.feed.slice(0, 8).map((e) => {
          const sev = e.kind.includes('failed') ? 'err' : e.kind === 'connection' && /fail/.test(e.message) ? 'err' : e.kind.includes('completed') ? 'ok' : 'info';
          return `<div class="row"><div class="status-ico s-${sev}">${ICON[SEVERITY_ICON[sev]]}</div><div class="row-main"><div class="row-sub" style="color:var(--text)">${esc(e.message)}</div></div><div class="row-time">${esc(rel(e.created_at))}</div></div>`;
        }).join('')}</div>` : emptyBlock('No activity yet', 'Syncs, task updates and connection changes are listed here.')}
      </section>
    </div>`;
  },

  tools() {
    const d = S.data;
    const warnAt = d.settings.usage_warn_pct;
    const card = (t) => {
      const st = toolStatus(t);
      const caps = Object.entries(t.capabilities).map(([k, v]) => `<span class="cap ${v === 'none' ? 'none' : ''}">${CAP_NAME[k]}: <b>${esc(capShort(k, v))}</b></span>`).join('');
      const activity = t.last_error
        ? `<span class="dotx err"></span><span style="color:var(--err)">${esc(t.last_error)}</span>`
        : t.current_activity
          ? `<span class="dotx on"></span><span>Running: ${esc(t.current_activity)}</span>`
          : `<span class="dotx"></span><span>${t.active ? 'Recently active' : 'Idle'}</span>`;
      const foot = t.can_sync ? (t.last_sync_at ? `Synced ${rel(t.last_sync_at)}` : 'Not synced yet') : 'No API sync';
      const last = t.last_activity_at ? `Active ${rel(t.last_activity_at)}` : t.last_usage_day ? `Last usage ${shortDay(t.last_usage_day)}` : 'No activity yet';
      return `<article class="card tool" role="button" tabindex="0" data-action="open-tool" data-id="${t.id}">
        <div class="tool-head"><div class="logo">${initials(t.name)}</div>
          <div style="min-width:0"><div class="tool-name">${esc(t.name)}</div><div class="tool-kind">${esc(t.adapter_name)} · ${esc(t.vendor)}</div></div>
          ${pill(st.cls, st.label)}</div>
        <div class="caps">${caps}</div>
        <dl class="kv">
          <div><dt>Spend this month</dt><dd class="${t.cost_mtd == null ? 'na' : ''}">${or(fmtUsd(t.cost_mtd))}</dd></div>
          <div><dt>Tokens this month</dt><dd class="${t.tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.tokens_mtd))}</dd></div>
        </dl>
        ${t.budget_usd ? `<div class="meter" style="padding:0"><div class="meter-top"><span class="muted">Monthly budget</span><b>${t.budget_pct == null ? '<span class="faint">No cost data</span>' : `${esc(fmtPct(t.budget_pct))} of ${esc(fmtUsd(t.budget_usd))}`}</b></div>${bar(t.budget_pct ?? 0, barCls(t.budget_pct ?? 0, warnAt))}</div>` : '<div class="faint" style="font-size:12px">No monthly budget set</div>'}
        <div class="tool-activity">${activity}</div>
        <div class="tool-foot"><span>${esc(foot)}</span><span>${esc(last)}</span></div>
      </article>`;
    };
    return `<div class="page-head"><div><h2>AI Tools</h2><p>${plural(d.tools.length, 'tool')} · each card shows what that integration can actually see.</p></div>
      <button class="btn primary" data-action="add-tool" ${d.demo ? 'disabled title="Demo data is read-only"' : ''}>Add a tool</button></div>
      ${d.tools.length ? `<div class="tools-grid">${d.tools.map(card).join('')}</div>` : `<div class="card">${emptyBlock('No tools yet', 'Add one to start tracking it.', '<button class="btn primary" data-action="add-tool">Add a tool</button>')}</div>`}
      <div class="card"><div class="card-head"><h3>What the labels mean</h3></div>
        <dl class="detail-grid">${Object.entries(CAP_SHORT).map(([k, v]) => `<dt>${esc(v)}</dt><dd>${esc(CAP_LONG[k])}</dd>`).join('')}<dt>Your budget</dt><dd>A monthly dollar budget you set. Provider plan limits are not read.</dd></dl>
      </div>`;
  },

  usage() {
    const d = S.data;
    const s = d.stats;
    const warnAt = d.settings.usage_warn_pct;
    const ceilPct = s.ceiling_usd && s.cost_mtd != null ? (s.cost_mtd / s.ceiling_usd) * 100 : null;
    const apiTools = d.tools.filter((t) => t.can_sync && t.enabled);
    const rows = d.tools.filter((t) => t.enabled).map((t) => `<tr>
      <td><b>${esc(t.name)}</b><div class="faint" style="font-size:11.5px">${esc(t.adapter_name)}</div></td>
      <td class="r ${t.cost_mtd == null ? 'na' : ''}">${or(fmtUsd(t.cost_mtd), '—')}</td>
      <td class="r ${t.tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.tokens_mtd), '—')}</td>
      <td class="r ${t.input_tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.input_tokens_mtd), '—')}</td>
      <td class="r ${t.output_tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.output_tokens_mtd), '—')}</td>
      <td class="r ${t.requests_mtd == null ? 'na' : ''}">${or(t.requests_mtd == null ? null : t.requests_mtd.toLocaleString(), '—')}</td>
      <td style="min-width:130px">${t.budget_pct != null ? `<div style="display:flex;gap:8px;align-items:center"><div style="flex:1">${bar(t.budget_pct, barCls(t.budget_pct, warnAt), true)}</div><span class="num" style="font-size:12px">${esc(fmtPct(t.budget_pct))}</span></div>` : `<span class="faint">${t.budget_usd ? 'No cost data' : 'No budget'}</span>`}</td>
      <td class="muted" style="font-size:12px">${esc(capShort('usage', t.capabilities.usage))}</td>
    </tr>`).join('');
    const models = d.usage.by_model.map((m) => `<tr><td><code>${esc(m.model)}</code></td><td class="r">${or(fmtNum(m.tokens), '—')}</td><td class="r">${or(fmtUsd(m.cost_usd), '—')}</td><td class="r">${or(m.requests?.toLocaleString(), '—')}</td></tr>`).join('');
    const hasSeries = d.usage.series.length > 0;

    return `<div class="page-head"><div><h2>Usage & Costs</h2><p>This month so far. Days are in UTC, the same as the providers report.</p></div></div>
      <div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
        ${tile('Spend this month', fmtUsd(s.cost_mtd), reportingCost(s.tools_reporting_cost))}
        ${tile('Tokens this month', fmtNum(s.tokens_mtd), 'Input, output and cache')}
        ${tile('Requests this month', s.requests_mtd?.toLocaleString() ?? null, 'Where the tool reports them')}
        ${tile('Ceiling used', ceilPct == null ? null : fmtPct(ceilPct), s.ceiling_usd ? `Of ${fmtUsd(s.ceiling_usd)} this month` : 'Set a ceiling in Settings', ceilPct == null ? '' : barCls(ceilPct, warnAt), s.ceiling_usd ? 'No cost data' : 'No ceiling')}
      </div>
      <div class="grid-2">
        <section class="card"><div class="card-head"><h3>Daily spend</h3><span class="aside">Last 30 days</span></div>
          ${hasSeries ? '<div class="chart"><canvas id="ch-cost" aria-label="Daily spend by tool"></canvas></div><div class="legend" id="lg-cost"></div>' : emptyBlock('No usage data yet', 'Charts fill in after an API tool syncs or your scripts report usage.')}</section>
        <section class="card"><div class="card-head"><h3>Daily tokens</h3><span class="aside">Last 30 days</span></div>
          ${hasSeries ? '<div class="chart"><canvas id="ch-tokens" aria-label="Daily tokens by tool"></canvas></div>' : emptyBlock('No usage data yet', 'Token counts appear for tools that report them.')}</section>
      </div>
      <section class="card"><div class="card-head"><h3>By tool</h3><span class="aside">This month</span></div>
        ${rows ? `<div class="table-wrap"><table><thead><tr><th>Tool</th><th class="r">Spend</th><th class="r">Tokens</th><th class="r">Input</th><th class="r">Output</th><th class="r">Requests</th><th>Budget</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBlock('No tools yet', 'Add a tool to see its usage.')}
        <p class="faint" style="font-size:12px;margin:10px 0 0">A dash means the tool does not report that figure. It is not zero.</p></section>
      <section class="card"><div class="card-head"><h3>By model</h3><span class="aside">This month</span></div>
        ${models ? `<div class="table-wrap"><table><thead><tr><th>Model</th><th class="r">Tokens</th><th class="r">Spend</th><th class="r">Requests</th></tr></thead><tbody>${models}</tbody></table></div>` : emptyBlock('No model data', 'Per-model figures come from API integrations.')}
        <p class="faint" style="font-size:12px;margin:10px 0 0">OpenAI reports cost per day without a model split, so its models show tokens but no spend.</p></section>
      ${apiTools.length ? `<section class="card"><div class="card-head"><h3>Data freshness</h3></div><div class="rows">${apiTools.map((t) => `<div class="row"><div class="row-main"><div class="row-title">${esc(t.name)}</div><div class="row-sub">${t.last_sync_at ? `Synced ${esc(rel(t.last_sync_at))}` : 'Not synced yet'}${t.data_refreshed_at ? ` · provider data complete up to ${esc(when(t.data_refreshed_at))}` : ''}</div></div>${pill(toolStatus(t).cls, toolStatus(t).label)}</div>`).join('')}</div>
        <p class="faint" style="font-size:12px;margin:10px 0 0">Anthropic usually publishes usage within 4 hours (up to 24). OpenAI cost data is daily.</p></section>` : ''}`;
  },

  tasks() {
    const d = S.data;
    const groups = {
      all: d.tasks,
      running: d.tasks.filter((t) => t.status === 'running'),
      upcoming: d.tasks.filter((t) => t.status === 'queued' || t.status === 'scheduled'),
      completed: d.tasks.filter((t) => t.status === 'completed'),
      failed: d.tasks.filter((t) => t.status === 'failed'),
    };
    const labels = { all: 'All', running: 'Running', upcoming: 'Upcoming', completed: 'Completed', failed: 'Failed' };
    const list = groups[S.taskFilter] ?? groups.all;
    return `<div class="page-head"><div><h2>Tasks</h2><p>Tasks your agents and automations report, across every tool.</p></div></div>
      <div class="chips" role="group" aria-label="Filter tasks">${Object.keys(groups).map((k) => `<button class="chip" data-action="task-filter" data-filter="${k}" aria-pressed="${S.taskFilter === k}">${labels[k]} <span class="n num">${groups[k].length}</span></button>`).join('')}</div>
      <section class="card">${list.length ? `<div class="rows">${list.map((t) => taskRow(t)).join('')}</div>` : d.tasks.length
        ? emptyBlock(`No ${labels[S.taskFilter].toLowerCase()} tasks`, 'Try another filter.')
        : emptyBlock('No tasks reported yet', 'None of these providers expose your running tasks through their usage APIs, so tasks come from your own scripts. Open a tool on the AI Tools page to get its ingest token and an example request.')}</section>`;
  },

  notifications() {
    const d = S.data;
    return `<div class="page-head"><div><h2>Alerts</h2><p>${d.unread ? `${d.unread} unread` : 'All caught up'} · choose which alerts you get in Settings.</p></div>
      ${d.unread && !d.demo ? '<button class="btn" data-action="read-all">Mark all as read</button>' : ''}</div>
      <section class="card">${d.notifications.length ? `<div class="rows">${d.notifications.map((n) => `<button class="row" data-action="read-notif" data-id="${n.id}">
        <div class="status-ico s-${esc(n.severity)}">${ICON[SEVERITY_ICON[n.severity] ?? 'info']}</div>
        <div class="row-main"><div class="row-title" style="${n.read ? 'font-weight:500;color:var(--text-2)' : ''}">${n.read ? '' : '<span class="pill s-info plain" style="margin-right:6px">New</span>'}${esc(n.title)}</div><div class="row-sub">${esc(n.body)}</div></div>
        <div class="row-time">${esc(rel(n.created_at))}</div></button>`).join('')}</div>` : emptyBlock('No alerts yet', 'Failed tasks, budget warnings and connection problems show up here.')}</section>`;
  },

  settings() {
    const d = S.data;
    const st = d.settings;
    const dis = d.demo ? 'disabled' : '';
    return `<div class="page-head"><div><h2>Settings</h2><p>Alerts, the daily summary and your account.</p></div></div>
      ${d.demo ? '<div class="callout warn">Settings are read-only while demo data is showing.</div>' : ''}
      <div class="grid-2">
        <section class="card"><div class="card-head"><h3>Budgets and syncing</h3></div>
          <form class="form" data-form="alerts">
            <div class="form-row">
              <div class="field"><label for="s-ceil">Monthly ceiling, all tools ($)</label><input class="input" id="s-ceil" name="monthly_ceiling_usd" type="number" min="0" step="0.01" value="${esc(st.monthly_ceiling_usd ?? '')}" placeholder="None" ${dis}></div>
              <div class="field"><label for="s-warn">Warn at (% of a budget)</label><input class="input" id="s-warn" name="usage_warn_pct" type="number" min="1" max="99" value="${esc(st.usage_warn_pct)}" ${dis}></div>
            </div>
            <div class="form-row">
              <div class="field"><label for="s-spike">Unusual spending at (× weekly average)</label><input class="input" id="s-spike" name="spike_multiplier" type="number" min="1.2" max="20" step="0.1" value="${esc(st.spike_multiplier)}" ${dis}></div>
              <div class="field"><label for="s-sync">Sync API tools every (minutes)</label><input class="input" id="s-sync" name="sync_minutes" type="number" min="5" max="1440" value="${esc(st.sync_minutes)}" ${dis}></div>
            </div>
            <div class="form-actions"><button class="btn primary" type="submit" ${dis}>Save</button></div>
            <div class="error-text" data-error></div>
          </form></section>

        <section class="card"><div class="card-head"><h3>Alerts</h3></div>
          ${Object.entries(NOTIFY_LABELS).map(([k, [label, help]]) => `<label class="switch"><span><span style="display:block;font-weight:500">${esc(label)}</span><span class="faint" style="font-size:12px">${esc(help)}</span></span><input type="checkbox" id="n-${k}" data-notify="${k}" ${st.notify[k] ? 'checked' : ''} ${dis}></label>`).join('')}
        </section>

        <section class="card"><div class="card-head"><h3>AI daily summary</h3></div>
          <form class="form" data-form="summary">
            <p class="muted" style="margin:0;font-size:13px">Without a key, the summary is assembled from your data by fixed rules. With a Claude API key it is written by Claude Opus 5.5. Use a regular API key here, not the Admin key.</p>
            <div class="field"><label for="s-key">Claude API key</label><input class="input" id="s-key" name="summary_key" type="password" autocomplete="off" placeholder="${st.summary_key_set ? `Saved: ${esc(st.summary_key_hint)}` : 'sk-ant-…'}" ${dis}>
              <span class="help">${st.summary_key_set ? 'Leave empty to keep the saved key.' : 'Stored encrypted on this server.'}</span></div>
            <div class="field"><label for="s-int">Regenerate every (hours)</label><input class="input" id="s-int" name="summary_interval_hours" type="number" min="1" max="168" value="${esc(st.summary_interval_hours)}" ${dis}>
              <span class="help">Each AI summary is one short request. Every 6 hours means 4 requests a day.</span></div>
            <div class="form-actions"><button class="btn primary" type="submit" ${dis}>Save</button>
              ${st.summary_key_set ? `<button class="btn danger" type="button" data-action="remove-summary-key" ${dis}>Remove key</button>` : ''}
              <button class="btn" type="button" data-action="refresh-summary" ${dis}>Generate now</button></div>
            <div class="error-text" data-error></div>
          </form></section>

        <section class="card"><div class="card-head"><h3>Demo data and account</h3></div>
          <label class="switch"><span><span style="display:block;font-weight:500">Show demo data</span><span class="faint" style="font-size:12px">Sample tools and tasks, labeled as demo. Your data is untouched.</span></span><input type="checkbox" id="s-demo" data-action-change="toggle-demo" ${S.demo ? 'checked' : ''}></label>
          <div class="switch" style="cursor:default"><span>Signed in as <b>${esc(S.user.username)}</b></span><button class="btn small" data-action="logout">Sign out</button></div>
        </section>
      </div>`;
  },
};

// ── Charts ───────────────────────────────────────────────────────────────
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { series: ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'].map(v), text: v('--text-3'), grid: v('--border-sub') };
}

const AFTER = {
  usage() {
    if (!window.Chart || !S.data.usage.series.length) return;
    const { series, text, grid } = palette();
    const labels = S.data.usage.days.map(shortDay);
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: text, maxTicksLimit: 8, maxRotation: 0 } },
        y: { stacked: true, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: text } },
      },
    };
    const sets = S.data.usage.series;
    S.charts.push(new window.Chart($('#ch-cost'), {
      type: 'bar',
      data: { labels, datasets: sets.map((s, i) => ({ label: s.name, data: s.cost, backgroundColor: series[i % series.length], borderRadius: 2, maxBarThickness: 18 })) },
      options: { ...base, plugins: { ...base.plugins, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? 'not reported' : fmtUsd(c.raw)}` } } },
        scales: { ...base.scales, y: { ...base.scales.y, ticks: { color: text, callback: (v) => `$${v}` } } } },
    }));
    S.charts.push(new window.Chart($('#ch-tokens'), {
      type: 'line',
      data: { labels, datasets: sets.map((s, i) => ({ label: s.name, data: s.tokens, borderColor: series[i % series.length], backgroundColor: series[i % series.length], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, spanGaps: false })) },
      options: { ...base, plugins: { ...base.plugins, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? 'not reported' : fmtNum(c.raw)}` } } },
        scales: { x: base.scales.x, y: { ...base.scales.y, stacked: false, ticks: { color: text, callback: (v) => fmtNum(v) } } } },
    }));
    $('#lg-cost').innerHTML = sets.map((s, i) => `<span><i style="background:${series[i % series.length]}"></i>${esc(s.name)}</span>`).join('');
  },
};

// ── Modals ───────────────────────────────────────────────────────────────
function openPanel(title, body, { center = false } = {}) {
  $('#modal-root').innerHTML = `<div class="overlay ${center ? 'center' : ''}" data-action="overlay">
    <div class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="panel-head"><h2>${esc(title)}</h2><button class="btn icon-btn ghost" data-action="close" aria-label="Close">${ICON.close}</button></div>
      <div class="panel-body">${body}</div></div></div>`;
  $('#modal-root .panel-body input, #modal-root .panel-body button')?.focus();
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  S.add = null;
}

function ingestHelp(t, token) {
  const url = `${location.origin}/api/ingest/${t.id}`;
  const example = `curl -X POST ${url} \\
  -H "Authorization: Bearer ${token ?? 'YOUR_INGEST_TOKEN'}" \\
  -H "Content-Type: application/json" \\
  -d '{"task": {"id": "run-42", "name": "Nightly report", "status": "running", "progress": 40}}'`;
  return `${token ? `<div class="field"><label>Ingest token (shown once)</label><div class="secret-box"><code id="ingest-token">${esc(token)}</code><button class="btn" data-action="copy" data-target="ingest-token">Copy</button></div><span class="help">Store it in your script’s environment. Creating a new token stops the old one working.</span></div>` : ''}
    <p class="muted" style="margin:0;font-size:13px">Send task updates to <code>${esc(url)}</code>. Status is one of running, queued, scheduled, completed or failed. You can also send <code>usage</code> rows with day, model, tokens, requests and cost_usd; each row sets that day’s totals.</p>
    <pre class="code" id="ingest-example">${esc(example)}</pre>`;
}

function openTool(id) {
  const t = S.data.tools.find((x) => x.id === Number(id));
  if (!t) return;
  const st = toolStatus(t);
  const demo = S.data.demo;
  const capRows = Object.entries(t.capabilities).map(([k, v]) => `<tr><td><b>${CAP_NAME[k]}</b><div class="faint" style="font-size:12px">${esc(k === 'limits' && v === 'manual' ? 'The monthly budget you set below' : CAP_LONG[v])}</div></td><td>${pill(v === 'none' ? 's-queued' : v === 'api' ? 's-ok' : 's-info', capShort(k, v))}</td></tr>`).join('');
  const body = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${pill(st.cls, st.label)}<span class="faint" style="font-size:12.5px">${esc(t.adapter_name)} · ${esc(t.vendor)}${t.secret_hint ? ` · key ${esc(t.secret_hint)}` : ''}</span></div>
    ${t.last_error ? `<div class="callout err">${esc(t.last_error)}</div>` : ''}
    ${t.status === 'pending' ? '<div class="callout info">The first sync hasn’t finished yet.</div>' : ''}
    <div class="section"><h4>This month</h4><dl class="detail-grid">
      <dt>Spend</dt><dd>${or(fmtUsd(t.cost_mtd))}</dd>
      <dt>Tokens</dt><dd>${or(fmtNum(t.tokens_mtd))}${t.input_tokens_mtd != null ? ` <span class="faint">(${esc(fmtNum(t.input_tokens_mtd))} in, ${esc(fmtNum(t.output_tokens_mtd))} out)</span>` : ''}</dd>
      <dt>Requests</dt><dd>${or(t.requests_mtd?.toLocaleString())}</dd>
      <dt>Budget</dt><dd>${t.budget_usd ? `${esc(fmtUsd(t.budget_usd))}${t.budget_pct != null ? ` · ${esc(fmtPct(t.budget_pct))} used` : ''}` : '<span class="faint">Not set</span>'}</dd>
      ${t.can_sync ? `<dt>Last sync</dt><dd>${or(t.last_sync_at && when(t.last_sync_at), 'Not yet')}</dd>` : ''}
      ${t.data_refreshed_at ? `<dt>Data complete to</dt><dd>${esc(when(t.data_refreshed_at))}</dd>` : ''}
    </dl></div>
    <div class="section"><h4>What this integration can see</h4><table class="cap-table"><tbody>${capRows}</tbody></table></div>
    <div class="section"><h4>Limitations</h4><ul class="notes">${t.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
    ${demo ? '<div class="callout warn">Demo data is read-only.</div>' : `
    <div class="section"><h4>Monthly budget</h4><form class="form" data-form="budget" data-id="${t.id}">
      <div class="field"><label for="t-budget">Budget in dollars</label><input class="input" id="t-budget" name="budget_usd" type="number" min="0" step="0.01" value="${esc(t.budget_usd ?? '')}" placeholder="None"><span class="help">Drives the limit bar and budget alerts. Leave empty for none.</span></div>
      <div class="form-actions"><button class="btn primary" type="submit">Save budget</button></div><div class="error-text" data-error></div></form></div>
    ${t.kind === 'api' ? `<div class="section"><h4>Replace key</h4><form class="form" data-form="secret" data-id="${t.id}">
      <div class="field"><label for="t-secret">New key</label><input class="input" id="t-secret" name="secret" type="password" autocomplete="off" required><span class="help">It is tested before it replaces the saved key.</span></div>
      <div class="form-actions"><button class="btn" type="submit">Test and save</button></div><div class="error-text" data-error></div></form></div>` : ''}
    ${t.capabilities.usage === 'manual' ? `<div class="section"><h4>Log usage</h4><form class="form" data-form="manual-usage" data-id="${t.id}">
      <div class="form-row"><div class="field"><label for="m-day">Day (UTC)</label><input class="input" id="m-day" name="day" type="date" value="${utcToday()}" required></div>
        <div class="field"><label for="m-cost">Cost ($)</label><input class="input" id="m-cost" name="cost_usd" type="number" min="0" step="0.01"></div></div>
      <div class="form-row"><div class="field"><label for="m-req">Requests</label><input class="input" id="m-req" name="requests" type="number" min="0"></div>
        <div class="field"><label for="m-in">Input tokens</label><input class="input" id="m-in" name="input_tokens" type="number" min="0"></div>
        <div class="field"><label for="m-out">Output tokens</label><input class="input" id="m-out" name="output_tokens" type="number" min="0"></div></div>
      <span class="help">Saving the same day again replaces that day’s figures. For a subscription, log the plan price on the day it renews.</span>
      <div class="form-actions"><button class="btn" type="submit">Save usage</button></div><div class="error-text" data-error></div></form></div>` : ''}
    <div class="section"><h4>Report tasks from your scripts</h4><div class="form" id="ingest-section">${ingestHelp(t)}
      <div class="form-actions"><button class="btn" data-action="rotate-token" data-id="${t.id}">Create new ingest token</button></div></div></div>
    <div class="section"><h4>Manage</h4><div class="form-actions" id="manage-actions">
      ${t.can_sync ? `<button class="btn" data-action="sync" data-id="${t.id}">Sync now</button>` : ''}
      <button class="btn" data-action="toggle-tool" data-id="${t.id}" data-enabled="${t.enabled ? 0 : 1}">${t.enabled ? 'Turn off' : 'Turn on'}</button>
      <button class="btn danger" data-action="remove-tool" data-id="${t.id}">Remove</button></div></div>`}`;
  openPanel(t.name, body);
}

function openTask(id) {
  const t = S.data.tasks.find((x) => x.id === Number(id));
  if (!t) return;
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  openPanel(t.name, `
    <div>${pill(TASK_STATUS[t.status].pill, TASK_STATUS[t.status].label)}</div>
    ${t.description ? `<p style="margin:0">${esc(t.description)}</p>` : ''}
    ${t.error ? `<div class="callout err">${esc(t.error)}</div>` : ''}
    ${t.progress != null ? `<div class="meter" style="padding:0"><div class="meter-top"><span class="muted">Progress</span><b>${Math.round(t.progress)}%</b></div>${bar(t.progress, 'info')}</div>` : ''}
    <dl class="detail-grid">
      ${row('Tool', esc(t.tool_name))}
      ${row('Started', t.started_at && `${esc(when(t.started_at))} <span class="faint">(${esc(rel(t.started_at))})</span>`)}
      ${row('Estimated finish', t.eta && `${esc(when(t.eta))} <span class="faint">(${esc(rel(t.eta))})</span>`)}
      ${row('Scheduled for', t.scheduled_for && esc(when(t.scheduled_for)))}
      ${row('Finished', t.finished_at && esc(when(t.finished_at)))}
      ${row('Last update', esc(when(t.updated_at)))}
      ${row('Task ID', `<code>${esc(t.external_id)}</code>`)}
    </dl>
    <div class="section"><h4>Controls</h4>
      <div class="form-actions"><button class="btn" disabled>Pause</button><button class="btn" disabled>Resume</button><button class="btn" disabled>Cancel</button><button class="btn" disabled>Restart</button></div>
      <p class="faint" style="font-size:12.5px;margin:8px 0 0">${esc(t.tool_name)} doesn’t offer task controls through this app yet. Stop or restart the task where it runs.</p></div>`);
}

async function openAddTool() {
  if (S.data?.demo) return toast('Demo data is read-only. Exit demo to add a tool.', true);
  try {
    S.catalog ??= await api('/api/catalog');
  } catch (err) {
    return toast(err.message, true);
  }
  S.add = { step: 'pick' };
  renderAdd();
}

function renderAdd() {
  const a = S.add;
  if (a.step === 'pick') {
    const item = (c) => `<button class="cat-item" data-action="pick-adapter" data-id="${esc(c.id)}"><div class="logo">${initials(c.name)}</div><div style="min-width:0">
      <b>${esc(c.name)}</b> <span class="faint" style="font-size:12px">${esc(c.vendor)}</span><p>${esc(c.description)}</p>
      <div class="caps">${Object.entries(c.capabilities).map(([k, v]) => `<span class="cap ${v === 'none' ? 'none' : ''}">${CAP_NAME[k]}: <b>${esc(capShort(k, v))}</b></span>`).join('')}</div></div></button>`;
    openPanel('Add a tool', `
      <div class="section"><h4>Connect with an API</h4><div class="catalog">${S.catalog.filter((c) => c.kind === 'api').map(item).join('')}</div></div>
      <div class="section"><h4>Track without an API</h4><div class="catalog">${S.catalog.filter((c) => c.kind !== 'api').map(item).join('')}</div></div>`, { center: true });
    return;
  }
  const c = a.adapter;
  if (a.step === 'form') {
    openPanel(`Add ${c.name}`, `
      <form class="form" data-form="add-tool">
        <div class="field"><label for="a-name">Name</label><input class="input" id="a-name" name="name" value="${esc(c.name)}" maxlength="80" required><span class="help">Use a different name if you connect more than one account.</span></div>
        ${c.credential ? `<div class="field"><label for="a-secret">${esc(c.credential.label)}</label><input class="input" id="a-secret" name="secret" type="password" autocomplete="off" placeholder="${esc(c.credential.placeholder)}" required><span class="help">${esc(c.credential.help)} It is stored encrypted and never shown again.</span></div>` : ''}
        <div class="field"><label for="a-budget">Monthly budget ($, optional)</label><input class="input" id="a-budget" name="budget_usd" type="number" min="0" step="0.01"></div>
        <div class="callout info"><ul class="notes" style="padding-left:16px">${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
        <div class="form-actions"><button class="btn primary" type="submit">${c.credential ? 'Test and connect' : 'Add tool'}</button><button class="btn ghost" type="button" data-action="add-back">Back</button></div>
        <div class="error-text" data-error></div>
      </form>`, { center: true });
    $('#a-secret')?.focus();
    return;
  }
  openPanel(`${c.name} added`, `
    ${a.result.test?.detail ? `<div class="callout info">${esc(a.result.test.detail)}</div>` : ''}
    <div class="form">${ingestHelp({ id: a.result.id }, a.result.ingest_token)}</div>
    <div class="form-actions"><button class="btn primary" data-action="close">Done</button></div>`, { center: true });
}

// ── Events ───────────────────────────────────────────────────────────────
function numOrNull(v) {
  return v === '' || v == null ? null : Number(v);
}

const FORMS = {
  async setup(fd) {
    await api('/api/auth/setup', { method: 'POST', body: fd });
    await boot();
  },
  async login(fd) {
    await api('/api/auth/login', { method: 'POST', body: fd });
    await boot();
  },
  async alerts(fd) {
    await api('/api/settings', { method: 'PUT', body: { ...fd, monthly_ceiling_usd: numOrNull(fd.monthly_ceiling_usd) } });
    toast('Settings saved');
    await load({ force: true });
  },
  async summary(fd) {
    const body = { summary_interval_hours: fd.summary_interval_hours };
    if (fd.summary_key) body.summary_key = fd.summary_key;
    await api('/api/settings', { method: 'PUT', body });
    toast('Summary settings saved');
    await load({ force: true });
  },
  async budget(fd, form) {
    await api(`/api/integrations/${form.dataset.id}`, { method: 'PATCH', body: { budget_usd: numOrNull(fd.budget_usd) } });
    toast('Budget saved');
    await load({ force: true });
    openTool(form.dataset.id);
  },
  async secret(fd, form) {
    await api(`/api/integrations/${form.dataset.id}`, { method: 'PATCH', body: { secret: fd.secret } });
    toast('Key replaced');
    await load({ force: true });
    openTool(form.dataset.id);
  },
  async 'manual-usage'(fd, form) {
    const body = { day: fd.day };
    for (const k of ['cost_usd', 'requests', 'input_tokens', 'output_tokens']) body[k] = numOrNull(fd[k]);
    await api(`/api/integrations/${form.dataset.id}/manual-usage`, { method: 'POST', body });
    toast('Usage saved');
    await load({ force: true });
    openTool(form.dataset.id);
  },
  async 'add-tool'(fd) {
    const result = await api('/api/integrations', { method: 'POST', body: { adapter: S.add.adapter.id, ...fd, budget_usd: numOrNull(fd.budget_usd) } });
    S.add = { ...S.add, step: 'done', result };
    renderAdd();
    load({ force: true });
  },
};

async function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const errEl = form.querySelector('[data-error]');
  const label = btn?.textContent;
  if (errEl) errEl.textContent = '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = form.dataset.form === 'add-tool' || form.dataset.form === 'secret' ? 'Testing connection…' : 'Saving…';
  }
  try {
    await FORMS[form.dataset.form](Object.fromEntries(new FormData(form)), form);
  } catch (err) {
    if (errEl?.isConnected) errEl.textContent = err.message;
    else toast(err.message, true);
  } finally {
    if (btn?.isConnected) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

async function toggleDemo() {
  S.demo = !S.demo;
  writeDemo(S.demo);
  closeModal();
  S.data = null;
  renderPage();
  await load({ force: true });
}

const ACTIONS = {
  close: closeModal,
  overlay: (el, e) => e.target === el && closeModal(),
  reload: () => load({ force: true }),
  'add-tool': openAddTool,
  'pick-adapter': (el) => {
    S.add = { step: 'form', adapter: S.catalog.find((c) => c.id === el.dataset.id) };
    renderAdd();
  },
  'add-back': () => {
    S.add = { step: 'pick' };
    renderAdd();
  },
  'open-tool': (el) => openTool(el.dataset.id),
  'open-task': (el) => openTask(el.dataset.id),
  'task-filter': (el) => {
    S.taskFilter = el.dataset.filter;
    renderPage();
  },
  'toggle-demo': toggleDemo,
  async logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    S.user = null;
    S.data = null;
    await showAuth();
  },
  async 'refresh-summary'(el) {
    el.disabled = true;
    el.textContent = 'Generating…';
    try {
      await api('/api/summary/refresh', { method: 'POST' });
      await load({ force: true });
      toast('Summary updated');
    } catch (err) {
      toast(err.message, true);
      el.disabled = false;
      el.textContent = 'Generate now';
    }
  },
  async 'remove-summary-key'() {
    await api('/api/settings', { method: 'PUT', body: { summary_key: null } });
    toast('Claude API key removed');
    await load({ force: true });
  },
  async 'read-notif'(el) {
    if (S.data.demo) return;
    await api(`/api/notifications/${el.dataset.id}/read`, { method: 'POST' });
    await load({ force: true });
  },
  async 'read-all'() {
    await api('/api/notifications/read-all', { method: 'POST' });
    await load({ force: true });
  },
  async sync(el) {
    el.disabled = true;
    el.textContent = 'Syncing…';
    const r = await api(`/api/integrations/${el.dataset.id}/sync`, { method: 'POST' });
    toast(r.ok ? 'Sync finished' : r.error, !r.ok);
    await load({ force: true });
    openTool(el.dataset.id);
  },
  async 'toggle-tool'(el) {
    await api(`/api/integrations/${el.dataset.id}`, { method: 'PATCH', body: { enabled: el.dataset.enabled === '1' } });
    await load({ force: true });
    openTool(el.dataset.id);
  },
  'remove-tool'(el) {
    const t = S.data.tools.find((x) => x.id === Number(el.dataset.id));
    $('#manage-actions').innerHTML = `<div class="callout err" style="flex-basis:100%">Remove ${esc(t.name)}? Its usage history, tasks and ingest token are deleted. This can’t be undone.</div>
      <button class="btn danger" data-action="confirm-remove" data-id="${t.id}">Remove ${esc(t.name)}</button><button class="btn ghost" data-action="cancel-remove" data-id="${t.id}">Cancel</button>`;
  },
  'cancel-remove': (el) => openTool(el.dataset.id),
  async 'confirm-remove'(el) {
    await api(`/api/integrations/${el.dataset.id}`, { method: 'DELETE' });
    closeModal();
    toast('Tool removed');
    await load({ force: true });
  },
  async 'rotate-token'(el) {
    const { ingest_token } = await api(`/api/integrations/${el.dataset.id}/ingest-token`, { method: 'POST' });
    $('#ingest-section').innerHTML = ingestHelp({ id: Number(el.dataset.id) }, ingest_token);
    toast('New ingest token created. The old one no longer works.');
  },
  async copy(el) {
    const target = document.getElementById(el.dataset.target);
    try {
      await navigator.clipboard.writeText(target.textContent);
      el.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(target);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast('Press Ctrl+C or ⌘C to copy the selected token.');
    }
  },
};

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  if (el.tagName === 'A') e.preventDefault();
  try {
    await ACTIONS[el.dataset.action](el, e);
  } catch (err) {
    toast(err.message, true);
  }
}

async function onChange(e) {
  const el = e.target;
  if (el.dataset.actionChange === 'toggle-demo') return toggleDemo();
  if (el.dataset.notify) {
    try {
      await api('/api/settings', { method: 'PUT', body: { notify: { [el.dataset.notify]: el.checked } } });
      toast('Alert setting saved');
    } catch (err) {
      el.checked = !el.checked;
      toast(err.message, true);
    }
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────
let wired = false;
async function boot() {
  if (!wired) {
    wired = true;
    window.addEventListener('hashchange', () => {
      S.page = pageFromHash();
      closeModal();
      updateChrome();
      renderPage();
      $('#content')?.scrollTo(0, 0);
    });
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"][data-action]')) {
        e.preventDefault();
        e.target.click();
      }
    });
    document.addEventListener('visibilitychange', () => !document.hidden && S.user && load());
  }
  let st;
  try {
    st = await api('/api/auth/status');
  } catch (err) {
    $('#root').innerHTML = `<div class="auth"><div class="card"><div class="callout err">Can’t reach the server: ${esc(err.message)}</div></div></div>`;
    return;
  }
  if (!st.user) return showAuth();
  S.user = st.user;
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  renderShell();
  updateChrome();
  renderPage();
  await load({ force: true });
  clearInterval(S.timer);
  S.timer = setInterval(() => !document.hidden && load(), 30_000);
}

boot();
