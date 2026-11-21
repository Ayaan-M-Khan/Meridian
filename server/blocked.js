/**
 * AI apps that are installed and signed in, but whose account can't use them: Google moved personal accounts from
 * Gemini CLI to Antigravity, and Gemini CLI then answers every run with an error. A run that hits this marks the app
 * not ready, with the reason, so smart routing passes over it. The mark lasts while the same sign-in is in place:
 * signing in there with another account, or pressing Check again on the app's page, lifts it.
 */
import { db, addEvent, notify } from './db.js';
import { nowIso } from './util.js';

const parse = (s) => {
  try {
    return JSON.parse(s ?? 'null');
  } catch {
    return null;
  }
};

/** Marks a connected app unusable with this sign-in. `signinId` identifies the sign-in (adapter statusCheck). */
export function markUnusable(adapterId, reason, signinId = null) {
  const row = db.prepare('SELECT * FROM integrations WHERE adapter = ? ORDER BY id LIMIT 1').get(adapterId);
  if (!row) return;
  const meta = parse(row.meta) ?? {};
  meta.blocked = { reason, signin_id: signinId, at: nowIso() };
  db.prepare("UPDATE integrations SET status = 'error', last_error = ?, meta = ? WHERE id = ?").run(reason, JSON.stringify(meta), row.id);
  if (row.status !== 'error') {
    addEvent(row.id, 'connection', `${row.name} can’t be used with this account: ${reason}`);
    notify({ kind: 'connection', severity: 'warn', title: `${row.name} can’t be used with this account`, body: reason, dedupe: `blocked:${row.id}:${signinId ?? ''}` });
  }
}

/** The mark, if it still holds for this sign-in (a sync's fresh status), else null. */
export function stillBlocked(row, localStatus) {
  const b = parse(row.meta)?.blocked;
  if (!b) return null;
  return (b.signin_id ?? null) === (localStatus?.signin_id ?? null) ? b : null;
}

/** Lifts the mark, for Check again: the next run tries the app again. */
export function clearUnusable(integrationId) {
  const row = db.prepare('SELECT meta FROM integrations WHERE id = ?').get(integrationId);
  const meta = parse(row?.meta);
  if (!meta?.blocked) return;
  delete meta.blocked;
  db.prepare('UPDATE integrations SET meta = ? WHERE id = ?').run(JSON.stringify(meta), integrationId);
}
