import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosResponse } from "axios";
import { defaultAiConfig } from "@/lib/ai-config";
import { requestVideoGeneration, validateVideoGeneration, getVideoTask, resumeVideoTask, getVideoTaskByClientRequest, VideoQueryTransientError } from "./video.ts";
import { flashVideoModel } from "@/test-utils/flash-video";
import { useConfigStore } from "@/stores/use-config-store";
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

test("formal requests only carry local sample identity, never prompts or reference URLs", async () => {
    const adapter = axios.defaults.adapter;
    let body: any;
    axios.defaults.adapter = async (c) => {
        body = JSON.parse(c.data);
        return { config: c, data: { code: 0, data: { id: "formal", status: "queued", videos: [] } }, status: 200, statusText: "OK", headers: {} } as AxiosResponse;
    };
    try {
        await requestVideoGeneration({ ...config, videoMode: "final", sourceDraftTaskId: "local-sample" }, "do not send", [], "formal-client", ["do-not-send"]);
        assert.deepEqual(body, { clientRequestId: "formal-client", providerId: "seedance", mode: "final", sourceDraftTaskId: "local-sample" });
    } finally {
        axios.defaults.adapter = adapter;
    }
});

test("Flash allows six mixed references in order and rejects unsupported inputs before submitting", async () => {
    const previous = axios.defaults.adapter;
    const previousStatus = useConfigStore.getState().status;
    const calls: any[] = [];
    axios.defaults.adapter = async c => {
        calls.push(JSON.parse(c.data));
        return { config: c, data: { code: 0, data: { id: "flash-task", status: "queued", videos: [] } }, status: 200, statusText: "OK", headers: {} } as AxiosResponse;
    };
    useConfigStore.setState({ status: { imageAvailable: false, imageEditable: false, videoAvailable: true, videoModels: [flashVideoModel] } });
    const selected = { ...config, videoProviderId: "flash", videoSize: "adaptive", videoSeconds: "30" };
    const images = ["b", "a", "b"].map(mediaId => ({ id: mediaId, name: mediaId, type: "image/png", dataUrl: "", mediaId }));
    try {
        await requestVideoGeneration(selected, "制作视频", images, "flash-client", ["v3", "v1", "v2"]);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].imageMediaIds, ["b", "a", "b"]);
        assert.deepEqual(calls[0].videoMediaIds, ["v3", "v1", "v2"]);
        assert.equal(calls[0].size, "adaptive");
        assert.equal(calls[0].seconds, 30);
        assert.equal(calls[0].mode, undefined);
        assert.equal(calls[0].sourceDraftTaskId, undefined);
        await assert.rejects(requestVideoGeneration(selected, "视频", [...images, images[0]], "over", ["v1", "v2", "v3"]), /合计最多 6/);
        for (const patch of [{ vquality: "1080p" }, { videoSize: "2:1" }, { videoSeconds: "31" }, { videoSeconds: "-1" }, { videoMode: "draft" as const }, { videoMode: "final" as const, sourceDraftTaskId: "old" }]) {
            await assert.rejects(requestVideoGeneration({ ...selected, ...patch }, "视频"));
        }
        assert.throws(() => validateVideoGeneration(selected, [], ["v1", "v2", "v3", "v4"], flashVideoModel.videoRequestSchema), /最多支持/);
        assert.equal(calls.length, 1, "invalid inputs must never create another task");
    } finally {
        axios.defaults.adapter = previous;
        useConfigStore.setState({ status: previousStatus });
    }
});
