// Builds an RFC 5322 / MIME email (used for Gmail drafts).
//  - text/plain part = the reminder body exactly as written from the skill's template.
//  - text/html part  = generated HERE from that text (escaped; "a | b | c" lines become table rows),
//    so no raw HTML from the model ever reaches the email.
//  - optional attachments (e.g. invoice PDFs later): [{ filename, contentType, content: Buffer }]

import { randomBytes } from "node:crypto";

export const MAX_RAW_BYTES = 20 * 1024 * 1024; // keep well under Gmail's 25 MB message limit

const CRLF = "\r\n";
const noLineBreaks = (name, v) => {
  if (/[\r\n]/.test(String(v))) throw new Error(`Line breaks are not allowed in ${name}`);
  return String(v);
};

// RFC 2047 encoded-words, split so no word exceeds 75 chars and no UTF-8 character is cut.
export function encodeHeader(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = "";
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

const base64Lines = (buf) => buf.toString("base64").replace(/.{1,76}/g, "$&\r\n");

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Plain text -> simple, email-client-safe HTML (inline styles only).
export function textToHtml(text) {
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const cell = "border:1px solid #ccc;padding:6px 10px;text-align:left";
  const html = blocks.map((block) => {
    const lines = block.split("\n");
    const out = [];
    let rows = [];
    let para = [];
    const flushRows = () => {
      if (rows.length) out.push(`<table style="border-collapse:collapse;margin:8px 0">${rows.map((r) =>
        `<tr>${r.map((c) => `<td style="${cell}">${escapeHtml(c.trim())}</td>`).join("")}</tr>`).join("")}</table>`);
      rows = [];
    };
    const flushPara = () => {
      if (para.length) out.push(`<p style="margin:0 0 12px">${para.map(escapeHtml).join("<br>")}</p>`);
      para = [];
    };
    for (const line of lines) {
      if ((line.match(/ \| /g) ?? []).length >= 2) { flushPara(); rows.push(line.split(" | ")); }
      else { flushRows(); para.push(line); }
    }
    flushRows(); flushPara();
    return out.join("");
  }).join("\n");
  return `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">\n${html}\n</body></html>`;
}

const boundary = () => `=_ai_acct_${randomBytes(12).toString("hex")}`;

function attachmentPart(a) {
  const filename = noLineBreaks("attachment filename", a.filename);
  if (!filename || /[\\/]/.test(filename)) throw new Error(`Invalid attachment filename: "${filename}"`);
  if (!Buffer.isBuffer(a.content)) throw new Error(`Attachment "${filename}" content must be a Buffer`);
  const type = noLineBreaks("attachment type", a.contentType || "application/octet-stream");
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) throw new Error(`Invalid attachment content type: "${type}"`);
  const ascii = /^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename);
  const name = ascii ? `filename="${filename}"` : `filename*=UTF-8''${encodeURIComponent(filename)}`;
  return [
    `Content-Type: ${type}${ascii ? `; name="${filename}"` : ""}`,
    `Content-Disposition: attachment; ${name}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(a.content),
  ].join(CRLF);
}

export function buildMessage({ to, subject, text, html = textToHtml(text), attachments = [], date = new Date() }) {
  noLineBreaks("'to'", to);
  noLineBreaks("'subject'", subject);
  if (!to?.trim()) throw new Error("Recipient ('to') is required");
  if (!text?.trim()) throw new Error("Email body is required");

  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    base64Lines(Buffer.from(text.replace(/\r?\n/g, CRLF), "utf8"))].join(CRLF);
  const htmlPart = ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    base64Lines(Buffer.from(html, "utf8"))].join(CRLF);

  const alt = boundary();
  const alternative = [`Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, textPart, `--${alt}`, htmlPart, `--${alt}--`, ""].join(CRLF);

  let bodyPart = alternative;
  if (attachments.length) {
    const mixed = boundary();
    bodyPart = [`Content-Type: multipart/mixed; boundary="${mixed}"`, "",
      `--${mixed}`, alternative, ...attachments.flatMap((a) => [`--${mixed}`, attachmentPart(a)]), `--${mixed}--`, ""].join(CRLF);
  }

  const raw = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`, `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0", bodyPart].join(CRLF);
  if (Buffer.byteLength(raw) > MAX_RAW_BYTES) throw new Error("Email is too large (max 20 MB including attachments)");
  return raw;
}
