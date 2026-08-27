import { CanvasNodeType, type CanvasNodeData } from "../types.ts";

export function selectedDownloadableImageNodes(nodes: CanvasNodeData[], selectedNodeIds: Set<string>) {
    return nodes.filter((node) => node.type === CanvasNodeType.Image && selectedNodeIds.has(node.id) && Boolean(node.metadata?.content || node.metadata?.storageKey || node.metadata?.mediaId));
}
