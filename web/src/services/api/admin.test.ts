import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

import { fetchAdminSettings, saveAdminSettings, type AdminSettings } from "./admin.ts";
import { ApiRequestError } from "./request.ts";

const settings: AdminSettings = {
    revision: 7,
    ai: { providers: [], imageProviderId: "", videoProviderId: "" },
};

test("admin settings API sends the loaded revision and retains the next revision", async () => {
    const originalRequest = axios.request;
    const requests: Array<{ method?: string; data?: unknown }> = [];
    axios.request = (async (config) => {
        requests.push(config);
        const revision = config.method === "GET" ? 7 : 8;
        return { status: 200, data: { code: 0, data: { ...settings, revision }, msg: "ok" } } as never;
    }) as typeof axios.request;
    try {
        const loaded = await fetchAdminSettings("admin-token");
        const saved = await saveAdminSettings("admin-token", loaded);
        assert.equal(loaded.revision, 7);
        assert.equal(saved.revision, 8);
        assert.deepEqual(requests.map(({ method, data }) => ({ method, data })), [
            { method: "GET", data: undefined },
            { method: "POST", data: settings },
        ]);
    } finally {
        axios.request = originalRequest;
    }
});

test("admin settings API exposes only structured revision conflict data", async () => {
    const originalRequest = axios.request;
    axios.request = (async () => ({
        status: 409,
        data: { code: 1, data: { currentRevision: 8 }, msg: "AI 配置已在其他位置更新，请刷新后重试" },
    })) as typeof axios.request;
    try {
        await assert.rejects(
            saveAdminSettings("admin-token", settings),
            (error: unknown) =>
                error instanceof ApiRequestError &&
                error.status === 409 &&
                error.message === "AI 配置已在其他位置更新，请刷新后重试" &&
                (error.data as { currentRevision?: number })?.currentRevision === 8 &&
                Object.keys((error.data || {}) as object).length === 1,
        );
    } finally {
        axios.request = originalRequest;
    }
});
