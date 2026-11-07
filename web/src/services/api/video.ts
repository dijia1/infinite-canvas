import { GenerationTaskQueryError, type GenerationTaskIssue, type GenerationTaskReplacement } from "@/lib/generation-task-state";
import axios from "axios";
import { nanoid } from "nanoid";
import { aiApiPath, apiRequestError, type ApiResponse } from "@/services/api/request";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type VideoGenerationTask = {
    id: string;
    status: "queued" | "submitting" | "running" | "saving" | "succeeded" | "failed" | "uncertain" | "paused";
    progress: number;
    error?: string;
    issue?: GenerationTaskIssue;
    resultMediaIds: string[];
    videos: { mediaId: string; url: string; width?: number; height?: number; bytes?: number; contentType?: string; duration?: number }[];
};
export class VideoRequestRejectedError extends Error {}
export class VideoQueryTransientError extends GenerationTaskQueryError {}

function queryError(error: unknown, fallback: string): never {
    if (axios.isCancel(error)) throw error;
    if (axios.isAxiosError(error) && (!error.response || [408, 429].includes(error.response.status) || error.response.status >= 500)) {
        throw new VideoQueryTransientError(["ECONNABORTED", "ETIMEDOUT"].includes(error.code || "") ? "请求超时，后台视频任务仍会继续，可重新查询" : "视频任务查询暂不可用，后台任务仍会继续，可重新查询");
    }
    throw new GenerationTaskQueryError(apiRequestError(error, fallback));
}

function unwrap(payload: unknown): VideoGenerationTask {
    if (!payload || typeof payload !== "object") throw new Error("接口没有返回视频任务");
    const envelope = payload as ApiResponse<unknown>;
    if (typeof envelope.code === "number" && envelope.code !== 0) throw new VideoRequestRejectedError(envelope.msg || "视频请求失败");
    const task = (envelope.data || payload) as VideoGenerationTask;
    if (!task.id || !["queued", "submitting", "running", "saving", "succeeded", "failed", "uncertain", "paused"].includes(task.status)) throw new Error("接口返回无效视频任务");
    return { ...task, resultMediaIds: task.resultMediaIds || [], videos: task.videos || [] };
}
export function validateVideoGeneration(config: AiConfig, references: ReferenceImage[] = [], videoMediaIds: string[] = []) {
    const seconds = Number(config.videoSeconds);
    if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) throw new Error("视频时长必须为 4 至 15 秒整数");
    if (!config.videoSize || !config.vquality) throw new Error("请选择视频分辨率和比例");
    if (references.length > 9 || videoMediaIds.length > 3) throw new Error("最多支持 9 张参考图和 3 个参考视频");
    if (references.some((r) => !r.mediaId)) throw new Error("参考图片尚未上传完成，请等待上传完成后重试");
    return seconds;
}
export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], clientRequestId = nanoid(), videoMediaIds: string[] = [], replacement?: GenerationTaskReplacement): Promise<VideoGenerationTask> {
    const seconds = validateVideoGeneration(config, references, videoMediaIds);
    try {
        return unwrap(
            (
                await axios.post(
                    aiApiPath("/videos"),
                    {
                        clientRequestId,
                        ...replacement,
                        providerId: config.videoProviderId,
                        prompt,
                        seconds,
                        size: config.videoSize,
                        resolution: config.vquality,
                        generateAudio: config.generateAudio === "true",
                        imageMediaIds: references.map((r) => r.mediaId),
                        videoMediaIds,
                    },
                    { timeout: 60_000 },
                )
            ).data,
        );
    } catch (e) {
        if (e instanceof VideoRequestRejectedError) throw e;
        if (axios.isAxiosError(e) && e.response && e.response.status >= 400 && e.response.status < 500 && ![408, 499].includes(e.response.status)) throw new VideoRequestRejectedError(apiRequestError(e, "视频生成失败"));
        if (axios.isAxiosError(e) && ["ECONNABORTED", "ETIMEDOUT"].includes(e.code || "")) throw new Error("提交请求超时，结果待确认，请查询原任务，勿重复生成");
        throw new Error(apiRequestError(e, "视频生成失败"));
    }
}
export async function getVideoTask(id: string, signal?: AbortSignal): Promise<VideoGenerationTask> {
    try {
        return unwrap((await axios.get(aiApiPath(`/videos/${encodeURIComponent(id)}`), { timeout: 20_000, signal })).data);
    } catch (e) {
        queryError(e, "读取视频任务失败");
    }
}
export async function resumeVideoTask(id: string, signal?: AbortSignal): Promise<VideoGenerationTask> {
    try {
        return unwrap((await axios.post(aiApiPath(`/videos/${encodeURIComponent(id)}/resume`), undefined, { timeout: 20_000, signal })).data);
    } catch (e) {
        queryError(e, "恢复视频任务失败");
    }
}

export async function getVideoTaskByClientRequest(id: string, signal?: AbortSignal): Promise<VideoGenerationTask> {
    try {
        return unwrap((await axios.get(aiApiPath(`/videos/by-client/${encodeURIComponent(id)}`), { timeout: 20_000, signal })).data);
    } catch (e) {
        queryError(e, "读取视频任务失败");
    }
}
