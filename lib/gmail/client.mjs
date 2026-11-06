// Gmail API client — DRAFT CREATION ONLY.
//
// Every Gmail request goes through gmailRequest(), which allows exactly these calls:
//   gmail.compose mode: POST /gmail/v1/users/me/drafts      (drafts.create)
//   gmail.insert  mode: POST /gmail/v1/users/me/messages    (messages.insert with the DRAFT label)
// Anything else — including users.messages.send and users.drafts.send — is refused before any
// network call. There is deliberately no send / reply / forward function in this project.
// POSTs are never retried automatically (a retry could create a second draft).

import { getAccessToken, invalidateAccessToken, gmailConfig } from "./oauth.mjs";
import { buildMessage } from "../mime.mjs";

const apiBase = () => (process.env.GMAIL_API_BASE || "https://gmail.googleapis.com").replace(/\/$/, "");

const ALLOWED = Object.freeze([
  Object.freeze({ mode: "compose", method: "POST", path: "/gmail/v1/users/me/drafts", query: [] }),
  Object.freeze({ mode: "insert", method: "POST", path: "/gmail/v1/users/me/messages", query: ["internalDateSource"] }),
]);

export class GmailApiError extends Error {
  constructor(msg, { status, reason } = {}) { super(msg); this.name = "GmailApiError"; this.status = status; this.reason = reason; }
}
export class GmailBlockedError extends Error {
  constructor(msg) { super(msg); this.name = "GmailBlockedError"; }
}

// The single gate to the Gmail API.
export function assertAllowed(method, path, query = {}, mode = gmailConfig().mode) {
  const rule = ALLOWED.find((r) => r.mode === mode && r.method === method && r.path === path);
  if (!rule || /send/i.test(path))
    throw new GmailBlockedError(`Blocked Gmail API call: ${method} ${path}. This application may only create drafts.`);
  const badQuery = Object.keys(query).filter((k) => !rule.query.includes(k));
  if (badQuery.length) throw new GmailBlockedError(`Blocked Gmail API query parameter(s): ${badQuery.join(", ")}`);
}

async function gmailRequest(method, path, { query = {}, body } = {}) {
  assertAllowed(method, path, query);
  const url = `${apiBase()}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`;
  for (let attempt = 1; ; attempt++) {
    const token = await getAccessToken();
    let res;
    try {
      res = await fetch(url, {
        method, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    } catch (e) {
      throw new GmailApiError(`Cannot reach Gmail (${e.cause?.code ?? e.name}). Check the internet connection.`, { reason: "network" });
    }
    // 401 = access token expired/revoked: get a fresh one once. Safe to repeat — nothing was created.
    if (res.status === 401 && attempt === 1) { invalidateAccessToken(); continue; }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    // Google's error text describes the request problem, not the email content — still keep it short.
    const reason = data.error?.errors?.[0]?.reason ?? data.error?.status ?? "unknown";
    const msg = String(data.error?.message ?? "").slice(0, 200);
    throw new GmailApiError(`Gmail API error ${res.status} (${reason})${msg ? `: ${msg}` : ""}`, { status: res.status, reason });
  }
}

// Create one draft in the connected Gmail account. Returns ids only (never the content).
export async function createGmailDraft({ to, subject, text, html, attachments }) {
  const raw = Buffer.from(buildMessage({ to, subject, text, html, attachments }), "utf8").toString("base64url");
  const { mode } = gmailConfig();
  if (mode === "compose") {
    const d = await gmailRequest("POST", "/gmail/v1/users/me/drafts", { body: { message: { raw } } });
    return { gmailDraftId: d.id, gmailMessageId: d.message?.id, gmailThreadId: d.message?.threadId, gmailMode: mode };
  }
  const m = await gmailRequest("POST", "/gmail/v1/users/me/messages", {
    query: { internalDateSource: "dateHeader" }, body: { raw, labelIds: ["DRAFT"] },
  });
  return { gmailDraftId: null, gmailMessageId: m.id, gmailThreadId: m.threadId, gmailMode: mode };
}
