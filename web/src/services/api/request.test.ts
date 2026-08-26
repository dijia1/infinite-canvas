import assert from "node:assert/strict";
import test from "node:test";

import { aiApiPath, apiRequestError, authorizationHeaders, jsonRequestHeaders } from "./request.ts";

test("does not send the legacy Portal placeholder as an Authorization header", () => {
    assert.equal(authorizationHeaders("portal"), undefined);
});

test("keeps Authorization headers for non-Portal tokens", () => {
    assert.deepEqual(authorizationHeaders("token-value"), { Authorization: "Bearer token-value" });
});

test("does not attach JSON content type when a POST has no request body", () => {
    assert.deepEqual(jsonRequestHeaders(undefined), {});
    assert.deepEqual(jsonRequestHeaders({ sync: true }), { "Content-Type": "application/json" });
});

test("builds AI API paths under the Portal application base path", () => {
    assert.equal(aiApiPath("/videos", "/apps/infinite-canvas"), "/apps/infinite-canvas/api/v1/videos");
});

test("keeps an upstream API error message when Axios provides one", () => {
    assert.equal(apiRequestError({ isAxiosError: true, response: { status: 400, data: { msg: "上游参数无效" } } }, "请求失败"), "上游参数无效");
});
