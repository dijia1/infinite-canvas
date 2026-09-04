import type { CanvasProjectDocument } from "@/services/api/canvas-projects";

import { CanvasNodeType, type CanvasNodeData } from "../types";

export function isLocalImageUploadNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image && !node.metadata?.mediaId && Boolean(node.metadata?.localUploadState && node.metadata.storageKey);
}

export function hasLocalImageUploads(nodes: CanvasNodeData[]) {
    return nodes.some(isLocalImageUploadNode);
}

export function excludeLocalUploadNodes(document: CanvasProjectDocument): CanvasProjectDocument {
    const excludedNodeIds = new Set(document.nodes.filter(isLocalImageUploadNode).map((node) => node.id));
    if (!excludedNodeIds.size) return document;
    return {
        ...document,
        nodes: document.nodes.filter((node) => !excludedNodeIds.has(node.id)),
        connections: document.connections.filter((connection) => !excludedNodeIds.has(connection.fromNodeId) && !excludedNodeIds.has(connection.toNodeId)),
    };
}
