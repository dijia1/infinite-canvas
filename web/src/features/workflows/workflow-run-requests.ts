import type { WorkflowRunScope } from "./types";

export type PendingWorkflowRunRequest = { workflowId: string; revision: number; requestId: string; scope: WorkflowRunScope };
export type PendingWorkflowRetryRequest = { runId: string; nodeId: string; slotId: string; attempt: number; requestId: string };
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const memoryRunRequests = new Map<string, PendingWorkflowRunRequest>();
const memoryRetryRequests = new Map<string, PendingWorkflowRetryRequest[]>();
const clearedRequestKeys = new Set<string>();

function legacyRunStorageKey(ownerUID: string, workflowId: string) {
    return `infinite-canvas:workflow-run-request:${ownerUID}:${workflowId}`;
}

function runStorageKey(ownerUID: string, workflowId: string, scope: WorkflowRunScope) {
    return `${legacyRunStorageKey(ownerUID, workflowId)}:${workflowRunScopeKey(scope)}`;
}

function retryStorageKey(ownerUID: string, runId: string) {
    return `infinite-canvas:workflow-retry-requests:${ownerUID}:${runId}`;
}

export function pendingWorkflowRetryKey(input: Pick<PendingWorkflowRetryRequest, "runId" | "nodeId" | "slotId">) {
    return JSON.stringify([input.runId, input.nodeId, input.slotId]);
}

export function workflowRunScopeKey(scope: WorkflowRunScope = { type: "workflow" }) {
    return JSON.stringify(scope.type === "frame" ? ["frame", scope.frameId] : ["workflow"]);
}

function sameWorkflowRunScope(left: WorkflowRunScope, right: WorkflowRunScope) {
    return workflowRunScopeKey(left) === workflowRunScopeKey(right);
}

export function ensureWorkflowRunRequest(pending: PendingWorkflowRunRequest | undefined, workflowId: string, revision: number, createRequestId: () => string, scope: WorkflowRunScope = { type: "workflow" }): PendingWorkflowRunRequest {
    return pending?.workflowId === workflowId && sameWorkflowRunScope(pending.scope, scope) ? pending : { workflowId, revision, requestId: createRequestId(), scope };
}

export function ensureWorkflowRetryRequest(pending: PendingWorkflowRetryRequest | undefined, input: Omit<PendingWorkflowRetryRequest, "requestId">, createRequestId: () => string): PendingWorkflowRetryRequest {
    if (pending && pending.runId === input.runId && pending.nodeId === input.nodeId && pending.slotId === input.slotId && pending.attempt === input.attempt) return pending;
    return { ...input, requestId: createRequestId() };
}

export function workflowRetryWasAccepted(pending: PendingWorkflowRetryRequest, output: { attempt: number } | undefined) {
    return Boolean(output && output.attempt > pending.attempt);
}

function parsePendingWorkflowRunRequest(value: string | null | undefined, workflowId: string, fallbackScope?: WorkflowRunScope) {
    try {
        const request = JSON.parse(value || "null") as Partial<PendingWorkflowRunRequest> | null;
        const scope = request?.scope || fallbackScope;
        if (!request || request.workflowId !== workflowId || !Number.isInteger(request.revision) || (request.revision || 0) < 1 || typeof request.requestId !== "string" || !request.requestId || !scope || (scope.type !== "workflow" && (scope.type !== "frame" || typeof scope.frameId !== "string" || !scope.frameId))) return undefined;
        return { workflowId, revision: request.revision!, requestId: request.requestId, scope } as PendingWorkflowRunRequest;
    } catch {
        return undefined;
    }
}

export function readPendingWorkflowRunRequest(storage: RequestStorage | undefined, ownerUID: string, workflowId: string, scope: WorkflowRunScope = { type: "workflow" }): PendingWorkflowRunRequest | undefined {
    const key = runStorageKey(ownerUID, workflowId, scope);
    if (clearedRequestKeys.has(key)) return undefined;
    const memory = memoryRunRequests.get(key);
    if (memory) return memory;
    try {
        const value = parsePendingWorkflowRunRequest(storage?.getItem(key), workflowId);
        if (value && sameWorkflowRunScope(value.scope, scope)) return value;
        if (scope.type !== "workflow") return undefined;
        const legacyKey = legacyRunStorageKey(ownerUID, workflowId);
        if (clearedRequestKeys.has(legacyKey)) return undefined;
        const legacyMemory = memoryRunRequests.get(legacyKey);
        if (legacyMemory) return { ...legacyMemory, scope: { type: "workflow" as const } };
        return parsePendingWorkflowRunRequest(storage?.getItem(legacyKey), workflowId, { type: "workflow" });
    } catch {
        return undefined;
    }
}

export function writePendingWorkflowRunRequest(storage: RequestStorage | undefined, ownerUID: string, request: PendingWorkflowRunRequest) {
    const normalized = { ...request, scope: request.scope || { type: "workflow" as const } };
    const key = runStorageKey(ownerUID, request.workflowId, normalized.scope);
    clearedRequestKeys.delete(key);
    memoryRunRequests.set(key, normalized);
    try { storage?.setItem(key, JSON.stringify(normalized)); } catch { /* Memory retains the id for this app session. */ }
}

export function clearPendingWorkflowRunRequest(storage: RequestStorage | undefined, ownerUID: string, workflowId: string, scope: WorkflowRunScope = { type: "workflow" }) {
    const key = runStorageKey(ownerUID, workflowId, scope);
    memoryRunRequests.delete(key);
    clearedRequestKeys.add(key);
    try { storage?.removeItem(key); } catch { try { storage?.setItem(key, ""); } catch { /* The memory tombstone prevents stale recovery in this app session. */ } }
    if (scope.type === "workflow") {
        const legacyKey = legacyRunStorageKey(ownerUID, workflowId);
        memoryRunRequests.delete(legacyKey);
        clearedRequestKeys.add(legacyKey);
        try { storage?.removeItem(legacyKey); } catch { try { storage?.setItem(legacyKey, ""); } catch { /* The memory tombstone prevents stale recovery in this app session. */ } }
    }
}

export function readPendingWorkflowRetryRequests(storage: RequestStorage | undefined, ownerUID: string, runId: string) {
    const key = retryStorageKey(ownerUID, runId);
    if (clearedRequestKeys.has(key)) return [];
    const memory = memoryRetryRequests.get(key);
    if (memory) return memory;
    try {
        const values = JSON.parse(storage?.getItem(key) || "[]") as PendingWorkflowRetryRequest[];
        if (!Array.isArray(values)) return [];
        return values.filter((value) => value?.runId === runId && typeof value.nodeId === "string" && typeof value.slotId === "string" && Number.isInteger(value.attempt) && value.attempt > 0 && typeof value.requestId === "string" && value.requestId);
    } catch {
        return [];
    }
}

export function writePendingWorkflowRetryRequest(storage: RequestStorage | undefined, ownerUID: string, request: PendingWorkflowRetryRequest) {
    const key = retryStorageKey(ownerUID, request.runId);
    const identity = pendingWorkflowRetryKey(request);
    const values = readPendingWorkflowRetryRequests(storage, ownerUID, request.runId).filter((value) => pendingWorkflowRetryKey(value) !== identity);
    values.push(request);
    clearedRequestKeys.delete(key);
    memoryRetryRequests.set(key, values);
    try { storage?.setItem(key, JSON.stringify(values)); } catch { /* Memory retains the id for this app session. */ }
}

export function clearPendingWorkflowRetryRequest(storage: RequestStorage | undefined, ownerUID: string, request: Pick<PendingWorkflowRetryRequest, "runId" | "nodeId" | "slotId">) {
    const key = retryStorageKey(ownerUID, request.runId);
    const identity = pendingWorkflowRetryKey(request);
    const values = readPendingWorkflowRetryRequests(storage, ownerUID, request.runId).filter((value) => pendingWorkflowRetryKey(value) !== identity);
    if (values.length) {
        clearedRequestKeys.delete(key);
        memoryRetryRequests.set(key, values);
        try { storage?.setItem(key, JSON.stringify(values)); } catch { /* Memory remains authoritative for this app session. */ }
        return;
    }
    memoryRetryRequests.delete(key);
    clearedRequestKeys.add(key);
    try { storage?.removeItem(key); } catch { try { storage?.setItem(key, ""); } catch { /* The memory tombstone prevents stale recovery in this app session. */ } }
}
