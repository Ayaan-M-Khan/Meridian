import { db, getSettings, notify } from './db.js';
import { estimate, pastDurations, progressHistory } from './eta.js';
import { addDays, lastNDays, startOfUtcDay, startOfUtcMonth, utcDay } from './util.js';

const usd = (n) => `$${n.toFixed(2)}`;

/** Checks budgets, spending spikes and upcoming scheduled tasks. Safe to run often: every alert is deduplicated. */
export function evaluateAlerts(now = new Date()) {
  const s = getSettings();
  const month = utcDay(startOfUtcMonth(now)).slice(0, 7);
  const monthStart = utcDay(startOfUtcMonth(now));
  const ints = db.prepare('SELECT * FROM integrations WHERE enabled = 1').all();
  const costRows = db
    .prepare('SELECT integration_id, day, SUM(cost_usd) AS cost FROM usage_daily WHERE day >= ? AND cost_usd IS NOT NULL GROUP BY integration_id, day')
    .all(utcDay(addDays(startOfUtcDay(now), -40)));

  let totalMtd = 0;
  for (const i of ints) {
    const rows = costRows.filter((r) => r.integration_id === i.id);
    const mtd = rows.filter((r) => r.day >= monthStart).reduce((a, r) => a + r.cost, 0);
    totalMtd += mtd;

    if (i.budget_usd > 0) {
      const pct = (mtd / i.budget_usd) * 100;
      if (pct >= 100) {
        notify({
          kind: 'limit_reached',
          severity: 'err',
          title: `${i.name} reached its monthly budget`,
          body: `${usd(mtd)} spent of the ${usd(i.budget_usd)} budget you set for ${month}.`,
          dedupe: `limit:${i.id}:${month}`,
        });
      } else if (pct >= s.usage_warn_pct) {
        notify({
          kind: 'usage_warning',
          severity: 'warn',
          title: `${i.name} is at ${Math.round(pct)}% of its monthly budget`,
          body: `${usd(mtd)} spent of ${usd(i.budget_usd)} so far in ${month}.`,
          dedupe: `warn:${i.id}:${month}`,
        });
      }
    }

    // Spike check uses yesterday, the latest complete day, against the 7 days before it.
    const [yesterday, ...prior] = lastNDays(8, addDays(now, -1)).reverse();
    const y = rows.find((r) => r.day === yesterday)?.cost ?? 0;
    const priorCosts = prior.map((d) => rows.find((r) => r.day === d)?.cost ?? 0);
    const avg = priorCosts.reduce((a, b) => a + b, 0) / priorCosts.length;
    if (y >= 1 && avg > 0 && y > avg * s.spike_multiplier) {
      notify({
        kind: 'spike',
        severity: 'warn',
        title: `Unusual spending on ${i.name}`,
        body: `${usd(y)} on ${yesterday}, ${(y / avg).toFixed(1)}× the 7-day average of ${usd(avg)}.`,
        dedupe: `spike:${i.id}:${yesterday}`,
      });
    }
  }

  if (s.monthly_ceiling_usd > 0) {
    const pct = (totalMtd / s.monthly_ceiling_usd) * 100;
    if (pct >= 100) {
      notify({
        kind: 'limit_reached',
        severity: 'err',
        title: 'Total AI spending passed your monthly ceiling',
        body: `${usd(totalMtd)} across all tools, above the ${usd(s.monthly_ceiling_usd)} ceiling.`,
        dedupe: `ceiling:${month}`,
      });
    } else if (pct >= s.usage_warn_pct) {
      notify({
        kind: 'usage_warning',
        severity: 'warn',
        title: `Total AI spending is at ${Math.round(pct)}% of your ceiling`,
        body: `${usd(totalMtd)} of ${usd(s.monthly_ceiling_usd)} so far this month.`,
        dedupe: `ceiling-warn:${month}`,
      });
    }
  }

  const soon = db
    .prepare(
      `SELECT t.id, t.name, t.scheduled_for, i.name AS tool FROM tasks t JOIN integrations i ON i.id = t.integration_id
       WHERE t.status = 'scheduled' AND t.scheduled_for > ? AND t.scheduled_for <= ?`,
    )
    .all(now.toISOString(), new Date(now.getTime() + 60 * 60_000).toISOString());
  for (const t of soon) {
    notify({
      kind: 'scheduled',
      severity: 'info',
      title: `Starting soon: ${t.name}`,
      body: `${t.tool} is scheduled to run it at ${t.scheduled_for.slice(11, 16)} UTC.`,
      dedupe: `sched:${t.id}:${t.scheduled_for}`,
    });
  }

  watchRunningTasks(now);
}

/** The ETA watcher: flags running tasks that stopped reporting progress or ran well past their expected finish. */
function watchRunningTasks(now) {
  const running = db
    .prepare(`SELECT t.*, i.name AS tool FROM tasks t JOIN integrations i ON i.id = t.integration_id WHERE t.status = 'running' AND i.enabled = 1`)
    .all();
  if (!running.length) return;
  const names = [...new Set(running.map((t) => t.name))];
  const finished = db
    .prepare(`SELECT integration_id, name, status, started_at, finished_at FROM tasks WHERE status = 'completed' AND name IN (${names.map(() => '?').join(',')}) ORDER BY finished_at DESC LIMIT 500`)
    .all(...names);
  const history = progressHistory(running.map((t) => t.id));
  const durations = pastDurations(finished);
  for (const t of running) {
    const e = estimate(t, history.get(t.id) ?? [], durations.get(`${t.integration_id}|${t.name}`) ?? [], now.getTime());
    if (e.stalled) {
      notify({
        kind: 'task_stalled',
        severity: 'warn',
        title: `No progress on ${t.name}`,
        body: `${t.tool} last reported progress ${minutesAgo(t.updated_at, now)} at ${Math.round(t.progress ?? 0)}%. It may be stuck.`,
        dedupe: `stall:${t.id}:${t.updated_at}`,
      });
    }
    if (e.overdue) {
      notify({
        kind: 'task_overdue',
        severity: 'warn',
        title: `${t.name} is taking longer than expected`,
        body: `${t.tool} ${e.eta_source === 'reported' ? 'said it would finish' : 'was on track to finish'} by ${e.eta_at.slice(11, 16)} UTC and is still running.`,
        dedupe: `overdue:${t.id}:${e.eta_at.slice(0, 16)}`,
      });
    }
  }
}

function minutesAgo(iso, now) {
  const m = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  return m >= 120 ? `${Math.round(m / 60)} hours ago` : `${m} minutes ago`;
}
