"use client";

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError } from "@/services/api/request";
import { resumeVideoTask } from "@/services/api/video";
import { createWorkflowRun, fetchWorkflowRun, fetchWorkflowRunState, retryWorkflowOutput, stopWorkflowRun } from "@/services/api/workflows";
import {
    clearPendingWorkflowRetryRequest,
    clearPendingWorkflowRunRequest,
    ensureWorkflowRetryRequest,
    ensureWorkflowRunRequest,
    pendingWorkflowRetryKey,
    readPendingWorkflowRetryRequests,
    readPendingWorkflowRunRequest,
    workflowRetryWasAccepted,
    workflowRunScopeKey,
    writePendingWorkflowRetryRequest,
    writePendingWorkflowRunRequest,
    type PendingWorkflowRetryRequest,
    type PendingWorkflowRunRequest,
} from "./workflow-run-requests";
import { findWorkflowOutput, indexWorkflowRunDetailsByNode, isWorkflowRunActive } from "./workflow-run-state";
import type { WorkflowGraph, WorkflowRun, WorkflowRunDetail, WorkflowRunScope, WorkflowRunState } from "./types";

const OVERVIEW_POLL_MS = 2500;
const DETAIL_POLL_MS = 1500;

type QueuedRequest<T> = {
    task: () => Promise<T>;
    signal?: AbortSignal;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
    started: boolean;
    settled: boolean;
    onAbort?: () => void;
};

function abortedRequestError() {
    return new DOMException("The operation was aborted", "AbortError");
}

export function createWorkflowRunRequestLimiter(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("请求并发上限必须是正整数");
    let active = 0;
    const queue: Array<QueuedRequest<unknown>> = [];
    const drain = () => {
        while (active < maxConcurrent && queue.length) {
            const request = queue.shift()!;
            if (request.settled) continue;
            if (request.signal?.aborted) {
                request.settled = true;
                request.reject(abortedRequestError());
                continue;
            }
            request.started = true;
            request.signal?.removeEventListener("abort", request.onAbort!);
            active++;
            void Promise.resolve()
                .then(request.task)
                .then(
                    (value) => {
                        if (!request.settled) {
                            request.settled = true;
                            request.resolve(value);
                        }
                    },
                    (error) => {
                        if (!request.settled) {
                            request.settled = true;
                            request.reject(error);
                        }
                    },
                )
                .finally(() => {
                    active--;
                    drain();
                });
        }
    };
    return {
        run<T>(task: () => Promise<T>, signal?: AbortSignal) {
            if (signal?.aborted) return Promise.reject(abortedRequestError());
            return new Promise<T>((resolve, reject) => {
                const request: QueuedRequest<T> = { task, signal, resolve, reject, started: false, settled: false };
                request.onAbort = () => {
                    if (request.started || request.settled) return;
                    request.settled = true;
                    reject(abortedRequestError());
                };
                signal?.addEventListener("abort", request.onAbort, { once: true });
                queue.push(request as QueuedRequest<unknown>);
                drain();
            });
        },
    };
}

const detailRequestLimiter = createWorkflowRunRequestLimiter(4);

export function workflowRunOverviewQueryKey(ownerUID: string | undefined, workflowId: string | undefined) {
    return ["workflow-run-state", ownerUID || null, workflowId || null] as const;
}

export function workflowRunDetailQueryKey(ownerUID: string | undefined, workflowId: string | undefined, runId: string | undefined) {
    return ["workflow-run", ownerUID || null, workflowId || null, runId || null] as const;
}

export function workflowRunRelevantDetailIds(overview: WorkflowRunState | undefined, visibleNodeIds: ReadonlySet<string> | undefined, selectedRunId: string | undefined) {
    const ids = new Set<string>();
    for (const nodeId of visibleNodeIds || []) {
        const runId = overview?.nodeRunIds[nodeId];
        if (runId) ids.add(runId);
    }
    if (selectedRunId) ids.add(selectedRunId);
    return [...ids];
}

function isDefinitiveWorkflowMutationError(error: unknown) {
    return error instanceof ApiRequestError && error.status >= 400 && error.status < 500;
}

function findOverviewRun(overview: WorkflowRunState | undefined, runId: string | undefined) {
    if (!runId) return undefined;
    for (const scope of overview?.scopes || []) if (scope.latestRun?.id === runId) return scope.latestRun;
    return overview?.activeRuns.items.find((run) => run.id === runId);
}

function browserSessionStorage() {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
}

export type UseWorkflowRunsOptions = {
    ownerUID?: string;
    workflowId?: string;
    graph: WorkflowGraph;
    visibleNodeIds?: ReadonlySet<string>;
};

export function useWorkflowRuns({ ownerUID, workflowId, graph, visibleNodeIds }: UseWorkflowRunsOptions) {
    const queryClient = useQueryClient();
    const identity = JSON.stringify([ownerUID, workflowId]);
    const identityRef = useRef(identity);
    identityRef.current = identity;
    const [selectedRunId, setSelectedRunId] = useState<string>();
    const [pendingByScope, setPendingByScope] = useState<ReadonlyMap<string, PendingWorkflowRunRequest>>(() => new Map());
    const pendingByScopeRef = useRef(new Map<string, PendingWorkflowRunRequest>());
    const [pendingRetryKeys, setPendingRetryKeys] = useState<ReadonlySet<string>>(() => new Set());
    const pendingRetriesRef = useRef(new Map<string, PendingWorkflowRetryRequest>());
    const startPromisesRef = useRef(new Map<string, Promise<WorkflowRunDetail>>());
    const [operationCount, setOperationCount] = useState(0);

    const overviewQuery = useQuery({
        queryKey: workflowRunOverviewQueryKey(ownerUID, workflowId),
        queryFn: ({ signal }) => fetchWorkflowRunState(workflowId!, 1, 100, signal),
        enabled: Boolean(ownerUID && workflowId),
        refetchOnWindowFocus: "always",
        refetchInterval: (query) => (query.state.data?.activeRuns.total ? OVERVIEW_POLL_MS : false),
    });
    const relevantDetailIds = useMemo(() => workflowRunRelevantDetailIds(overviewQuery.data, visibleNodeIds, selectedRunId), [overviewQuery.data, selectedRunId, visibleNodeIds]);
    const detailQueries = useQueries({
        queries: relevantDetailIds.map((runId) => ({
            queryKey: workflowRunDetailQueryKey(ownerUID, workflowId, runId),
            queryFn: ({ signal }: { signal: AbortSignal }) => detailRequestLimiter.run(() => fetchWorkflowRun(runId, signal), signal),
            enabled: Boolean(ownerUID && workflowId),
            refetchInterval: (query: { state: { data?: WorkflowRunDetail } }) => (isWorkflowRunActive(query.state.data?.run.status) ? DETAIL_POLL_MS : false),
        })),
    });
    const detailsByRunId = useMemo(() => {
        const details = new Map<string, WorkflowRunDetail>();
        detailQueries.forEach((query, index) => {
            const detail = query.data;
            if (detail?.run.id === relevantDetailIds[index] && detail.run.workflowId === workflowId) details.set(detail.run.id, detail);
        });
        return details;
    }, [detailQueries, relevantDetailIds, workflowId]);
    const selectedDetailQuery = selectedRunId ? detailQueries[relevantDetailIds.indexOf(selectedRunId)] : undefined;
    const detailByNode = useMemo(() => indexWorkflowRunDetailsByNode(detailsByRunId, overviewQuery.data?.nodeRunIds || {}, graph), [detailsByRunId, graph, overviewQuery.data?.nodeRunIds]);
    const selectedDetail = selectedRunId ? detailsByRunId.get(selectedRunId) : undefined;
    const selectedRun: WorkflowRun | undefined = selectedDetail?.run || findOverviewRun(overviewQuery.data, selectedRunId);

    const currentScopes = useMemo<WorkflowRunScope[]>(() => [{ type: "workflow" as const }, ...(graph.frames || []).map((frame) => ({ type: "frame" as const, frameId: frame.id }))], [graph.frames]);
    const currentScopeIdentity = useMemo(() => currentScopes.map(workflowRunScopeKey).join("|"), [currentScopes]);

    useEffect(() => {
        setSelectedRunId(undefined);
        setOperationCount(0);
        pendingByScopeRef.current = new Map();
        setPendingByScope(new Map());
        pendingRetriesRef.current = new Map();
        setPendingRetryKeys(new Set());
        startPromisesRef.current = new Map();
    }, [identity]);

    useEffect(() => {
        if (!ownerUID || !workflowId) return;
        const restored = new Map<string, PendingWorkflowRunRequest>();
        for (const scope of currentScopes) {
            const request = readPendingWorkflowRunRequest(browserSessionStorage(), ownerUID, workflowId, scope);
            if (request) restored.set(workflowRunScopeKey(scope), request);
        }
        pendingByScopeRef.current = restored;
        setPendingByScope(restored);
    }, [currentScopeIdentity, identity, ownerUID, workflowId]);

    const relevantDetailIdentity = relevantDetailIds.join("|");
    useEffect(() => {
        if (!ownerUID) return;
        let changed = false;
        const next = new Map(pendingRetriesRef.current);
        for (const runId of relevantDetailIds) {
            for (const request of readPendingWorkflowRetryRequests(browserSessionStorage(), ownerUID, runId)) {
                const key = pendingWorkflowRetryKey(request);
                if (next.has(key)) continue;
                next.set(key, request);
                changed = true;
            }
        }
        if (!changed) return;
        pendingRetriesRef.current = next;
        setPendingRetryKeys(new Set(next.keys()));
    }, [identity, ownerUID, relevantDetailIdentity]);

    useEffect(() => {
        if (!ownerUID || !workflowId || !overviewQuery.data || !pendingByScopeRef.current.size) return;
        const runs = [...overviewQuery.data.scopes.flatMap((scope) => (scope.latestRun ? [scope.latestRun] : [])), ...overviewQuery.data.activeRuns.items];
        const next = new Map(pendingByScopeRef.current);
        for (const [scopeKey, request] of pendingByScopeRef.current) {
            if (!runs.some((run) => run.workflowId === workflowId && run.requestId === request.requestId)) continue;
            clearPendingWorkflowRunRequest(browserSessionStorage(), ownerUID, workflowId, request.scope);
            next.delete(scopeKey);
        }
        if (next.size !== pendingByScopeRef.current.size) {
            pendingByScopeRef.current = next;
            setPendingByScope(next);
        }
    }, [overviewQuery.data, ownerUID, workflowId]);

    useEffect(() => {
        if (!ownerUID || !detailsByRunId.size || !pendingRetriesRef.current.size) return;
        const accepted: PendingWorkflowRetryRequest[] = [];
        for (const request of pendingRetriesRef.current.values()) {
            const detail = detailsByRunId.get(request.runId);
            if (workflowRetryWasAccepted(request, findWorkflowOutput(detail?.outputs, request.nodeId, request.slotId))) accepted.push(request);
        }
        if (!accepted.length) return;
        for (const request of accepted) {
            clearPendingWorkflowRetryRequest(browserSessionStorage(), ownerUID, request);
            pendingRetriesRef.current.delete(pendingWorkflowRetryKey(request));
        }
        setPendingRetryKeys(new Set(pendingRetriesRef.current.keys()));
    }, [detailsByRunId, ownerUID]);

    const assertCurrent = useCallback((startedIdentity: string) => {
        if (identityRef.current !== startedIdentity) throw new Error("流程编辑会话已变化");
    }, []);
    const updateCachedDetail = useCallback(
        (detail: WorkflowRunDetail) => {
            if (!ownerUID || !workflowId || detail.run.workflowId !== workflowId) return;
            queryClient.setQueryData(workflowRunDetailQueryKey(ownerUID, workflowId, detail.run.id), detail);
            void queryClient.invalidateQueries({ queryKey: workflowRunOverviewQueryKey(ownerUID, workflowId) });
        },
        [ownerUID, queryClient, workflowId],
    );
    const withOperation = useCallback(async <T>(startedIdentity: string, operation: () => Promise<T>) => {
        if (identityRef.current === startedIdentity) setOperationCount((count) => count + 1);
        try {
            return await operation();
        } finally {
            if (identityRef.current === startedIdentity) setOperationCount((count) => Math.max(0, count - 1));
        }
    }, []);

    const start = useCallback(
        (scope: WorkflowRunScope, revision: number) => {
            if (!ownerUID || !workflowId) return Promise.reject(new Error("流程尚未加载"));
            const scopeKey = workflowRunScopeKey(scope);
            const inFlight = startPromisesRef.current.get(scopeKey);
            if (inFlight) return inFlight;
            const startedIdentity = identityRef.current;
            const persisted = readPendingWorkflowRunRequest(browserSessionStorage(), ownerUID, workflowId, scope);
            const request = ensureWorkflowRunRequest(pendingByScopeRef.current.get(scopeKey) || persisted, workflowId, revision, nanoid, scope);
            writePendingWorkflowRunRequest(browserSessionStorage(), ownerUID, request);
            const pending = new Map(pendingByScopeRef.current).set(scopeKey, request);
            pendingByScopeRef.current = pending;
            setPendingByScope(pending);
            const promise = withOperation(startedIdentity, async () => {
                try {
                    const detail = await createWorkflowRun(workflowId, request.requestId, request.revision, request.scope);
                    assertCurrent(startedIdentity);
                    clearPendingWorkflowRunRequest(browserSessionStorage(), ownerUID, workflowId, request.scope);
                    const next = new Map(pendingByScopeRef.current);
                    if (next.get(scopeKey)?.requestId === request.requestId) next.delete(scopeKey);
                    pendingByScopeRef.current = next;
                    setPendingByScope(next);
                    setSelectedRunId(detail.run.id);
                    updateCachedDetail(detail);
                    return detail;
                } catch (error) {
                    assertCurrent(startedIdentity);
                    if (isDefinitiveWorkflowMutationError(error)) {
                        clearPendingWorkflowRunRequest(browserSessionStorage(), ownerUID, workflowId, request.scope);
                        const next = new Map(pendingByScopeRef.current);
                        if (next.get(scopeKey)?.requestId === request.requestId) next.delete(scopeKey);
                        pendingByScopeRef.current = next;
                        setPendingByScope(next);
                    } else {
                        void overviewQuery.refetch();
                    }
                    throw error;
                }
            });
            startPromisesRef.current.set(scopeKey, promise);
            void promise
                .finally(() => {
                    if (startPromisesRef.current.get(scopeKey) === promise) startPromisesRef.current.delete(scopeKey);
                })
                .catch(() => undefined);
            return promise;
        },
        [assertCurrent, overviewQuery, ownerUID, updateCachedDetail, withOperation, workflowId],
    );

    const retry = useCallback(
        (runId: string, nodeId: string, slotId: string) => {
            const startedIdentity = identityRef.current;
            return withOperation(startedIdentity, async () => {
                if (!ownerUID || !workflowId) throw new Error("流程尚未加载");
                const key = pendingWorkflowRetryKey({ runId, nodeId, slotId });
                let pending = pendingRetriesRef.current.get(key) || readPendingWorkflowRetryRequests(browserSessionStorage(), ownerUID, runId).find((request) => pendingWorkflowRetryKey(request) === key);
                const detail = detailsByRunId.get(runId) || queryClient.getQueryData<WorkflowRunDetail>(workflowRunDetailQueryKey(ownerUID, workflowId, runId));
                const output = findWorkflowOutput(detail?.outputs, nodeId, slotId);
                if (pending && workflowRetryWasAccepted(pending, output)) {
                    clearPendingWorkflowRetryRequest(browserSessionStorage(), ownerUID, pending);
                    pendingRetriesRef.current.delete(key);
                    pending = undefined;
                }
                if (!pending && !output) throw new Error("运行结果尚未加载");
                const request = pending || ensureWorkflowRetryRequest(undefined, { runId, nodeId, slotId, attempt: output!.attempt }, nanoid);
                writePendingWorkflowRetryRequest(browserSessionStorage(), ownerUID, request);
                pendingRetriesRef.current.set(key, request);
                setPendingRetryKeys(new Set(pendingRetriesRef.current.keys()));
                try {
                    const nextDetail = await retryWorkflowOutput(runId, { requestId: request.requestId, nodeId: request.nodeId, slotId: request.slotId });
                    assertCurrent(startedIdentity);
                    clearPendingWorkflowRetryRequest(browserSessionStorage(), ownerUID, request);
                    pendingRetriesRef.current.delete(key);
                    setPendingRetryKeys(new Set(pendingRetriesRef.current.keys()));
                    setSelectedRunId(nextDetail.run.id);
                    updateCachedDetail(nextDetail);
                    return nextDetail;
                } catch (error) {
                    assertCurrent(startedIdentity);
                    if (isDefinitiveWorkflowMutationError(error)) {
                        clearPendingWorkflowRetryRequest(browserSessionStorage(), ownerUID, request);
                        pendingRetriesRef.current.delete(key);
                        setPendingRetryKeys(new Set(pendingRetriesRef.current.keys()));
                    } else {
                        void queryClient.invalidateQueries({ queryKey: workflowRunDetailQueryKey(ownerUID, workflowId, runId) });
                    }
                    throw error;
                }
            });
        },
        [assertCurrent, detailsByRunId, ownerUID, queryClient, updateCachedDetail, withOperation, workflowId],
    );

    const stop = useCallback(
        (runId: string) => {
            const startedIdentity = identityRef.current;
            return withOperation(startedIdentity, async () => {
                if (!ownerUID || !workflowId) throw new Error("流程尚未加载");
                const detail = await stopWorkflowRun(runId);
                assertCurrent(startedIdentity);
                updateCachedDetail(detail);
                return detail;
            });
        },
        [assertCurrent, ownerUID, updateCachedDetail, withOperation, workflowId],
    );

    const resumeVideo = useCallback(
        (taskID: string) => {
            const startedIdentity = identityRef.current;
            return withOperation(startedIdentity, async () => {
                if (!ownerUID || !workflowId) throw new Error("流程尚未加载");
                const task = await resumeVideoTask(taskID);
                assertCurrent(startedIdentity);
                void queryClient.invalidateQueries({ queryKey: workflowRunOverviewQueryKey(ownerUID, workflowId) });
                void queryClient.invalidateQueries({ queryKey: ["workflow-run", ownerUID, workflowId] });
                return task;
            });
        },
        [assertCurrent, ownerUID, queryClient, withOperation, workflowId],
    );

    const refresh = useCallback(async () => {
        await overviewQuery.refetch();
        await Promise.all(detailQueries.map((query) => query.refetch()));
    }, [detailQueries, overviewQuery]);

    const queryError = overviewQuery.error || detailQueries.find((query) => query.error)?.error;
    return {
        overview: overviewQuery.data,
        detailsByRunId,
        detailByNode,
        selectedRun,
        selectedDetail,
        selectedError: selectedDetailQuery?.error,
        overviewError: overviewQuery.error,
        detailErrorsByRunId: new Map(detailQueries.flatMap((query, index) => query.error && !query.data ? [[relevantDetailIds[index]!, query.error] as const] : [])),
        selectedRunId,
        selectRun: setSelectedRunId,
        start,
        retry,
        stop,
        resumeVideo,
        pendingByScope,
        pendingRetryKeys,
        loading: overviewQuery.isPending || detailQueries.some((query) => query.isPending) || operationCount > 0,
        error: queryError,
        refresh,
    };
}

export { workflowRunScopeKey };
