export interface Period {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parsePeriod(from: unknown, to: unknown, today = new Date()): Period {
  const t = today.toISOString().slice(0, 10);
  const f = typeof from === "string" && ISO.test(from) ? from : shift(t, -6);
  const e = typeof to === "string" && ISO.test(to) ? to : t;
  if (f > e) throw new Error("Start date is after end date.");
  if ((Date.parse(e) - Date.parse(f)) / 86_400_000 > 366) throw new Error("Periods are limited to one year.");
  return { from: f, to: e };
}

export const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

export const periodLabel = (p: Period) => (p.from === p.to ? p.from : `${p.from} to ${p.to}`);

export const ordersQuery = (p: Period) => `created_at:>=${p.from} created_at:<${shift(p.to, 1)}`;
