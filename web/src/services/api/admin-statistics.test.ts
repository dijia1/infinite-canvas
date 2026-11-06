import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";

import { fetchStatistics, type Statistics } from "./admin-statistics";
import { ApiRequestError } from "./request";

test("statistics API sends the date range and preserves decimal strings in the parsed response", async () => {
    const original = axios.defaults.adapter;
    const range = { start: "2026-09-01", end: "2026-09-07" };
    const amount = "12345678901234567890.123456789";
    const model = { providerId: "image", providerName: "Image", successfulCalls: 2, imageCount: 3, amount, unpricedImageCount: 1, resolutions: [{ resolution: "2K", successfulCalls: 2, imageCount: 3, amount, unpricedImageCount: 1 }] };
    const payload: Statistics = { startDate: range.start, endDate: range.end, timezone: "Asia/Shanghai", amount, imageCount: 3, unpricedImageCount: 1, models: [model], users: [{ userUid: "user-1", displayName: "User", successfulCalls: 2, imageCount: 3, amount, unpricedImageCount: 1, models: [model] }] };
    let requests = 0;
    axios.defaults.adapter = async (config) => {
        requests++;
        assert.equal(config.method, "get");
        const url = new URL(axios.getUri(config), "https://canvas.test");
        assert.ok(url.pathname.endsWith("/api/admin/statistics"));
        assert.deepEqual(Object.fromEntries(url.searchParams), range);
        assert.equal(config.headers.get("Authorization"), undefined);
        return { config, status: 200, statusText: "OK", headers: {}, data: JSON.stringify({ code: 0, data: payload, msg: "" }) };
    };
    try {
        assert.deepEqual(await fetchStatistics(range), payload);
        assert.equal(requests, 1);
    } finally {
        axios.defaults.adapter = original;
    }
});

test("statistics API propagates server errors instead of treating an error envelope as statistics", async () => {
    const original = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => ({ config, status: 403, statusText: "Forbidden", headers: {}, data: { code: 403, msg: "forbidden" } });
    try {
        await assert.rejects(fetchStatistics({ start: "2026-09-01", end: "2026-09-07" }), (error: unknown) => error instanceof ApiRequestError && error.status === 403 && error.message === "forbidden");
    } finally {
        axios.defaults.adapter = original;
    }
});
