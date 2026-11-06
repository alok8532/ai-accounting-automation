// Business dates. The business runs on Indian time, but JavaScript's toISOString() is UTC —
// between 00:00 and 05:30 IST that would still be "yesterday". All "today" logic goes through here.

export const DAY = 86400000;
export const BUSINESS_TZ = process.env.BUSINESS_TZ ?? "Asia/Kolkata";

const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

// Calendar date (YYYY-MM-DD) of an instant, in the business time zone.
export const businessDate = (d = new Date()) => ymd.format(new Date(d));

// A date-only value (UTC midnight) for ageing maths. Accepts "YYYY-MM-DD" (used as-is) or a Date/instant
// (converted to its business date first), so "now" at 02:00 IST ages bills as of the IST date.
export const toDateOnly = (d = new Date()) =>
  new Date(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : businessDate(d));

// "YYYY-MM-DD" of a date-only value.
export const fmtDate = (d) => d.toISOString().slice(0, 10);
