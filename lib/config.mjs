// Loads config/receivables.json (the documented accounting rules — see docs/ACCOUNTING_RULES.md).
// RECEIVABLES_CONFIG points to another file (tests use this). A bad config fails loudly: silently
// falling back to defaults could change who gets chased for money.

import { readFileSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = resolve(process.env.RECEIVABLES_CONFIG || join(ROOT, "config", "receivables.json"));

const DEFAULTS = {
  debtorsGroup: "Sundry Debtors",
  retainerGroup: "Retainer Customers",
  ageingBuckets: [30, 60, 90],
  dueDateFallback: "ledger-default", // "ledger-default" | "bill-date" | "none"
  minBillBalance: 100,
  minCustomerNetOverdue: 0,
  allowPastAsOf: false,
  holdsFile: "config/account-holds.json",
};

export function validateConfig(c) {
  const errs = [];
  const b = c.ageingBuckets;
  if (!Array.isArray(b) || !b.length || b.some((n) => !Number.isInteger(n) || n < 1) || b.some((n, i) => i && n <= b[i - 1]))
    errs.push("ageingBuckets must be increasing whole numbers of days, e.g. [30, 60, 90]");
  if (!["ledger-default", "bill-date", "none"].includes(c.dueDateFallback))
    errs.push('dueDateFallback must be "ledger-default", "bill-date" or "none"');
  for (const k of ["minBillBalance", "minCustomerNetOverdue"])
    if (typeof c[k] !== "number" || c[k] < 0) errs.push(`${k} must be a number >= 0`);
  if (typeof c.allowPastAsOf !== "boolean") errs.push("allowPastAsOf must be true or false");
  for (const k of ["debtorsGroup", "retainerGroup", "holdsFile"])
    if (typeof c[k] !== "string" || !c[k].trim()) errs.push(`${k} must be a non-empty string`);
  if (errs.length) throw new Error(`Invalid ${CONFIG_FILE}: ${errs.join("; ")}`);
  return c;
}

function load() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Cannot read ${CONFIG_FILE}: ${e.message}`);
  }
  const c = { ...DEFAULTS, ...Object.fromEntries(Object.entries(file).filter(([k]) => !k.startsWith("_"))) };
  if (process.env.RETAINER_GROUP) c.retainerGroup = process.env.RETAINER_GROUP; // kept for backward compatibility
  validateConfig(c);
  c.holdsPath = isAbsolute(c.holdsFile) ? c.holdsFile : join(ROOT, c.holdsFile);
  if (process.env.HOLDS_FILE) c.holdsPath = resolve(process.env.HOLDS_FILE);
  return Object.freeze(c);
}

export const CONFIG = load();
