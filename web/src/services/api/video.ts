import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { aiApiPath, apiRequestError, debugApiRequest } from "@/services/api/request";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type VideoResponse = { id: string; status?: string; error?: { message?: string } };
type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = []) {
    const seconds = normalizeVideoSeconds(config.videoSeconds);
    const size = normalizeVideoSize(config.size);
    const resolutionName = normalizeVideoResolution(config.vquality);
    const body = new FormData();
    body.append("prompt", prompt);
    body.append("seconds", seconds);
    if (size) body.append("size", size);
    body.append("resolution_name", resolutionName);
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    debugApiRequest("video generation", {
        url: aiApiPath("/videos"),
        body: {
            prompt,
            seconds,
            ...(size ? { size } : {}),
            resolution_name: resolutionName,
            preset: "normal",
        },
        references: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    });
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiPath("/videos"), body)).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        for (;;) {
            const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiPath(`/videos/${created.id}`))).data);
            if (video.status === "completed") break;
            if (video.status === "failed" || video.status === "cancelled") throw new Error(video.error?.message || "视频生成失败");
            await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        const content = await axios.get<Blob>(aiApiPath(`/videos/${created.id}/content`), { responseType: "blob" });
        await assertVideoBlob(content.data);
        return content.data;
    } catch (error) {
        throw new Error(apiRequestError(error, "视频生成失败"));
    }
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse): VideoResponse {
    if (!payload) throw new Error("接口没有返回视频任务");
    if ("code" in payload && typeof payload.code === "number") {
        if (payload.code !== 0) throw new Error(payload.msg || "请求失败");
        if (!payload.data) throw new Error("接口没有返回视频任务");
        return payload.data;
    }
    return payload as VideoResponse;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "视频下载失败");
}
