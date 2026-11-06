// Save reminder drafts as .eml files (open in Outlook/Windows Mail as an unsent, editable email).
// Writes ONLY inside DRAFTS_DIR/<YYYY-MM-DD>/ — never sends anything, never touches Tally.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DAY, businessDate } from "./dates.mjs";

export const DRAFTS_DIR = resolve(
  process.env.DRAFTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "drafts"),
);

// RFC 2047: subjects contain "₹" and "–", which must be encoded in a mail header.
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

// "Sharma Exports Pvt Ltd" -> "sharma-exports-pvt-ltd"
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "customer";

// drafts/<business date>/<customer>.eml — same customer + same day = same file (re-run = refresh).
export const draftFile = (customer, date = new Date()) => join(DRAFTS_DIR, businessDate(date), `${slug(customer)}.eml`);

export async function saveDraft({ customer, to, subject, body, date = new Date() }) {
  if (/[\r\n]/.test(to + subject)) throw new Error("Line breaks are not allowed in 'to' or 'subject'");
  const file = draftFile(customer, date);
  await mkdir(dirname(file), { recursive: true });

  const eml = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "X-Unsent: 1", // Outlook opens it as a draft with a Send button
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");

  await writeFile(file, eml, "utf8");
  return file;
}

// Is bill number `bill` mentioned in `text` as a whole token? ("DEMO-001" must not match "DEMO-0011").
export function mentionsBill(text, bill) {
  const e = bill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9/_-])${e}($|[^A-Za-z0-9/_-])`).test(text);
}

// Draft files for this customer from the previous (days - 1) business days that mention any of `bills`.
// A second duplicate source next to the audit log: it also catches drafts saved before audit logging
// existed, or whose audit line was lost. Most recent first. Today is excluded (same-day = refresh).
export async function findEarlierDrafts({ customer, bills, now = new Date(), days, skipFile = () => false }) {
  const hits = [];
  for (let i = 1; i < days; i++) {
    const file = draftFile(customer, new Date(now.getTime() - i * DAY));
    if (skipFile(file)) continue;
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    const body = text.slice(text.search(/\r?\n\r?\n/) + 1); // skip headers
    for (const bill of bills) {
      if (!hits.some((h) => h.bill === bill) && mentionsBill(body, bill)) {
        hits.push({ bill, draftedOn: businessDate(new Date(now.getTime() - i * DAY)), file, source: "draft file" });
      }
    }
  }
  return hits;
}
