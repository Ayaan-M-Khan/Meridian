import { db, getSettings, notify } from './db.js';
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
}
