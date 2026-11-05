// Controlled reminder-draft creation. The rules live HERE, in code, not in the skill prompt:
//  1. Recipient email is read from the customer's Tally ledger — the caller cannot supply it.
//  2. Every bill must be an open receivable of that customer in Tally, and be named in the body.
//  3. Duplicate check: a bill already drafted within REMINDER_COOLDOWN_DAYS is skipped.
//     Re-drafting the same customer on the same day is allowed (it overwrites that day's file).
//  4. Every attempt (saved / skipped / rejected / error) is written to the audit log.

import { getLedgers, getReceivables } from "./receivables.mjs";
import { saveDraft } from "./drafts.mjs";
import { audit, readAudit } from "./audit.mjs";

const DAY = 86400000;
export const COOLDOWN_DAYS = Number(process.env.REMINDER_COOLDOWN_DAYS ?? 7);

class Rejected extends Error {}
const reject = (msg) => { throw new Rejected(msg); };

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const dayOf = (d) => new Date(d).toISOString().slice(0, 10); // same day key as the drafts folder

// Exact ledger name first; otherwise a unique case-insensitive match.
function resolveLedger(ledgers, customer) {
  if (ledgers.has(customer)) return customer;
  const hits = [...ledgers.keys()].filter((n) => n.trim().toLowerCase() === customer.trim().toLowerCase());
  if (hits.length === 1) return hits[0];
  reject(`Customer "${customer}" was not found as a ledger in Tally. Use the exact ledger name.`);
}

export async function createReminderDraft({ customer, bills, subject, body, now = new Date() }) {
  bills = [...new Set(bills.map((b) => b.trim()))];
  const base = { action: "reminder_draft", customer, bills };

  try {
    // 1. Customer + recipient from Tally only.
    const ledgers = await getLedgers();
    const name = resolveLedger(ledgers, customer);
    const emails = (ledgers.get(name).email ?? "").split(/[,;]/).map((e) => e.trim()).filter(Boolean);
    if (!emails.length) reject(`Ledger "${name}" has no email in Tally. Add it to the ledger, then retry.`);
    const bad = emails.filter((e) => !EMAIL.test(e));
    if (bad.length) reject(`Ledger "${name}" has an invalid email in Tally (${bad.join(", ")}). Fix the ledger, then retry.`);
    const to = emails.join(", ");

    // 2. Bills must be open receivables of this customer, and must appear in the email.
    const open = new Map((await getReceivables(now, ledgers)).filter((r) => r.customer === name).map((r) => [r.bill, r]));
    const notOpen = bills.filter((b) => !open.has(b));
    if (notOpen.length) reject(`Not open receivable bills of "${name}" in Tally: ${notOpen.join(", ")}.`);
    const notInBody = bills.filter((b) => !body.includes(b));
    if (notInBody.length) reject(`The email body does not mention bill(s): ${notInBody.join(", ")}.`);

    // 3. Duplicate check against earlier saved drafts.
    if (COOLDOWN_DAYS > 0) {
      const today = dayOf(now);
      const earlier = (await readAudit()).filter((e) =>
        e.action === "reminder_draft" && e.status === "saved" &&
        now - new Date(e.at) < COOLDOWN_DAYS * DAY &&
        !(e.customer === name && dayOf(e.at) === today)); // same customer, same day = refresh, allowed
      const dupes = bills.flatMap((b) => {
        const prev = earlier.findLast((e) => e.bills?.some((x) => x.bill === b));
        return prev ? [{ bill: b, draftedAt: prev.at, file: prev.file }] : [];
      });
      if (dupes.length) {
        await audit({ ...base, customer: name, status: "skipped_duplicate", duplicates: dupes });
        return {
          saved: false, status: "skipped_duplicate", customer: name, duplicates: dupes,
          message: `Already drafted within the last ${COOLDOWN_DAYS} days — not drafted again.`,
        };
      }
    }

    // 4. Save + audit.
    const file = await saveDraft({ customer: name, to, subject, body, date: now });
    const billRows = bills.map((b) => ({ bill: b, outstanding: open.get(b).outstanding, overdueDays: open.get(b).overdueDays }));
    const totalDue = billRows.reduce((s, r) => s + r.outstanding, 0);
    await audit({ ...base, customer: name, status: "saved", to, subject, bills: billRows, totalDue, file });
    return { saved: true, status: "saved", sent: false, customer: name, to, bills: billRows, totalDue, file };
  } catch (e) {
    const status = e instanceof Rejected ? "rejected" : "error";
    await audit({ ...base, status, reason: e.message }).catch(() => {}); // never hide the original error
    throw e;
  }
}
