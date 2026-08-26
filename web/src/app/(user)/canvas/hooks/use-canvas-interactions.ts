"use client";

import { useEffect, useRef, useState } from "react";

import { distanceBetweenPoints, segmentHitsConnection } from "../utils/canvas-connection-geometry";
import { isHiddenBatchChild, isHiddenBatchConnectionEndpoint, normalizeConnection } from "../utils/canvas-graph-utils";
import { isCanvasPerfDebugEnabled, logCanvasPerf } from "../utils/canvas-performance-debug";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle, type ContextMenuState, type Position, type SelectionBox, type ViewportTransform } from "../types";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

export type CutConnectionState = {
    points: Position[];
    connectionIds: Set<string>;
};

type MutableRef<T> = { current: T };
type StateSetter<T> = (value: T | ((previous: T) => T)) => void;

type CanvasPointerEvent = {
    clientX: number;
    clientY: number;
    button?: number;
    buttons?: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    metaKey?: boolean;
    stopPropagation?: () => void;
};

export type CanvasInteractionControllerOptions = {
    nodesRef: MutableRef<CanvasNodeData[]>;
    connectionsRef: MutableRef<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRef<Set<string>>;
    viewportRef: MutableRef<ViewportTransform>;
    setNodes: StateSetter<CanvasNodeData[]>;
    setConnections: StateSetter<CanvasConnection[]>;
    setSelectedNodeIds: StateSetter<Set<string>>;
    setSelectedConnectionId: StateSetter<string | null>;
    setContextMenu: StateSetter<ContextMenuState | null>;
    setHoveredNodeId: StateSetter<string | null>;
    setToolbarNodeId: StateSetter<string | null>;
    setDialogNodeId: StateSetter<string | null>;
    setConnectingParams?: StateSetter<ConnectionHandle | null>;
    setConnectionTargetNodeId?: StateSetter<string | null>;
    setPendingConnectionCreate?: StateSetter<PendingConnectionCreate | null>;
    setMouseWorld?: StateSetter<Position>;
    setSelectionBox?: StateSetter<SelectionBox | null>;
    setCutConnectionState?: StateSetter<CutConnectionState | null>;
    setIsNodeDragging?: StateSetter<boolean>;
    pause: () => void;
    resume: () => void;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    createNode: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video, position: Position) => CanvasNodeData;
    createConnectionId?: () => string;
    onWarning?: (message: string) => void;
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (handle: number) => void;
};

export type CanvasInteractionController = {
    readonly connectingParams: ConnectionHandle | null;
    readonly connectionTargetNodeId: string | null;
    readonly pendingConnectionCreate: PendingConnectionCreate | null;
    readonly mouseWorld: Position;
    readonly selectionBox: SelectionBox | null;
    readonly cutConnectionState: CutConnectionState | null;
    readonly isNodeDragging: boolean;
    updateOptions: (options: CanvasInteractionControllerOptions) => void;
    handleCanvasMouseDown: (event: CanvasPointerEvent) => void;
    handleNodeMouseDown: (event: CanvasPointerEvent, nodeId: string) => void;
    handleConnectStart: (event: CanvasPointerEvent, nodeId: string, handleType: ConnectionHandle["handleType"]) => void;
    handleGlobalMouseMove: (event: CanvasPointerEvent) => void;
    handleGlobalPointerMove: (event: CanvasPointerEvent) => void;
    handleGlobalMouseUp: (event: CanvasPointerEvent) => void;
    handleGlobalPointerUp: (event: CanvasPointerEvent) => void;
    finishNodeDrag: (clientX?: number, clientY?: number) => void;
    finishCutConnection: () => boolean;
    createConnectedNode: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video, pending: PendingConnectionCreate) => void;
    cancelPendingConnectionCreate: () => void;
    clearCutConnectionState: () => void;
    resetInteractionState: () => void;
    dispose: () => void;
};

const initialDragState = () => ({
    isDraggingNode: false,
    hasMoved: false,
    startX: 0,
    startY: 0,
    initialSelectedNodes: [] as { id: string; x: number; y: number }[],
});

function defaultRequestFrame(callback: FrameRequestCallback) {
    return window.requestAnimationFrame(callback);
}

function defaultCancelFrame(handle: number) {
    window.cancelAnimationFrame(handle);
}

export function createCanvasInteractionController(initialOptions: CanvasInteractionControllerOptions): CanvasInteractionController {
    let options = initialOptions;
    let connectingParams: ConnectionHandle | null = null;
    let connectionTargetNodeId: string | null = null;
    let pendingConnectionCreate: PendingConnectionCreate | null = null;
    let mouseWorld: Position = { x: 0, y: 0 };
    let selectionBox: SelectionBox | null = null;
    let cutConnectionState: CutConnectionState | null = null;
    let isNodeDragging = false;
    let animationFrame: number | null = null;
    const drag = initialDragState();
    const dragPerf = { startedAt: 0, frameCount: 0, movedNodeCount: 0 };
    const cutPerf = { startedAt: 0, moveCount: 0, scannedConnections: 0 };

    const setConnecting = (next: ConnectionHandle | null) => {
        connectingParams = next;
        options.setConnectingParams?.(next);
        if (!next) {
            connectionTargetNodeId = null;
            options.setConnectionTargetNodeId?.(null);
        }
    };

    const setConnectionTarget = (next: string | null) => {
        connectionTargetNodeId = next;
        options.setConnectionTargetNodeId?.(next);
    };

    const setPending = (next: PendingConnectionCreate | null) => {
        pendingConnectionCreate = next;
        options.setPendingConnectionCreate?.(next);
    };

    const setMouse = (next: Position) => {
        mouseWorld = next;
        options.setMouseWorld?.(next);
    };

    const setSelection = (next: SelectionBox | null) => {
        selectionBox = next;
        options.setSelectionBox?.(next);
    };

    const setCut = (next: CutConnectionState | null) => {
        cutConnectionState = next;
        options.setCutConnectionState?.(next);
    };

    const setDragging = (next: boolean) => {
        isNodeDragging = next;
        options.setIsNodeDragging?.(next);
    };

    const clearCutConnectionState = () => {
        setCut(null);
    };

    const cancelPendingConnectionCreate = () => {
        setPending(null);
        setConnecting(null);
    };

    const getConnectableNodeAtPoint = (clientX: number, clientY: number, current: ConnectionHandle) => {
        const world = options.screenToCanvas(clientX, clientY);
        return (
            [...options.nodesRef.current]
                .filter((node) => !isHiddenBatchChild(node, options.nodesRef.current))
                .reverse()
                .find(
                    (node) =>
                        node.id !== current.nodeId &&
                        Boolean(normalizeConnection(current.nodeId, node.id, options.nodesRef.current, current.handleType)) &&
                        world.x >= node.position.x &&
                        world.x <= node.position.x + node.width &&
                        world.y >= node.position.y &&
                        world.y <= node.position.y + node.height,
                )?.id || null
        );
    };

    const connectNodes = (current: ConnectionHandle, targetNodeId: string) => {
        if (current.nodeId === targetNodeId) return;
        const connection = normalizeConnection(current.nodeId, targetNodeId, options.nodesRef.current, current.handleType);
        if (!connection) {
            options.onWarning?.("配置节点之间不能连接");
            return;
        }
        const exists = options.connectionsRef.current.some((item) => item.fromNodeId === connection.fromNodeId && item.toNodeId === connection.toNodeId);
        if (!exists) {
            options.setConnections((previous) => [...previous, { id: options.createConnectionId?.() || `conn-${Date.now()}`, ...connection }]);
        }
        options.setContextMenu(null);
    };

    const createConnectedNode = (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video, pending: PendingConnectionCreate) => {
        const newNode = options.createNode(type, pending.position);
        const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...options.nodesRef.current, newNode], pending.connection.handleType);
        if (!connection) {
            options.onWarning?.("配置节点之间不能连接");
            return;
        }
        options.setNodes((previous) => [...previous, newNode]);
        options.setConnections((previous) => [...previous, { id: options.createConnectionId?.() || `conn-${Date.now()}`, ...connection }]);
        options.setSelectedNodeIds(new Set([newNode.id]));
        options.setSelectedConnectionId(null);
        if (type !== CanvasNodeType.Text) options.setDialogNodeId(newNode.id);
        cancelPendingConnectionCreate();
    };

    const handleCanvasMouseDown = (event: CanvasPointerEvent) => {
        options.setContextMenu(null);
        if (pendingConnectionCreate) cancelPendingConnectionCreate();
        if (event.button !== 0) return;

        const world = options.screenToCanvas(event.clientX, event.clientY);
        if (event.ctrlKey) {
            const next = { points: [world], connectionIds: new Set<string>() };
            if (isCanvasPerfDebugEnabled()) {
                cutPerf.startedAt = performance.now();
                cutPerf.moveCount = 0;
                cutPerf.scannedConnections = 0;
                logCanvasPerf("cut start", { nodes: options.nodesRef.current.length, connections: options.connectionsRef.current.length });
            }
            setCut(next);
            options.setSelectedNodeIds(new Set());
            options.setSelectedConnectionId(null);
            options.setDialogNodeId(null);
            return;
        }

        const next = {
            startWorldX: world.x,
            startWorldY: world.y,
            currentWorldX: world.x,
            currentWorldY: world.y,
            additive: Boolean(event.shiftKey),
            initialSelectedNodeIds: event.shiftKey ? Array.from(options.selectedNodeIdsRef.current) : [],
        };
        setSelection(next);
        if (!event.shiftKey) options.setSelectedNodeIds(new Set());
        options.setSelectedConnectionId(null);
        options.setDialogNodeId(null);
    };

    const handleNodeMouseDown = (event: CanvasPointerEvent, nodeId: string) => {
        event.stopPropagation?.();
        options.setContextMenu(null);
        options.setHoveredNodeId(null);
        options.setToolbarNodeId(null);
        options.setSelectedConnectionId(null);

        const nextSelected = new Set(options.selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }

        options.setSelectedNodeIds(nextSelected);
        const dragIds = new Set(nextSelected);
        options.nodesRef.current.forEach((node) => {
            if (nextSelected.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
        });
        drag.isDraggingNode = true;
        drag.hasMoved = false;
        drag.startX = event.clientX;
        drag.startY = event.clientY;
        drag.initialSelectedNodes = options.nodesRef.current.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y }));
        if (isCanvasPerfDebugEnabled()) {
            dragPerf.startedAt = performance.now();
            dragPerf.frameCount = 0;
            dragPerf.movedNodeCount = drag.initialSelectedNodes.length;
            logCanvasPerf("drag start", { selectedNodes: nextSelected.size, movedNodes: dragPerf.movedNodeCount });
        }
        options.pause();
        setDragging(true);
    };

    const finishNodeDrag = (clientX?: number, clientY?: number) => {
        if (animationFrame !== null) {
            (options.cancelAnimationFrame || defaultCancelFrame)(animationFrame);
            animationFrame = null;
        }
        if (!drag.isDraggingNode) return;

        const wasClick = !drag.hasMoved && drag.initialSelectedNodes.length === 1;
        const clickedNodeId = drag.initialSelectedNodes[0]?.id;
        const dx = clientX == null ? 0 : (clientX - drag.startX) / options.viewportRef.current.k;
        const dy = clientY == null ? 0 : (clientY - drag.startY) / options.viewportRef.current.k;
        const initialPositions = drag.initialSelectedNodes;

        if (drag.hasMoved && clientX != null && clientY != null) {
            options.setNodes((previous) =>
                previous.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                }),
            );
        }
        options.resume();
        setDragging(false);

        drag.isDraggingNode = false;
        drag.hasMoved = false;
        drag.initialSelectedNodes = [];
        if (dragPerf.startedAt) {
            logCanvasPerf("drag end", {
                durationMs: Math.round(performance.now() - dragPerf.startedAt),
                frameCount: dragPerf.frameCount,
                movedNodeCount: dragPerf.movedNodeCount,
                committed: !wasClick,
            });
            dragPerf.startedAt = 0;
            dragPerf.frameCount = 0;
            dragPerf.movedNodeCount = 0;
        }
        if (wasClick && clickedNodeId) {
            const clickedNode = options.nodesRef.current.find((node) => node.id === clickedNodeId);
            if (clickedNode?.type === CanvasNodeType.Text) options.setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            else options.setDialogNodeId(clickedNodeId);
        }
    };

    const handleGlobalMouseMove = (event: CanvasPointerEvent) => {
        if (drag.isDraggingNode) {
            const dx = (event.clientX - drag.startX) / options.viewportRef.current.k;
            const dy = (event.clientY - drag.startY) / options.viewportRef.current.k;
            const initialPositions = drag.initialSelectedNodes;
            if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) drag.hasMoved = true;
            if (dragPerf.startedAt) {
                dragPerf.frameCount += 1;
                if (dragPerf.frameCount <= 3 || dragPerf.frameCount % 30 === 0) logCanvasPerf("drag move", { frameCount: dragPerf.frameCount, movedNodeCount: dragPerf.movedNodeCount, dx: Math.round(dx), dy: Math.round(dy) });
            }
            if (animationFrame !== null) (options.cancelAnimationFrame || defaultCancelFrame)(animationFrame);
            animationFrame = (options.requestAnimationFrame || defaultRequestFrame)(() => {
                options.setNodes((previous) =>
                    previous.map((node) => {
                        const initial = initialPositions.find((item) => item.id === node.id);
                        return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                    }),
                );
                animationFrame = null;
            });
            return;
        }
        if (connectingParams && !pendingConnectionCreate) {
            setConnectionTarget(getConnectableNodeAtPoint(event.clientX, event.clientY, connectingParams));
            setMouse(options.screenToCanvas(event.clientX, event.clientY));
        }
    };

    const handleGlobalPointerMove = (event: CanvasPointerEvent) => {
        if (cutConnectionState) {
            if (event.buttons === 0) return;
            const world = options.screenToCanvas(event.clientX, event.clientY);
            const lastPoint = cutConnectionState.points[cutConnectionState.points.length - 1];
            const minDistance = Math.max(4, 12 / options.viewportRef.current.k);
            if (lastPoint && distanceBetweenPoints(lastPoint, world) < minDistance) return;
            const nextPoints = [...cutConnectionState.points, world];
            const nextConnectionIds = new Set(cutConnectionState.connectionIds);
            const previousPoint = nextPoints[nextPoints.length - 2];
            let scannedConnections = 0;
            if (previousPoint) {
                const threshold = Math.max(6, Math.min(20, 12 / options.viewportRef.current.k));
                options.connectionsRef.current.forEach((connection) => {
                    scannedConnections += 1;
                    if (nextConnectionIds.has(connection.id)) return;
                    const from = options.nodesRef.current.find((node) => node.id === connection.fromNodeId);
                    const to = options.nodesRef.current.find((node) => node.id === connection.toNodeId);
                    if (!from || !to || isHiddenBatchConnectionEndpoint(from, options.nodesRef.current) || isHiddenBatchConnectionEndpoint(to, options.nodesRef.current)) return;
                    if (segmentHitsConnection(previousPoint, world, from, to, threshold)) nextConnectionIds.add(connection.id);
                });
            }
            if (cutPerf.startedAt) {
                cutPerf.moveCount += 1;
                cutPerf.scannedConnections += scannedConnections;
                if (cutPerf.moveCount <= 3 || cutPerf.moveCount % 12 === 0)
                    logCanvasPerf("cut move", { moveCount: cutPerf.moveCount, points: nextPoints.length, hitConnections: nextConnectionIds.size, scannedConnections, totalScannedConnections: cutPerf.scannedConnections });
            }
            setCut({ points: nextPoints, connectionIds: nextConnectionIds });
            return;
        }

        if (!selectionBox) return;
        if (event.buttons === 0) {
            setSelection(null);
            return;
        }
        const world = options.screenToCanvas(event.clientX, event.clientY);
        const rectX = Math.min(selectionBox.startWorldX, world.x);
        const rectY = Math.min(selectionBox.startWorldY, world.y);
        const rectW = Math.abs(world.x - selectionBox.startWorldX);
        const rectH = Math.abs(world.y - selectionBox.startWorldY);
        const nextSelected = new Set<string>(selectionBox.additive ? selectionBox.initialSelectedNodeIds : []);
        options.nodesRef.current
            .filter((node) => !isHiddenBatchChild(node, options.nodesRef.current))
            .forEach((node) => {
                const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;
                if (intersects) nextSelected.add(node.id);
            });
        setSelection({ ...selectionBox, currentWorldX: world.x, currentWorldY: world.y });
        options.setSelectedNodeIds(nextSelected);
    };

    const finishCutConnection = () => {
        if (!cutConnectionState) return false;
        const removedConnectionIds = new Set(cutConnectionState.connectionIds);
        if (cutPerf.startedAt) {
            logCanvasPerf("cut end", { durationMs: Math.round(performance.now() - cutPerf.startedAt), moveCount: cutPerf.moveCount, hitConnections: cutConnectionState.connectionIds.size, scannedConnections: cutPerf.scannedConnections });
            cutPerf.startedAt = 0;
            cutPerf.moveCount = 0;
            cutPerf.scannedConnections = 0;
        }
        if (removedConnectionIds.size) {
            options.setConnections((previous) => previous.filter((connection) => !removedConnectionIds.has(connection.id)));
            options.setSelectedConnectionId((current) => (current && removedConnectionIds.has(current) ? null : current));
        }
        clearCutConnectionState();
        return true;
    };

    const handleGlobalMouseUp = (event: CanvasPointerEvent) => {
        if (finishCutConnection()) return;
        finishNodeDrag(event.clientX, event.clientY);
        setSelection(null);
        if (pendingConnectionCreate) return;
        if (!connectingParams) return;
        const targetNodeId = getConnectableNodeAtPoint(event.clientX, event.clientY, connectingParams) || connectionTargetNodeId;
        if (targetNodeId) {
            connectNodes(connectingParams, targetNodeId);
            setConnecting(null);
            return;
        }
        const position = options.screenToCanvas(event.clientX, event.clientY);
        setMouse(position);
        setPending({ connection: connectingParams, position });
    };

    const handleGlobalPointerUp = (event: CanvasPointerEvent) => {
        handleGlobalMouseUp(event);
    };

    const handleConnectStart = (event: CanvasPointerEvent, nodeId: string, handleType: ConnectionHandle["handleType"]) => {
        event.stopPropagation?.();
        setMouse(options.screenToCanvas(event.clientX, event.clientY));
        setConnecting({ nodeId, handleType });
        setConnectionTarget(null);
        options.setSelectedConnectionId(null);
    };

    const resetInteractionState = () => {
        clearCutConnectionState();
        setSelection(null);
        cancelPendingConnectionCreate();
    };

    const dispose = () => {
        if (animationFrame !== null) {
            (options.cancelAnimationFrame || defaultCancelFrame)(animationFrame);
            animationFrame = null;
        }
        drag.isDraggingNode = false;
        drag.hasMoved = false;
        drag.initialSelectedNodes = [];
        isNodeDragging = false;
        connectingParams = null;
        connectionTargetNodeId = null;
        pendingConnectionCreate = null;
        selectionBox = null;
        cutConnectionState = null;
    };

    return {
        get connectingParams() {
            return connectingParams;
        },
        get connectionTargetNodeId() {
            return connectionTargetNodeId;
        },
        get pendingConnectionCreate() {
            return pendingConnectionCreate;
        },
        get mouseWorld() {
            return mouseWorld;
        },
        get selectionBox() {
            return selectionBox;
        },
        get cutConnectionState() {
            return cutConnectionState;
        },
        get isNodeDragging() {
            return isNodeDragging;
        },
        updateOptions(next) {
            options = next;
        },
        handleCanvasMouseDown,
        handleNodeMouseDown,
        handleConnectStart,
        handleGlobalMouseMove,
        handleGlobalPointerMove,
        handleGlobalMouseUp,
        handleGlobalPointerUp,
        finishNodeDrag,
        finishCutConnection,
        createConnectedNode,
        cancelPendingConnectionCreate,
        clearCutConnectionState,
        resetInteractionState,
        dispose,
    };
}

export type UseCanvasInteractionsOptions = Omit<CanvasInteractionControllerOptions, "setConnectingParams" | "setConnectionTargetNodeId" | "setPendingConnectionCreate" | "setMouseWorld" | "setSelectionBox" | "setCutConnectionState" | "setIsNodeDragging">;

export function useCanvasInteractions(options: UseCanvasInteractionsOptions) {
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [cutConnectionState, setCutConnectionState] = useState<CutConnectionState | null>(null);
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const controllerRef = useRef<CanvasInteractionController | null>(null);

    const controllerOptions: CanvasInteractionControllerOptions = {
        ...options,
        setConnectingParams,
        setConnectionTargetNodeId,
        setPendingConnectionCreate,
        setMouseWorld,
        setSelectionBox,
        setCutConnectionState,
        setIsNodeDragging,
    };

    if (!controllerRef.current) controllerRef.current = createCanvasInteractionController(controllerOptions);
    else controllerRef.current.updateOptions(controllerOptions);
    const controller = controllerRef.current;

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => {
            controller.handleGlobalPointerUp(event);
        };
        const cancelNodeDrag = () => controller.finishNodeDrag();
        window.addEventListener("mousemove", controller.handleGlobalMouseMove);
        window.addEventListener("mouseup", controller.handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", controller.handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", controller.handleGlobalMouseMove);
            window.removeEventListener("mouseup", controller.handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", controller.handleGlobalPointerMove);
            controller.dispose();
        };
    }, [controller]);

    return {
        connectingParams,
        connectionTargetNodeId,
        pendingConnectionCreate,
        mouseWorld,
        selectionBox,
        cutConnectionState,
        isNodeDragging,
        handleCanvasMouseDown: controller.handleCanvasMouseDown,
        handleNodeMouseDown: controller.handleNodeMouseDown,
        handleConnectStart: controller.handleConnectStart,
        handleGlobalMouseMove: controller.handleGlobalMouseMove,
        handleGlobalPointerMove: controller.handleGlobalPointerMove,
        handleGlobalMouseUp: controller.handleGlobalMouseUp,
        finishNodeDrag: controller.finishNodeDrag,
        finishCutConnection: controller.finishCutConnection,
        createConnectedNode: controller.createConnectedNode,
        cancelPendingConnectionCreate: controller.cancelPendingConnectionCreate,
        clearCutConnectionState: controller.clearCutConnectionState,
        resetInteractionState: controller.resetInteractionState,
    };
}
