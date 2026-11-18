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

ICON.claude = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.2l1.7 4.6 4.6 1.7-4.6 1.7L8 13.8 6.3 9.2 1.7 7.5l4.6-1.7z"/></svg>';
ICON.send = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>';
ICON.stop = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';
ICON.plus = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';
ICON.trash = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';

const PAGES = {
  dashboard: { title: 'Overview', icon: 'grid', short: 'Home' },
  assistant: { title: 'Claude', icon: 'claude', short: 'Claude' },
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
const CAP_SHORT = { api: 'API', manual: 'You log it', webhook: 'Your scripts', app: 'This app', none: 'None' };
const CAP_LONG = {
  api: 'Read automatically from the provider’s official API',
  manual: 'Entered by you in this app',
  webhook: 'Reported by your own scripts with the ingest token',
  app: 'Measured or controlled by this app itself',
  none: 'Not available for this service',
};
const NOTIFY_LABELS = {
  task_failed: ['Failed tasks', 'When a reported task fails'],
  task_completed: ['Completed tasks', 'When a reported task finishes'],
  task_stalled: ['Stalled tasks', 'When a task that reports progress stops updating'],
  task_overdue: ['Overdue tasks', 'When a task runs well past its expected finish'],
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
  chat: { loaded: false, threads: [], thread: null, streaming: false, pending: null, draft: '' },
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
  clearTimeout(S.timer);
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
        ${nav('dashboard')}${nav('assistant')}${nav('tools')}
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
      <nav class="tabbar" aria-label="Main">${['dashboard', 'assistant', 'tasks', 'usage', 'tools', 'notifications'].map(tab).join('')}</nav>
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
  // Settings and the chat keep their own state on screen, so background refreshes leave them alone.
  const keep = ['settings', 'assistant'].includes(S.page) && $('#content')?.dataset.page === S.page;
  if (force ? !(S.page === 'assistant' && keep) : !(typing || keep)) renderPage();
}

/** Refresh every 30 seconds, or every 10 while tasks are running so their ETAs stay current. */
function schedulePoll() {
  clearTimeout(S.timer);
  const ms = S.data?.stats?.running ? 10_000 : 30_000;
  S.timer = setTimeout(async () => {
    if (!document.hidden && S.user) await load();
    if (S.user) schedulePoll();
  }, ms);
}

function renderPage() {
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
  const el = $('#content');
  if (!el) return;
  if (!S.data) {
    delete el.dataset.page;
    el.innerHTML = S.loadError ? `<div class="page"><div class="callout err">${esc(S.loadError)}</div></div>` : '<div class="empty">Loading…</div>';
    return;
  }
  el.dataset.page = S.page;
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

/** A duration in words: "8 min", "2 h 5 min". */
function dur(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const ETA_BASIS = { reported: 'reported by the task', progress: 'estimated from its progress', history: 'based on earlier runs' };

/** What the ETA watcher knows about a running task, as one short line. */
function etaInfo(t) {
  if (t.status !== 'running') return null;
  if (t.stalled) return { text: `No progress for ${dur(Date.now() - Date.parse(t.updated_at))}`, basis: 'it may be stuck', cls: 'err' };
  if (t.overdue) return { text: `Past its expected finish of ${when(t.eta_at)}`, basis: ETA_BASIS[t.eta_source], cls: 'warn' };
  if (t.eta_at) {
    const left = Date.parse(t.eta_at) - Date.now();
    return { text: left < 60_000 ? 'Finishing now' : `About ${dur(left)} left`, basis: ETA_BASIS[t.eta_source], cls: 'info' };
  }
  if (t.longer_than_usual) return { text: 'Running longer than usual', basis: `earlier runs took about ${dur(t.typical_ms)}`, cls: 'warn' };
  return { text: 'No finish estimate yet', basis: 'it hasn’t reported progress or an ETA', cls: 'none' };
}
const etaLine = (t) => {
  const e = etaInfo(t);
  return e ? `<div class="eta ${e.cls}">${esc(e.text)}${e.basis ? `<span> · ${esc(e.basis)}</span>` : ''}</div>` : '';
};

/** A small, safe Markdown subset for Claude's replies: escapes everything first, then adds formatting. */
function md(src) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  const out = [];
  let list = null;
  let code = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of String(src ?? '').split('\n')) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre class="code">${esc(code.join('\n'))}</pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      code = [];
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) {
      closeList();
      out.push(`<h${Math.min(6, h[1].length + 3)}>${inline(h[2])}</h${Math.min(6, h[1].length + 3)}>`);
    } else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (code !== null) out.push(`<pre class="code">${esc(code.join('\n'))}</pre>`);
  closeList();
  return out.join('');
}

function taskRow(t, { compact = false } = {}) {
  const prog = t.status === 'running' && t.progress != null;
  return `<button class="row" data-action="open-task" data-id="${t.id}">
    ${statusIcon(t.status)}
    <div class="row-main">
      <div class="row-title">${esc(t.name)}${t.runner === 'claude' ? ' <span class="by-claude">Claude</span>' : ''}</div>
      <div class="row-sub">${esc(t.tool_name)} · ${esc(taskWhen(t))}${t.step && t.status === 'running' ? ` · ${esc(t.step)}` : ''}</div>
      ${prog ? `<div style="margin-top:7px;display:flex;align-items:center;gap:8px"><div style="flex:1">${bar(t.progress, t.stalled ? 'err' : 'info', true)}</div><span class="faint num" style="font-size:11.5px">${Math.round(t.progress)}%</span></div>` : ''}
      ${etaLine(t)}
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

// ── Claude: overview card and chat ───────────────────────────────────────
function suggestions(d) {
  const out = ['What needs my attention right now?'];
  if (d.tasks.some((t) => t.status === 'running')) out.push('When will my running tasks finish?');
  const failed = d.tasks.find((t) => t.status === 'failed');
  if (failed) out.push(`Why did “${failed.name}” fail, and what should I do?`);
  out.push('How is my spending this month compared to my budgets?');
  out.push('Draft a short report of this month’s AI usage');
  return out.slice(0, 4);
}

function askCard(d) {
  const keySet = d.settings.summary_key_set;
  const body = d.demo
    ? '<p class="faint" style="margin:0;font-size:13px">Claude works with your real data. Exit demo to ask it something.</p>'
    : !keySet
      ? `<p class="muted" style="margin:0 0 10px;font-size:13px">Ask questions about your tools and tasks, or hand Claude work to do in the background. It needs a regular Claude API key.</p>
         <a class="btn" href="#settings">Add a Claude API key</a>`
      : `<form class="ask-form" data-form="ask"><input class="input" name="text" placeholder="Ask Claude, or tell it what to do…" autocomplete="off" maxlength="8000" aria-label="Ask Claude"><button class="btn primary" type="submit">Ask</button></form>
         <div class="chips" style="margin-top:10px">${suggestions(d).map((p) => `<button class="chip" data-action="ask" data-prompt="${esc(p)}">${esc(p)}</button>`).join('')}</div>`;
  return `<section class="card ask a-ask">
    <div class="card-head">${ICON.claude}<h3>Ask Claude</h3>${!d.demo && keySet ? '<a class="aside" href="#assistant">Open chat</a>' : ''}</div>
    ${body}
  </section>`;
}

function chatItem(it) {
  if (it.role === 'user') return `<div class="msg user"><div class="bubble">${esc(it.text)}</div></div>`;
  if (it.role === 'assistant') return `<div class="msg ai"><div class="bubble md">${it.text ? md(it.text) : '<span class="typing"><i></i><i></i><i></i></span>'}</div></div>`;
  if (it.role === 'action') {
    const icon = it.pending ? '<span class="spin"></span>' : it.ok ? ICON.check : ICON.x;
    return `<div class="act ${it.pending ? '' : it.ok ? 'ok' : 'err'}">${icon}<span>${esc(it.label)}${it.error ? ` · ${esc(it.error)}` : ''}</span></div>`;
  }
  return `<div class="chat-note ${it.role === 'error' ? 'err' : ''}">${esc(it.text)}</div>`;
}

function renderMsgs() {
  const el = $('#msgs');
  if (!el) return;
  const c = S.chat;
  const items = c.thread?.items ?? [];
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  el.innerHTML = items.length
    ? items.map(chatItem).join('')
    : `<div class="chat-empty">${ICON.claude}<h3>What can Claude do for you?</h3>
        <p>It can read your tools, tasks, spending and alerts, change budgets, sync tools, and run tasks in the background that show up on the Tasks page with live progress.</p>
        <div class="chips">${suggestions(S.data).map((p) => `<button class="chip" data-action="ask-here" data-prompt="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>`;
  if (nearBottom || c.streaming) el.scrollTop = el.scrollHeight;
  const form = $('#chat-form');
  if (form) {
    form.querySelector('[data-role="send"]').hidden = c.streaming;
    form.querySelector('[data-role="stop"]').hidden = !c.streaming;
  }
}

let msgFrame = 0;
const renderMsgsSoon = () => {
  if (!msgFrame) msgFrame = requestAnimationFrame(() => { msgFrame = 0; renderMsgs(); });
};

async function loadThreads() {
  S.chat.threads = await api('/api/assistant/threads');
  S.chat.loaded = true;
}

async function openThread(id) {
  S.chat.thread = await api(`/api/assistant/threads/${id}`);
  if (S.page === 'assistant') renderPage();
}

/** Sends a message and reads the reply as it streams in. */
async function sendChat(text) {
  const c = S.chat;
  text = text.trim();
  if (!text || c.streaming) return;
  if (!c.thread) {
    c.thread = await api('/api/assistant/threads', { method: 'POST' });
    c.threads.unshift({ id: c.thread.id, title: 'New conversation', updated_at: c.thread.updated_at });
  }
  const thread = c.thread;
  thread.items.push({ role: 'user', text });
  c.streaming = true;
  c.draft = '';
  let current = null; // the assistant bubble being written
  const assistantBubble = () => {
    if (!current) {
      current = { role: 'assistant', text: '' };
      thread.items.push(current);
    }
    return current;
  };
  assistantBubble();
  renderMsgs();
  const finishPending = () => thread.items.forEach((it) => { if (it.pending) { it.pending = false; it.ok = true; } });

  try {
    const res = await fetch(`/api/assistant/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'x-acc-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || `Request failed (${res.status}).`), { unsent: text });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') {
          finishPending();
          assistantBubble().text += ev.delta;
        } else if (ev.type === 'searching') {
          current = null;
          thread.items.push({ role: 'action', label: 'Searching the web', pending: true });
        } else if (ev.type === 'tool') {
          if (current && !current.text) thread.items.splice(thread.items.indexOf(current), 1);
          current = null;
          thread.items.push({ role: 'action', label: ev.label, pending: true });
        } else if (ev.type === 'tool_done') {
          const it = [...thread.items].reverse().find((x) => x.role === 'action' && x.pending);
          if (it) Object.assign(it, { pending: false, ok: ev.ok, label: ev.label, error: ev.error });
        } else if (ev.type === 'turn') {
          assistantBubble();
        } else if (ev.type === 'notice' || ev.type === 'error') {
          if (current && !current.text) thread.items.splice(thread.items.indexOf(current), 1);
          current = null;
          thread.items.push({ role: ev.type === 'error' ? 'error' : 'notice', text: ev.type === 'error' ? ev.message : ev.text });
          if (ev.unsent) c.draft = ev.unsent;
        } else if (ev.type === 'done') {
          if (S.chat.thread?.id === ev.thread.id) {
            const notes = thread.items.filter((x) => x.role === 'error' || x.role === 'notice');
            S.chat.thread = { ...ev.thread, items: [...ev.thread.items, ...notes] };
          }
          const entry = c.threads.find((x) => x.id === ev.thread.id);
          if (entry) entry.title = ev.thread.title;
        }
        renderMsgsSoon();
      }
    }
  } catch (err) {
    if (current && !current.text) thread.items.splice(thread.items.indexOf(current), 1);
    thread.items.push({ role: 'error', text: err.message });
    c.draft = err.unsent ?? text;
  } finally {
    c.streaming = false;
    finishPending();
    if (S.page === 'assistant') {
      renderPage();
      $('#chat-input')?.focus();
    }
    load({ force: true }); // Claude may have changed budgets or started tasks
  }
}

/** Opens the chat in a new conversation and sends a prompt, from the overview or a task. */
function askClaude(prompt) {
  S.chat.thread = null;
  S.chat.pending = prompt;
  if (S.page === 'assistant') {
    renderPage();
    AFTER.assistant();
  } else location.hash = '#assistant';
}

// ── Views ────────────────────────────────────────────────────────────────
const VIEWS = {
  assistant() {
    const d = S.data;
    if (d.demo) return `<div class="card">${emptyBlock('Claude works with your real data', 'Exit demo to chat with Claude about your tools and tasks.', '<button class="btn" data-action="toggle-demo">Exit demo</button>')}</div>`;
    if (!d.settings.summary_key_set) {
      return `<div class="card" style="padding:24px"><div class="page-head"><div><h2>Bring Claude into your command center</h2>
        <p>Add a regular Claude API key in Settings. Claude can then answer questions about your tools, tasks and spending, change budgets, sync tools, and run tasks in the background with live progress and ETAs.</p></div></div>
        <div class="form-actions" style="margin-top:16px"><a class="btn primary" href="#settings">Open Settings</a></div></div>`;
    }
    const c = S.chat;
    const options = c.threads.map((t) => `<option value="${t.id}" ${c.thread?.id === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
    return `<div class="chat-page">
      <div class="chat-bar">
        <select class="input" id="thread-pick" data-action-change="pick-thread" aria-label="Conversation" ${c.streaming ? 'disabled' : ''}>
          ${c.thread ? '' : '<option value="" selected>New conversation</option>'}${options}</select>
        <button class="btn" data-action="new-chat" ${c.streaming ? 'disabled' : ''}>${ICON.plus}<span class="hide-sm">New chat</span></button>
        ${c.thread ? `<button class="btn icon-btn ghost" data-action="delete-chat" aria-label="Delete this conversation" title="Delete this conversation" ${c.streaming ? 'disabled' : ''}>${ICON.trash}</button>` : ''}
      </div>
      <section class="card chat">
        <div class="msgs" id="msgs" aria-live="polite"></div>
        <form class="composer" id="chat-form" data-form="chat">
          <textarea class="input" id="chat-input" name="text" rows="1" maxlength="8000" placeholder="Ask about your tools, or tell Claude what to do…" aria-label="Message Claude">${esc(c.draft)}</textarea>
          <button class="btn primary icon-btn" type="submit" data-role="send" aria-label="Send">${ICON.send}</button>
          <button class="btn icon-btn" type="button" data-action="stop-chat" data-role="stop" aria-label="Stop" hidden>${ICON.stop}</button>
        </form>
      </section>
      <p class="faint chat-foot">Claude uses the API key from Settings, and each message uses tokens. It changes budgets, syncs tools or starts tasks only when you ask${d.settings.assistant_web_search ? '. Web search is on' : ''}.</p>
    </div>`;
  },

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
    const stalled = running.filter((t) => t.stalled).length;
    const nextEta = running.map((t) => t.eta_at && !t.overdue && Date.parse(t.eta_at)).filter(Boolean).sort((a, b) => a - b)[0];
    const runningSub = stalled ? `${stalled} may be stuck` : nextEta ? `Next one done ${rel(new Date(nextEta).toISOString())}` : `${s.queued} queued · ${s.scheduled} scheduled`;

    return `<div class="dash">
      <div class="tiles a-tiles">
        ${tile('Tools connected', s.connected, s.needs_attention ? `${s.active} active · ${s.needs_attention} need attention` : `${s.active} active now`, s.needs_attention ? 'warn' : '')}
        ${tile('Running tasks', s.running, runningSub, stalled ? 'warn' : s.running ? 'info' : '')}
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

      ${askCard(d)}

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
    const canRun = !d.demo && d.settings.summary_key_set;
    return `<div class="page-head"><div><h2>Tasks</h2><p>Tasks your agents and automations report, plus work Claude does here. Finish times come from each task’s reports.</p></div>
      ${canRun ? `<button class="btn primary" data-action="new-claude-task">${ICON.claude}New Claude task</button>` : ''}</div>
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

        <section class="card"><div class="card-head"><h3>Claude</h3></div>
          <form class="form" data-form="summary">
            <p class="muted" style="margin:0;font-size:13px">One Claude API key powers the Claude chat, background tasks and the daily summary, all on Claude Opus 5.5. Use a regular API key here, not the Admin key. Without a key, the summary is assembled from your data by fixed rules and the chat is off.</p>
            <div class="field"><label for="s-key">Claude API key</label><input class="input" id="s-key" name="summary_key" type="password" autocomplete="off" placeholder="${st.summary_key_set ? `Saved: ${esc(st.summary_key_hint)}` : 'sk-ant-…'}" ${dis}>
              <span class="help">${st.summary_key_set ? 'Leave empty to keep the saved key.' : 'Stored encrypted on this server.'}</span></div>
            <div class="field"><label for="s-int">Regenerate every (hours)</label><input class="input" id="s-int" name="summary_interval_hours" type="number" min="1" max="168" value="${esc(st.summary_interval_hours)}" ${dis}>
              <span class="help">Each AI summary is one short request. Every 6 hours means 4 requests a day.</span></div>
            <label class="switch"><span><span style="display:block;font-weight:500">Let Claude search the web</span><span class="faint" style="font-size:12px">For chat answers and background tasks. Searches are billed by Anthropic on top of tokens.</span></span><input type="checkbox" data-setting="assistant_web_search" ${st.assistant_web_search ? 'checked' : ''} ${dis}></label>
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

function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 200)}px`;
  el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
}

const AFTER = {
  assistant() {
    const d = S.data;
    if (d.demo || !d.settings.summary_key_set) return;
    renderMsgs();
    autosize($('#chat-input'));
    const ready = S.chat.loaded ? Promise.resolve() : loadThreads();
    if (S.chat.pending) {
      const p = S.chat.pending;
      S.chat.pending = null;
      ready.then(() => sendChat(p)).catch((err) => toast(err.message, true));
      return;
    }
    if (!S.chat.loaded) {
      ready
        .then(() => {
          if (S.page !== 'assistant') return;
          if (!S.chat.thread && S.chat.threads[0] && !S.chat.streaming) return openThread(S.chat.threads[0].id);
          renderPage();
        })
        .catch((err) => toast(err.message, true));
    }
  },
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
    ${t.kind === 'builtin' ? '' : `<div class="section"><h4>Monthly budget</h4><form class="form" data-form="budget" data-id="${t.id}">
      <div class="field"><label for="t-budget">Budget in dollars</label><input class="input" id="t-budget" name="budget_usd" type="number" min="0" step="0.01" value="${esc(t.budget_usd ?? '')}" placeholder="None"><span class="help">Drives the limit bar and budget alerts. Leave empty for none.</span></div>
      <div class="form-actions"><button class="btn primary" type="submit">Save budget</button></div><div class="error-text" data-error></div></form></div>`}
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
    ${t.kind === 'builtin' ? '' : `<div class="section"><h4>Report tasks from your scripts</h4><div class="form" id="ingest-section">${ingestHelp(t)}
      <div class="form-actions"><button class="btn" data-action="rotate-token" data-id="${t.id}">Create new ingest token</button></div></div></div>`}
    <div class="section"><h4>Manage</h4><div class="form-actions" id="manage-actions">
      ${t.can_sync ? `<button class="btn" data-action="sync" data-id="${t.id}">Sync now</button>` : ''}
      <button class="btn" data-action="toggle-tool" data-id="${t.id}" data-enabled="${t.enabled ? 0 : 1}">${t.enabled ? 'Turn off' : 'Turn on'}</button>
      <button class="btn danger" data-action="remove-tool" data-id="${t.id}">Remove</button></div></div>`}`;
  openPanel(t.name, body);
}

function taskPrompt(t) {
  const what = t.status === 'failed' ? 'why it failed and what I can do about it'
    : t.status === 'running' ? 'how it is going and when it should finish'
      : t.status === 'completed' ? 'what it did and anything I should follow up on'
        : 'when it will run and whether anything is blocking it';
  return `Look at task #${t.id} (“${t.name}” on ${t.tool_name}) and tell me ${what}.`;
}

async function openTask(id) {
  const t = S.data.tasks.find((x) => x.id === Number(id));
  if (!t) return;
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const at = (iso) => iso && `${esc(when(iso))} <span class="faint">(${esc(rel(iso))})</span>`;
  const e = etaInfo(t);
  const claudeTask = t.runner === 'claude';
  const canAsk = !S.data.demo && S.data.settings.summary_key_set;
  const controls = claudeTask && !S.data.demo
    ? `<div class="form-actions">${t.controls.includes('cancel') ? `<button class="btn danger" data-action="task-cancel" data-id="${t.id}">Cancel task</button>` : ''}
        ${t.controls.includes('retry') ? `<button class="btn" data-action="task-retry" data-id="${t.id}">Run again</button>` : ''}</div>`
    : `<div class="form-actions"><button class="btn" disabled>Pause</button><button class="btn" disabled>Cancel</button><button class="btn" disabled>Restart</button></div>
       <p class="faint" style="font-size:12.5px;margin:8px 0 0">${esc(t.tool_name)} doesn’t offer task controls through this app. Stop or restart the task where it runs.</p>`;
  openPanel(t.name, `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${pill(TASK_STATUS[t.status].pill, TASK_STATUS[t.status].label)}${claudeTask ? '<span class="by-claude">Run by Claude</span>' : ''}</div>
    ${t.error ? `<div class="callout err">${esc(t.error)}</div>` : ''}
    ${t.step && t.status === 'running' ? `<p style="margin:0"><span class="faint">Now:</span> ${esc(t.step)}</p>` : ''}
    ${t.progress != null ? `<div class="meter" style="padding:0"><div class="meter-top"><span class="muted">Progress</span><b>${Math.round(t.progress)}%</b></div>${bar(t.progress, t.stalled ? 'err' : 'info')}</div>` : ''}
    ${e ? `<div class="callout ${e.cls === 'err' ? 'err' : e.cls === 'warn' ? 'warn' : 'info'}"><b>${esc(e.text)}</b>${e.basis ? `, ${esc(e.basis)}` : ''}.</div>` : ''}
    <dl class="detail-grid">
      ${row('Tool', esc(t.tool_name))}
      ${row('Started', at(t.started_at))}
      ${row('Expected finish', t.status === 'running' && t.eta_at && `${at(t.eta_at)}<div class="faint" style="font-size:12px">${esc(ETA_BASIS[t.eta_source] ?? '')}</div>`)}
      ${row('Usually takes', t.typical_ms && esc(dur(t.typical_ms)))}
      ${row('Scheduled for', t.scheduled_for && esc(when(t.scheduled_for)))}
      ${row('Finished', t.finished_at && esc(when(t.finished_at)))}
      ${row('Took', t.finished_at && t.started_at && esc(dur(Date.parse(t.finished_at) - Date.parse(t.started_at))))}
      ${row('Last update', esc(when(t.updated_at)))}
      ${row('Task ID', `<code>${esc(t.external_id)}</code>`)}
    </dl>
    <div class="section" id="task-detail">${t.description ? `<h4>${claudeTask ? 'Instructions' : 'Description'}</h4><p style="margin:0;white-space:pre-wrap">${esc(t.description)}</p>` : ''}</div>
    ${canAsk ? `<div class="form-actions"><button class="btn" data-action="ask-task" data-id="${t.id}">${ICON.claude}Ask Claude about this task</button></div>` : ''}
    <div class="section"><h4>Controls</h4>${controls}</div>`);
  if (S.data.demo || !t.has_result) return;
  try {
    const detail = await api(`/api/tasks/${t.id}`);
    const box = $('#task-detail');
    if (!box || !detail.result) return;
    box.insertAdjacentHTML('afterend', `<div class="section"><h4>Result</h4>
      <div class="result md" id="task-result">${md(detail.result)}</div>
      <pre id="task-result-raw" hidden>${esc(detail.result)}</pre>
      <div class="form-actions" style="margin-top:8px"><button class="btn small" data-action="copy" data-target="task-result-raw">Copy result</button></div></div>`);
  } catch (err) {
    toast(err.message, true);
  }
}

function openNewClaudeTask(preset = {}) {
  openPanel('New Claude task', `
    <form class="form" data-form="claude-task">
      <p class="muted" style="margin:0;font-size:13px">Claude works on this in the background and reports its progress, so you can see how far along it is and when it should finish. The result is saved on the task. It can read your dashboard data${S.data.settings.assistant_web_search ? ' and search the web' : ''}.</p>
      <div class="field"><label for="ct-name">Name</label><input class="input" id="ct-name" name="name" maxlength="80" required value="${esc(preset.name ?? '')}" placeholder="Monthly usage report"></div>
      <div class="field"><label for="ct-ins">What should Claude do?</label><textarea class="input" id="ct-ins" name="instructions" rows="6" maxlength="2000" required placeholder="Summarize this month’s spending by tool, flag anything close to budget, and suggest where to cut back.">${esc(preset.instructions ?? '')}</textarea>
        <span class="help">Be specific about what you want back. Uses your Claude API key.</span></div>
      <div class="form-actions"><button class="btn primary" type="submit">Start task</button></div>
      <div class="error-text" data-error></div>
    </form>`, { center: true });
  $('#ct-name')?.focus();
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
  async 'claude-task'(fd) {
    const r = await api('/api/claude-tasks', { method: 'POST', body: { name: fd.name, instructions: fd.instructions } });
    closeModal();
    toast(r.status === 'queued' ? 'Task queued. It starts when a running Claude task finishes.' : 'Task started');
    S.taskFilter = 'all';
    await load({ force: true });
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
  if (form.dataset.form === 'ask' || form.dataset.form === 'chat') {
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (!text) return;
    if (form.dataset.form === 'ask') return askClaude(text);
    if (S.chat.streaming) return;
    form.reset();
    autosize($('#chat-input'));
    return sendChat(text).catch((err) => toast(err.message, true));
  }
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
  ask: (el) => askClaude(el.dataset.prompt),
  'ask-here': (el) => sendChat(el.dataset.prompt),
  'ask-task'(el) {
    const t = S.data.tasks.find((x) => x.id === Number(el.dataset.id));
    closeModal();
    if (t) askClaude(taskPrompt(t));
  },
  'new-chat'() {
    S.chat.thread = null;
    S.chat.draft = '';
    renderPage();
    $('#chat-input')?.focus();
  },
  'delete-chat'(el) {
    el.closest('.chat-bar').innerHTML = `<span class="muted" style="flex:1;font-size:13px">Delete “${esc(S.chat.thread.title)}”? This can’t be undone.</span>
      <button class="btn danger" data-action="confirm-delete-chat">Delete</button><button class="btn ghost" data-action="cancel-delete-chat">Cancel</button>`;
  },
  'cancel-delete-chat': () => renderPage(),
  async 'confirm-delete-chat'() {
    const id = S.chat.thread.id;
    await api(`/api/assistant/threads/${id}`, { method: 'DELETE' });
    S.chat.threads = S.chat.threads.filter((t) => t.id !== id);
    S.chat.thread = null;
    toast('Conversation deleted');
    renderPage();
  },
  async 'stop-chat'() {
    if (S.chat.thread) await api(`/api/assistant/threads/${S.chat.thread.id}/stop`, { method: 'POST' });
  },
  'new-claude-task': () => openNewClaudeTask(),
  async 'task-cancel'(el) {
    el.disabled = true;
    await api(`/api/tasks/${el.dataset.id}/cancel`, { method: 'POST' });
    toast('Cancelling the task');
    closeModal();
    setTimeout(() => load({ force: true }), 800);
  },
  async 'task-retry'(el) {
    el.disabled = true;
    await api(`/api/tasks/${el.dataset.id}/retry`, { method: 'POST' });
    toast('Task started again');
    closeModal();
    await load({ force: true });
  },
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
      toast('Press Ctrl+C or ⌘C to copy the selected text.');
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
  if (el.dataset.actionChange === 'pick-thread') {
    if (el.value) openThread(el.value).catch((err) => toast(err.message, true));
    return;
  }
  if (el.dataset.setting) {
    try {
      await api('/api/settings', { method: 'PUT', body: { [el.dataset.setting]: el.checked } });
      toast('Setting saved');
      await load({ force: true });
    } catch (err) {
      el.checked = !el.checked;
      toast(err.message, true);
    }
    return;
  }
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
    document.addEventListener('input', (e) => e.target.id === 'chat-input' && autosize(e.target));
    document.addEventListener('keydown', (e) => {
      if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        e.target.form.requestSubmit();
        return;
      }
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
  schedulePoll();
}

boot();
