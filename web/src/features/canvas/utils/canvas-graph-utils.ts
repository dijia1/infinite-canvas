import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle } from "../types.ts";

export type NormalizedConnection = Pick<CanvasConnection, "fromNodeId" | "toNodeId">;

export function normalizeConnection(
    firstNodeId: string,
    secondNodeId: string,
    nodes: CanvasNodeData[],
    firstHandleType: ConnectionHandle["handleType"],
): NormalizedConnection | null {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

export function hiddenBatchNodeIds(nodes: CanvasNodeData[], collapsingBatchIds?: ReadonlySet<string>) {
    const roots = new Map(nodes.map((node) => [node.id, node]));
    const hiddenNodeIds = new Set<string>();
    const hiddenConnectionNodeIds = new Set<string>();
    for (const node of nodes) {
        const rootId = node.metadata?.batchRootId;
        if (!rootId) continue;
        const root = roots.get(rootId);
        if (!root || root.metadata?.imageBatchExpanded) continue;
        hiddenConnectionNodeIds.add(node.id);
        if (!collapsingBatchIds?.has(rootId)) hiddenNodeIds.add(node.id);
    }
    return { hiddenNodeIds, hiddenConnectionNodeIds };
}
