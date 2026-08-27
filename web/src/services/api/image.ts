import axios from "axios";

import type { AiConfig } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { aiApiPath, apiDelete, apiRequestError, debugApiRequest } from "@/services/api/request";
import type { ReferenceImage } from "@/types/image";
import { normalizeImageResolution } from "@/lib/image-generation-config";
import { imageOutputSettings } from "@/lib/image-output-config";
import { imageEditReferenceError } from "@/lib/image-edit-validation";
import { createImageMaskFile } from "@/app/(user)/canvas/image-mask/mask-raster";

type ImageApiResponse = {
    data?: Record<string, unknown> | Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

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

export type GeneratedImage = { id: string; dataUrl: string; mediaId?: string };

export type ImageGenerationTask = {
    id: string;
    clientRequestId: string;
    status: "queued" | "submitting" | "running" | "succeeded" | "failed";
    progress: number;
    error?: string;
    images: GeneratedImage[];
};

function parseImageTask(payload: ImageApiResponse): ImageGenerationTask {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }
    const item = payload.data;
    if (!item || Array.isArray(item) || typeof item.id !== "string" || !item.id) {
        throw new Error("接口没有返回图片任务");
    }
    const images = Array.isArray(item.images)
        ? item.images
              .map((image): GeneratedImage | null => {
                  if (!image || typeof image !== "object") return null;
                  const value = image as Record<string, unknown>;
                  if (typeof value.url !== "string" || !value.url) return null;
                  return { id: nanoid(), dataUrl: value.url, ...(typeof value.mediaId === "string" ? { mediaId: value.mediaId } : {}) };
              })
              .filter((image): image is GeneratedImage => Boolean(image))
        : [];
    return {
        id: item.id,
        clientRequestId: typeof item.clientRequestId === "string" ? item.clientRequestId : "",
        status: item.status === "queued" || item.status === "submitting" || item.status === "running" || item.status === "succeeded" || item.status === "failed" ? item.status : "failed",
        progress: typeof item.progress === "number" ? item.progress : 0,
        error: typeof item.error === "string" ? item.error : undefined,
        images,
    };
}

export async function uploadUserImage(file: File, intent: "canvas" | "library" = "library") {
    const form = new FormData();
    form.set("image", file);
    form.set("intent", intent);
    const response = await axios.post<ImageApiResponse & { data?: { mediaId?: string; url?: string; mediaExpiresAt?: string } }>(aiApiPath("/media/images"), form);
    if (response.data.code !== 0 || !response.data.data?.mediaId || !response.data.data.url) throw new Error(response.data.msg || "上传图片失败");
    return { mediaId: response.data.data.mediaId, url: response.data.data.url, mediaExpiresAt: response.data.data.mediaExpiresAt };
}

export async function deleteUserImage(mediaId: string) {
    return apiDelete<void>(`/api/v1/media/${encodeURIComponent(mediaId)}`);
}

function aiHeaders(contentType?: string) {
    return contentType ? { "Content-Type": contentType } : undefined;
}

export async function requestGeneration(config: AiConfig, prompt: string, clientRequestId: string): Promise<ImageGenerationTask> {
    const quality = normalizeQuality(config.quality);
    const size = (config.size || "").trim();
    const resolution = config.imageProviderType ? config.resolution : normalizeImageResolution(config.resolution);
    const output = imageOutputSettings(config.outputFormat, config.background);
    const body = {
        clientRequestId,
		...(config.imageProviderId ? { providerId: config.imageProviderId } : {}),
        prompt,
        n: 1,
        ...(quality ? { quality } : {}),
        ...(size && size !== "auto" ? { size } : {}),
        ...(resolution ? { resolution } : {}),
        output_format: output.outputFormat,
        background: output.background,
		providerOptions: config.providerOptions || {},
        response_format: "b64_json",
    };
    debugApiRequest("image generation", {
        url: aiApiPath("/images/generations"),
        body,
    });
    try {
        const response = await axios.post<ImageApiResponse>(aiApiPath("/images/generations"), body, {
            headers: aiHeaders("application/json"),
        });
        return parseImageTask(response.data);
    } catch (error) {
        throw new Error(apiRequestError(error, "请求失败"));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], clientRequestId: string): Promise<ImageGenerationTask> {
    const quality = normalizeQuality(config.quality);
    const size = (config.size || "").trim();
    const resolution = config.imageProviderType ? config.resolution : normalizeImageResolution(config.resolution);
    const output = imageOutputSettings(config.outputFormat, config.background);
    const formData = new FormData();
    formData.set("clientRequestId", clientRequestId);
	if (config.imageProviderId) formData.set("providerId", config.imageProviderId);
    formData.set("prompt", prompt);
    formData.set("n", "1");
    formData.set("response_format", "b64_json");
    formData.set("output_format", output.outputFormat);
    formData.set("background", output.background);
	formData.set("providerOptions", JSON.stringify(config.providerOptions || {}));
    if (quality) {
        formData.set("quality", quality);
    }
    if (size && size !== "auto") {
        formData.set("size", size);
    }
    if (resolution) {
        formData.set("resolution", resolution);
    }
    const hydratedReferences = await Promise.all(references.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) })));
    const referenceError = imageEditReferenceError(hydratedReferences);
    if (referenceError) throw new Error(referenceError);
    const maskedReferences = hydratedReferences.filter((image) => image.mask?.strokes.length);
    const files = await Promise.all(hydratedReferences.map((image) => dataUrlToFile(image)));
    files.forEach((file) => formData.append("image", file));
    const mask = maskedReferences[0];
    if (mask?.mask) {
        formData.set("mask", await createImageMaskFile(mask.mask, mask));
    }
    debugApiRequest("image edit", {
        url: aiApiPath("/images/edits"),
        body: {
            clientRequestId,
            prompt,
            n: 1,
            ...(quality ? { quality } : {}),
            ...(size && size !== "auto" ? { size } : {}),
            ...(resolution ? { resolution } : {}),
            output_format: output.outputFormat,
            background: output.background,
			providerOptions: config.providerOptions || {},
            response_format: "b64_json",
        },
        references: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
        mask: mask ? { name: "mask.png", type: "image/png" } : undefined,
    });

    try {
        const response = await axios.post<ImageApiResponse>(aiApiPath("/images/edits"), formData, { headers: aiHeaders() });
        return parseImageTask(response.data);
    } catch (error) {
        throw new Error(apiRequestError(error, "请求失败"));
    }
}

export async function getImageGenerationTask(taskId: string): Promise<ImageGenerationTask> {
    try {
        const response = await axios.get<ImageApiResponse>(aiApiPath(`/images/tasks/${encodeURIComponent(taskId)}`));
        return parseImageTask(response.data);
    } catch (error) {
        throw new Error(apiRequestError(error, "查询图片任务失败"));
    }
}

export async function getImageGenerationTaskByClientRequest(clientRequestId: string): Promise<ImageGenerationTask> {
    try {
        const response = await axios.get<ImageApiResponse>(aiApiPath(`/images/tasks/by-client-request/${encodeURIComponent(clientRequestId)}`));
        return parseImageTask(response.data);
    } catch (error) {
        throw new Error(apiRequestError(error, "查询图片任务失败"));
    }
}

/** 仅用于旧画布节点的兼容提示，不再发起文本模型请求。 */
export async function requestImageQuestion(_config: AiConfig, _messages: ChatCompletionMessage[], _onDelta: (text: string) => void): Promise<string> {
    throw new Error("文本生成功能已移除");
}
