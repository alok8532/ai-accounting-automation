// Append-only audit log (JSON Lines): one line per draft attempt — saved, skipped or rejected.
// Stores who/when/what (customer, bills, amounts, recipient, file), NOT full email bodies.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";

export const AUDIT_LOG = resolve(
  process.env.AUDIT_LOG ?? join(dirname(fileURLToPath(import.meta.url)), "..", "logs", "reminder-audit.jsonl"),
);

const currentUser = () => {
  try { return userInfo().username; } catch { return process.env.USERNAME ?? "unknown"; }
};

export async function audit(event) {
  const entry = { at: new Date().toISOString(), user: currentUser(), ...event };
  await mkdir(dirname(AUDIT_LOG), { recursive: true });
  await appendFile(AUDIT_LOG, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

export async function readAudit() {
  let text;
  try {
    text = await readFile(AUDIT_LOG, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; } // a damaged line must not block all drafting
  });
}
