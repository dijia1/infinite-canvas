import type { UploadedImage } from "@/services/image-storage";
import type { WorkflowEditorDocument } from "./workflow-editor-state";
import type { WorkflowGraph, WorkflowNode, WorkflowRunScope } from "./types";
import { expandWorkflowFrames } from "./workflow-frames";
import { fitWorkflowImage } from "./workflow-graph";
import { canvasFrameRectsOverlap } from "@/lib/canvas-frame";

export type LocalImageOperation = {
    id: string; nodeId: string; fileName: string; lastModified: number;
    image: Omit<UploadedImage, "url">;
    state: "uploading" | "failed" | "completed";
    progress: number; error?: string;
    original?: { mediaId?: string; width?: number; height?: number; operationId?: string };
    remote?: { mediaId: string };
};
export type LocalImageBindings = Record<string, string>;
export type LocalImageOperations = Record<string, LocalImageOperation>;
export type LocalImageHistory = WorkflowEditorDocument & { imageImports?: LocalImageBindings };
export type LocalImageRecovery = { version: 1; revision: number; document: LocalImageHistory; operations: LocalImageOperations };

export function currentImageBindings(graph: WorkflowGraph, bindings: LocalImageBindings, operations: LocalImageOperations): LocalImageBindings {
    const result: LocalImageBindings = {};
    for (const node of graph.nodes) {
        const id = bindings[node.id], op = operations[id];
        if (op && node.type === "image_input" && (node.mediaId === op.original?.mediaId || node.mediaId === op.remote?.mediaId)) result[node.id] = id;
    }
    return result;
}

// Normalize only upload backfills. Positions, connections and other edits remain undoable.
export function localImageHistory(document: WorkflowEditorDocument, bindings: LocalImageBindings, operations: LocalImageOperations): LocalImageHistory {
    const active = currentImageBindings(document.graph, bindings, operations);
    return { ...document, graph: { ...document.graph, nodes: document.graph.nodes.map(node => {
        const op = operations[active[node.id]];
        if (!op) return node;
        return { ...node, mediaId: op.original?.mediaId };
    }) }, ...(Object.keys(active).length ? { imageImports: active } : {}) };
}
export function materializeLocalImages(document: LocalImageHistory, operations: LocalImageOperations): WorkflowEditorDocument {
    return { name: document.name, graph: { ...document.graph, nodes: document.graph.nodes.map(node => {
        const op = operations[document.imageImports?.[node.id] || ""];
        return op?.state === "completed" && op.remote ? { ...node, mediaId: op.remote.mediaId } : node;
    }) } };
}
export function replaceLocalImageSize(graph: WorkflowGraph, nodeId: string, image: { width: number; height: number }): WorkflowGraph {
    const nodes = graph.nodes.map(node => node.id === nodeId ? { ...fitWorkflowImage(node, image, true), position: node.position } : node);
    const expanded = expandWorkflowFrames({ ...graph, nodes });
    const frames = expanded.frames || [];
    if (frames.some((frame, i) => frames.slice(i + 1).some(other => canvasFrameRectsOverlap(frame, other)))) return graph;
    // expandWorkflowFrames can reject an expansion. Verify the resized member is still contained.
    const node = nodes.find(node => node.id === nodeId)!;
    const frame = frames.find(frame => frame.nodeIds.includes(nodeId));
    if (frame && (node.position.x < frame.position.x || node.position.y < frame.position.y || node.position.x + (node.width || 340) > frame.position.x + frame.width || node.position.y + (node.height || 240) > frame.position.y + frame.height)) return graph;
    return expanded;
}
export function pendingRunImages(graph: WorkflowGraph, scope: WorkflowRunScope, bindings: LocalImageBindings, operations: LocalImageOperations): LocalImageOperation[] {
    const active = currentImageBindings(graph, bindings, operations);
    const members = scope.type === "frame" ? new Set(graph.frames?.find(frame => frame.id === scope.frameId)?.nodeIds || []) : new Set(graph.nodes.map(node => node.id));
    const inputs = new Set(members);
    for (const connection of graph.connections) if (members.has(connection.targetNodeId)) inputs.add(connection.sourceNodeId);
    return [...inputs].flatMap(id => { const op = operations[active[id]]; return op && op.state !== "completed" ? [op] : []; });
}
export function localImageRecoveryKey(uid: string, workflowId: string) { return `infinite-canvas:workflow-images:${encodeURIComponent(uid)}:${encodeURIComponent(workflowId)}`; }
export function readLocalImageRecovery(storage: Pick<Storage, "getItem">, uid: string, workflowId: string): LocalImageRecovery | undefined {
    const raw = storage.getItem(localImageRecoveryKey(uid, workflowId));
    if (!raw) return;
    const value = JSON.parse(raw) as LocalImageRecovery;
    if (value.version !== 1 || !Number.isInteger(value.revision) || !value.document?.graph?.nodes || !value.operations) throw new Error("本地图片恢复记录无效，请重新选择图片");
    for (const [id, op] of Object.entries(value.operations)) if (op.id !== id || typeof op.image?.storageKey !== "string" || !op.nodeId || !op.fileName) throw new Error("本地图片恢复记录无效，请重新选择图片");
    return value;
}
export function originalImageNode(node: WorkflowNode, op: LocalImageOperation): WorkflowNode {
    return { ...node, mediaId: op.original?.mediaId, width: op.original?.width, height: op.original?.height };
}
