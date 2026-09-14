"use client";

import { Button, Empty, Modal, Spin } from "antd";
import { CircleAlert, Image as ImageIcon, RefreshCw, Square, Trash2, Video } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { ScopedVideoResourceProvider } from "@/app/(user)/canvas/components/canvas-video-content";
import { useCanvasImageResources } from "@/app/(user)/canvas/media/use-canvas-image-resources";
import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";
import { getRemoteImageAccess } from "@/services/image-storage";
import { WorkflowMediaPreview } from "./workflow-media-preview";
import { workflowConnectionKey } from "./workflow-graph";
import { isRetryableImageOutput, isWorkflowRunActive, workflowOutputKey, workflowOutputResourceNodeId, workflowOutputStatusText, workflowRunStatusText, workflowVideoResumeTaskID } from "./workflow-run-state";
import type { WorkflowGraph, WorkflowNode, WorkflowOutputExecution, WorkflowOutputSlot, WorkflowRunDetail as WorkflowRunDetailRecord } from "./types";

type Preview = { nodeId: string; mediaId: string; type: "image" | "video" };

export function WorkflowRunDetail({ detail, stopping, deleting, retryingKey, resumingVideoTaskIDs, confirmingRetryKeys, onStop, onDelete, onRetry, onResumeVideo }: {
    detail?: WorkflowRunDetailRecord;
    stopping?: boolean;
    deleting?: boolean;
    retryingKey?: string;
    resumingVideoTaskIDs?: ReadonlySet<string>;
    confirmingRetryKeys?: ReadonlySet<string>;
    onStop?: () => void;
    onDelete?: () => void;
    onRetry?: (nodeId: string, slotId: string) => void;
    onResumeVideo?: (taskId: string) => void;
}) {
    const [preview, setPreview] = useState<Preview>();
    const previewTarget = useMemo(() => {
        if (!preview || preview.type !== "image") return [];
        const node = { id: preview.nodeId, type: CanvasNodeType.Image, title: "", position: { x: 0, y: 0 }, width: 720, height: 520, metadata: { mediaId: preview.mediaId } } satisfies CanvasNodeData;
        return [{ node, visible: true, pinned: true, prefetch: false, preview: true }];
    }, [preview]);
    const resolveImageAccess = useCallback((node: CanvasNodeData) => getRemoteImageAccess(node.metadata!.mediaId!), []);
    const images = useCanvasImageResources({ targets: previewTarget, scale: 1, resolveAccess: resolveImageAccess });

    if (!detail) return <div className="flex min-h-72 items-center justify-center"><Spin /></div>;
    const active = isWorkflowRunActive(detail.run.status);
    const slotByKey = new Map<string, WorkflowOutputSlot>();
    detail.graph.nodes.forEach((node) => node.outputs?.forEach((slot) => slotByKey.set(workflowOutputKey(node.id, slot.id), slot)));
    const hasResumableVideo = detail.outputs.some((output) => Boolean(workflowVideoResumeTaskID(detail, output)));

    const openOutput = (output: WorkflowOutputExecution) => {
        const slot = slotByKey.get(workflowOutputKey(output.nodeId, output.slotId));
        if (!slot || output.status !== "succeeded" || !output.mediaId) return;
        setPreview({ nodeId: workflowOutputResourceNodeId(detail.run.id, output.nodeId, output.slotId), mediaId: output.mediaId, type: slot.type });
    };

    return (
        <ScopedVideoResourceProvider scope={`workflow-run-detail:${detail.run.id}`} nodeIds={preview?.type === "video" ? [preview.nodeId] : []}>
            <div className="space-y-6">
                <section className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 pb-4 dark:border-stone-800">
                    <div className="min-w-0">
                        <h2 className="truncate text-lg font-semibold">{detail.run.title}</h2>
                        <p className="mt-1 text-xs text-stone-500">{detail.run.scopeType === "frame" ? `包裹框：${detail.run.frameName || "未命名"}` : "整个流程"}</p>
                        <p className="mt-1 text-xs text-stone-500">快照 v{detail.run.revision} · {new Date(detail.run.createdAt).toLocaleString("zh-CN")}</p>
                        <p className="mt-2 text-sm">{workflowRunStatusText(detail.run.status)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {active && !detail.run.stopRequested && onStop ? <Button danger icon={<Square className="size-3.5" />} loading={stopping} onClick={onStop}>停止</Button> : null}
                        {!active && onDelete ? <Button danger type="text" icon={<Trash2 className="size-3.5" />} loading={deleting} onClick={onDelete}>删除记录</Button> : null}
                    </div>
                </section>

                {detail.run.status === "attention_required" ? (
                    <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                        <CircleAlert className="mt-0.5 size-4 shrink-0" />
                        {hasResumableVideo ? "视频任务需要确认。请恢复原任务，页面会继续刷新同一任务的状态，不会创建新的生成任务。" : "生成任务需要确认。页面会继续刷新原任务状态，不会创建新的生成任务。"}
                    </div>
                ) : null}

                <section>
                    <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-medium">只读运行快照</h3>
                        <span className="text-xs text-stone-500">当前流程修改不会改变此快照</span>
                    </div>
                    <WorkflowRunSnapshot graph={detail.graph} outputs={detail.outputs} onOpenOutput={openOutput} />
                </section>

                <section>
                    <h3 className="mb-3 text-sm font-medium">输出结果</h3>
                    {detail.outputs.length ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            {detail.outputs.map((output) => {
                                const slot = slotByKey.get(workflowOutputKey(output.nodeId, output.slotId));
                                const retryable = Boolean(slot && isRetryableImageOutput(slot, output, detail.run));
                                const videoTaskID = workflowVideoResumeTaskID(detail, output);
                                const key = workflowOutputKey(output.nodeId, output.slotId);
                                return (
                                    <div key={key} className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 text-sm">
                                                    {slot?.type === "video" ? <Video className="size-4" /> : <ImageIcon className="size-4" />}
                                                    <span>{workflowOutputStatusText(output.status)}</span>
                                                    <span className="text-xs text-stone-400">第 {output.attempt} 次</span>
                                                </div>
                                                {output.error ? <p className="mt-2 break-words text-xs leading-5 text-red-500">{output.error}</p> : null}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1">
                                                {output.status === "succeeded" && output.mediaId ? <Button type="text" size="small" onClick={() => openOutput(output)}>查看</Button> : null}
                                                {retryable && onRetry ? <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} loading={retryingKey === key} onClick={() => onRetry(output.nodeId, output.slotId)}>{confirmingRetryKeys?.has(key) ? "确认重试" : "重试"}</Button> : null}
                                                {videoTaskID && onResumeVideo ? <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} loading={resumingVideoTaskIDs?.has(videoTaskID)} onClick={() => onResumeVideo(videoTaskID)}>恢复原任务</Button> : null}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此运行没有生成输出" />}
                </section>

                {detail.attempts.length ? (
                    <section>
                        <h3 className="mb-3 text-sm font-medium">尝试记录</h3>
                        <div className="divide-y divide-stone-200 rounded-xl border border-stone-200 px-3 dark:divide-stone-800 dark:border-stone-800">
                            {detail.attempts.map((attempt) => (
                                <div key={attempt.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                                    <span className="min-w-0 truncate">第 {attempt.attempt} 次 · {attempt.taskType === "video" ? "视频" : "图片"} · {workflowOutputStatusText(attempt.status)}</span>
                                    <span className="shrink-0 text-stone-500">{new Date(attempt.updatedAt).toLocaleString("zh-CN")}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>
            <Modal title={preview?.type === "video" ? "视频结果" : "图片结果"} open={Boolean(preview)} footer={null} width={860} destroyOnHidden onCancel={() => setPreview(undefined)}>
                {preview ? (
                    <div className="aspect-video overflow-hidden rounded-xl bg-black/5 dark:bg-white/5">
                        <WorkflowMediaPreview
                            nodeId={preview.nodeId}
                            mediaId={preview.mediaId}
                            type={preview.type}
                            visible
                            imageUrl={images.resources.get(preview.nodeId)?.url}
                            imageStorageKey={images.resources.get(preview.nodeId)?.storageKey}
                            imageError={images.errors.get(preview.nodeId)}
                            onRetryImage={() => images.retry(preview.nodeId)}
                            onImageLoaded={(storageKey) => images.acknowledgeRendered(preview.nodeId, storageKey)}
                        />
                    </div>
                ) : null}
            </Modal>
        </ScopedVideoResourceProvider>
    );
}

function WorkflowRunSnapshot({ graph, outputs, onOpenOutput }: { graph: WorkflowGraph; outputs: WorkflowOutputExecution[]; onOpenOutput: (output: WorkflowOutputExecution) => void }) {
    const scale = 0.42;
    const objects = graph.nodes.flatMap((node) => [{ position: node.position, width: node.width || 340, height: node.height || 240 }, ...(node.outputs || []).map((slot) => ({ position: slot.position || node.position, width: slot.width || (slot.type === "image" ? 340 : 420), height: slot.height || 240 }))]);
    if (!objects.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="空流程" />;
    const minX = Math.min(...objects.map((item) => item.position.x)) - 32;
    const minY = Math.min(...objects.map((item) => item.position.y)) - 32;
    const maxX = Math.max(...objects.map((item) => item.position.x + item.width)) + 32;
    const maxY = Math.max(...objects.map((item) => item.position.y + item.height)) + 32;
    const width = Math.max(680, (maxX - minX) * scale);
    const height = Math.max(280, Math.min(640, (maxY - minY) * scale));
    const position = (item: { x: number; y: number }) => ({ x: (item.x - minX) * scale, y: (item.y - minY) * scale });
    const nodeLabel = (node: WorkflowNode) => node.type === "text_input" ? "文本输入" : node.type === "image_input" ? "图片输入" : node.type === "video_input" ? "视频输入" : node.type === "image_generation" ? "图片生成" : "视频生成";
    const outputByKey = new Map(outputs.map((output) => [workflowOutputKey(output.nodeId, output.slotId), output]));
    const path = (from: { x: number; y: number }, to: { x: number; y: number }) => {
        const distance = Math.max(36, Math.abs(to.x - from.x) * 0.45);
        return `M ${from.x} ${from.y} C ${from.x + distance} ${from.y}, ${to.x - distance} ${to.y}, ${to.x} ${to.y}`;
    };
    const sourcePoint = (nodeId: string, slotId: string) => {
        const node = graph.nodes.find((item) => item.id === nodeId);
        if (!node) return undefined;
        if (slotId === "output") {
            const start = position(node.position);
            return { x: start.x + (node.width || 340) * scale, y: start.y + (node.height || 240) * scale / 2 };
        }
        const slot = node.outputs?.find((item) => item.id === slotId);
        if (!slot) return undefined;
        const start = position(slot.position || node.position);
        return { x: start.x + (slot.width || 340) * scale, y: start.y + (slot.height || 240) * scale / 2 };
    };
    return (
        <div className="overflow-auto rounded-xl border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950/40" style={{ height }}>
            <div className="relative" style={{ width, height: Math.max(height, (maxY - minY) * scale) }}>
                <svg className="pointer-events-none absolute inset-0 h-full w-full">
                    {graph.nodes.flatMap((node) => (node.outputs || []).map((slot) => {
                        const fromStart = position(node.position);
                        const toStart = position(slot.position || node.position);
                        const from = { x: fromStart.x + (node.width || 340) * scale, y: fromStart.y + (node.height || 240) * scale / 2 };
                        const to = { x: toStart.x, y: toStart.y + (slot.height || 240) * scale / 2 };
                        return <path key={`slot:${workflowOutputKey(node.id, slot.id)}`} d={path(from, to)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" className="text-stone-300 dark:text-stone-700" />;
                    }))}
                    {graph.connections.map((connection) => {
                        const from = sourcePoint(connection.sourceNodeId, connection.sourceSlotId);
                        const target = graph.nodes.find((node) => node.id === connection.targetNodeId);
                        if (!from || !target) return null;
                        const targetStart = position(target.position);
                        const to = { x: targetStart.x, y: targetStart.y + (target.height || 240) * scale / 2 };
                        return <path key={`connection:${workflowConnectionKey(connection)}`} d={path(from, to)} fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400 dark:text-stone-600" />;
                    })}
                </svg>
                {graph.nodes.map((node) => {
                    const start = position(node.position);
                    const stepStatus = outputs.find((output) => output.nodeId === node.id)?.status;
                    return <div key={node.id} className="absolute flex flex-col justify-between overflow-hidden rounded-xl border border-stone-300 bg-white p-2 text-xs shadow-sm dark:border-stone-700 dark:bg-stone-900" style={{ left: start.x, top: start.y, width: Math.max(120, (node.width || 340) * scale), height: Math.max(76, (node.height || 240) * scale) }}><span className="font-medium">{nodeLabel(node)}</span><span className="line-clamp-2 text-[11px] text-stone-500">{node.type === "text_input" ? node.text || "空文本" : stepStatus ? workflowOutputStatusText(stepStatus) : node.mediaId ? "已选择素材" : "未选择素材"}</span></div>;
                })}
                {graph.nodes.flatMap((node) => (node.outputs || []).map((slot) => {
                    const start = position(slot.position || node.position);
                    const output = outputByKey.get(workflowOutputKey(node.id, slot.id));
                    const canOpen = output?.status === "succeeded" && Boolean(output.mediaId);
                    return <button key={workflowOutputKey(node.id, slot.id)} type="button" disabled={!canOpen} className="absolute flex flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border border-stone-300 bg-white p-2 text-xs shadow-sm disabled:cursor-default dark:border-stone-700 dark:bg-stone-900" style={{ left: start.x, top: start.y, width: Math.max(112, (slot.width || 340) * scale), height: Math.max(76, (slot.height || 240) * scale) }} onClick={() => output && onOpenOutput(output)}>{slot.type === "image" ? <ImageIcon className="size-4" /> : <Video className="size-4" />}<span>{workflowOutputStatusText(output?.status)}</span>{canOpen ? <span className="text-[10px] text-stone-500">点击预览</span> : null}</button>;
                }))}
            </div>
        </div>
    );
}
