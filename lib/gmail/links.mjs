// Clickable link that opens a saved draft in Gmail's compose window.
// Pure string building — no Gmail API call. Tested live on 6-Nov-2026: with the gmail.insert permission Gmail
// returns a message id (no separate draft id), and #drafts?compose=<message id> opens that draft for editing.
// authuser=<email> makes Gmail open the right account when several are signed in.

export function gmailDraftLink(messageId, account) {
  if (!/^[0-9a-f]{8,32}$/i.test(String(messageId ?? ""))) return null;
  const user = account && /^[^\s@/#?&]+@[^\s@/#?&]+$/.test(account) ? `?authuser=${encodeURIComponent(account)}` : "";
  return `https://mail.google.com/mail/${user}#drafts?compose=${messageId}`;
}
