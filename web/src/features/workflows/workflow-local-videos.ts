import type { VideoMediaAccess, VideoUploadMetadata } from "@/services/api/video-media";
import type { LocalVideoUploadView } from "@/features/canvas/media/canvas-local-video-upload-controller";
import { fitNodeSize } from "@/features/canvas/utils/canvas-node-size";
import { canvasFrameContainsRect, canvasFrameRectsOverlap } from "@/lib/canvas-frame";
import { expandWorkflowFrames } from "./workflow-frames";
import { workflowInputNodeIdsForScope } from "./workflow-graph";
import type { WorkflowEditorDocument } from "./workflow-editor-state";
import type { WorkflowGraph, WorkflowNode, WorkflowRunScope } from "./types";

export type LocalVideoOperation = {
    id: string;
    nodeId: string;
    fileName: string;
    file?: File;
    metadata: VideoUploadMetadata;
    original?: Pick<WorkflowNode, "mediaId" | "width" | "height"> & { operationId?: string };
    remote?: VideoMediaAccess;
    view: LocalVideoUploadView;
};
export type LocalVideoBindings = Record<string, string>;
export type LocalVideoOperations = Record<string, LocalVideoOperation>;
export type LocalVideoHistory = WorkflowEditorDocument & { videoImports?: LocalVideoBindings };

export function currentVideoBindings(graph: WorkflowGraph, bindings: LocalVideoBindings, operations: LocalVideoOperations) {
    return Object.fromEntries(
        graph.nodes.flatMap((node) => {
            const id = bindings[node.id],
                op = operations[id];
            return node.type === "video_input" && op && (node.mediaId === op.original?.mediaId || (op.remote && node.mediaId === op.remote.mediaId)) ? [[node.id, id]] : [];
        }),
    );
}
export function localVideoHistory(document: WorkflowEditorDocument, bindings: LocalVideoBindings, operations: LocalVideoOperations): LocalVideoHistory {
    const active = currentVideoBindings(document.graph, bindings, operations);
    return {
        ...document,
        graph: {
            ...document.graph,
            nodes: document.graph.nodes.map((node) => {
                const op = operations[active[node.id]];
                return op ? { ...node, mediaId: op.original?.mediaId } : node;
            }),
        },
        ...(Object.keys(active).length ? { videoImports: active } : {}),
    };
}
export function materializeLocalVideos(document: LocalVideoHistory, operations: LocalVideoOperations): LocalVideoHistory {
    return {
        ...document,
        graph: {
            ...document.graph,
            nodes: document.graph.nodes.map((node) => {
                const remote = operations[document.videoImports?.[node.id] || ""]?.remote;
                return remote ? { ...node, mediaId: remote.mediaId } : node;
            }),
        },
    };
}
export function pendingRunVideos(graph: WorkflowGraph, scope: WorkflowRunScope, bindings: LocalVideoBindings, operations: LocalVideoOperations) {
    const active = currentVideoBindings(graph, bindings, operations);
    return [...workflowInputNodeIdsForScope(graph, scope)].flatMap((id) => {
        const op = operations[active[id]];
        return op && !op.remote ? [op] : [];
    });
}
export function fitWorkflowVideo<T extends { width?: number; height?: number; position?: { x: number; y: number } }>(node: T, dimensions: { width: number; height: number }, force = false): T {
    if (!force && ((node.width || 420) !== 420 || (node.height || 236) !== 236)) return node;
    const size = fitNodeSize(dimensions.width, dimensions.height, 420, 420);
    if (size.width === node.width && size.height === node.height) return node;
    return { ...node, ...size, ...(node.position ? { position: { x: node.position.x + ((node.width || 420) - size.width) / 2, y: node.position.y + ((node.height || 236) - size.height) / 2 } } : {}) };
}
export function replaceWorkflowVideoSize(graph: WorkflowGraph, id: string, dimensions: VideoUploadMetadata) {
    const nodes = graph.nodes.map((node) => (node.id === id ? { ...fitWorkflowVideo(node, dimensions, true), position: node.position } : node));
    const next = expandWorkflowFrames({ ...graph, nodes });
    const frames = next.frames || [];
    if (frames.some((frame, index) => frames.slice(index + 1).some((other) => canvasFrameRectsOverlap(frame, other)))) return graph;
    const frame = frames.find((frame) => frame.nodeIds.includes(id));
    const node = next.nodes.find((node) => node.id === id)!;
    return frame && !canvasFrameContainsRect(frame, { position: node.position, width: node.width || 420, height: node.height || 236 }) ? graph : next;
}
