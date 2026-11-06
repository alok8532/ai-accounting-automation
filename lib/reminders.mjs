// Controlled reminder-draft creation. The rules live HERE, in code, not in the skill prompt:
//  1. Recipient email is read from the customer's Tally ledger — the caller cannot supply it.
//  2. Every bill must be an open receivable of that customer in Tally, have a usable due date, be
//     overdue, be at least minBillBalance, not be on hold, and be named in the body. The customer
//     must not be on hold and must still owe money after unadjusted advances/credits (netOverdue > 0).
//     Rules and values: docs/ACCOUNTING_RULES.md + config/receivables.json + config/account-holds.json.
//  3. Duplicate check: a bill of THIS customer already drafted within REMINDER_COOLDOWN_DAYS is skipped.
//     Sources: the audit log, plus earlier draft files on disk (catches drafts with no audit line).
//     Re-drafting the same customer on the same day is allowed: it overwrites that day's file, and the
//     overwritten draft no longer counts for the duplicate check.
//  4. Every attempt (saved / skipped / rejected / error) is written to the audit log.

import { getLedgers, loadReceivables } from "./receivables.mjs";
import { customerPosition } from "./ageing.mjs";
import { checkEmails } from "./email.mjs";
import { loadHolds, activeHolds, holdFor, describeHold } from "./holds.mjs";
import { CONFIG } from "./config.mjs";
import { saveDraft, draftFile, findEarlierDrafts } from "./drafts.mjs";
import { audit, readAudit } from "./audit.mjs";
import { DAY, businessDate } from "./dates.mjs";

export const COOLDOWN_DAYS = Number(process.env.REMINDER_COOLDOWN_DAYS ?? 7);

class Rejected extends Error {}
const reject = (msg) => { throw new Rejected(msg); };

const billNo = (x) => (typeof x === "string" ? x : x?.bill);
// Windows paths are case-insensitive, and the drive letter may be "d:" or "D:" depending on how we were launched.
const fileKey = (f) => (process.platform === "win32" ? String(f).toLowerCase() : String(f));

// Exact ledger name first; otherwise a unique case-insensitive match.
function resolveLedger(ledgers, customer) {
  if (ledgers.has(customer)) return customer;
  const hits = [...ledgers.keys()].filter((n) => n.trim().toLowerCase() === customer.trim().toLowerCase());
  if (hits.length === 1) return hits[0];
  reject(`Customer "${customer}" was not found as a ledger in Tally. Use the exact ledger name.`);
}

// Saved drafts that still exist: when a file was overwritten (same customer, same day), only its
// latest audit entry describes what is actually in it.
function liveSavedDrafts(entries) {
  const latest = new Map();
  for (const e of entries) if (e.action === "reminder_draft" && e.status === "saved") latest.set(fileKey(e.file), e);
  return [...latest.values()];
}

export async function createReminderDraft({ customer, bills, subject, body, now = new Date() }) {
  bills = [...new Set(bills.map((b) => b.trim()))];
  const base = { action: "reminder_draft", customer, bills };

  try {
    // 1. Customer + recipient from Tally only.
    const ledgers = await getLedgers();
    const name = resolveLedger(ledgers, customer);
    const email = checkEmails(ledgers.get(name).email);
    if (email.status === "missing") reject(`Ledger "${name}" has no email in Tally. Add it to the ledger, then retry.`);
    if (email.status === "invalid") reject(`Ledger "${name}" has an invalid email in Tally (${email.invalid.join(", ")}). Fix the ledger, then retry.`);
    const to = email.emails.join(", ");

    // 2. Bills: open, ageable, not on hold, overdue, above threshold; customer still owes after credits.
    const holds = activeHolds(await loadHolds(), businessDate(now));
    const data = await loadReceivables(now, { ledgers });
    const mine = data.rows.filter((r) => r.customer === name);
    const open = new Map(mine.map((r) => [r.bill, r]));
    const notOpen = bills.filter((b) => !open.has(b));
    if (notOpen.length) reject(`Not open receivable bills of "${name}" in Tally: ${notOpen.join(", ")}.`);
    const odd = bills.filter((b) => open.get(b).issue);
    if (odd.length) reject(`Bill(s) cannot be aged — fix them in Tally first: ${odd.map((b) => `${b} (${open.get(b).issue})`).join("; ")}.`);
    const held = bills.map((b) => [b, holdFor(holds, name, b)]).filter(([, h]) => h);
    if (held.length) reject(`On hold — no reminder allowed: ${held.map(([b, h]) => `${b}: ${describeHold(h)}`).join("; ")}.`);
    const notDue = bills.filter((b) => !(open.get(b).overdueDays > 0));
    if (notDue.length) reject(`Not overdue yet: ${notDue.map((b) => `${b} (due ${open.get(b).dueDate})`).join(", ")}.`);
    const small = bills.filter((b) => open.get(b).outstanding < CONFIG.minBillBalance);
    if (small.length) reject(`Balance below the ₹${CONFIG.minBillBalance} reminder threshold: ${small.join(", ")}.`);
    const pos = customerPosition({ customer: name, ledger: ledgers.get(name), rows: mine, holds, config: CONFIG,
      credits: data.credits.filter((c) => c.customer === name), onAccount: data.onAccount.get(name) ?? 0 });
    if (!pos.reminder.eligible) reject(`No reminder for "${name}": ${pos.reminder.reason}.`);
    const notInBody = bills.filter((b) => !body.includes(b));
    if (notInBody.length) reject(`The email body does not mention bill(s): ${notInBody.join(", ")}.`);

    const file = draftFile(name, now);
    const today = businessDate(now);
    const live = liveSavedDrafts(await readAudit());

    // Two different ledgers can map to the same file name ("A & B" / "A-B"): never overwrite another customer.
    const other = live.find((e) => fileKey(e.file) === fileKey(file) && e.customer !== name);
    if (other) reject(`Customers "${other.customer}" and "${name}" share the draft file name ${file}, and today's file is already ` +
      `"${other.customer}"'s. Draft "${name}" manually today, or retry tomorrow.`);

    // 3. Duplicate check (key = customer + bill).
    if (COOLDOWN_DAYS > 0) {
      const earlier = live.filter((e) =>
        e.customer === name && now - new Date(e.at) < COOLDOWN_DAYS * DAY &&
        businessDate(e.at) !== today); // same day = refresh, allowed
      const dupes = bills.flatMap((b) => {
        const prev = earlier.findLast((e) => e.bills?.some((x) => billNo(x) === b));
        return prev ? [{ bill: b, draftedAt: prev.at, file: prev.file, source: "audit log" }] : [];
      });
      const othersFiles = new Set(live.filter((e) => e.customer !== name).map((e) => fileKey(e.file)));
      const fromFiles = await findEarlierDrafts({
        customer: name, bills: bills.filter((b) => !dupes.some((d) => d.bill === b)), now, days: COOLDOWN_DAYS,
        skipFile: (f) => othersFiles.has(fileKey(f)), // same file name, but the audit log says it's another customer's
      });
      dupes.push(...fromFiles);
      if (dupes.length) {
        await audit({ ...base, customer: name, status: "skipped_duplicate", duplicates: dupes });
        return {
          saved: false, status: "skipped_duplicate", customer: name, duplicates: dupes,
          message: `Already drafted within the last ${COOLDOWN_DAYS} days — not drafted again.`,
        };
      }
    }

    // 4. Save + audit. If this refreshes today's draft, say which bills dropped out of it.
    const replaced = live.find((e) => fileKey(e.file) === fileKey(file) && e.customer === name);
    const droppedBills = (replaced?.bills ?? []).map(billNo).filter((b) => !bills.includes(b));
    await saveDraft({ customer: name, to, subject, body, date: now });
    const billRows = bills.map((b) => ({ bill: b, outstanding: open.get(b).outstanding, overdueDays: open.get(b).overdueDays }));
    const totalDue = Math.round(billRows.reduce((s, r) => s + r.outstanding, 0) * 100) / 100;
    const credit = pos.unadjustedCredits ? { unadjustedCredits: pos.unadjustedCredits, netOverdue: pos.netOverdue } : {};
    await audit({ ...base, customer: name, status: "saved", to, subject, bills: billRows, totalDue, ...credit, file,
      ...(replaced && { replacedDraftAt: replaced.at, droppedBills }) });
    return {
      saved: true, status: "saved", sent: false, customer: name, to, bills: billRows, totalDue, ...credit, file,
      ...(replaced && { replacedTodaysDraft: true, droppedBills }),
    };
  } catch (e) {
    const status = e instanceof Rejected ? "rejected" : "error";
    await audit({ ...base, status, reason: e.message }).catch(() => {}); // never hide the original error
    throw e;
  }
}
