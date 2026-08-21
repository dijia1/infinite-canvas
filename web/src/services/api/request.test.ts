import assert from "node:assert/strict";
import test from "node:test";

import { authorizationHeaders } from "./request.ts";

test("does not send the legacy Portal placeholder as an Authorization header", () => {
    assert.equal(authorizationHeaders("portal"), undefined);
});

test("keeps Authorization headers for non-Portal tokens", () => {
    assert.deepEqual(authorizationHeaders("token-value"), { Authorization: "Bearer token-value" });
});
