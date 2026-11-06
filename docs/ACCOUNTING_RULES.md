# Accounting rules — receivables, ageing and payment reminders

Every rule the code applies to outstanding amounts is listed here, with where the data comes from in
TallyPrime and which setting controls it. Settings live in [`config/receivables.json`](../config/receivables.json);
approved holds live in [`config/account-holds.json`](../config/account-holds.json).
Code: `lib/receivables.mjs` (reading Tally), `lib/ageing.mjs` (calculations), `lib/reminders.mjs` (draft checks).

**Nothing here writes to Tally.** All Tally access is read-only (XML "Export" requests).

Status of verification: rules were built and unit-tested against a simulated Tally that returns the same XML
shapes as TallyPrime. **They have not yet been compared with a live TallyPrime company.** Run
`npm run probe` with Tally open — it compares our numbers with Tally's own *Bills Receivable* report.

---

## 1. Source of outstanding amounts

| What | Tally source |
|---|---|
| Customers | Ledgers whose group is **Sundry Debtors** or any sub-group under it (`debtorsGroup`). Supplier ledgers are ignored, even if they have a debit balance. |
| Retainer customers | Ledgers under **Retainer Customers** or any sub-group under it (`retainerGroup`). |
| Open bills | Tally's `Bill` collection: one line per bill reference with its **closing balance**. |
| Customer balance | Ledger `ClosingBalance`. |

Tally sends debit (amount receivable) as a negative number; the code flips the sign so that
"customer owes us" is positive.

## 2. Bill date and due date (never treated as the same thing)

- **Bill date** = the bill reference's date in Tally (`BILLDUEDATE` JD attribute, or `BILLDATE`).
- **Due date** is decided in this order, and the source is always shown (`dueDateSource`):

| # | Source | When |
|---|---|---|
| 1 | Fixed due date on the bill | Credit period typed as a date, e.g. `15-Aug-2026` |
| 2 | Bill date + credit period on the bill | Credit period typed as days, e.g. `30 Days` |
| 3 | Bill date + the ledger's default credit period | Bill has no credit period (`dueDateFallback: "ledger-default"`) |
| 4 | Bill date | Neither bill nor ledger has a credit period. Same as Tally's own behaviour; flagged in the report |

- `dueDateFallback` can be `"ledger-default"` (above), `"bill-date"` (skip step 3) or `"none"` (no
  fallback: such bills are reported as *cannot be aged*).
- A credit period the code can't read (e.g. "2 Months") is **never guessed**: the bill is listed under
  *billsWithIssues*, kept out of ageing buckets, and no reminder can be drafted for it.

## 3. Overdue days and the ageing date

- Overdue days = ageing date − due date, in whole days. **Due today = 0 days overdue.** Never negative.
- "Today" is the date in India (`BUSINESS_TZ`, default Asia/Kolkata), not UTC.
- The report also shows **days since bill date** for reference. Ageing buckets use the due date.
- **Past ageing dates are refused** (`allowPastAsOf: false`). Reason: Tally returns *today's* bill balances,
  so ageing "as of 1 October" would already deduct payments received after 1 October. Future dates are
  allowed ("what will be overdue by month end"). `npm run probe` tests whether your Tally honours past
  dates; only then consider enabling it.

## 4. Ageing buckets

`ageingBuckets: [30, 60, 90]` gives: **Not due · 1-30 days · 31-60 days · 61-90 days · Over 90 days**.
A bill exactly 30 days overdue is in "1-30 days"; 31 days is in "31-60 days". Change the list to change the
buckets (must be increasing whole numbers).

## 5. Amount thresholds

- `minBillBalance` (₹100): bills with a smaller balance are **not chased** (no reminder; left out of
  `get_receivables.bills` and listed under *belowThreshold*). They **are** still included in the ageing
  report totals, so the report agrees with Tally.
- `minCustomerNetOverdue` (₹0): a customer is chased only if their **net overdue** (§7) is greater than this.
- `get_receivables` also takes `minOverdueDays` (e.g. 30, 60, 90) and `minAmount` per request.

## 6. Part payments and receipt adjustments

- A bill's balance in Tally is already net of receipts and credit notes entered **against that bill**
  (Agst Ref). The code uses that balance as the amount due — never the original invoice amount.
- With `includePayments` (MCP) or `npm run ageing`, each bill also shows the **billed** amount and every
  receipt / credit note adjusted against it, rebuilt from voucher bill allocations. If those vouchers
  don't add up to Tally's bill balance, the bill gets a note (e.g. an opening-balance bill has no voucher).

## 7. Advances, credit notes and on-account amounts

| Situation in Tally | How it appears | Effect |
|---|---|---|
| Receipt or credit note **against a bill** (Agst Ref) | Reduces that bill's balance | Already in the bill balance (§6) |
| **Advance** receipt, or credit note as a **new reference** | A bill reference with a *credit* balance | Listed as a credit (`creditBills`), not as a bill |
| **On Account** receipt / entry (no bill reference) | Ledger balance − sum of bill balances | `onAccount`: negative = unallocated credit, positive = unallocated debit |

- **Unadjusted credits** = credit bills + on-account credit.
- **Net overdue** = overdue bills that may be chased (§5, §8) − unadjusted credits. Credits are assumed to
  settle the oldest (overdue) bills first, as an accountant would adjust them.
- **No reminder if net overdue ≤ 0** — the accounts need reconciling (adjust the advance/credit in
  Tally), not a payment chase. Otherwise the reminder shows the bills and a "less advances/credits" line.
- **Net due** = all open bills − credit bills + on account = the customer's ledger balance.
- An on-account **debit** (balance with no bill reference) cannot be aged; it is listed as a warning.

## 8. Disputed / on-hold accounts

- Approved holds are listed in `config/account-holds.json` (path: `holdsFile`). Each needs `customer`,
  `reason`, `approvedBy`, `approvedOn`; optional `bill` (hold one bill only) and `until` (last day).
- A hold is active from `approvedOn` to `until` inclusive. Expired holds are ignored and listed as warnings.
- Held customers / bills **stay in the ageing report** (marked) but **no reminder can be drafted** — this is
  enforced in code, not just in the Claude skill.
- If the holds file is broken, drafting stops with an error. It is never treated as "no holds".
- Customer names are matched case-insensitively; a hold that matches no ledger is reported.

## 9. Customer email addresses

- Taken only from the customer's ledger in Tally (one field; several addresses separated by `,` or `;`).
- Status: **valid**, **missing** or **invalid** (format check; duplicates removed). No DNS/mailbox check.
- No reminder is drafted unless the status is valid.

## 10. Ageing report

`npm run ageing` (or MCP tool `get_ageing_report`) — one line per customer:
Retainer flag · amount per ageing bucket · unknown due date · total bills · overdue · credit bills ·
on account · net due · net overdue · oldest overdue days · hold · email status · reminder decision,
plus a TOTAL line and warnings. CSV files are written to `reports/` (customer-wise and bill-wise).

## Reminder checks (all enforced in `save_reminder_draft`)

Recipient from the Tally ledger · bill open in Tally · due date known · bill overdue (> 0 days) ·
balance ≥ `minBillBalance` · bill and customer not on hold · net overdue > `minCustomerNetOverdue` ·
bill mentioned in the email body · not drafted in the last `REMINDER_COOLDOWN_DAYS` (7) days.

## Open points to confirm with live Tally (`npm run probe`)

1. XML shape of `BillCreditPeriod` on ledgers (default credit period) and of groups.
2. Whether credit periods are ever stored in a format other than "N Days" or a date.
3. Whether advances / new-reference credit notes appear in the `Bill` collection with a credit balance.
4. Whether voucher exports include bill allocations (needed for payment history).
5. Whether Tally honours a past date for bill balances (needed before `allowPastAsOf` can be enabled).
