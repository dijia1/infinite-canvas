"use client";

import { useEffect, useRef, useState, type SetStateAction } from "react";
import { collectDroppedImageFiles } from "@/app/(user)/canvas/utils/canvas-file-drop";
import { readImageMeta } from "@/lib/image-utils";
import { uploadUserImage } from "@/services/api/image";
import { workflowVisualNodeId } from "./workflow-canvas-adapter";
import { appendWorkflowDroppedImages, prepareWorkflowDroppedImages, type WorkflowDropProgress } from "./workflow-image-drop";
import type { WorkflowGraph, WorkflowPosition } from "./types";

type Options = {
    readOnly: boolean;
    setGraph: (update: SetStateAction<WorkflowGraph>) => void;
    onSelected: (ids: Set<string>) => void;
    notify: (text: string, warning: boolean) => void;
};

export function useWorkflowImageDrop(options: Options) {
    const latest = useRef(options);
    latest.current = options;
    const active = useRef<AbortController | null>(null);
    const [progress, setProgress] = useState<WorkflowDropProgress | null>(null);
    useEffect(() => {
        if (options.readOnly) {
            active.current?.abort();
            active.current = null;
            setProgress(null);
        }
        return () => { active.current?.abort(); active.current = null; };
    }, [options.readOnly]);

    const importFiles = async (files: File[], center: WorkflowPosition) => {
        if (latest.current.readOnly || !collectDroppedImageFiles(files).files.length) return;
        if (active.current) { latest.current.notify("请等待当前图片导入完成", true); return; }
        const controller = new AbortController();
        active.current = controller;
        try {
            const result = await prepareWorkflowDroppedImages(files, center, {
                signal: controller.signal,
                readDimensions: async (file) => {
                    const url = URL.createObjectURL(file);
                    try { return await readImageMeta(url); }
                    finally { URL.revokeObjectURL(url); }
                },
                upload: (file, signal) => uploadUserImage(file, "canvas", { signal }),
                onProgress: setProgress,
            });
            if (controller.signal.aborted || latest.current.readOnly) return;
            latest.current.setGraph(current => controller.signal.aborted || latest.current.readOnly ? current : appendWorkflowDroppedImages(current, result.nodes));
            if (result.nodes.length) latest.current.onSelected(new Set(result.nodes.map(node => workflowVisualNodeId(node.id))));
            const summary = [`已添加 ${result.nodes.length} 张图片`];
            if (result.failedCount) summary.push(`${result.failedCount} 张上传失败`);
            if (result.omittedCount) summary.push(`超过上限，已忽略 ${result.omittedCount} 张`);
            latest.current.notify(summary.join("；"), Boolean(result.failedCount || result.omittedCount));
        } catch (error) {
            if (!controller.signal.aborted) latest.current.notify(error instanceof Error ? error.message : "图片导入失败", true);
        } finally {
            if (active.current === controller) { active.current = null; setProgress(null); }
        }
    };
    return { progress, importFiles };
}
