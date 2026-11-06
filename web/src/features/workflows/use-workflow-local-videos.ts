"use client";

import { useEffect, useRef, useState, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { prepareVideoUpload } from "@/services/api/video-media";
import { createCanvasLocalVideoUploadController } from "@/features/canvas/media/canvas-local-video-upload-controller";
import { CanvasNodeType, type CanvasNodeData } from "@/features/canvas/types";
import { layoutDroppedImageGrid } from "@/features/canvas/utils/canvas-file-drop";
import { autoAssignWorkflowFrameMembers } from "./workflow-frames";
import { createWorkflowNode, removeWorkflowNode, workflowInputNodeIdsForScope } from "./workflow-graph";
import { workflowVisualNodeId } from "./workflow-canvas-adapter";
import { currentVideoBindings, fitWorkflowVideo, localVideoHistory, materializeLocalVideos, pendingRunVideos, replaceWorkflowVideoSize, type LocalVideoBindings, type LocalVideoHistory, type LocalVideoOperations } from "./workflow-local-videos";
import type { WorkflowEditorDocument } from "./workflow-editor-state";
import type { WorkflowGraph, WorkflowPosition, WorkflowRunScope } from "./types";

type Options = {
    document: WorkflowEditorDocument;
    readOnly: boolean;
    ready: boolean;
    setGraph: (update: SetStateAction<WorkflowGraph>) => void;
    onSelected: (ids: Set<string>) => void;
    notify: (message: string) => void;
    onUploaded: () => void;
    beforeEdit: () => void;
    retainedHistory: () => readonly string[];
};
export function useWorkflowLocalVideos(options: Options) {
    const latest = useRef(options);
    latest.current = options;
    const operations = useRef<LocalVideoOperations>({});
    const bindings = useRef<LocalVideoBindings>({});
    const uploads = useRef(new Map<string, string>());
    const preparing = useRef(new Map<string, { abort: AbortController; file: File }>());
    const mounted = useRef(true);
    const [version, render] = useState(0);
    const changed = () => {
        if (mounted.current) render((value) => value + 1);
    };
    const active = () => currentVideoBindings(latest.current.document.graph, bindings.current, operations.current);
    const nodeSource = (id: string): CanvasNodeData | undefined => {
        const node = latest.current.document.graph.nodes.find((node) => node.id === id && node.type === "video_input");
        return node ? { ...node, type: CanvasNodeType.Video, title: "", width: node.width || 420, height: node.height || 236, metadata: { mediaId: node.mediaId } } : undefined;
    };
    const controllerRef = useRef<ReturnType<typeof createCanvasLocalVideoUploadController> | null>(null);
    if (!controllerRef.current)
        controllerRef.current = createCanvasLocalVideoUploadController({
            getNode: nodeSource,
            canEdit: () => mounted.current && !latest.current.readOnly,
            createURL: (file) => {
                const op = Object.values(operations.current).find((op) => op.file === file && bindings.current[op.nodeId] === op.id)!;
                if (!op.view.url) op.view.url = URL.createObjectURL(file);
                return op.view.url;
            },
            revokeURL: (url) => {
                URL.revokeObjectURL(url);
                for (const op of Object.values(operations.current)) if (op.view.url === url) op.view = { ...op.view, url: "" };
            },
            onChange: (views) => {
                for (const [id, view] of views) {
                    const op = operations.current[uploads.current.get(id) || ""];
                    if (op) op.view = view;
                }
                changed();
            },
            onCompleted: (id, _file, remote) => {
                const op = operations.current[uploads.current.get(id) || ""];
                if (!op || active()[id] !== op.id) return;
                op.remote = remote;
                op.file = undefined;
                latest.current.setGraph((graph) => (currentVideoBindings(graph, bindings.current, operations.current)[id] === op.id ? { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? { ...node, mediaId: remote.mediaId } : node)) } : graph));
                latest.current.onUploaded();
            },
        });
    const controller = controllerRef.current;
    const start = (id: string) => {
        const op = operations.current[active()[id]];
        const source = nodeSource(id);
        if (!op?.file || !source || latest.current.readOnly) return;
        uploads.current.set(id, op.id);
        void controller.start(source, op.file, op.metadata);
    };
    useEffect(() => {
        mounted.current = true;
        const stop = () => {
            for (const entry of preparing.current.values()) entry.abort.abort();
            preparing.current.clear();
            controller.dispose();
        };
        window.addEventListener("pagehide", stop);
        return () => {
            mounted.current = false;
            stop();
            for (const op of Object.values(operations.current)) if (op.view.url) URL.revokeObjectURL(op.view.url);
            window.removeEventListener("pagehide", stop);
        };
    }, [controller]);
    const bindingSnapshot = JSON.stringify(bindings.current);
    useEffect(() => {
        const current = active();
        for (const [id, operationId] of uploads.current) {
            if (options.readOnly || current[id] !== operationId || operations.current[operationId]?.remote) {
                controller.cancel(id);
                uploads.current.delete(id);
            }
        }
        if (options.readOnly) {
            for (const entry of preparing.current.values()) entry.abort.abort();
            return;
        }
        if (!options.ready) return;
        for (const [id, operationId] of Object.entries(current)) {
            const op = operations.current[operationId];
            if (!op.remote && op.view.stage !== "failed" && !controller.views().has(id)) start(id);
        }
        const keep = new Set(Object.values(current));
        for (const snapshot of latest.current.retainedHistory()) {
            const history = JSON.parse(snapshot) as LocalVideoHistory;
            for (const id of Object.values(history.videoImports || {})) keep.add(id);
        }
        for (const id of keep) {
            const original = operations.current[id]?.original?.operationId;
            if (original) keep.add(original);
        }
        for (const [id, op] of Object.entries(operations.current))
            if (!keep.has(id)) {
                if (op.view.url) URL.revokeObjectURL(op.view.url);
                delete operations.current[id];
            }
    }, [options.document.graph, options.readOnly, options.ready, bindingSnapshot]);

    const importFiles = async (files: File[], center: WorkflowPosition, replacementId?: string) => {
        if (latest.current.readOnly) return;
        const videos = files.filter((file) => file.type.startsWith("video/"));
        const positions = layoutDroppedImageGrid(replacementId ? 1 : videos.length, center);
        for (const [index, file] of (replacementId ? videos.slice(0, 1) : videos).entries()) {
            const id = replacementId || nanoid();
            preparing.current.get(id)?.abort.abort();
            const abort = new AbortController();
            preparing.current.set(id, { abort, file });
            try {
                const metadata = await prepareVideoUpload(file, abort.signal);
                if (abort.signal.aborted || latest.current.readOnly || !mounted.current) return;
                const original = replacementId ? latest.current.document.graph.nodes.find((node) => node.id === id && node.type === "video_input") : undefined;
                if (replacementId && !original) return;
                latest.current.beforeEdit();
                const operationId = nanoid();
                const previousId = bindings.current[id];
                controller.cancel(id);
                uploads.current.delete(id);
                const op = {
                    id: operationId,
                    nodeId: id,
                    fileName: file.name,
                    file,
                    metadata,
                    view: { url: URL.createObjectURL(file), stage: "uploading" as const, progress: 0 },
                    ...(original ? { original: { mediaId: original.mediaId, width: original.width, height: original.height, operationId: previousId } } : {}),
                };
                operations.current[operationId] = op;
                bindings.current[id] = operationId;
                latest.current.setGraph((graph) => {
                    if (original) return replaceWorkflowVideoSize(graph, id, metadata);
                    const node = fitWorkflowVideo(createWorkflowNode("video_input", positions[index]!, id), metadata, true);
                    node.position = { x: positions[index]!.x - node.width! / 2, y: positions[index]!.y - node.height! / 2 };
                    return autoAssignWorkflowFrameMembers({ ...graph, nodes: [...graph.nodes, node] }, new Set([workflowVisualNodeId(id)]));
                });
                latest.current.onSelected(new Set([workflowVisualNodeId(id)]));
                changed();
            } catch (error) {
                if (!abort.signal.aborted && mounted.current) latest.current.notify(error instanceof Error ? error.message : "视频读取失败");
            } finally {
                if (preparing.current.get(id)?.abort === abort) preparing.current.delete(id);
            }
        }
    };
    return {
        version,
        importFiles,
        get: (id: string) => {
            const op = operations.current[active()[id]];
            return op && !op.remote ? op.view : undefined;
        },
        snapshot: (document: WorkflowEditorDocument) => JSON.stringify(localVideoHistory(document, bindings.current, operations.current)),
        applyHistory: (snapshot: string) => {
            const document = JSON.parse(snapshot) as LocalVideoHistory;
            bindings.current = document.videoImports || {};
            return materializeLocalVideos(document, operations.current);
        },
        pending: (scope: WorkflowRunScope) => {
            const inputs = workflowInputNodeIdsForScope(latest.current.document.graph, scope);
            return [...pendingRunVideos(latest.current.document.graph, scope, bindings.current, operations.current), ...[...preparing.current].filter(([id]) => inputs.has(id)).map(([, entry]) => ({ fileName: entry.file.name }))];
        },
        retry: (id: string) => {
            const op = operations.current[active()[id]];
            if (!op || latest.current.readOnly) return;
            if (controller.views().has(id)) void controller.retry(id);
            else {
                op.view = { ...op.view, stage: "uploading", error: undefined };
                start(id);
            }
        },
        cancel: (id: string) => {
            if (latest.current.readOnly) return;
            const op = operations.current[active()[id]];
            if (!op) return;
            latest.current.beforeEdit();
            controller.cancel(id);
            uploads.current.delete(id);
            if (op.original?.operationId) bindings.current[id] = op.original.operationId;
            else delete bindings.current[id];
            latest.current.setGraph((graph) =>
                op.original ? { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? { ...node, mediaId: op.original!.mediaId, width: op.original!.width, height: op.original!.height } : node)) } : removeWorkflowNode(graph, id),
            );
            changed();
        },
        forget: (id: string) => {
            preparing.current.get(id)?.abort.abort();
            controller.cancel(id);
            uploads.current.delete(id);
            delete bindings.current[id];
            changed();
        },
    };
}
