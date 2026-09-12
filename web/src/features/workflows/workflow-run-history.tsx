"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Empty, Pagination, Skeleton } from "antd";
import { ArrowLeft, Clock3, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { nanoid } from "nanoid";

import { appPath } from "@/lib/app-path";
import { ApiRequestError } from "@/services/api/request";
import { portalSessionQuery } from "@/services/api/session";
import { deleteWorkflowRun, fetchWorkflowRun, fetchWorkflowRuns, retryWorkflowOutput, stopWorkflowRun } from "@/services/api/workflows";
import { WorkflowRunDetail } from "./workflow-run-detail";
import { clearPendingWorkflowRetryRequest, ensureWorkflowRetryRequest, pendingWorkflowRetryKey, readPendingWorkflowRetryRequests, workflowRetryWasAccepted, writePendingWorkflowRetryRequest, type PendingWorkflowRetryRequest } from "./workflow-run-requests";
import { isWorkflowRunActive, workflowOutputKey, workflowRunStatusText } from "./workflow-run-state";

export function WorkflowRunHistory() {
    const session = useQuery(portalSessionQuery);
    const ownerUID = session.data?.user.uid;
    return <WorkflowRunHistoryContent key={ownerUID || "pending"} ownerUID={ownerUID} />;
}

function WorkflowRunHistoryContent({ ownerUID }: { ownerUID?: string }) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { message, modal } = App.useApp();
    const [page, setPage] = useState(1);
    const [selectedRunId, setSelectedRunId] = useState<string>();
    const [pendingRetryRequests, setPendingRetryRequests] = useState<Record<string, PendingWorkflowRetryRequest>>({});
    const pageSize = 16;
    const runs = useQuery({
        queryKey: ["workflow-runs", ownerUID, page, pageSize],
        queryFn: () => fetchWorkflowRuns(page, pageSize),
        enabled: Boolean(ownerUID),
        refetchInterval: (query) => query.state.data?.items.some((run) => isWorkflowRunActive(run.status)) ? 2500 : false,
    });
    const detail = useQuery({
        queryKey: ["workflow-run", ownerUID, selectedRunId],
        queryFn: () => fetchWorkflowRun(selectedRunId!),
        enabled: Boolean(ownerUID && selectedRunId),
        refetchInterval: (query) => isWorkflowRunActive(query.state.data?.run.status) ? 1500 : false,
    });
    useEffect(() => {
        setPendingRetryRequests({});
        if (!ownerUID || !selectedRunId || typeof window === "undefined") return;
        const restored = readPendingWorkflowRetryRequests(window.sessionStorage, ownerUID, selectedRunId);
        setPendingRetryRequests(Object.fromEntries(restored.map((request) => [pendingWorkflowRetryKey(request), request])));
    }, [ownerUID, selectedRunId]);
    const updateDetail = (value: NonNullable<typeof detail.data>) => {
        queryClient.setQueryData(["workflow-run", ownerUID, value.run.id], value);
        void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
    };
    useEffect(() => {
        if (!detail.data) return;
        const accepted = Object.entries(pendingRetryRequests).filter(([, pending]) => pending.runId === detail.data!.run.id && workflowRetryWasAccepted(pending, detail.data!.outputs.find((output) => output.nodeId === pending.nodeId && output.slotId === pending.slotId)));
        if (!accepted.length) return;
        if (ownerUID && typeof window !== "undefined") accepted.forEach(([, pending]) => clearPendingWorkflowRetryRequest(window.sessionStorage, ownerUID, pending));
        setPendingRetryRequests((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !accepted.some(([acceptedKey]) => acceptedKey === key))));
    }, [detail.data, ownerUID, pendingRetryRequests]);
    const stop = useMutation({
        mutationFn: (id: string) => stopWorkflowRun(id),
        onSuccess: updateDetail,
        onError: (error) => message.error(error instanceof Error ? error.message : "停止运行失败"),
    });
    const retry = useMutation({
        retry: false,
        mutationFn: (request: PendingWorkflowRetryRequest) => retryWorkflowOutput(request.runId, { requestId: request.requestId, nodeId: request.nodeId, slotId: request.slotId }),
        onSuccess: (value, request) => {
            updateDetail(value);
            const key = pendingWorkflowRetryKey(request);
            if (ownerUID && typeof window !== "undefined") clearPendingWorkflowRetryRequest(window.sessionStorage, ownerUID, request);
            setPendingRetryRequests((current) => {
                if (current[key]?.requestId !== request.requestId) return current;
                const next = { ...current };
                delete next[key];
                return next;
            });
        },
        onError: (error, request) => {
            if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
                const key = pendingWorkflowRetryKey(request);
                if (ownerUID && typeof window !== "undefined") clearPendingWorkflowRetryRequest(window.sessionStorage, ownerUID, request);
                setPendingRetryRequests((current) => {
                    if (current[key]?.requestId !== request.requestId) return current;
                    const next = { ...current };
                    delete next[key];
                    return next;
                });
                message.error(error.message);
                return;
            }
            void detail.refetch();
            message.warning("重试请求结果待确认，可再次点击并使用同一请求确认");
        },
    });
    const remove = useMutation({
        mutationFn: (id: string) => deleteWorkflowRun(id),
        onSuccess: () => {
            if (ownerUID && selectedRunId && typeof window !== "undefined") Object.values(pendingRetryRequests).filter((request) => request.runId === selectedRunId).forEach((request) => clearPendingWorkflowRetryRequest(window.sessionStorage, ownerUID, request));
            setSelectedRunId(undefined);
            void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
            message.success("运行记录已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除运行记录失败"),
    });
    const confirmDelete = () => {
        if (!detail.data) return;
        modal.confirm({
            title: "删除运行记录",
            content: "删除后将解除这次运行对输入和输出素材的持有，且无法恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => remove.mutateAsync(detail.data.run.id),
        });
    };
    const startRetry = (nodeId: string, slotId: string) => {
        if (!detail.data) return;
        const output = detail.data.outputs.find((item) => item.nodeId === nodeId && item.slotId === slotId);
        if (!output) return;
        const key = pendingWorkflowRetryKey({ runId: detail.data.run.id, nodeId, slotId });
        const request = ensureWorkflowRetryRequest(pendingRetryRequests[key], { runId: detail.data.run.id, nodeId, slotId, attempt: output.attempt }, nanoid);
        if (ownerUID && typeof window !== "undefined") writePendingWorkflowRetryRequest(window.sessionStorage, ownerUID, request);
        setPendingRetryRequests((current) => ({ ...current, [key]: request }));
        retry.mutate(request);
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <button type="button" className="mb-3 inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" onClick={() => router.push(appPath("/workflows"))}><ArrowLeft className="size-3.5" />流程库</button>
                        <h1 className="text-3xl font-semibold">运行记录</h1>
                        <p className="mt-2 text-sm text-stone-500">运行使用独立快照；删除流程定义后，记录和结果仍保留在这里。</p>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} loading={runs.isFetching} onClick={() => void runs.refetch()}>刷新</Button>
                </header>

                {runs.isPending ? (
                    <div className="space-y-3">{Array.from({ length: 4 }, (_, index) => <Skeleton.Node key={index} active className="!h-24 !w-full !rounded-xl" />)}</div>
                ) : runs.isError ? (
                    <Empty description={runs.error instanceof Error ? runs.error.message : "运行记录加载失败"}><Button onClick={() => void runs.refetch()}>重新加载</Button></Empty>
                ) : runs.data.items.length ? (
                    <>
                        <div className="divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                            {runs.data.items.map((run) => (
                                <button key={run.id} type="button" className="flex w-full items-center justify-between gap-4 px-2 py-4 text-left transition hover:bg-stone-50 dark:hover:bg-white/5" onClick={() => setSelectedRunId(run.id)}>
                                    <div className="min-w-0">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <h2 className="truncate text-sm font-medium">{run.title}</h2>
                                            <span className="truncate text-xs text-stone-500">{run.scopeType === "frame" ? run.frameName || "包裹框" : "整个流程"}</span>
                                            <span className="shrink-0 text-xs text-stone-400">v{run.revision}</span>
                                        </div>
                                        <p className="mt-1 flex items-center gap-1 text-xs text-stone-500"><Clock3 className="size-3" />{new Date(run.createdAt).toLocaleString("zh-CN")}</p>
                                    </div>
                                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${run.status === "failed" ? "bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300" : run.status === "attention_required" ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300" : isWorkflowRunActive(run.status) ? "bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-300" : "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300"}`}>{workflowRunStatusText(run.status)}</span>
                                </button>
                            ))}
                        </div>
                        {runs.data.total > pageSize ? <Pagination current={page} pageSize={pageSize} total={runs.data.total} showSizeChanger={false} className="self-center" onChange={setPage} /> : null}
                    </>
                ) : <Empty description="还没有运行记录" />}
            </div>
            <Drawer title="运行详情" open={Boolean(selectedRunId)} width="min(920px, 94vw)" destroyOnHidden onClose={() => setSelectedRunId(undefined)}>
                {detail.isError && !detail.data ? <Empty description={detail.error instanceof Error ? detail.error.message : "运行详情加载失败"}><Button onClick={() => void detail.refetch()}>重新加载</Button></Empty> : (
                    <WorkflowRunDetail
                        detail={detail.data}
                        stopping={stop.isPending}
                        deleting={remove.isPending}
                        retryingKey={retry.isPending ? workflowOutputKey(retry.variables.nodeId, retry.variables.slotId) : undefined}
                        confirmingRetryKeys={new Set(Object.values(pendingRetryRequests).filter((request) => request.runId === detail.data?.run.id).map((request) => workflowOutputKey(request.nodeId, request.slotId)))}
                        onStop={detail.data ? () => stop.mutate(detail.data.run.id) : undefined}
                        onDelete={detail.data ? confirmDelete : undefined}
                        onRetry={detail.data && ownerUID ? startRetry : undefined}
                    />
                )}
            </Drawer>
        </main>
    );
}
