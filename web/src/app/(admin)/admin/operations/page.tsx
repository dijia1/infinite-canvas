"use client";

import { useQuery } from "@tanstack/react-query";
import { Empty, Input, Pagination, Select, Spin, Tag } from "antd";
import { useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useEffect, useState } from "react";

import { formatCNYAmount } from "@/lib/money";
import { fetchOperationLogs, type OperationLog } from "@/services/api/operation-logs";

import { generationStatusOptions, operationStatusPresentation } from "./operation-status";

const PAGE_SIZE = 20;

const actionLabels: Record<string, string> = {
    media_created: "资源创建",
    media_reference_added: "加入画布",
    media_reference_removed: "移出画布",
    media_cleanup_scheduled: "进入待清理",
    media_cleanup_cancelled: "取消清理",
    media_cleanup_started: "开始清理",
    media_delete_requested: "申请删除资源",
    media_deleted: "资源已删除",
    media_delete_failed: "资源删除失败",
    media_access_failed: "资源访问失败",
    image_generate: "图片生成",
    image_edit: "图片编辑",
    video_generate: "视频生成",
    private_image_upload: "上传私人图片",
    private_image_delete: "删除私人图片",
    public_image_upload: "上传公共图片",
    public_image_rename: "重命名公共图片",
    public_image_update: "更新公共图片",
    public_image_move: "移动公共图片",
    public_image_delete: "删除公共图片",
    public_folder_create: "新建公共文件夹",
    public_folder_rename: "重命名公共文件夹",
    public_folder_delete: "删除公共文件夹",
    ai_settings_save: "保存 AI 配置",
    portal_member_sync: "同步 Portal 用户",
};

export default function AdminOperationsPage() {
    return (
        <Suspense>
            <AdminOperationsContent />
        </Suspense>
    );
}

function AdminOperationsContent() {
    const searchParams = useSearchParams();
    const actorFromMember = searchParams.get("actor") || "";
    const [page, setPage] = useState(1);
    const [action, setAction] = useState("");
    const [status, setStatus] = useState("");
    const [actor, setActor] = useState(actorFromMember);
    const deferredActor = useDeferredValue(actor);
    const [mediaId, setMediaId] = useState(searchParams.get("mediaId") || "");
    const deferredMediaId = useDeferredValue(mediaId);
    const query = useQuery({
        queryKey: ["operation-logs", page, action, status, deferredActor, deferredMediaId],
        queryFn: () => fetchOperationLogs({ page, pageSize: PAGE_SIZE, action, status, actor: deferredActor, mediaId: deferredMediaId }),
        refetchInterval: 5000,
    });

    useEffect(() => {
        setPage(1);
        setActor(actorFromMember);
    }, [actorFromMember]);

    const updateFilter = (setter: (value: string) => void, value: string) => {
        setPage(1);
        setter(value);
    };

    return (
        <main className="space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold">操作记录</h1>
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">图片生命周期保留 30 天，其他操作保留 7 天。重复资源错误每 30 分钟合并记录。</p>
                </div>
            </div>
            <div className="flex flex-wrap gap-3">
                <Input.Search value={actor} allowClear placeholder="按用户姓名或 UID 搜索" className="w-60" onChange={(event) => updateFilter(setActor, event.target.value)} />
                <Input.Search value={mediaId} allowClear placeholder="按完整图片 / 资源 ID 查询" className="w-72" onChange={(event) => updateFilter(setMediaId, event.target.value)} />
                <Select value={action || undefined} allowClear className="w-40" placeholder="全部操作" onChange={(value) => updateFilter(setAction, value || "")} options={Object.entries(actionLabels).map(([value, label]) => ({ value, label }))} />
                <Select
                    value={status || undefined}
                    allowClear
                    className="w-32"
                    placeholder="全部状态"
                    onChange={(value) => updateFilter(setStatus, value || "")}
                    options={[{ value: "submitted", label: "已提交" }, { value: "success", label: "成功" }, { value: "failure", label: "失败" }, ...generationStatusOptions]}
                />
            </div>
            {query.isLoading ? (
                <div className="flex justify-center py-16">
                    <Spin />
                </div>
            ) : query.data?.items.length ? (
                <div className="space-y-3">
                    {query.data.items.map((item) => (
                        <OperationLogItem key={item.id} item={item} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.isError ? "读取操作记录失败" : "暂无操作记录"} />
            )}
            {(query.data?.total || 0) > PAGE_SIZE ? <Pagination current={page} pageSize={PAGE_SIZE} total={query.data?.total} showSizeChanger={false} onChange={setPage} /> : null}
        </main>
    );
}

function OperationLogItem({ item }: { item: OperationLog }) {
    return (
        <article className="rounded-lg border border-stone-200 bg-background p-4 dark:border-stone-800">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.actorName}</span>
                        <span className="text-sm text-stone-500 dark:text-stone-400">{actionLabels[item.action] || item.action}</span>
                        <OperationStatusTag item={item} />
                    </div>
                    {item.targetType === "media_lifecycle" ? <p className="mt-1 break-all font-mono text-xs text-stone-500">资源 ID：{item.targetId}</p> : null}
                    {item.targetName ? <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{item.targetName}</p> : null}
                    {item.providerTaskId ? <p className="mt-1 break-all font-mono text-xs text-stone-500 dark:text-stone-400">上游任务 ID：{item.providerTaskId}</p> : null}
                    {item.image ? (
                        <div className="mt-2 space-y-1 text-xs text-stone-500 dark:text-stone-400">
                            <p>
                                {item.image.providerName || item.image.providerId} · {item.image.resolution} · {item.image.size} · {item.image.quality} · {item.image.outputFormat} / {item.image.background} · 费用快照 {formatCNYAmount(item.image.amount)}
                            </p>
                            <p className="break-all font-mono">
                                模型 ID：{item.image.providerId} · 本地任务 ID：{item.image.taskId}
                            </p>
                        </div>
                    ) : null}
                    {item.video ? (
                        <div className="mt-2 space-y-1 text-xs text-stone-500 dark:text-stone-400">
                            <p>
                                {item.video.providerName || item.video.providerId} · {item.video.resolution} · {item.video.size} · {item.video.seconds} 秒 · 音频{item.video.generateAudio ? "开启" : "关闭"} · 费用快照 {formatCNYAmount(item.video.amount)}
                            </p>
                            <p className="break-all font-mono">
                                模型 ID：{item.video.providerId} · 本地任务 ID：{item.video.taskId}
                            </p>
                        </div>
                    ) : null}
                    {item.prompt ? (
                        <details className="mt-2 text-sm">
                            <summary className="cursor-pointer text-stone-500 dark:text-stone-400">查看完整提示词</summary>
                            <p className="mt-2 whitespace-pre-wrap break-words rounded bg-stone-50 p-3 text-stone-700 dark:bg-stone-900 dark:text-stone-200">{item.prompt}</p>
                        </details>
                    ) : null}
                    {item.requestSummary ? <OperationRequestSummary summary={item.requestSummary} lifecycle={item.targetType === "media_lifecycle"} /> : null}
                    {item.errorMessage ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{item.errorMessage}</p> : null}
                </div>
                <time className="shrink-0 text-xs text-stone-500 dark:text-stone-400">{new Date(item.createdAt).toLocaleString()}</time>
            </div>
        </article>
    );
}

function OperationStatusTag({ item }: { item: OperationLog }) {
    const presentation = operationStatusPresentation(item);
    return <Tag color={presentation.color}>{presentation.label}</Tag>;
}

function OperationRequestSummary({ summary, lifecycle = false }: { summary: string; lifecycle?: boolean }) {
    let content = summary;
    try {
        content = JSON.stringify(JSON.parse(summary), null, 2);
    } catch {
        // Historical malformed audit data remains readable without breaking the record.
    }
    return (
        <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-stone-500 dark:text-stone-400">{lifecycle ? "查看生命周期详情" : "查看请求参数"}</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-stone-50 p-3 text-xs text-stone-700 dark:bg-stone-900 dark:text-stone-200">{content}</pre>
        </details>
    );
}
