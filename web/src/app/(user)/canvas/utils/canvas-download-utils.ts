import { CanvasNodeType, type CanvasNodeData } from "../types.ts";
import type { ImageDownloadTarget } from "@/services/image-download";

export function selectedDownloadableImageNodes(nodes: CanvasNodeData[], selectedNodeIds: Set<string>) {
    return nodes.filter((node) => node.type === CanvasNodeType.Image && selectedNodeIds.has(node.id) && Boolean(node.metadata?.content || node.metadata?.storageKey || node.metadata?.mediaId || node.metadata?.publicImageId));
}

export function canvasImageDownloadTargets(nodes: readonly CanvasNodeData[]): ImageDownloadTarget[] {
    return nodes.filter(node => node.type === CanvasNodeType.Image && node.metadata).map(node => ({
        filename: `canvas-image-${node.id}`,
        mediaId: node.metadata!.mediaId,
        storageKey: node.metadata!.storageKey,
        url: node.metadata!.content,
        publicImageId: node.metadata!.publicImageId,
        mimeType: node.metadata!.mimeType,
    }));
}
