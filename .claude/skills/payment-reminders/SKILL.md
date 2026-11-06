---
name: payment-reminders
description: Draft payment reminder emails for customers with overdue bills in Tally. Use when the user asks to chase payments, follow up on overdue invoices/outstanding/receivables, send or draft reminders, put reminders in Gmail drafts, or "who hasn't paid". Reads live data with the tally MCP tools and saves drafts for human review (local .eml files or the user's Gmail Drafts folder) — never sends.
---

# Payment reminders

Draft one reminder email per customer with overdue bills, using live Tally data, and save each as a draft for the user to review. **You never send emails and never change anything in Tally.**

## Company details (edit for the client)

- Company name: **Shauryam Solutions Pvt. Ltd.**
- Signature:
  ```
  Regards,
  Accounts Team
  Shauryam Solutions Pvt. Ltd.
  ```

## Workflow

1. Call `tally_status`. If Tally is not reachable or the expected company is not open, stop and tell the user what to fix.
2. Call `get_receivables` with `minOverdueDays: 1` (today's date is the default; past dates are refused by the tool — tell the user why if they ask for one). Apply any filter the user asked for (one customer, Retainer only, more than N days, above an amount → `minAmount`). If the result has `billsWithIssues` (bills whose due date can't be worked out), do not draft for those bills — list them under "Flag for the user".
3. **Use `customers` to decide who gets an email.** Draft only for customers with `reminder.eligible: true`, and include exactly the bills in `reminder.bills`. For every other customer, report `reminder.reason` (on hold, credits cover the dues, email missing, below threshold…) — do not draft. One email per customer; the tier is decided by their **oldest** bill in `reminder.bills`.
4. Pick the tier and tone using the rules below, then write the email from the matching template.
5. Save all the emails in one call with `save_reminder_drafts` (`drafts`: one item per customer with `customer` (exact ledger name), `bills` (the bill numbers in that email), `subject`, `body` (plain text — the tool builds the HTML version itself)). For a single customer, `save_reminder_draft` with the same fields also works. You do not pass an email address: the tool takes it from the customer's Tally ledger.
   - **Where to save (`destination`)**: leave it out to use the configured default (the tool description says which). Pass `"gmail"` if the user asks for Gmail drafts (the draft goes into their Gmail Drafts folder), or `"local"` if they ask for local files (.eml in the project's drafts/ folder). Never say an email was sent: these are drafts the user reviews and sends themselves.
   - `status: "skipped_duplicate"`: these bills were already drafted recently (or are already in a Gmail draft today). Do not retry and do not change the bill list to get around it. Report it to the user. If the source is `unconfirmed gmail attempt`, ask the user to check their Gmail Drafts folder.
   - `status: "rejected"` / `"error"` (single tool: "Draft not saved: …"): do not retry with changes to get around the check. Report the reason to the user.
   - `status: "not_processed"` with a Gmail reason (not connected / login expired): nothing was saved. Tell the user to run `npm run gmail:auth`, then ask whether to retry in Gmail or save locally instead — do not switch to local on your own.
   - `replacedTodaysDraft: true`: today's earlier local draft for this customer was overwritten. If `droppedBills` is not empty, tell the user those bills are no longer in any draft.
6. Reply to the user with a summary table: Customer | Bills | Total due | Max days overdue | Tier | Result (Gmail draft saved / local file saved / skipped duplicate / not saved + reason). For Gmail, end with "The drafts are in your Gmail Drafts folder (<gmailAccount>) — review and send them from Gmail." After the table, list anything that needs a human decision (see "Flag for the user").

If the user only wants to *see* drafts, show them in chat and ask before saving.

## Tier rules

| Days overdue (oldest bill) | Tier | Tone |
|---|---|---|
| 1–45 | **Friendly reminder** | Polite, assumes it was missed |
| 46–90 | **Firm follow-up** | Clear and direct, asks for a payment date |
| 91+ | **Final reminder** | Serious, asks for payment within 7 days |

**Retainer customers** (`retainer: "yes"`) are ongoing relationships:
- Never use the Final reminder template for them. Cap them at **Firm follow-up**, written warmly.
- If a retainer customer is 91+ days overdue, still draft the Firm follow-up, and flag it so the owner can call them personally.

## Writing rules

- Amounts in Indian format with the rupee symbol: **₹2,14,260** (not ₹214,260 or Rs. 214260). Use the `outstanding` value (it is the balance due, already net of part payments).
- Dates as **DD-Mon-YYYY**, e.g. 01-Jul-2026.
- Always call the amount the **balance** (never "invoice amount") — part payments are already deducted.
- Always include: invoice number(s), invoice date, due date, balance, and a total line if more than one bill.
- If the customer has `unadjustedCredits` > 0 (an advance or credit note not yet adjusted), add after the total: `Less: advance/credit not yet adjusted ₹{unadjustedCredits}` and `Net amount payable: ₹{reminder.netAmount}`, and ask for the net amount.
- Always give an easy way out: "If you have already made this payment, please share the UTR/transaction reference so we can update our records."
- Keep it short: under ~150 words of body text before the bill table.
- Never threaten legal action, penalties, interest, or stopping supply/service unless the user explicitly tells you to.
- Never invent bank details, phone numbers, or names. Use only the signature above.
- Address the customer as "Dear <Customer name> Accounts Team".

## Templates

Fill in `{…}`. For several bills, list one bill line per bill (oldest first), then a total line, and use the subject with "{n} invoices – {total}" instead of the single invoice. Example:

```
Invoice DEMO-001 | Dated 01-Jun-2026 | Due 01-Jul-2026 | Balance ₹59,000
Invoice DEMO-009 | Dated 02-Oct-2026 | Due 01-Nov-2026 | Balance ₹23,600
Total balance due: ₹82,600
```

In the opening sentence, say "invoices" instead of "invoice" when there are several. `{days}` is the oldest bill's days overdue.

### Friendly reminder (1–45 days)

Subject: `Payment reminder: Invoice {bill} – {amount} due`

```
Dear {customer} Accounts Team,

I hope you are doing well. This is a gentle reminder that the following invoice is now past its due date:

Invoice {bill} | Dated {billDate} | Due {dueDate} | Balance {amount}

We understand these things can slip through. We would be grateful if you could arrange the payment at your earliest convenience.

If you have already made this payment, please share the UTR/transaction reference so we can update our records.

{signature}
```

### Firm follow-up (46–90 days)

Subject: `Overdue payment: Invoice {bill} – {amount} ({days} days overdue)`

```
Dear {customer} Accounts Team,

Our records show the following amount is now {days} days overdue:

Invoice {bill} | Dated {billDate} | Due {dueDate} | Balance {amount}

We request you to clear this payment at the earliest. Could you please reply with the date by which we can expect the payment?

If you have already made this payment, please share the UTR/transaction reference so we can update our records. If there is any query on this invoice, please let us know so we can resolve it quickly.

{signature}
```

For **retainer customers** in this tier, open with a line of appreciation, e.g. "Thank you for your continued association with us." and keep the rest of the template the same.

### Final reminder (91+ days, non-retainer only)

Subject: `Final reminder: Invoice {bill} – {amount} overdue since {dueDate}`

```
Dear {customer} Accounts Team,

This is a final reminder regarding the following payment, which remains outstanding for {days} days:

Invoice {bill} | Dated {billDate} | Due {dueDate} | Balance {amount}

We request you to clear this amount within 7 days of this email. If there is a reason for the delay or any dispute on the invoice, please contact us immediately so we can discuss it.

If you have already made this payment, please share the UTR/transaction reference so we can update our records.

{signature}
```

## Flag for the user

After the summary, list these explicitly (do not hide them in the drafts):
- Customers with **no email** in Tally: no draft saved; tell the user to add the email to the ledger.
- Bills **skipped as duplicates**: show when they were last drafted; the user decides whether the earlier draft was sent.
- **Retainer customers 91+ days overdue**: recommend a personal call from the owner.
- Customers whose **total due exceeds ₹1,00,000**: recommend a phone follow-up alongside the email.
- Any bill that looks odd (e.g. negative or zero balance, missing due date): do not draft; mention it.
- **On hold** (`onHold`, or `customers[].hold`): show the reason and who approved it. Never draft for them.
- **Credits cover the dues** (reminder reason mentions advances/credits): recommend the accountant adjusts the advance/credit note against the bills in Tally.
- **Below threshold** (`belowThreshold`): mention the count and total; no reminder.
- Anything in `warnings` (e.g. due date taken from the ledger default, amounts on account, expired holds).
- For a full customer-wise ageing picture, use `get_ageing_report`.
