"use client";

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { ImageIcon, Images, List, Menu, Plus, Redo2, Settings2, Trash2, Undo2, Upload, Video } from "lucide-react";
import { saveAs } from "file-saver";

import { getImageGenerationTask, getImageGenerationTaskByClientRequest, requestEdit, requestGeneration, requestImageQuestion, uploadUserImage } from "@/services/api/image";
import { fetchPublicImageAccess } from "@/services/api/public-images";
import { requestVideoGeneration } from "@/services/api/video";
import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { loadMediaImage, mediaIdFromImageStorageKey, releaseImageObjectURL, resolveImageUrl, resolveRemoteImage, uploadImage, type UploadedImage } from "@/services/image-storage";
import { hydrateCanvasImages, imageMetadata } from "@/services/canvas-image-hydration";
import { resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { getDataUrlByteSize } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { appPath } from "@/lib/app-path";
import { normalizeImageResolution } from "@/lib/image-generation-config";
import { type ImageAsset, useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl } from "../utils/canvas-image-data";
import { getInputSummary, resetInterruptedGeneration, snapshotConfigNodeProviderSelection } from "../utils/canvas-generation-utils";
import { isHiddenBatchChild, isHiddenBatchConnectionEndpoint } from "../utils/canvas-graph-utils";
import { selectedDownloadableImageNodes } from "../utils/canvas-download-utils";
import { fitNodeSize, nodeSizeFromRatio } from "../utils/canvas-node-size";
import { App, Button, Dropdown, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "../constants";
import { ActiveConnectionPath, ConnectionPath } from "../components/canvas-connections";
import { CanvasConfigNodePanel } from "../components/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "../components/canvas-context-menu";
import { CanvasNodeAngleDialog } from "../components/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "../components/canvas-node-crop-dialog";
import { buildNodeChatMessages, buildNodeGenerationContext, buildNodeGenerationInputs, hydrateNodeGenerationContext, type NodeGenerationInput } from "../components/canvas-node-generation";
import { CanvasNodeHoverToolbar } from "../components/canvas-node-hover-toolbar";
import { InfiniteCanvas } from "../components/infinite-canvas";
import { Minimap } from "../components/canvas-mini-map";
import { CanvasNode } from "../components/canvas-node";
import { CanvasNodePromptPanel } from "../components/canvas-node-prompt-panel";
import { CanvasToolbar } from "../components/canvas-toolbar";
import { CanvasZoomControls } from "../components/canvas-zoom-controls";
import { CanvasImageMaskDialog } from "../image-mask/canvas-image-mask-dialog";
import { PRIVATE_IMAGE_DRAG_TYPE, PUBLIC_IMAGE_DRAG_TYPE, readImageDropPayload, type PrivateImageDropPayload, type PublicImageDropPayload } from "../components/material-image-drag";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasHistory } from "../hooks/use-canvas-history";
import { useCanvasInteractions, type PendingConnectionCreate } from "../hooks/use-canvas-interactions";
import { useCanvasGeneration } from "../hooks/use-canvas-generation";
import { logCanvasPerf, useCanvasPerfDebugRegistration, useCanvasPerfRender } from "../utils/canvas-performance-debug";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type ContextMenuState, type Position, type ViewportTransform } from "../types";

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type ConfigInputBadge = {
    kind: "image" | "text";
    index: number;
    configNodeId: string;
    label: string;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const CANVAS_MEDIA_PREFETCH_PADDING = 280;

function isCanvasNodeNearViewport(node: CanvasNodeData, viewport: ViewportTransform, viewportSize: { width: number; height: number }) {
    const viewLeft = -viewport.x / viewport.k - CANVAS_MEDIA_PREFETCH_PADDING;
    const viewTop = -viewport.y / viewport.k - CANVAS_MEDIA_PREFETCH_PADDING;
    const viewRight = viewLeft + viewportSize.width / viewport.k + CANVAS_MEDIA_PREFETCH_PADDING * 2;
    const viewBottom = viewTop + viewportSize.height / viewport.k + CANVAS_MEDIA_PREFETCH_PADDING * 2;
    return node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom;
}

function canHydrateCanvasImage(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Image) return false;
    const metadata = node.metadata;
    return Boolean(metadata?.mediaId || metadata?.storageKey || metadata?.content?.startsWith("data:image/"));
}

function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function CanvasRefreshShell() {
    return (
        <main className="relative h-full min-h-0 overflow-hidden bg-background text-foreground">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                    backgroundSize: "28px 28px",
                }}
            />

            <div className="absolute bottom-5 left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div className="absolute bottom-24 left-6 z-50 h-40 w-[240px] rounded-lg border shadow-2xl backdrop-blur-sm" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div className="absolute bottom-5 left-5 z-50 flex h-14 w-[260px] items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}

function ConnectionCreateMenu({ pending, onCreate, onClose }: { pending: PendingConnectionCreate; onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: pending.position.x, top: pending.position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    引用该节点生成
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label="关闭">
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title="文本生成" description="脚本、广告词、品牌文案" onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title="图片生成" onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title="视频生成" onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title="配置节点" description="模型、尺寸、数量和输入顺序" onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? (
                    <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

function InfiniteCanvasPage() {
    const { message } = App.useApp();
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const projectId = params.id;
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const didInitialCenterRef = useRef(false);
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCanvasImageHydrationIdsRef = useRef<Set<string>>(new Set());
    const renderedCanvasImageStorageByIdRef = useRef<Map<string, string>>(new Map());

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
	const aiStatus = useConfigStore((state) => state.status);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    useCanvasPerfDebugRegistration();
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [maskNodeId, setMaskNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [collapsingBatchIds, setCollapsingBatchIds] = useState<Set<string>>(new Set());
    const [openingBatchIds, setOpeningBatchIds] = useState<Set<string>>(new Set());

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const deferredMiniMapNodes = useDeferredValue(nodes);
    const canvasImageHydrationDependencies = useMemo(
        () => ({
            resolveMediaUrl,
            readCachedImage: (storageKey: string) => resolveImageUrl(storageKey, ""),
            resolveRemoteImage,
            fetchPublicImageAccess,
            loadMediaImage,
            uploadImage,
        }),
        [],
    );

    const resolveStoredImageReference = useCallback(async (storageKey: string) => {
        const cached = await resolveImageUrl(storageKey, "");
        if (cached) return cached;
        const mediaId = mediaIdFromImageStorageKey(storageKey);
        if (!mediaId) return "";
        return (await loadMediaImage(mediaId, async () => resolveRemoteImage(mediaId))).url;
    }, []);

    const historySnapshot = useMemo<CanvasHistoryEntry>(() => ({ nodes, connections, backgroundMode, showImageInfo }), [backgroundMode, connections, nodes, showImageInfo]);

    const applyHistorySnapshot = useCallback((entry: CanvasHistoryEntry) => {
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
    }, []);

    const { canUndo, canRedo, undo, redo, pause, resume, replaceBaseline, getRetainedHistory, isPausedRef, isApplyingRef } = useCanvasHistory({
        snapshot: historySnapshot,
        applySnapshot: applyHistorySnapshot,
        isReady: projectLoaded,
        isSameSnapshot: (left, right) => left.nodes === right.nodes && left.connections === right.connections && left.backgroundMode === right.backgroundMode && left.showImageInfo === right.showImageInfo,
    });

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            const { history, lastHistory } = getRetainedHistory();
            cleanupAssetImages({ extra, history, lastHistory });
        },
        [cleanupAssetImages, getRetainedHistory],
    );

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) {
            router.replace(appPath("/canvas"));
            return;
        }

        const restore = async () => {
            const initialNodes = resetInterruptedGeneration(project.nodes);
            const rect = containerRef.current?.getBoundingClientRect();
            const initialViewportSize = { width: rect?.width || 1200, height: rect?.height || 720 };
            const shouldHydrate = (node: CanvasNodeData) => canHydrateCanvasImage(node) && isCanvasNodeNearViewport(node, project.viewport, initialViewportSize);
            pendingCanvasImageHydrationIdsRef.current = new Set(initialNodes.filter(canHydrateCanvasImage).map((node) => node.id));
            const restoredNodes = await hydrateCanvasImages(initialNodes, canvasImageHydrationDependencies, { shouldHydrate });
            restoredNodes.filter(shouldHydrate).forEach((node) => pendingCanvasImageHydrationIdsRef.current.delete(node.id));
            setNodes(restoredNodes);
            setConnections(project.connections);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            replaceBaseline({
                nodes: restoredNodes,
                connections: project.connections,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            });
            setProjectLoaded(true);
        };
        void restore();
    }, [canvasImageHydrationDependencies, hydrated, openProject, projectId, replaceBaseline, router]);

    useEffect(() => {
        if (!projectLoaded || isPausedRef.current || isApplyingRef.current) return;
        updateProject(projectId, { nodes, connections, backgroundMode, showImageInfo });
    }, [backgroundMode, connections, isApplyingRef, isPausedRef, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

	useEffect(() => {
		if (!projectLoaded || !aiStatus) return;
		setNodes((current) => snapshotConfigNodeProviderSelection(current, effectiveConfig));
	}, [aiStatus, effectiveConfig, projectLoaded]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
    }, [nodes, connections, selectedNodeIds, viewport]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const createInteractionNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video, position: Position) => {
            const metadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          resolution: effectiveConfig.imageProviderType ? effectiveConfig.resolution : normalizeImageResolution(effectiveConfig.resolution),
                          outputFormat: effectiveConfig.outputFormat,
                          background: effectiveConfig.background,
						  imageProviderId: effectiveConfig.imageProviderId,
						  videoProviderId: effectiveConfig.videoProviderId,
                          imageProviderType: effectiveConfig.imageProviderType,
                          imageRequestSchemaVersion: effectiveConfig.imageRequestSchemaVersion,
                          providerOptions: effectiveConfig.providerOptions,
                          count: Number(effectiveConfig.count) || 1,
                      }
                    : undefined;
            return createCanvasNode(type, position, metadata);
        },
        [effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.resolution, effectiveConfig.size],
    );

    const {
        connectingParams,
        connectionTargetNodeId,
        pendingConnectionCreate,
        mouseWorld,
        selectionBox,
        cutConnectionState,
        isNodeDragging,
        handleCanvasMouseDown,
        handleNodeMouseDown,
        handleConnectStart,
        createConnectedNode,
        cancelPendingConnectionCreate,
        resetInteractionState,
    } = useCanvasInteractions({
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setHoveredNodeId,
        setToolbarNodeId,
        setDialogNodeId,
        pause,
        resume,
        screenToCanvas,
        createNode: createInteractionNode,
        createConnectionId: nanoid,
        onWarning: message.warning,
    });

    const {
        runningNodeId,
        generateNode: handleGenerateNode,
        retryNode: handleRetryNode,
        generateImageFromTextNode,
        generateAngleNode,
        resumePendingImageTasks,
        clearRunningNode,
    } = useCanvasGeneration({
        nodesRef,
        connectionsRef,
        effectiveConfig,
        defaultConfig,
        isAiConfigReady,
        openConfigDialog,
        message,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setAngleNodeId,
        createId: nanoid,
        createConfigNode: (position, metadata) => createCanvasNode(CanvasNodeType.Config, position, metadata),
        requestGeneration,
        requestEdit,
        getImageTask: getImageGenerationTask,
        getImageTaskByClientRequest: getImageGenerationTaskByClientRequest,
        requestImageQuestion,
        requestVideoGeneration,
        uploadImage,
        uploadMediaFile,
        hydrateGenerationContext: (nodeId, prompt) => hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, prompt)),
        buildChatMessages: buildNodeChatMessages,
        resolveImageUrl,
        resolveStoredImageReference,
    });

    useEffect(() => {
        if (!projectLoaded) return;
        resumePendingImageTasks();
    }, [projectLoaded, resumePendingImageTasks]);

    useCanvasPerfRender("InfiniteCanvasPage", () => ({
        nodes: nodes.length,
        connections: connections.length,
        selectedNodes: selectedNodeIds.size,
        hasSelectionBox: Boolean(selectionBox),
        isCutting: Boolean(cutConnectionState),
    }));

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (isNodeDragging || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [isNodeDragging, nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const visibleNodes = useMemo(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        return nodes.filter((node) => !isHiddenBatchChild(node, nodes, collapsingBatchIds) && isCanvasNodeNearViewport(node, viewport, { width, height }));
    }, [collapsingBatchIds, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    useEffect(() => {
        if (!projectLoaded) return;
        const candidates = visibleNodes.filter((node) => pendingCanvasImageHydrationIdsRef.current.has(node.id));
        if (!candidates.length) return;
        candidates.forEach((node) => pendingCanvasImageHydrationIdsRef.current.delete(node.id));

        void hydrateCanvasImages(candidates, canvasImageHydrationDependencies).then((restoredNodes) => {
            const restoredById = new Map(restoredNodes.map((node) => [node.id, node]));
            pause();
            setNodes((current) => current.map((node) => restoredById.get(node.id) || node));
            window.requestAnimationFrame(() => resume());
        });
    }, [canvasImageHydrationDependencies, pause, projectLoaded, resume, visibleNodes]);

    useEffect(() => {
        const nextStorageById = new Map(visibleNodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.storageKey).map((node) => [node.id, node.metadata!.storageKey!] as const));
        const visibleStorageKeys = new Set(nextStorageById.values());
        renderedCanvasImageStorageByIdRef.current.forEach((storageKey, nodeId) => {
            if (nextStorageById.has(nodeId) || visibleStorageKeys.has(storageKey)) return;
            releaseImageObjectURL(storageKey);
            pendingCanvasImageHydrationIdsRef.current.add(nodeId);
        });
        renderedCanvasImageStorageByIdRef.current = nextStorageById;
    }, [visibleNodes]);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const visibleConnections = useMemo(
        () =>
            connections.filter((connection) => {
                const from = nodeById.get(connection.fromNodeId);
                const to = nodeById.get(connection.toNodeId);
                return Boolean(from && to && !isHiddenBatchConnectionEndpoint(from, nodes) && !isHiddenBatchConnectionEndpoint(to, nodes));
            }),
        [connections, nodeById, nodes],
    );
    const loadingNodeCount = useMemo(() => nodes.filter((node) => node.metadata?.status === NODE_STATUS_LOADING).length, [nodes]);
    const toolbarNode = toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null;
    const maskNode = maskNodeId ? nodeById.get(maskNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
	const contextMenuImageNodes = useMemo(() => {
		if (!contextMenu) return [];
		const ids = selectedNodeIds.has(contextMenu.nodeId) ? selectedNodeIds : new Set([contextMenu.nodeId]);
		return selectedDownloadableImageNodes(nodes, ids);
	}, [contextMenu, nodes, selectedNodeIds]);
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const batchChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            if (node.metadata?.isBatchRoot) map.set(node.id, node.metadata.batchChildIds?.length || 0);
        });
        return map;
    }, [nodes]);
    const batchMotionById = useMemo(() => {
        const map = new Map<string, { x: number; y: number; index: number }>();
        nodes.forEach((node) => {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return;
            const root = nodeById.get(rootId);
            const index = root?.metadata?.batchChildIds?.indexOf(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            map.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        });
        return map;
    }, [nodeById, nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);
    const focusedConfigNodeId = useMemo(() => {
        const dialogNode = dialogNodeId ? nodeById.get(dialogNodeId) : null;
        if (dialogNode?.type === CanvasNodeType.Config) return dialogNode.id;
        const activeNode = activeNodeId ? nodeById.get(activeNodeId) : null;
        if (activeNode?.type === CanvasNodeType.Config) return activeNode.id;
        return null;
    }, [activeNodeId, dialogNodeId, nodeById]);

    const generationInputNodeSignature = useMemo(
        () =>
            nodes
                .map((node) => {
                    const contentKey = node.type === CanvasNodeType.Image ? node.metadata?.storageKey || `inline:${node.metadata?.content?.length || 0}` : node.metadata?.content || node.metadata?.prompt || "";
                    return [node.id, node.type, node.title, contentKey, node.metadata?.mimeType || "", (node.metadata?.inputOrder || []).join(",")].join("::");
                })
                .join("|"),
        [nodes],
    );
    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, generationInputNodeSignature, nodes]);
    const focusedConfigInputBadges = useMemo(() => {
        const map = new Map<string, ConfigInputBadge>();
        if (!focusedConfigNodeId) return map;
        const inputs = configInputsById.get(focusedConfigNodeId) || [];
        let imageIndex = 0;
        let textIndex = 0;
        inputs.forEach((input) => {
            if (input.type === "image") {
                imageIndex += 1;
                map.set(input.nodeId, { kind: "image", index: imageIndex, configNodeId: focusedConfigNodeId, label: `图 ${imageIndex}` });
                return;
            }
            if (input.type === "text") {
                textIndex += 1;
                map.set(input.nodeId, { kind: "text", index: textIndex, configNodeId: focusedConfigNodeId, label: `文本 ${textIndex}` });
            }
        });
        return map;
    }, [configInputsById, focusedConfigNodeId]);
    const configInputPanelMetaById = useMemo(() => {
        const map = new Map<string, { summary: { textCount: number; imageCount: number }; version: string }>();
        configInputsById.forEach((inputs, nodeId) => {
            const summary = getInputSummary(inputs);
            const version = inputs
                .map((input) => (input.type === "image" ? `image:${input.nodeId}:${input.title}:${input.image?.storageKey || `inline:${input.image?.dataUrl?.length || 0}`}` : `text:${input.nodeId}:${input.title}:${input.text || ""}`))
                .join("|");
            map.set(nodeId, { summary, version });
        });
        return map;
    }, [configInputsById]);

    useEffect(() => {
        logCanvasPerf("graph snapshot", {
            totalNodes: nodes.length,
            visibleNodes: visibleNodes.length,
            totalConnections: connections.length,
            visibleConnections: visibleConnections.length,
            loadingNodes: loadingNodeCount,
            miniMapOpen: isMiniMapOpen,
        });
    }, [connections.length, isMiniMapOpen, loadingNodeCount, nodes.length, visibleConnections.length, visibleNodes.length]);

    useEffect(() => {
        logCanvasPerf("generation status", {
            runningNodeId,
            loadingNodes: loadingNodeCount,
        });
    }, [loadingNodeCount, runningNodeId]);

    const createNode = useCallback(
        (type: CanvasNodeType, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const newNode = createInteractionNode(type, targetPosition);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text) setDialogNodeId(newNode.id);
        },
        [createInteractionNode, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                    if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                    const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                    const primaryNode = next.find((item) => item.id === primaryImageId);
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            batchChildIds: childIds,
                            primaryImageId,
                            content: primaryNode?.metadata?.content || node.metadata.content,
                            naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                            naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                        },
                    };
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            clearRunningNode(allIds);
            setContextMenu((current) => (current && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)) });
        },
        [cleanupCanvasFiles, projectId],
    );

    const deselectCanvas = useCallback(() => {
        resetInteractionState();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [resetInteractionState]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setMaskNodeId(null);
        setCropNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        clearRunningNode();
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...nextNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(nextNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(nextNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const createAndOpenProject = useCallback(() => {
        const id = createProject(`无限画布 ${useCanvasStore.getState().projects.length + 1}`);
        router.push(appPath(`/canvas/${id}`));
    }, [createProject, router]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        router.push(appPath("/canvas"));
    }, [cleanupAssetImages, deleteProjects, projectId, router]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const remote = await uploadUserImage(file, "canvas");
        const image = await uploadImage(file, remote.mediaId);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: { ...imageMetadata(image), mediaExpiresAt: remote.mediaExpiresAt },
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
        void useAssetStore.getState().refreshFromServer().catch(() => undefined);
    }, []);

    const createImageAssetNode = useCallback(async (asset: ImageAsset, position: Position) => {
        const mediaId = typeof asset.metadata?.mediaId === "string" ? asset.metadata.mediaId : "";
        const publicImageId = typeof asset.metadata?.publicImageId === "string" ? asset.metadata.publicImageId : "";
        let image: UploadedImage;
        if (mediaId) {
            image = await loadMediaImage(mediaId, async () => (publicImageId ? (await fetchPublicImageAccess(publicImageId)).url : resolveRemoteImage(mediaId)));
        } else {
            const content = await resolveImageUrl(asset.data.storageKey, "");
            if (!content) throw new Error("素材图片缓存不存在");
            image = {
                url: content,
                storageKey: asset.data.storageKey || "",
                width: asset.data.width,
                height: asset.data.height,
                bytes: asset.data.bytes,
                mimeType: asset.data.mimeType,
            };
        }
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: asset.title,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: { ...imageMetadata(image), assetId: asset.id, publicImageId: publicImageId || undefined, mediaExpiresAt: typeof asset.metadata?.expiresAt === "string" ? asset.metadata.expiresAt : undefined },
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createPublicImageNode = useCallback(async (payload: PublicImageDropPayload, position: Position) => {
        const dimensions = await loadMediaImage(payload.mediaId, async () => (await fetchPublicImageAccess(payload.id)).url);
        const size = fitNodeSize(dimensions.width, dimensions.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: payload.title,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: { ...imageMetadata(dimensions), publicImageId: payload.id },
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success("已从剪切板添加图片");
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success("已从剪切板添加文本");
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redo();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                resetInteractionState();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    setConnections((prev) => prev.filter((conn) => conn.id !== selectedConnectionId));
                    setSelectedConnectionId(null);
                }
            }

            if (event.key === "Escape") {
                resetInteractionState();
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setMaskNodeId(null);
                setCropNodeId(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteNodes, pasteCopiedNodes, pasteSystemClipboard, redo, resetInteractionState, selectedConnectionId, undo]);

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const saveNodeMask = useCallback((nodeId: string, imageMask: CanvasNodeMetadata["imageMask"]) => {
        setNodes((previous) => previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, imageMask } } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        if (isExpanded) {
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, []);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

	const downloadNodeImage = useCallback(
		async (node: CanvasNodeData) => {
			if (node.type === CanvasNodeType.Video) {
				if (!node.metadata?.content) throw new Error("没有可下载的视频");
				saveAs(node.metadata.content, `canvas-video-${node.id}.mp4`);
				return;
			}
			if (node.type !== CanvasNodeType.Image || !node.metadata) throw new Error("没有可下载的图片");
			let content = node.metadata.content || "";
			if (node.metadata.storageKey) content = (await resolveStoredImageReference(node.metadata.storageKey)) || content;
			if (!content && node.metadata.mediaId) content = (await loadMediaImage(node.metadata.mediaId, () => resolveRemoteImage(node.metadata!.mediaId!))).url;
			if (!content) throw new Error("图片尚未加载完成");
			saveAs(content, `canvas-image-${node.id}.${imageExtension(node.metadata.mimeType || content)}`);
		},
		[resolveStoredImageReference],
	);

	const downloadSelectedImages = useCallback(
		async (selectedImages: CanvasNodeData[]) => {
			const results = await Promise.allSettled(selectedImages.map((node) => downloadNodeImage(node)));
			const failed = results.filter((result) => result.status === "rejected").length;
			if (failed) message.error(`${failed} 张图片下载失败`);
			else message.success(`已开始下载 ${selectedImages.length} 张图片`);
		},
		[downloadNodeImage, message],
	);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error("没有可保存的文本");
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success("已加入我的素材");
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error("没有可保存的视频");
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布视频",
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success("已加入我的素材");
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: {
                    source: "canvas",
                    nodeId: node.id,
                    prompt: node.metadata?.prompt,
                    mediaId: node.metadata?.mediaId,
                    publicImageId: node.metadata?.publicImageId,
                    uploadState: node.metadata?.mediaId ? "uploaded" : undefined,
                },
            });
            message.success("已加入我的素材");
        },
        [addAsset, message],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            const target = uploadTargetRef.current;
            if (!file || (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) return;

            if (target?.nodeId) {
                if (file.type.startsWith("video/")) {
                    const video = await uploadMediaFile(file, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: file.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(target.nodeId);
                    uploadTargetRef.current = null;
                    event.target.value = "";
                    return;
                }
                const remote = await uploadUserImage(file, "canvas");
                const image = await uploadImage(file, remote.mediaId);
                const size = fitNodeSize(image.width, image.height);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === target.nodeId
                            ? {
                                  ...node,
                                  type: CanvasNodeType.Image,
                                  title: file.name,
                                  width: size.width,
                                  height: size.height,
                                  metadata: {
                                      ...node.metadata,
                                      ...imageMetadata(image),
                                      mediaExpiresAt: remote.mediaExpiresAt,
                                      errorDetails: undefined,
                                      freeResize: false,
                                      isBatchRoot: undefined,
                                      batchRootId: undefined,
                                      batchChildIds: undefined,
                                      batchUsesReferenceImages: undefined,
                                      generationType: undefined,
                                      model: undefined,
                                      size: undefined,
                                      quality: undefined,
                                      count: undefined,
                                      references: undefined,
                                      primaryImageId: undefined,
                                      imageBatchExpanded: undefined,
                                  },
                              }
                            : node,
                    ),
                );
                setSelectedNodeIds(new Set([target.nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(target.nodeId);
                void useAssetStore.getState().refreshFromServer().catch(() => undefined);
            } else {
                const position = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                void (file.type.startsWith("video/") ? createVideoFileNode(file, position) : createImageFileNode(file, position));
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const renderNodePromptPanel = useCallback(
        (panelNode: CanvasNodeData) => (
            <CanvasNodePromptPanel
                node={panelNode}
                isRunning={runningNodeId === panelNode.id}
                onPromptChange={handleNodePromptChange}
                onConfigChange={handleConfigNodeChange}
                onGenerate={handleGenerateNode}
                onImageSettingsOpenChange={(open) => {
                    setNodeImageSettingsOpen(open);
                    if (open) setToolbarNodeId(null);
                }}
            />
        ),
        [handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, runningNodeId],
    );

    const renderConfigNodeContent = useCallback(
        (contentNode: CanvasNodeData) => {
            const inputs = configInputsById.get(contentNode.id) || [];
            const panelMeta = configInputPanelMetaById.get(contentNode.id);
            return (
                <CanvasConfigNodePanel
                    node={contentNode}
                    inputSummary={panelMeta?.summary || getInputSummary(inputs)}
                    inputs={inputs}
                    onConfigChange={handleConfigNodeChange}
                    onTextInputChange={handleNodeContentChange}
                    onGenerate={(nodeId) => {
                        const target = nodesRef.current.find((item) => item.id === nodeId);
                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.prompt || "");
                    }}
                />
            );
        },
        [configInputPanelMetaById, configInputsById, handleConfigNodeChange, handleGenerateNode, handleNodeContentChange],
    );

    const handleCanvasNodeHoverStart = useCallback(
        (nodeId: string) => {
            if (isNodeDragging) return;
            setHoveredNodeId(nodeId);
            keepNodeToolbar(nodeId);
        },
        [isNodeDragging, keepNodeToolbar],
    );

    const handleCanvasNodeHoverEnd = useCallback(
        (nodeId: string) => {
            setHoveredNodeId((current) => (current === nodeId ? null : current));
            hideNodeToolbar();
        },
        [hideNodeToolbar],
    );

    const handleCanvasNodeRetry = useCallback(
        (node: CanvasNodeData) => {
            void handleRetryNode(node);
        },
        [handleRetryNode],
    );

    const handleCanvasNodeGenerateImage = useCallback(
        (node: CanvasNodeData) => {
            generateImageFromTextNode(node);
        },
        [generateImageFromTextNode],
    );

    const handleCanvasNodeContextMenu = useCallback((event: ReactMouseEvent, id: string) => {
        event.preventDefault();
        event.stopPropagation();
		setSelectedNodeIds((previous) => (previous.has(id) ? previous : new Set([id])));
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
    }, []);

    useEffect(() => {
        return useAssetStore.subscribe(({ assets }) => {
            const imageAssets = assets.filter((asset): asset is ImageAsset => asset.kind === "image");
            const imagesById = new Map(imageAssets.map((asset) => [asset.id, asset]));
            const imagesByMediaID = new Map(imageAssets.flatMap((asset) => (typeof asset.metadata?.mediaId === "string" ? [[asset.metadata.mediaId, asset] as const] : [])));
            setNodes((previous) => {
                let changed = false;
                const next = previous.map((node) => {
                    const assetId = node.metadata?.assetId;
                    const asset = assetId ? imagesById.get(assetId) : undefined;
                    const mediaAsset = !asset && typeof node.metadata?.mediaId === "string" ? imagesByMediaID.get(node.metadata.mediaId) : undefined;
                    if (!asset && mediaAsset) {
                        const mediaExpiresAt = typeof mediaAsset.metadata?.expiresAt === "string" ? mediaAsset.metadata.expiresAt : undefined;
                        if (node.metadata?.mediaExpiresAt === mediaExpiresAt) return node;
                        changed = true;
                        return { ...node, metadata: { ...node.metadata, mediaExpiresAt } };
                    }
                    const mediaId = asset?.metadata?.mediaId;
                    const mediaExpiresAt = typeof asset?.metadata?.expiresAt === "string" ? asset.metadata.expiresAt : undefined;
                    if (!asset || typeof mediaId !== "string" || (node.metadata?.mediaId === mediaId && node.metadata?.mediaExpiresAt === mediaExpiresAt)) return node;
                    changed = true;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            ...imageMetadata({
                                url: asset.coverUrl || asset.data.dataUrl,
                                storageKey: asset.data.storageKey || "",
                                width: asset.data.width,
                                height: asset.data.height,
                                bytes: asset.data.bytes,
                                mimeType: asset.data.mimeType,
                                mediaId,
                                mediaExpiresAt,
                            }),
                        },
                    };
                });
                return changed ? next : previous;
            });
        });
    }, []);

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const position = screenToCanvas(event.clientX, event.clientY);
            const privatePayload = readImageDropPayload<PrivateImageDropPayload>(event.dataTransfer.getData(PRIVATE_IMAGE_DRAG_TYPE));
            if (privatePayload?.assetId) {
                const asset = useAssetStore.getState().assets.find((item): item is ImageAsset => item.id === privatePayload.assetId && item.kind === "image");
                if (asset) void createImageAssetNode(asset, position).catch((error) => message.error(error instanceof Error ? error.message : "素材插入失败"));
                return;
            }
            const publicPayload = readImageDropPayload<PublicImageDropPayload>(event.dataTransfer.getData(PUBLIC_IMAGE_DRAG_TYPE));
            if (publicPayload?.id && publicPayload.mediaId) {
                void createPublicImageNode(publicPayload, position).catch((error) => message.error(error instanceof Error ? error.message : "公共素材插入失败"));
                return;
            }
            const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/") || item.type.startsWith("video/"));
            if (!file) return;
            void (file.type.startsWith("video/") ? createVideoFileNode(file, position) : createImageFileNode(file, position));
        },
        [createImageAssetNode, createImageFileNode, createPublicImageNode, createVideoFileNode, message, screenToCanvas],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || "未命名画布"}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    onProjects={() => router.push(appPath("/canvas"))}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onUndo={undo}
                    onRedo={redo}
                />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    cursor={cutConnectionState ? "crosshair" : undefined}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {visibleConnections.map((connection) => {
                            const from = nodeById.get(connection.fromNodeId);
                            const to = nodeById.get(connection.toNodeId);
                            if (!from || !to) return null;

                            return (
                                <ConnectionPath
                                    key={connection.id}
                                    connection={connection}
                                    from={from}
                                    to={to}
                                    active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                    pendingCut={cutConnectionState?.connectionIds.has(connection.id)}
                                    onSelect={() => {
                                        setSelectedConnectionId(connection.id);
                                        setSelectedNodeIds(new Set());
                                        setContextMenu(null);
                                    }}
                                />
                            );
                        })}
                        {cutConnectionState && cutConnectionState.points.length > 1 ? (
                            <polyline
                                points={cutConnectionState.points.map((point) => `${point.x},${point.y}`).join(" ")}
                                fill="none"
                                stroke={theme.node.activeStroke}
                                strokeWidth={2.5}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeDasharray="10 8"
                                opacity={0.9}
                            />
                        ) : null}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            inputBadgeLabel={focusedConfigInputBadges.get(node.id)?.label}
                            panelVersion={dialogNodeId === node.id && !selectionBox ? `${runningNodeId === node.id ? "running" : "idle"}:${nodeImageSettingsOpen ? "settings-open" : "settings-closed"}` : undefined}
                            contentVersion={node.type === CanvasNodeType.Config ? configInputPanelMetaById.get(node.id)?.version || "" : undefined}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            showPanel={dialogNodeId === node.id && !selectionBox}
                            batchCount={batchChildCountById.get(node.id) || 0}
                            batchExpanded={Boolean(node.metadata?.imageBatchExpanded)}
                            batchClosing={Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId))}
                            batchOpening={openingBatchIds.has(node.id)}
                            batchRecovering={collapsingBatchIds.has(node.id)}
                            batchMotion={batchMotionById.get(node.id)}
                            showImageInfo={showImageInfo}
                            renderPanel={renderNodePromptPanel}
                            renderNodeContent={renderConfigNodeContent}
                            onMouseDown={handleNodeMouseDown}
                            onHoverStart={handleCanvasNodeHoverStart}
                            onHoverEnd={handleCanvasNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResize={handleNodeResize}
                            onContentChange={handleNodeContentChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onRetry={handleCanvasNodeRetry}
                            onGenerateImage={handleCanvasNodeGenerateImage}
                            onContextMenu={handleCanvasNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <div
                            className="pointer-events-none absolute z-[100] border"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                                borderColor: theme.canvas.selectionStroke,
                                background: theme.canvas.selectionFill,
                            }}
                        />
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                </InfiniteCanvas>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || nodeImageSettingsOpen ? null : toolbarNode}
                    viewport={viewport}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                        onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={(node) => setPreviewNodeId(node.id)}
                    onMask={(node) => setMaskNodeId(node.id)}
                    onRetry={(node) => void handleRetryNode(node)}
                />

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onUndo={undo}
                    onRedo={redo}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onDeselect={deselectCanvas}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                />

                {isMiniMapOpen ? <Minimap nodes={deferredMiniMapNodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        onDuplicate={() => {
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            deleteNodes(new Set([contextMenu.nodeId]));
                            setContextMenu(null);
                        }}
						downloadCount={contextMenuImageNodes.length}
						onDownloadSelected={() => {
							void downloadSelectedImages(contextMenuImageNodes);
							setContextMenu(null);
						}}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleImageInputChange} />

                {maskNode?.metadata?.content ? (
                    <CanvasImageMaskDialog
                        image={maskNode.metadata.content}
                        initialMask={maskNode.metadata.imageMask}
                        open={Boolean(maskNode)}
                        onClose={() => setMaskNodeId(null)}
                        onSave={(imageMask) => {
                            saveNodeMask(maskNode.id, imageMask);
                            setMaskNodeId(null);
                        }}
                    />
                ) : null}

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                <Modal
                    title="图片详情"
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content ? <img src={previewNode.metadata.content} alt={previewNode.title || "图片"} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Modal>

                <Modal
                    title="清空画布？"
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>取消</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                清空
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
                </Modal>
            </section>
        </main>
    );
}

function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onImportImage,
    onUndo,
    onRedo,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onImportImage: () => void;
    onUndo: () => void;
    onRedo: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between px-4">
                <div className="pointer-events-auto flex min-w-0 items-center gap-3">
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "projects", icon: <Images className="size-4" />, label: "我的画布", onClick: onProjects },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: "新建画布", onClick: onCreateProject },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: "删除当前画布", onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: "导入图片", onClick: onImportImage },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text="撤销" shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text="重做" shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-9 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="打开画布菜单">
                            <Menu className="size-5" />
                        </button>
                    </Dropdown>

                    <div ref={titleRef} className="flex min-w-0 items-center gap-2">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="max-w-[280px] bg-transparent p-0 text-left text-lg font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="max-w-[280px] truncate border-b border-dashed border-transparent text-left text-lg font-semibold tracking-normal transition hover:border-current"
                                onDoubleClick={onStartTitleEditing}
                                title="双击修改画布名称"
                            >
                                {title}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4" };
}

function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]> = {}) {
    const next = { ...node, metadata: { ...node.metadata, ...(patch || {}) } };
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof patch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(patch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}
