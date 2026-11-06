// Pure ageing / position calculations — no Tally calls, no I/O, so every rule is unit-testable.
// Each rule is documented in docs/ACCOUNTING_RULES.md (section numbers in the comments).

import { DAY, fmtDate } from "./dates.mjs";
import { checkEmails } from "./email.mjs";
import { holdFor, customerHold, describeHold } from "./holds.mjs";

// Errors caused by a business rule or configuration (not by Tally being unreachable).
export const ruleError = (msg) => Object.assign(new Error(msg), { rule: true });

export const round2 = (n) => Math.round(n * 100) / 100;

// §2 Due date. `due` comes from the bill in Tally: { billDate, creditDays, fixedDue, issue }.
// Order: the bill's own fixed due date / credit period -> (fallback) ledger default credit period
// -> (fallback) bill date, as Tally itself does when there is no credit period. Never silent: the
// source is always returned and anything but the bill's own terms is flagged in reports.
export function resolveDueDate(due, ledgerDefaultDays, fallback = "ledger-default") {
  if (due.issue) return { issue: due.issue };
  if (due.fixedDue) return { dueDate: due.fixedDue, source: "bill due date" };
  if (!due.billDate) return { issue: "no bill date in Tally" };
  if (due.creditDays != null) return { dueDate: addDays(due.billDate, due.creditDays), source: "bill credit period" };
  if (fallback === "none") return { issue: "no credit period on the bill" };
  if (fallback === "ledger-default" && ledgerDefaultDays != null)
    return { dueDate: addDays(due.billDate, ledgerDefaultDays), source: "ledger default credit period" };
  return { dueDate: due.billDate, source: "bill date (no credit period in Tally)" };
}

const addDays = (d, n) => new Date(d.getTime() + n * DAY);

// §3 Whole days between two date-only values (UTC midnight). Due today = 0 days overdue.
export const daysBetween = (from, to) => Math.round((to - from) / DAY);
export const overdueDays = (asOf, dueDate) => Math.max(0, daysBetween(dueDate, asOf));

// §4 Ageing buckets, by days overdue. [30, 60, 90] ->
//   "Not due" (0) | "1-30 days" | "31-60 days" | "61-90 days" | "Over 90 days"
export function bucketLabels(limits) {
  return ["Not due", ...limits.map((n, i) => `${(limits[i - 1] ?? 0) + 1}-${n} days`), `Over ${limits.at(-1)} days`];
}
export function bucketOf(days, limits) {
  const labels = bucketLabels(limits);
  if (days <= 0) return labels[0];
  const i = limits.findIndex((n) => days <= n);
  return labels[i === -1 ? labels.length - 1 : i + 1];
}

// §3 Ageing date policy: Tally gives today's balances, so ageing as of a PAST date would silently
// deduct later receipts. Past dates are refused unless allowPastAsOf is switched on after verification.
export function checkAsOf(asOf, today, allowPast) {
  if (!allowPast && asOf < today)
    throw ruleError(`Ageing as of a past date (${asOf}) is switched off: Tally returns today's balances, so ` +
      `payments received after ${asOf} would already be deducted. Use today (${today}) or a later date.`);
}

// §5–§9 One customer's position, bucket split and reminder eligibility.
//   rows:      open debit bills of this customer (from receivables.mjs)
//   credits:   credit-balance bill references (advances, unadjusted credit notes)
//   onAccount: ledger balance not linked to any bill (+ = unallocated debit, − = unallocated credit)
export function customerPosition({ customer, ledger = {}, rows = [], credits = [], onAccount = 0, holds = [], config }) {
  const labels = bucketLabels(config.ageingBuckets);
  const buckets = Object.fromEntries(labels.map((l) => [l, 0]));
  let unknownDue = 0;
  for (const r of rows) {
    if (r.issue) unknownDue += r.outstanding;
    else buckets[bucketOf(r.overdueDays, config.ageingBuckets)] += r.outstanding;
  }
  for (const l of labels) buckets[l] = round2(buckets[l]);

  const sum = (xs, f) => round2(xs.reduce((s, x) => s + f(x), 0));
  const totalBills = sum(rows, (r) => r.outstanding);
  const creditBills = sum(credits, (c) => c.amount);
  const overdueTotal = sum(rows.filter((r) => !r.issue && r.overdueDays > 0), (r) => r.outstanding);
  const unadjustedCredits = round2(creditBills + Math.max(0, -onAccount));
  const email = checkEmails(ledger.email);
  const hold = customerHold(holds, customer);

  // §5/§8 Bills a reminder may ask for: overdue, ageable, at/above the bill threshold, not on hold.
  const reminderBills = rows.filter((r) => !r.issue && r.overdueDays > 0 && r.outstanding >= config.minBillBalance &&
    !holdFor(holds, customer, r.bill));
  const chaseable = sum(reminderBills, (r) => r.outstanding);
  const netOverdue = round2(chaseable - unadjustedCredits); // §7 credits are set off against overdue bills first

  let skipReason = null;
  if (hold) skipReason = `on hold: ${describeHold(hold)}`;
  else if (!reminderBills.length) skipReason = overdueTotal > 0
    ? `no overdue bill qualifies (below ₹${config.minBillBalance}, on hold, or due date unknown)` : "nothing overdue";
  else if (netOverdue <= config.minCustomerNetOverdue) skipReason =
    `unadjusted advances/credits ₹${unadjustedCredits} cover the overdue ₹${chaseable} — reconcile instead of chasing`;
  else if (email.status !== "valid") skipReason = `email ${email.status} on the Tally ledger`;

  const oldest = Math.max(0, ...rows.filter((r) => !r.issue).map((r) => r.overdueDays));
  return {
    customer,
    retainer: ledger.retainer ? "yes" : "",
    email: email.emails.join(", "),
    emailStatus: email.status,
    ...(email.invalid.length && { invalidEmails: email.invalid }),
    hold: hold ? describeHold(hold) : null,
    buckets,
    unknownDueDate: round2(unknownDue),
    totalBills,
    overdueTotal,
    creditBills,
    onAccount: round2(onAccount),
    unadjustedCredits,
    netDue: round2(totalBills - creditBills + onAccount),
    netOverdue,
    oldestOverdueDays: oldest,
    reminder: skipReason ? { eligible: false, reason: skipReason }
      : { eligible: true, bills: reminderBills.map((r) => r.bill), amount: chaseable, netAmount: netOverdue },
  };
}

// §10 Ageing report: one line per customer that has anything open, plus totals.
export function buildAgeingReport({ asOf, ledgers, rows, credits, onAccount, holds, config }) {
  const names = new Set([...rows.map((r) => r.customer), ...credits.map((c) => c.customer),
    ...[...onAccount].filter(([, v]) => v !== 0).map(([k]) => k)]);
  const customers = [...names].sort().map((customer) => customerPosition({
    customer, ledger: ledgers.get(customer), holds, config,
    rows: rows.filter((r) => r.customer === customer),
    credits: credits.filter((c) => c.customer === customer),
    onAccount: onAccount.get(customer) ?? 0,
  })).sort((a, b) => b.oldestOverdueDays - a.oldestOverdueDays || b.netDue - a.netDue);

  const labels = bucketLabels(config.ageingBuckets);
  const total = (k) => round2(customers.reduce((s, c) => s + c[k], 0));
  const totals = {
    buckets: Object.fromEntries(labels.map((l) => [l, round2(customers.reduce((s, c) => s + c.buckets[l], 0))])),
    ...Object.fromEntries(["unknownDueDate", "totalBills", "overdueTotal", "creditBills", "onAccount", "netDue"].map((k) => [k, total(k)])),
  };
  const warnings = [
    ...rows.filter((r) => r.issue).map((r) => `${r.customer} / ${r.bill}: ${r.issue}`),
    ...rows.filter((r) => r.dueDateSource && r.dueDateSource !== "bill credit period" && r.dueDateSource !== "bill due date")
      .map((r) => `${r.customer} / ${r.bill}: due date from ${r.dueDateSource}`),
    ...customers.filter((c) => c.onAccount > 0).map((c) =>
      `${c.customer}: ₹${c.onAccount} of the balance has no bill reference (on account) — cannot be aged`),
    ...customers.filter((c) => c.emailStatus !== "valid").map((c) => `${c.customer}: email ${c.emailStatus}`),
  ];
  return { asOf: fmtDate(asOf), bucketLabels: labels, customers, totals, warnings };
}
