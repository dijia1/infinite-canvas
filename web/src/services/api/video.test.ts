import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosResponse } from "axios";
import { defaultAiConfig } from "@/lib/ai-config";
import { requestVideoGeneration, getVideoTask, resumeVideoTask, getVideoTaskByClientRequest, VideoQueryTransientError } from "./video.ts";
const config = { ...defaultAiConfig, videoProviderId: "seedance", videoSeconds: "5", videoSize: "16:9", vquality: "720p" };
test("creates a persistent video task using stable references and never polls or downloads during create", async () => {
    const previous = axios.defaults.adapter;
    const calls: { url: string; body: unknown }[] = [];
    axios.defaults.adapter = async (c) => {
        calls.push({ url: String(c.url), body: c.data ? JSON.parse(c.data) : undefined });
        return { config: c, data: { code: 0, data: { id: "task", status: "running", progress: 0, videos: [] } }, status: 200, statusText: "OK", headers: {} } as AxiosResponse;
    };
    try {
        const task = await requestVideoGeneration(config, "dance", [{ id: "ref", name: "x", type: "image/png", dataUrl: "", mediaId: "m1" }], "client", ["v1"]);
        assert.equal(task.id, "task");
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body, { clientRequestId: "client", providerId: "seedance", prompt: "dance", seconds: 5, size: "16:9", resolution: "720p", generateAudio: false, imageMediaIds: ["m1"], videoMediaIds: ["v1"] });
        await getVideoTask("task");
        await resumeVideoTask("task");
        assert.ok(calls[2].url.endsWith("/videos/task/resume"));
    } finally {
        axios.defaults.adapter = previous;
    }
});
test("rejects invalid video parameters and incomplete uploads before requests", async () => {
    for (const seconds of ["3", "16", "4.5"]) {
        await assert.rejects(requestVideoGeneration({ ...config, videoSeconds: seconds }, "dance"), /4 至 15/);
    }
    await assert.rejects(requestVideoGeneration({ ...config, videoSize: "" }, "dance"), /分辨率和比例/);
    await assert.rejects(requestVideoGeneration(config, "dance", [{ id: "x", name: "x", type: "image/png", dataUrl: "blob:x" }]), /上传完成/);
    await assert.rejects(requestVideoGeneration(config, "dance", [], "id", ["1", "2", "3", "4"]), /最多/);
});
test("surfaces video API failures", async () => {
    const previous = axios.defaults.adapter;
    axios.defaults.adapter = async (c) => ({ config: c, data: { code: 400, msg: "拒绝" }, status: 200, statusText: "OK", headers: {} }) as AxiosResponse;
    try {
        await assert.rejects(requestVideoGeneration(config, "dance"), /拒绝/);
    } finally {
        axios.defaults.adapter = previous;
    }
});

test("video HTTP requests carry bounded timeouts and query cancellation", async () => {
    const adapter = axios.defaults.adapter;
    const calls: { timeout?: number; signal?: unknown }[] = [];
    const controller = new AbortController();
    axios.defaults.adapter = async (c) => {
        calls.push(c);
        return { config: c, data: { code: 0, data: { id: "task", status: "running", videos: [] } }, status: 200, statusText: "OK", headers: {} } as AxiosResponse;
    };
    try {
        await requestVideoGeneration(config, "dance", [], "original-client");
        await getVideoTask("task", controller.signal);
        await getVideoTaskByClientRequest("original-client", controller.signal);
        await resumeVideoTask("task", controller.signal);
        assert.deepEqual(
            calls.map((c) => c.timeout),
            [60000, 20000, 20000, 20000],
        );
        assert.ok(calls.slice(1).every((c) => c.signal === controller.signal));
        axios.defaults.adapter = async () => {
            throw new axios.AxiosError("timeout", "ECONNABORTED");
        };
        await assert.rejects(requestVideoGeneration(config, "dance"), /提交请求超时/);
        await assert.rejects(getVideoTask("task"), VideoQueryTransientError);
        controller.abort();
        await assert.rejects(getVideoTask("task", controller.signal), (error) => axios.isCancel(error));
    } finally {
        axios.defaults.adapter = adapter;
    }
});


test("video regeneration carries old task consent and query issues", async () => {
    const previous = axios.defaults.adapter;
    let input: { replaceTaskId?: string; confirmUncertain?: boolean } | undefined;
    const issue = { kind: "configuration", stage: "query", consecutiveFailures: 0 };
    axios.defaults.adapter = async (c) => {
        input = JSON.parse(c.data);
        return { config: c, data: { code: 0, data: { id: "new-video", status: "paused", issue, videos: [] } }, status: 200, statusText: "OK", headers: {} } as AxiosResponse;
    };
    try {
        const task = await requestVideoGeneration(config, "dance", [], "new-client", [], { replaceTaskId: "old-video", confirmUncertain: true });
        assert.equal(input?.replaceTaskId, "old-video");
        assert.equal(input?.confirmUncertain, true);
        assert.deepEqual(task.issue, issue);
    } finally { axios.defaults.adapter = previous; }
});
