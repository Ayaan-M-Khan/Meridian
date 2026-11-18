export const nowIso = () => new Date().toISOString();
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
export const startOfUtcDay = (d = new Date()) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const startOfUtcMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const addDays = (d, n) => new Date(d.getTime() + n * 86_400_000);

export function lastNDays(n, end = new Date()) {
  const t = startOfUtcDay(end);
  return Array.from({ length: n }, (_, i) => utcDay(addDays(t, i - (n - 1))));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class AdapterError extends Error {}

/** Sums a field across rows; null when no row has a value, so "no data" never reads as zero. */
export function sumField(rows, field) {
  let any = false;
  let total = 0;
  for (const r of rows) {
    if (r[field] != null) {
      any = true;
      total += r[field];
    }
  }
  return any ? total : null;
}

export function sumNullable(values) {
  const known = values.filter((v) => v != null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

export const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

export function rowTokens(r) {
  return sumNullable(TOKEN_FIELDS.map((f) => r[f]));
}
