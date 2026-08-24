import { apiGet, apiPost, compactApiParams } from "@/services/api/request";

export type OperationLog = {
    id: string;
    actorUid: string;
    actorName: string;
    actorRoles: string[];
    action: string;
    status: "success" | "failure";
    targetType: string;
    targetId: string;
    targetName: string;
    prompt: string;
    mediaIds: string[];
    errorMessage: string;
    createdAt: string;
};

export type OperationLogList = { items: OperationLog[]; total: number };

export function fetchOperationLogs(query: { page?: number; pageSize?: number; action?: string; actor?: string; status?: string } = {}) {
    return apiGet<OperationLogList>("/api/admin/operation-logs", compactApiParams(query));
}

export function syncPortalMembers() {
    return apiPost<{ count: number; syncedAt: string }>("/api/admin/members/sync");
}
