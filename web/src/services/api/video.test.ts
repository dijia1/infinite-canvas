import assert from "node:assert/strict";
import test from "node:test";

import axios, { type AxiosResponse } from "axios";

import type { AiConfig } from "@/stores/use-config-store";
import { requestVideoGeneration } from "./video.ts";

test("sends video requests through the Portal application base path", async () => {
    const previousBasePath = process.env.NEXT_PUBLIC_BASE_PATH;
    const previousAdapter = axios.defaults.adapter;
    const urls: string[] = [];
    process.env.NEXT_PUBLIC_BASE_PATH = "/apps/infinite-canvas";
    axios.defaults.adapter = async (config) => {
        const url = String(config.url);
        urls.push(url);
        const data = url.endsWith("/content") ? new Blob(["video"], { type: "video/mp4" }) : config.method === "post" ? { id: "video-task" } : { id: "video-task", status: "completed" };
        return { config, data, status: 200, statusText: "OK", headers: {} } as AxiosResponse;
    };

    try {
        const video = await requestVideoGeneration({ videoSeconds: "6", size: "16:9", vquality: "auto" } as AiConfig, "生成测试视频");
        assert.equal(video.type, "video/mp4");
        assert.deepEqual(urls, ["/apps/infinite-canvas/api/v1/videos", "/apps/infinite-canvas/api/v1/videos/video-task", "/apps/infinite-canvas/api/v1/videos/video-task/content"]);
    } finally {
        axios.defaults.adapter = previousAdapter;
        if (previousBasePath === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
        else process.env.NEXT_PUBLIC_BASE_PATH = previousBasePath;
    }
});
