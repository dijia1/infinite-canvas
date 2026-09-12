import { canvasFrameBounds, canvasFrameContainsRect, canvasFrameRectsOverlap, constrainCanvasFrameDelta, constrainCanvasFrameTransition, expandCanvasFrame, MAX_CANVAS_FRAMES, resizeCanvasFrame, resizeCanvasFrameFromHandle, setFrameMembers, type CanvasFrameBounds, type CanvasFrameData, type CanvasFrameRect, type CanvasFrameResizeDirection, type FrameDelta } from "@/lib/canvas-frame";
import { parseWorkflowVisualId, workflowVisualNodeId, workflowVisualOutputId } from "./workflow-canvas-adapter";
import type { WorkflowGraph, WorkflowNode } from "./types";

export type WorkflowFrameGraph = WorkflowGraph & { frames?: CanvasFrameData[] };

export type CreateWorkflowFrameInput = Pick<CanvasFrameData, "id" | "name" | "position"> & Partial<Pick<CanvasFrameData, "width" | "height">>;

export function workflowFrameLogicalNodeIds(graph: WorkflowGraph, visualIds: ReadonlySet<string>): Set<string> {
    const existing = new Set(graph.nodes.map((node) => node.id));
    return new Set(
        [...visualIds].flatMap((visualId) => {
            const identity = parseWorkflowVisualId(visualId);
            return identity && existing.has(identity.nodeId) ? [identity.nodeId] : [];
        }),
    );
}

export function workflowFrameOptionDragVisualIds(graph: WorkflowGraph, visualIds: ReadonlySet<string>): Set<string> {
    const nodeIds = workflowFrameLogicalNodeIds(graph, visualIds);
    return new Set(graph.nodes.flatMap((node) => nodeIds.has(node.id)
        ? [workflowVisualNodeId(node.id), ...(node.outputs || []).map((slot) => workflowVisualOutputId(node.id, slot.id))]
        : []));
}

export function createWorkflowFrame<T extends WorkflowFrameGraph>(graph: T, input: CreateWorkflowFrameInput, visualIds: ReadonlySet<string> = new Set()): T {
    const frames = graph.frames || [];
    if (frames.length >= MAX_CANVAS_FRAMES) throw new Error(`最多创建 ${MAX_CANVAS_FRAMES} 个 Frame`);
    if (frames.some((frame) => frame.id === input.id)) throw new Error("Frame 已存在");
    const nodeIds = [...workflowFrameLogicalNodeIds(graph, visualIds)];
    const fitted = canvasFrameBounds(workflowMemberRects(graph, nodeIds));
    const frame: CanvasFrameData = {
        id: input.id,
        name: input.name,
        position: fitted?.position || input.position,
        width: fitted?.width || input.width || 480,
        height: fitted?.height || input.height || 320,
        nodeIds: [],
    };
    if (frames.some((item) => canvasFrameRectsOverlap(item, frame))) throw new Error("Frame 不能与其他 Frame 重叠");
    return withFrames(graph, setFrameMembers([...frames, frame], nodeIds, frame.id));
}

export function deleteWorkflowFrame<T extends WorkflowFrameGraph>(graph: T, frameId: string): T {
    const frames = graph.frames || [];
    const next = frames.filter((frame) => frame.id !== frameId);
    return next.length === frames.length ? graph : withFrames(graph, next);
}

export function renameWorkflowFrame<T extends WorkflowFrameGraph>(graph: T, frameId: string, name: string): T {
    const frames = graph.frames || [];
    let changed = false;
    const next = frames.map((frame) => {
        if (frame.id !== frameId || frame.name === name) return frame;
        changed = true;
        return { ...frame, name };
    });
    return changed ? withFrames(graph, next) : graph;
}

export function autoAssignWorkflowFrameMembers<T extends WorkflowFrameGraph>(graph: T, visualIds: ReadonlySet<string>): T {
    if (!graph.frames?.length) return graph;
    const existing = new Map(graph.nodes.map((node) => [node.id, node]));
    const owned = new Set(graph.frames.flatMap((frame) => frame.nodeIds));
    const candidates = [...visualIds].flatMap((visualId) => {
        const identity = parseWorkflowVisualId(visualId);
        return identity?.kind === "node" && existing.has(identity.nodeId) && !owned.has(identity.nodeId) ? [identity.nodeId] : [];
    });
    let frames = graph.frames;

    for (const nodeId of new Set(candidates)) {
        const node = existing.get(nodeId)!;
        const containing = graph.frames.filter((frame) => canvasFrameContainsRect(frame, workflowPrimaryNodeRect(node)));
        if (containing.length !== 1) continue;
        const target = containing[0]!;
        const assigned = setFrameMembers(frames, [nodeId], target.id);
        const assignedTarget = assigned.find((frame) => frame.id === target.id)!;
        const expanded = expandCanvasFrame(assignedTarget, workflowMemberRects(graph, assignedTarget.nodeIds));
        if (assigned.some((frame) => frame.id !== target.id && canvasFrameRectsOverlap(frame, expanded))) continue;
        frames = assigned.map((frame) => (frame.id === target.id ? expanded : frame));
        owned.add(nodeId);
    }

    return frames === graph.frames ? graph : withFrames(graph, frames);
}

export function moveWorkflowFrame<T extends WorkflowFrameGraph>(graph: T, frameId: string, delta: FrameDelta): T {
    if ((!delta.x && !delta.y) || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return graph;
    const frame = graph.frames?.find((item) => item.id === frameId);
    if (!frame) return graph;
    const constrained = constrainCanvasFrameDelta(frame, delta, graph.frames!.filter((item) => item.id !== frameId));
    if (!constrained.x && !constrained.y) return graph;
    const memberIds = new Set(frame.nodeIds);
    const nodes = moveWorkflowNodes(graph.nodes, new Map([...memberIds].map((nodeId) => [nodeId, constrained])));
    const frames = graph.frames!.map((item) => (item.id === frameId ? { ...item, position: movePosition(item.position, constrained) } : item));
    return { ...graph, frames, nodes };
}

export function detachWorkflowFrameMembersInPlace<T extends WorkflowFrameGraph>(graph: T, visualIds: ReadonlySet<string>): T {
    if (!graph.frames?.length) return graph;
    const nodeIds = workflowFrameLogicalNodeIds(graph, visualIds);
    if (!nodeIds.size) return graph;
    const frames = setFrameMembers(graph.frames, [...nodeIds], null);
    return frames === graph.frames ? graph : withFrames(graph, frames);
}

export function restoreWorkflowFrameMembersInsideOriginalFrames<T extends WorkflowFrameGraph>(graph: T, visualIds: ReadonlySet<string>, originalGraph: WorkflowFrameGraph): T {
    if (!graph.frames?.length || !originalGraph.frames?.length) return graph;
    const selected = workflowFrameLogicalNodeIds(graph, visualIds);
    if (!selected.size) return graph;
    const currentNodes = new Map(graph.nodes.map((node) => [node.id, node]));
    let frames = graph.frames;

    for (const nodeId of selected) {
        const originalFrame = originalGraph.frames.find((frame) => frame.nodeIds.includes(nodeId));
        const currentFrame = originalFrame && frames.find((frame) => frame.id === originalFrame.id);
        const node = currentNodes.get(nodeId);
        if (!currentFrame || !node || !workflowNodeRects(node).every((rect) => canvasFrameContainsRect(currentFrame, rect))) continue;
        const assigned = setFrameMembers(frames, [nodeId], currentFrame.id);
        const target = assigned.find((frame) => frame.id === currentFrame.id)!;
        const expanded = expandCanvasFrame(target, workflowMemberRects(graph, target.nodeIds));
        if (assigned.some((frame) => frame.id !== target.id && canvasFrameRectsOverlap(frame, expanded))) continue;
        frames = assigned.map((frame) => (frame.id === target.id ? expanded : frame));
    }

    return frames === graph.frames ? graph : withFrames(graph, frames);
}

export function restoreWorkflowFrameGeometries<T extends WorkflowFrameGraph>(graph: T, visualIds: ReadonlySet<string>, originalGraph: WorkflowFrameGraph): T {
    if (!graph.frames?.length || !originalGraph.frames?.length) return graph;
    const nodeIds = workflowFrameLogicalNodeIds(originalGraph, visualIds);
    if (!nodeIds.size) return graph;
    const originals = new Map(originalGraph.frames
        .filter((frame) => frame.nodeIds.some((nodeId) => nodeIds.has(nodeId)))
        .map((frame) => [frame.id, frame]));
    let changed = false;
    const frames = graph.frames.map((frame) => {
        const original = originals.get(frame.id);
        if (!original || sameFrameGeometry(frame, original)) return frame;
        changed = true;
        return { ...frame, position: original.position, width: original.width, height: original.height };
    });
    return changed ? withFrames(graph, frames) : graph;
}

export function constrainWorkflowMemberMove(graphAtDragStart: WorkflowFrameGraph, visualIds: ReadonlySet<string>, requestedDelta: FrameDelta): FrameDelta {
    if (!Number.isFinite(requestedDelta.x) || !Number.isFinite(requestedDelta.y)) return { x: 0, y: 0 };
    if ((!requestedDelta.x && !requestedDelta.y) || !graphAtDragStart.frames?.length) return requestedDelta;
    const selected = workflowVisualIdentities(graphAtDragStart, visualIds);
    const affectedNodeIds = new Set(selected.map((identity) => identity.nodeId));
    const affectedFrameIds = new Set(graphAtDragStart.frames.filter((frame) => frame.nodeIds.some((nodeId) => affectedNodeIds.has(nodeId))).map((frame) => frame.id));
    if (!affectedFrameIds.size) return requestedDelta;

    const overlapsAt = (progress: number) => {
        const delta = { x: requestedDelta.x * progress, y: requestedDelta.y * progress };
        const frames = graphAtDragStart.frames!.map((frame) => affectedFrameIds.has(frame.id)
            ? expandCanvasFrame(frame, workflowMemberRectsAfterVisualMove(graphAtDragStart, frame.nodeIds, selected, delta))
            : frame);
        return frames.some((frame, index) => frames.slice(index + 1).some((other) => canvasFrameRectsOverlap(frame, other)));
    };
    if (!overlapsAt(1)) return requestedDelta;

    let safe = 0;
    let blocked = 1;
    for (let index = 0; index < 60; index += 1) {
        const progress = (safe + blocked) / 2;
        if (overlapsAt(progress)) blocked = progress;
        else safe = progress;
    }
    return { x: requestedDelta.x * safe, y: requestedDelta.y * safe };
}

export function expandWorkflowFrames<T extends WorkflowFrameGraph>(graph: T, visualIds?: ReadonlySet<string>): T {
    if (!graph.frames?.length) return graph;
    const selected = visualIds ? workflowFrameLogicalNodeIds(graph, visualIds) : null;
    if (selected && !selected.size) return graph;
    let changed = false;
    const frames = graph.frames.map((frame) => {
        if (selected && !frame.nodeIds.some((nodeId) => selected.has(nodeId))) return frame;
        const next = expandCanvasFrame(frame, workflowMemberRects(graph, frame.nodeIds));
        changed ||= next !== frame;
        return next;
    });
    return changed ? withFrames(graph, frames) : graph;
}

export function resizeWorkflowFrame<T extends WorkflowFrameGraph>(graph: T, frameId: string, nextBounds: CanvasFrameBounds): T {
    const frames = graph.frames || [];
    let changed = false;
    const next = frames.map((frame) => {
        if (frame.id !== frameId) return frame;
        const resized = resizeCanvasFrame(frame, nextBounds, workflowMemberRects(graph, frame.nodeIds));
        const constrained = constrainCanvasFrameTransition(frame, resized, frames.filter((item) => item.id !== frameId));
        changed ||= constrained !== frame;
        return constrained;
    });
    return changed ? withFrames(graph, next) : graph;
}

export function resizeWorkflowFrameFromHandle<T extends WorkflowFrameGraph>(graph: T, frameId: string, startFrame: CanvasFrameData, direction: CanvasFrameResizeDirection, delta: FrameDelta): T {
    if (startFrame.id !== frameId || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return graph;
    const frames = graph.frames || [];
    let changed = false;
    const next = frames.map((frame) => {
        if (frame.id !== frameId) return frame;
        const startLeft = direction.includes("left") ? startFrame.position.x : frame.position.x;
        const startTop = direction.includes("top") ? startFrame.position.y : frame.position.y;
        const startRight = direction.includes("right") ? startFrame.position.x + startFrame.width : frame.position.x + frame.width;
        const startBottom = direction.includes("bottom") ? startFrame.position.y + startFrame.height : frame.position.y + frame.height;
        const startGeometry = { ...frame, position: { x: startLeft, y: startTop }, width: startRight - startLeft, height: startBottom - startTop };
        const resized = resizeCanvasFrameFromHandle(startGeometry, direction, delta, workflowMemberRects(graph, frame.nodeIds));
        const constrained = constrainCanvasFrameTransition(frame, resized, frames.filter((item) => item.id !== frameId));
        if (sameFrameGeometry(frame, constrained)) return frame;
        changed = true;
        return constrained;
    });
    return changed ? withFrames(graph, next) : graph;
}

function workflowMemberRects(graph: WorkflowGraph, nodeIds: readonly string[]): CanvasFrameRect[] {
    const members = new Set(nodeIds);
    return graph.nodes.flatMap((node) => (members.has(node.id) ? workflowNodeRects(node) : []));
}

function workflowNodeRects(node: WorkflowNode): CanvasFrameRect[] {
    return [{ position: node.position, width: node.width || 340, height: node.height || 240 }, ...(node.outputs || []).map((slot) => ({ position: slot.position || node.position, width: slot.width || 340, height: slot.height || 240 }))];
}

function workflowPrimaryNodeRect(node: WorkflowNode): CanvasFrameRect {
    return { position: node.position, width: node.width || 340, height: node.height || 240 };
}

function workflowVisualIdentities(graph: WorkflowGraph, visualIds: ReadonlySet<string>) {
    const existing = new Set(graph.nodes.map((node) => node.id));
    return [...visualIds].flatMap((visualId) => {
        const identity = parseWorkflowVisualId(visualId);
        return identity && existing.has(identity.nodeId) ? [identity] : [];
    });
}

function workflowMemberRectsAfterVisualMove(graph: WorkflowGraph, nodeIds: readonly string[], selected: ReturnType<typeof workflowVisualIdentities>, delta: FrameDelta): CanvasFrameRect[] {
    const members = new Set(nodeIds);
    const selectedNodes = new Set(selected.filter((identity) => identity.kind === "node").map((identity) => identity.nodeId));
    const selectedOutputs = new Set(selected.flatMap((identity) => identity.kind === "output" ? [JSON.stringify([identity.nodeId, identity.slotId])] : []));
    return graph.nodes.flatMap((node) => {
        if (!members.has(node.id)) return [];
        const primary = workflowPrimaryNodeRect(node);
        return [
            selectedNodes.has(node.id) ? { ...primary, position: movePosition(primary.position, delta) } : primary,
            ...(node.outputs || []).map((slot) => {
                const rect = { position: slot.position || node.position, width: slot.width || 340, height: slot.height || 240 };
                return selectedOutputs.has(JSON.stringify([node.id, slot.id])) ? { ...rect, position: movePosition(rect.position, delta) } : rect;
            }),
        ];
    });
}

function moveWorkflowNodes(nodes: WorkflowNode[], deltas: ReadonlyMap<string, FrameDelta>): WorkflowNode[] {
    return nodes.map((node) => {
        const delta = deltas.get(node.id);
        if (!delta) return node;
        return {
            ...node,
            position: movePosition(node.position, delta),
            ...(node.outputs ? { outputs: node.outputs.map((slot) => (slot.position ? { ...slot, position: movePosition(slot.position, delta) } : slot)) } : {}),
        };
    });
}

function movePosition(position: { x: number; y: number }, delta: FrameDelta) {
    return { x: position.x + delta.x, y: position.y + delta.y };
}

function sameFrameGeometry(left: CanvasFrameData, right: CanvasFrameData) {
    return left.position.x === right.position.x && left.position.y === right.position.y && left.width === right.width && left.height === right.height;
}

function withFrames<T extends WorkflowFrameGraph>(graph: T, frames: CanvasFrameData[]): T {
    return { ...graph, frames };
}
