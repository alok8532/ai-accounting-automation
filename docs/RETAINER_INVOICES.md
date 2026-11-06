# Monthly Retainer invoices (Capability 4 / Workflow A)

Creates one Sales invoice per Retainer customer for a month in Tally, exports the invoice PDF and saves an
email draft with the PDF attached. Nothing is ever sent. This is the **only** workflow in the project that
writes to Tally.

## Rules (enforced in `lib/retainer-invoices.mjs`)

| Rule | How |
|---|---|
| Who is billed | Customers in the Tally group **Retainer Customers** (and its sub-groups) — `retainerGroup` in `config/receivables.json`. Never by name. |
| What is billed | Only the agreed terms in `config/retainer-billing.json`: monthly fee, description, income ledger, GST ledgers/rates. A Retainer customer without terms is shown as `needs_setup` — never guessed. |
| Invoice date | `invoiceDay` of the billing month (default the 1st). Must be in `allowedInvoiceDays` (TallyPrime EDU accepts only the 1st, 2nd and 31st). Future dates are refused. |
| Due date | Invoice date + the customer ledger's default credit period in Tally. No credit period → `blocked`. |
| Bill reference | `RET/<YYYY-MM>/<code>`, e.g. `RET/2026-11/SHARMA`, with credit period, so ageing and reminders work on it. Voucher number: Tally's own numbering. |
| Duplicate | Blocked if Tally already has the `[retainer:<month>:<code>]` tag / bill reference, or a Sales voucher to that customer in that month with "Retainer" in its narration, or the audit log says it was created. Other Sales vouchers in the month are shown as a note. |
| Approval | `preview_retainer_invoices` returns an approval code (hash of exactly the invoices shown, valid today). `create_retainer_invoices` needs it, re-runs the preview and refuses if anything changed. In Claude Desktop the user also clicks **Allow** for the create tool. |
| Write switch | `INVOICE_WRITE_ENABLED=true` in `.env` **and** the Tally company must equal `writeCompany` in the config **and** be open in Tally. |
| Failures | A "pending" audit line is written before each write. Tally error → `error` (safe to try again later). No clear answer → `unknown`: blocked for 10 minutes, then allowed only if Tally shows no such invoice. Created but cannot be read back / total differs → `created_unverified`, blocked until checked. Nothing is ever retried automatically. |
| Verification | After creating, the voucher is read back from Tally and its total compared with the preview. |
| PDF | Tally's own **Printed Invoice** for that voucher, exported as HTML and printed to PDF with Microsoft Edge (headless) → `invoices/<month>/` (git-ignored). |
| Email | Template in `config/retainer-billing.json` (`email.subject` / `email.body`), recipient from the Tally ledger. Local `.eml` in `drafts/<date>/`, or Gmail draft + local copy. One draft per invoice. |

## Use

1. **Back up the company in Tally** (Alt+Y Data → Backup) before the first run.
2. Add `INVOICE_WRITE_ENABLED=true` to `.env`, restart Claude.
3. In Claude: *"Prepare this month's Retainer invoices and save the emails in Gmail drafts."*
   Claude shows the preview, asks for confirmation, then creates.
4. Check in Tally (Day Book), review the drafts, send them yourself.
5. Set `INVOICE_WRITE_ENABLED=false` again when not billing.

`npm run invoices:preview [YYYY-MM]` shows the same preview in the terminal (read-only).

## Before real (client) use — accounting must confirm

- Monthly fee, description and income ledger per customer, GST ledgers and rates (current values are DEMO).
- Invoice day, billing in advance vs. in arrears, invoice template/numbering, item vs. accounting invoice.
- Email wording and signature.
- Run on a backup / non-production company first.
