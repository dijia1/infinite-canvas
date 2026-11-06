import axios from "axios";
import { uploadDirectlyToOSS } from "./direct-upload";
import { aiApiPath, type ApiResponse } from "./request";

export type VideoMediaAccess = { mediaId: string; url: string; previewUrl?: string; contentType: string; bytes: number; width: number; height: number; duration: number; expiresAt?: string };
export type VideoUploadMetadata = Pick<VideoMediaAccess, "duration" | "width" | "height">;
export class VideoMediaRequestError extends Error {}
function data<T>(value: ApiResponse<T>): T {
    if (value.code !== 0 || !value.data) throw new VideoMediaRequestError(value.msg || "视频素材请求失败");
    return value.data;
}
export type VideoUploadOptions = {
    metadata?: VideoUploadMetadata;
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
    onStage?: (stage: "uploading" | "verifying") => void;
    onUploaded?: (intentId: string) => void;
    uploadedIntentId?: string;
};
function validateVideoUpload(file: Blob) {
    if (file.type !== "video/mp4") throw new Error("仅支持 MP4 视频");
    if (!file.size) throw new Error("视频文件为空");
    if (file.size > 100 * 1024 * 1024) throw new Error("视频大小不能超过 100 MB");
}

export function prepareVideoUpload(file: Blob, signal?: AbortSignal): Promise<VideoUploadMetadata> {
    validateVideoUpload(file);
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(file);
        const cleanup = () => {
            video.onloadedmetadata = null;
            video.onerror = null;
            signal?.removeEventListener("abort", abort);
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
        };
        const abort = () => {
            cleanup();
            reject(new DOMException("上传已取消", "AbortError"));
        };
        video.preload = "metadata";
        video.onloadedmetadata = () => {
            const metadata = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
            cleanup();
            if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.width <= 0 || metadata.height <= 0) reject(new Error("无法读取视频时长或尺寸，请重新选择视频"));
            else resolve(metadata);
        };
        video.onerror = () => {
            cleanup();
            reject(new Error("无法读取视频，请确认文件可播放"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        video.src = url;
    });
}
export async function uploadVideoMedia(file: Blob, options: VideoUploadOptions = {}): Promise<VideoMediaAccess> {
    const { signal } = options;
    const metadata = options.metadata ?? (await prepareVideoUpload(file, signal));
    if (options.uploadedIntentId) {
        options.onStage?.("verifying");
        return data((await axios.post<ApiResponse<VideoMediaAccess>>(aiApiPath(`/media/upload-intents/${encodeURIComponent(options.uploadedIntentId)}/complete`), metadata, { signal })).data);
    }
    options.onStage?.("uploading");
    const intent = data(
        (
            await axios.post<ApiResponse<{ mode: string; id: string; uploadUrl: string }>>(
                aiApiPath("/media/upload-intents"),
                {
                    filename: file instanceof File ? file.name : "video.mp4",
                    contentType: file.type,
                    bytes: file.size,
                    intent: "canvas",
                },
                { signal },
            )
        ).data,
    );
    if (intent.mode !== "direct" || !intent.id || !intent.uploadUrl) throw new Error("视频上传需要 OSS 存储");
    await uploadDirectlyToOSS(intent.uploadUrl, file, options);
    options.onUploaded?.(intent.id);
    options.onStage?.("verifying");
    return data((await axios.post<ApiResponse<VideoMediaAccess>>(aiApiPath(`/media/upload-intents/${encodeURIComponent(intent.id)}/complete`), metadata, { signal })).data);
}
export async function getVideoMediaAccess(mediaId: string, signal?: AbortSignal): Promise<VideoMediaAccess> {
    return data((await axios.get<ApiResponse<VideoMediaAccess>>(aiApiPath(`/media/${encodeURIComponent(mediaId)}/access`), { signal, timeout: 20_000 })).data);
}

export async function getVideoDownloadAccess(mediaId: string, filename: string): Promise<VideoMediaAccess> {
    return data((await axios.get<ApiResponse<VideoMediaAccess>>(aiApiPath(`/media/${encodeURIComponent(mediaId)}/access`), { params: { download: "1", filename }, timeout: 20_000 })).data);
}
