import axios from "axios";

import type { AiConfig } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import { normalizeImageResolution } from "@/lib/image-generation-config";

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

function debugCanvasRequest(label: string, payload: Record<string, unknown>) {
    if (process.env.NODE_ENV !== "development") return;
    console.groupCollapsed(`[canvas-api] ${label}`);
    console.log(payload);
    console.groupEnd();
}

const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};

function normalizeQuality(quality: string) {
    const value = (quality || "").trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return normalized === "auto" || !normalized ? undefined : normalized;
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }
    const images =
        payload.data
            ?.map(resolveImageDataUrl)
            .filter((value): value is string => Boolean(value))
            .map((dataUrl, index) => ({ id: nanoid(), dataUrl, mediaId: typeof payload.data?.[index]?.mediaId === "string" ? payload.data[index].mediaId as string : undefined })) || [];

    if (images.length === 0) {
        throw new Error("接口没有返回图片");
    }

    return images;
}

export async function uploadUserImage(file: File) {
    const form = new FormData();
    form.set("image", file);
    const response = await axios.post<ImageApiResponse & { data?: { mediaId?: string; url?: string } }>(aiApiUrl("/media/images"), form);
    if (response.data.code !== 0 || !response.data.data?.mediaId || !response.data.data.url) throw new Error(response.data.msg || "上传图片失败");
    return { mediaId: response.data.data.mediaId, url: response.data.data.url };
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function aiApiUrl(path: string) {
    return `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/v1${path}`;
}

function aiHeaders(contentType?: string) {
    return contentType ? { "Content-Type": contentType } : undefined;
}

export async function requestGeneration(config: AiConfig, prompt: string) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const size = (config.size || "").trim();
    const resolution = normalizeImageResolution(config.resolution);
    const body = {
        prompt,
        n,
        ...(quality ? { quality } : {}),
        ...(size && size !== "auto" ? { size } : {}),
        ...(resolution ? { resolution } : {}),
        response_format: "b64_json",
    };
    debugCanvasRequest("image generation", {
        url: aiApiUrl("/images/generations"),
        body,
    });
    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl("/images/generations"), body, {
            headers: aiHeaders("application/json"),
        });
        const images = parseImagePayload(response.data);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[]) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const size = (config.size || "").trim();
    const resolution = normalizeImageResolution(config.resolution);
    const formData = new FormData();
    formData.set("prompt", prompt);
    formData.set("n", String(n));
    formData.set("response_format", "b64_json");
    if (quality) {
        formData.set("quality", quality);
    }
    if (size && size !== "auto") {
        formData.set("size", size);
    }
    if (resolution) {
        formData.set("resolution", resolution);
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));
    debugCanvasRequest("image edit", {
        url: aiApiUrl("/images/edits"),
        body: {
            prompt,
            n,
            ...(quality ? { quality } : {}),
            ...(size && size !== "auto" ? { size } : {}),
            ...(resolution ? { resolution } : {}),
            response_format: "b64_json",
        },
        references: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    });

    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl("/images/edits"), formData, { headers: aiHeaders() });
        const images = parseImagePayload(response.data);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

/** 仅用于旧画布节点的兼容提示，不再发起文本模型请求。 */
export async function requestImageQuestion(_config: AiConfig, _messages: ChatCompletionMessage[], _onDelta: (text: string) => void): Promise<string> {
    throw new Error("文本生成功能已移除");
}
