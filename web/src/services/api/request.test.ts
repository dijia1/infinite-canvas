import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

import { ApiRequestError, aiApiPath, apiDelete, apiPut, apiRequestError, authorizationHeaders, jsonRequestHeaders } from "./request.ts";

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

test("sends PUT and DELETE JSON bodies and preserves conflict status", async () => {
    const originalRequest = axios.request;
    const requests: Array<{ method?: string; data?: unknown; headers?: unknown }> = [];
    axios.request = (async (config) => {
        requests.push(config);
        if (config.method === "PUT") return { status: 200, data: { code: 0, data: { revision: 2 }, msg: "ok" } } as never;
        return { status: 409, data: { code: 1, data: null, msg: "版本冲突" } } as never;
    }) as typeof axios.request;

    try {
        assert.deepEqual(await apiPut("/api/v1/canvas/projects/project-1", { revision: 1 }), { revision: 2 });
        await assert.rejects(
            () => apiDelete("/api/v1/canvas/projects/project-1", undefined, { revision: 1 }),
            (error) => error instanceof ApiRequestError && error.status === 409,
        );
        assert.deepEqual(
            requests.map(({ method, data, headers }) => ({ method, data, headers })),
            [
                { method: "PUT", data: { revision: 1 }, headers: { "Content-Type": "application/json" } },
                { method: "DELETE", data: { revision: 1 }, headers: { "Content-Type": "application/json" } },
            ],
        );
    } finally {
        axios.request = originalRequest;
    }
});
