import { apiGet, apiPost, compactApiParams } from "@/services/api/request";

export type GenerationTaskStatus = "queued" | "submitting" | "running" | "saving" | "paused" | "uncertain" | "succeeded" | "failed";

export type ImageOperationDetails = {
    taskId: string;
    status: Exclude<GenerationTaskStatus, "saving" | "paused">;
    providerId: string;
    providerName: string;
    providerTaskId: string;
    quality: string;
    size: string;
    resolution: string;
    outputFormat: string;
    background: string;
    amount: string;
};

export type VideoOperationDetails = {
    taskId: string;
    status: GenerationTaskStatus;
    providerId: string;
    providerName: string;
    providerTaskId: string;
    seconds: number;
    size: string;
    resolution: string;
    generateAudio: boolean;
    amount: string;
};

export type OperationLog = {
    image?: ImageOperationDetails;
    video?: VideoOperationDetails;
    id: string;
    actorUid: string;
    actorName: string;
    actorRoles: string[];
    action: string;
    status: "submitted" | "success" | "failure";
    targetType: string;
    targetId: string;
    providerTaskId?: string;
    targetName: string;
    prompt: string;
    mediaIds: string[];
    errorMessage: string;
    requestSummary?: string;
    createdAt: string;
};

export type OperationLogList = { items: OperationLog[]; total: number };

export function fetchOperationLogs(query: { mediaId?: string; page?: number; pageSize?: number; action?: string; actor?: string; status?: string } = {}) {
    return apiGet<OperationLogList>("/api/admin/operation-logs", compactApiParams(query));
}

export function syncPortalMembers() {
    return apiPost<{ count: number; syncedAt: string }>("/api/admin/members/sync");
}
