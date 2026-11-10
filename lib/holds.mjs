// Approved disputed / on-hold accounts, from config/account-holds.json (rule 8 in docs/ACCOUNTING_RULES.md).
// Read fresh on every call, so an accountant's edit takes effect without restarting Claude.
// A malformed holds file is an ERROR, not "no holds": ignoring it could chase a disputed customer.

import { readFile } from "node:fs/promises";
import { CONFIG } from "./config.mjs";

const ruleError = (msg) => Object.assign(new Error(msg), { rule: true });
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function validateHolds(doc, source = "holds file") {
  const holds = doc?.holds;
  if (!Array.isArray(holds)) throw ruleError(`${source}: "holds" must be a list`);
  const errs = [];
  holds.forEach((h, i) => {
    const at = `holds[${i}]`;
    for (const k of ["customer", "reason", "approvedBy"])
      if (typeof h?.[k] !== "string" || !h[k].trim()) errs.push(`${at}.${k} is required`);
    if (!ISO.test(h?.approvedOn ?? "")) errs.push(`${at}.approvedOn must be YYYY-MM-DD`);
    if (h?.until !== undefined && !ISO.test(h.until)) errs.push(`${at}.until must be YYYY-MM-DD`);
    if (h?.bill !== undefined && (typeof h.bill !== "string" || !h.bill.trim())) errs.push(`${at}.bill must be a bill number`);
  });
  if (errs.length) throw ruleError(`${source} is invalid — fix it before reminders can run: ${errs.join("; ")}`);
  return holds;
}

export async function loadHolds(path = CONFIG.holdsPath) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw ruleError(`${path} is not valid JSON: ${e.message}`); }
  return validateHolds(doc, path);
}

const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Holds in force on `day` (YYYY-MM-DD): approvedOn <= day <= until (until is inclusive).
export const activeHolds = (holds, day) => holds.filter((h) => h.approvedOn <= day && (!h.until || day <= h.until));

// The active hold covering this customer's bill (a whole-customer hold covers every bill), or null.
export function holdFor(active, customer, bill) {
  return active.find((h) => same(h.customer, customer) && (!h.bill || (bill !== undefined && same(h.bill, bill)))) ?? null;
}

// Whole-customer hold only.
export const customerHold = (active, customer) => active.find((h) => same(h.customer, customer) && !h.bill) ?? null;

export const describeHold = (h) =>
  `${h.reason} (approved by ${h.approvedBy} on ${h.approvedOn}${h.until ? `, until ${h.until}` : ""})`;
