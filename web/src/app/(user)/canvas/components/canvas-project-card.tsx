"use client";

import { Check, Copy, Pencil, Share2, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { App, Button, Input } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import { appPath } from "@/lib/app-path";
import type { CanvasSummary } from "@/services/api/canvas-projects";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import { CanvasShareDialog } from "./canvas-share-dialog";
import { CanvasSyncFeedback } from "./canvas-sync-feedback";
import { createCanvasProjectCardActionGate, describeCanvasSummaryCounts, loadCanvasProjectForCardAction, shareCanvasProjectStatus } from "./canvas-project-card-actions";

type CanvasProjectCardAction = "copy" | "rename" | "share";

export function CanvasProjectCard({ project }: { project: CanvasSummary }) {
    const { message } = App.useApp();
    const router = useRouter();
    const ensureProjectDetail = useCanvasStore((state) => state.ensureProjectDetail);
    const duplicateProject = useCanvasStore((state) => state.duplicateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const localProject = useCanvasStore((state) => state.projects.find((item) => item.id === project.id) || null);
    const projectSync = useCanvasStore((state) => state.projectSync[project.id]);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const [shareOpen, setShareOpen] = useState(false);
    const [shareRevision, setShareRevision] = useState<number | null>(null);
    const [action, setAction] = useState<CanvasProjectCardAction | null>(null);
    const actionGate = useMemo(() => createCanvasProjectCardActionGate(), []);
    const actionGeneration = useRef(0);
    const renameStartTitle = useRef<string | null>(null);
    useEffect(
        () => () => {
            actionGeneration.current += 1;
        },
        [project.id],
    );
    const editing = editingId === project.id;
    const shareStatus = shareCanvasProjectStatus(localProject, projectSync);
    const open = () => router.push(appPath(`/canvas/${project.id}`));
    const runDetailAction = async (kind: CanvasProjectCardAction, callback: (context: Awaited<ReturnType<typeof loadCanvasProjectForCardAction>>) => void, revalidate = false) => {
        let succeeded = false;
        const generation = actionGeneration.current;
        await actionGate.run(async () => {
            setAction(kind);
            try {
                const context = await loadCanvasProjectForCardAction({ id: project.id, revalidate, ensureProjectDetail, readState: useCanvasStore.getState });
                if (actionGeneration.current !== generation) return;
                callback(context);
                succeeded = true;
            } catch (error) {
                if (actionGeneration.current === generation) message.error(error instanceof Error ? error.message : "画布加载失败，请重试");
            } finally {
                if (actionGeneration.current === generation) setAction(null);
            }
        });
        return succeeded && actionGeneration.current === generation;
    };
    const saveTitle = async () => {
        const initialTitle = renameStartTitle.current ?? project.title;
        const saved = await runDetailAction("rename", ({ project: loadedProject }) => renameProject(project.id, editingTitle === initialTitle ? loadedProject.title : editingTitle));
        if (saved) stopEditing();
    };
    const duplicate = () => {
        void runDetailAction("copy", () => {
            if (!duplicateProject(project.id)) throw new Error("画布复制失败，请重试");
            message.success("已复制画布");
        });
    };
    const share = () => {
        void runDetailAction(
            "share",
            ({ project: loadedProject, sync }) => {
                const current = shareCanvasProjectStatus(loadedProject, sync);
                if (!current.allowed) throw new Error(current.reason);
                setShareRevision(current.revision);
                setShareOpen(true);
            },
            true,
        );
    };

    return (
        <article className="group flex min-h-44 cursor-pointer flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => !editing && open()}>
            <div className="flex items-start gap-3">
                {editing ? (
                    <Input
                        className="min-w-0"
                        value={editingTitle}
                        disabled={action !== null}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && void saveTitle()}
                        autoFocus
                    />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="truncate text-xl font-semibold">{project.title}</h2>
                        <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-400">{describeCanvasSummaryCounts(project)}</p>
                    </button>
                )}
            </div>
            <div className="mt-8 flex items-end justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-xs text-stone-500">更新于 {new Date(project.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
                    <CanvasSyncFeedback projectId={project.id} />
                </div>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" loading={action === "rename"} disabled={action !== null && action !== "rename"} icon={<Check className="size-4" />} onClick={() => void saveTitle()} aria-label="保存名称" />
                            <Button type="text" size="small" shape="circle" disabled={action !== null} icon={<X className="size-4" />} onClick={stopEditing} aria-label="取消重命名" />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" loading={action === "copy"} disabled={action !== null && action !== "copy"} icon={<Copy className="size-4" />} onClick={duplicate} aria-label="复制画布" />
                            <Button
                                type="text"
                                size="small"
                                shape="circle"
                                loading={action === "share"}
                                disabled={!shareStatus.allowed || action !== null}
                                title={shareStatus.allowed ? "分享画布" : shareStatus.reason}
                                icon={<Share2 className="size-4" />}
                                onClick={share}
                                aria-label="分享画布"
                            />
                            <Button
                                type="text"
                                size="small"
                                shape="circle"
                                disabled={action !== null}
                                icon={<Pencil className="size-4" />}
                                onClick={() => {
                                    renameStartTitle.current = project.title;
                                    startEditing(project.id, project.title);
                                }}
                                aria-label="重命名"
                            />
                            <Button type="text" size="small" shape="circle" disabled={action !== null} icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label="删除" />
                        </>
                    )}
                </div>
            </div>
            {shareRevision !== null && shareStatus.allowed && shareStatus.revision === shareRevision ? <CanvasShareDialog projectId={project.id} revision={shareRevision} open={shareOpen} onClose={() => setShareOpen(false)} /> : null}
        </article>
    );
}
