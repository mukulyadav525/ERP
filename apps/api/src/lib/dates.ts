// The shop's calendar. "Today", a default report period, whether a supplier bill
// is dated in the future — all of these are questions about the business day in
// the shop's timezone, not the UTC day the server clock happens to be in. Just
// after midnight in India the two differ, and a report defaulting to the UTC date
// silently leaves out everything sold since midnight.

const TZ = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';

/** Today's date in the business timezone, as YYYY-MM-DD. */
export function businessToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/** Calendar arithmetic on a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
