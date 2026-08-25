"use client";

import { useQuery } from "@tanstack/react-query";
import { Empty, Input, Pagination, Select, Spin, Tag } from "antd";
import { useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useEffect, useState } from "react";

import { fetchOperationLogs, type OperationLog } from "@/services/api/operation-logs";

const PAGE_SIZE = 20;

const actionLabels: Record<string, string> = {
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
    return <Suspense><AdminOperationsContent /></Suspense>;
}

function AdminOperationsContent() {
    const searchParams = useSearchParams();
    const actorFromMember = searchParams.get("actor") || "";
    const [page, setPage] = useState(1);
    const [action, setAction] = useState("");
    const [status, setStatus] = useState("");
    const [actor, setActor] = useState(actorFromMember);
    const deferredActor = useDeferredValue(actor);
    const query = useQuery({ queryKey: ["operation-logs", page, action, status, deferredActor], queryFn: () => fetchOperationLogs({ page, pageSize: PAGE_SIZE, action, status, actor: deferredActor }) });

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
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">仅保留最近 7 天的可信服务端操作。</p>
                </div>
            </div>
            <div className="flex flex-wrap gap-3">
                <Input.Search value={actor} allowClear placeholder="按用户姓名或 UID 搜索" className="w-60" onChange={(event) => updateFilter(setActor, event.target.value)} />
                <Select value={action || undefined} allowClear className="w-40" placeholder="全部操作" onChange={(value) => updateFilter(setAction, value || "")} options={Object.entries(actionLabels).map(([value, label]) => ({ value, label }))} />
                <Select
                    value={status || undefined}
                    allowClear
                    className="w-32"
                    placeholder="全部状态"
                    onChange={(value) => updateFilter(setStatus, value || "")}
                    options={[
                        { value: "submitted", label: "已提交" },
                        { value: "success", label: "成功" },
                        { value: "failure", label: "失败" },
                    ]}
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
                        <OperationStatusTag status={item.status} />
                    </div>
                    {item.targetName ? <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{item.targetName}</p> : null}
                    {item.prompt ? (
                        <details className="mt-2 text-sm">
                            <summary className="cursor-pointer text-stone-500 dark:text-stone-400">查看完整提示词</summary>
                            <p className="mt-2 whitespace-pre-wrap break-words rounded bg-stone-50 p-3 text-stone-700 dark:bg-stone-900 dark:text-stone-200">{item.prompt}</p>
                        </details>
                    ) : null}
                    {item.requestSummary ? <OperationRequestSummary summary={item.requestSummary} /> : null}
                    {item.errorMessage ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{item.errorMessage}</p> : null}
                </div>
                <time className="shrink-0 text-xs text-stone-500 dark:text-stone-400">{new Date(item.createdAt).toLocaleString()}</time>
            </div>
        </article>
    );
}

function OperationStatusTag({ status }: { status: OperationLog["status"] }) {
    if (status === "submitted") return <Tag color="blue">已提交</Tag>;
    if (status === "success") return <Tag color="green">成功</Tag>;
    return <Tag color="red">失败</Tag>;
}

function OperationRequestSummary({ summary }: { summary: string }) {
    let content = summary;
    try {
        content = JSON.stringify(JSON.parse(summary), null, 2);
    } catch {
        // Historical malformed audit data remains readable without breaking the record.
    }
    return (
        <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-stone-500 dark:text-stone-400">查看请求参数</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-stone-50 p-3 text-xs text-stone-700 dark:bg-stone-900 dark:text-stone-200">{content}</pre>
        </details>
    );
}
