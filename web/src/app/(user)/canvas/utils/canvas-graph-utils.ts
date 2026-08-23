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

export function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>): boolean {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]): boolean {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}
