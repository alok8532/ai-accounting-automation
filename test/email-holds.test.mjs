import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEmails } from "../lib/email.mjs";
import { validateHolds, loadHolds, activeHolds, holdFor, customerHold } from "../lib/holds.mjs";

// --- §9 email ---
test("email: valid, several addresses, duplicates removed", () => {
  assert.deepEqual(checkEmails("accounts@x.com"), { status: "valid", emails: ["accounts@x.com"], invalid: [] });
  assert.deepEqual(checkEmails(" a@x.com; b@y.co.in , A@X.com ").emails, ["a@x.com", "b@y.co.in"]);
});

test("email: missing and invalid", () => {
  assert.equal(checkEmails("").status, "missing");
  assert.equal(checkEmails(null).status, "missing");
  assert.equal(checkEmails(" ; , ").status, "missing");
  for (const bad of ["a@b", "a b@x.com", "@x.com", "a@x.c", "a..b@x.com", "a@x..com", "name <a@x.com>"])
    assert.equal(checkEmails(bad).status, "invalid", bad);
  const mixed = checkEmails("good@x.com, bad@");
  assert.equal(mixed.status, "invalid");
  assert.deepEqual(mixed.invalid, ["bad@"]);
});

// --- §8 holds ---
const H = { customer: "Kapoor Builders", reason: "Dispute", approvedBy: "Owner", approvedOn: "2026-11-01" };

test("holds: every entry needs reason, approver and date", () => {
  assert.deepEqual(validateHolds({ holds: [H] }), [H]);
  assert.throws(() => validateHolds({ holds: [{ customer: "X" }] }), (e) =>
    e.rule && /reason is required/.test(e.message) && /approvedBy is required/.test(e.message) && /approvedOn/.test(e.message));
  assert.throws(() => validateHolds({ holds: [{ ...H, until: "30/11/2026" }] }), /until must be YYYY-MM-DD/);
  assert.throws(() => validateHolds({}), /"holds" must be a list/);
});

test("holds: active from approvedOn up to and including until", () => {
  const h = [{ ...H, until: "2026-11-30" }];
  assert.equal(activeHolds(h, "2026-10-31").length, 0);
  assert.equal(activeHolds(h, "2026-11-01").length, 1);
  assert.equal(activeHolds(h, "2026-11-30").length, 1);
  assert.equal(activeHolds(h, "2026-12-01").length, 0);
});

test("holds: customer hold covers all bills; bill hold only that bill; names case-insensitive", () => {
  const all = [H];
  assert.ok(holdFor(all, "kapoor builders", "DEMO-001"));
  assert.ok(customerHold(all, "KAPOOR BUILDERS"));
  const one = [{ ...H, bill: "DEMO-009" }];
  assert.ok(holdFor(one, "Kapoor Builders", "demo-009"));
  assert.equal(holdFor(one, "Kapoor Builders", "DEMO-001"), null);
  assert.equal(customerHold(one, "Kapoor Builders"), null);
});

test("holds file: missing = no holds; broken = error (never silently ignored)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "holds-"));
  try {
    assert.deepEqual(await loadHolds(join(dir, "none.json")), []);
    await writeFile(join(dir, "bad.json"), "{ holds: [");
    await assert.rejects(loadHolds(join(dir, "bad.json")), (e) => e.rule && /not valid JSON/.test(e.message));
    await writeFile(join(dir, "ok.json"), JSON.stringify({ _readme: "x", holds: [H] }));
    assert.deepEqual(await loadHolds(join(dir, "ok.json")), [H]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the shipped holds file is valid", async () => {
  await assert.doesNotReject(loadHolds(new URL("../config/account-holds.json", import.meta.url)));
});
