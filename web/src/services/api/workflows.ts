import type { WorkflowGraph, WorkflowList, WorkflowRecord, WorkflowRunDetail, WorkflowRunList, WorkflowRunScope, WorkflowRunState } from "@/features/workflows/types";
import { ApiRequestError, apiDelete, apiGet, apiPost, apiPut } from "./request";

export type CreateWorkflowInput = { name: string; graph?: WorkflowGraph; frameSchemaVersion?: 1 };
export type UpdateWorkflowInput = { revision: number; name: string; graph: WorkflowGraph; frameSchemaVersion?: 1 };
export type FetchWorkflowRunsOptions = { workflowId?: string; scope?: WorkflowRunScope; active?: boolean; signal?: AbortSignal };
export type WorkflowRunErrorCode =
    | "workflow_revision_conflict"
    | "workflow_run_scope_active"
    | "workflow_run_nodes_active"
    | "workflow_run_request_mismatch"
    | "workflow_run_revision_required"
    | "workflow_frame_external_generation"
    | "workflow_frame_not_runnable"
    | "workflow_run_scope_required";
export type WorkflowRunErrorData = {
    code: WorkflowRunErrorCode;
    runId?: string;
    conflictNodeIds?: string[];
    sourceNodeId?: string;
    targetNodeId?: string;
};

const workflowRunErrorCodes = new Set<WorkflowRunErrorCode>([
    "workflow_revision_conflict",
    "workflow_run_scope_active",
    "workflow_run_nodes_active",
    "workflow_run_request_mismatch",
    "workflow_run_revision_required",
    "workflow_frame_external_generation",
    "workflow_frame_not_runnable",
    "workflow_run_scope_required",
]);

export function workflowRunErrorData(error: unknown): WorkflowRunErrorData | undefined {
    if (!(error instanceof ApiRequestError) || !error.data || typeof error.data !== "object") return undefined;
    const data = error.data as Partial<WorkflowRunErrorData>;
    return typeof data.code === "string" && workflowRunErrorCodes.has(data.code as WorkflowRunErrorCode) ? data as WorkflowRunErrorData : undefined;
}
export type WorkflowVideoAsset = { id: string; source: "upload" | "generated"; contentType: string; bytes: number; duration: number; width: number; height: number; filename: string; title: string; createdAt: string };
export type WorkflowVideoList = { items: WorkflowVideoAsset[]; total: number };

export function fetchWorkflows(page = 1, pageSize = 60) {
    return apiGet<WorkflowList>("/api/v1/workflows", { page, pageSize });
}

export function fetchWorkflow(id: string) {
    return apiGet<WorkflowRecord>(`/api/v1/workflows/${encodeURIComponent(id)}`);
}

export function fetchWorkflowVideos() {
    return apiGet<WorkflowVideoList>("/api/v1/private-images", { kind: "video" });
}

export function createWorkflow(input: CreateWorkflowInput) {
    return apiPost<WorkflowRecord>("/api/v1/workflows", { ...input, frameSchemaVersion: 1 });
}

export function updateWorkflow(id: string, input: UpdateWorkflowInput) {
    return apiPut<WorkflowRecord>(`/api/v1/workflows/${encodeURIComponent(id)}`, { ...input, frameSchemaVersion: 1 });
}

export function copyWorkflow(id: string, name?: string) {
    return apiPost<WorkflowRecord>(`/api/v1/workflows/${encodeURIComponent(id)}/copy`, name ? { name } : {});
}

export async function deleteWorkflow(id: string, revision: number) {
    await apiDelete<true>(`/api/v1/workflows/${encodeURIComponent(id)}`, undefined, { revision });
}

export function createWorkflowRun(workflowId: string, requestId: string, revision?: number, scope?: WorkflowRunScope) {
    return apiPost<WorkflowRunDetail>(`/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`, { requestId, ...(revision === undefined ? {} : { revision }), ...(scope ? { scope } : {}) });
}

export function fetchWorkflowRuns(page = 1, pageSize = 20, workflowIdOrOptions?: string | FetchWorkflowRunsOptions) {
    const options = typeof workflowIdOrOptions === "string" ? { workflowId: workflowIdOrOptions } : workflowIdOrOptions || {};
    return apiGet<WorkflowRunList>("/api/v1/workflow-runs", {
        page,
        pageSize,
        ...(options.workflowId ? { workflowId: options.workflowId } : {}),
        ...(options.scope ? { scopeType: options.scope.type } : {}),
        ...(options.scope?.type === "frame" ? { frameId: options.scope.frameId } : {}),
        ...(options.active === undefined ? {} : { active: options.active ? 1 : 0 }),
    }, undefined, { signal: options.signal });
}

export function fetchWorkflowRunState(workflowId: string, activePage = 1, activePageSize = 20, signal?: AbortSignal) {
    return apiGet<WorkflowRunState>(`/api/v1/workflows/${encodeURIComponent(workflowId)}/run-state`, { activePage, activePageSize }, undefined, { signal });
}

export function fetchWorkflowRun(id: string, signal?: AbortSignal) {
    return apiGet<WorkflowRunDetail>(`/api/v1/workflow-runs/${encodeURIComponent(id)}`, undefined, undefined, { signal });
}

export function stopWorkflowRun(id: string) {
    return apiPost<WorkflowRunDetail>(`/api/v1/workflow-runs/${encodeURIComponent(id)}/stop`);
}

export function retryWorkflowOutput(id: string, input: { requestId: string; nodeId: string; slotId: string }) {
    return apiPost<WorkflowRunDetail>(`/api/v1/workflow-runs/${encodeURIComponent(id)}/retry`, input);
}

export async function deleteWorkflowRun(id: string) {
    await apiDelete<true>(`/api/v1/workflow-runs/${encodeURIComponent(id)}`);
}
