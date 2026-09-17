"use client";

import { useEffect, useRef, useState, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { createCanvasLocalImageUploadController } from "@/app/(user)/canvas/media/canvas-local-image-upload-controller";
import { collectDroppedImageFiles } from "@/app/(user)/canvas/utils/canvas-file-drop";
import { uploadUserImage } from "@/services/api/image";
import { getImageBlob, imageStorageKeyForMedia, promoteImageStorageKey, releaseImageObjectURL, resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { retainImageCache } from "@/services/image-cache-retention";
import { portalStorageScope } from "@/lib/portal-storage-scope";
import { workflowVisualNodeId } from "./workflow-canvas-adapter";
import { appendWorkflowDroppedImages, prepareWorkflowDroppedImages, type WorkflowDropProgress } from "./workflow-image-drop";
import { currentImageBindings, localImageHistory, localImageRecoveryKey, materializeLocalImages, originalImageNode, pendingRunImages, readLocalImageRecovery, replaceLocalImageSize, type LocalImageBindings, type LocalImageHistory, type LocalImageOperation, type LocalImageOperations, type LocalImageRecovery } from "./workflow-local-images";
import type { WorkflowEditorDocument } from "./workflow-editor-state";
import type { WorkflowGraph, WorkflowPosition, WorkflowRunScope } from "./types";

type Options = {
    uid?: string; workflowId?: string; revision: number; savedSnapshot?: string; readOnly: boolean; ready: boolean;
    document: WorkflowEditorDocument;
    setGraph: (update: SetStateAction<WorkflowGraph>) => void;
    onSelected: (ids: Set<string>) => void;
    notify: (text: string, warning: boolean) => void;
    onUploaded: () => void;
    beforeEdit: () => void;
    retainedHistory: () => readonly string[];
};

export function useWorkflowLocalImages(options: Options) {
    const latest = useRef(options); latest.current = options;
    const operations = useRef<LocalImageOperations>({});
    const bindings = useRef<LocalImageBindings>({});
    const urls = useRef(new Map<string, string>());
    const preparing = useRef(new Map<string, object>());
    const uploadBindings = useRef(new Map<string, string>());
    const session = useRef(0);
    const mounted = useRef(true);
    const localRead = useRef<AbortController | null>(null);
    const storageWarning = useRef(false);
    const historyImports = useRef(new Map<string, { operations: string[]; mediaKeys: string[] }>());
    const [version, render] = useState(0);
    const [progress, setProgress] = useState<WorkflowDropProgress | null>(null);
    const changed = () => { if (mounted.current) render(value => value + 1); };
    const activeBindings = () => currentImageBindings(latest.current.document.graph, bindings.current, operations.current);
    const isCurrent = (op: LocalImageOperation, generation: number) => mounted.current && generation === session.current && !latest.current.readOnly && activeBindings()[op.nodeId] === op.id;
    const persist = (document = latest.current.document, revision = latest.current.revision) => {
        const { uid, workflowId } = latest.current;
        if (!uid || !workflowId || typeof window === "undefined") return;
        try {
            const active = currentImageBindings(document.graph, bindings.current, operations.current);
            const history = localImageHistory(document, active, operations.current);
            const keys = new Set<string>();
            // Retain operations referenced by undo/redo too. Completed references in the current
            // document remain cached, but only unfinished work needs a persistent recovery draft.
            const snapshots = new Set(latest.current.retainedHistory());
            for (const snapshot of historyImports.current.keys()) if (!snapshots.has(snapshot)) historyImports.current.delete(snapshot);
            const kept: LocalImageOperations = {};
            const keep = new Set(Object.values(active));
            for (const snapshot of snapshots) {
                let references = historyImports.current.get(snapshot);
                if (!references) {
                    const document = JSON.parse(snapshot) as LocalImageHistory;
                    references = { operations: Object.values(document.imageImports || {}), mediaKeys: document.graph.nodes.flatMap(node => node.type === "image_input" && node.mediaId ? [imageStorageKeyForMedia(node.mediaId)] : []) };
                    historyImports.current.set(snapshot, references);
                }
                for (const id of references.operations) keep.add(id);
                for (const key of references.mediaKeys) keys.add(key);
            }
            for (const id of keep) { const originalId = operations.current[id]?.original?.operationId; if (originalId) keep.add(originalId); }
            for (const op of Object.values(operations.current)) {
                if (keep.has(op.id)) {
                    kept[op.id] = op; keys.add(op.image.storageKey);
                    if (op.remote) keys.add(imageStorageKeyForMedia(op.remote.mediaId));
                    if (op.original?.mediaId) keys.add(imageStorageKeyForMedia(op.original.mediaId));
                }
            }
            for (const node of document.graph.nodes) if (node.type === "image_input" && node.mediaId) keys.add(imageStorageKeyForMedia(node.mediaId));
            retainImageCache(window.localStorage, portalStorageScope(uid), `workflow:${workflowId}`, keys);
            const settled = Object.values(active).every(id => operations.current[id]?.state === "completed");
            if (Object.keys(active).length && (!settled || JSON.stringify(document) !== latest.current.savedSnapshot)) {
                const recovery: LocalImageRecovery = { version: 1, revision, document: history, operations: kept };
                window.localStorage.setItem(localImageRecoveryKey(uid, workflowId), JSON.stringify(recovery));
            } else window.localStorage.removeItem(localImageRecoveryKey(uid, workflowId));
            for (const op of Object.values(operations.current)) if (!kept[op.id]) {
                releaseImageObjectURL(op.image.storageKey);
                urls.current.delete(op.id);
            }
            operations.current = kept;
        } catch (error) {
            if (!storageWarning.current) { storageWarning.current = true; latest.current.notify(`本地恢复记录保存失败，关闭前请完成上传：${error instanceof Error ? error.message : "浏览器存储不可用"}`, true); }
        }
    };
    const controllerRef = useRef<ReturnType<typeof createCanvasLocalImageUploadController> | null>(null);
    if (!controllerRef.current) controllerRef.current = createCanvasLocalImageUploadController({
        upload: uploadUserImage,
        // Retain the acknowledged ID before promotion, so a cache error never triggers another upload.
        onUploaded: (_nodeId, remote, source) => {
            const op = operations.current[source.scope || ""];
            if (op && isCurrent(op, session.current)) { op.remote = { mediaId: remote.mediaId }; persist(); }
        },
        promote: (image, mediaId) => promoteImageStorageKey(image, mediaId, { retainSource: true }),
        onProgress: (_nodeId, value, source) => {
            const op = operations.current[source.scope || ""];
            if (op && isCurrent(op, session.current)) { op.progress = value; changed(); }
        },
        onCompleted: (_nodeId, image, remote, source) => {
            const op = operations.current[source.scope || ""];
            if (!op || !isCurrent(op, session.current)) return;
            complete(op, image, remote.mediaId);
        },
        onFailed: (_nodeId, error, source) => {
            const op = operations.current[source.scope || ""];
            if (op && isCurrent(op, session.current)) { op.state = "failed"; op.error = error; persist(); changed(); }
        },
    });
    const controller = controllerRef.current;
    const complete = (op: LocalImageOperation, image: UploadedImage, mediaId: string) => {
        op.state = "completed"; op.progress = 100; op.error = undefined; op.remote = { mediaId };
        urls.current.set(op.id, image.url);
        latest.current.setGraph(graph => {
            if (latest.current.readOnly || currentImageBindings(graph, bindings.current, operations.current)[op.nodeId] !== op.id) return graph;
            const next = { ...graph, nodes: graph.nodes.map(node => node.id === op.nodeId ? { ...node, mediaId } : node) };
            persist({ ...latest.current.document, graph: next });
            return next;
        });
        changed(); latest.current.onUploaded();
    };
    const start = async (op: LocalImageOperation, retry = false) => {
        const generation = session.current;
        if (!isCurrent(op, generation) || controller.isActive(op.nodeId) || preparing.current.has(op.id)) return;
        const preparation = {};
        preparing.current.set(op.id, preparation);
        try {
            const blob = await getImageBlob(op.image.storageKey);
            if (!isCurrent(op, generation)) return;
            if (!blob && op.state === "completed") { urls.current.set(op.id, ""); return; }
            if (!blob) throw new Error("本地图片缓存已丢失，请重新选择文件");
            const url = await resolveImageUrl(op.image.storageKey);
            if (!isCurrent(op, generation)) return;
            urls.current.set(op.id, url);
            changed();
            if (op.state === "failed" && !retry) return;
            const image = { ...op.image, url };
            if (op.remote) {
                const promoted = await promoteImageStorageKey(image, op.remote.mediaId, { retainSource: true });
                if (isCurrent(op, generation)) complete(op, promoted, op.remote.mediaId);
            } else {
                op.state = "uploading"; op.error = undefined; op.progress = 0; changed();
                uploadBindings.current.set(op.nodeId, op.id);
                await controller.start({ nodeId: op.nodeId, scope: op.id, image, file: new File([blob], op.fileName, { type: op.image.mimeType, lastModified: op.lastModified }), intent: "library" });
            }
        } catch (error) {
            if (isCurrent(op, generation)) { op.state = "failed"; op.error = error instanceof Error ? error.message : "读取本地图片失败"; persist(); changed(); }
        } finally { if (preparing.current.get(op.id) === preparation) preparing.current.delete(op.id); }
    };
    const recover = (recovery?: LocalImageRecovery) => {
        controller.dispose(); session.current++; preparing.current.clear(); uploadBindings.current.clear();
        operations.current = recovery?.operations || {};
        bindings.current = recovery?.document.imageImports || {};
        changed();
    };
    const applyHistory = (snapshot: string) => {
        const document = JSON.parse(snapshot) as LocalImageHistory;
        bindings.current = document.imageImports || {};
        for (const [nodeId, operationId] of uploadBindings.current) if (bindings.current[nodeId] !== operationId) controller.cancel(nodeId);
        changed();
        return materializeLocalImages(document, operations.current);
    };
    useEffect(() => {
        mounted.current = true;
        const stop = () => { session.current++; localRead.current?.abort(); controller.dispose(); preparing.current.clear(); };
        window.addEventListener("pagehide", stop);
        return () => { mounted.current = false; stop(); for (const op of Object.values(operations.current)) releaseImageObjectURL(op.image.storageKey); urls.current.clear(); window.removeEventListener("pagehide", stop); };
    }, [controller]);
    useEffect(() => {
        if (options.readOnly) { session.current++; localRead.current?.abort(); controller.dispose(); preparing.current.clear(); return; }
        if (!options.ready) return;
        const active = activeBindings();
        for (const [nodeId, operationId] of uploadBindings.current) if (active[nodeId] !== operationId) controller.cancel(nodeId);
        for (const id of Object.values(active)) {
            const op = operations.current[id];
            if (op.state !== "completed" || !urls.current.has(op.id)) void start(op);
        }
        persist();
    }, [options.readOnly, options.ready, options.document.graph, options.document.name, options.revision, options.savedSnapshot]);

    const importFiles = async (files: File[], center: WorkflowPosition, replacementId?: string) => {
        if (latest.current.readOnly || !collectDroppedImageFiles(files).files.length) return;
        if (localRead.current) { latest.current.notify("请等待本地图片读取完成", true); return; }
        const abort = new AbortController(); localRead.current = abort;
        const generation = session.current;
        try {
            const prepared = await prepareWorkflowDroppedImages(replacementId ? files.slice(0, 1) : files, center, { signal: abort.signal, readLocal: file => uploadImage(file), onDiscard: image => releaseImageObjectURL(image.storageKey), onProgress: setProgress });
            const discard = () => { for (const { image } of prepared.localImages.values()) releaseImageObjectURL(image.storageKey); };
            if (abort.signal.aborted || latest.current.readOnly || !mounted.current || generation !== session.current) { discard(); return; }
            latest.current.beforeEdit();
            const current = latest.current.document.graph;
            const original = replacementId ? current.nodes.find(node => node.id === replacementId && node.type === "image_input") : undefined;
            if (replacementId && !original) { discard(); return; }
            const newOps = prepared.nodes.map(node => {
                const { image, file } = prepared.localImages.get(node.id)!;
                const { url, ...stored } = image;
                const op: LocalImageOperation = { id: nanoid(), nodeId: replacementId || node.id, image: stored, fileName: file.name, lastModified: file.lastModified, state: "uploading", progress: 0,
                    ...(original ? { original: { mediaId: original.mediaId, width: original.width, height: original.height, operationId: bindings.current[original.id] } } : {}) };
                controller.cancel(op.nodeId); operations.current[op.id] = op; bindings.current[op.nodeId] = op.id; urls.current.set(op.id, url);
                return op;
            });
            latest.current.setGraph(graph => {
                if (abort.signal.aborted || latest.current.readOnly) return graph;
                const next = original && newOps[0] ? replaceLocalImageSize(graph, original.id, newOps[0].image) : appendWorkflowDroppedImages(graph, prepared.nodes);
                persist({ ...latest.current.document, graph: next });
                return next;
            });
            changed();
            if (newOps.length) latest.current.onSelected(new Set(newOps.map(op => workflowVisualNodeId(op.nodeId))));
            const summary = [`已读取 ${newOps.length} 张图片，后台上传到我的素材`];
            if (prepared.failedCount) summary.push(`${prepared.failedCount} 张读取失败`);
            if (prepared.omittedCount) summary.push(`超过上限，已忽略 ${prepared.omittedCount} 张`);
            latest.current.notify(summary.join("；"), Boolean(prepared.failedCount || prepared.omittedCount));
            // React publishes the preview graph first; the effect starts its uploads afterward.
        } catch (error) {
            if (!abort.signal.aborted && mounted.current) latest.current.notify(error instanceof Error ? error.message : "图片导入失败", true);
        } finally {
            if (localRead.current === abort) { localRead.current = null; if (mounted.current) setProgress(null); }
        }
    };
    const cancelReplacement = (nodeId: string) => {
        if (latest.current.readOnly) return;
        const op = operations.current[activeBindings()[nodeId]];
        if (!op?.original) return;
        controller.cancel(nodeId);
        if (op.original.operationId) bindings.current[nodeId] = op.original.operationId;
        else delete bindings.current[nodeId];
        latest.current.beforeEdit();
        latest.current.setGraph(graph => ({ ...graph, nodes: graph.nodes.map(node => node.id === nodeId ? originalImageNode(node, op) : node) }));
        changed();
    };
    const displayedBindings = activeBindings();
    const get = (nodeId: string) => {
        const op = operations.current[displayedBindings[nodeId]];
        return op ? { ...op, url: urls.current.get(op.id) } : undefined;
    };
    return {
        version, progress, importFiles, get, persist, recover, applyHistory,
        acknowledge: (nodeId: string) => { const op = operations.current[activeBindings()[nodeId]]; if (op?.state === "completed" && urls.current.get(op.id)) { urls.current.set(op.id, ""); changed(); } },
        snapshot: (document: WorkflowEditorDocument) => JSON.stringify(localImageHistory(document, bindings.current, operations.current)),
        readRecovery: () => { try { return options.uid && options.workflowId ? readLocalImageRecovery(window.localStorage, options.uid, options.workflowId) : undefined; } catch (error) { latest.current.notify(error instanceof Error ? error.message : "读取本地恢复记录失败", true); } },
        restoreDocument: (recovery: LocalImageRecovery) => materializeLocalImages(recovery.document, recovery.operations),
        retry: (nodeId: string) => { const op = operations.current[activeBindings()[nodeId]]; if (op) void start(op, true); },
        cancelReplacement,
        forget: (nodeId: string) => { controller.cancel(nodeId); delete bindings.current[nodeId]; changed(); },
        pending: (scope: WorkflowRunScope) => pendingRunImages(latest.current.document.graph, scope, bindings.current, operations.current),
    };
}
