// Customer email addresses as stored on the Tally ledger. Tally keeps them in one text field, so a
// ledger may hold several addresses separated by "," or ";".
// Format check only — no DNS / mailbox check (that needs network access and is out of scope).

const EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[A-Za-z]{2,}$/;

// -> { status: "valid" | "missing" | "invalid", emails: [...valid, deduplicated], invalid: [...] }
export function checkEmails(raw) {
  const parts = String(raw ?? "").split(/[,;]/).map((e) => e.trim()).filter(Boolean);
  const seen = new Set();
  const emails = [];
  const invalid = [];
  for (const p of parts) {
    if (!EMAIL.test(p) || p.includes("..")) { invalid.push(p); continue; }
    const key = p.toLowerCase();
    if (!seen.has(key)) { seen.add(key); emails.push(p); }
  }
  const status = !parts.length ? "missing" : invalid.length ? "invalid" : "valid";
  return { status, emails, invalid };
}
