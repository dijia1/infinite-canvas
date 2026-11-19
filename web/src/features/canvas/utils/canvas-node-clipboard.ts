import { nanoid } from "nanoid";

import { normalizeImageMask } from "@/lib/image-mask/mask-utils";
import { resolveCanvasNodeMask, type CanvasMaskResources } from "../image-mask/mask-resources";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "../types";
import { isLocalImageUploadNode } from "./canvas-local-image-upload";

export const CANVAS_NODE_CLIPBOARD_TYPE = "application/x-infinite-canvas";
const maxClipboardBytes = 4 << 20; // Same limit as a saved canvas document.

export type CanvasClipboardGraph = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    maskResources: CanvasMaskResources;
};

const nodeTypes = new Set<string>(Object.values(CanvasNodeType));
const stringFields = [
    "prompt", "size", "resolution", "outputFormat", "background", "imageProviderId", "imageProviderName",
    "videoProviderId", "videoProviderName", "imageProviderType", "imageRequestSchemaVersion", "quality",
    "seconds", "videoSize", "generateAudio", "maskId", "sourceNodeId", "batchRootId", "primaryImageId",
    "storageKey", "mediaId", "publicImageId", "assetId", "mimeType",
] as const satisfies readonly (keyof CanvasNodeMetadata)[];
const numberFields = ["fontSize", "count", "duration", "naturalWidth", "naturalHeight", "bytes"] as const satisfies readonly (keyof CanvasNodeMetadata)[];
const booleanFields = ["freeResize", "isBatchRoot", "batchUsesReferenceImages", "imageBatchExpanded"] as const satisfies readonly (keyof CanvasNodeMetadata)[];

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isId(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim());
}

// A clipboard snapshot carries editable settings and completed results, without
// original task handles, temporary URLs or upload state.
function copyMetadata(type: CanvasNodeType, source: Record<string, unknown>): CanvasNodeMetadata {
    const metadata: CanvasNodeMetadata = {};
    for (const key of stringFields) if (typeof source[key] === "string") metadata[key] = source[key];
    for (const key of numberFields) if (isFiniteNumber(source[key])) metadata[key] = source[key];
    for (const key of booleanFields) if (typeof source[key] === "boolean") metadata[key] = source[key];
    if (type === CanvasNodeType.Text && typeof source.content === "string") metadata.content = source.content;
    if (source.status === "success" || source.status === "idle") metadata.status = source.status;
    if (source.generationMode === "image" || source.generationMode === "video") metadata.generationMode = source.generationMode;
    if (source.generationType === "generation" || source.generationType === "edit") metadata.generationType = source.generationType;
    if (source.videoMode === "draft" || (source.videoMode === "final" && type === CanvasNodeType.Video)) metadata.videoMode = source.videoMode;
    if (metadata.videoMode === "final" && metadata.mediaId && isId(source.sourceDraftTaskId)) metadata.sourceDraftTaskId = source.sourceDraftTaskId;
    if (typeof source.vquality === "string" || source.vquality === null) metadata.vquality = source.vquality;
    for (const key of ["inputOrder", "batchChildIds"] as const) {
        if (Array.isArray(source[key])) metadata[key] = source[key].filter(isId);
    }
    if (isRecord(source.providerOptions)) {
        metadata.providerOptions = Object.fromEntries(Object.entries(source.providerOptions).filter(([, value]) =>
            typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value),
        ));
    }
    return metadata;
}

export function captureCanvasClipboard(
    graph: CanvasClipboardGraph, selectedIds: ReadonlySet<string>, isVideoUploadPending: (nodeId: string) => boolean,
): { graph: CanvasClipboardGraph; skipped: number } {
    const nodes: CanvasNodeData[] = [];
    const masks = new Map<string, NonNullable<ReturnType<typeof resolveCanvasNodeMask>>>();
    let skipped = 0;
    for (const node of graph.nodes) {
        if (!selectedIds.has(node.id)) continue;
        const meta = node.metadata;
        const media = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video;
        const noSavedReference = !meta?.mediaId && !meta?.publicImageId && !meta?.storageKey;
        if (media && (meta?.status === "loading" || isLocalImageUploadNode(node) ||
            (node.type === CanvasNodeType.Video && isVideoUploadPending(node.id)) ||
            (noSavedReference && (meta?.content || meta?.status === "error")))) {
            skipped++;
            continue;
        }
        const metadata = meta ? copyMetadata(node.type, meta) : undefined;
        const mask = metadata && resolveCanvasNodeMask(node, graph.maskResources);
        if (metadata && mask) {
            metadata.maskId = metadata.maskId || `clipboard-mask-${nanoid()}`;
            masks.set(metadata.maskId, mask);
        }
        nodes.push({ ...node, metadata });
    }
    const ids = new Set(nodes.map(node => node.id));
    const connections = graph.connections.filter(connection => ids.has(connection.fromNodeId) && ids.has(connection.toNodeId));
    return { graph: { nodes, connections, maskResources: Object.fromEntries(masks) }, skipped };
}

function checkClipboardSize(value: string) {
    if (value.length > maxClipboardBytes || new TextEncoder().encode(value).byteLength > maxClipboardBytes) {
        throw new Error("复制内容过多，请分批复制");
    }
}

export function encodeCanvasClipboard(graph: CanvasClipboardGraph, scope: string) {
    const value = JSON.stringify({ version: 1, scope, ...graph });
    checkClipboardSize(value);
    return value;
}

export function decodeCanvasClipboard(value: string, scope: string): CanvasClipboardGraph {
    checkClipboardSize(value);
    const invalid = () => new Error("剪贴板中的画布内容无效，请重新复制");
    let snapshot: unknown;
    try {
        snapshot = JSON.parse(value);
    } catch {
        throw invalid();
    }
    if (!isRecord(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.nodes) ||
        !snapshot.nodes.length || !Array.isArray(snapshot.connections) || !isRecord(snapshot.maskResources)) throw invalid();
    if (snapshot.scope !== scope) throw new Error("请使用复制时的账号粘贴画布节点");

    const nodeIds = new Set<string>();
    const masks = new Map<string, NonNullable<ReturnType<typeof normalizeImageMask>>>();
    const sources = snapshot.maskResources;
    const nodes = snapshot.nodes.map((node: unknown): CanvasNodeData => {
        if (!isRecord(node) || !isId(node.id) || nodeIds.has(node.id) || typeof node.type !== "string" || !nodeTypes.has(node.type) ||
            typeof node.title !== "string" || !isRecord(node.position) || !isFiniteNumber(node.position.x) || !isFiniteNumber(node.position.y) ||
            !isFiniteNumber(node.width) || node.width <= 0 || !isFiniteNumber(node.height) || node.height <= 0 ||
            !Number.isFinite(node.position.x + node.width) || !Number.isFinite(node.position.y + node.height)) throw invalid();
        nodeIds.add(node.id);
        const type = node.type as CanvasNodeType;
        const metadata = isRecord(node.metadata) ? copyMetadata(type, node.metadata) : undefined;
        if (metadata?.maskId && !masks.has(metadata.maskId) && Object.hasOwn(sources, metadata.maskId)) {
            const mask = normalizeImageMask(sources[metadata.maskId]);
            if (mask) masks.set(metadata.maskId, mask);
        }
        return { id: node.id, type, title: node.title, position: { x: node.position.x, y: node.position.y }, width: node.width, height: node.height, metadata };
    });
    const connections = snapshot.connections.map((connection: unknown): CanvasConnection => {
        if (!isRecord(connection) || !isId(connection.id) || !isId(connection.fromNodeId) || !isId(connection.toNodeId) ||
            !nodeIds.has(connection.fromNodeId) || !nodeIds.has(connection.toNodeId)) throw invalid();
        return { id: connection.id, fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId };
    });
    return { nodes, connections, maskResources: Object.fromEntries(masks) };
}

export function placeCanvasClipboard(graph: CanvasClipboardGraph, center: Position): CanvasClipboardGraph {
    const ids = new Map(graph.nodes.map(node => [node.id, `${node.type}-${nanoid()}`]));
    const bounds = graph.nodes.reduce(
        (box, node) => ({
            left: Math.min(box.left, node.position.x), top: Math.min(box.top, node.position.y),
            right: Math.max(box.right, node.position.x + node.width), bottom: Math.max(box.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    const dx = center.x - (bounds.left / 2 + bounds.right / 2);
    const dy = center.y - (bounds.top / 2 + bounds.bottom / 2);
    const maskIds = new Map<string, string>();
    const maskResources: CanvasMaskResources = {};
    const mapIds = (values?: string[]) => values && [...new Set(values.flatMap(id => ids.get(id) || []))];
    const nodes = graph.nodes.map(node => {
        const id = ids.get(node.id)!;
        const title = node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`;
        const position = { x: node.position.x + dx, y: node.position.y + dy };
        if (!Number.isFinite(position.x + node.width) || !Number.isFinite(position.y + node.height)) throw new Error("剪贴板中的节点位置无效");
        if (!node.metadata) return { ...node, id, title, position };

        const { maskId, sourceNodeId, inputOrder, batchRootId, batchChildIds, primaryImageId, isBatchRoot, imageBatchExpanded, batchUsesReferenceImages, ...retainedMetadata } = node.metadata;
        const metadata: CanvasNodeMetadata = retainedMetadata;
        const source = sourceNodeId && ids.get(sourceNodeId);
        const remappedChildren = mapIds(batchChildIds);
        const root = batchRootId && ids.get(batchRootId);
        if (inputOrder) metadata.inputOrder = mapIds(inputOrder);
        if (source) metadata.sourceNodeId = source;
        if (root) metadata.batchRootId = root;
        if (isBatchRoot && remappedChildren?.length) {
            metadata.isBatchRoot = true;
            metadata.batchChildIds = remappedChildren;
            metadata.imageBatchExpanded = imageBatchExpanded;
            metadata.batchUsesReferenceImages = batchUsesReferenceImages;
            metadata.primaryImageId = (primaryImageId && ids.get(primaryImageId)) || id;
        }
        // An inherited mask belongs to its source image, even if the result
        // alone was selected. It must not turn into a mask on the result.
        if (maskId && (!sourceNodeId || source) && Object.hasOwn(graph.maskResources, maskId)) {
            const newMaskId = maskIds.get(maskId) || `mask-${nanoid()}`;
            maskIds.set(maskId, newMaskId);
            maskResources[newMaskId] = graph.maskResources[maskId];
            metadata.maskId = newMaskId;
        }
        return { ...node, id, title, position, metadata };
    });
    const connections = graph.connections.map(connection => ({
        id: `conn-${nanoid()}`, fromNodeId: ids.get(connection.fromNodeId)!, toNodeId: ids.get(connection.toNodeId)!,
    }));
    return { nodes, connections, maskResources };
}
