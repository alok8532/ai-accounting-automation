---
name: retainer-invoices
description: Prepare the monthly Retainer invoices in Tally and save an email draft with each invoice PDF. Use when the user asks to raise/prepare/create this month's Retainer invoices, monthly retainer billing, or to email Retainer invoices. Always shows a preview and needs the user's explicit confirmation before anything is created in Tally — never sends emails.
---

# Monthly Retainer invoices

Create one Sales invoice per Retainer customer for a billing month in Tally, export the invoice PDF, and save an email draft with the PDF attached for the user to review and send. **You never send emails.** Creating invoices is a real accounting entry: it happens **only after the user confirms the preview**.

Always say "Retainer" for these customers and invoices — never "recurring".

## Workflow

1. Call `tally_status`. If Tally is not reachable or the expected company is not open, stop and tell the user what to fix.
2. Call `preview_retainer_invoices` (pass `period` as `YYYY-MM` only if the user named a month; default is the current month).
3. **Show the preview** as a table: Customer | Bill ref | Fee | GST | Total | Invoice date | Due date | Email to | Status.
   - Amounts in Indian format with ₹ (₹47,200), dates as DD-Mon-YYYY.
   - Then list, per customer, every `issues` (why it is blocked) and `notes`, and every top-level `warnings` entry.
   - `already_invoiced`: say which voucher already exists (`existing`). `needs_setup`: the agreed fee etc. is missing in `config/retainer-billing.json` — the accountant must add it; never suggest an amount yourself.
   - If `writeEnabled` is false, say that invoice creation is switched off (`INVOICE_WRITE_ENABLED=true` in `.env`, after a Tally backup) and stop after the preview.
4. **Ask for confirmation**: "Shall I create these N invoices in Tally (company …) for <month>, total ₹…? Drafts will be saved in <Gmail / local files>." Wait for an explicit yes in the conversation. If the user changes anything (amount, customer), do not edit values yourself — the change has to be made in Tally or the config, then preview again.
5. Only after a clear yes: call `create_retainer_invoices` with the `approvalCode` from that preview (plus `period`/`customers` if the user limited it). Leave `destination` out to use the configured default; pass `"gmail"` or `"local"` only if the user asked for a specific place.
   - If it fails with "does not match the current data": something changed — preview again and ask again.
   - Never call it a second time to retry an invoice with status `error`, `unknown` or `created_unverified`. Report it.
6. Report a result table: Customer | Bill ref | Tally voucher no. | Total | Invoice status | Draft (Gmail draft saved / local file / not saved + reason).
   - `unknown` or `created_unverified`: tell the user to check Tally's Day Book for that customer before doing anything else.
   - Draft `rejected` (no email) or `error`: once fixed, `save_invoice_drafts` creates the missing drafts (it never creates invoices).
   - End with: "Nothing was sent. Review the drafts and send them yourself."

## Rules

- Never create an invoice without the preview + explicit confirmation in this conversation, even if the user asked earlier "create them all".
- Never invent or change fees, GST, dates, ledgers or recipients. They come only from Tally and `config/retainer-billing.json`.
- Customers are Retainer customers only because they are in the Tally Retainer group — never decide by their name.
- Do not create receipts, credit notes or any other Tally entry.
