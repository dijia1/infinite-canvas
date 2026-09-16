import axios from "axios";

import type { AiConfig } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { aiApiPath, apiDelete, apiRequestError, debugApiRequest } from "@/services/api/request";
import type { ReferenceImage } from "@/types/image";
import { imageOutputSettings } from "@/lib/image-output-config";
import { imageEditReferenceError } from "@/lib/image-edit-validation";
import { createImageMaskFile } from "@/app/(user)/canvas/image-mask/mask-raster";

type ImageApiResponse = {
    data?: Record<string, unknown> | Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

function normalizeQuality(quality: string) {
    const value = (quality || "").trim();
    return value === "auto" || !value ? undefined : value;
}

export type GeneratedImage = { id: string; dataUrl: string; mediaId?: string };

export type ImageGenerationTask = {
    id: string;
    clientRequestId: string;
    status: "queued" | "submitting" | "running" | "succeeded" | "failed" | "uncertain";
    progress: number;
    error?: string;
    images: GeneratedImage[];
};

export class ImageRequestRejectedError extends Error {}

type UserImageUploadData = {
    mediaId?: string;
    url?: string;
    mediaExpiresAt?: string;
};

type UserImageUploadIntent = {
    mode?: "direct" | "proxy";
    id?: string;
    uploadUrl?: string;
};

export type UserImageUploadOptions = {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
};

export function canUseServerMediaReferences(references: ReferenceImage[]) {
    return references.length > 0 && references.every((reference) => Boolean(reference.mediaId));
}

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
        status: item.status === "queued" || item.status === "submitting" || item.status === "running" || item.status === "succeeded" || item.status === "failed" || item.status === "uncertain" ? item.status : "failed",
        progress: typeof item.progress === "number" ? item.progress : 0,
        error: typeof item.error === "string" ? item.error : undefined,
        images,
    };
}

function uploadAbortedError() {
    return Object.assign(new Error("上传已取消"), { name: "AbortError" });
}

async function uploadDirectlyToOSS(uploadURL: string, file: File, options: UserImageUploadOptions) {
    if (typeof XMLHttpRequest === "undefined") {
        const response = await fetch(uploadURL, {
            method: "PUT",
            body: file,
            headers: { "Content-Type": file.type },
            credentials: "omit",
            signal: options.signal,
        });
        if (!response.ok) throw new Error(`上传图片失败：OSS 返回 ${response.status}`);
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", abort);
            callback();
        };
        const abort = () => request.abort();

        request.open("PUT", uploadURL);
        request.setRequestHeader("Content-Type", file.type);
        request.upload.onprogress = (event) => {
            if (!event.lengthComputable || event.total <= 0) return;
            options.onProgress?.(Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))));
        };
        request.onload = () =>
            finish(() => {
                if (request.status >= 200 && request.status < 300) resolve();
                else reject(new Error(`上传图片失败：OSS 返回 ${request.status}`));
            });
        request.onerror = () => finish(() => reject(new Error("上传图片失败：无法连接 OSS")));
        request.onabort = () => finish(() => reject(uploadAbortedError()));
        if (options.signal?.aborted) {
            abort();
            return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        request.send(file);
    });
}

export async function uploadUserImage(file: File, intent: "canvas" | "library" | "mask" = "library", options: UserImageUploadOptions = {}) {
    const uploadIntent = await axios.post<ImageApiResponse & { data?: UserImageUploadIntent }>(
        aiApiPath("/media/upload-intents"),
        {
            filename: file.name,
            contentType: file.type,
            bytes: file.size,
            intent,
        },
        { signal: options.signal },
    );
    if (uploadIntent.data.code !== 0 || !uploadIntent.data.data?.mode) throw new Error(uploadIntent.data.msg || "申请上传失败");
    if (uploadIntent.data.data.mode === "direct") {
        const { id, uploadUrl } = uploadIntent.data.data;
        if (!id || !uploadUrl) throw new Error("上传服务没有返回有效凭证");
        await uploadDirectlyToOSS(uploadUrl, file, options);
        const completed = await axios.post<ImageApiResponse & { data?: UserImageUploadData }>(aiApiPath(`/media/upload-intents/${encodeURIComponent(id)}/complete`));
        return parseUserImageUpload(completed.data);
    }
    if (uploadIntent.data.data.mode !== "proxy") throw new Error("上传服务返回了未知模式");
    const form = new FormData();
    form.set("image", file);
    form.set("intent", intent);
    const response = await axios.post<ImageApiResponse & { data?: UserImageUploadData }>(aiApiPath("/media/images"), form, {
        signal: options.signal,
        onUploadProgress: (event) => {
            if (!event.total || event.total <= 0) return;
            options.onProgress?.(Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))));
        },
    });
    return parseUserImageUpload(response.data);
}

function parseUserImageUpload(payload: ImageApiResponse & { data?: UserImageUploadData }) {
    if (payload.code !== 0 || !payload.data?.mediaId || !payload.data.url) throw new Error(payload.msg || "上传图片失败");
    return { mediaId: payload.data.mediaId, url: payload.data.url, mediaExpiresAt: payload.data.mediaExpiresAt };
}

export async function deleteUserImage(mediaId: string) {
    return apiDelete<void>(`/api/v1/media/${encodeURIComponent(mediaId)}`);
}

function aiHeaders(contentType?: string) {
    return contentType ? { "Content-Type": contentType } : undefined;
}

function imageCreateError(error: unknown, fallback: string): never {
    if (error instanceof ImageRequestRejectedError) throw error;
    if (axios.isAxiosError(error) && error.response && error.response.status >= 400 && error.response.status < 500 && ![408, 499].includes(error.response.status)) {
        throw new ImageRequestRejectedError(apiRequestError(error, fallback));
    }
    throw new Error(apiRequestError(error, fallback));
}

export async function requestGeneration(config: AiConfig, prompt: string, clientRequestId: string): Promise<ImageGenerationTask> {
    const quality = normalizeQuality(config.quality);
    const size = (config.size || "").trim();
    const resolution = config.resolution.trim();
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
        imageCreateError(error, "请求失败");
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], clientRequestId: string): Promise<ImageGenerationTask> {
    const quality = normalizeQuality(config.quality);
    const size = (config.size || "").trim();
    const resolution = config.resolution.trim();
    const output = imageOutputSettings(config.outputFormat, config.background);
    const referenceError = imageEditReferenceError(references);
    if (referenceError) throw new Error(referenceError);
    const maskedReferences = references.filter((image) => image.mask?.strokes.length);
    const referenceMediaIds = await Promise.all(
        references.map(async (image) => {
            if (image.mediaId) return image.mediaId;
            const file = dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) });
            return (await uploadUserImage(file, "canvas")).mediaId;
        }),
    );
    const mask = maskedReferences[0];
    const maskMediaId = mask?.mask ? (await uploadUserImage(await createImageMaskFile(mask.mask, mask), "mask")).mediaId : undefined;
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
        referenceMediaIds,
        ...(maskMediaId ? { maskMediaId } : {}),
    };
    debugApiRequest("image edit", {
        url: aiApiPath("/images/edits"),
        body,
    });

    try {
        const response = await axios.post<ImageApiResponse>(aiApiPath("/images/edits"), body, { headers: aiHeaders("application/json") });
        return parseImageTask(response.data);
    } catch (error) {
        imageCreateError(error, "请求失败");
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
