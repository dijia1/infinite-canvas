import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/app/(user)/canvas/types";
import type { CanvasRenderDetail } from "@/app/(user)/canvas/media/canvas-media-policy";
import { getConnectionCurve } from "@/app/(user)/canvas/utils/canvas-connection-geometry";
import { isCanvasConnectionNearViewport, shouldRenderCanvasConnection } from "@/app/(user)/canvas/utils/canvas-connection-visibility";
import { isCanvasNodeNearViewport } from "@/app/(user)/canvas/utils/canvas-node-visibility";

import { parseWorkflowVisualId, workflowVisualNodeId, workflowVisualOutputId } from "./workflow-canvas-adapter";
import { workflowOutputKey, workflowOutputResourceNodeId } from "./workflow-run-state";
import type { WorkflowGraph, WorkflowOutputExecution } from "./types";

export type WorkflowOutputLink = CanvasConnection;

export type WorkflowViewportScene = {
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    visibleNodeIds: ReadonlySet<string>;
    visibleConnections: readonly CanvasConnection[];
    visibleOutputLinks: readonly WorkflowOutputLink[];
};

export function workflowOutputLinks(graph: WorkflowGraph): WorkflowOutputLink[] {
    return graph.nodes.flatMap((node) =>
        (node.outputs || []).map((slot) => ({
            id: `workflow-output:${workflowVisualOutputId(node.id, slot.id)}`,
            fromNodeId: workflowVisualNodeId(node.id),
            toNodeId: workflowVisualOutputId(node.id, slot.id),
        })),
    );
}

export function workflowSelectedImageResourceIds(
    graph: WorkflowGraph,
    selectedVisualIds: ReadonlySet<string>,
    outputsByKey: ReadonlyMap<string, WorkflowOutputExecution>,
) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const resourceIds = new Set<string>();
    for (const visualId of selectedVisualIds) {
        const selected = parseWorkflowVisualId(visualId);
        if (!selected) continue;
        const node = nodesById.get(selected.nodeId);
        if (!node) continue;
        if (selected.kind === "node") {
            if (node.type === "image_input" && node.mediaId) resourceIds.add(node.id);
            continue;
        }
        if (node.outputs?.find((slot) => slot.id === selected.slotId)?.type !== "image") continue;
        const output = outputsByKey.get(workflowOutputKey(node.id, selected.slotId));
        if (output?.status === "succeeded" && output.mediaId) {
            resourceIds.add(workflowOutputResourceNodeId(output.runId, node.id, selected.slotId));
        }
    }
    return resourceIds;
}

export function workflowConnectionPathCache(
    connections: readonly CanvasConnection[],
    nodeById: ReadonlyMap<string, CanvasNodeData>,
) {
    return new Map(connections.flatMap((connection) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        return from && to ? [[connection.id, getConnectionCurve(from, to).pathD] as const] : [];
    }));
}

export function workflowOutputPathCache(
    outputLinks: readonly WorkflowOutputLink[],
    nodeById: ReadonlyMap<string, CanvasNodeData>,
) {
    return new Map(outputLinks.flatMap((link) => {
        const from = nodeById.get(link.fromNodeId);
        const to = nodeById.get(link.toNodeId);
        if (!from || !to) return [];
        const startX = from.position.x + from.width;
        const startY = from.position.y + from.height / 2;
        const endX = to.position.x;
        const endY = to.position.y + to.height / 2;
        return [[link.id, `M ${startX} ${startY} C ${startX + 48} ${startY}, ${endX - 48} ${endY}, ${endX} ${endY}`] as const];
    }));
}

export function buildWorkflowPathData(
    connections: readonly CanvasConnection[],
    pathCache: ReadonlyMap<string, string>,
    excludedIds: ReadonlySet<string> = new Set(),
) {
    return connections.flatMap((connection) => {
        if (excludedIds.has(connection.id)) return [];
        const path = pathCache.get(connection.id);
        return path ? [path] : [];
    }).join(" ");
}

export function workflowVisualRenderDetail(
    renderDetail: CanvasRenderDetail,
    visualNodeId: string,
    retainedNodeIds: ReadonlySet<string>,
): CanvasRenderDetail {
    return renderDetail === "overview" && retainedNodeIds.has(visualNodeId) ? "full" : renderDetail;
}

export function selectWorkflowViewportScene({
    nodes,
    connections,
    outputLinks,
    viewport,
    viewportSize,
    retainedNodeIds,
    interactiveConnectionIds,
}: {
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
    outputLinks: readonly WorkflowOutputLink[];
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    retainedNodeIds: ReadonlySet<string>;
    interactiveConnectionIds: ReadonlySet<string>;
}): WorkflowViewportScene {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const visibleNodeIds = new Set<string>();
    for (const node of nodes) {
        if (retainedNodeIds.has(node.id) || (viewportSize.width > 0 && viewportSize.height > 0 && isCanvasNodeNearViewport(node, viewport, viewportSize))) {
            visibleNodeIds.add(node.id);
        }
    }

    if (viewportSize.width <= 0 || viewportSize.height <= 0) {
        return { nodeById, visibleNodeIds, visibleConnections: [], visibleOutputLinks: [] };
    }

    const isVisible = (connection: CanvasConnection, interactive = false) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        return Boolean(
            from
            && to
            && shouldRenderCanvasConnection(connection, visibleNodeIds, interactive)
            && isCanvasConnectionNearViewport(from, to, viewport, viewportSize),
        );
    };

    return {
        nodeById,
        visibleNodeIds,
        visibleConnections: connections.filter((connection) => isVisible(connection, interactiveConnectionIds.has(connection.id))),
        visibleOutputLinks: outputLinks.filter((connection) => isVisible(connection)),
    };
}
