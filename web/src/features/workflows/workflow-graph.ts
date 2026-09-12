import { nanoid } from "nanoid";
import { fitNodeSize } from "@/app/(user)/canvas/utils/canvas-node-size";

import type { WorkflowConnection, WorkflowGraph, WorkflowMediaType, WorkflowNode, WorkflowNodeType, WorkflowPosition } from "./types";

const MAX_INPUTS = 9;
const MAX_OUTPUTS = 9;

export function emptyWorkflowGraph(): WorkflowGraph {
    return { version: 1, nodes: [], connections: [] };
}

export function createWorkflowNode(type: WorkflowNodeType, position: WorkflowPosition, id = nanoid()): WorkflowNode {
    if (type === "image_input") return { id, type, position, width: 340, height: 240 };
    if (type === "video_input") return { id, type, position, width: 420, height: 236 };
    if (type === "text_input") return { id, type, position, width: 340, height: 240, text: "" };
    const outputType = type === "image_generation" ? "image" : "video";
    const width = 360;
    return {
        id,
        type,
        position,
        width,
        height: 260,
        inputPorts: [],
        config: {},
        outputs: [{ id: `${id}-output-1`, type: outputType, position: { x: position.x + width + 96, y: position.y + 10 }, width: outputType === "image" ? 340 : 420, height: outputType === "image" ? 240 : 236 }],
    };
}

export function workflowSourceType(node: WorkflowNode, slotId: string): WorkflowMediaType | undefined {
    if (slotId === "output") {
        if (node.type === "image_input") return "image";
        if (node.type === "video_input") return "video";
        if (node.type === "text_input") return "text";
        return undefined;
    }
    return node.outputs?.find((slot) => slot.id === slotId)?.type;
}

export type WorkflowConnectionInput = { sourceNodeId: string; sourceSlotId: string; targetNodeId: string };

export function validateWorkflowConnection(graph: WorkflowGraph, input: WorkflowConnectionInput) {
    const source = graph.nodes.find((node) => node.id === input.sourceNodeId);
    const target = graph.nodes.find((node) => node.id === input.targetNodeId);
    if (!source || !target) throw new Error("连接节点不存在");
    if (source.id === target.id) throw new Error("不能连接节点自身");
    if (target.type !== "image_generation" && target.type !== "video_generation") throw new Error("只能连接到生成配置");
    const sourceType = workflowSourceType(source, input.sourceSlotId);
    if (!sourceType) throw new Error("输出槽位不存在");
    if (target.type === "image_generation" && sourceType === "video") throw new Error("生图配置不支持视频输入");
    if (graph.connections.some((connection) => connection.sourceNodeId === source.id && connection.sourceSlotId === input.sourceSlotId && connection.targetNodeId === target.id)) throw new Error("该输入已经连接");
    if (graph.connections.filter((connection) => connection.targetNodeId === target.id).length >= MAX_INPUTS) throw new Error("每个生成步骤最多连接 9 个输入");
    if (createsCycle(graph, source.id, target.id)) throw new Error("连接不能形成循环");

    return { source, target, sourceType };
}

export function addWorkflowConnection(graph: WorkflowGraph, input: WorkflowConnectionInput): WorkflowGraph {
    const { target, sourceType } = validateWorkflowConnection(graph, input);
    const portIndex = (target.inputPorts || []).filter((port) => port.type === sourceType).length + 1;
    const port = { id: `${target.id}-input-${sourceType}-${portIndex}-${nanoid(5)}`, type: sourceType };
    const targetConnections = graph.connections.filter((connection) => connection.targetNodeId === target.id);
    const order = targetConnections.length ? Math.max(...targetConnections.map((connection) => connection.order)) + 1 : 0;
    const connection: WorkflowConnection = { ...input, targetPortId: port.id, order };
    return {
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === target.id ? { ...node, inputPorts: [...(node.inputPorts || []), port] } : node)),
        connections: [...graph.connections, connection],
    };
}

export function appendWorkflowOutput(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node || (node.type !== "image_generation" && node.type !== "video_generation")) throw new Error("生成节点不存在");
    const outputs = node.outputs || [];
    if (outputs.length >= MAX_OUTPUTS) throw new Error("每个生成步骤最多 9 个输出");
    const width = node.width || 320;
    const outputWidth = node.type === "image_generation" ? 340 : 420;
    const outputHeight = node.type === "image_generation" ? 240 : 236;
    const x = node.position.x + width + 96;
    let position = { x, y: node.position.y + 10 };
    for (let row = 0; row < MAX_OUTPUTS; row++) {
        const candidate = { x, y: node.position.y + 10 + row * (outputHeight + 36) };
        if (!outputs.some((slot) => rectanglesOverlap(candidate, outputWidth, outputHeight, slot.position || node.position, slot.width || outputWidth, slot.height || outputHeight))) {
            position = candidate;
            break;
        }
    }
    const output = {
        id: `${node.id}-output-${outputs.length + 1}-${nanoid(5)}`,
        type: node.type === "image_generation" ? ("image" as const) : ("video" as const),
        position,
        width: outputWidth,
        height: outputHeight,
    };
    return { ...graph, nodes: graph.nodes.map((item) => (item.id === node.id ? { ...item, outputs: [...outputs, output] } : item)) };
}

export function setWorkflowOutputCount(graph: WorkflowGraph, nodeId: string, count: number): WorkflowGraph {
    const desired = Math.max(1, Math.min(MAX_OUTPUTS, Math.floor(count) || 1));
    let next = graph;
    while ((next.nodes.find((node) => node.id === nodeId)?.outputs?.length || 0) < desired) next = appendWorkflowOutput(next, nodeId);
    while ((next.nodes.find((node) => node.id === nodeId)?.outputs?.length || 0) > desired) {
        const outputs = next.nodes.find((node) => node.id === nodeId)?.outputs || [];
        next = removeWorkflowOutput(next, nodeId, outputs[outputs.length - 1]!.id);
    }
    return next;
}

export function removeWorkflowOutput(graph: WorkflowGraph, nodeId: string, slotId: string): WorkflowGraph {
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node?.outputs?.some((slot) => slot.id === slotId)) return graph;
    if (graph.connections.some((connection) => connection.sourceNodeId === nodeId && connection.sourceSlotId === slotId)) throw new Error("输出仍有连线，请先删除连线");
    if (node.outputs.length === 1) throw new Error("生成步骤至少保留 1 个输出");
    return { ...graph, nodes: graph.nodes.map((item) => (item.id === nodeId ? { ...item, outputs: item.outputs?.filter((slot) => slot.id !== slotId) } : item)) };
}

export function removeWorkflowConnection(graph: WorkflowGraph, connection: WorkflowConnection): WorkflowGraph {
    const connections = graph.connections.filter((item) => !sameConnection(item, connection));
    if (connections.length === graph.connections.length) return graph;
    const usedPortIds = new Set(connections.filter((item) => item.targetNodeId === connection.targetNodeId).map((item) => item.targetPortId));
    return {
        ...graph,
        connections,
        nodes: graph.nodes.map((node) => (node.id === connection.targetNodeId ? { ...node, inputPorts: node.inputPorts?.filter((port) => usedPortIds.has(port.id)) } : node)),
    };
}

export function removeWorkflowNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
    const connections = graph.connections.filter((connection) => connection.sourceNodeId !== nodeId && connection.targetNodeId !== nodeId);
    return {
        ...graph,
        nodes: graph.nodes
            .filter((node) => node.id !== nodeId)
            .map((node) => {
                const usedPortIds = new Set(connections.filter((connection) => connection.targetNodeId === node.id).map((connection) => connection.targetPortId));
                return { ...node, inputPorts: node.inputPorts?.filter((port) => usedPortIds.has(port.id)) };
            }),
        connections,
        ...(graph.frames ? { frames: graph.frames.map((frame) => frame.nodeIds.includes(nodeId) ? { ...frame, nodeIds: frame.nodeIds.filter((id) => id !== nodeId) } : frame) } : {}),
    };
}

function sameConnection(left: WorkflowConnection, right: WorkflowConnection) {
    return left.sourceNodeId === right.sourceNodeId && left.sourceSlotId === right.sourceSlotId && left.targetNodeId === right.targetNodeId && left.targetPortId === right.targetPortId;
}

export type WorkflowConnectionIdentity = Pick<WorkflowConnection, "targetNodeId" | "targetPortId">;

export function workflowConnectionKey(connection: WorkflowConnectionIdentity) {
    return JSON.stringify([connection.targetNodeId, connection.targetPortId]);
}

function rectanglesOverlap(leftPosition: WorkflowPosition, leftWidth: number, leftHeight: number, rightPosition: WorkflowPosition, rightWidth: number, rightHeight: number, padding = 0) {
    return leftPosition.x < rightPosition.x + rightWidth + padding && leftPosition.x + leftWidth + padding > rightPosition.x && leftPosition.y < rightPosition.y + rightHeight + padding && leftPosition.y + leftHeight + padding > rightPosition.y;
}

function createsCycle(graph: WorkflowGraph, sourceNodeId: string, targetNodeId: string) {
    const queue = [targetNodeId];
    const visited = new Set<string>();
    while (queue.length) {
        const current = queue.shift()!;
        if (current === sourceNodeId) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        graph.connections.filter((connection) => connection.sourceNodeId === current).forEach((connection) => queue.push(connection.targetNodeId));
    }
    return false;
}

export function workflowViewportCenter(viewport: { x: number; y: number; k: number }, size: { width: number; height: number }): WorkflowPosition {
    return { x: (size.width / 2 - viewport.x) / viewport.k, y: (size.height / 2 - viewport.y) / viewport.k };
}

// Preserve the node's center when an empty placeholder becomes an image.
export function fitWorkflowImage<T extends { width?: number; height?: number; position?: WorkflowPosition }>(node: T, dimensions: { width: number; height: number }, force = false): T {
    if (!(Number.isFinite(dimensions.width) && dimensions.width > 0 && Number.isFinite(dimensions.height) && dimensions.height > 0)) return node;
    // Older workflows stored only the placeholder size. Do not reset custom sizes on resource reload.
    if (!force && ((node.width || 340) !== 340 || (node.height || 240) !== 240)) return node;
    const size = fitNodeSize(dimensions.width, dimensions.height);
    if (size.width === node.width && size.height === node.height) return node;
    return { ...node, ...size, ...(node.position ? { position: { x: node.position.x + ((node.width || 340) - size.width) / 2, y: node.position.y + ((node.height || 240) - size.height) / 2 } } : {}) };
}
