import assert from "node:assert/strict";
import test from "node:test";
import { checkHealth } from "./check-gateway-health.mjs";

const gatewayUrl = "https://www.semetaloa.com/apps/infinite-canvas/api/healthz";

test("release probe requires an exact HTTPS Gateway health URL and never follows redirects", async () => {
  let called = false;
  await checkHealth(gatewayUrl, { gateway: true, fetch: async (url, init) => {
    called = true;
    assert.equal(String(url), gatewayUrl);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    return Response.json({ ok: true });
  } });
  assert.equal(called, true);
  for (const url of [gatewayUrl + "?x=1", gatewayUrl + "/", "http://www.semetaloa.com/apps/infinite-canvas/api/healthz", "https://www.semetaloa.com/api/healthz"]) {
    await assert.rejects(checkHealth(url, { gateway: true, fetch: async () => { assert.fail("must reject before issuing any request"); } }));
  }
});

test("release probe rejects HTML, redirects, non-200 responses, and non-boolean success values", async () => {
  for (const response of [
    new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
    new Response(null, { status: 302, headers: { Location: "/login" } }),
    Response.json({ ok: true }, { status: 201 }),
    Response.json({ ok: true }, { status: 503 }),
    Response.json({ ok: "true" }), Response.json({ ok: false }),
    new Response("broken-json", { headers: { "Content-Type": "application/json" } }),
  ]) await assert.rejects(checkHealth(gatewayUrl, { gateway: true, fetch: async () => response }));
});

test("release probe bounds network waits and reports the timeout as a failure", async () => {
  await assert.rejects(checkHealth(gatewayUrl, { gateway: true, timeoutMs: 10, fetch: async (_url, init) => {
    assert.ok(init?.signal);
    await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    return Response.json({ ok: true });
  } }));
});
