// Shared receivables views for the MCP tools and CLI scripts: applies the documented rules
// (asOf policy, holds, thresholds, filters) on top of loadReceivables(). Read-only.

import { loadReceivables, getBillHistory, attachHistory } from "./receivables.mjs";
import { buildAgeingReport, checkAsOf } from "./ageing.mjs";
import { loadHolds, activeHolds, holdFor, describeHold } from "./holds.mjs";
import { businessDate, toDateOnly, fmtDate } from "./dates.mjs";
import { CONFIG } from "./config.mjs";

export async function ageingView({ asOf, customer, retainerOnly = false, includePayments = false, now = new Date(), config = CONFIG } = {}) {
  const today = businessDate(now);
  const day = asOf ?? today;
  checkAsOf(day, today, config.allowPastAsOf);

  const allHolds = await loadHolds(config.holdsPath);
  const holds = activeHolds(allHolds, today); // holds are about what we may do today
  const data = await loadReceivables(day, { config });

  const keep = (name) => (!customer || name.toLowerCase().includes(customer.toLowerCase())) &&
    (!retainerOnly || data.ledgers.get(name)?.retainer);
  let rows = data.rows.filter((r) => keep(r.customer));
  if (includePayments) rows = attachHistory(rows, await getBillHistory(data.ledgers));
  const credits = data.credits.filter((c) => keep(c.customer));
  const onAccount = new Map([...data.onAccount].filter(([k]) => keep(k)));

  const report = buildAgeingReport({ asOf: toDateOnly(day), ledgers: data.ledgers, rows, credits, onAccount, holds, config });
  const known = new Set(data.ledgers.keys());
  report.warnings.push(
    ...holds.filter((h) => ![...known].some((k) => k.toLowerCase() === h.customer.trim().toLowerCase()))
      .map((h) => `Hold for "${h.customer}" does not match any ledger in Tally — check the name in the holds file`),
    ...allHolds.filter((h) => h.until && h.until < today).map((h) => `Hold for "${h.customer}"${h.bill ? ` / ${h.bill}` : ""} expired on ${h.until}`),
  );
  return { asOf: day, rows, credits, onAccount, holds, report, ledgers: data.ledgers };
}

// The get_receivables view: bills worth chasing, plus everything that was left out and why.
export async function receivablesView({ minOverdueDays = 0, minAmount = CONFIG.minBillBalance, ...opts } = {}) {
  const v = await ageingView(opts);
  const held = (r) => holdFor(v.holds, r.customer, r.bill);
  const due = v.rows.filter((r) => !r.issue && r.overdueDays >= minOverdueDays);
  const bills = due.filter((r) => !held(r) && r.outstanding >= minAmount);
  const onHold = due.filter(held).map((r) => ({ customer: r.customer, bill: r.bill, outstanding: r.outstanding,
    overdueDays: r.overdueDays, hold: describeHold(held(r)) }));
  const small = due.filter((r) => !held(r) && r.outstanding < minAmount);
  const billsWithIssues = v.rows.filter((r) => r.issue);
  const names = new Set(due.map((r) => r.customer));
  const customers = v.report.customers.filter((c) => names.has(c.customer)).map((c) => ({
    customer: c.customer, retainer: c.retainer, email: c.email, emailStatus: c.emailStatus, hold: c.hold,
    overdueTotal: c.overdueTotal, unadjustedCredits: c.unadjustedCredits, netOverdue: c.netOverdue,
    oldestOverdueDays: c.oldestOverdueDays, reminder: c.reminder,
  }));
  const sum = (xs) => Math.round(xs.reduce((s, r) => s + r.outstanding, 0) * 100) / 100;
  return {
    asOf: v.asOf,
    filters: { minOverdueDays, minAmount, ...(opts.customer && { customer: opts.customer }), ...(opts.retainerOnly && { retainerOnly: true }) },
    count: bills.length,
    totalOutstanding: sum(bills),
    bills,
    customers,
    ...(onHold.length && { onHold }),
    ...(small.length && { belowThreshold: { count: small.length, total: sum(small), bills: small.map((r) => `${r.customer} / ${r.bill}`) } }),
    ...(billsWithIssues.length && { billsWithIssues }),
    ...(v.report.warnings.length && { warnings: v.report.warnings }),
  };
}

export { fmtDate };
