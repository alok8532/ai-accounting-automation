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
//  5. Destination "local" = .eml file in drafts/. "gmail" = a draft in the connected Gmail account only
//     (lib/gmail — draft creation only, sending is impossible); no local copy. Default: REMINDER_DRAFT_DESTINATION.
//     A Gmail draft lives in Gmail, so it keeps counting for the duplicate check (from the audit log),
//     and a bill already in a Gmail draft TODAY is skipped (we never overwrite a
//     draft the user may have edited in Gmail). A Gmail call that never finished ("gmail_pending" with no
//     result) is treated as a possible draft: skipped, and the user is asked to check Gmail.

import { randomUUID } from "node:crypto";
import { getLedgers, loadReceivables } from "./receivables.mjs";
import { customerPosition } from "./ageing.mjs";
import { checkEmails } from "./email.mjs";
import { loadHolds, activeHolds, holdFor, describeHold } from "./holds.mjs";
import { CONFIG } from "./config.mjs";
import { saveDraft, draftFile, findEarlierDrafts } from "./drafts.mjs";
import { audit, readAudit } from "./audit.mjs";
import { DAY, businessDate } from "./dates.mjs";
import { loadDotEnv } from "./env.mjs";
import { createGmailDraft } from "./gmail/client.mjs";
import { connectedAccount, getAccessToken } from "./gmail/oauth.mjs";

loadDotEnv(); // so REMINDER_COOLDOWN_DAYS / REMINDER_DRAFT_DESTINATION in .env apply
export const COOLDOWN_DAYS = Number(process.env.REMINDER_COOLDOWN_DAYS ?? 7);
export const DESTINATIONS = ["local", "gmail"];
export const MAX_BATCH = 50;

export function resolveDestination(d) {
  loadDotEnv();
  const v = String(d || process.env.REMINDER_DRAFT_DESTINATION || "local").trim().toLowerCase();
  if (!DESTINATIONS.includes(v)) throw new Error(`Draft destination must be "local" or "gmail" (got "${d ?? process.env.REMINDER_DRAFT_DESTINATION}")`);
  return v;
}

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

// Drafts that still exist, from the audit log:
//  - local files: when a file was overwritten (same customer, same day), only its latest entry counts;
//  - Gmail drafts: always (a later local file for the same customer does not touch the draft in Gmail);
//  - unconfirmed: Gmail calls that started but never recorded a result (process killed mid-call).
function draftState(entries) {
  const saved = entries.filter((e) => e.action === "reminder_draft" && e.status === "saved");
  const latestByFile = new Map();
  for (const e of saved) if (e.file) latestByFile.set(fileKey(e.file), e);
  const latest = new Set(latestByFile.values());
  const finished = new Set(entries.filter((e) => e.attemptId && e.status !== "gmail_pending").map((e) => e.attemptId));
  return {
    live: saved.filter((e) => latest.has(e) || e.gmail),
    latestByFile,
    unconfirmed: entries.filter((e) => e.action === "reminder_draft" && e.status === "gmail_pending" && !finished.has(e.attemptId)),
  };
}

export async function createReminderDraft({ customer, bills, subject, body, destination, runId, now = new Date() }) {
  bills = [...new Set(bills.map((b) => b.trim()))];
  const base = { action: "reminder_draft", customer, bills, ...(runId && { runId }) };

  try {
    destination = resolveDestination(destination);
    base.destination = destination;
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
    const { live, latestByFile, unconfirmed } = draftState(await readAudit());

    // Two different ledgers can map to the same file name ("A & B" / "A-B"): never overwrite another customer.
    const other = live.find((e) => fileKey(e.file) === fileKey(file) && e.customer !== name);
    if (other) reject(`Customers "${other.customer}" and "${name}" share the draft file name ${file}, and today's file is already ` +
      `"${other.customer}"'s. Draft "${name}" manually today, or retry tomorrow.`);

    // 3. Duplicate check (key = customer + bill).
    const hasBill = (e, b) => e.bills?.some((x) => billNo(x) === b);
    const dupes = [];
    // 3a. Gmail drafts made today, and Gmail calls that never finished: never draft those bills again.
    const mineToday = live.filter((e) => e.customer === name && e.gmail && businessDate(e.at) === today);
    const mineUnconfirmed = unconfirmed.filter((e) => e.customer === name && (COOLDOWN_DAYS <= 0
      ? businessDate(e.at) === today : now - new Date(e.at) < COOLDOWN_DAYS * DAY));
    for (const b of bills) {
      const g = mineToday.findLast((e) => hasBill(e, b));
      const u = !g && mineUnconfirmed.findLast((e) => hasBill(e, b));
      if (g) dupes.push({ bill: b, draftedAt: g.at, gmailMessageId: g.gmail.messageId, source: "gmail draft (today)" });
      else if (u) dupes.push({ bill: b, draftedAt: u.at, source: "unconfirmed gmail attempt",
        note: "A Gmail draft request for this bill did not finish. Check Gmail Drafts before drafting it again." });
    }
    if (COOLDOWN_DAYS > 0) {
      const earlier = live.filter((e) =>
        e.customer === name && now - new Date(e.at) < COOLDOWN_DAYS * DAY &&
        businessDate(e.at) !== today); // same day = refresh, allowed (local files)
      dupes.push(...bills.filter((b) => !dupes.some((d) => d.bill === b)).flatMap((b) => {
        const prev = earlier.findLast((e) => hasBill(e, b));
        return prev ? [{ bill: b, draftedAt: prev.at, file: prev.file, source: prev.gmail ? "gmail draft" : "local draft",
          ...(prev.gmail && { gmailMessageId: prev.gmail.messageId }) }] : [];
      }));
      const othersFiles = new Set(live.filter((e) => e.customer !== name).map((e) => fileKey(e.file)));
      const fromFiles = await findEarlierDrafts({
        customer: name, bills: bills.filter((b) => !dupes.some((d) => d.bill === b)), now, days: COOLDOWN_DAYS,
        skipFile: (f) => othersFiles.has(fileKey(f)), // same file name, but the audit log says it's another customer's
      });
      dupes.push(...fromFiles);
    }
    if (dupes.length) {
      await audit({ ...base, customer: name, status: "skipped_duplicate", duplicates: dupes });
      return {
        saved: false, sent: false, status: "skipped_duplicate", customer: name, duplicates: dupes,
        message: dupes.some((d) => d.source === "unconfirmed gmail attempt")
          ? "A previous Gmail draft request did not finish — check Gmail Drafts. Not drafted again."
          : `Already drafted ${dupes.every((d) => d.source === "gmail draft (today)") ? "in Gmail today" : `within the last ${COOLDOWN_DAYS} days`} — not drafted again.`,
      };
    }

    // 4. Gmail (if chosen). A "gmail_pending" line goes to the audit log BEFORE the call, so a crash in
    //    the middle can never lead to a silent second draft.
    let gmail = null;
    let attemptId;
    if (destination === "gmail") {
      attemptId = randomUUID();
      await audit({ ...base, customer: name, status: "gmail_pending", attemptId });
      try {
        const r = await createGmailDraft({ to, subject, text: body });
        const acc = await connectedAccount().catch(() => null);
        gmail = { messageId: r.gmailMessageId, draftId: r.gmailDraftId, threadId: r.gmailThreadId, mode: r.gmailMode, account: acc?.account ?? null };
      } catch (e) {
        await audit({ ...base, customer: name, status: "error", attemptId, reason: `Gmail: ${e.message}` }).catch(() => {});
        e.audited = true;
        throw e;
      }
    }

    // 5. Local .eml — only for destination "local" (a Gmail draft has no local copy). If this refreshes
    //    today's local draft, say which bills dropped out of it.
    let replaced = null;
    let droppedBills = [];
    let savedFile = null;
    if (!gmail) {
      const prev = latestByFile.get(fileKey(file));
      replaced = prev?.customer === name && !prev.gmail ? prev : null;
      droppedBills = (replaced?.bills ?? []).map(billNo).filter((b) => !bills.includes(b));
      await saveDraft({ customer: name, to, subject, body, date: now });
      savedFile = file;
    }
    const billRows = bills.map((b) => ({ bill: b, outstanding: open.get(b).outstanding, overdueDays: open.get(b).overdueDays }));
    const totalDue = Math.round(billRows.reduce((s, r) => s + r.outstanding, 0) * 100) / 100;
    const credit = pos.unadjustedCredits ? { unadjustedCredits: pos.unadjustedCredits, netOverdue: pos.netOverdue } : {};
    await audit({ ...base, customer: name, status: "saved", to, subject, bills: billRows, totalDue, ...credit, file: savedFile,
      ...(gmail && { gmail, attemptId }),
      ...(replaced && { replacedDraftAt: replaced.at, droppedBills }) });
    return {
      saved: true, status: "saved", sent: false, destination, customer: name, to, bills: billRows, totalDue, ...credit,
      ...(savedFile && { file: savedFile }), ...(gmail && { gmail }),
      ...(replaced && { replacedTodaysDraft: true, droppedBills }),
    };
  } catch (e) {
    const status = e instanceof Rejected ? "rejected" : "error";
    e.draftStatus = status;
    if (!e.audited) await audit({ ...base, status, reason: e.message }).catch(() => {}); // never hide the original error
    throw e;
  }
}

// Several customers in one run. Each draft goes through createReminderDraft (all rules above); one
// failure never stops the others. The same customer twice in one run is skipped. If the Gmail login
// is missing/expired, nothing is attempted for Gmail and every item says so.
export async function createReminderDrafts({ drafts, destination, now = new Date() }) {
  destination = resolveDestination(destination);
  if (!Array.isArray(drafts) || !drafts.length) throw new Error("No drafts given");
  if (drafts.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} drafts per run`);
  const runId = `run-${businessDate(now)}-${randomUUID().slice(0, 8)}`;

  let stopReason = null;
  if (destination === "gmail") {
    try { await getAccessToken(); } catch (e) { stopReason = `Gmail: ${e.message}`; }
  }

  const results = [];
  const seen = new Set();
  for (const d of drafts) {
    const item = { customer: d.customer, bills: d.bills };
    const key = String(d.customer).trim().toLowerCase();
    if (stopReason) {
      results.push({ ...item, status: "not_processed", reason: stopReason });
      await audit({ action: "reminder_draft", ...item, runId, destination, status: "not_processed", reason: stopReason });
      continue;
    }
    if (seen.has(key)) {
      results.push({ ...item, status: "skipped_duplicate", reason: "Same customer appears twice in this run" });
      await audit({ action: "reminder_draft", ...item, runId, destination, status: "skipped_duplicate", reason: "duplicate in run" });
      continue;
    }
    seen.add(key);
    try {
      const r = await createReminderDraft({ ...d, destination, runId, now });
      results.push({
        customer: r.customer, bills: r.bills?.map((b) => b.bill) ?? d.bills, status: r.status,
        ...(r.saved && { to: r.to, totalDue: r.totalDue, file: r.file }),
        ...(r.gmail && { gmailMessageId: r.gmail.messageId, gmailAccount: r.gmail.account }),
        ...(r.localCopyError && { localCopyError: r.localCopyError }),
        ...(r.replacedTodaysDraft && { replacedTodaysDraft: true, droppedBills: r.droppedBills }),
        ...(r.duplicates && { duplicates: r.duplicates, reason: r.message }),
      });
    } catch (e) {
      results.push({ ...item, status: e.draftStatus ?? "error", reason: e.message });
      if (e.name === "GmailAuthError") stopReason = `Gmail: ${e.message}`; // same for every remaining draft
    }
  }
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return { runId, destination, sent: false, counts, results };
}
