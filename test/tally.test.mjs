import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeTally } from "./fake-tally.mjs";

let hung, T;
before(async () => {
  hung = await startFakeTally({ hang: true }); // accepts the connection, never answers
  Object.assign(process.env, { TALLY_URL: hung.url, TALLY_TIMEOUT_MS: "300" });
  T = await import("../lib/tally.mjs");
});
after(() => hung.close());

test("a Tally that never answers times out with a clear message", async () => {
  const t0 = Date.now();
  await assert.rejects(T.postXml("<ENVELOPE/>"), /Tally did not respond within 0\.3s/);
  assert.ok(Date.now() - t0 < 3000);
});

test("esc/decode round-trip names with XML special characters", () => {
  const name = `A & B "Traders" <North>`;
  assert.equal(T.decode(T.esc(name)), name);
  assert.equal(T.decode("&#4; Primary"), "Primary");
});

test("collection requests target the configured company and are Export-only", () => {
  const xml = T.collectionRequest("B", "Bill", ["Name"]);
  assert.match(xml, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
  assert.match(xml, /<SVCURRENTCOMPANY>Demo Trading Co<\/SVCURRENTCOMPANY>/);
});
