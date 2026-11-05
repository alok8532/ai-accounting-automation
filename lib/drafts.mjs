// Save reminder drafts as .eml files (open in Outlook/Windows Mail as an unsent, editable email).
// Writes ONLY inside DRAFTS_DIR/<YYYY-MM-DD>/ — never sends anything, never touches Tally.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DRAFTS_DIR = resolve(
  process.env.DRAFTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "drafts"),
);

// RFC 2047: subjects contain "₹" and "–", which must be encoded in a mail header.
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

// "Sharma Exports Pvt Ltd" -> "sharma-exports-pvt-ltd"
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "customer";

export async function saveDraft({ customer, to, subject, body, date = new Date() }) {
  if (/[\r\n]/.test(to + subject)) throw new Error("Line breaks are not allowed in 'to' or 'subject'");
  const day = date.toISOString().slice(0, 10);
  const dir = join(DRAFTS_DIR, day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${slug(customer)}.eml`); // same customer + same day overwrites (re-run = refresh)

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
