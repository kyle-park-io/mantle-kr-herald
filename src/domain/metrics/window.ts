export function currentMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export interface MonthWindow {
  month: string;
  startISO: string;
  endExclusiveISO: string;
}

export function monthWindow(month: string): MonthWindow {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month "${month}" (expected YYYY-MM)`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`Invalid month "${month}" (month must be 01-12)`);
  return {
    month,
    startISO: new Date(Date.UTC(year, mon - 1, 1)).toISOString(),
    endExclusiveISO: new Date(Date.UTC(year, mon, 1)).toISOString(),
  };
}
