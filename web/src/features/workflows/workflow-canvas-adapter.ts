import { canvasFrameRectsOverlap, MAX_CANVAS_FRAMES } from "@/lib/canvas-frame";
import { nanoid } from "nanoid";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle } from "@/app/(user)/canvas/types";

import { addWorkflowConnection, removeWorkflowConnection, removeWorkflowNode, removeWorkflowOutput, validateWorkflowConnection, workflowConnectionKey, type WorkflowConnectionInput } from "./workflow-graph";
import type { WorkflowGraph, WorkflowPosition } from "./types";

export type WorkflowVisualIdentity = { kind: "node"; nodeId: string } | { kind: "output"; nodeId: string; slotId: string };
export type WorkflowConnectionValidator = (graph: WorkflowGraph, input: WorkflowConnectionInput) => void;

// These identifiers are editor-only; graph IDs and output slot IDs may themselves contain delimiters.
export const workflowVisualNodeId = (nodeId: string) => JSON.stringify(["node", nodeId]);
export const workflowVisualOutputId = (nodeId: string, slotId: string) => JSON.stringify(["output", nodeId, slotId]);

export function parseWorkflowVisualId(id: string): WorkflowVisualIdentity | null {
    try {
        const value: unknown = JSON.parse(id);
        if (!Array.isArray(value) || typeof value[1] !== "string") return null;
        if (value.length === 2 && value[0] === "node") return { kind: "node", nodeId: value[1] };
        if (value.length === 3 && value[0] === "output" && typeof value[2] === "string") return { kind: "output", nodeId: value[1], slotId: value[2] };
    } catch { /* Not an editor identifier. */ }
    return null;
}

export function toWorkflowCanvasNodes(graph: WorkflowGraph): CanvasNodeData[] {
    return graph.nodes.flatMap((node) => {
        const type = node.type === "text_input" ? CanvasNodeType.Text : node.type === "image_input" ? CanvasNodeType.Image : node.type === "video_input" ? CanvasNodeType.Video : CanvasNodeType.Config;
        return [
            { id: workflowVisualNodeId(node.id), type, title: "", position: node.position, width: node.width || 340, height: node.height || 240 },
            ...(node.outputs || []).map((slot) => ({ id: workflowVisualOutputId(node.id, slot.id), type: slot.type === "video" ? CanvasNodeType.Video : CanvasNodeType.Image, title: "", position: slot.position || node.position, width: slot.width || 340, height: slot.height || 240 })),
        ];
    });
}

export function toWorkflowCanvasConnections(graph: WorkflowGraph): CanvasConnection[] {
    return graph.connections.map((connection) => ({
        id: workflowConnectionKey(connection),
        fromNodeId: connection.sourceSlotId === "output" && graph.nodes.some((node) => node.id === connection.sourceNodeId && node.type.endsWith("_input")) ? workflowVisualNodeId(connection.sourceNodeId) : workflowVisualOutputId(connection.sourceNodeId, connection.sourceSlotId),
        toNodeId: workflowVisualNodeId(connection.targetNodeId),
    }));
}

export function applyWorkflowVisualNodes(graph: WorkflowGraph, visualNodes: CanvasNodeData[]): WorkflowGraph {
    const updates = new Map(visualNodes.map((node) => [node.id, node]));
    let changed = false;
    const nodes = graph.nodes.map((node) => {
        const visual = updates.get(workflowVisualNodeId(node.id));
        const outputs = node.outputs?.map((slot) => {
            const update = updates.get(workflowVisualOutputId(node.id, slot.id));
            const position = slot.position || node.position;
            if (!update || (position.x === update.position.x && position.y === update.position.y && (slot.width || 340) === update.width && (slot.height || 240) === update.height)) return slot;
            changed = true;
            return { ...slot, position: update.position, width: update.width, height: update.height };
        });
        const outputChanged = outputs?.some((slot, index) => slot !== node.outputs?.[index]);
        if (!visual || (visual.position.x === node.position.x && visual.position.y === node.position.y && visual.width === (node.width || 340) && visual.height === (node.height || 240))) return outputChanged ? { ...node, outputs } : node;
        changed = true;
        return { ...node, position: visual.position, width: visual.width, height: visual.height, ...(outputs ? { outputs } : {}) };
    });
    return changed ? { ...graph, nodes } : graph;
}

export function workflowConnectionInput(fromNodeId: string, toNodeId: string): WorkflowConnectionInput | null {
    const source = parseWorkflowVisualId(fromNodeId);
    const target = parseWorkflowVisualId(toNodeId);
    if (!source || !target || target.kind !== "node") return null;
    return { sourceNodeId: source.nodeId, sourceSlotId: source.kind === "output" ? source.slotId : "output", targetNodeId: target.nodeId };
}

export function normalizeWorkflowCanvasConnection(graph: WorkflowGraph, firstId: string, secondId: string, handle: ConnectionHandle["handleType"], validate?: WorkflowConnectionValidator): Pick<CanvasConnection, "fromNodeId" | "toNodeId"> | null {
    const connection = handle === "target" ? { fromNodeId: secondId, toNodeId: firstId } : { fromNodeId: firstId, toNodeId: secondId };
    const input = workflowConnectionInput(connection.fromNodeId, connection.toNodeId);
    if (!input) return null;
    try {
        validateWorkflowConnection(graph, input);
        validate?.(graph, input);
        return connection;
    } catch { return null; }
}

export function applyWorkflowVisualConnections(graph: WorkflowGraph, connections: CanvasConnection[], validate?: WorkflowConnectionValidator): WorkflowGraph {
    const kept = new Set(connections.map((connection) => connection.id));
    let next = graph;
    for (const connection of graph.connections) if (!kept.has(workflowConnectionKey(connection))) next = removeWorkflowConnection(next, connection);
    const current = new Set(toWorkflowCanvasConnections(next).map((connection) => connection.id));
    for (const connection of connections) {
        if (current.has(connection.id)) continue;
        const input = workflowConnectionInput(connection.fromNodeId, connection.toNodeId);
        if (!input) throw new Error("连接节点不存在");
        validate?.(next, input);
        next = addWorkflowConnection(next, input);
    }
    return next;
}

export function deleteWorkflowVisualSelection(graph: WorkflowGraph, selectedIds: ReadonlySet<string>, selectedConnectionId?: string | null): WorkflowGraph {
    let next = graph;
    const identities = [...selectedIds].map(parseWorkflowVisualId).filter((value): value is WorkflowVisualIdentity => value !== null);
    for (const selected of identities) if (selected.kind === "node") next = removeWorkflowNode(next, selected.nodeId);
    for (const selected of identities) if (selected.kind === "output") next = removeWorkflowOutput(next, selected.nodeId, selected.slotId);
    const connection = next.connections.find((item) => workflowConnectionKey(item) === selectedConnectionId);
    return connection ? removeWorkflowConnection(next, connection) : next;
}

export function copyWorkflowSelection(graph: WorkflowGraph, selectedIds: ReadonlySet<string>): WorkflowGraph {
    // A result slot is not an independent definition. Only explicitly selected graph nodes can be copied.
    const nodeIds = new Set([...selectedIds].flatMap((id) => { const item = parseWorkflowVisualId(id); return item?.kind === "node" ? [item.nodeId] : []; }));
    return structuredClone({ version: 1, nodes: graph.nodes.filter((node) => nodeIds.has(node.id)), connections: graph.connections.filter((connection) => nodeIds.has(connection.sourceNodeId) && nodeIds.has(connection.targetNodeId)) });
}

export function copyWorkflowFrameSelection(graph: WorkflowGraph, frameId: string): WorkflowGraph {
    const frame = graph.frames?.find((item) => item.id === frameId);
    if (!frame) return { version: 1, nodes: [], connections: [] };
    const copied = copyWorkflowSelection(graph, new Set(frame.nodeIds.map(workflowVisualNodeId)));
    const ports = new Set(copied.connections.map((edge) => JSON.stringify([edge.targetNodeId, edge.targetPortId])));
    return { ...copied,
        nodes: copied.nodes.map((node) => ({ ...node, ...(node.inputPorts ? { inputPorts: node.inputPorts.filter((port) => ports.has(JSON.stringify([node.id, port.id]))) } : {}) })),
        frames: [structuredClone(frame)],
    };
}

export function pasteWorkflowSelection(graph: WorkflowGraph, clipboard: WorkflowGraph, offset: WorkflowPosition = { x: 48, y: 48 }, createId: () => string = nanoid): { graph: WorkflowGraph; selectedNodeIds: Set<string>; selectedFrameId?: string } {
    if ((graph.frames?.length || 0) + (clipboard.frames?.length || 0) > MAX_CANVAS_FRAMES) throw new Error(`最多支持 ${MAX_CANVAS_FRAMES} 个包裹框`);
    const placementOffset = nonOverlappingFramePasteOffset(graph.frames || [], clipboard.frames || [], offset);
    const nodeIds = new Map(clipboard.nodes.map((node) => [node.id, createId()]));
    const slotIds = new Map(clipboard.nodes.flatMap((node) => (node.outputs || []).map((slot) => [workflowVisualOutputId(node.id, slot.id), createId()] as const)));
    const portIds = new Map(clipboard.nodes.flatMap((node) => (node.inputPorts || []).map((port) => [JSON.stringify([node.id, port.id]), createId()] as const)));
    const move = (position: WorkflowPosition) => ({ x: position.x + placementOffset.x, y: position.y + placementOffset.y });
    const connections = clipboard.connections.map((connection) => ({ ...connection, sourceNodeId: nodeIds.get(connection.sourceNodeId)!, targetNodeId: nodeIds.get(connection.targetNodeId)!, sourceSlotId: slotIds.get(workflowVisualOutputId(connection.sourceNodeId, connection.sourceSlotId)) || connection.sourceSlotId, targetPortId: portIds.get(JSON.stringify([connection.targetNodeId, connection.targetPortId]))! }));
    const usedPorts = new Set(connections.map((connection) => connection.targetPortId));
    const nodes = structuredClone(clipboard.nodes).map((node) => ({ ...node, id: nodeIds.get(node.id)!, position: move(node.position), ...(node.outputs ? { outputs: node.outputs.map((slot) => ({ ...slot, id: slotIds.get(workflowVisualOutputId(node.id, slot.id))!, position: move(slot.position || node.position) })) } : {}), ...(node.inputPorts ? { inputPorts: node.inputPorts.map((port) => ({ ...port, id: portIds.get(JSON.stringify([node.id, port.id]))! })).filter((port) => usedPorts.has(port.id)) } : {}) }));
    const frames = clipboard.frames?.map((frame) => ({ ...structuredClone(frame), id: createId(), position: move(frame.position), nodeIds: frame.nodeIds.flatMap((id) => nodeIds.has(id) ? [nodeIds.get(id)!] : []) }));
    return {
        graph: { ...graph, nodes: [...graph.nodes, ...nodes], connections: [...graph.connections, ...connections], ...(frames?.length ? { frames: [...(graph.frames || []), ...frames] } : {}) },
        selectedFrameId: frames?.[0]?.id,
        selectedNodeIds: new Set(frames?.length ? [] : nodes.flatMap((node) => [workflowVisualNodeId(node.id), ...(node.outputs || []).map((slot) => workflowVisualOutputId(node.id, slot.id))])),
    };
}

function nonOverlappingFramePasteOffset(existing: NonNullable<WorkflowGraph["frames"]>, copied: NonNullable<WorkflowGraph["frames"]>, requested: WorkflowPosition): WorkflowPosition {
    if (!existing.length || !copied.length) return requested;
    const moved = copied.map((frame) => ({ ...frame, position: { x: frame.position.x + requested.x, y: frame.position.y + requested.y } }));
    if (!moved.some((frame) => existing.some((current) => canvasFrameRectsOverlap(frame, current)))) return requested;
    const right = Math.max(...existing.map((frame) => frame.position.x + frame.width));
    const left = Math.min(...moved.map((frame) => frame.position.x));
    return { x: requested.x + right + 48 - left, y: requested.y };
}
