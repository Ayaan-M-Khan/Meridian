import { mountMap, buildMapModel, mapListHtml } from './map.js';

// ── Helpers ──────────────────────────────────────────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtUsd = (n) => (n == null ? null : n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);
const fmtNum = (n) =>
  n == null ? null : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
const fmtPct = (n) => (n == null ? null : `${Math.round(n)}%`);
const or = (v, label = 'Not available') => (v == null ? `<span class="faint">${esc(label)}</span>` : esc(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
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
const sumOrNull = (xs) => (xs.some((v) => v != null) ? xs.reduce((a, v) => a + (v ?? 0), 0) : null);

const svg = (body, attrs = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"') =>
  `<svg viewBox="0 0 16 16" ${attrs} aria-hidden="true">${body}</svg>`;
const ICON = {
  grid: svg('<rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.4"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.4"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.4"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.4"/>', 'fill="currentColor"'),
  tools: svg('<rect x="2" y="2" width="12" height="4" rx="1.2"/><rect x="2" y="10" width="12" height="4" rx="1.2"/><circle cx="5" cy="4" r=".6" fill="currentColor"/><circle cx="5" cy="12" r=".6" fill="currentColor"/>'),
  chart: svg('<path d="M2 14h12"/><path d="M4 11V8M8 11V4M12 11V6.5"/>'),
  tasks: svg('<path d="M6 4h8M6 8h8M6 12h8"/><path d="M2 4l.8.8L4 3.4M2 8l.8.8L4 7.4M2 12l.8.8L4 11.4"/>'),
  bell: svg('<path d="M8 2a4.5 4.5 0 0 0-4.5 4.5V9L2.5 11h11l-1-2V6.5A4.5 4.5 0 0 0 8 2z"/><path d="M6.5 13.2a1.6 1.6 0 0 0 3 0"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>'),
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>', 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'),
  play: svg('<path d="M5 3.5v9l7-4.5z"/>', 'fill="currentColor"'),
  clock: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.2l2 1.3"/>'),
  check: svg('<path d="M3.5 8.3l3 3 6-6.5"/>', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'),
  x: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'),
  warn: svg('<path d="M8 2.2l6 10.6H2z"/><path d="M8 6.5v2.8M8 11.2v.1"/>'),
  info: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6M8 5.2v.1"/>'),
  spark: svg('<path d="M8 1.2l1.7 4.6 4.6 1.7-4.6 1.7L8 13.8 6.3 9.2 1.7 7.5l4.6-1.7z"/>', 'fill="currentColor"'),
  send: svg('<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>', 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.5"/>', 'fill="currentColor"'),
  plus: svg('<path d="M8 3v10M3 8h10"/>', 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  terminal: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3"/>'),
  key: svg('<circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3L13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2"/>'),
  pencil: svg('<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/><path d="M9 4l3 3"/>'),
  signin: svg('<path d="M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3"/><path d="M2.5 8h7M6.5 5l3 3-3 3"/>'),
  download: svg('<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5"/><path d="M2.5 13.5h11"/>'),
  chevron: svg('<path d="M6 3.5L10.5 8 6 12.5"/>'),
  external: svg('<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>'),
  chat: svg('<path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11h0A1.5 1.5 0 0 1 2.5 9.5z"/>'),
  sun: svg('<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"/>'),
  bolt: svg('<path d="M9 1.5L3.5 9h4L7 14.5 12.5 7h-4z"/>'),
  team: svg('<circle cx="8" cy="3.6" r="2"/><circle cx="3.4" cy="11.6" r="2"/><circle cx="12.6" cy="11.6" r="2"/><path d="M7 5.4L4.4 9.8M9 5.4l2.6 4.4M5.4 11.6h5.2"/>'),
  folder: svg('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'),
  pulse: svg('<path d="M1.5 8.5h3l1.8-4.5 3.2 8 1.8-3.5h3.2"/>'),
  repeat: svg('<path d="M2.8 7A5.2 5.2 0 0 1 12.4 4.4M13.2 9a5.2 5.2 0 0 1-9.6 2.6"/><path d="M12.8 1.8v2.9H9.9M3.2 14.2v-2.9h2.9"/>'),
  search: svg('<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4l3.6 3.6"/>'),
  // Meridian's mark: a globe with one meridian, and a marker at its north point.
  brand: svg('<circle cx="8" cy="8.7" r="5.5"/><ellipse cx="8" cy="8.7" rx="2.15" ry="5.5"/><circle cx="8" cy="3.2" r="1.55" style="fill: var(--brand-dot, #3d8bfd); stroke: none"/>', 'fill="none" stroke="currentColor" stroke-width="1.35"'),
  shield: svg('<path d="M8 1.6l5.2 2v4.1c0 3.2-2.2 5.6-5.2 6.7-3-1.1-5.2-3.5-5.2-6.7V3.6z"/><path d="M5.8 8l1.6 1.6 2.9-3"/>'),
  map: svg('<path d="M1.8 3.6l4-1.6 4.4 1.8 4-1.6v10.2l-4 1.6-4.4-1.8-4 1.6z"/><path d="M5.8 2v10.2M10.2 3.8V14"/>'),
  pause: svg('<path d="M5.5 3.5v9M10.5 3.5v9"/>', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'),
};
ICON.claude = ICON.spark;

const PAGES = {
  dashboard: { title: 'Overview', icon: 'grid', short: 'Home' },
  map: { title: 'Map', icon: 'map', short: 'Map' },
  assistant: { title: 'Assistant', icon: 'chat', short: 'Assistant' },
  tasks: { title: 'Tasks', icon: 'tasks', short: 'Tasks' },
  automations: { title: 'Automations', icon: 'repeat', short: 'Auto' },
  usage: { title: 'Usage & Costs', icon: 'chart', short: 'Usage' },
  stats: { title: 'Statistics', icon: 'pulse', short: 'Stats' },
  notifications: { title: 'Alerts', icon: 'bell', short: 'Alerts' },
  security: { title: 'Sign-in & security', icon: 'key', short: 'Security' },
  privacy: { title: 'Privacy & data', icon: 'shield', short: 'Privacy' },
  tools: { title: 'AI Tools', icon: 'tools', short: 'Tools' },
  settings: { title: 'Settings', icon: 'gear', short: 'Settings' },
  tool: { title: 'Tool', icon: 'tools', short: 'Tool' },
};
const TASK_STATUS = {
  running: { label: 'Running', icon: 'play', pill: 's-running' },
  queued: { label: 'Queued', icon: 'clock', pill: 's-queued' },
  scheduled: { label: 'Scheduled', icon: 'clock', pill: 's-scheduled' },
  completed: { label: 'Completed', icon: 'check', pill: 's-completed' },
  failed: { label: 'Failed', icon: 'x', pill: 's-failed' },
};
const SESSION_STATUS = { running: { label: 'Active', pill: 's-running' }, completed: { label: 'Idle', pill: 's-queued' } };
const SEVERITY_ICON = { err: 'x', warn: 'warn', ok: 'check', info: 'info' };
const CAP_NAME = { usage: 'Usage', cost: 'Cost', limits: 'Limits', tasks: 'Tasks', control: 'Controls' };
const CAP_SHORT = { api: 'API', local: 'This computer', manual: 'You log it', webhook: 'Your scripts', app: 'This app', none: 'None' };
const CAP_LONG = {
  api: 'Read automatically from the provider’s official API',
  local: 'Read from the app’s own files on this computer',
  manual: 'Entered by you in this app',
  webhook: 'Reported by your own scripts with the ingest token',
  app: 'Measured or controlled by this app itself',
  none: 'Not available for this service',
};
const NOTIFY_LABELS = {
  my_task_done: ['Your tasks', 'When an assistant or AI team task you started finishes or fails'],
  security: ['Sign-in and security', 'New sign-ins, password changes and two-step verification changes'],
  update: ['App updates', 'When a new version of Meridian is available'],
  task_failed: ['Failed tasks', 'When a reported task fails'],
  task_completed: ['Completed tasks', 'When a reported task finishes'],
  task_stalled: ['Stalled tasks', 'When a task that reports progress stops updating'],
  task_overdue: ['Overdue tasks', 'When a task runs well past its expected finish'],
  scheduled: ['Upcoming scheduled tasks', 'An hour before a scheduled task starts'],
  usage_warning: ['Budget warnings', 'When a tool or your total passes the warning level'],
  limit_reached: ['Budget reached', 'When a tool or your total reaches its budget'],
  connection: ['Connection failures', 'When a tool can’t sync'],
  spike: ['Unusual spending', 'When a day costs far more than the previous week’s average'],
};
const HUE = { Anthropic: 'clay', OpenAI: 'mint', Google: 'blue', GitHub: 'slate', Anysphere: 'slate', 'Perplexity AI': 'teal', 'Your own': 'violet', 'Meridian': 'brand' };
const KIND_LABEL = { local: 'Your account, no API key', api: 'API key', manual: 'Tracked manually', builtin: 'Built in' };

const S = {
  user: null,
  data: null,
  demo: readStore('acc-demo') === '1',
  ...routeFromHash(),
  taskFilter: 'all',
  catalog: null,
  local: null,
  localLoading: null,
  add: null,
  charts: [],
  loadError: null,
  timer: null,
  waiting: {}, // adapter id -> 'signin' | 'install' while the app waits for you to finish
  flashTool: null,
  confirmRemove: null,
  heroMode: ['team', 'compare'].includes(readStore('acc-hero-mode')) ? readStore('acc-hero-mode') : 'ask',
  dock: readStore('acc-dock') === '1',
  chat: { loaded: false, threads: [], thread: null, streaming: false, pending: null, draft: '' },
};

function readStore(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeStore(k, v) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}
function routeFromHash() {
  const h = location.hash.slice(1);
  const m = h.match(/^tool-(\d+)$/);
  if (m) return { page: 'tool', toolId: Number(m[1]) };
  return { page: PAGES[h] && h !== 'tool' ? h : 'dashboard', toolId: null };
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-acc-request': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
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
  t.setAttribute('role', isErr ? 'alert' : 'status');
  t.setAttribute('aria-live', isErr ? 'assertive' : 'polite');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6500 : 3200);
}

// ── Logos ────────────────────────────────────────────────────────────────
const MONO = { 'claude-code': 'CC', codex: 'Cx', 'gemini-cli': 'Ge', 'antigravity-cli': 'Ag', 'copilot-cli': 'GH', 'cursor-cli': 'Cu', anthropic: 'An', openai: 'OA', 'claude-api': 'An' };
function monogram(name) {
  const words = String(name ?? '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return esc(words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase()));
  return esc((words[0][0] + words[1][0]).toUpperCase());
}
/** A vendor-tinted monogram tile. It is a label, not the vendor's logo. */
function logo(item, size = '') {
  const hue = HUE[item.vendor] ?? 'slate';
  const inner = item.kind === 'builtin' ? ICON.spark : MONO[item.adapter] ?? monogram(item.adapter_name ?? item.name);
  return `<span class="logo ${size} hue-${hue}" aria-hidden="true">${inner}</span>`;
}
const engineLogo = (e, size = '') => logo({ vendor: e.vendor, name: e.label, adapter: e.id }, size);
const ENGINE_VENDOR = { 'claude-code': 'Anthropic', 'claude-api': 'Anthropic', codex: 'OpenAI', 'gemini-cli': 'Google', 'antigravity-cli': 'Google', 'copilot-cli': 'GitHub', 'cursor-cli': 'Anysphere' };
const engineById = (id, label) => engineLogo({ id, label, vendor: ENGINE_VENDOR[id] }, 'xs');

// ── Sign-in ──────────────────────────────────────────────────────────────
// Google's "G" mark, used as Google's sign-in branding guidelines describe (on a plain button, with "Continue with Google").
const GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
const EYE = svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>');

async function showAuth(view = null, message = '') {
  closeModal();
  if (S.pal) closePalette({ restore: false });
  document.body.classList.remove('dock-open');
  clearTimeout(S.timer);
  S.mapInst?.destroy();
  S.mapInst = null;
  const st = await fetch('/api/auth/status').then((r) => r.json()).catch(() => ({ setupRequired: false }));
  S.auth = { setup: Boolean(st.setupRequired), google: Boolean(st.google), version: st.version ?? '', view: view ?? (st.setupRequired ? 'setup' : 'login'), challenge: null, flow: null, message };
  renderAuth();
}

/** How strong a new password looks, 0–4, from its length and variety. The server's rules decide. */
function passwordScore(pw, username = '') {
  if (!pw) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((r) => r.test(pw)).length;
  let score = pw.length >= 20 ? 3 : pw.length >= 16 ? 2 : pw.length >= 12 ? 1 : 0;
  if (score && kinds >= 3) score += 1;
  if (username && pw.toLowerCase().includes(username.toLowerCase())) score = Math.min(score, 1);
  if (new Set(pw).size < 6) score = 0;
  return Math.min(4, score);
}
const SCORE_LABEL = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

function renderAuth() {
  const a = S.auth;
  const preset = new URLSearchParams(location.search).get('setup');
  const passField = (id, label, auto, extra = '') => `<div class="si-field"><label for="${id}">${label}</label>
    <div class="si-pass"><input class="si-input" id="${id}" name="${id === 'f-pass' ? 'password' : id === 'f-pass2' ? 'confirm' : 'password'}" type="password" autocomplete="${auto}" required maxlength="200" ${extra}>
      <button type="button" class="si-eye" data-action="toggle-pass" data-target="${id}" aria-label="Show password" aria-pressed="false" title="Show password">${EYE}</button></div></div>`;
  const remember = `<label class="si-check"><input type="checkbox" name="remember" id="f-remember" value="1"><span>Keep me signed in on this computer for 30 days</span></label>`;
  const errorBox = `<div class="si-error" data-error role="alert">${esc(a.message ?? '')}</div>`;
  let main;
  if (a.view === 'setup') {
    main = `<form class="si-form" data-form="setup" autocomplete="on">
      <div class="si-step">First run</div>
      <h1>Create your account</h1>
      <p class="si-lead">This is the only account for Meridian on this computer. You’ll use it to sign in each time.</p>
      <div class="si-field"><label for="f-user">Username</label><input class="si-input" id="f-user" name="username" autocomplete="username" required autocapitalize="off" spellcheck="false" maxlength="64"></div>
      ${passField('f-pass', 'Password', 'new-password', 'minlength="12" aria-describedby="pw-rules"')}
      <div class="si-meter" aria-hidden="true"><i id="pw-bar"></i></div>
      <ul class="si-rules" id="pw-rules"><li data-rule="len">At least 12 characters</li><li data-rule="mix">A mix of letters, numbers or symbols</li><li data-rule="user">Doesn’t contain your username</li></ul>
      ${passField('f-pass2', 'Confirm password', 'new-password')}
      ${preset ? `<input type="hidden" name="setupCode" value="${esc(preset)}">` : '<div class="si-field"><label for="f-code">Setup code</label><input class="si-input" id="f-code" name="setupCode" autocomplete="one-time-code" required spellcheck="false"><span class="si-help">Printed in the server console when it started.</span></div>'}
      ${remember}
      <button class="si-btn primary" type="submit">Create account</button>
      ${errorBox}
      <p class="si-fine">Your account and everything the app keeps stay on this computer. There’s no analytics or tracking. Data goes to an AI company only when you use that AI, under your own account with it. You can see, export or delete all of it under Privacy &amp; data.</p>
    </form>`;
  } else if (a.view === 'verify') {
    main = `<form class="si-form" data-form="verify" autocomplete="off">
      <div class="si-step">Two-step verification</div>
      <h1>Enter your code</h1>
      <p class="si-lead">Open your authenticator app and enter the 6-digit code for Meridian.</p>
      <div class="si-field"><label for="f-code2">Verification code</label><input class="si-input si-code" id="f-code2" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="12" spellcheck="false" placeholder="123 456"></div>
      <button class="si-btn primary" type="submit">Verify and sign in</button>
      ${errorBox}
      <p class="si-fine">Lost your phone? Enter one of your recovery codes, like 7KQ4-M2XP, instead. Each works once.</p>
      <button type="button" class="si-link" data-action="auth-back">Use a different account</button>
    </form>`;
  } else if (a.view === 'google-wait') {
    main = `<div class="si-form">
      <div class="si-step">Sign in with Google</div>
      <h1>Continue in your browser</h1>
      <p class="si-lead">Google’s sign-in page opened in your web browser. Choose your account there; this window signs you in as soon as you’re done.</p>
      <div class="si-wait"><span class="spin"></span><span>Waiting for Google…</span></div>
      ${errorBox}
      <div class="si-row"><button type="button" class="si-btn" data-action="google-reopen">Open the page again</button><button type="button" class="si-link" data-action="google-cancel">Cancel</button></div>
      <p class="si-fine">Google doesn’t allow its sign-in page inside apps, so it opens in your browser. Nothing from your browser is shared with this app except the sign-in result.</p>
    </div>`;
  } else {
    main = `<form class="si-form" data-form="login" autocomplete="on">
      <h1>Sign in</h1>
      <p class="si-lead">Use your Meridian account on this computer.</p>
      <div class="si-field"><label for="f-user">Username</label><input class="si-input" id="f-user" name="username" autocomplete="username" required autocapitalize="off" spellcheck="false" maxlength="64"></div>
      ${passField('f-pass', 'Password', 'current-password')}
      <div class="si-caps" id="caps" hidden>Caps Lock is on</div>
      ${remember}
      <button class="si-btn primary" type="submit">Sign in</button>
      ${errorBox}
      ${a.google ? `<div class="si-or" role="separator"><span>or</span></div><button type="button" class="si-btn google" data-action="google-signin">${GOOGLE_G}<span>Continue with Google</span></button>` : ''}
      <p class="si-fine">Forgot your password? ${a.google ? 'Continue with Google, then set a new one in Sign-in &amp; security.' : 'There’s no email reset, because nothing leaves this computer. Once signed in, link a Google account in Sign-in &amp; security, and you can use it to set a new password if you forget this one.'}</p>
    </form>`;
  }
  $('#root').innerHTML = `<div class="si">
    <div class="si-shell">
      <aside class="si-brand" aria-label="About Meridian">
        <div class="si-mark">${ICON.brand}</div>
        <div class="si-name">Meridian</div>
        <h2 class="si-tag">Your AI tools, usage and work, in one secure place.</h2>
        <ul class="si-points">
          <li>${ICON.shield}<span><b>Stays on this computer.</b> Your data leaves it only when you use an AI, under your own account.</span></li>
          <li>${ICON.key}<span><b>Protected.</b> Passwords are hashed, keys are encrypted, and sign-in attempts are limited.</span></li>
          <li>${svg('<rect x="4" y="1.8" width="8" height="12.4" rx="1.6"/><path d="M7 11.6h2"/>')}<span><b>Two-step verification.</b> Add a code from your phone for extra protection.</span></li>
        </ul>
        <div class="si-foot">${a.version ? `Version ${esc(a.version)} · ` : ''}Not affiliated with the AI companies whose tools it shows.</div>
      </aside>
      <main class="si-main">${main}</main>
    </div></div>`;
  ($('#f-user') ?? $('#f-code2') ?? $('.si-main button'))?.focus();
}

/** Opens Google's sign-in page in the browser and waits for the result. */
async function googleFlow(path, body, onDone) {
  const r = await api(path, { method: 'POST', body });
  S.googleFlow = { flow: r.flow, url: r.url, started: Date.now() };
  window.open(r.url, '_blank', 'noopener');
  const tick = async () => {
    const g = S.googleFlow;
    if (!g || g.flow !== r.flow) return;
    if (Date.now() - g.started > 10 * 60_000) {
      S.googleFlow = null;
      return onDone({ status: 'expired' });
    }
    try {
      const p = await api('/api/auth/google/poll', { method: 'POST', body: { flow: g.flow } });
      if (p.status === 'pending') {
        g.timer = setTimeout(tick, 1500);
        return;
      }
      S.googleFlow = null;
      onDone(p);
    } catch (err) {
      g.timer = setTimeout(tick, 3000);
    }
  };
  S.googleFlow.timer = setTimeout(tick, 1500);
}
function stopGoogleFlow() {
  const g = S.googleFlow;
  if (!g) return;
  clearTimeout(g.timer);
  S.googleFlow = null;
  api('/api/auth/google/cancel', { method: 'POST', body: { flow: g.flow } }).catch(() => {});
}

/** The strength bar and rule ticks under a new password. */
function updatePasswordRules(form) {
  const pw = form.querySelector('#f-pass, #cp-next')?.value ?? '';
  const user = form.querySelector('#f-user')?.value ?? S.user?.username ?? '';
  const score = passwordScore(pw, user);
  const bar = form.querySelector('#pw-bar, #cp-bar');
  if (bar) {
    bar.style.width = `${pw ? Math.max(8, score * 25) : 0}%`;
    bar.dataset.score = String(score);
    bar.parentElement.title = pw ? SCORE_LABEL[score] : '';
  }
  const rules = { len: pw.length >= 12, mix: [/[a-z]/i, /\d/, /[^\w\s]/].filter((r) => r.test(pw)).length >= 2, user: !user || !pw.toLowerCase().includes(user.toLowerCase()) };
  for (const li of form.querySelectorAll('[data-rule]')) li.classList.toggle('ok', Boolean(pw) && rules[li.dataset.rule]);
}

// ── Shell ────────────────────────────────────────────────────────────────
function renderShell() {
  const act = (key) => `<a href="#${key}" class="wb-act" data-nav="${key}" title="${esc(PAGES[key].title)}" aria-label="${esc(PAGES[key].title)}">${ICON[PAGES[key].icon]}<span class="dot-badge" data-count="${key}" hidden></span></a>`;
  const tab = (key) => `<a href="#${key}" data-nav="${key}">${ICON[PAGES[key].icon]}<span>${PAGES[key].short}</span><span class="dot-badge" data-count="${key}" hidden></span></a>`;
  $('#root').innerHTML = `
  <button class="skip-link" data-action="skip">Skip to content</button>
  <div class="wb">
    <nav class="wb-activity" aria-label="Main">
      <a class="wb-logo" href="#dashboard" title="Meridian" aria-label="Meridian overview">${ICON.brand}</a>
      ${['dashboard', 'map', 'assistant', 'tasks', 'automations', 'usage', 'stats', 'notifications'].map(act).join('')}
      <div class="wb-grow"></div>
      ${['tools', 'security', 'privacy', 'settings'].map(act).join('')}
    </nav>
    <aside class="wb-side sidebar" aria-label="Explorer">
      <div class="wb-side-head"><span>Explorer</span>
        <div class="wb-side-actions">
          <button class="wb-icon" data-action="open-palette" title="Search and commands (Ctrl+P)" aria-label="Search and commands">${ICON.search}</button>
          <button class="wb-icon" data-action="add-tool" title="Connect a tool" aria-label="Connect a tool">${ICON.plus}</button>
          <button class="wb-icon" data-action="reload" title="Refresh" aria-label="Refresh">${ICON.refresh}</button>
        </div></div>
      <div class="wb-tree nav">
        <details class="wb-sec" open><summary>${ICON.chevron}<span>Connected</span><span class="wb-sec-n" id="sec-n-tools"></span></summary><div class="nav-tools" id="nav-tools"></div></details>
        <details class="wb-sec" open><summary>${ICON.chevron}<span>Running</span><span class="wb-sec-n" id="sec-n-running"></span></summary><div id="nav-running"></div></details>
        <details class="wb-sec" open><summary>${ICON.chevron}<span>Up next</span><span class="wb-sec-n" id="sec-n-next"></span></summary><div id="nav-next"></div></details>
      </div>
      <div class="sidebar-foot"><span class="avatar">${esc(S.user.username.slice(0, 1).toUpperCase())}</span><span class="who">${esc(S.user.username)}</span><button class="btn small ghost" data-action="logout">Sign out</button></div>
    </aside>
    <div class="wb-main main">
      <div class="wb-tabs" id="wb-tabs" role="tablist" aria-label="Open pages"></div>
      <header class="wb-bar topbar">
        <nav class="wb-crumbs topbar-title" aria-label="You are here"><span class="wb-crumb-root">Meridian</span><span class="wb-crumb-sep" aria-hidden="true">›</span><h1 id="page-title"></h1></nav>
        <button class="wb-search" data-action="open-palette" aria-label="Search or run a command">${ICON.search}<span>Search or run a command</span><kbd>Ctrl P</kbd></button>
        <button class="btn icon-btn ghost" data-action="toggle-dock" aria-pressed="false" aria-label="Chat panel" title="Chat panel (Ctrl+L)">${ICON.chat}</button>
        <a class="btn icon-btn ghost" href="#notifications" aria-label="Alerts" title="Alerts">${ICON.bell}<span class="dot-badge" id="bell-count" hidden></span></a>
        <a class="btn icon-btn ghost hide-lg" href="#settings" aria-label="Settings">${ICON.gear}</a>
      </header>
      <div class="demo-banner" id="demo-banner" hidden>
        <span>You’re looking at demo data. None of it comes from your accounts.</span>
        <button class="btn small" data-action="toggle-demo">Exit demo</button>
      </div>
      <div class="wb-body">
        <main class="content" id="content" tabindex="-1"></main>
        <aside class="wb-dock" id="dock" aria-label="Chat" hidden></aside>
      </div>
      <nav class="tabbar" aria-label="Main">${['dashboard', 'map', 'assistant', 'tasks', 'tools'].map(tab).join('')}</nav>
    </div>
  </div>
  <footer class="wb-status" id="wb-status" aria-label="Status">
    <div class="wb-status-left" id="wb-status-left"></div>
    <div class="wb-status-right"><span class="wb-si updated" id="updated"></span><a class="wb-si update-pill" id="update-pill" href="#settings" data-action="go-update" hidden></a><span class="wb-si" id="wb-version"></span></div>
  </footer>
  <div id="palette-root"></div>`;
}

// ── Tabs, explorer and status bar ────────────────────────────────────────
const tabKey = () => (S.page === 'tool' ? `tool-${S.toolId}` : S.page);
S.tabs = (() => {
  try {
    const t = JSON.parse(readStore('acc-tabs') ?? '[]');
    return Array.isArray(t) ? t.filter((k) => typeof k === 'string' && (PAGES[k] || /^tool-\d+$/.test(k))).slice(0, 10) : [];
  } catch {
    return [];
  }
})();
const saveTabs = () => writeStore('acc-tabs', JSON.stringify(S.tabs));

function tabLabel(key) {
  const m = key.match(/^tool-(\d+)$/);
  if (m) {
    const t = S.data?.tools.find((x) => x.id === Number(m[1]));
    return t ? { text: t.name, icon: logo(t, 'xs') } : null;
  }
  return PAGES[key] ? { text: PAGES[key].title, icon: ICON[PAGES[key].icon] } : null;
}

/** Open pages as tabs, like an editor: the current page is added, and tabs for removed tools disappear. */
function updateTabs() {
  const el = $('#wb-tabs');
  if (!el) return;
  const cur = tabKey();
  if (!S.tabs.includes(cur)) {
    S.tabs.push(cur);
    while (S.tabs.length > 10) S.tabs.splice(S.tabs.findIndex((k) => k !== cur), 1);
  }
  // Until the data arrives, tool tabs can't be named yet; keep them rather than dropping them.
  if (S.data) S.tabs = S.tabs.filter((k) => tabLabel(k) || k === cur);
  saveTabs();
  el.innerHTML = S.tabs.map((k) => {
    const l = tabLabel(k) ?? { text: currentTitle(), icon: ICON.grid };
    const on = k === cur;
    return `<div class="wb-tab ${on ? 'on' : ''}" role="presentation"><a role="tab" aria-selected="${on}" href="#${k}" title="${esc(l.text)}">${l.icon}<span>${esc(l.text)}</span></a>
      <button class="wb-tab-x" data-action="close-tab" data-key="${esc(k)}" aria-label="Close ${esc(l.text)}" title="Close">${ICON.close}</button></div>`;
  }).join('');
  el.querySelector('.wb-tab.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function closeTab(key) {
  const i = S.tabs.indexOf(key);
  if (i < 0) return;
  S.tabs.splice(i, 1);
  saveTabs();
  if (key === tabKey()) location.hash = `#${S.tabs[Math.min(i, S.tabs.length - 1)] ?? 'dashboard'}`;
  else updateTabs();
}

/** The explorer's Running and Up next sections. */
function updateExplorer() {
  const d = S.data;
  const run = $('#nav-running');
  const next = $('#nav-next');
  if (!d || !run || !next) return;
  const running = d.tasks.filter((t) => t.status === 'running').sort((a, b) => (a.kind === 'session') - (b.kind === 'session')).slice(0, 6);
  run.innerHTML = running.length
    ? running.map((t) => `<button class="wb-item" data-action="open-task" data-id="${t.id}" title="${esc(`${t.name} · ${t.tool_name}`)}"><span class="nav-dot d-ok pulse"></span><span class="wb-item-name">${esc(t.name)}</span><span class="wb-item-meta">${t.progress != null && t.kind !== 'session' ? `${Math.round(t.progress)}%` : t.kind === 'session' ? 'live' : ''}</span></button>`).join('')
    : '<div class="wb-empty">Nothing running</div>';
  const autos = (d.automations ?? []).filter((a) => a.enabled && a.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at));
  const items = [
    ...d.upcoming.slice(0, 3).map((t) => `<button class="wb-item" data-action="open-task" data-id="${t.id}" title="${esc(t.name)}">${ICON.clock}<span class="wb-item-name">${esc(t.name)}</span><span class="wb-item-meta">${esc(t.status)}</span></button>`),
    ...autos.slice(0, 4).map((a) => `<a class="wb-item" href="#automations" title="${esc(`${a.name} · ${a.schedule_text}`)}">${ICON.repeat}<span class="wb-item-name">${esc(a.name)}</span><span class="wb-item-meta">${esc(rel(a.next_run_at))}</span></a>`),
  ];
  next.innerHTML = items.length ? items.join('') : '<div class="wb-empty">Nothing scheduled</div>';
  const setN = (id, n) => {
    const e = $(id);
    if (e) e.textContent = n ? String(n) : '';
  };
  setN('#sec-n-tools', d.tools.filter((t) => t.kind !== 'builtin').length);
  setN('#sec-n-running', running.length);
  setN('#sec-n-next', items.length);
}

/** The status bar: which AI answers, connections, live work, the next automation, and the app's version. */
function updateStatus() {
  const d = S.data;
  const left = $('#wb-status-left');
  if (!left) return;
  if (!d) {
    left.innerHTML = '';
    return;
  }
  const s = d.stats;
  const engine = d.engine_choice === 'auto' ? 'Automatic' : d.engine?.label ?? 'No AI';
  const next = (d.automations ?? []).filter((a) => a.enabled && a.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
  left.innerHTML = [
    d.demo ? '<button class="wb-si wb-si-demo" data-action="toggle-demo" title="Exit demo">Demo data</button>' : '',
    `<a class="wb-si" href="#settings" title="Which AI answers">${ICON.spark}<span>${esc(engine)}</span></a>`,
    `<a class="wb-si ${s.needs_attention ? 'warn' : ''}" href="#tools" title="Connected tools"><span class="nav-dot ${s.needs_attention ? 'd-warn' : 'd-ok'}"></span><span>${plural(s.connected, 'tool')}${s.needs_attention ? ` · ${s.needs_attention} need attention` : ''}</span></a>`,
    `<a class="wb-si" href="#tasks" title="Running now">${ICON.play}<span>${s.running} running</span></a>`,
    next ? `<a class="wb-si hide-md" href="#automations" title="${esc(next.name)}">${ICON.repeat}<span>${esc(next.name)} ${esc(rel(next.next_run_at))}</span></a>` : '',
  ].join('');
  const v = $('#wb-version');
  if (v) v.textContent = d.update?.current ? `v${d.update.current}` : '';
}

function navTools() {
  const el = $('#nav-tools');
  if (!el) return;
  const tools = (S.data?.tools ?? []).filter((t) => t.kind !== 'builtin');
  if (!tools.length) {
    el.innerHTML = '<button class="nav-empty" data-action="add-tool">Connect your first AI tool</button>';
    return;
  }
  el.innerHTML = tools.map((t) => {
    const st = toolStatus(t);
    const busy = t.sessions_running || t.current_activity;
    const cur = S.page === 'tool' && S.toolId === t.id ? 'aria-current="page"' : '';
    return `<a href="#tool-${t.id}" class="nav-tool ${S.flashTool === t.id ? 'flash' : ''}" ${cur} title="${esc(`${t.name} · ${st.label}`)}">
      ${logo(t, 'xs')}<span class="nav-tool-name">${esc(t.name)}</span>
      <span class="nav-dot d-${st.dot} ${busy ? 'pulse' : ''}" aria-label="${esc(st.label)}"></span></a>`;
  }).join('');
}

function currentTitle() {
  if (S.page === 'tool') return S.data?.tools.find((t) => t.id === S.toolId)?.name ?? 'Tool';
  return PAGES[S.page].title;
}

function updateChrome() {
  // Before sign-in, or while the app starts, there's no app frame to update yet.
  if (!$('#page-title')) return;
  const d = S.data;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === S.page || (S.page === 'tool' && a.dataset.nav === 'tools' && a.closest('.tabbar'));
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#page-title').textContent = currentTitle();
  document.title = `${currentTitle()} · Meridian`;
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
  const up = $('#update-pill');
  if (up) {
    up.hidden = !d?.update?.available || d.demo;
    up.innerHTML = d?.update?.available ? `${ICON.download}<span>Update to ${esc(d.update.latest)}</span>` : '';
  }
  updateTabs();
  updateExplorer();
  updateStatus();
  navTools();
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
  const keep = ['settings', 'assistant', 'privacy', 'map', 'security'].includes(S.page) && $('#content')?.dataset.page === S.page;
  if (keep && S.page === 'map') refreshMap();
  if (force ? !(S.page === 'assistant' && keep && S.chat.streaming) : !(typing || keep)) renderPage();
  refreshOpenTask();
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
  S.mapInst?.destroy();
  S.mapInst = null;
  const el = $('#content');
  if (!el) return;
  if (!S.data) {
    delete el.dataset.page;
    el.innerHTML = S.loadError ? `<div class="page"><div class="callout err">${esc(S.loadError)}</div></div>` : '<div class="empty">Loading…</div>';
    return;
  }
  const key = S.page === 'tool' ? `tool-${S.toolId}` : S.page;
  // A short fade only when you move to another page, not when the same page refreshes.
  const entering = el.dataset.page !== key;
  el.dataset.page = key;
  el.innerHTML = `<div class="page page-${S.page}${entering ? ' page-enter' : ''}">${S.loadError ? `<div class="callout err">Couldn’t refresh: ${esc(S.loadError)}</div>` : ''}${VIEWS[S.page]()}</div>`;
  AFTER[S.page]?.();
  const dock = $('#dock');
  if (dock && dock.hidden === dockShown()) renderDock();
}

// ── Shared fragments ─────────────────────────────────────────────────────
const statusIcon = (status) => `<div class="status-ico ${TASK_STATUS[status].pill}">${ICON[TASK_STATUS[status].icon]}</div>`;
const pill = (cls, label) => `<span class="pill ${cls}">${esc(label)}</span>`;
const barCls = (pct, warnAt) => (pct >= 100 ? 'err' : pct >= warnAt ? 'warn' : '');
const bar = (pct, cls = '', thin = false) => `<div class="bar ${cls} ${thin ? 'thin' : ''}"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>`;

function toolStatus(t) {
  const local = t.kind === 'local';
  return {
    ok: { label: local ? 'Signed in' : 'Synced', cls: 's-ok', dot: 'ok' },
    pending: { label: 'Checking…', cls: 's-info', dot: 'info' },
    signin: { label: 'Needs sign-in', cls: 's-warn', dot: 'warn' },
    missing: { label: 'Not installed', cls: 's-warn', dot: 'warn' },
    error: { label: local ? 'Problem' : 'Sync failed', cls: 's-err', dot: 'err' },
    tracked: { label: t.kind === 'builtin' ? 'Built in' : 'Tracked manually', cls: 's-queued', dot: 'idle' },
    disabled: { label: 'Off', cls: 's-queued', dot: 'off' },
  }[t.status] ?? { label: t.status, cls: 's-queued', dot: 'idle' };
}

function accountLine(t) {
  const a = t.account;
  if (t.kind !== 'local') return null;
  if (t.status === 'missing') return `${t.adapter_name} isn’t installed on this computer`;
  if (!a) return t.status === 'signin' ? `Not signed in to your ${t.account_kind ?? 'account'}` : null;
  const who = a.email || a.user ? `Signed in as ${a.email ?? a.user}` : `Signed in${a.method ? ` with ${a.method}` : ''}`;
  return `${who}${a.plan ? ` · ${cap1(a.plan)} plan` : ''}`;
}

function capShort(key, level) {
  if (key === 'limits' && level === 'manual') return 'Your budget';
  return CAP_SHORT[level] ?? level;
}

function taskWhen(t) {
  if (t.kind === 'session') return t.status === 'running' ? `Active ${rel(t.updated_at)}` : `Last active ${rel(t.updated_at)}`;
  if (t.status === 'running') return t.started_at ? `Started ${rel(t.started_at)}` : 'Running';
  if (t.status === 'scheduled' && t.scheduled_for && Date.parse(t.scheduled_for) < Date.now()) return `Was due ${when(t.scheduled_for)}, no update since`;
  if (t.status === 'scheduled') return t.scheduled_for ? `Scheduled ${when(t.scheduled_for)}` : 'Scheduled';
  if (t.status === 'queued') return `Queued ${rel(t.updated_at)}`;
  return t.finished_at ? `${TASK_STATUS[t.status].label} ${rel(t.finished_at)}` : TASK_STATUS[t.status].label;
}

/** A duration in words: "40 s", "8 min", "2 h 5 min". */
function dur(ms) {
  if (ms < 59_500) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const ETA_BASIS = { reported: 'reported by the task', progress: 'estimated from its progress', history: 'based on earlier runs' };

/** What the ETA watcher knows about a running task, as one short line. */
function etaInfo(t) {
  if (t.status !== 'running') return null;
  if (t.kind === 'session') return { text: 'Interactive session', basis: 'no set end, so no finish estimate', cls: 'none' };
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

/** A small, safe Markdown subset for the assistant's replies: escapes everything first, then adds formatting. */
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
      const lv = Math.min(6, h[1].length + 3);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
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
  const session = t.kind === 'session';
  const prog = t.status === 'running' && t.progress != null;
  const st = session ? SESSION_STATUS[t.status] ?? SESSION_STATUS.completed : TASK_STATUS[t.status];
  const badge = session ? '<span class="tag">Session</span>' : t.runner_label ? `<span class="tag accent">${esc(t.runner_label)}</span>${t.follows ? ' <span class="tag">Follow-up</span>' : ''}` : '';
  return `<button class="row" data-action="open-task" data-id="${t.id}">
    ${session ? `<div class="status-ico ${t.status === 'running' ? 's-running' : 's-queued'}">${ICON.terminal}</div>` : statusIcon(t.status)}
    <div class="row-main">
      <div class="row-title">${esc(t.name)} ${badge}</div>
      <div class="row-sub">${esc(t.tool_name)} · ${esc(taskWhen(t))}${t.step && t.status === 'running' ? ` · ${esc(t.step)}` : ''}</div>
      ${prog ? `<div class="row-progress"><div>${bar(t.progress, t.stalled ? 'err' : 'info', true)}</div><span class="num">${Math.round(t.progress)}%</span></div>` : ''}
      ${compact && session ? '' : etaLine(t)}
      ${t.status === 'failed' && t.error && !compact ? `<div class="row-sub err-text">${esc(t.error)}</div>` : ''}
    </div>
    ${compact ? '' : pill(st.pill, st.label)}
  </button>`;
}

function emptyBlock(title, text, action = '') {
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}${action ? `<div class="empty-action">${action}</div>` : ''}</div>`;
}

/** A tiny trend line for a stat tile. Missing days are gaps, never zeros. */
function sparkline(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 4) return ''; // too few days to show a trend
  const max = Math.max(...pts.map(([, v]) => v), 1);
  const w = 100;
  const h = 28;
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => h - 2 - (v / max) * (h - 4);
  const d = pts.map(([i, v], k) => `${k && pts[k - 1][0] === i - 1 ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
}

function tile(label, value, sub, { cls = '', na = 'Not reported', icon = null, trend = null } = {}) {
  return `<div class="tile ${cls}"><div class="tile-top"><span class="tile-label">${esc(label)}</span>${icon ? `<span class="tile-ico">${ICON[icon]}</span>` : ''}</div>
    ${value == null ? `<div class="tile-value na">${esc(na)}</div>` : `<div class="tile-value">${esc(value)}</div>`}
    <div class="tile-sub">${esc(sub)}</div>${trend && value != null ? sparkline(trend) : ''}</div>`;
}

const dailyTotal = (d, key, n = 14) => d.usage.days.slice(-n).map((_, i) => sumOrNull(d.usage.series.map((s) => s[key][s[key].length - n + i])));

function limitMeters(t) {
  const L = t.limits;
  if (!L) return '';
  const win = (w, fallback) => {
    if (!w) return '';
    const name = w.window_minutes ? (w.window_minutes >= 1440 ? `${Math.round(w.window_minutes / 1440)}-day limit` : `${Math.round(w.window_minutes / 60)}-hour limit`) : fallback;
    return `<div class="meter"><div class="meter-top"><span>${esc(name)}</span><b>${esc(fmtPct(w.used_percent))} used</b></div>${bar(w.used_percent, barCls(w.used_percent, 75))}
      ${w.resets_at ? `<div class="meter-sub">Resets ${esc(Date.parse(w.resets_at) > Date.now() ? rel(w.resets_at) : 'soon')}</div>` : ''}</div>`;
  };
  return `${win(L.primary, 'Short-term limit')}${win(L.secondary, 'Longer-term limit')}
    <p class="fine">${L.plan ? `${esc(cap1(L.plan))} plan · ` : ''}As of ${esc(rel(L.observed_at) ?? 'the last session')}, from ${esc(t.adapter_name)}’s own logs.</p>`;
}

// ── Assistant: overview command bar and chat ─────────────────────────────
function suggestions(d) {
  const out = ['What needs my attention right now?'];
  if (d.tasks.some((t) => t.status === 'running' && t.kind !== 'session')) out.push('When will my running tasks finish?');
  const failed = d.tasks.find((t) => t.status === 'failed');
  if (failed) out.push(`Why did “${failed.name}” fail, and what should I do?`);
  if (d.tools.some((t) => t.kind === 'local' && t.tokens_today)) out.push('How much have I used my AI apps today?');
  out.push('How is my spending this month compared to my budgets?');
  out.push('Draft a short report of this month’s AI usage');
  return out.slice(0, 4);
}

function connectPrompt(d) {
  const local = S.local;
  // Connected but not ready yet (not signed in, not installed): point to its page to finish.
  const pending = d.engines.filter((e) => e.kind === 'cli' && e.integration_id && !e.ready);
  const found = (local ?? []).filter((l) => l.installed && !l.connected_id);
  const buttons = [
    ...pending.map((e) => `<a class="btn primary" href="#tool-${e.integration_id}">${engineLogo(e, 'xs')}Finish setting up ${esc(e.label)}</a>`),
    ...found.map((l) => `<button class="btn" data-action="connect-local" data-id="${esc(l.id)}">${logo({ vendor: l.vendor, name: l.name, adapter: l.id }, 'xs')}Connect ${esc(l.name)}</button>`),
  ];
  if (!buttons.length) buttons.push('<button class="btn" data-action="add-tool">Connect an AI app</button>');
  const why = pending.length ? ` ${pending.map((e) => e.reason).join(' ')}` : '';
  return `<div class="hero-connect">
    <p>Sign in to Claude Code, Codex, Gemini CLI, GitHub Copilot or Cursor with your own account to ask questions and run tasks from here. No API key needed.${esc(why)}</p>
    <div class="form-actions">${buttons.join('')}<a class="btn ghost" href="#settings">Use an API key instead</a></div></div>`;
}

function hero(d) {
  const e = d.engine;
  const s = d.stats;
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const pulse = [
    s.running ? `${plural(s.running, 'task')} running` : 'Nothing running',
    s.needs_attention ? `${s.needs_attention} need${s.needs_attention === 1 ? 's' : ''} attention` : null,
    d.unread ? `${plural(d.unread, 'unread alert')}` : null,
  ].filter(Boolean);
  const ask = d.demo
    ? `<p class="hero-note">The assistant works with your real data. Exit demo to ask it something.</p>${d.team?.lineup ? `<div class="lineup-label">AI team lineup</div>${lineupStrip(d.team.lineup)}` : ''}`
    : !e
      ? connectPrompt(d)
      : heroCommand(d);
  return `<section class="hero a-hero">
    <div class="hero-top"><div><div class="eyebrow">${esc(new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
      <h2>${esc(greet)}, ${esc(S.user.username)}</h2></div>
      <div class="hero-pulse">${pulse.map((p, i) => `<span class="${i === 0 && s.running ? 'live' : ''}">${esc(p)}</span>`).join('')}</div></div>
    ${ask}
  </section>`;
}

const TEAM_ORDER = [['planner', 'Plan'], ['builder', 'Build'], ['reviewer', 'Review'], ['debugger', 'Debug']];

/** Who does each part of an AI team task, as a row of steps. */
function lineupStrip(l) {
  if (!l) return '<p class="fine">Connect an AI to use the team.</p>';
  return `<div class="lineup">${TEAM_ORDER.map(([r, label], i) => `${i ? '<span class="lineup-arrow" aria-hidden="true">→</span>' : ''}<span class="lineup-step">${engineById(l[r].id, l[r].label)}<span><b>${label}</b> ${esc(l[r].label)}</span></span>`).join('')}</div>`;
}

/** The overview's command bar: ask the assistant, or hand the goal to the AI team. */
function heroCommand(d) {
  const e = d.engine;
  const team = S.heroMode === 'team';
  const all = S.heroMode === 'compare';
  const ready = d.engines.filter((x) => x.ready);
  const smart = d.engine_choice === 'auto' && ready.length > 1;
  const toggle = `<div class="mode-switch" role="group" aria-label="How to run it">
    <button type="button" class="mode-btn" data-action="hero-mode" data-mode="ask" aria-pressed="${!team && !all}">${ICON.chat}${smart ? 'Ask' : `Ask ${esc(e.label)}`}</button>
    <button type="button" class="mode-btn" data-action="hero-mode" data-mode="team" aria-pressed="${team}">${ICON.team}AI team</button>
    <button type="button" class="mode-btn" data-action="hero-mode" data-mode="compare" aria-pressed="${all}">${ICON.grid}Ask all</button></div>`;
  if (all) {
    return `${toggle}<form class="command" data-form="team-quick" data-mode="compare">
        <span class="command-engine team-mark">${ICON.grid}</span>
        <input class="command-input" name="goal" placeholder="Ask every connected AI the same thing…" autocomplete="off" maxlength="4000" aria-label="Question for every AI">
        <button class="btn primary" type="submit">${ICON.send}<span class="hide-sm">Ask all</span></button>
      </form>
      <div class="lineup">${ready.map((x) => `<span class="lineup-step">${engineLogo(x, 'xs')}<span>${esc(x.label)}</span></span>`).join('')}<span class="lineup-arrow" aria-hidden="true">→</span><span class="lineup-step">${d.team?.lineup ? engineById(d.team.lineup.builder.id, d.team.lineup.builder.label) : ''}<span><b>Combine</b> ${esc(d.team?.lineup?.builder.label ?? '')}</span></span></div>
      <p class="hero-foot">${ready.length > 1 ? `Sends your question to all ${ready.length} AIs, each under your account with its company. Each answers on its own, then the answers are combined into one; you can read every answer on the task.` : 'Connect more AIs to compare their answers. With one, you get its answer.'}</p>`;
  }
  if (!team) {
    return `${toggle}<form class="command" data-form="ask">
        <span class="command-engine" id="route-logo" title="${esc(smart ? 'Automatic: the best AI for each request' : `${e.label}, ${e.via}`)}">${smart ? `<span class="logo sm hue-brand">${ICON.spark}</span>` : engineLogo(e, 'sm')}</span>
        <input class="command-input" name="text" data-route="ask" placeholder="${smart ? 'Ask anything, or hand it work. The best AI for it answers…' : `Ask ${esc(e.label)} about your tools, or tell it what to do…`}" autocomplete="off" maxlength="8000" aria-label="Ask the assistant">
        <button class="btn primary" type="submit">${ICON.send}<span class="hide-sm">Ask</span></button>
      </form>
      <div class="route-hint" id="route-hint" aria-live="polite"></div>
      <div class="chips">${suggestions(d).map((p) => `<button class="chip" data-action="ask" data-prompt="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      <p class="hero-foot">${smart ? `<b>Automatic</b>: each request goes to whichever of your ${ready.length} AIs suits it best, using your plans before any API key` : `Runs through <b>${esc(e.label)}</b> with ${esc(e.via)}`} · <a href="#assistant">Open chat</a> · <a href="#settings">Change</a></p>`;
  }
  return `${toggle}<form class="command" data-form="team-quick">
      <span class="command-engine team-mark">${ICON.team}</span>
      <input class="command-input" name="goal" data-route="team" placeholder="Describe what the team should make…" autocomplete="off" maxlength="4000" aria-label="Goal for the AI team">
      <button class="btn primary" type="submit">${ICON.play}<span class="hide-sm">Start</span></button>
    </form>
    <div id="team-lineup">${lineupStrip(d.team?.lineup)}</div>
    <div class="route-hint" id="route-hint" aria-live="polite"></div>
    <p class="hero-foot">Each AI does the part it’s best at, in the background. Follow it on the Tasks page. <button class="link" type="button" data-action="team-folder">${ICON.folder}Work on files in a folder</button> · <a href="#settings">Change who does what</a></p>`;
}

let routeTimer = 0;
let routeSeq = 0;
/** As you type in the command bar, shows where the request would go. No AI is asked, so it costs nothing. */
function previewRoute(input) {
  clearTimeout(routeTimer);
  const text = input.value.trim();
  const mode = input.dataset.route;
  const hint = $('#route-hint');
  if (!hint) return;
  if (text.length < 4) {
    hint.innerHTML = '';
    return;
  }
  routeTimer = setTimeout(async () => {
    const seq = ++routeSeq;
    const r = await api('/api/route', { method: 'POST', body: { text, mode } }).catch(() => null);
    if (seq !== routeSeq || !r || !$('#route-hint')) return;
    if (mode === 'team') {
      if (r.lineup) $('#team-lineup').innerHTML = lineupStrip(r.lineup);
      $('#route-hint').innerHTML = `<span class="route-kind">${esc(r.label)}</span><span class="faint">Roles picked for this kind of task</span>`;
    } else if (r.fixed) {
      $('#route-hint').innerHTML = `<span class="route-kind">${esc(r.label)}</span>`;
    } else {
      const why = r.why.replace(/^[^:]+:\s*/, '');
      $('#route-hint').innerHTML = `<span class="route-kind">${esc(r.label)}</span>${engineById(r.engine.id, r.engine.label)}<span class="route-why">${esc(why)}</span>`;
      const logoBox = $('#route-logo');
      if (logoBox) logoBox.innerHTML = engineLogo({ id: r.engine.id, label: r.engine.label, vendor: r.engine.vendor }, 'sm');
    }
  }, 280);
}

function chatItem(it, i) {
  if (it.role === 'user') return `<div class="msg user"><div class="bubble">${esc(it.text)}</div></div>`;
  if (it.role === 'assistant') {
    // The AI that answers this conversation, which on Automatic can differ from conversation to conversation.
    const tid = S.chat.thread?.route?.engine ?? S.chat.thread?.engine;
    const e = (tid && S.data?.engines.find((x) => x.id === tid)) || S.data?.engine;
    const copy = it.text && !S.chat.streaming ? `<button class="bubble-copy" data-action="copy-reply" data-index="${i}" aria-label="Copy this reply" title="Copy">${ICON.check}<span>Copy</span></button>` : '';
    return `<div class="msg ai">${e ? engineLogo(e, 'xs') : `<span class="logo xs hue-brand">${ICON.spark}</span>`}<div class="bubble md">${it.text ? md(it.text) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>${copy}</div>`;
  }
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
  const e = S.data.engine;
  const r = c.thread?.route;
  const routeNote = r ? `<div class="route-note" title="${esc(r.why ?? '')}">${engineById(r.engine, r.engine_label)}<span>Automatic picked <b>${esc(r.engine_label)}</b> for this ${esc((r.category_label ?? '').toLowerCase())} conversation</span></div>` : '';
  el.innerHTML = items.length
    ? routeNote + items.map(chatItem).join('')
    : `<div class="chat-empty">${e ? engineLogo(e, 'lg') : ''}<h3>What can I do for you?</h3>
        <p>I can read your tools, tasks, spending and alerts, change budgets, sync tools, and run tasks in the background that show up on the Tasks page with live progress.</p>
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
  if (!msgFrame) msgFrame = requestAnimationFrame(() => {
    msgFrame = 0;
    renderMsgs();
  });
};

async function loadThreads() {
  S.chat.threads = await api('/api/assistant/threads');
  S.chat.loaded = true;
}

async function openThread(id) {
  S.chat.thread = await api(`/api/assistant/threads/${id}`);
  if (chatOnScreen()) renderChat();
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
  const finishPending = () => thread.items.forEach((it) => {
    if (it.pending) {
      it.pending = false;
      it.ok = true;
    }
  });
  const dropEmpty = () => {
    if (current && !current.text) thread.items.splice(thread.items.indexOf(current), 1);
    current = null;
  };

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
        if (ev.type === 'route') {
          thread.route = ev;
        } else if (ev.type === 'text') {
          finishPending();
          assistantBubble().text += ev.delta;
        } else if (ev.type === 'searching') {
          dropEmpty();
          thread.items.push({ role: 'action', label: 'Searching the web', pending: true });
        } else if (ev.type === 'tool') {
          dropEmpty();
          thread.items.push({ role: 'action', label: ev.label, pending: true });
        } else if (ev.type === 'tool_done') {
          const it = [...thread.items].reverse().find((x) => x.role === 'action' && x.pending);
          if (it) Object.assign(it, { pending: false, ok: ev.ok, label: ev.label, error: ev.error });
        } else if (ev.type === 'turn') {
          if (current?.text) current = null;
          assistantBubble();
        } else if (ev.type === 'notice' || ev.type === 'error') {
          dropEmpty();
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
    dropEmpty();
    thread.items.push({ role: 'error', text: err.message });
    c.draft = err.unsent ?? text;
  } finally {
    c.streaming = false;
    finishPending();
    if (chatOnScreen()) {
      renderChat();
      $('#chat-input')?.focus();
    }
    load({ force: true }); // the assistant may have changed budgets or started tasks
  }
}

/** Opens the chat in a new conversation and sends a prompt, from the overview, a tool page or a task. */
function askAssistant(prompt) {
  S.chat.thread = null;
  S.chat.pending = prompt;
  if (S.page === 'assistant') renderPage();
  else if (dockShown()) renderDock();
  else location.hash = '#assistant';
}

async function useEngine(id, { quiet = false } = {}) {
  if (S.data.settings.assistant_engine === id) return;
  await api('/api/settings', { method: 'PUT', body: { assistant_engine: id } });
  await load({ force: true });
  if (!quiet) toast(id === 'auto' ? 'The assistant picks an AI automatically' : `The assistant now uses ${S.data.engines.find((e) => e.id === id)?.label ?? id}`);
}

function engineOptions(d) {
  const auto = d.engines.find((e) => e.ready);
  return `<option value="auto" ${d.engine_choice === 'auto' ? 'selected' : ''}>Automatic${auto ? ` (${esc(auto.label)})` : ''}</option>
    ${d.engines.map((e) => `<option value="${e.id}" ${d.engine_choice === e.id ? 'selected' : ''} ${e.ready ? '' : 'disabled'}>${esc(e.label)} · ${esc(e.ready ? e.via : e.reason)}</option>`).join('')}`;
}

// ── Views ────────────────────────────────────────────────────────────────
const VIEWS = {
  dashboard() {
    const d = S.data;
    const s = d.stats;
    const tools = d.tools.filter((t) => t.kind !== 'builtin');
    if (!d.demo && !tools.length) return welcome();
    const warnAt = d.settings.usage_warn_pct;
    const ceilPct = s.ceiling_usd && s.cost_mtd != null ? (s.cost_mtd / s.ceiling_usd) * 100 : null;
    const running = d.tasks.filter((t) => t.status === 'running');
    const budgeted = d.tools.filter((t) => t.enabled && t.budget_usd);
    const limited = d.tools.filter((t) => t.enabled && t.limits);
    const sm = d.summary;
    const smSource = !sm ? '' : sm.source === 'ai' ? `AI-generated by ${sm.by ?? 'the assistant'} from your data` : sm.source === 'demo' ? 'Sample summary' : 'Generated from your data';
    const work = running.filter((t) => t.kind !== 'session');
    const stalled = work.filter((t) => t.stalled).length;
    const nextEta = work.map((t) => t.eta_at && !t.overdue && Date.parse(t.eta_at)).filter(Boolean).sort((a, b) => a - b)[0];
    const runningSub = stalled ? `${stalled} may be stuck` : nextEta ? `Next one done ${rel(new Date(nextEta).toISOString())}` : s.sessions_running ? `${plural(s.sessions_running, 'live session')} · ${s.queued} queued` : `${s.queued} queued · ${s.scheduled} scheduled`;

    return `<div class="dash">
      ${hero(d)}
      <div class="tiles a-tiles">
        ${tile('Running now', s.running, runningSub, { cls: stalled ? 'warn' : s.running ? 'info' : '', icon: 'play' })}
        ${tile('Tokens today', fmtNum(s.tokens_today), 'From tools that report tokens', { icon: 'bolt', trend: dailyTotal(d, 'tokens') })}
        ${tile('Spend this month', fmtUsd(s.cost_mtd), ceilPct != null ? `${Math.round(ceilPct)}% of ${fmtUsd(s.ceiling_usd)} ceiling` : reportingCost(s.tools_reporting_cost), { cls: ceilPct == null ? '' : barCls(ceilPct, warnAt), trend: dailyTotal(d, 'cost'), na: 'No cost data' })}
        ${tile('Completed today', s.completed_today, 'Tasks your tools reported', { icon: 'check' })}
        ${tile('Failed today', s.failed_today, s.failed_today ? 'Open Tasks to see why' : 'Nothing has failed', { cls: s.failed_today ? 'err' : '', icon: 'x' })}
        ${tile('Tools connected', s.connected, s.needs_attention ? `${s.needs_attention} need attention` : `${s.active} active now`, { cls: s.needs_attention ? 'warn' : '', icon: 'tools' })}
      </div>

      <section class="card a-running">
        <div class="card-head"><h3>Running now</h3><a class="aside" href="#tasks">All tasks ${ICON.chevron}</a></div>
        ${running.length ? `<div class="rows">${running.slice(0, 6).map((t) => taskRow(t, { compact: true })).join('')}</div>` : emptyBlock('Nothing is running', 'Tasks and live sessions show up here as they happen.')}
      </section>

      <section class="card summary a-summary">
        <div class="card-head">${ICON.spark}<h3>Daily summary</h3></div>
        <p>${esc(sm?.text ?? 'No summary yet. It is generated after the first sync, or you can generate one now.')}</p>
        <div class="meta">
          ${sm ? `<span>${esc(smSource)} · ${esc(rel(sm.generated_at))}</span>` : ''}
          ${sm?.error ? `<span class="warn-text">${esc(sm.error)}</span>` : ''}
          ${!d.demo ? '<button class="btn small ghost" data-action="refresh-summary">Regenerate</button>' : ''}
        </div>
      </section>

      <section class="card a-tools">
        <div class="card-head"><h3>Your AI tools</h3><a class="aside" href="#map">${ICON.map} Map</a><button class="aside link aside-next" data-action="add-tool">${ICON.plus} Connect</button></div>
        <div class="rows">${tools.map((t) => {
          const st = toolStatus(t);
          const sub = t.current_activity ? `Running: ${t.current_activity}` : accountLine(t) ?? KIND_LABEL[t.kind];
          const fig = t.tokens_today != null ? `${fmtNum(t.tokens_today)} today` : t.cost_mtd != null ? `${fmtUsd(t.cost_mtd)} this month` : '';
          return `<a class="row tool-row" href="#tool-${t.id}">${logo(t, 'sm')}<div class="row-main"><div class="row-title">${esc(t.name)}</div><div class="row-sub">${esc(sub)}</div></div>
            <div class="row-end"><span class="num">${esc(fig)}</span>${pill(st.cls, st.label)}</div></a>`;
        }).join('')}</div>
      </section>

      <section class="card a-upcoming">
        <div class="card-head"><h3>Up next</h3><a class="aside" href="#automations">Automations ${ICON.chevron}</a></div>
        ${upNext(d)}
      </section>

      <section class="card a-limits">
        <div class="card-head"><h3>Budgets and limits</h3><a class="aside" href="#usage">Usage ${ICON.chevron}</a></div>
        ${s.ceiling_usd ? `<div class="meter"><div class="meter-top"><span>All tools this month</span><b>${or(fmtUsd(s.cost_mtd), 'No cost data')} / ${esc(fmtUsd(s.ceiling_usd))}</b></div>${bar(ceilPct ?? 0, barCls(ceilPct ?? 0, warnAt))}</div>` : ''}
        ${budgeted.map((t) => `<div class="meter"><div class="meter-top"><span>${esc(t.name)}</span><b>${t.budget_pct == null ? '<span class="faint">No cost data</span>' : `${esc(fmtUsd(t.cost_mtd))} / ${esc(fmtUsd(t.budget_usd))}`}</b></div>${bar(t.budget_pct ?? 0, barCls(t.budget_pct ?? 0, warnAt))}</div>`).join('')}
        ${limited.map((t) => `<div class="limit-group"><div class="limit-name">${logo(t, 'xs')}${esc(t.name)} plan limits</div>${limitMeters(t)}</div>`).join('')}
        ${!budgeted.length && !s.ceiling_usd && !limited.length ? emptyBlock('No budgets set', 'Set a monthly budget on a tool, or a ceiling in Settings, to track limits here.') : ''}
        <p class="fine">Claude.ai and ChatGPT plan limits aren’t available through their APIs. Codex’s limits appear here when Codex reports them in its logs.</p>
      </section>

      <section class="card a-activity">
        <div class="card-head"><h3>Recent activity</h3></div>
        ${d.feed.length ? `<div class="rows">${d.feed.slice(0, 8).map((e) => {
          const sev = e.kind.includes('failed') ? 'err' : e.kind === 'connection' && /fail|no longer|not found/.test(e.message) ? 'err' : e.kind.includes('completed') || /ready|reconnected/.test(e.message) ? 'ok' : 'info';
          return `<div class="row"><div class="status-ico s-${sev}">${ICON[SEVERITY_ICON[sev]]}</div><div class="row-main"><div class="row-sub strong">${esc(e.message)}</div></div><div class="row-time">${esc(rel(e.created_at))}</div></div>`;
        }).join('')}</div>` : emptyBlock('No activity yet', 'Syncs, task updates and connection changes are listed here.')}
      </section>
    </div>`;
  },

  assistant() {
    const d = S.data;
    if (d.demo) return `<div class="card">${emptyBlock('The assistant works with your real data', 'Exit demo to chat about your tools and tasks.', '<button class="btn" data-action="toggle-demo">Exit demo</button>')}</div>`;
    if (!d.engine) return assistantSetup(d);
    return `<div class="chat-page">${chatBody(d)}</div>`;
  },

  tools() {
    const d = S.data;
    const warnAt = d.settings.usage_warn_pct;
    const card = (t) => {
      const st = toolStatus(t);
      const caps = Object.entries(t.capabilities).filter(([, v]) => v !== 'none').map(([k, v]) => `<span class="cap">${CAP_NAME[k]}: <b>${esc(capShort(k, v))}</b></span>`).join('');
      const activity = t.last_error
        ? `<span class="dotx err"></span><span class="err-text">${esc(t.last_error)}</span>`
        : t.current_activity
          ? `<span class="dotx on"></span><span>Running: ${esc(t.current_activity)}</span>`
          : `<span class="dotx"></span><span>${esc(accountLine(t) ?? (t.active ? 'Recently active' : 'Idle'))}</span>`;
      const last = t.last_activity_at ? `Active ${rel(t.last_activity_at)}` : t.last_usage_day ? `Last usage ${shortDay(t.last_usage_day)}` : 'No activity yet';
      return `<a class="card tool" href="#tool-${t.id}">
        <div class="tool-head">${logo(t)}
          <div class="min0"><div class="tool-name">${esc(t.name)}</div><div class="tool-kind">${esc(KIND_LABEL[t.kind] ?? t.adapter_name)} · ${esc(t.vendor)}</div></div>
          ${pill(st.cls, st.label)}</div>
        <dl class="kv">
          <div><dt>Tokens this month</dt><dd class="${t.tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.tokens_mtd))}</dd></div>
          <div><dt>Spend this month</dt><dd class="${t.cost_mtd == null ? 'na' : ''}">${or(fmtUsd(t.cost_mtd), t.kind === 'local' ? 'Included in plan' : 'Not available')}</dd></div>
        </dl>
        ${t.budget_usd ? `<div class="meter flat"><div class="meter-top"><span class="muted">Monthly budget</span><b>${t.budget_pct == null ? '<span class="faint">No cost data</span>' : `${esc(fmtPct(t.budget_pct))} of ${esc(fmtUsd(t.budget_usd))}`}</b></div>${bar(t.budget_pct ?? 0, barCls(t.budget_pct ?? 0, warnAt))}</div>` : ''}
        <div class="caps">${caps}</div>
        <div class="tool-activity">${activity}</div>
        <div class="tool-foot"><span>${esc(last)}</span><span class="go">Open ${ICON.chevron}</span></div>
      </a>`;
    };
    return `<div class="page-head"><div><h2>AI Tools</h2><p>${plural(d.tools.length, 'tool')} · each card shows what that connection can actually see.</p></div>
      <button class="btn primary" data-action="add-tool" ${d.demo ? 'disabled title="Demo data is read-only"' : ''}>${ICON.plus}Connect a tool</button></div>
      ${d.tools.length ? `<div class="tools-grid">${d.tools.map(card).join('')}</div>` : `<div class="card">${emptyBlock('No tools yet', 'Connect one to start tracking it.', '<button class="btn primary" data-action="add-tool">Connect a tool</button>')}</div>`}
      <div class="card"><div class="card-head"><h3>What the labels mean</h3></div>
        <dl class="detail-grid">${Object.entries(CAP_SHORT).map(([k, v]) => `<dt>${esc(v)}</dt><dd>${esc(CAP_LONG[k])}</dd>`).join('')}<dt>Your budget</dt><dd>A monthly dollar budget you set. Provider plan limits are not read.</dd></dl>
      </div>`;
  },

  tool() {
    const d = S.data;
    const t = d.tools.find((x) => x.id === S.toolId);
    if (!t) return `<div class="card">${emptyBlock('This tool isn’t connected', 'It may have been removed.', '<a class="btn" href="#tools">See all tools</a>')}</div>`;
    const st = toolStatus(t);
    const demo = d.demo;
    const warnAt = d.settings.usage_warn_pct;
    const engine = d.engines.find((e) => e.integration_id === t.id);
    const waiting = t.cli ? S.waiting[t.adapter] : null;
    const tasks = d.tasks.filter((x) => x.integration_id === t.id);
    const series = d.usage.series.find((x) => x.id === t.id);
    const acct = accountLine(t);

    const actions = [];
    if (!demo && engine?.ready) actions.push(`<button class="btn primary" data-action="chat-with" data-engine="${engine.id}">${ICON.chat}Chat with ${esc(engine.label)}</button>`);
    if (!demo && t.kind === 'local' && t.status === 'signin') actions.push(`<button class="btn primary" data-action="local-login" data-id="${esc(t.adapter)}">${ICON.signin}Sign in with your ${esc(t.account_kind ?? 'account')}</button>`);
    if (!demo && t.kind === 'local' && t.status === 'missing') actions.push(`<button class="btn primary" data-action="local-install" data-id="${esc(t.adapter)}">${ICON.download}Install ${esc(t.adapter_name)}</button>`);
    if (!demo && t.kind === 'local') actions.push(`<button class="btn" data-action="local-check" data-id="${esc(t.adapter)}">${ICON.refresh}Check again</button>`);
    if (!demo && t.kind === 'api') actions.push(`<button class="btn" data-action="sync" data-id="${t.id}">${ICON.refresh}Sync now</button>`);

    const setup = t.kind === 'local' && t.status !== 'ok' && t.status !== 'disabled' ? `
      <section class="card setup">
        <div class="card-head"><h3>Finish setting up ${esc(t.adapter_name)}</h3></div>
        <ol class="steps">
          <li class="${t.status !== 'missing' ? 'done' : 'now'}"><b>Install ${esc(t.adapter_name)}</b>
            <span>${t.status !== 'missing' ? `Installed${t.version ? ` (version ${esc(t.version)})` : ''}.` : `Run <code>${esc(t.cli?.install)}</code>, or choose Install and the app opens a window that does it.`}</span></li>
          <li class="${t.status === 'signin' ? 'now' : t.status === 'missing' ? '' : 'done'}"><b>Sign in with your ${esc(t.account_kind ?? 'account')}</b>
            <span>${esc(t.cli?.login_help ?? '')} No API key is needed.</span></li>
          <li><b>Use it here</b><span>Its usage and sessions appear on this page, and the assistant can run through it.</span></li>
        </ol>
        ${waiting ? `<div class="callout info waiting"><span class="spin"></span>${waiting === 'install' ? 'Waiting for the install to finish. This page updates when it’s done.' : 'Waiting for you to finish signing in. This page updates when you’re signed in.'}</div>` : ''}
        ${t.last_error ? `<div class="callout err">${esc(t.last_error)}</div>` : ''}
      </section>` : '';

    const capRows = Object.entries(t.capabilities).map(([k, v]) => `<tr><td><b>${CAP_NAME[k]}</b><div class="faint small">${esc(k === 'limits' && v === 'manual' ? 'The monthly budget you set below' : CAP_LONG[v])}</div></td><td>${pill(v === 'none' ? 's-queued' : v === 'api' || v === 'local' ? 's-ok' : 's-info', capShort(k, v))}</td></tr>`).join('');

    return `
      <section class="tool-hero">
        ${logo(t, 'xl')}
        <div class="tool-hero-main">
          <div class="eyebrow">${esc(KIND_LABEL[t.kind] ?? '')} · ${esc(t.vendor)}</div>
          <h2>${esc(t.name)}</h2>
          <div class="tool-hero-meta">${pill(st.cls, st.label)}${acct ? `<span>${esc(acct)}</span>` : ''}${t.version ? `<span class="faint">v${esc(t.version)}</span>` : ''}${t.secret_hint ? `<span class="faint">key ${esc(t.secret_hint)}</span>` : ''}</div>
        </div>
        <div class="tool-hero-actions">${actions.join('')}</div>
      </section>
      ${t.replaced_by && !demo ? (() => {
        const have = d.tools.find((x) => x.adapter === t.replaced_by.id);
        return `<div class="callout info upgrade">${ICON.signin}<span class="grow">${esc(t.notes[0] ?? '')} This entry is tracked by hand.</span>${have ? `<a class="btn small primary" href="#tool-${have.id}">Open ${esc(have.name)}</a>` : `<button class="btn small primary" data-action="connect-local" data-id="${esc(t.replaced_by.id)}">Connect ${esc(t.replaced_by.name)}</button>`}</div>`;
      })() : ''}
      ${t.last_error && !setup ? `<div class="callout err">${esc(t.last_error)}</div>` : ''}
      ${t.status === 'pending' ? '<div class="callout info">The first check hasn’t finished yet.</div>' : ''}
      ${setup}

      <div class="tiles tiles-5">
        ${tile('Tokens this month', fmtNum(t.tokens_mtd), t.input_tokens_mtd != null ? `${fmtNum(t.input_tokens_mtd)} in · ${fmtNum(t.output_tokens_mtd)} out, plus cache` : 'Input, output and cache', { icon: 'bolt' })}
        ${tile('Tokens today', fmtNum(t.tokens_today), 'UTC day', { trend: series?.tokens.slice(-14) })}
        ${tile('Requests this month', t.requests_mtd?.toLocaleString() ?? null, t.kind === 'local' ? 'Model responses in its logs' : 'Where the tool reports them')}
        ${tile('Spend this month', fmtUsd(t.cost_mtd), t.budget_usd ? `Budget ${fmtUsd(t.budget_usd)}` : t.kind === 'local' ? 'Plan usage isn’t priced per token' : 'No budget set', { na: t.kind === 'local' ? 'Included in plan' : 'Not reported', cls: t.budget_pct == null ? '' : barCls(t.budget_pct, warnAt) })}
        ${tile(t.kind === 'local' ? 'Live sessions' : 'Running tasks', t.kind === 'local' ? t.sessions_running : tasks.filter((x) => x.status === 'running').length, t.last_activity_at ? `Last active ${rel(t.last_activity_at)}` : 'No activity yet', { icon: 'play' })}
      </div>

      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h3>Daily tokens</h3><span class="aside">Last 30 days</span></div>
          ${series ? '<div class="chart"><canvas id="ch-tool" aria-label="Daily tokens"></canvas></div>' : emptyBlock('No usage yet', t.kind === 'local' ? `Usage appears after ${t.adapter_name} has been used on this computer.` : 'Charts fill in once usage is reported.')}
        </section>
        ${engine?.ready && !demo ? `<section class="card ask-tool">
          <div class="card-head">${ICON.chat}<h3>Ask ${esc(engine.label)}</h3></div>
          <p class="muted small">Ask about your tools and tasks, or hand it work. It runs with ${esc(engine.via)} and can use this app’s functions.</p>
          <form class="command compact" data-form="ask-tool" data-engine="${engine.id}"><input class="command-input" name="text" placeholder="e.g. Draft a summary of this week’s usage" autocomplete="off" maxlength="8000" aria-label="Ask ${esc(engine.label)}"><button class="btn primary" type="submit">${ICON.send}</button></form>
          <div class="chips">${['What did I use this for today?', 'Am I close to any limits?', 'Start a task: write a weekly usage report'].map((p) => `<button class="chip" data-action="ask-tool" data-engine="${engine.id}" data-prompt="${esc(p)}">${esc(p)}</button>`).join('')}</div>
        </section>` : t.limits ? `<section class="card"><div class="card-head"><h3>Plan limits</h3></div>${limitMeters(t)}</section>` : `<section class="card"><div class="card-head"><h3>This month</h3></div><dl class="detail-grid">
          <dt>Spend</dt><dd>${or(fmtUsd(t.cost_mtd), t.kind === 'local' ? 'Included in plan' : 'Not available')}</dd>
          <dt>Budget</dt><dd>${t.budget_usd ? `${esc(fmtUsd(t.budget_usd))}${t.budget_pct != null ? ` · ${esc(fmtPct(t.budget_pct))} used` : ''}` : '<span class="faint">Not set</span>'}</dd>
          ${t.can_sync ? `<dt>Last ${t.kind === 'local' ? 'check' : 'sync'}</dt><dd>${or(t.last_sync_at && when(t.last_sync_at), 'Not yet')}</dd>` : ''}
          ${t.data_refreshed_at && t.kind === 'api' ? `<dt>Data complete to</dt><dd>${esc(when(t.data_refreshed_at))}</dd>` : ''}
        </dl></section>`}
      </div>
      ${engine?.ready && t.limits && !demo ? `<section class="card"><div class="card-head"><h3>Plan limits</h3></div>${limitMeters(t)}</section>` : ''}

      <section class="card">
        <div class="card-head"><h3>${t.kind === 'local' ? 'Sessions' : 'Tasks'}</h3><span class="aside">${plural(tasks.length, t.kind === 'local' ? 'session' : 'task')}</span></div>
        ${tasks.length ? `<div class="rows">${tasks.slice(0, 12).map((x) => taskRow(x)).join('')}</div>` : emptyBlock(t.kind === 'local' ? 'No sessions in the last 30 days' : 'No tasks reported yet', t.kind === 'local' ? `Sessions appear here when you use ${t.adapter_name} on this computer.` : t.kind === 'builtin' ? 'Background tasks the assistant runs are listed here.' : 'Your scripts can report tasks with the ingest token below.')}
      </section>

      <div class="grid-2">
        <section class="card"><div class="card-head"><h3>What this connection can see</h3></div><table class="cap-table"><tbody>${capRows}</tbody></table></section>
        <section class="card"><div class="card-head"><h3>Good to know</h3></div><ul class="notes">${t.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>
      </div>

      ${demo ? '<div class="callout warn">Demo data is read-only.</div>' : manageSection(t)}`;
  },

  usage() {
    const d = S.data;
    const s = d.stats;
    const warnAt = d.settings.usage_warn_pct;
    const ceilPct = s.ceiling_usd && s.cost_mtd != null ? (s.cost_mtd / s.ceiling_usd) * 100 : null;
    const synced = d.tools.filter((t) => t.can_sync && t.enabled);
    const rows = d.tools.filter((t) => t.enabled).map((t) => `<tr>
      <td><a class="cell-tool" href="#tool-${t.id}">${logo(t, 'xs')}<span><b>${esc(t.name)}</b><span class="faint small block">${esc(t.adapter_name)}</span></span></a></td>
      <td class="r ${t.cost_mtd == null ? 'na' : ''}">${or(fmtUsd(t.cost_mtd), t.kind === 'local' ? 'In plan' : '—')}</td>
      <td class="r ${t.tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.tokens_mtd), '—')}</td>
      <td class="r ${t.input_tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.input_tokens_mtd), '—')}</td>
      <td class="r ${t.output_tokens_mtd == null ? 'na' : ''}">${or(fmtNum(t.output_tokens_mtd), '—')}</td>
      <td class="r ${t.requests_mtd == null ? 'na' : ''}">${or(t.requests_mtd == null ? null : t.requests_mtd.toLocaleString(), '—')}</td>
      <td class="budget-cell">${t.budget_pct != null ? `<div class="row-progress"><div>${bar(t.budget_pct, barCls(t.budget_pct, warnAt), true)}</div><span class="num">${esc(fmtPct(t.budget_pct))}</span></div>` : `<span class="faint">${t.budget_usd ? 'No cost data' : 'No budget'}</span>`}</td>
      <td class="muted small">${esc(capShort('usage', t.capabilities.usage))}</td>
    </tr>`).join('');
    const models = d.usage.by_model.map((m) => `<tr><td><code>${esc(m.model)}</code></td><td class="r">${or(fmtNum(m.tokens), '—')}</td><td class="r">${or(fmtUsd(m.cost_usd), '—')}</td><td class="r">${or(m.requests?.toLocaleString(), '—')}</td></tr>`).join('');
    const hasSeries = d.usage.series.length > 0;
    const hasCost = d.usage.series.some((x) => x.cost.some((v) => v != null));

    return `<div class="page-head"><div><h2>Usage & Costs</h2><p>This month so far. Days are in UTC, the same as the providers report.</p></div>
      ${hasSeries ? `<button class="btn" data-action="usage-csv">${ICON.download}Download CSV</button>` : ''}</div>
      <div class="tiles tiles-4">
        ${tile('Spend this month', fmtUsd(s.cost_mtd), reportingCost(s.tools_reporting_cost), { na: 'No cost data' })}
        ${tile('Tokens this month', fmtNum(s.tokens_mtd), 'Input, output and cache', { trend: dailyTotal(d, 'tokens', 30) })}
        ${tile('Requests this month', s.requests_mtd?.toLocaleString() ?? null, 'Where the tool reports them')}
        ${tile('Ceiling used', ceilPct == null ? null : fmtPct(ceilPct), s.ceiling_usd ? `Of ${fmtUsd(s.ceiling_usd)} this month` : 'Set a ceiling in Settings', { cls: ceilPct == null ? '' : barCls(ceilPct, warnAt), na: s.ceiling_usd ? 'No cost data' : 'No ceiling' })}
      </div>
      <div class="grid-2">
        <section class="card"><div class="card-head"><h3>Daily tokens</h3><span class="aside">Last 30 days</span></div>
          ${hasSeries ? '<div class="chart"><canvas id="ch-tokens" aria-label="Daily tokens by tool"></canvas></div><div class="legend" id="lg-tokens"></div>' : emptyBlock('No usage data yet', 'Token counts appear for tools that report them.')}</section>
        <section class="card"><div class="card-head"><h3>Daily spend</h3><span class="aside">Last 30 days</span></div>
          ${hasCost ? '<div class="chart"><canvas id="ch-cost" aria-label="Daily spend by tool"></canvas></div>' : emptyBlock('No cost data yet', 'Spend appears for API tools and tools you log costs for. Apps signed in with your account are included in your plan.')}</section>
      </div>
      <section class="card"><div class="card-head"><h3>By tool</h3><span class="aside">This month</span></div>
        ${rows ? `<div class="table-wrap"><table><thead><tr><th>Tool</th><th class="r">Spend</th><th class="r">Tokens</th><th class="r">Input</th><th class="r">Output</th><th class="r">Requests</th><th>Budget</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBlock('No tools yet', 'Add a tool to see its usage.')}
        <p class="fine">A dash means the tool does not report that figure. It is not zero. “In plan” means usage counts toward your subscription instead of being billed per token.</p></section>
      <section class="card"><div class="card-head"><h3>By model</h3><span class="aside">This month</span></div>
        ${models ? `<div class="table-wrap"><table><thead><tr><th>Model</th><th class="r">Tokens</th><th class="r">Spend</th><th class="r">Requests</th></tr></thead><tbody>${models}</tbody></table></div>` : emptyBlock('No model data', 'Per-model figures come from API tools and AI apps on this computer.')}
        <p class="fine">OpenAI reports cost per day without a model split, so its models show tokens but no spend.</p></section>
      ${synced.length ? `<section class="card"><div class="card-head"><h3>Data freshness</h3></div><div class="rows">${synced.map((t) => `<div class="row">${logo(t, 'xs')}<div class="row-main"><div class="row-title">${esc(t.name)}</div><div class="row-sub">${t.last_sync_at ? `${t.kind === 'local' ? 'Logs read' : 'Synced'} ${esc(rel(t.last_sync_at))}` : 'Not synced yet'}${t.data_refreshed_at && t.kind === 'api' ? ` · provider data complete up to ${esc(when(t.data_refreshed_at))}` : ''}</div></div>${pill(toolStatus(t).cls, toolStatus(t).label)}</div>`).join('')}</div>
        <p class="fine">Anthropic usually publishes usage within 4 hours (up to 24). OpenAI cost data is daily. Apps on this computer are read every 2 minutes.</p></section>` : ''}`;
  },

  stats() {
    const st = S.stats;
    const head = `<div class="page-head"><div><h2>Statistics</h2><p>This month and the last 30 days, from what your tools report and the work your AIs did here. Nothing is estimated.</p></div>
      <a class="btn" href="#usage">${ICON.chart}Usage & Costs</a></div>`;
    if (!st) return `${head}<div class="card">${emptyBlock('Loading statistics…', '')}</div>`;
    const t = st.totals;
    const pct = (n) => (n == null ? null : `${Math.round(n)}%`);
    const perfRows = st.performance.map((p) => `<tr>
      <td><span class="cell-tool">${engineById(p.id, p.label)}<b>${esc(p.label)}</b></span></td>
      <td class="r">${p.runs}</td>
      <td class="r"><span class="${p.success_pct < 60 ? 'err-text' : p.success_pct < 90 ? 'warn-text' : ''}">${esc(pct(p.success_pct))}</span></td>
      <td class="r">${or(p.median_ms == null ? null : dur(p.median_ms), '—')}</td>
      <td class="r">${or(p.passed_review_pct == null ? null : `${pct(p.passed_review_pct)} of ${p.reviewed}`, '—')}</td>
      <td class="r">${or(p.reviews ? `${p.approved} of ${p.reviews}` : null, '—')}</td></tr>`).join('');
    const maxCat = Math.max(1, ...st.asks.by_category.map((c) => c.count));
    const maxEng = Math.max(1, ...st.asks.by_engine.map((c) => c.count));
    return `${head}
      <div class="tiles tiles-5">
        ${tile('Tokens this month', fmtNum(t.tokens_mtd), 'Input, output and cache, all tools')}
        ${tile('Requests this month', t.requests_mtd?.toLocaleString() ?? null, 'Where tools report them')}
        ${tile('AI runs this month', t.runs_mtd, t.success_pct == null ? 'Tasks your AIs ran here' : `${pct(t.success_pct)} finished successfully`)}
        ${tile('AI team tasks', t.team_runs, t.team_median_ms == null ? 'Last 30 days' : `Usually take ${dur(t.team_median_ms)}`)}
        ${tile('Busiest day', t.busiest_day ? fmtNum(t.busiest_day.tokens) : null, t.busiest_day ? `${shortDay(t.busiest_day.day)}, in tokens` : 'No usage yet', { na: 'No usage yet' })}
      </div>
      <div class="grid-2">
        <section class="card"><div class="card-head"><h3>Share of usage</h3><span class="aside">This month, by tokens</span></div>
          ${st.share.length ? `<div class="share"><div class="share-chart"><canvas id="ch-share" aria-label="Share of tokens by tool"></canvas></div>
            <div class="share-list">${st.share.map((s, i) => `<div class="share-row"><i style="background:var(--c${(i % 6) + 1})"></i><span class="grow min0">${esc(s.name)}</span><span class="num faint">${esc(fmtNum(s.tokens))}</span><b class="num">${esc(pct(s.share))}</b></div>`).join('')}</div></div>`
            : emptyBlock('No token usage yet', 'Shares appear once tools report tokens.')}
        </section>
        <section class="card"><div class="card-head"><h3>Usage over 30 days</h3><span class="aside">Tokens per day, all tools</span></div>
          ${st.daily.some((x) => x.tokens != null) ? '<div class="chart"><canvas id="ch-daily" aria-label="Tokens per day"></canvas></div>' : emptyBlock('No usage yet', 'Daily totals appear once tools report tokens.')}
        </section>
      </div>
      <section class="card"><div class="card-head"><h3>How your AIs perform</h3><span class="aside">Work they did here, last 30 days</span></div>
        ${perfRows ? `<div class="table-wrap"><table><thead><tr><th>AI</th><th class="r">Runs</th><th class="r">Succeeded</th><th class="r">Typical time</th><th class="r">Its work approved</th><th class="r">Approvals it gave</th></tr></thead><tbody>${perfRows}</tbody></table></div>
          <p class="fine">Runs count assistant tasks, AI team stages and Ask all answers. “Its work approved” is how often the first review approved what it built; “approvals it gave” is how often it approved as the reviewer. Smart routing uses recent failures here to send work elsewhere.</p>`
          : emptyBlock('No runs yet', 'Start an assistant task, an AI team task or Ask all to see how each AI does.')}
      </section>
      <div class="grid-2">
        <section class="card"><div class="card-head"><h3>What you ask for</h3><span class="aside">${plural(st.asks.total, 'request')} routed</span></div>
          ${st.asks.by_category.length ? `<div class="hbars">${st.asks.by_category.map((c) => `<div class="hbar"><span>${esc(c.label)}</span><div class="bar thin"><i style="width:${(100 * c.count) / maxCat}%"></i></div><b class="num">${c.count}</b></div>`).join('')}</div>
            <div class="lineup-label">Where Automatic sent it</div>
            <div class="hbars">${st.asks.by_engine.map((c) => `<div class="hbar"><span class="cell-tool">${engineById(c.id, c.label)}${esc(c.label)}</span><div class="bar thin"><i style="width:${(100 * c.count) / maxEng}%"></i></div><b class="num">${c.count}</b></div>`).join('')}</div>`
            : emptyBlock('Nothing routed yet', 'With the assistant on Automatic, every request is sorted by kind and sent to the best AI for it.')}
        </section>
        <section class="card"><div class="card-head"><h3>Cache reuse</h3><span class="aside">This month</span></div>
          ${st.cache.length ? `<div class="hbars">${st.cache.map((c) => `<div class="hbar"><span class="cell-tool">${logo({ vendor: c.vendor, name: c.name, adapter: c.adapter }, 'xs')}${esc(c.name)}</span><div class="bar thin ok"><i style="width:${c.cache_pct}%"></i></div><b class="num">${esc(pct(c.cache_pct))}</b></div>`).join('')}</div>
            <p class="fine">The share of input read back from the provider’s cache instead of sent fresh. Higher is better: cached input is cheaper and counts less toward limits.</p>`
            : emptyBlock('No cache figures yet', 'Shown for tools that report cache reads, such as Claude Code.')}
        </section>
      </div>
      <section class="card"><div class="card-head"><h3>Recent routing decisions</h3></div>
        ${st.recent_routes.length ? `<div class="rows">${st.recent_routes.map((r) => `<div class="row">${engineById(r.engine, r.engine_label)}<div class="row-main"><div class="row-title">${esc(r.preview || r.category)}</div><div class="row-sub">${esc(r.why ?? '')}</div></div><div class="row-time">${esc(rel(r.at))}</div></div>`).join('')}</div>`
          : emptyBlock('No decisions yet', 'They appear here when Automatic picks an AI for a chat, task or team.')}
      </section>`;
  },

  tasks() {
    const d = S.data;
    const { groups, labels } = taskGroups(d);
    const canRun = !d.demo && d.engine;
    return `<div class="page-head"><div><h2>Tasks</h2><p>What your agents and apps report, live sessions from AI apps on this computer, and work the assistant and the AI team do here.</p></div>
      <div class="form-actions"><a class="btn ghost" href="#automations">${ICON.repeat}Automations</a>${canRun ? `<button class="btn" data-action="new-claude-task">${ICON.spark}New assistant task</button><button class="btn primary" data-action="new-team-task">${ICON.team}New AI team task</button>` : ''}</div></div>
      <div class="task-tools">
        <div class="chips" role="group" aria-label="Filter tasks">${Object.keys(groups).map((k) => `<button class="chip" data-action="task-filter" data-filter="${k}" aria-pressed="${S.taskFilter === k}">${labels[k]} <span class="n num">${groups[k].length}</span></button>`).join('')}</div>
        <input class="input task-search" id="task-search" type="search" placeholder="Search tasks" value="${esc(S.taskQuery ?? '')}" aria-label="Search tasks" autocomplete="off">
      </div>
      <section class="card" id="task-list">${taskListHtml(groups, labels)}</section>`;
  },

  automations() {
    const d = S.data;
    const list = d.automations ?? [];
    const canEdit = !d.demo;
    const on = list.filter((a) => a.enabled).length;
    const ideas = AUTO_TEMPLATES.map((t, i) => ({ t, i })).filter(({ t }) => !list.some((a) => a.name === t.name));
    return `<div class="page-head"><div><h2>Automations</h2><p>Prompts that run on a schedule. Each run goes to the AI best suited to it, shows up in Tasks with live progress, and alerts you when it finishes.</p></div>
      ${canEdit ? `<button class="btn primary" data-action="new-automation">${ICON.plus}New automation</button>` : ''}</div>
      ${!d.demo && !d.engine ? '<div class="callout warn">Connect an AI app or add a Claude API key first. Automations need one to run.</div>' : ''}
      ${list.length ? `<p class="auto-summary">${plural(list.length, 'automation')} · ${on} on${on ? ` · next run ${esc(rel(list.filter((a) => a.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0]?.next_run_at) ?? 'not scheduled')}` : ''}</p>
        <div class="autos">${list.map(autoCard).join('')}</div>` : ''}
      ${ideas.length ? `<section class="card">
        <div class="card-head"><h3>${list.length ? 'More ideas' : 'Start from an idea'}</h3><span class="aside">Edit any of them before saving</span></div>
        <div class="auto-ideas">${ideas.map(({ t, i }) => `<button class="auto-idea" data-action="new-automation" data-template="${i}" ${canEdit ? '' : 'disabled'}>
          <span class="auto-ico sm">${ICON[t.mode === 'team' ? 'team' : t.mode === 'compare' ? 'chat' : 'repeat']}</span>
          <span class="min0"><b>${esc(t.name)}</b><span class="faint small block">${esc(scheduleText(t.schedule))} · ${esc(MODE_LABEL[t.mode])}</span></span></button>`).join('')}</div>
      </section>` : ''}
      <p class="fine">Times are this computer’s local time. Automations run while Meridian is open or in the tray. A run that was due while the app was closed is skipped rather than run late.</p>`;
  },

  notifications() {
    const d = S.data;
    return `<div class="page-head"><div><h2>Alerts</h2><p>${d.unread ? `${d.unread} unread` : 'All caught up'} · choose which alerts you get in Settings.</p></div>
      ${d.unread && !d.demo ? '<button class="btn" data-action="read-all">Mark all as read</button>' : ''}</div>
      <section class="card">${d.notifications.length ? `<div class="rows">${d.notifications.map((n) => `<button class="row ${n.read ? 'read' : ''}" data-action="read-notif" data-id="${n.id}">
        <div class="status-ico s-${esc(n.severity)}">${ICON[SEVERITY_ICON[n.severity] ?? 'info']}</div>
        <div class="row-main"><div class="row-title">${n.read ? '' : '<span class="new-dot" aria-label="Unread"></span>'}${esc(n.title)}</div><div class="row-sub">${esc(n.body)}</div></div>
        <div class="row-time">${esc(rel(n.created_at))}</div></button>`).join('')}</div>` : emptyBlock('No alerts yet', 'Failed tasks, budget warnings and connection problems show up here.')}</section>`;
  },

  map() {
    const d = S.data;
    const tools = d.tools.filter((t) => t.kind !== 'builtin');
    return `<div class="page-head"><div><h2>Map</h2><p>Your command center and the AI tools around it, grouped by company, with the routes your requests take. Drag to move, scroll to zoom, or search for a place.</p></div>
        <div class="form-actions"><button class="btn" data-action="add-tool">${ICON.plus}Connect a tool</button></div></div>
      <div class="map" id="map" tabindex="0" aria-label="AI map. Arrow keys move it, plus and minus zoom, 0 shows everything, Tab moves between places."></div>
      <details class="map-list card" ${tools.length ? '' : 'hidden'}><summary>${ICON.tasks}<span>Every place as a list</span></summary><div id="map-list"></div></details>`;
  },

  security() {
    const d = S.data;
    const x = S.sec;
    const head = `<div class="page-head"><div><h2>Sign-in &amp; security</h2><p>How you sign in to Meridian, and who is signed in.</p></div></div>`;
    if (d.demo) return `${head}<div class="callout warn">Exit the demo to change how you sign in.</div>`;
    if (!x) return `${head}<section class="card"><div class="empty">Loading…</div></section>`;
    const pwField = (id, name, label, auto, extra = '') => `<div class="field"><label for="${id}">${label}</label><div class="si-pass"><input class="input" id="${id}" name="${name}" type="password" autocomplete="${auto}" required maxlength="200" ${extra}><button type="button" class="si-eye" data-action="toggle-pass" data-target="${id}" aria-label="Show password" aria-pressed="false">${EYE}</button></div></div>`;
    const status = (on, yes, no) => `<span class="pill ${on ? 's-ok' : 's-queued'}">${on ? yes : no}</span>`;

    // Password
    const password = `<section class="card sec-card"><div class="card-head">${ICON.key}<h3>Password</h3><span class="aside">Changed ${esc(rel(x.password_changed_at) ?? 'at setup')}</span></div>
      <form class="form" data-form="change-password">
        ${x.can_reset_without_password ? '<div class="callout info small">You signed in with Google just now, so you can set a new password without the old one for a few minutes.</div>' : pwField('cp-current', 'current', 'Current password', 'current-password')}
        <div class="form-row">${pwField('cp-next', 'next', 'New password', 'new-password', 'minlength="12"')}${pwField('cp-confirm', 'confirm', 'Confirm new password', 'new-password')}</div>
        <div class="si-meter" aria-hidden="true"><i id="cp-bar"></i></div>
        <ul class="si-rules"><li data-rule="len">At least 12 characters</li><li data-rule="mix">A mix of letters, numbers or symbols</li><li data-rule="user">Doesn’t contain your username</li></ul>
        <div class="form-actions"><button class="btn primary" type="submit">Change password</button><span class="faint small">Everyone else signed in is signed out.</span></div>
        <div class="error-text" data-error></div>
      </form></section>`;

    // Two-step verification
    let twoStep;
    if (S.secCodes) {
      twoStep = `<div class="callout warn"><b>Save these recovery codes now.</b> Each signs you in once if you lose your phone. They won’t be shown again.</div>
        <ol class="sec-codes" id="sec-codes">${S.secCodes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ol>
        <pre id="sec-codes-raw" hidden>${esc(`Meridian recovery codes for ${x.username}\nEach works once.\n\n${S.secCodes.join('\n')}`)}</pre>
        <div class="form-actions"><button class="btn" data-action="copy" data-target="sec-codes-raw">Copy</button><button class="btn" data-action="save-codes">${ICON.download}Save as file</button><button class="btn primary" data-action="codes-done">I’ve saved them</button></div>`;
    } else if (x.two_factor) {
      twoStep = `<p class="muted small">Signing in with your password also needs a code from your authenticator app. ${plural(x.recovery_left ?? 0, 'recovery code')} left.</p>
        ${S.secForm === '2fa-off' || S.secForm === '2fa-recovery' ? `<form class="form sec-inline" data-form="${S.secForm}">
          <div class="form-row">${pwField('tf-pass', 'password', 'Your password', 'current-password')}${S.secForm === '2fa-off' ? '<div class="field"><label for="tf-code">Code or recovery code</label><input class="input" id="tf-code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="12"></div>' : ''}</div>
          <div class="form-actions"><button class="btn ${S.secForm === '2fa-off' ? 'danger' : 'primary'}" type="submit">${S.secForm === '2fa-off' ? 'Turn off two-step verification' : 'Make new recovery codes'}</button><button class="btn ghost" type="button" data-action="sec-form" data-form-name="">Cancel</button></div>
          ${S.secForm === '2fa-recovery' ? '<p class="fine">Your old recovery codes stop working.</p>' : ''}
          <div class="error-text" data-error></div></form>`
        : `<div class="form-actions"><button class="btn" data-action="sec-form" data-form-name="2fa-recovery">New recovery codes</button><button class="btn danger" data-action="sec-form" data-form-name="2fa-off">Turn off</button></div>`}`;
    } else if (S.secSetup) {
      twoStep = `<div class="sec-setup">
        <div class="sec-qr" role="img" aria-label="QR code for your authenticator app">${S.secSetup.qr}</div>
        <div class="min0">
          <ol class="sec-steps"><li>Open an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password.</li><li>Scan this QR code, or enter the key below by hand.</li><li>Type the 6-digit code it shows, and your password.</li></ol>
          <div class="field"><label>Key</label><div class="secret-box"><code id="sec-key">${esc(S.secSetup.secret)}</code><button class="btn small" data-action="copy" data-target="sec-key">Copy</button></div></div>
          <form class="form" data-form="2fa-on">
            <div class="form-row"><div class="field"><label for="tf-code">6-digit code</label><input class="input" id="tf-code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="7"></div>${pwField('tf-pass', 'password', 'Your password', 'current-password')}</div>
            <div class="form-actions"><button class="btn primary" type="submit">Turn on</button><button class="btn ghost" type="button" data-action="sec-2fa-cancel">Cancel</button></div>
            <div class="error-text" data-error></div></form>
        </div></div>`;
    } else {
      twoStep = `<p class="muted small">Add a second step to signing in with your password: a 6-digit code from an authenticator app on your phone. Someone who learns your password still can’t get in.</p>
        <div class="form-actions"><button class="btn primary" data-action="sec-2fa-start">Set up two-step verification</button></div>`;
    }
    const twoStepCard = `<section class="card sec-card"><div class="card-head">${svg('<rect x="4" y="1.8" width="8" height="12.4" rx="1.6"/><path d="M7 11.6h2"/>')}<h3>Two-step verification</h3>${status(x.two_factor, 'On', 'Off')}</div>${twoStep}</section>`;

    // Google
    const g = x.google;
    let google;
    if (!g.configured) {
      google = `<p class="muted small">Sign in with your Google account instead of your password. Google needs to know which app is asking, so you register Meridian in your own Google Cloud account first. It’s free and takes a few minutes:</p>
        <ol class="sec-steps">
          <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console → APIs &amp; Services → Credentials</a> and pick or create a project.</li>
          <li>If asked, set up the consent screen (Google Auth Platform): app name “Meridian”, audience <b>External</b>, your email as the contact. Under <b>Audience → Test users</b>, add the Google account you’ll sign in with.</li>
          <li>Choose <b>Create credentials → OAuth client ID</b>, application type <b>Desktop app</b>, name it, and create it.</li>
          <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the boxes below.</li>
        </ol>
        <form class="form" data-form="google-client">
          <div class="form-row"><div class="field"><label for="gc-id">Client ID</label><input class="input" id="gc-id" name="client_id" autocomplete="off" spellcheck="false" required placeholder="1234…apps.googleusercontent.com"></div>
            <div class="field"><label for="gc-secret">Client secret</label><input class="input" id="gc-secret" name="client_secret" type="password" autocomplete="off" spellcheck="false" required placeholder="GOCSPX-…"></div></div>
          <div class="form-actions"><button class="btn primary" type="submit">Save</button><span class="faint small">The secret is encrypted on this computer.</span></div>
          <div class="error-text" data-error></div></form>`;
    } else if (!g.linked) {
      google = `<p class="muted small">Your Google client is set up (${esc(g.client_id.slice(0, 14))}…). Now link the Google account you’ll sign in with. Google’s page opens in your browser.</p>
        ${S.secLinking ? '<div class="si-wait"><span class="spin"></span><span>Waiting for Google in your browser…</span><button class="btn small ghost" data-action="sec-link-cancel">Cancel</button></div>'
          : `<div class="form-actions"><button class="btn google-btn" data-action="sec-link">${GOOGLE_G}<span>Link a Google account</span></button><button class="btn ghost" data-action="sec-remove-client">Remove client</button></div>`}`;
    } else {
      google = `<p class="muted small">Linked to <b>${esc(g.email ?? 'your Google account')}</b>. “Continue with Google” on the sign-in page signs you in. Two-step verification isn’t asked for then, since Google has its own.</p>
        ${S.secForm === 'unlink' ? `<form class="form sec-inline" data-form="google-unlink"><div class="form-row">${pwField('gu-pass', 'password', 'Your password', 'current-password')}</div>
          <div class="form-actions"><button class="btn danger" type="submit">Unlink</button><button class="btn ghost" type="button" data-action="sec-form" data-form-name="">Cancel</button></div><div class="error-text" data-error></div></form>`
          : '<div class="form-actions"><button class="btn" data-action="sec-form" data-form-name="unlink">Unlink</button></div>'}`;
    }
    const googleCard = `<section class="card sec-card"><div class="card-head"><span class="sec-g">${GOOGLE_G}</span><h3>Sign in with Google</h3>${status(g.linked, 'Linked', g.configured ? 'Not linked' : 'Not set up')}</div>${google}</section>`;

    // Sessions
    const others = x.sessions.filter((t) => !t.current).length;
    const sessions = `<section class="card sec-card"><div class="card-head">${ICON.grid}<h3>Signed-in sessions</h3><span class="aside">${plural(x.sessions.length, 'session')}</span></div>
      <div class="rows">${x.sessions.map((t) => `<div class="row"><div class="status-ico ${t.current ? 's-ok' : 's-queued'}">${t.device.startsWith('Desktop') ? ICON.grid : ICON.external}</div>
        <div class="row-main"><div class="row-title">${esc(t.device)} ${t.current ? '<span class="tag accent">This session</span>' : ''}</div>
          <div class="row-sub">${esc(t.method === 'google' ? 'Signed in with Google' : t.method === 'password+2fa' ? 'Password and code' : 'Password')} · started ${esc(rel(t.created_at) ?? 'earlier')} · active ${esc(rel(t.last_seen) ?? 'earlier')} · ${t.persistent ? 'kept signed in' : 'ends when closed'}</div></div>
        ${t.current ? '' : `<button class="btn small" data-action="sec-end" data-id="${esc(t.id)}">Sign out</button>`}</div>`).join('')}</div>
      ${others ? `<div class="form-actions"><button class="btn" data-action="sec-end-others">Sign out everywhere else</button></div>` : ''}
    </section>`;

    return `${head}<div class="sec-grid">${password}${twoStepCard}${googleCard}${sessions}</div>
      <p class="fine">Signing in is limited to 10 tries per 15 minutes, and 20 wrong passwords lock the account for 15 minutes. Each new sign-in raises an alert. Turn those alerts on or off in <a href="#settings">Settings</a>.</p>`;
  },

  privacy() {
    const d = S.data;
    const p = S.privacyInfo;
    const head = `<div class="page-head"><div><h2>Privacy &amp; data</h2><p>What Meridian keeps, where your data goes, and how to control or delete it.</p></div></div>`;
    if (!p) return `${head}<section class="card"><div class="empty">Loading…</div></section>`;
    const dis = d.demo ? 'disabled' : '';
    const c = p.counts;
    const kv = (label, value, sub = '') => `<div class="pv-kv"><span>${esc(label)}</span><b class="num">${esc(value)}</b>${sub ? `<span class="faint small">${esc(sub)}</span>` : ''}</div>`;
    const mb = p.database_bytes == null ? 'Unknown' : p.database_bytes < 1e6 ? `${Math.max(1, Math.round(p.database_bytes / 1024))} KB` : `${(p.database_bytes / 1e6).toFixed(1)} MB`;
    const st = p.settings ?? {};
    const days = (n) => (n === 0 ? 'Keep until I delete it' : n === 365 ? '1 year' : `${n} days`);
    const pruned = p.last_pruned ? `Last clean-up ${rel(p.last_pruned.at)}: ${plural(p.last_pruned.tasks ?? 0, 'task')}, ${plural(p.last_pruned.conversations ?? 0, 'conversation')} and ${plural(p.last_pruned.alerts ?? 0, 'alert')} removed.` : '';
    const sw = (k, label, help) => `<label class="switch"><span><span class="switch-label">${esc(label)}</span><span class="faint small">${esc(help)}</span></span><input type="checkbox" data-privacy="${k}" ${st[k] !== false ? 'checked' : ''} ${dis}></label>`;
    return `${head}
      ${d.demo ? '<div class="callout warn">You’re looking at demo data elsewhere in the app. This page always describes your real data, and its controls are off while the demo is showing.</div>' : ''}
      <section class="card pv-hero">
        <span class="pv-badge">${ICON.shield}</span>
        <div class="min0"><h3>Your data stays on this computer</h3>
          <p>Everything the app keeps is in one folder on this computer. There’s no analytics, tracking or advertising, and nothing is sent to the makers of this app. Data leaves this computer only to the services you connect, and only when you use them.</p>
          <div class="pv-path"><code title="${esc(p.folder)}">${esc(p.folder)}</code>${p.desktop_app ? `<button class="btn small" data-action="open-data-folder">${ICON.folder}Open folder</button>` : ''}</div></div>
      </section>
      <div class="pv-grid">
        <section class="card"><div class="card-head">${ICON.folder}<h3>What’s kept here</h3><span class="aside">${esc(mb)}</span></div>
          <div class="pv-kvs">
            ${kv('Connected tools', c.tools, 'Names and budgets; keys are encrypted')}
            ${kv('Your tasks and results', c.tasks)}
            ${kv('Sessions from AI apps', c.sessions, st.read_sessions === false ? 'Off' : 'When, where, model, tokens')}
            ${kv('Assistant conversations', c.conversations)}
            ${kv('Alerts', c.alerts)}
            ${kv('Activity entries', c.activity)}
            ${kv('Routing notes', c.routing, 'Which AI took a request, and why')}
            ${kv('Automations', c.automations)}
            ${kv('Days of usage totals', c.usage_days, 'Numbers only')}
          </div>
          <p class="fine">Your password is stored only as a salted hash. API keys are encrypted with a key kept in the same folder. Backups never include either.</p>
        </section>
        <section class="card"><div class="card-head">${ICON.external}<h3>Where data goes</h3></div>
          <ol class="pv-flows">${p.flows.map((f) => `<li><b>${esc(f.to)}</b><span>${esc(f.what)}</span><span class="faint small">${esc(f.when)} ${esc(f.terms)}</span></li>`).join('')}</ol>
        </section>
      </div>
      <section class="card"><div class="card-head">${ICON.gear}<h3>Controls</h3></div>
        <div class="switch"><span><span class="switch-label">Keep finished work for</span><span class="faint small">Finished tasks and their results, conversations, alerts, activity and routing notes older than this are deleted once a day. Running work, automations, tools and usage totals are kept. ${esc(pruned)}</span></span>
          <select class="input pv-select" data-privacy="retention_days" aria-label="Keep finished work for" ${dis}>${p.retention_choices.map((n) => `<option value="${n}" ${st.retention_days === n ? 'selected' : ''}>${esc(days(n))}</option>`).join('')}</select></div>
        ${sw('read_sessions', 'List sessions from AI apps on this computer', 'Read from each app’s own logs: when and where it ran, the model and tokens. Off removes them here; the apps’ own history isn’t touched.')}
        ${sw('session_titles', 'Name sessions after their first message', 'Off lists them as “Claude Code session” and so on, without what you typed.')}
        <p class="fine">Alerts, Windows notifications and the update check are in <a href="#settings">Settings</a>.</p>
      </section>
      <section class="card"><div class="card-head">${ICON.download}<h3>Your copy, and deleting everything</h3></div>
        <p class="muted small">Download everything in a readable file you can keep or move: tools, tasks and results, conversations, alerts, automations and settings. It never includes your password or keys.</p>
        <div class="form-actions"><button class="btn" data-action="backup-download" ${dis}>${ICON.download}Download a copy</button>
          ${S.eraseOpen ? '' : `<button class="btn danger" data-action="erase-open" ${dis}>${ICON.trash}Delete everything…</button>`}</div>
        ${S.eraseOpen ? `<form class="pv-erase" data-form="erase">
          <p><b>This permanently deletes everything Meridian keeps</b>: your account, tools and keys, usage, tasks and results, conversations, alerts, automations and settings. It can’t be undone. The AI apps you connected and their own history aren’t affected. The app then starts over as if newly installed.</p>
          <div class="form-row"><div class="field"><label for="er-pass">Your password</label><input class="input" id="er-pass" name="password" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="er-confirm">Type DELETE to confirm</label><input class="input" id="er-confirm" name="confirm" autocomplete="off" required pattern="DELETE" spellcheck="false"></div></div>
          <div class="form-actions"><button class="btn danger" type="submit">${ICON.trash}Delete everything</button><button class="btn ghost" type="button" data-action="erase-cancel">Keep my data</button></div>
          <div class="error-text" data-error></div></form>` : ''}
      </section>
      <section class="card pv-about"><div class="card-head">${ICON.info}<h3>About</h3><span class="aside">Version ${esc(d.update?.current ?? '')}</span></div>
        <p><b>AI-generated content.</b> Chat replies, task results, AI team work, merged answers and the daily summary are written by AI models from other companies, and each is labelled with the AI that wrote it. They can be wrong or out of date, so check anything important before relying on it.</p>
        <p><b>Your accounts.</b> Work you run here counts toward your plans and follows each provider’s terms and privacy policy. Only connect accounts you’re allowed to use, and only give an AI team folders you’re allowed to change.</p>
        <p><b>Not affiliated.</b> Meridian isn’t made, endorsed or sponsored by Anthropic, OpenAI, Google, GitHub, Microsoft, Anysphere or Perplexity. Their product names are trademarks of their owners and appear only to identify the tools you connect. The coloured initials aren’t their logos.</p>
        <details class="pv-licenses"><summary>Open-source software in this app</summary>
          <ul>${[['Electron', 'MIT'], ['Express', 'MIT'], ['Chart.js', 'MIT'], ['Anthropic SDK for TypeScript', 'MIT'], ['Inter typeface', 'SIL Open Font License 1.1'], ['Node.js', 'MIT and others']].map(([n, l]) => `<li>${esc(n)} <span class="faint">· ${esc(l)}</span></li>`).join('')}</ul>
          <p class="fine">Each package’s licence ships with it in the app’s files.</p></details>
      </section>`;
  },

  settings() {
    const d = S.data;
    const st = d.settings;
    const dis = d.demo ? 'disabled' : '';
    const theme = readStore('acc-theme') ?? 'system';
    return `<div class="page-head"><div><h2>Settings</h2><p>The assistant, alerts, appearance and your account.</p></div></div>
      ${d.demo ? '<div class="callout warn">Settings are read-only while demo data is showing.</div>' : ''}
      <div class="grid-2">
        <section class="card span-2"><div class="card-head">${ICON.chat}<h3>Assistant</h3></div>
          <p class="muted small">The chat, background tasks and the daily summary run through one AI. Apps signed in with your own account need no API key; their usage counts toward your plan.</p>
          <div class="engine-list" role="radiogroup" aria-label="Which AI the assistant uses">
            <label class="engine-opt ${st.assistant_engine === 'auto' ? 'on' : ''}"><input type="radio" name="engine" value="auto" data-action-change="set-engine" ${st.assistant_engine === 'auto' ? 'checked' : ''} ${dis}>
              <span class="logo sm hue-brand">${ICON.spark}</span><span class="min0"><b>Automatic (smart)</b><span class="faint small block">Each request goes to the AI best suited to it: coding to Claude Code or Codex, planning to Codex, research to Gemini, quick questions to Copilot. Plans you pay for come before an API key, AIs near their limits or failing are used less, and work is spread across your accounts.</span></span></label>
            ${d.engines.map((e) => `<label class="engine-opt ${st.assistant_engine === e.id ? 'on' : ''} ${e.ready ? '' : 'off'}"><input type="radio" name="engine" value="${e.id}" data-action-change="set-engine" ${st.assistant_engine === e.id ? 'checked' : ''} ${e.ready ? '' : 'disabled'} ${dis}>
              ${engineLogo(e, 'sm')}<span class="min0"><b>${esc(e.label)}</b><span class="faint small block">${esc(e.ready ? `Ready · ${e.via}` : e.reason)}</span></span>
              ${!e.ready && e.kind === 'cli' && !d.demo ? (e.integration_id ? `<a class="btn small" href="#tool-${e.integration_id}">Set up</a>` : `<button class="btn small" type="button" data-action="connect-local" data-id="${e.id}">Connect</button>`) : ''}</label>`).join('')}
          </div>
          <label class="switch summary-switch"><span><span class="switch-label">Write the daily summary with AI</span><span class="faint small">One short request to the AI above every ${esc(st.summary_interval_hours)} hours. Off: the summary is built from your data by fixed rules, with no AI use.</span></span><input type="checkbox" data-summary-mode ${st.summary_mode !== 'rules' ? 'checked' : ''} ${dis}></label>
        </section>

        <section class="card span-2"><div class="card-head">${ICON.pulse}<h3>Smart routing</h3></div>
          <p class="muted small">On Automatic, each request goes to the AI best suited to its kind of task, using your plans before any API key and passing over AIs at their limit or failing. Pick an AI here to always use it for that kind of task; Automatic still steps in if it’s at its limit or its last run failed.</p>
          <div class="role-grid">${Object.entries(d.task_kinds ?? {}).map(([kind, label]) => {
            const cur = st.route_prefs?.[kind] ?? 'auto';
            return `<label class="role-opt"><span class="min0"><b>${esc(label)}</b></span>
              <select class="input" data-route-pref="${kind}" ${dis} aria-label="Preferred AI for ${esc(label)}">
                <option value="auto" ${cur === 'auto' ? 'selected' : ''}>Automatic</option>
                ${d.engines.map((e) => `<option value="${e.id}" ${cur === e.id ? 'selected' : ''} ${e.ready || cur === e.id ? '' : 'disabled'}>${esc(e.label)}${e.ready ? '' : ` · ${esc(e.reason)}`}</option>`).join('')}
              </select></label>`;
          }).join('')}</div>
        </section>

        <section class="card span-2"><div class="card-head">${ICON.team}<h3>AI team</h3></div>
          <p class="muted small">For AI team tasks, your connected AIs split the work by role. Automatic gives each role to the best-suited AI that’s ready: Codex plans and reviews, Claude Code builds and fixes, and Gemini CLI debugs, with the others filling in. The reviewer is a different AI from the builder whenever one is available.</p>
          <div class="role-grid">${TEAM_ORDER.map(([role]) => {
            const r = d.team.roles[role];
            const now = d.team.lineup?.[role];
            const cur = st.team_roles?.[role] ?? 'auto';
            return `<label class="role-opt"><span class="min0"><b>${esc(r.title)}</b><span class="faint small block">${esc(r.does)}</span></span>
              <select class="input" data-team-role="${role}" ${dis} aria-label="${esc(r.title)}">
                <option value="auto" ${cur === 'auto' ? 'selected' : ''}>Automatic${now ? ` (${esc(now.label)})` : ''}</option>
                ${d.engines.map((e) => `<option value="${e.id}" ${cur === e.id ? 'selected' : ''} ${e.ready ? '' : 'disabled'}>${esc(e.label)}${e.ready ? '' : ` · ${esc(e.reason)}`}</option>`).join('')}
              </select></label>`;
          }).join('')}</div>
          <div class="lineup-label">Right now</div>${lineupStrip(d.team.lineup)}
        </section>

        <section class="card"><div class="card-head">${ICON.key}<h3>Claude API key (optional)</h3></div>
          <form class="form" data-form="summary">
            <p class="muted small">Only needed if you want the assistant to use the Claude API instead of an app signed in with your account. Use a regular API key, not the Admin key. Requests use Claude Opus 5.5 and are billed per token.</p>
            <div class="field"><label for="s-key">Claude API key</label><input class="input" id="s-key" name="summary_key" type="password" autocomplete="off" placeholder="${st.summary_key_set ? `Saved: ${esc(st.summary_key_hint)}` : 'sk-ant-…'}" ${dis}>
              <span class="help">${st.summary_key_set ? 'Leave empty to keep the saved key.' : 'Stored encrypted on this computer.'}</span></div>
            <div class="field"><label for="s-int">Regenerate the daily summary every (hours)</label><input class="input" id="s-int" name="summary_interval_hours" type="number" min="1" max="168" value="${esc(st.summary_interval_hours)}" ${dis}>
              <span class="help">Each AI summary is one short request.</span></div>
            <label class="switch"><span><span class="switch-label">Let Claude search the web</span><span class="faint small">With the Claude API key only. Searches are billed on top of tokens.</span></span><input type="checkbox" data-setting="assistant_web_search" ${st.assistant_web_search ? 'checked' : ''} ${dis}></label>
            <div class="form-actions"><button class="btn primary" type="submit" ${dis}>Save</button>
              ${st.summary_key_set ? `<button class="btn danger" type="button" data-action="remove-summary-key" ${dis}>Remove key</button>` : ''}
              <button class="btn" type="button" data-action="refresh-summary" ${dis}>Generate summary now</button></div>
            <div class="error-text" data-error></div>
          </form></section>

        <section class="card"><div class="card-head">${ICON.chart}<h3>Budgets and syncing</h3></div>
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

        <section class="card"><div class="card-head">${ICON.bell}<h3>Alerts</h3></div>
          ${Object.entries(NOTIFY_LABELS).map(([k, [label, help]]) => `<label class="switch"><span><span class="switch-label">${esc(label)}</span><span class="faint small">${esc(help)}</span></span><input type="checkbox" id="n-${k}" data-notify="${k}" ${st.notify[k] ? 'checked' : ''} ${dis}></label>`).join('')}
        </section>

        ${d.desktop_app ? `<section class="card"><div class="card-head">${ICON.grid}<h3>Desktop app</h3></div>
          ${[
            ['keep_running', 'Keep running when the window is closed', 'Tasks, the AI team, syncs and alerts keep going. Open it again from the icon in the system tray, and quit it there.'],
            ['open_at_login', 'Start when you sign in to Windows', 'Starts in the system tray, so syncs and alerts run from the moment you sign in.'],
            ['notifications', 'Windows notifications', 'Show new alerts, such as a finished AI team task, as Windows notifications while the app isn’t in front.'],
            ['check_updates', 'Check for updates', 'Looks for a new version every few hours and lets you know. Nothing installs until you choose to.'],
          ].map(([k, label, help]) => `<label class="switch"><span><span class="switch-label">${esc(label)}</span><span class="faint small">${esc(help)}</span></span><input type="checkbox" data-desktop="${k}" ${st.desktop?.[k] ? 'checked' : ''} ${dis}></label>`).join('')}
        </section>` : ''}

        ${updateCard(d)}

        <section class="card"><div class="card-head">${ICON.download}<h3>Backup</h3></div>
          <p class="muted small">Save your tools, tasks and their results, conversations, alerts and settings to a file. Backups never include your password, API keys or ingest tokens, so a backup file is safe to keep, and you add keys again after restoring.</p>
          <div class="form-actions"><button class="btn" data-action="backup-download" ${dis}>${ICON.download}Download a backup</button>
            <label class="btn ${d.demo ? 'disabled' : ''}">${ICON.folder}Restore from a backup…<input type="file" accept="application/json,.json" data-action-change="backup-file" hidden ${dis}></label></div>
          <div id="restore-confirm"></div>
        </section>

        <section class="card"><div class="card-head">${ICON.sun}<h3>Appearance, demo and account</h3></div>
          <div class="switch"><span><span class="switch-label">Theme</span><span class="faint small">Saved on this device</span></span>
            <div class="seg" role="group" aria-label="Theme">${['system', 'dark', 'light'].map((v) => `<button type="button" class="seg-btn" data-action="set-theme" data-theme="${v}" aria-pressed="${theme === v}">${cap1(v)}</button>`).join('')}</div></div>
          <label class="switch"><span><span class="switch-label">Show demo data</span><span class="faint small">Sample tools and tasks, labeled as demo. Your data is untouched.</span></span><input type="checkbox" id="s-demo" data-action-change="toggle-demo" ${S.demo ? 'checked' : ''}></label>
          <div class="switch static"><span>Signed in as <b>${esc(S.user.username)}</b></span><button class="btn small" data-action="logout">Sign out</button></div>
        </section>
      </div>`;
  },
};

function taskGroups(d) {
  const groups = {
    all: d.tasks,
    running: d.tasks.filter((t) => t.status === 'running'),
    upcoming: d.tasks.filter((t) => t.status === 'queued' || t.status === 'scheduled'),
    completed: d.tasks.filter((t) => t.status === 'completed' && t.kind !== 'session'),
    failed: d.tasks.filter((t) => t.status === 'failed'),
    team: d.tasks.filter((t) => t.kind === 'team'),
    sessions: d.tasks.filter((t) => t.kind === 'session'),
  };
  const labels = { all: 'All', running: 'Running', upcoming: 'Upcoming', completed: 'Completed', failed: 'Failed', team: 'AI team', sessions: 'Sessions' };
  for (const k of ['team', 'sessions']) if (!groups[k].length) delete groups[k];
  return { groups, labels };
}

/** The task list for the current filter and search, so typing in the search box only redraws the list. */
function taskListHtml(groups, labels) {
  const d = S.data;
  const q = (S.taskQuery ?? '').trim().toLowerCase();
  let list = groups[S.taskFilter] ?? groups.all;
  if (q) list = list.filter((t) => [t.name, t.tool_name, t.description, t.step, t.error, t.runner_label].some((v) => v && String(v).toLowerCase().includes(q)));
  if (list.length) return `<div class="rows">${list.map((t) => taskRow(t)).join('')}</div>`;
  if (q) return emptyBlock('No matching tasks', `Nothing ${S.taskFilter === 'all' ? '' : `in ${labels[S.taskFilter]?.toLowerCase()} `}matches “${S.taskQuery.trim()}”.`);
  return d.tasks.length
    ? emptyBlock(`No ${labels[S.taskFilter]?.toLowerCase() ?? ''} tasks`, 'Try another filter.')
    : emptyBlock('No tasks yet', 'Connect Claude Code, Codex, Gemini or GitHub Copilot to see their sessions, have your scripts report tasks, or start an assistant or AI team task.');
}

/** Retention deletes old work as soon as it's set, so say how much first. Resolves true to go ahead. */
function confirmRetention(days) {
  const cutoff = Date.now() - days * 86_400_000;
  const n = (S.data?.tasks ?? []).filter((t) => t.kind !== 'session' && ['completed', 'failed'].includes(t.status) && Date.parse(t.finished_at ?? t.updated_at) < cutoff).length;
  return new Promise((resolve) => {
    openPanel('Delete old finished work?', `<div class="form">
      <p>Finished tasks and their results, conversations, alerts, activity and routing notes older than ${days === 365 ? 'a year' : `${days} days`} will be deleted now, then once a day. ${n ? `That includes ${plural(n, 'task')} now.` : 'Nothing is that old yet.'} Deleted work can’t be brought back, unless you saved a copy first.</p>
      <div class="form-actions"><button class="btn danger" data-retention="yes">Delete old work</button><button class="btn ghost" data-retention="no">Cancel</button></div></div>`, { center: true });
    const root = $('#modal-root');
    const done = (v) => {
      root.removeEventListener('click', onPick, true);
      S.onModalClose = null;
      closeModal();
      resolve(v);
    };
    // Escape, or anything else that closes the dialog, counts as Cancel.
    S.onModalClose = () => {
      root.removeEventListener('click', onPick, true);
      resolve(false);
    };
    const onPick = (e) => {
      const b = e.target.closest('[data-retention], [data-action="close"], .overlay');
      if (!b) return;
      if (b.classList.contains('overlay') && e.target !== b) return;
      e.stopPropagation();
      done(b.dataset.retention === 'yes');
    };
    root.addEventListener('click', onPick, true);
  });
}

// ── Updates ──────────────────────────────────────────────────────────────
function updateCard(d) {
  const u = d.update ?? {};
  const dis = d.demo ? 'disabled' : '';
  const status = u.available
    ? `<b>Version ${esc(u.latest)} is available.</b> You have ${esc(u.current)}.`
    : u.latest && !u.error
      ? `You have the newest version, ${esc(u.current)}.`
      : `You have version ${esc(u.current ?? 'unknown')}.`;
  const action = u.can_install
    ? `<button class="btn primary" data-action="install-update" ${dis}>${ICON.download}Install ${esc(u.latest)} and restart</button>`
    : u.available
      ? `<a class="btn primary" href="${esc(u.url)}" target="_blank" rel="noopener">${ICON.external}Get ${esc(u.latest)} from GitHub</a>`
      : '';
  return `<section class="card" id="updates"><div class="card-head">${ICON.refresh}<h3>Updates</h3>${u.available ? '<span class="tag accent">New version</span>' : ''}</div>
    <p class="small update-status">${status}</p>
    ${u.error ? `<div class="callout warn small">Couldn’t check: ${esc(u.error)}</div>` : ''}
    ${u.available && u.notes ? `<details class="release-notes"><summary>What’s new in ${esc(u.latest)}</summary><div class="md">${md(u.notes)}</div></details>` : ''}
    <div class="form-actions">${action}<button class="btn" data-action="check-update" ${dis}>Check now</button>
      <span class="faint small">${u.checked_at ? `Checked ${esc(rel(u.checked_at))}` : 'Not checked yet'}</span></div>
    <p class="fine">Reads the public list of releases on GitHub; no account or data of yours is sent.${u.can_install ? ' Installing keeps your data and settings, and the app opens again by itself.' : d.desktop_app ? '' : ' Running as a server: download the new version and restart it yourself.'}</p>
  </section>`;
}

// ── Command palette (Ctrl+P, Ctrl+Shift+P for commands) ──────────────────
function paletteItems() {
  const d = S.data;
  const items = [];
  const cmd = (label, run, { icon = ICON.chevron, hint = 'Command', keys = '' } = {}) => items.push({ kind: 'cmd', label, run, icon, hint, keys });
  for (const [k, pg] of Object.entries(PAGES)) if (k !== 'tool') items.push({ kind: 'page', label: pg.title, hint: 'Page', icon: ICON[pg.icon], run: () => (location.hash = `#${k}`) });
  for (const t of d?.tools ?? []) if (t.kind !== 'builtin') items.push({ kind: 'tool', label: t.name, hint: `${t.vendor} · ${toolStatus(t).label}`, icon: logo(t, 'xs'), run: () => (location.hash = `#tool-${t.id}`) });
  for (const t of (d?.tasks ?? []).filter((x) => x.kind !== 'session').slice(0, 40)) items.push({ kind: 'task', label: t.name, hint: `Task · ${TASK_STATUS[t.status]?.label ?? t.status}`, icon: ICON.tasks, run: () => openTask(t.id) });
  const real = d && !d.demo;
  if (real && d.engine) {
    cmd('Open the chat panel', () => toggleDock(true), { icon: ICON.chat, keys: 'Ctrl L' });
    cmd('New assistant task', () => openNewTask(), { icon: ICON.spark });
    cmd('New AI team task', () => openTeamTask(), { icon: ICON.team });
  }
  if (real) cmd('New automation', () => openAutomation({}), { icon: ICON.repeat });
  if (real) cmd('Connect a tool', () => openAddTool(), { icon: ICON.plus });
  cmd('Refresh', () => load({ force: true }), { icon: ICON.refresh });
  cmd('Theme: dark', () => setTheme('dark'), { icon: ICON.sun });
  cmd('Theme: light', () => setTheme('light'), { icon: ICON.sun });
  cmd('Theme: match the system', () => setTheme('system'), { icon: ICON.sun });
  cmd(d?.demo ? 'Exit demo data' : 'Show demo data', () => toggleDemo(), { icon: ICON.grid });
  if (real) cmd('Check for updates', async () => {
    const u = await api('/api/update/check', { method: 'POST' });
    toast(u.error ? `Couldn’t check: ${u.error}` : u.available ? `Version ${u.latest} is available. Open Settings to install it.` : 'You have the newest version', Boolean(u.error));
    load({ force: true });
  }, { icon: ICON.download });
  if (real) cmd('Download a copy of my data', () => ACTIONS['backup-download']({ disabled: false, isConnected: false }), { icon: ICON.download });
  cmd('Sign out', () => ACTIONS.logout(), { icon: ICON.signin });
  return items;
}

/** Ranks how well `q` matches `text`: whole words first, then substrings, then letters in order. 0 means no match. */
function matchScore(text, q) {
  const t = text.toLowerCase();
  if (!q) return 1;
  const i = t.indexOf(q);
  if (i === 0) return 300 - t.length / 100;
  if (i > 0) return (/\W/.test(t[i - 1]) ? 250 : 200) - i;
  let pos = -1;
  let gaps = 0;
  for (const ch of q) {
    const n = t.indexOf(ch, pos + 1);
    if (n < 0) return 0;
    gaps += n - pos - 1;
    pos = n;
  }
  return Math.max(1, 100 - gaps);
}

function openPalette(prefix = '') {
  if (!S.user || !$('#palette-root')) return;
  closeModal();
  S.pal = { q: prefix, active: 0, back: document.activeElement, items: paletteItems() };
  $('#palette-root').innerHTML = `<div class="pal-overlay" data-pal="overlay">
    <div class="pal" role="dialog" aria-modal="true" aria-label="Search and commands">
      <div class="pal-input">${ICON.search}<input id="pal-q" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" placeholder="Search pages, tools and tasks, or type > for commands" value="${esc(prefix)}"></div>
      <ul class="pal-list" id="pal-list" role="listbox" aria-label="Results"></ul>
      <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span><kbd>&gt;</kbd> commands</span></div>
    </div></div>`;
  renderPalette();
  const input = $('#pal-q');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function paletteResults() {
  const raw = S.pal.q;
  const cmdOnly = raw.startsWith('>');
  const q = (cmdOnly ? raw.slice(1) : raw).trim().toLowerCase();
  let list = S.pal.items.filter((it) => (cmdOnly ? it.kind === 'cmd' : true));
  if (!q && !cmdOnly) list = [...list.filter((it) => it.kind === 'page'), ...list.filter((it) => it.kind === 'cmd')];
  return list
    .map((it) => ({ it, score: matchScore(it.label, q) + (it.kind === 'page' ? 2 : it.kind === 'tool' ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (q ? b.score - a.score : 0))
    .slice(0, 40)
    .map((x) => x.it);
}

function renderPalette() {
  const list = $('#pal-list');
  if (!list) return;
  S.pal.results = paletteResults();
  S.pal.active = Math.min(S.pal.active, Math.max(0, S.pal.results.length - 1));
  list.innerHTML = S.pal.results.length
    ? S.pal.results.map((it, i) => `<li id="pal-${i}" role="option" aria-selected="${i === S.pal.active}" class="pal-item ${i === S.pal.active ? 'on' : ''}" data-pal="pick" data-i="${i}">
        <span class="pal-ico">${it.icon}</span><span class="pal-label">${esc(it.label)}</span><span class="pal-hint">${esc(it.hint)}</span>${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ''}</li>`).join('')
    : '<li class="pal-none">No matches. Type &gt; to see commands.</li>';
  $('#pal-q')?.setAttribute('aria-activedescendant', S.pal.results.length ? `pal-${S.pal.active}` : '');
  $(`#pal-${S.pal.active}`)?.scrollIntoView({ block: 'nearest' });
}

function closePalette({ restore = true } = {}) {
  const back = S.pal?.back;
  S.pal = null;
  const root = $('#palette-root');
  if (root) root.innerHTML = '';
  if (restore && back?.isConnected) back.focus?.({ preventScroll: true });
}

function runPalette(i) {
  const it = S.pal?.results?.[i];
  if (!it) return;
  closePalette({ restore: it.kind === 'cmd' });
  Promise.resolve(it.run()).catch((err) => toast(err.message, true));
}

// ── Chat, on its page or in the side panel ──────────────────────────────
/** The chat: which AI answers, the conversation picker, the messages and the composer. One copy is on screen at a time. */
function chatBody(d, { docked = false } = {}) {
  const c = S.chat;
  const e = d.engine;
  const options = c.threads.map((t) => `<option value="${t.id}" ${c.thread?.id === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  return `<div class="chat-bar">
      <label class="engine-pick">${engineLogo(e, 'xs')}<select class="input" id="engine-pick" data-action-change="pick-engine" aria-label="Which AI answers" ${c.streaming ? 'disabled' : ''}>${engineOptions(d)}</select></label>
      <select class="input" id="thread-pick" data-action-change="pick-thread" aria-label="Conversation" ${c.streaming ? 'disabled' : ''}>
        ${c.thread ? '' : '<option value="" selected>New conversation</option>'}${options}</select>
      <button class="btn ${docked ? 'icon-btn' : ''}" data-action="new-chat" title="New chat" aria-label="New chat" ${c.streaming ? 'disabled' : ''}>${ICON.plus}${docked ? '' : '<span class="hide-sm">New chat</span>'}</button>
      ${c.thread ? `<button class="btn icon-btn ghost" data-action="delete-chat" aria-label="Delete this conversation" title="Delete this conversation" ${c.streaming ? 'disabled' : ''}>${ICON.trash}</button>` : ''}
    </div>
    <section class="card chat">
      <div class="msgs" id="msgs" aria-live="polite"></div>
      <form class="composer" id="chat-form" data-form="chat">
        <textarea class="input" id="chat-input" name="text" rows="1" maxlength="8000" placeholder="Message ${esc(e.label)}…" aria-label="Message the assistant">${esc(c.draft)}</textarea>
        <button class="btn primary icon-btn" type="submit" data-role="send" aria-label="Send">${ICON.send}</button>
        <button class="btn icon-btn" type="button" data-action="stop-chat" data-role="stop" aria-label="Stop" hidden>${ICON.stop}</button>
      </form>
    </section>
    <p class="chat-foot">${d.engine_choice === 'auto' && d.engines.filter((x) => x.ready).length > 1 ? 'Automatic: a new conversation goes to the AI best suited to its first message, and stays with it.' : `Answers come from ${esc(e.label)} with ${esc(e.via)}${e.kind === 'api' ? ', and each message uses tokens' : ''}.`} ${e.tools === false ? 'It reads a snapshot of your dashboard but can’t change anything here.' : `It changes budgets, syncs tools or starts tasks only when you ask${e.kind === 'api' && d.settings.assistant_web_search ? '. Web search is on' : ''}.`} Replies are AI-generated and can be wrong. <a href="#privacy">What’s shared</a></p>`;
}

const chatOnScreen = () => S.page === 'assistant' || dockShown();
const dockShown = () => Boolean(S.dock) && S.page !== 'assistant' && Boolean(S.data) && !S.data.demo && Boolean(S.data.engine);

/** Draws the messages, loads conversations the first time, and sends a prompt that's waiting. */
function mountChat() {
  if (!S.data || S.data.demo || !S.data.engine || !$('#msgs')) return;
  renderMsgs();
  autosize($('#chat-input'));
  const ready = S.chat.loaded ? Promise.resolve() : loadThreads();
  if (S.chat.pending) {
    const prompt = S.chat.pending;
    S.chat.pending = null;
    ready.then(() => sendChat(prompt)).catch((err) => toast(err.message, true));
    return;
  }
  if (!S.chat.loaded) {
    ready
      .then(() => {
        if (!chatOnScreen()) return;
        if (!S.chat.thread && S.chat.threads[0] && !S.chat.streaming) return openThread(S.chat.threads[0].id);
        renderChat();
      })
      .catch((err) => toast(err.message, true));
  }
}

/** Redraws whichever chat is showing: the Assistant page, or the side panel. */
function renderChat() {
  if (S.page === 'assistant') renderPage();
  else renderDock();
}

/** The chat side panel (Ctrl+L), next to any page. */
function renderDock() {
  const el = $('#dock');
  if (!el) return;
  const show = dockShown();
  el.hidden = !show;
  document.body.classList.toggle('dock-open', show);
  $('[data-action="toggle-dock"]')?.setAttribute('aria-pressed', String(Boolean(S.dock)));
  if (!show) {
    el.innerHTML = '';
    return;
  }
  // Keep what you were typing, and where you were typing it, across a redraw.
  const ta = $('#dock #chat-input');
  if (ta?.value) S.chat.draft = ta.value;
  const refocus = document.activeElement === ta || (S.dockFocusUntil ?? 0) > Date.now();
  el.innerHTML = `<div class="dock-head"><span class="dock-title">${ICON.chat}Chat</span><span class="faint small">Ctrl+L</span>
      <a class="btn icon-btn ghost" href="#assistant" title="Open as a page" aria-label="Open the chat as a page">${ICON.external}</a>
      <button class="btn icon-btn ghost" data-action="toggle-dock" aria-label="Close the chat panel" title="Close (Ctrl+L)">${ICON.close}</button></div>
    <div class="dock-body">${chatBody(S.data, { docked: true })}</div>`;
  mountChat();
  if (refocus) {
    const input = $('#dock #chat-input');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function toggleDock(force) {
  if (S.data?.demo) return toast('The chat works with your real data. Exit the demo to use it.');
  if (!S.data?.engine) {
    location.hash = '#assistant';
    return;
  }
  S.dock = force ?? !S.dock;
  writeStore('acc-dock', S.dock ? '1' : null);
  // The conversation loads a moment later and redraws the panel; keep the cursor in the message box through that.
  S.dockFocusUntil = S.dock ? Date.now() + 4000 : 0;
  if (S.dock && S.page === 'assistant') location.hash = '#dashboard';
  renderDock();
}

// ── Sign-in & security ───────────────────────────────────────────────────
async function loadSecurity({ render = true } = {}) {
  S.secLoading = true;
  try {
    S.sec = await api('/api/security');
    S.secAt = Date.now();
    if (render && S.page === 'security') renderPage();
  } catch (err) {
    toast(err.message, true);
  } finally {
    S.secLoading = false;
  }
}

// ── Map ──────────────────────────────────────────────────────────────────
const MAP_HELPERS = {
  esc,
  ICON,
  fmtNum,
  rel,
  logo,
  limitMeters,
  accountLine,
  toolStatus,
  hueOf: (vendor) => HUE[vendor] ?? 'slate',
  mono: (t) => (t.kind === 'builtin' ? 'An' : MONO[t.adapter] ?? monogram(t.adapter_name ?? t.name)),
  kindLabel: (t) => KIND_LABEL[t.kind] ?? '',
  remember: writeStore,
};
S.map = { view: null, sel: null, layers: null, legend: readStore('acc-map-legend') === '1' };
const mapStats = () => (S.stats && S.stats.demo === S.demo ? S.stats : null);

function mountTheMap() {
  const el = $('#map');
  if (!el) return;
  // A different data set (demo on or off) starts from a fresh view.
  if (S.map.demo !== S.demo) S.map = { view: null, sel: null, layers: S.map.layers, legend: S.map.legend, demo: S.demo };
  S.mapInst = mountMap(el, { data: S.data, stats: mapStats(), state: S.map, h: MAP_HELPERS });
  const list = $('#map-list');
  if (list) list.innerHTML = mapListHtml(S.mapInst.model(), MAP_HELPERS);
}

function refreshMap() {
  if (!S.mapInst || !$('#map')) return;
  S.mapInst.update(S.data, mapStats());
  const list = $('#map-list');
  if (list) list.innerHTML = mapListHtml(S.mapInst.model(), MAP_HELPERS);
}

// ── Automations ──────────────────────────────────────────────────────────
const MODE_LABEL = { task: 'Assistant task', team: 'AI team', compare: 'Ask all' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const scheduleText = (s) => (s.every === 'hour' ? `Every hour at :${s.at.slice(3)}` : s.every === 'day' ? `Every day at ${s.at}` : s.every === 'weekday' ? `Every weekday at ${s.at}` : `Every ${WEEKDAYS[s.day]} at ${s.at}`);
const AUTO_TEMPLATES = [
  { name: 'Weekly usage report', mode: 'task', schedule: { every: 'week', at: '09:00', day: 1 },
    prompt: 'Summarize last week’s AI usage by tool: tokens, cost where reported, and plan limits. Flag anything close to a budget or limit, and suggest where to cut back.' },
  { name: 'Morning briefing', mode: 'task', schedule: { every: 'weekday', at: '08:30' },
    prompt: 'Give me a short briefing: what ran since yesterday, anything that failed and why, and what is scheduled next. Five bullets at most.' },
  { name: 'Second opinions', mode: 'compare', schedule: { every: 'week', at: '16:00', day: 5 },
    prompt: 'What are three practical ways I could get more out of the AI tools I use for coding? Be concrete and skip the obvious.' },
  { name: 'Project check-up', mode: 'team', schedule: { every: 'week', at: '17:00', day: 5 },
    prompt: 'Review this project for out-of-date docs, obvious bugs and leftover TODOs. Fix the small, safe things and list the rest.' },
];

/** The dashboard's Up next: queued and scheduled tasks, then the next automation runs. */
function upNext(d) {
  const autos = (d.automations ?? []).filter((a) => a.enabled && a.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at));
  const tasks = d.upcoming.slice(0, 6);
  const rows = [
    ...tasks.map((t) => taskRow(t, { compact: true })),
    ...autos.slice(0, Math.max(0, 6 - tasks.length)).map((a) => `<a class="row" href="#automations"><div class="status-ico s-scheduled">${ICON.repeat}</div>
      <div class="row-main"><div class="row-title">${esc(a.name)}</div><div class="row-sub">${esc(a.schedule_text)} · ${esc(a.mode_label)}</div></div>
      <div class="row-time" title="${esc(when(a.next_run_at))}">${esc(rel(a.next_run_at))}</div></a>`),
  ];
  return rows.length ? `<div class="rows">${rows.join('')}</div>` : emptyBlock('Nothing is scheduled', 'Queued tasks and your next automation runs appear here.', !d.demo ? '<button class="btn small" data-action="new-automation">New automation</button>' : '');
}

function autoCard(a) {
  const d = S.data;
  const dis = d.demo ? 'disabled' : '';
  const last = a.last_task;
  const lastStatus = last ? TASK_STATUS[last.status] : null;
  const confirm = S.confirmAuto === a.id;
  return `<section class="card auto ${a.enabled ? '' : 'off'}">
    <div class="auto-head">
      <span class="auto-ico">${ICON[a.mode === 'team' ? 'team' : a.mode === 'compare' ? 'chat' : 'repeat']}</span>
      <div class="min0"><div class="row-title">${esc(a.name)}</div><div class="row-sub">${esc(a.schedule_text)} · ${esc(a.mode_label)}</div></div>
      <label class="switch mini" title="${a.enabled ? 'On' : 'Paused'}"><input type="checkbox" data-auto-toggle="${a.id}" ${a.enabled ? 'checked' : ''} ${dis} aria-label="${esc(a.name)} is ${a.enabled ? 'on' : 'paused'}"></label>
    </div>
    <p class="auto-prompt">${esc(a.prompt)}</p>
    ${a.folder ? `<div class="faint small auto-folder">${ICON.folder}<code>${esc(a.folder)}</code></div>` : ''}
    <dl class="auto-meta">
      <div><dt>Next run</dt><dd>${a.enabled && a.next_run_at ? `<span title="${esc(when(a.next_run_at))}">${esc(when(a.next_run_at))}</span>` : '<span class="faint">Paused</span>'}</dd></div>
      <div><dt>Last run</dt><dd>${last ? `<button class="link" data-action="open-task" data-id="${last.id}">${esc(lastStatus?.label ?? last.status)} · ${esc(rel(a.last_run_at))}</button>` : a.last_run_at ? esc(rel(a.last_run_at)) : '<span class="faint">Not yet</span>'}</dd></div>
    </dl>
    ${a.last_error ? `<div class="callout warn small">${esc(a.last_error)}</div>` : ''}
    <div class="auto-actions">
      ${confirm
        ? `<span class="small err-text">Delete this automation? Tasks it already ran stay.</span><button class="btn small danger" data-action="confirm-delete-automation" data-id="${a.id}">Delete</button><button class="btn small ghost" data-action="cancel-delete-automation">Keep</button>`
        : `<button class="btn small" data-action="run-automation" data-id="${a.id}" ${dis || (d.engine ? '' : 'disabled')}>${ICON.play}Run now</button>
           <button class="btn small ghost" data-action="edit-automation" data-id="${a.id}" ${dis}>${ICON.pencil}Edit</button>
           <button class="btn small ghost icon-btn" data-action="delete-automation" data-id="${a.id}" aria-label="Delete ${esc(a.name)}" title="Delete" ${dis}>${ICON.trash}</button>`}
    </div>
  </section>`;
}

function openAutomation(a = {}) {
  const s = a.schedule ?? { every: 'day', at: '09:00', day: 1 };
  const mode = a.mode ?? 'task';
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
  openPanel(a.id ? 'Edit automation' : 'New automation', `
    <form class="form" data-form="automation" ${a.id ? `data-id="${a.id}"` : ''}>
      <div class="field"><label for="au-name">Name</label><input class="input" id="au-name" name="name" maxlength="80" required value="${esc(a.name ?? '')}" placeholder="Weekly usage report"></div>
      <div class="field"><label for="au-prompt">What should it do each time?</label><textarea class="input" id="au-prompt" name="prompt" rows="5" maxlength="4000" required placeholder="Summarize last week’s AI usage and flag anything close to a limit.">${esc(a.prompt ?? '')}</textarea>
        <span class="help">Write it as you would for a one-off task. The AI starts fresh each run. Each run sends this prompt, and any dashboard data the AI asks for, to the AI it goes to, while you’re away.</span></div>
      <div class="field"><label>How it runs</label>
        <div class="choice-row" role="radiogroup">${Object.entries(MODE_LABEL).map(([k, v]) => `<label class="choice"><input type="radio" name="mode" value="${k}" ${mode === k ? 'checked' : ''} data-auto-mode><span><b>${v}</b><span class="faint small block">${k === 'task' ? 'The best AI for it works alone' : k === 'team' ? 'Plan, build, review, fix' : 'Every AI answers, then a merge'}</span></span></label>`).join('')}</div></div>
      <div class="field" id="au-folder-field" ${mode === 'team' ? '' : 'hidden'}><label for="au-folder">Folder to work in (optional)</label>
        <div class="folder-row"><input class="input" id="au-folder" name="folder" autocomplete="off" placeholder="Leave empty for a text result" value="${esc(a.folder ?? '')}"><button class="btn" type="button" data-action="pick-folder" data-target="au-folder">${ICON.folder}Choose…</button></div>
        <span class="help">With a folder, the builder can change files in it on every run. Use a folder you have a copy of, such as a git project.</span></div>
      <div class="form-row">
        <div class="field"><label for="au-every">Repeats</label><select class="input" id="au-every" name="every" data-auto-every>
          ${opt('hour', 'Every hour', s.every)}${opt('day', 'Every day', s.every)}${opt('weekday', 'Every weekday (Mon–Fri)', s.every)}${opt('week', 'Once a week', s.every)}</select></div>
        <div class="field" id="au-day-field" ${s.every === 'week' ? '' : 'hidden'}><label for="au-day">On</label><select class="input" id="au-day" name="day">${WEEKDAYS.map((w, i) => opt(i, w, s.day ?? 1)).join('')}</select></div>
        <div class="field"><label for="au-at" id="au-at-label">${s.every === 'hour' ? 'Minutes past the hour' : 'At'}</label><input class="input" id="au-at" name="at" type="time" required value="${esc(s.at)}"></div>
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">${a.id ? 'Save changes' : `${ICON.repeat}Save automation`}</button>${a.id ? '' : '<span class="faint small">It starts at the next scheduled time. Use Run now to try it first.</span>'}</div>
      <div class="error-text" data-error></div>
    </form>`, { center: true });
  $('#au-name')?.focus();
}

function welcome() {
  const local = S.local;
  const item = (l) => {
    const state = !l.installed ? 'Not installed' : l.signed_in ? 'Installed and signed in' : 'Installed, not signed in';
    return `<div class="welcome-app">${logo({ vendor: l.vendor, name: l.name, adapter: l.id }, 'sm')}<div class="min0"><b>${esc(l.name)}</b><span class="faint small block">${esc(state)} · ${esc(l.account_kind)}</span></div>
      ${l.connected_id ? `<a class="btn small" href="#tool-${l.connected_id}">Open</a>` : `<button class="btn small ${l.installed ? 'primary' : ''}" data-action="connect-local" data-id="${esc(l.id)}">Connect</button>`}</div>`;
  };
  return `<section class="hero welcome">
    <div class="eyebrow">Welcome, ${esc(S.user.username)}</div>
    <h2>Bring your AI tools together</h2>
    <p>Connect the AI apps you already use with your own account. No API keys needed. Their usage, sessions and limits show up here, and you can ask them to do things from this app.</p>
    <div class="welcome-apps">${local === null ? '<div class="faint small"><span class="spin"></span> Looking for AI apps on this computer…</div>' : local.map(item).join('')}</div>
    <div class="form-actions"><button class="btn" data-action="add-tool">${ICON.key}Connect with an API key or track a tool</button><button class="btn ghost" data-action="toggle-demo">Explore with demo data</button></div>
  </section>`;
}

function assistantSetup(d) {
  return `<section class="hero welcome">
    <div class="eyebrow">Assistant</div>
    <h2>Choose an AI for the assistant</h2>
    <p>The assistant can answer questions about your tools and tasks, change budgets, and run tasks in the background with live progress. Connect an app signed in with your own account, or add a Claude API key.</p>
    <div class="welcome-apps">${d.engines.map((e) => `<div class="welcome-app">${engineLogo(e, 'sm')}<div class="min0"><b>${esc(e.label)}</b><span class="faint small block">${esc(e.ready ? e.via : e.reason)}</span></div>
      ${e.kind === 'api' ? '<a class="btn small" href="#settings">Add key</a>' : e.integration_id ? `<a class="btn small primary" href="#tool-${e.integration_id}">Set up</a>` : `<button class="btn small primary" data-action="connect-local" data-id="${e.id}">Connect</button>`}</div>`).join('')}</div>
  </section>`;
}

function manageSection(t) {
  const confirm = S.confirmRemove === t.id;
  return `<section class="card manage">
    <div class="card-head">${ICON.gear}<h3>Manage</h3></div>
    <div class="manage-grid">
      ${t.engine ? `<form class="form" data-form="engine-model" data-adapter="${esc(t.adapter)}">
        <div class="field"><label for="t-model">Model for runs from this app</label><input class="input" id="t-model" name="model" maxlength="80" autocomplete="off" value="${esc(t.engine.model ?? '')}" placeholder="${esc(t.adapter_name)}’s default">
          <span class="help">Used for the chat, background tasks, the AI team and the summary. For example: ${esc(t.engine.model_hint ?? 'a model name')}. A lighter model uses less of your plan.</span></div>
        <div class="form-actions"><button class="btn" type="submit">Save model</button></div><div class="error-text" data-error></div></form>` : ''}
      ${t.kind === 'builtin' ? '' : `<form class="form" data-form="budget" data-id="${t.id}">
        <div class="field"><label for="t-budget">Monthly budget ($)</label><input class="input" id="t-budget" name="budget_usd" type="number" min="0" step="0.01" value="${esc(t.budget_usd ?? '')}" placeholder="None"><span class="help">${t.kind === 'local' ? 'Plan usage has no per-token price, so a budget only applies if you log costs.' : 'Drives the limit bar and budget alerts.'}</span></div>
        <div class="form-actions"><button class="btn" type="submit">Save budget</button></div><div class="error-text" data-error></div></form>`}
      ${t.kind === 'api' ? `<form class="form" data-form="secret" data-id="${t.id}">
        <div class="field"><label for="t-secret">Replace key</label><input class="input" id="t-secret" name="secret" type="password" autocomplete="off" required><span class="help">It is tested before it replaces the saved key.</span></div>
        <div class="form-actions"><button class="btn" type="submit">Test and save</button></div><div class="error-text" data-error></div></form>` : ''}
      ${t.capabilities.usage === 'manual' ? `<form class="form" data-form="manual-usage" data-id="${t.id}">
        <div class="form-row"><div class="field"><label for="m-day">Day (UTC)</label><input class="input" id="m-day" name="day" type="date" value="${utcToday()}" required></div>
          <div class="field"><label for="m-cost">Cost ($)</label><input class="input" id="m-cost" name="cost_usd" type="number" min="0" step="0.01"></div></div>
        <div class="form-row"><div class="field"><label for="m-req">Requests</label><input class="input" id="m-req" name="requests" type="number" min="0"></div>
          <div class="field"><label for="m-in">Input tokens</label><input class="input" id="m-in" name="input_tokens" type="number" min="0"></div>
          <div class="field"><label for="m-out">Output tokens</label><input class="input" id="m-out" name="output_tokens" type="number" min="0"></div></div>
        <span class="help">Saving the same day again replaces that day’s figures. For a subscription, log the plan price on the day it renews.</span>
        <div class="form-actions"><button class="btn" type="submit">Save usage</button></div><div class="error-text" data-error></div></form>` : ''}
      ${t.kind === 'builtin' || t.kind === 'local' ? '' : `<div class="form" id="ingest-section"><label class="field-label">Report tasks from your scripts</label>${ingestHelp(t)}
        <div class="form-actions"><button class="btn" data-action="rotate-token" data-id="${t.id}">Create new ingest token</button></div></div>`}
    </div>
    <div class="form-actions manage-actions">
      <button class="btn" data-action="toggle-tool" data-id="${t.id}" data-enabled="${t.enabled ? 0 : 1}">${t.enabled ? 'Turn off' : 'Turn on'}</button>
      ${confirm ? `<span class="callout err inline">Remove ${esc(t.name)}? Its usage history${t.kind === 'local' ? ' and sessions' : ', tasks and ingest token'} are deleted here. ${t.kind === 'local' ? `${esc(t.adapter_name)} itself stays installed and signed in.` : 'This can’t be undone.'}</span>
        <button class="btn danger" data-action="confirm-remove" data-id="${t.id}">Remove</button><button class="btn ghost" data-action="cancel-remove">Cancel</button>`
        : `<button class="btn danger" data-action="remove-tool" data-id="${t.id}">Remove</button>`}
    </div>
  </section>`;
}

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

function chartBase(text, grid) {
  return {
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
}

const AFTER = {
  security() {
    if (S.data?.demo || S.secLoading || (S.sec && Date.now() - S.secAt < 20_000)) return;
    loadSecurity();
  },
  map() {
    mountTheMap();
    const fresh = S.stats && S.stats.demo === S.demo && Date.now() - S.statsAt < 60_000;
    if (fresh || S.statsLoading) return;
    S.statsLoading = true;
    api(S.demo ? '/api/demo/stats' : '/api/stats')
      .then((r) => {
        S.stats = { ...r, demo: S.demo };
        S.statsAt = Date.now();
        if (S.page === 'map') refreshMap();
      })
      .catch(() => {
        /* the map still works without routing counts */
      })
      .finally(() => (S.statsLoading = false));
  },
  privacy() {
    const fresh = S.privacyInfo && Date.now() - S.privacyAt < 30_000;
    if (fresh || S.privacyLoading) return;
    S.privacyLoading = true;
    api('/api/privacy')
      .then((r) => {
        S.privacyInfo = r;
        S.privacyAt = Date.now();
        if (S.page === 'privacy' && !$('#er-pass')) renderPage();
      })
      .catch((err) => toast(err.message, true))
      .finally(() => (S.privacyLoading = false));
  },
  stats() {
    const fresh = S.stats && S.stats.demo === S.demo && Date.now() - S.statsAt < 60_000;
    if (!fresh) {
      if (S.statsLoading) return;
      S.statsLoading = true;
      api(S.demo ? '/api/demo/stats' : '/api/stats')
        .then((r) => {
          S.stats = { ...r, demo: S.demo };
          S.statsAt = Date.now();
          if (S.page === 'stats') renderPage();
        })
        .catch((err) => toast(err.message, true))
        .finally(() => (S.statsLoading = false));
      if (!S.stats || S.stats.demo !== S.demo) return;
    }
    if (!window.Chart) return;
    const { series: colors, text, grid } = palette();
    const st = S.stats;
    if ($('#ch-share') && st.share.length) {
      S.charts.push(new window.Chart($('#ch-share'), {
        type: 'doughnut',
        data: { labels: st.share.map((s) => s.name), datasets: [{ data: st.share.map((s) => s.tokens), backgroundColor: st.share.map((_, i) => colors[i % colors.length]), borderWidth: 0, hoverOffset: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtNum(c.raw)}` } } } },
      }));
    }
    if ($('#ch-daily')) {
      const vals = st.daily.map((x) => x.tokens);
      const avg = vals.map((_, i) => {
        const win = vals.slice(Math.max(0, i - 6), i + 1).filter((v) => v != null);
        return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
      });
      const base = chartBase(text, grid);
      S.charts.push(new window.Chart($('#ch-daily'), {
        type: 'bar',
        data: { labels: st.daily.map((x) => shortDay(x.day)), datasets: [
          { type: 'line', label: '7-day average', data: avg, borderColor: colors[2], borderWidth: 2, pointRadius: 0, tension: 0.35, spanGaps: true },
          { label: 'Tokens', data: vals, backgroundColor: colors[0], borderRadius: 3, maxBarThickness: 14 },
        ] },
        options: { ...base, plugins: { ...base.plugins, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? 'not reported' : fmtNum(c.raw)}` } } },
          scales: { x: { ...base.scales.x, stacked: false }, y: { ...base.scales.y, stacked: false, ticks: { color: text, callback: (v) => fmtNum(v) } } } },
      }));
    }
  },
  dashboard() {
    const tools = S.data.tools.filter((t) => t.kind !== 'builtin');
    if ((!tools.length || !S.data.engine) && !S.demo && S.local === null) loadLocal().then(() => S.page === 'dashboard' && renderPage());
  },
  assistant() {
    mountChat();
  },
  tool() {
    const series = S.data.usage.series.find((x) => x.id === S.toolId);
    if (!window.Chart || !series || !$('#ch-tool')) return;
    const { series: colors, text, grid } = palette();
    const base = chartBase(text, grid);
    S.charts.push(new window.Chart($('#ch-tool'), {
      type: 'bar',
      data: { labels: S.data.usage.days.map(shortDay), datasets: [{ label: 'Tokens', data: series.tokens, backgroundColor: colors[0], borderRadius: 3, maxBarThickness: 16 }] },
      options: { ...base, plugins: { ...base.plugins, tooltip: { callbacks: { label: (c) => `Tokens: ${c.raw == null ? 'not reported' : fmtNum(c.raw)}` } } },
        scales: { ...base.scales, y: { ...base.scales.y, ticks: { color: text, callback: (v) => fmtNum(v) } } } },
    }));
  },
  usage() {
    if (!window.Chart || !S.data.usage.series.length) return;
    const { series, text, grid } = palette();
    const labels = S.data.usage.days.map(shortDay);
    const base = chartBase(text, grid);
    const sets = S.data.usage.series;
    if ($('#ch-tokens')) {
      S.charts.push(new window.Chart($('#ch-tokens'), {
        type: 'bar',
        data: { labels, datasets: sets.map((s, i) => ({ label: s.name, data: s.tokens, backgroundColor: series[i % series.length], borderRadius: 2, maxBarThickness: 18 })) },
        options: { ...base, plugins: { ...base.plugins, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? 'not reported' : fmtNum(c.raw)}` } } },
          scales: { ...base.scales, y: { ...base.scales.y, ticks: { color: text, callback: (v) => fmtNum(v) } } } },
      }));
      $('#lg-tokens').innerHTML = sets.map((s, i) => `<span><i style="background:${series[i % series.length]}"></i>${esc(s.name)}</span>`).join('');
    }
    if ($('#ch-cost')) {
      const costSets = sets.map((s, i) => ({ s, i })).filter(({ s }) => s.cost.some((v) => v != null));
      S.charts.push(new window.Chart($('#ch-cost'), {
        type: 'bar',
        data: { labels, datasets: costSets.map(({ s, i }) => ({ label: s.name, data: s.cost, backgroundColor: series[i % series.length], borderRadius: 2, maxBarThickness: 18 })) },
        options: { ...base, plugins: { ...base.plugins, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? 'not reported' : fmtUsd(c.raw)}` } } },
          scales: { ...base.scales, y: { ...base.scales.y, ticks: { color: text, callback: (v) => `$${v}` } } } },
      }));
    }
  },
};

// ── Modals ───────────────────────────────────────────────────────────────
function openPanel(title, body, { center = false, wide = false, focus = true } = {}) {
  if (!$('#modal-root .panel')) S.returnFocus = document.activeElement;
  $('#modal-root').innerHTML = `<div class="overlay ${center ? 'center' : ''}" data-action="overlay">
    <div class="panel ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="panel-head"><h2>${esc(title)}</h2><button class="btn icon-btn ghost" data-action="close" aria-label="Close">${ICON.close}</button></div>
      <div class="panel-body">${body}</div></div></div>`;
  if (focus) $('#modal-root .panel-body input, #modal-root .panel-body button')?.focus();
}
function closeModal() {
  const onClose = S.onModalClose;
  S.onModalClose = null;
  onClose?.();
  const hadPanel = Boolean($('#modal-root .panel'));
  $('#modal-root').innerHTML = '';
  const back = S.returnFocus;
  S.returnFocus = null;
  if (hadPanel && back?.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
  S.add = null;
  S.openTask = null;
}

/** Keeps an open task panel current while the task changes, such as an AI team moving to its next stage. */
function refreshOpenTask() {
  const o = S.openTask;
  if (!o || !$('#modal-root .panel')) return;
  const t = S.data?.tasks.find((x) => x.id === o.id);
  if (!t) return;
  const sig = `${t.status}|${t.updated_at}|${t.progress}`;
  if (sig !== o.sig) openTask(t.id, { refresh: true });
}

function ingestHelp(t, token) {
  const url = `${location.origin}/api/ingest/${t.id}`;
  const example = `curl -X POST ${url} \\
  -H "Authorization: Bearer ${token ?? 'YOUR_INGEST_TOKEN'}" \\
  -H "Content-Type: application/json" \\
  -d '{"task": {"id": "run-42", "name": "Nightly report", "status": "running", "progress": 40}}'`;
  return `${token ? `<div class="field"><label>Ingest token (shown once)</label><div class="secret-box"><code id="ingest-token">${esc(token)}</code><button class="btn" data-action="copy" data-target="ingest-token">Copy</button></div><span class="help">Store it in your script’s environment. Creating a new token stops the old one working.</span></div>` : ''}
    <p class="muted small">Send task updates to <code>${esc(url)}</code>. Status is one of running, queued, scheduled, completed or failed. Send <code>progress</code> with running tasks so the app can estimate when they’ll finish. You can also send <code>usage</code> rows; each row sets that day’s totals.</p>
    <pre class="code" id="ingest-example">${esc(example)}</pre>`;
}

function taskPrompt(t) {
  const what = t.kind === 'session' ? 'what it was about and how much it used'
    : t.status === 'failed' ? 'why it failed and what I can do about it'
      : t.status === 'running' ? 'how it is going and when it should finish'
        : t.status === 'completed' ? 'what it did and anything I should follow up on'
          : 'when it will run and whether anything is blocking it';
  return `Look at task #${t.id} (“${t.name}” on ${t.tool_name}) and tell me ${what}.`;
}

async function openTask(id, { refresh = false } = {}) {
  const t = S.data.tasks.find((x) => x.id === Number(id));
  if (!t) return;
  const scroll = refresh ? $('#modal-root .panel-body')?.scrollTop ?? 0 : 0;
  const open = [...document.querySelectorAll('#modal-root .tl-out details[open]')].map((el) => el.closest('.tl-out').id);
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const at = (iso) => iso && `${esc(when(iso))} <span class="faint">(${esc(rel(iso))})</span>`;
  const e = etaInfo(t);
  const session = t.kind === 'session';
  const mine = Boolean(t.runner);
  const canAsk = !S.data.demo && S.data.engine;
  const st = session ? SESSION_STATUS[t.status] ?? SESSION_STATUS.completed : TASK_STATUS[t.status];
  const controls = session
    ? `<p class="muted small">This is a ${esc(t.tool_name)} session on this computer, read from its logs. Open ${esc(t.tool_name)} to continue it.</p>`
    : mine && !S.data.demo
      ? `<div class="form-actions">${t.controls.includes('cancel') ? `<button class="btn danger" data-action="task-cancel" data-id="${t.id}">Cancel task</button>` : ''}
        ${t.controls.includes('retry') ? `<button class="btn" data-action="task-retry" data-id="${t.id}">Run again</button>` : ''}</div>`
      : `<div class="form-actions"><button class="btn" disabled>Pause</button><button class="btn" disabled>Cancel</button><button class="btn" disabled>Restart</button></div>
       <p class="faint small">${esc(t.tool_name)} doesn’t offer task controls through this app. Stop or restart the task where it runs.</p>`;
  openPanel(t.name, `
    <div class="pill-row">${pill(st.pill, st.label)}${session ? '<span class="tag">Session</span>' : ''}${mine ? `<span class="tag accent">Run by ${esc(t.runner_label)}</span>` : ''}
      ${t.follows ? `<span class="faint small">Follows up on ${S.data.tasks.some((x) => x.id === t.follows.id) ? `<button class="link" data-action="open-task" data-id="${t.follows.id}">${esc(t.follows.name)}</button>` : `“${esc(t.follows.name)}”`}</span>` : ''}</div>
    ${t.error ? `<div class="callout err">${esc(t.error)}</div>` : ''}
    ${t.step && t.status === 'running' ? `<p class="now-step"><span class="faint">Now:</span> ${esc(t.step)}</p>` : ''}
    ${t.progress != null ? `<div class="meter flat"><div class="meter-top"><span class="muted">Progress</span><b>${Math.round(t.progress)}%</b></div>${bar(t.progress, t.stalled ? 'err' : 'info')}</div>` : ''}
    ${e ? `<div class="callout ${e.cls === 'err' ? 'err' : e.cls === 'warn' ? 'warn' : 'info'}"><b>${esc(e.text)}</b>${e.basis ? `, ${esc(e.basis)}` : ''}.</div>` : ''}
    <dl class="detail-grid">
      ${row('Tool', esc(t.tool_name))}
      ${row('Started', at(t.started_at))}
      ${row('Expected finish', t.status === 'running' && t.eta_at && `${at(t.eta_at)}<div class="faint small">${esc(ETA_BASIS[t.eta_source] ?? '')}</div>`)}
      ${row('Usually takes', t.typical_ms && esc(dur(t.typical_ms)))}
      ${row('Scheduled for', t.scheduled_for && esc(when(t.scheduled_for)))}
      ${row(session ? 'Last active' : 'Finished', (session ? t.updated_at : t.finished_at) && esc(when(session ? t.updated_at : t.finished_at)))}
      ${row(session ? 'Length' : 'Took', (session ? t.started_at : t.finished_at && t.started_at) && esc(dur(Date.parse(session ? t.updated_at : t.finished_at) - Date.parse(t.started_at))))}
      ${session ? '' : row('Last update', esc(when(t.updated_at)))}
    </dl>
    ${t.team ? teamTimeline(t) : ''}
    <div class="section" id="task-detail">${t.description ? `<h4>${t.team ? 'Goal' : mine ? 'Instructions' : session ? 'Details' : 'Description'}</h4><p class="pre">${esc(t.description)}</p>` : ''}</div>
    ${canAsk ? `<div class="form-actions"><button class="btn" data-action="ask-task" data-id="${t.id}">${ICON.chat}Ask the assistant about this</button></div>` : ''}
    ${mine && !S.data.demo && t.controls.includes('follow_up') ? followUpForm(t) : ''}
    <div class="section"><h4>Controls</h4>${controls}</div>`, { focus: !refresh });
  S.openTask = { id: t.id, sig: `${t.status}|${t.updated_at}|${t.progress}` };
  const restore = () => {
    for (const id of open) document.querySelector(`#${id} details`)?.setAttribute('open', '');
    const body = $('#modal-root .panel-body');
    if (body && refresh) body.scrollTop = scroll;
  };
  if (S.data.demo || (!t.has_result && !t.team)) return restore();
  try {
    const detail = await api(`/api/tasks/${t.id}`);
    if (S.openTask?.id !== t.id) return;
    for (const s of detail.detail?.stages ?? []) {
      const box = document.getElementById(`tl-out-${s.key}`);
      if (box && s.output) box.innerHTML = `<details><summary>What ${esc(s.engine_label)} wrote</summary><div class="md tl-md">${md(s.output)}</div></details>`;
    }
    const box = $('#task-detail');
    if (box && detail.result) {
      box.insertAdjacentHTML('beforebegin', `<div class="section"><h4>Result${t.runner ? ` <span class="tag ai-tag" title="Written by an AI model. Check anything important before relying on it.">AI-generated · ${esc(t.runner_label)}</span>` : ''}</h4>
        <div class="result md" id="task-result">${md(detail.result)}</div>
        <pre id="task-result-raw" hidden>${esc(detail.result)}</pre>
        <div class="form-actions"><button class="btn small" data-action="copy" data-target="task-result-raw">Copy result</button>
          <button class="btn small" data-action="save-result" data-name="${esc(t.name)}">${ICON.download}Save as file</button></div></div>`);
    }
    restore();
  } catch (err) {
    if (!refresh) toast(err.message, true);
  }
}

/** Continue a finished task: the new one runs the same way and sees this one's request and result. */
function followUpForm(t) {
  const how = t.team?.mode === 'compare' ? 'an Ask all task' : t.team ? `an AI team task${t.team.folder ? ' in the same folder' : ''}` : 'a task';
  const hint = t.status === 'failed'
    ? 'Say what to change, for example a simpler approach or more detail on the goal.'
    : t.team?.folder ? 'For example: “Now add tests for the new code.”' : 'For example: “Make it shorter” or “Turn this into a checklist.”';
  return `<form class="section follow-form" data-form="follow-up" data-id="${t.id}">
    <h4>${t.status === 'failed' ? 'Try again differently' : 'Continue from here'}</h4>
    <div class="follow-row"><textarea class="input" id="fu-text" name="text" rows="2" maxlength="2000" required placeholder="${esc(hint)}" aria-label="What should happen next"></textarea>
      <button class="btn primary" type="submit">${ICON.send}<span>Continue</span></button></div>
    <span class="help">Starts ${how} that builds on this ${t.status === 'failed' ? 'attempt' : 'result'}.</span>
    <div class="error-text" data-error></div>
  </form>`;
}

const STAGE_STATE = {
  pending: { icon: 'clock', text: 'Waiting' },
  running: { icon: null, text: 'Working…' },
  done: { icon: 'check', text: 'Done' },
  failed: { icon: 'x', text: 'Failed' },
  skipped: { icon: 'chevron', text: 'Skipped' },
};

/** The stages of an AI team task: who did each one, and how it went. */
function teamTimeline(t) {
  return `<div class="section"><h4>${ICON.team} ${t.team.mode === 'compare' ? 'Every AI’s answer' : 'The team'}${t.team.folder ? ` · working in <code>${esc(t.team.folder)}</code>` : ''}</h4>
    <ol class="timeline">${t.team.stages.map((s) => {
      const st = STAGE_STATE[s.status] ?? STAGE_STATE.pending;
      const took = s.started_at && s.finished_at ? ` · ${dur(Date.parse(s.finished_at) - Date.parse(s.started_at))}` : '';
      const verdict = s.status === 'done' && s.verdict ? (s.verdict === 'approve' ? 'Approved' : 'Asked for changes') : st.text;
      return `<li class="tl ${s.status}">
        <span class="tl-dot">${st.icon ? ICON[st.icon] : '<span class="spin"></span>'}</span>
        <div class="min0">
          <div class="tl-head">${engineById(s.engine, s.engine_label)}<b>${esc(s.label)}</b><span class="faint">${esc(s.engine_label)}</span><span class="tl-meta ${s.verdict === 'changes' ? 'warn-text' : ''}">${esc(verdict)}${esc(took)}</span></div>
          ${s.note ? `<div class="faint small">${esc(s.note)}</div>` : ''}${s.error ? `<div class="err-text small">${esc(s.error)}</div>` : ''}
          <div class="tl-out" id="tl-out-${esc(s.key)}"></div>
        </div></li>`;
    }).join('')}</ol></div>`;
}

function openTeamTask(preset = {}) {
  const lineup = S.data.team?.lineup;
  openPanel('New AI team task', `
    <form class="form" data-form="team-task">
      <p class="muted small">Your connected AIs split the work: one plans, one builds, another reviews, and if the review finds problems one debugs and the builder fixes them. It runs in the background with live progress on the Tasks page, and the result is saved on the task.</p>
      <div class="field"><label for="tt-goal">What should the team make?</label><textarea class="input" id="tt-goal" name="goal" rows="5" maxlength="4000" required placeholder="A one-page landing page for a dog-walking business: headline, three services with prices, and a contact section.">${esc(preset.goal ?? '')}</textarea></div>
      <div class="field"><label for="tt-folder">Folder to work in (optional)</label>
        <div class="folder-row"><input class="input" id="tt-folder" name="folder" autocomplete="off" placeholder="Leave empty for a text result, or paste a folder path" value="${esc(preset.folder ?? '')}"><button class="btn" type="button" data-action="pick-folder">${ICON.folder}Choose…</button></div>
        <span class="help">With a folder, the builder can create and change files in it, and the planner, reviewer and debugger can read them. None of them run shell commands, except Codex inside its own sandbox. Use a folder you have a copy of, such as a git project.</span></div>
      <div><div class="lineup-label">Who does what</div><div id="tt-lineup">${lineupStrip(lineup)}</div></div>
      <div class="form-actions"><button class="btn primary" type="submit">${ICON.play}Start team task</button><a class="btn ghost" href="#settings" data-action="close">Change roles</a></div>
      <div class="error-text" data-error></div>
    </form>`, { center: true });
  (preset.goal ? $('#tt-folder') : $('#tt-goal'))?.focus();
}

let lineupTimer = 0;
/** With a folder, only apps on this computer can take part, so the lineup can change. */
function refreshLineup() {
  clearTimeout(lineupTimer);
  lineupTimer = setTimeout(async () => {
    const box = $('#tt-lineup');
    if (!box) return;
    const folder = $('#tt-folder')?.value.trim();
    try {
      const r = await api(`/api/team${folder ? '?folder=1' : ''}`);
      box.innerHTML = r.lineup ? lineupStrip(r.lineup) : '<p class="fine err-text">Working in a folder needs an AI app on this computer: Claude Code, Codex, Gemini CLI, GitHub Copilot or Cursor.</p>';
    } catch {
      /* keep the last lineup */
    }
  }, 250);
}

async function startedTeam(r) {
  const l = r.lineup ?? {};
  const name = (id) => S.data.engines.find((e) => e.id === id)?.label ?? id;
  toast(r.mode === 'compare'
    ? `Asking ${l.answering?.length ?? 0} AIs: ${(l.answering ?? []).map(name).join(', ')}`
    : `Team started: ${name(l.planner)} plans, ${name(l.builder)} builds, ${name(l.reviewer)} reviews`);
  S.taskFilter = 'all';
  await load({ force: true });
  openTask(r.id);
}

function openNewTask(preset = {}) {
  const e = S.data.engine;
  openPanel('New assistant task', `
    <form class="form" data-form="claude-task">
      <p class="muted small">${esc(e.label)} works on this in the background and reports its progress, so you can see how far along it is and when it should finish. The result is saved on the task. It can read your dashboard data.</p>
      <div class="field"><label for="ct-name">Name</label><input class="input" id="ct-name" name="name" maxlength="80" required value="${esc(preset.name ?? '')}" placeholder="Monthly usage report"></div>
      <div class="field"><label for="ct-ins">What should it do?</label><textarea class="input" id="ct-ins" name="instructions" rows="6" maxlength="2000" required placeholder="Summarize this month’s usage by tool, flag anything close to a budget or limit, and suggest where to cut back.">${esc(preset.instructions ?? '')}</textarea>
        <span class="help">Be specific about what you want back. Runs with ${esc(e.via)}.</span></div>
      <div class="form-actions"><button class="btn primary" type="submit">Start task</button></div>
      <div class="error-text" data-error></div>
    </form>`, { center: true });
  $('#ct-name')?.focus();
}

/** Finds Claude Code, Codex, Gemini CLI, GitHub Copilot CLI and the Cursor CLI on this computer. */
function loadLocal({ fresh = false } = {}) {
  if (S.demo) return Promise.resolve(null);
  if (!S.localLoading || fresh) {
    S.localLoading = api(`/api/local${fresh ? '?fresh=1' : ''}`)
      .then((r) => (S.local = r))
      .catch(() => (S.local = []))
      .finally(() => (S.localLoading = null));
  }
  return S.localLoading;
}

async function openAddTool() {
  if (S.data?.demo) return toast('Demo data is read-only. Exit demo to add a tool.', true);
  S.add = { step: 'pick' };
  renderAdd();
  try {
    S.catalog ??= await api('/api/catalog');
    if (S.add?.step === 'pick') renderAdd();
    await loadLocal({ fresh: true });
    if (S.add?.step === 'pick') renderAdd();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderAdd() {
  const a = S.add;
  if (!a) return;
  if (a.step === 'pick') {
    const caps = (c) => `<div class="caps">${Object.entries(c.capabilities).filter(([, v]) => v !== 'none').map(([k, v]) => `<span class="cap">${CAP_NAME[k]}: <b>${esc(capShort(k, v))}</b></span>`).join('')}</div>`;
    const item = (c) => `<button class="cat-item" data-action="pick-adapter" data-id="${esc(c.id)}">${logo({ ...c, adapter: c.id })}<div class="min0">
      <b>${esc(c.name)}</b> <span class="faint small">${esc(c.vendor)}</span><p>${esc(c.description)}</p>${caps(c)}</div></button>`;
    const localItem = (c) => {
      const l = S.local?.find((x) => x.id === c.id);
      const state = !l ? '<span class="faint small"><span class="spin"></span> Checking this computer…</span>'
        : l.connected_id ? '<span class="state ok">Already connected</span>'
          : !l.installed ? '<span class="state warn">Not installed yet</span>'
            : l.signed_in ? `<span class="state ok">Installed and signed in${l.account?.email ? ` as ${esc(l.account.email)}` : ''}</span>` : '<span class="state warn">Installed, not signed in yet</span>';
      const action = l?.connected_id ? `<a class="btn small" href="#tool-${l.connected_id}" data-action="close">Open</a>` : `<button class="btn small ${l?.installed ? 'primary' : ''}" data-action="connect-local" data-id="${esc(c.id)}" ${l ? '' : 'disabled'}>Connect</button>`;
      return `<div class="cat-item local">${logo({ ...c, adapter: c.id })}<div class="min0"><b>${esc(c.name)}</b> <span class="faint small">${esc(c.account)}</span><p>${esc(c.description)}</p>${state}</div>${action}</div>`;
    };
    openPanel('Connect a tool', `
      <div class="section"><h4>${ICON.signin} Sign in with your account · no API key</h4><div class="catalog">${S.catalog ? S.catalog.filter((c) => c.kind === 'local').map(localItem).join('') : '<div class="faint small"><span class="spin"></span> Loading…</div>'}</div>
        <p class="fine">These use the app on this computer and the account it’s signed in with. If one isn’t installed or signed in yet, connect it anyway and its page walks you through it.</p></div>
      ${S.catalog ? `<div class="section"><h4>${ICON.key} Connect with an API key</h4><div class="catalog">${S.catalog.filter((c) => c.kind === 'api').map(item).join('')}</div></div>
      <div class="section"><h4>${ICON.pencil} Track without a connection</h4><div class="catalog">${S.catalog.filter((c) => c.kind === 'manual').map(item).join('')}</div></div>` : ''}`, { center: true, wide: true });
    return;
  }
  const c = a.adapter;
  if (a.step === 'form') {
    openPanel(`Add ${c.name}`, `
      <form class="form" data-form="add-tool">
        <div class="field"><label for="a-name">Name</label><input class="input" id="a-name" name="name" value="${esc(c.name)}" maxlength="80" required><span class="help">Use a different name if you connect more than one account.</span></div>
        ${c.credential ? `<div class="field"><label for="a-secret">${esc(c.credential.label)}</label><input class="input" id="a-secret" name="secret" type="password" autocomplete="off" placeholder="${esc(c.credential.placeholder)}" required><span class="help">${esc(c.credential.help)} It is stored encrypted and never shown again.</span></div>` : ''}
        <div class="field"><label for="a-budget">Monthly budget ($, optional)</label><input class="input" id="a-budget" name="budget_usd" type="number" min="0" step="0.01"></div>
        <div class="callout info"><ul class="notes">${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
        <div class="form-actions"><button class="btn primary" type="submit">${c.credential ? 'Test and connect' : 'Add tool'}</button><button class="btn ghost" type="button" data-action="add-back">Back</button></div>
        <div class="error-text" data-error></div>
      </form>`, { center: true });
    $('#a-secret')?.focus();
    return;
  }
  openPanel(`${c.name} added`, `
    ${a.result.test?.detail ? `<div class="callout info">${esc(a.result.test.detail)}</div>` : ''}
    <p class="muted small">${esc(c.name)} is now in the sidebar.</p>
    ${a.result.ingest_token ? `<div class="form">${ingestHelp({ id: a.result.id }, a.result.ingest_token)}</div>` : ''}
    <div class="form-actions"><a class="btn primary" href="#tool-${a.result.id}" data-action="close">Open ${esc(c.name)}</a></div>`, { center: true });
}

/** After the app opens a sign-in or install window, checks back until it's done (or gives up quietly). */
async function waitForLocal(adapterId, kind) {
  const done = (v) => (kind === 'install' ? v.installed : v.signed_in);
  S.waiting[adapterId] = kind;
  if (S.page === 'tool') renderPage();
  const end = Date.now() + (kind === 'install' ? 10 : 4) * 60_000;
  try {
    while (Date.now() < end && S.user && S.waiting[adapterId] === kind) {
      await sleep(kind === 'install' ? 8000 : 5000);
      const v = await api(`/api/local/${adapterId}/check`, { method: 'POST' }).catch(() => null);
      if (v && done(v)) {
        toast(kind === 'install' ? `${v.name} is installed. Next, sign in.` : `${v.name} is signed in and ready`);
        return v;
      }
    }
    return null;
  } finally {
    delete S.waiting[adapterId];
    await load({ force: true });
  }
}

// ── Events ───────────────────────────────────────────────────────────────
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

/** Hands a file to the browser (or the desktop app's save dialog). */
function saveFile(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const FORMS = {
  async setup(fd) {
    if (fd.password !== fd.confirm) throw new Error('The two passwords don’t match.');
    await api('/api/auth/setup', { method: 'POST', body: { username: fd.username, password: fd.password, setupCode: fd.setupCode, remember: fd.remember === '1' } });
    await boot();
  },
  async login(fd) {
    const r = await api('/api/auth/login', { method: 'POST', body: { username: fd.username, password: fd.password, remember: fd.remember === '1' } });
    if (r.twoFactor) {
      S.auth = { ...S.auth, view: 'verify', challenge: r.challenge, message: '' };
      return renderAuth();
    }
    await boot();
  },
  async verify(fd) {
    try {
      const r = await api('/api/auth/login/verify', { method: 'POST', body: { challenge: S.auth.challenge, code: fd.code } });
      await boot();
      if (r.recovery) toast('You signed in with a recovery code. It can’t be used again; make new ones in Sign-in & security if you’re running low.');
    } catch (err) {
      if (/Sign in again/.test(err.message)) return showAuth('login', err.message);
      throw err;
    }
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
    toast(fd.summary_key ? 'Claude API key saved' : 'Saved');
    await load({ force: true });
  },
  async budget(fd, form) {
    await api(`/api/integrations/${form.dataset.id}`, { method: 'PATCH', body: { budget_usd: numOrNull(fd.budget_usd) } });
    toast('Budget saved');
    await load({ force: true });
  },
  async secret(fd, form) {
    await api(`/api/integrations/${form.dataset.id}`, { method: 'PATCH', body: { secret: fd.secret } });
    toast('Key replaced');
    await load({ force: true });
  },
  async 'manual-usage'(fd, form) {
    const body = { day: fd.day };
    for (const k of ['cost_usd', 'requests', 'input_tokens', 'output_tokens']) body[k] = numOrNull(fd[k]);
    await api(`/api/integrations/${form.dataset.id}/manual-usage`, { method: 'POST', body });
    toast('Usage saved');
    await load({ force: true });
  },
  async 'engine-model'(fd, form) {
    await api('/api/settings', { method: 'PUT', body: { engine_models: { [form.dataset.adapter]: fd.model ?? '' } } });
    toast(fd.model?.trim() ? `Runs from this app now use ${fd.model.trim()}` : 'Runs from this app use the default model');
    await load({ force: true });
  },
  async 'team-task'(fd) {
    const r = await api('/api/team-tasks', { method: 'POST', body: { goal: fd.goal, folder: fd.folder?.trim() || null } });
    closeModal();
    await startedTeam(r);
  },
  async 'change-password'(fd) {
    if (fd.next !== fd.confirm) throw new Error('The new passwords don’t match.');
    const r = await api('/api/security/password', { method: 'POST', body: { current: fd.current ?? '', next: fd.next } });
    toast(r.signed_out ? `Password changed. ${plural(r.signed_out, 'other session')} signed out.` : 'Password changed');
    await loadSecurity();
  },
  async '2fa-on'(fd) {
    const r = await api('/api/security/2fa/confirm', { method: 'POST', body: { code: fd.code, password: fd.password } });
    S.secSetup = null;
    S.secCodes = r.recovery_codes;
    await loadSecurity();
  },
  async '2fa-off'(fd) {
    await api('/api/security/2fa/disable', { method: 'POST', body: { code: fd.code, password: fd.password } });
    S.secForm = null;
    toast('Two-step verification is off');
    await loadSecurity();
  },
  async '2fa-recovery'(fd) {
    const r = await api('/api/security/2fa/recovery', { method: 'POST', body: { password: fd.password } });
    S.secForm = null;
    S.secCodes = r.recovery_codes;
    await loadSecurity();
  },
  async 'google-client'(fd) {
    await api('/api/security/google-client', { method: 'PUT', body: { client_id: fd.client_id, client_secret: fd.client_secret } });
    toast('Google client saved. Now link your Google account.');
    await loadSecurity();
  },
  async 'google-unlink'(fd) {
    await api('/api/security/google/unlink', { method: 'POST', body: { password: fd.password } });
    S.secForm = null;
    toast('Google account unlinked');
    await loadSecurity();
  },
  async erase(fd) {
    if (fd.confirm !== 'DELETE') throw new Error('Type DELETE, in capitals, to confirm.');
    const r = await api('/api/privacy/erase', { method: 'POST', body: { password: fd.password, confirm: fd.confirm } });
    clearTimeout(S.timer);
    S.user = null;
    S.data = null;
    location.replace(r.setup_code ? `/?setup=${encodeURIComponent(r.setup_code)}` : '/');
  },
  async 'follow-up'(fd, form) {
    const r = await api(`/api/tasks/${form.dataset.id}/follow-up`, { method: 'POST', body: { text: fd.text } });
    toast(r.status === 'queued' ? 'Follow-up queued. It starts when a running task finishes.' : 'Follow-up started');
    S.taskFilter = 'all';
    await load({ force: true });
    openTask(r.task_id);
  },
  async automation(fd, form) {
    const body = { name: fd.name, prompt: fd.prompt, mode: fd.mode, folder: fd.mode === 'team' ? fd.folder?.trim() || null : null, schedule: { every: fd.every, at: fd.at, day: Number(fd.day) } };
    const id = form.dataset.id;
    const a = await api(id ? `/api/automations/${id}` : '/api/automations', { method: id ? 'PATCH' : 'POST', body });
    closeModal();
    toast(a.enabled && a.next_run_at ? `Saved. Next run ${when(a.next_run_at)}` : 'Saved');
    if (S.page !== 'automations') location.hash = '#automations';
    await load({ force: true });
  },
  async 'claude-task'(fd) {
    const r = await api('/api/claude-tasks', { method: 'POST', body: { name: fd.name, instructions: fd.instructions } });
    closeModal();
    toast(r.status === 'queued' ? 'Task queued. It starts when a running assistant task finishes.' : 'Task started');
    S.taskFilter = 'all';
    await load({ force: true });
  },
  async 'add-tool'(fd) {
    const result = await api('/api/integrations', { method: 'POST', body: { adapter: S.add.adapter.id, ...fd, budget_usd: numOrNull(fd.budget_usd) } });
    S.add = { ...S.add, step: 'done', result };
    flash(result.id);
    renderAdd();
    load({ force: true });
  },
};

function flash(id) {
  S.flashTool = id;
  setTimeout(() => {
    if (S.flashTool === id) {
      S.flashTool = null;
      navTools();
    }
  }, 2600);
}

async function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'team-quick') {
    const goal = String(new FormData(form).get('goal') ?? '').trim();
    if (!goal) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const r = await api('/api/team-tasks', { method: 'POST', body: { goal, mode: form.dataset.mode === 'compare' ? 'compare' : 'team' } });
      form.reset();
      await startedTeam(r);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
    return;
  }
  if (kind === 'ask' || kind === 'chat' || kind === 'ask-tool') {
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (!text) return;
    if (kind === 'ask') return askAssistant(text);
    if (kind === 'ask-tool') {
      try {
        await useEngine(form.dataset.engine, { quiet: true });
      } catch (err) {
        return toast(err.message, true);
      }
      return askAssistant(text);
    }
    if (S.chat.streaming) return;
    form.reset();
    autosize($('#chat-input'));
    return sendChat(text).catch((err) => toast(err.message, true));
  }
  const btn = form.querySelector('button[type="submit"]');
  const errEl = form.querySelector('[data-error]');
  const label = btn?.innerHTML;
  if (errEl) errEl.textContent = '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = kind === 'add-tool' || kind === 'secret' ? 'Testing connection…' : kind === 'login' ? 'Signing in…' : kind === 'setup' ? 'Creating account…' : kind === 'verify' ? 'Verifying…' : 'Saving…';
  }
  try {
    await FORMS[kind](Object.fromEntries(new FormData(form)), form);
  } catch (err) {
    if (errEl?.isConnected) errEl.textContent = err.message;
    else toast(err.message, true);
  } finally {
    if (btn?.isConnected) {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
}

async function toggleDemo() {
  S.demo = !S.demo;
  writeStore('acc-demo', S.demo ? '1' : '0');
  closeModal();
  S.data = null;
  renderPage();
  await load({ force: true });
}

function setTheme(v) {
  if (v === 'system') {
    writeStore('acc-theme', null);
    delete document.documentElement.dataset.theme;
  } else {
    writeStore('acc-theme', v);
    document.documentElement.dataset.theme = v;
  }
  syncTitleBar();
  renderPage();
}

/** In the desktop app, the window's own buttons follow the theme the page shows. */
let titleBarTheme = null;
function syncTitleBar() {
  if (!document.documentElement.classList.contains('wco')) return;
  const set = document.documentElement.dataset.theme;
  const theme = set === 'light' || set === 'dark' ? set : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (theme === titleBarTheme) return;
  titleBarTheme = theme;
  fetch('/api/desktop/titlebar', { method: 'POST', headers: { 'x-acc-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ theme }) }).catch(() => {});
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
  async 'connect-local'(el) {
    if (S.demo) return toast('Demo data is read-only. Exit demo to connect a tool.', true);
    el.disabled = true;
    const label = el.innerHTML;
    el.textContent = 'Connecting…';
    try {
      const r = await api('/api/integrations', { method: 'POST', body: { adapter: el.dataset.id } });
      closeModal();
      S.local = null;
      flash(r.id);
      await load({ force: true });
      location.hash = `#tool-${r.id}`;
      const t = S.data.tools.find((x) => x.id === r.id);
      toast(r.status === 'ok' ? `${t?.name ?? 'It'} is connected and ready` : `${t?.name ?? 'It'} is in the sidebar. Finish setting it up there.`);
    } finally {
      if (el.isConnected) {
        el.disabled = false;
        el.innerHTML = label;
      }
    }
  },
  async 'local-login'(el) {
    el.disabled = true;
    const r = await api(`/api/local/${el.dataset.id}/login`, { method: 'POST' });
    if (r.opened) {
      toast('A sign-in window opened. Follow it to sign in with your account.');
      waitForLocal(el.dataset.id, 'signin');
    } else {
      el.disabled = false;
      openPanel('Sign in', `<p class="muted">Run this in a terminal, then come back and choose Check again:</p><div class="secret-box"><code id="cmd-login">${esc(r.command)}</code><button class="btn" data-action="copy" data-target="cmd-login">Copy</button></div><p class="faint small">${esc(r.help ?? '')}</p>`, { center: true });
    }
  },
  async 'local-install'(el) {
    el.disabled = true;
    const r = await api(`/api/local/${el.dataset.id}/install`, { method: 'POST' });
    if (r.opened) {
      toast('An install window opened. It closes its work when done; you can then sign in.');
      waitForLocal(el.dataset.id, 'install');
    } else {
      el.disabled = false;
      openPanel('Install', `<p class="muted">Run this in a terminal, then come back and choose Check again:</p><div class="secret-box"><code id="cmd-install">${esc(r.command)}</code><button class="btn" data-action="copy" data-target="cmd-install">Copy</button></div>`, { center: true });
    }
  },
  async 'local-check'(el) {
    el.disabled = true;
    el.textContent = 'Checking…';
    const v = await api(`/api/local/${el.dataset.id}/check`, { method: 'POST' });
    await load({ force: true });
    toast(!v.installed ? `${v.name} isn’t installed yet` : v.signed_in ? `${v.name} is signed in` : `${v.name} isn’t signed in yet`, !v.signed_in);
  },
  async 'chat-with'(el) {
    await useEngine(el.dataset.engine);
    S.chat.thread = null;
    location.hash = '#assistant';
  },
  async 'ask-tool'(el) {
    await useEngine(el.dataset.engine, { quiet: true });
    askAssistant(el.dataset.prompt);
  },
  'task-filter': (el) => {
    S.taskFilter = el.dataset.filter;
    renderPage();
  },
  'toggle-demo': toggleDemo,
  'set-theme': (el) => setTheme(el.dataset.theme),
  ask: (el) => askAssistant(el.dataset.prompt),
  'ask-here': (el) => sendChat(el.dataset.prompt),
  'open-task': (el) => openTask(el.dataset.id),
  'ask-task'(el) {
    const t = S.data.tasks.find((x) => x.id === Number(el.dataset.id));
    closeModal();
    if (t) askAssistant(taskPrompt(t));
  },
  'new-chat'() {
    S.chat.thread = null;
    S.chat.draft = '';
    renderChat();
    $('#chat-input')?.focus();
  },
  'delete-chat'(el) {
    el.closest('.chat-bar').innerHTML = `<span class="muted small grow">Delete “${esc(S.chat.thread.title)}”? This can’t be undone.</span>
      <button class="btn danger" data-action="confirm-delete-chat">Delete</button><button class="btn ghost" data-action="cancel-delete-chat">Cancel</button>`;
  },
  'cancel-delete-chat': () => renderChat(),
  async 'confirm-delete-chat'() {
    const id = S.chat.thread.id;
    await api(`/api/assistant/threads/${id}`, { method: 'DELETE' });
    S.chat.threads = S.chat.threads.filter((t) => t.id !== id);
    S.chat.thread = null;
    toast('Conversation deleted');
    renderChat();
  },
  async 'stop-chat'() {
    if (S.chat.thread) await api(`/api/assistant/threads/${S.chat.thread.id}/stop`, { method: 'POST' });
  },
  'usage-csv'() {
    // One row per tool per day for the last 30 days. Empty cells mean the tool didn't report that figure.
    const d = S.data;
    const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [['day_utc', 'tool', 'tokens', 'cost_usd'].join(',')];
    d.usage.days.forEach((day, i) => {
      for (const s of d.usage.series) {
        if (s.tokens[i] == null && s.cost[i] == null) continue;
        lines.push([day, s.name, s.tokens[i], s.cost[i] == null ? null : s.cost[i].toFixed(4)].map(cell).join(','));
      }
    });
    saveFile(`ai-usage-${utcToday()}${d.demo ? '-demo' : ''}.csv`, `${lines.join('\r\n')}\r\n`, 'text/csv');
  },
  'save-result'(el) {
    const text = $('#task-result-raw')?.textContent ?? '';
    const slug = el.dataset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'result';
    saveFile(`${slug}.md`, text, 'text/markdown');
  },
  async 'copy-reply'(el) {
    const it = S.chat.thread?.items?.[Number(el.dataset.index)];
    if (!it?.text) return;
    try {
      await navigator.clipboard.writeText(it.text);
      el.classList.add('done');
      setTimeout(() => el.isConnected && el.classList.remove('done'), 1500);
    } catch {
      toast('Couldn’t copy. Select the text and press Ctrl+C.', true);
    }
  },
  async 'backup-download'(el) {
    el.disabled = true;
    try {
      const res = await fetch('/api/backup', { headers: { 'x-acc-request': '1' } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Backup failed (${res.status}).`);
      const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'ai-command-center-backup.json';
      saveFile(name, await res.blob());
      toast('Backup saved');
    } finally {
      el.disabled = false;
    }
  },
  async 'confirm-restore'(el) {
    el.disabled = true;
    const r = await api('/api/restore', { method: 'POST', body: S.pendingRestore });
    S.pendingRestore = null;
    S.local = null;
    S.chat = { loaded: false, threads: [], thread: null, streaming: false, pending: null, draft: '' };
    toast(`Restored ${plural(r.tools, 'tool')}, ${plural(r.tasks, 'task')} and ${plural(r.conversations, 'conversation')}`);
    await load({ force: true });
    renderPage();
  },
  'cancel-restore'() {
    S.pendingRestore = null;
    $('#restore-confirm').innerHTML = '';
  },
  'new-claude-task': () => openNewTask(),
  'new-team-task': () => openTeamTask(),
  'hero-mode'(el) {
    S.heroMode = ['team', 'compare'].includes(el.dataset.mode) ? el.dataset.mode : 'ask';
    writeStore('acc-hero-mode', S.heroMode);
    renderPage();
    $('.command-input')?.focus();
  },
  'team-folder'() {
    const goal = $('.command-input')?.value.trim() ?? '';
    openTeamTask({ goal });
  },
  async 'pick-folder'(el) {
    el.disabled = true;
    try {
      const r = await api('/api/pick-folder', { method: 'POST' });
      const input = document.getElementById(el.dataset.target || 'tt-folder');
      if (r.path && input) {
        input.value = r.path;
        if (input.id === 'tt-folder') refreshLineup();
      }
    } catch (err) {
      toast(err.message, true);
      document.getElementById(el.dataset.target || 'tt-folder')?.focus();
    } finally {
      el.disabled = false;
    }
  },
  'erase-open'() {
    S.eraseOpen = true;
    renderPage();
    $('#er-pass')?.focus();
  },
  'erase-cancel'() {
    S.eraseOpen = false;
    renderPage();
  },
  async 'open-data-folder'() {
    await api('/api/privacy/open-folder', { method: 'POST' });
  },
  async 'map-chat'(el) {
    await useEngine(el.dataset.engine);
    location.hash = '#assistant';
  },
  skip() {
    const main = $('#content');
    main?.focus();
    main?.scrollTo(0, 0);
  },
  async 'sec-2fa-start'(el) {
    el.disabled = true;
    S.secSetup = await api('/api/security/2fa/start', { method: 'POST' });
    renderPage();
    $('#tf-code')?.focus();
  },
  'sec-2fa-cancel'() {
    S.secSetup = null;
    renderPage();
  },
  'sec-form'(el) {
    S.secForm = el.dataset.formName || null;
    renderPage();
    $('.sec-inline input')?.focus();
  },
  'codes-done'() {
    S.secCodes = null;
    renderPage();
    toast('Two-step verification is on');
  },
  'save-codes'() {
    saveFile('meridian-recovery-codes.txt', new Blob([$('#sec-codes-raw').textContent], { type: 'text/plain' }));
  },
  async 'sec-end'(el) {
    el.disabled = true;
    await api(`/api/security/sessions/${el.dataset.id}/end`, { method: 'POST' });
    toast('That session is signed out');
    await loadSecurity();
  },
  async 'sec-end-others'(el) {
    el.disabled = true;
    const r = await api('/api/security/sessions/end-others', { method: 'POST' });
    toast(`${plural(r.ended, 'session')} signed out`);
    await loadSecurity();
  },
  async 'sec-link'() {
    S.secLinking = true;
    renderPage();
    try {
      await googleFlow('/api/security/google/link', {}, async (p) => {
        S.secLinking = false;
        if (p.status === 'linked') toast(`Linked ${p.email ?? 'your Google account'}`);
        else toast(p.status === 'expired' ? 'Linking took too long. Try again.' : p.error ?? 'Linking didn’t finish.', true);
        await loadSecurity();
      });
    } catch (err) {
      S.secLinking = false;
      renderPage();
      throw err;
    }
  },
  'sec-link-cancel'() {
    stopGoogleFlow();
    S.secLinking = false;
    renderPage();
  },
  async 'sec-remove-client'() {
    await api('/api/security/google-client', { method: 'DELETE' });
    toast('Google client removed');
    await loadSecurity();
  },
  'open-palette'() {
    openPalette();
  },
  'toggle-dock'() {
    toggleDock();
  },
  'close-tab'(el) {
    closeTab(el.dataset.key);
  },
  'toggle-pass'(el) {
    const input = document.getElementById(el.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.setAttribute('aria-pressed', String(show));
    el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  },
  'auth-back'() {
    showAuth('login');
  },
  async 'google-signin'() {
    const remember = Boolean($('#f-remember')?.checked);
    S.auth = { ...S.auth, view: 'google-wait', message: '' };
    renderAuth();
    try {
      await googleFlow('/api/auth/google/start', { remember }, (p) => {
        if (p.status === 'done') return boot();
        S.auth = { ...S.auth, view: 'login', message: p.status === 'expired' ? 'Google sign-in took too long. Try again.' : p.error ?? 'Google sign-in didn’t finish.' };
        renderAuth();
      });
    } catch (err) {
      S.auth = { ...S.auth, view: 'login', message: err.message };
      renderAuth();
    }
  },
  'google-reopen'() {
    if (S.googleFlow?.url) window.open(S.googleFlow.url, '_blank', 'noopener');
  },
  'google-cancel'() {
    stopGoogleFlow();
    S.auth = { ...S.auth, view: 'login', message: '' };
    renderAuth();
  },
  'go-update'() {
    if (S.page !== 'settings') location.hash = '#settings';
    setTimeout(() => document.getElementById('updates')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  },
  async 'check-update'(el) {
    el.disabled = true;
    el.textContent = 'Checking…';
    try {
      const u = await api('/api/update/check', { method: 'POST' });
      toast(u.error ? `Couldn’t check: ${u.error}` : u.available ? `Version ${u.latest} is available` : 'You have the newest version', Boolean(u.error));
      await load({ force: true });
    } finally {
      if (el.isConnected) {
        el.disabled = false;
        el.textContent = 'Check now';
      }
    }
  },
  async 'install-update'(el) {
    el.disabled = true;
    el.textContent = 'Downloading…';
    try {
      const r = await api('/api/update/install', { method: 'POST' });
      clearTimeout(S.timer);
      openPanel('Updating', `<div class="updating"><span class="spin"></span><div><b>Installing version ${esc(r.version)}</b><p class="muted small">Meridian closes now and opens again by itself in a minute. Your data and settings stay as they are.</p></div></div>`, { center: true, focus: false });
    } catch (err) {
      if (el.isConnected) {
        el.disabled = false;
        el.innerHTML = `${ICON.download}Try the update again`;
      }
      throw err;
    }
  },
  'new-automation'(el) {
    const t = AUTO_TEMPLATES[Number(el.dataset.template)];
    openAutomation(t ? { ...t, schedule: { ...t.schedule } } : {});
  },
  'edit-automation'(el) {
    const a = S.data.automations?.find((x) => x.id === Number(el.dataset.id));
    if (a) openAutomation(a);
  },
  async 'run-automation'(el) {
    el.disabled = true;
    const r = await api(`/api/automations/${el.dataset.id}/run`, { method: 'POST' });
    toast(r.status === 'queued' ? 'Queued. It starts when a running task finishes.' : 'Started. Follow it in Tasks.');
    await load({ force: true });
    if (r.task_id) openTask(r.task_id);
  },
  'delete-automation'(el) {
    S.confirmAuto = Number(el.dataset.id);
    renderPage();
  },
  'cancel-delete-automation'() {
    S.confirmAuto = null;
    renderPage();
  },
  async 'confirm-delete-automation'(el) {
    await api(`/api/automations/${el.dataset.id}`, { method: 'DELETE' });
    S.confirmAuto = null;
    toast('Automation deleted');
    await load({ force: true });
  },
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
    const label = el.textContent;
    el.disabled = true;
    el.textContent = 'Generating…';
    try {
      const r = await api('/api/summary/refresh', { method: 'POST' });
      await load({ force: true });
      toast(r.error ? r.error : 'Summary updated', Boolean(r.error));
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (el.isConnected) {
        el.disabled = false;
        el.textContent = label;
      }
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
  },
  async 'toggle-tool'(el) {
    await api(`/api/integrations/${el.dataset.id}`, { method: 'PATCH', body: { enabled: el.dataset.enabled === '1' } });
    await load({ force: true });
  },
  'remove-tool'(el) {
    S.confirmRemove = Number(el.dataset.id);
    renderPage();
  },
  'cancel-remove'() {
    S.confirmRemove = null;
    renderPage();
  },
  async 'confirm-remove'(el) {
    await api(`/api/integrations/${el.dataset.id}`, { method: 'DELETE' });
    S.confirmRemove = null;
    S.local = null;
    toast('Tool removed');
    location.hash = '#tools';
    await load({ force: true });
  },
  async 'rotate-token'(el) {
    const { ingest_token } = await api(`/api/integrations/${el.dataset.id}/ingest-token`, { method: 'POST' });
    $('#ingest-section').innerHTML = `<label class="field-label">Report tasks from your scripts</label>${ingestHelp({ id: Number(el.dataset.id) }, ingest_token)}`;
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
  const pal = e.target.closest('[data-pal]');
  if (pal) {
    if (pal.dataset.pal === 'pick') return runPalette(Number(pal.dataset.i));
    if (pal.dataset.pal === 'overlay' && e.target === pal) return closePalette();
  }
  if (e.button === 1) return;
  const el = e.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  // Links that also close a dialog keep their navigation.
  if (el.tagName === 'A' && el.dataset.action !== 'close') e.preventDefault();
  try {
    await ACTIONS[el.dataset.action](el, e);
  } catch (err) {
    toast(err.message, true);
    if (el.isConnected && el.disabled) el.disabled = false;
  }
}

async function onChange(e) {
  const el = e.target;
  const act = el.dataset.actionChange;
  if (act === 'toggle-demo') return toggleDemo();
  if (act === 'pick-thread') {
    if (el.value) openThread(el.value).catch((err) => toast(err.message, true));
    return;
  }
  if (act === 'pick-engine' || act === 'set-engine') {
    try {
      await useEngine(el.value);
    } catch (err) {
      toast(err.message, true);
    }
    renderPage();
    if (S.page !== 'assistant') renderDock();
    return;
  }
  if (act === 'backup-file') {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    try {
      const b = JSON.parse(await file.text());
      if (b?.format !== 'ai-command-center-backup') throw new Error('That file isn’t an Meridian backup.');
      S.pendingRestore = b;
      $('#restore-confirm').innerHTML = `<div class="callout warn restore-box">
        <b>Restore the backup from ${esc(String(b.exported_at ?? '').slice(0, 10) || 'an unknown date')}?</b>
        It has ${plural(b.integrations?.length ?? 0, 'tool')}, ${plural(b.tasks?.length ?? 0, 'task')} and ${plural(b.assistant_threads?.length ?? 0, 'conversation')}.
        They replace everything in the app now. Your account and Claude API key stay as they are; other tools’ keys need adding again.
        <div class="form-actions"><button class="btn danger" data-action="confirm-restore">Replace with the backup</button><button class="btn ghost" data-action="cancel-restore">Cancel</button></div></div>`;
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file isn’t valid JSON.' : err.message, true);
    }
    return;
  }
  if (el.dataset.privacy) {
    const k = el.dataset.privacy;
    const value = k === 'retention_days' ? Number(el.value) : el.checked;
    if (k === 'retention_days' && value && !(await confirmRetention(value))) {
      el.value = String(S.privacyInfo?.settings?.retention_days ?? 0);
      return;
    }
    try {
      await api('/api/settings', { method: 'PUT', body: { privacy: { [k]: value } } });
      toast(k === 'retention_days' ? (value ? `Finished work older than ${value === 365 ? 'a year' : `${value} days`} is now deleted daily` : 'Finished work is kept until you delete it')
        : k === 'read_sessions' ? (value ? 'Sessions from AI apps are listed again after the next sync' : 'Sessions from AI apps are no longer listed')
          : value ? 'Sessions are named after their first message from the next sync' : 'Sessions no longer show what you typed');
      S.privacyInfo = null;
      await load({ force: true });
    } catch (err) {
      if (k !== 'retention_days') el.checked = !el.checked;
      toast(err.message, true);
    }
    return;
  }
  if (el.dataset.autoToggle) {
    try {
      const a = await api(`/api/automations/${el.dataset.autoToggle}`, { method: 'PATCH', body: { enabled: el.checked } });
      toast(a.enabled ? `On. Next run ${when(a.next_run_at)}` : 'Paused');
      await load({ force: true });
    } catch (err) {
      el.checked = !el.checked;
      toast(err.message, true);
    }
    return;
  }
  if ('autoEvery' in el.dataset) {
    $('#au-day-field').hidden = el.value !== 'week';
    $('#au-at-label').textContent = el.value === 'hour' ? 'Minutes past the hour' : 'At';
    return;
  }
  if ('autoMode' in el.dataset) {
    $('#au-folder-field').hidden = el.value !== 'team';
    return;
  }
  if ('summaryMode' in el.dataset) {
    try {
      await api('/api/settings', { method: 'PUT', body: { summary_mode: el.checked ? 'ai' : 'rules' } });
      toast(el.checked ? 'The summary is written by AI' : 'The summary is built from rules, without AI');
      await load({ force: true });
    } catch (err) {
      el.checked = !el.checked;
      toast(err.message, true);
    }
    return;
  }
  if (el.dataset.desktop) {
    try {
      await api('/api/settings', { method: 'PUT', body: { desktop: { [el.dataset.desktop]: el.checked } } });
      toast('Setting saved');
      await load({ force: true });
    } catch (err) {
      el.checked = !el.checked;
      toast(err.message, true);
    }
    return;
  }
  if (el.dataset.routePref) {
    try {
      await api('/api/settings', { method: 'PUT', body: { route_prefs: { [el.dataset.routePref]: el.value } } });
      toast(el.value === 'auto' ? 'Automatic picks the AI for this kind of task' : `${el.selectedOptions[0].textContent.split(' · ')[0]} is now your choice for this kind of task`);
      await load({ force: true });
    } catch (err) {
      toast(err.message, true);
      renderPage();
    }
    return;
  }
  if (el.dataset.teamRole) {
    try {
      await api('/api/settings', { method: 'PUT', body: { team_roles: { [el.dataset.teamRole]: el.value } } });
      toast('Team role saved');
      await load({ force: true });
      renderPage();
    } catch (err) {
      toast(err.message, true);
      renderPage();
    }
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
  syncTitleBar();
  if (!wired) {
    wired = true;
    window.addEventListener('hashchange', () => {
      Object.assign(S, routeFromHash());
      S.confirmRemove = null;
      S.confirmAuto = null;
      S.eraseOpen = false;
      S.secForm = null;
      S.secSetup = null;
      S.secCodes = null;
      if (S.pal) closePalette({ restore: false });
      closeModal();
      updateChrome();
      renderPage();
      $('#content')?.scrollTo(0, 0);
    });
    document.addEventListener('click', onClick);
    document.addEventListener('auxclick', (e) => {
      const tab = e.button === 1 && e.target.closest('.wb-tab');
      if (!tab) return;
      e.preventDefault();
      closeTab(tab.querySelector('[data-action="close-tab"]').dataset.key);
    });
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', onChange);
    document.addEventListener('input', (e) => {
      if (e.target.closest?.('form[data-form="setup"], form[data-form="change-password"]') && ['f-pass', 'f-user', 'cp-next'].includes(e.target.id)) updatePasswordRules(e.target.form);
      if (e.target.id === 'pal-q' && S.pal) {
        S.pal.q = e.target.value;
        S.pal.active = 0;
        return renderPalette();
      }
      if (e.target.id === 'chat-input') autosize(e.target);
      else if (e.target.id === 'tt-folder') refreshLineup();
      else if (e.target.dataset?.route) previewRoute(e.target);
      else if (e.target.id === 'task-search') {
        S.taskQuery = e.target.value;
        const { groups, labels } = taskGroups(S.data);
        $('#task-list').innerHTML = taskListHtml(groups, labels);
      }
    });
    document.addEventListener('keyup', (e) => {
      const caps = $('#caps');
      if (caps && e.getModifierState) caps.hidden = !e.getModifierState('CapsLock');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && $('#modal-root .panel')) {
        const items = [...$('#modal-root .panel').querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
        if (items.length) {
          const first = items[0];
          const last = items[items.length - 1];
          const inside = $('#modal-root .panel').contains(document.activeElement);
          if (e.shiftKey && (document.activeElement === first || !inside)) {
            e.preventDefault();
            last.focus();
            return;
          }
          if (!e.shiftKey && (document.activeElement === last || !inside)) {
            e.preventDefault();
            first.focus();
            return;
          }
        }
      }
      if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        e.target.form.requestSubmit();
        return;
      }
      if (e.target.id === 'fu-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.target.form.requestSubmit();
        return;
      }
      if (S.pal) {
        if (e.key === 'Escape') {
          e.preventDefault();
          return closePalette();
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = S.pal.results?.length ?? 0;
          if (n) S.pal.active = (S.pal.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
          return renderPalette();
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          return runPalette(S.pal.active);
        }
        if (e.key === 'Tab') e.preventDefault();
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (S.user && S.data && mod && !e.altKey && (k === 'p' || k === 'k')) {
        e.preventDefault();
        return S.pal ? closePalette() : openPalette(e.shiftKey && k === 'p' ? '>' : '');
      }
      if (S.user && S.data && mod && !e.altKey && !e.shiftKey && k === 'l') {
        e.preventDefault();
        return toggleDock();
      }
      if (e.key === 'Escape') closeModal();
      // / outside a text box jumps to the command bar on the overview.
      const typingNow = /INPUT|SELECT|TEXTAREA/.test(e.target.tagName ?? '') || e.target.isContentEditable;
      if (e.key === '/' && !typingNow && !e.ctrlKey && !e.metaKey) {
        if (!S.user || !S.data) return;
        e.preventDefault();
        closeModal();
        const focusBar = () => $('.command-input')?.focus();
        if (S.page === 'dashboard') focusBar();
        else {
          location.hash = '#dashboard';
          setTimeout(focusBar, 60);
        }
      }
    });
    document.addEventListener('visibilitychange', () => !document.hidden && S.user && load());
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      syncTitleBar();
      if (S.data) renderPage();
    });
  }
  let st;
  try {
    st = await api('/api/auth/status');
  } catch (err) {
    $('#root').innerHTML = `<div class="auth"><div class="auth-card"><div class="callout err">Can’t reach the server: ${esc(err.message)}</div></div></div>`;
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
