"use client";

import { Check, Copy, Pencil, Share2, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { App, Button, Input } from "antd";
import { useState } from "react";

import { appPath } from "@/lib/app-path";
import { useCanvasStore, type CanvasProject } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import { CanvasShareDialog } from "./canvas-share-dialog";
import { CanvasSyncFeedback } from "./canvas-sync-feedback";

export function CanvasProjectCard({ project }: { project: CanvasProject }) {
    const { message } = App.useApp();
    const router = useRouter();
    const duplicateProject = useCanvasStore((state) => state.duplicateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const projectSync = useCanvasStore((state) => state.projectSync[project.id]);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const [shareOpen, setShareOpen] = useState(false);
    const editing = editingId === project.id;
    const shareRevision = typeof projectSync?.serverRevision === "number" ? projectSync.serverRevision : null;
    const shareable = shareRevision !== null && !projectSync?.dirty && !projectSync?.pending && !projectSync?.saving && !projectSync?.conflict;
    const open = () => router.push(appPath(`/canvas/${project.id}`));
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        stopEditing();
    };
    const duplicate = () => {
        if (duplicateProject(project.id)) message.success("已复制画布");
    };

    return (
        <article className="group flex min-h-44 cursor-pointer flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => !editing && open()}>
            <div className="flex items-start gap-3">
                {editing ? (
                    <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus />
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
                        <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-400">
                            {project.nodes.length} 个节点 · {project.connections.length} 条连线
                        </p>
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
                            <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={saveTitle} aria-label="保存名称" />
                            <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label="取消重命名" />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Copy className="size-4" />} onClick={duplicate} aria-label="复制画布" />
                            <Button type="text" size="small" shape="circle" icon={<Share2 className="size-4" />} disabled={!shareable} title={shareable ? "分享画布" : "等待画布保存后再分享"} onClick={() => setShareOpen(true)} aria-label="分享画布" />
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label="重命名" />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label="删除" />
                        </>
                    )}
                </div>
            </div>
            {shareable && shareRevision !== null ? <CanvasShareDialog projectId={project.id} revision={shareRevision} open={shareOpen} onClose={() => setShareOpen(false)} /> : null}
        </article>
    );
}
