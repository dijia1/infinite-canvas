"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Dropdown, Empty, Modal, Spin } from "antd";
import { ChevronDown, Download, Image as ImageIcon, List, Play, Square, Video } from "lucide-react";
import { nanoid } from "nanoid";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";

import { CanvasFrame } from "@/components/canvas-frame";
import { useCanvasFrameResize } from "@/components/use-canvas-frame-resize";
import { autoAssignWorkflowFrameMembers, createWorkflowFrame, deleteWorkflowFrame, expandWorkflowFrames, renameWorkflowFrame } from "./workflow-frames";
import { useWorkflowFrameGestures } from "./use-workflow-frames";
import { EditorSyncStatus } from "@/components/editor-sync-status";
import { useEditorNavigation } from "@/components/layout/editor-navigation";
import { useNavigationRoute } from "@/components/layout/use-navigation-route";
import { downloadWorkflowImages } from "@/services/workflow-download";
import { CanvasConnectionCreateMenu } from "@/components/canvas-connection-create-menu";
import { CanvasEditorTopBar } from "@/components/canvas-editor-top-bar";
import { CanvasToolbar } from "@/app/(user)/canvas/components/canvas-toolbar";
import { CanvasZoomControls } from "@/app/(user)/canvas/components/canvas-zoom-controls";
import { InfiniteCanvas, type InfiniteCanvasHandle } from "@/app/(user)/canvas/components/infinite-canvas";
import { Minimap } from "@/app/(user)/canvas/components/canvas-mini-map";
import { ConnectionPath, ActiveConnectionPath } from "@/app/(user)/canvas/components/canvas-connections";
import { useCanvasHistory } from "@/app/(user)/canvas/hooks/use-canvas-history";
import { createWorkflowAutosave, type WorkflowAutosaveState } from "./workflow-autosave";
import { useWorkflowEditorLease } from "./workflow-editor-lease";
import { defaultWorkflowView, readWorkflowView, writeWorkflowView } from "./workflow-view-preferences";
import { useWorkflowInteractions } from "./use-workflow-interactions";
import { workflowVisualNodeId, workflowVisualOutputId, applyWorkflowVisualNodes } from "./workflow-canvas-adapter";
import { resizeCanvasNode } from "@/lib/canvas-resize";
import type { CanvasResizeCorner } from "@/components/canvas-node-primitives";
import { ScopedVideoResourceProvider } from "@/app/(user)/canvas/components/canvas-video-content";
import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";
import { useCanvasImageResources } from "@/app/(user)/canvas/media/use-canvas-image-resources";
import { getCanvasRenderDetail } from "@/app/(user)/canvas/media/canvas-media-policy";
import { isCanvasNodeNearViewport } from "@/app/(user)/canvas/utils/canvas-node-visibility";
import { appPath } from "@/lib/app-path";
import { readImageMeta } from "@/lib/image-utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { isEditableTarget } from "@/lib/editable-target";
import { uploadUserImage } from "@/services/api/image";
import { ApiRequestError } from "@/services/api/request";
import { uploadVideoMedia } from "@/services/api/video-media";
import { fetchWorkflow, fetchWorkflowVideos, updateWorkflow } from "@/services/api/workflows";
import { portalSessionQuery } from "@/services/api/session";
import { getRemoteImageAccess } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { reconcileProviderConfig, useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { reconcileVideoConfig } from "@/lib/video-config";
import { workflowConfigFromAiConfig } from "./workflow-config";
import { createWorkflowNode, emptyWorkflowGraph, fitWorkflowImage, workflowViewportCenter, removeWorkflowNode, removeWorkflowOutput, setWorkflowOutputCount, workflowSourceType } from "./workflow-graph";
import { applyWorkflowSaveResult, cacheSavedWorkflow, clearWorkflowDraft, readWorkflowDraft, remoteWorkflowEditorState, workflowDetailQueryKey, workflowEditorSnapshot, writeWorkflowDraft, type WorkflowEditorDocument } from "./workflow-editor-state";
import { WorkflowNodeCard, WorkflowOutputCard, type WorkflowPreviewInput } from "./workflow-node";
import { WorkflowMediaPreview } from "./workflow-media-preview";
import { WorkflowImageAssetCard } from "./workflow-image-asset-card";
import { WorkflowRunDetail } from "./workflow-run-detail";
import { pendingWorkflowRetryKey, workflowRunScopeKey } from "./workflow-run-requests";
import { useWorkflowRuns } from "./use-workflow-runs";
import { workflowDownloadImageCount, indexWorkflowRunOutputsByNode, findCompatibleWorkflowOutput, isRetryableImageOutput, workflowOutputKey, workflowOutputResourceNodeId, workflowRunStatusText } from "./workflow-run-state";
import { observeWorkflowViewport } from "./workflow-viewport";
import { buildWorkflowPathData, selectWorkflowViewportScene, workflowConnectionPathCache, workflowOutputLinks, workflowOutputPathCache, workflowSelectedImageResourceIds, workflowVisualRenderDetail } from "./workflow-viewport-rendering";
import type { WorkflowConnection, WorkflowGraph, WorkflowNode, WorkflowNodeType, WorkflowOutputSlot, WorkflowPosition, WorkflowRunScope } from "./types";

type Viewport = { x: number; y: number; k: number };

export function WorkflowEditor() {
    const route = useParams<{ id: string | string[] }>();
    const session = useQuery(portalSessionQuery);
    return <WorkflowEditorContent key={JSON.stringify([route.id, session.data?.user.uid])} />;
}

function WorkflowEditorContent() {
    const route = useParams<{ id: string | string[] }>();
    const workflowId = Array.isArray(route.id) ? route.id[0] : route.id;
    const router = useRouter();
    const editorNavigation = useEditorNavigation();
    const { home } = useNavigationRoute();
    const [downloading, setDownloading] = useState(false);
    const downloadController = useRef<AbortController | null>(null);
    useEffect(() => () => downloadController.current?.abort(), []);
    const queryClient = useQueryClient();
    const { message, modal } = App.useApp();
    const session = useQuery({ ...portalSessionQuery, refetchOnMount: "always" });
    const draftOwnerUID = session.data?.user.uid;
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const aiStatus = useConfigStore((state) => state.status);
    const globalConfig = useConfigStore((state) => state.config);
    const assets = useAssetStore((state) => state.assets);
    const refreshAssets = useAssetStore((state) => state.refreshFromServer);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<InfiniteCanvasHandle>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const loadedRef = useRef("");
    const editorDocumentRef = useRef<WorkflowEditorDocument>({ name: "", graph: emptyWorkflowGraph() });
    const nodeDragActiveRef = useRef(false);

    const [name, setName] = useState("");
    const [graph, setGraphState] = useState<WorkflowGraph>(emptyWorkflowGraph);
    const setGraph = useCallback((update: SetStateAction<WorkflowGraph>) => setGraphState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        return nodeDragActiveRef.current ? next : expandWorkflowFrames(next);
    }), []);
    const [targetFrameId, setTargetFrameId] = useState<string>();
    const [revision, setRevision] = useState(0);
    const [savedSnapshot, setSavedSnapshot] = useState("");
    const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, k: 0.8 });
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [backgroundMode, setBackgroundMode] = useState(defaultWorkflowView.backgroundMode);
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [miniMapOpen, setMiniMapOpen] = useState(false);
    const [viewScope, setViewScope] = useState("");
    const [mediaPreview, setMediaPreview] = useState<{ node: WorkflowNode; slot?: WorkflowOutputSlot }>();
    const [resizing, setResizing] = useState(false);
    const startingScopesRef = useRef(new Set<string>());
    const [startingScopes, setStartingScopes] = useState<ReadonlySet<string>>(new Set());
    const [stoppingRuns, setStoppingRuns] = useState<ReadonlySet<string>>(new Set());
    const [retryingKeys, setRetryingKeys] = useState<ReadonlySet<string>>(new Set());
    const [draftRecoveryPending, setDraftRecoveryPending] = useState(false);
    const draftRecoveryKey = useRef("");
    const [saveState, setSaveState] = useState<WorkflowAutosaveState>({ revision: 0, dirty: false, status: "idle", error: undefined });
    const saveCallbacks = useRef<{ onSaved: (saved: NonNullable<typeof workflow.data>, snapshot: string) => void; onError: (error: unknown) => void }>({ onSaved: () => {}, onError: () => {} });
    const refreshForLease = useRef<(signal?: AbortSignal) => Promise<void>>(async () => {});
    const autosave = useMemo(
        () =>
            createWorkflowAutosave({
                save: (document, currentRevision) => updateWorkflow(workflowId!, { ...document, revision: currentRevision }),
                onSaved: (saved, snapshot) => saveCallbacks.current.onSaved(saved, snapshot),
                onError: (error) => saveCallbacks.current.onError(error),
                isConflict: (error) => error instanceof ApiRequestError && error.status === 409,
            }),
        [workflowId, draftOwnerUID],
    );
    useEffect(() => {
        autosave.activate();
        const unsubscribe = autosave.subscribe(() => setSaveState(autosave.getState()));
        return () => {
            unsubscribe();
            autosave.dispose();
        };
    }, [autosave]);
    const [mediaTarget, setMediaTarget] = useState<{ nodeId?: string; type: "image" | "video" }>();
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [previewNodeId, setPreviewNodeId] = useState<string>();
    const [uploading, setUploading] = useState(false);
    const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

    const [runDetailOpen, setRunDetailOpen] = useState(false);

    const workflow = useQuery({ queryKey: workflowDetailQueryKey(workflowId), queryFn: () => fetchWorkflow(workflowId!), enabled: Boolean(workflowId), refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false });
    const lease = useWorkflowEditorLease(draftOwnerUID, workflow.data ? workflowId : undefined, async (signal?: AbortSignal) => refreshForLease.current(signal));
    const readOnly = !lease.editable || draftRecoveryPending;
    const editBlocked = readOnly;
    const editBlockedRef = useRef(editBlocked);
    editBlockedRef.current = editBlocked;
    const workflowVideos = useQuery({ queryKey: ["workflow-video-assets"], queryFn: fetchWorkflowVideos, enabled: assetPickerOpen && mediaTarget?.type === "video" });
    const visibleRunNodeIds = useMemo(() => {
        const ids = new Set(graph.nodes.filter((node) => (node.outputs || []).some((slot) => isCanvasNodeNearViewport({ id: node.id, type: CanvasNodeType.Image, title: "", position: slot.position || node.position, width: slot.width || 340, height: slot.height || 240 }, viewport, viewportSize, 384))).map((node) => node.id));
        if (previewNodeId) for (const connection of graph.connections) if (connection.targetNodeId === previewNodeId && connection.sourceSlotId !== "output") ids.add(connection.sourceNodeId);
        if (mediaPreview?.slot) ids.add(mediaPreview.node.id);
        return ids;
    }, [graph.nodes, graph.connections, viewport, viewportSize, previewNodeId, mediaPreview]);
    const runs = useWorkflowRuns({ ownerUID: draftOwnerUID, workflowId: workflow.data ? workflowId : undefined, graph, visibleNodeIds: visibleRunNodeIds });
    const currentRun = { data: runs.selectedDetail, isError: !runs.selectedDetail && Boolean(runs.selectedError), error: runs.selectedError, refetch: runs.refresh };
    const compatibleOutputs = useMemo(() => indexWorkflowRunOutputsByNode(runs.detailByNode, graph), [runs.detailByNode, graph]);
    const downloadImageCount = workflowDownloadImageCount(currentRun.data);
    const scopeStates = useMemo(() => new Map((runs.overview?.scopes || []).map((item) => [workflowRunScopeKey(item.scope), item])), [runs.overview]);
    const nodesById = useMemo(() => {
        const index = new Map<string, WorkflowNode>();
        for (const node of graph.nodes) if (!index.has(node.id)) index.set(node.id, node);
        return index;
    }, [graph.nodes]);
    const inputConnectionsByTarget = useMemo(() => {
        const index = new Map<string, WorkflowConnection[]>();
        for (const connection of graph.connections) {
            const inputs = index.get(connection.targetNodeId);
            if (inputs) inputs.push(connection);
            else index.set(connection.targetNodeId, [connection]);
        }
        for (const inputs of index.values()) inputs.sort((left, right) => left.order - right.order);
        return index;
    }, [graph.connections]);
    const currentSnapshot = useMemo(() => workflowEditorSnapshot({ name, graph }), [graph, name]);
    editorDocumentRef.current = { name, graph };
    const dirty = Boolean(savedSnapshot && currentSnapshot !== savedSnapshot);
    const history = useCanvasHistory({
        snapshot: currentSnapshot,
        applySnapshot: (snapshot: string) => {
            const document = JSON.parse(snapshot) as WorkflowEditorDocument;
            setName(document.name);
            setGraph(document.graph);
        },
        isReady: Boolean(savedSnapshot),
    });
    const applyRemoteWorkflow = useCallback(
        (remote: NonNullable<typeof workflow.data>, restoreDraft = true) => {
            const remoteState = remoteWorkflowEditorState("", 0, false, remote)!;
            const draft = restoreDraft && draftOwnerUID && typeof window !== "undefined" ? readWorkflowDraft(window.sessionStorage, draftOwnerUID, remote.id) : undefined;
            const restore = draft?.revision === remote.revision && workflowEditorSnapshot(draft.document) !== remoteState.savedSnapshot;
            if (draft && !restore && draft.revision !== remote.revision && draftRecoveryKey.current !== `${remote.id}:${draft.revision}`) {
                draftRecoveryKey.current = `${remote.id}:${draft.revision}`;
                setDraftRecoveryPending(true);
                modal.confirm({
                    title: "发现未保存的本地草稿",
                    content: "远端已有更新。恢复草稿将以本地内容替换当前编辑内容并自动保存；使用远端将清除旧草稿。",
                    okText: "恢复草稿",
                    cancelText: "使用远端",
                    closable: false,
                    maskClosable: false,
                    onOk: () => {
                        setName(draft.document.name);
                        setGraph(draft.document.graph);
                        history.replaceBaseline(workflowEditorSnapshot(draft.document));
                        setDraftRecoveryPending(false);
                    },
                    onCancel: () => {
                        if (draftOwnerUID) clearWorkflowDraft(window.sessionStorage, draftOwnerUID, remote.id);
                        setDraftRecoveryPending(false);
                    },
                });
            }
            loadedRef.current = remote.id;
            setName(restore ? draft.document.name : remoteState.document.name);
            setGraph(restore ? draft.document.graph : remoteState.document.graph);
            setRevision(remoteState.revision);
            setSavedSnapshot(remoteState.savedSnapshot);
            autosave.reset(remoteState.document, remote.revision);
            history.replaceBaseline(workflowEditorSnapshot(restore ? draft.document : remoteState.document));
            if (restore) message.info("已恢复未保存的流程修改");
        },
        [autosave, draftOwnerUID, message],
    );
    useEffect(() => {
        if (!draftOwnerUID || session.isFetching || !workflow.data || workflow.isFetching || !remoteWorkflowEditorState(loadedRef.current, revision, dirty, workflow.data)) return;
        applyRemoteWorkflow(workflow.data);
    }, [applyRemoteWorkflow, dirty, draftOwnerUID, revision, session.isFetching, workflow.data, workflow.isFetching]);
    refreshForLease.current = async (signal) => {
        if (dirty && draftOwnerUID) writeWorkflowDraft(window.sessionStorage, draftOwnerUID, workflowId!, { revision, document: editorDocumentRef.current });
        const remote = await fetchWorkflow(workflowId!);
        if (signal?.aborted) return;
        cacheSavedWorkflow(queryClient, remote);
        applyRemoteWorkflow(remote);
    };
    useLayoutEffect(() => observeWorkflowViewport(containerRef.current, setViewportSize, (update) => new ResizeObserver(update)), [Boolean(workflow.data), Boolean(savedSnapshot)]);
    useEffect(() => {
        if (!draftOwnerUID || !workflowId) return;
        const restored = readWorkflowView(window.localStorage, draftOwnerUID, workflowId);
        setViewport(restored.viewport);
        setBackgroundMode(restored.backgroundMode);
        setShowImageInfo(restored.showImageInfo);
        setViewScope(JSON.stringify([draftOwnerUID, workflowId]));
    }, [draftOwnerUID, workflowId]);
    useEffect(() => {
        if (!draftOwnerUID || !workflowId || viewScope !== JSON.stringify([draftOwnerUID, workflowId])) return;
        const timer = setTimeout(() => writeWorkflowView(window.localStorage, draftOwnerUID, workflowId, { viewport, backgroundMode, showImageInfo }), 300);
        return () => clearTimeout(timer);
    }, [draftOwnerUID, workflowId, viewScope, viewport, backgroundMode, showImageInfo]);
    const previewImageNodeIds = useMemo(
        () =>
            new Set(
                (previewNodeId ? inputConnectionsByTarget.get(previewNodeId) || [] : [])
                    .flatMap((connection) => {
                        const source = nodesById.get(connection.sourceNodeId);
                        if (!source || workflowSourceType(source, connection.sourceSlotId) !== "image") return [];
                        if (connection.sourceSlotId === "output") return [source.id];
                        const output = compatibleOutputs.get(workflowOutputKey(source.id, connection.sourceSlotId));
                        return output?.mediaId ? [workflowOutputResourceNodeId(output.runId, source.id, connection.sourceSlotId)] : [];
                    })
                    .concat(mediaPreview ? [mediaPreview.slot && runs.detailByNode.has(mediaPreview.node.id) ? workflowOutputResourceNodeId(runs.detailByNode.get(mediaPreview.node.id)!.run.id, mediaPreview.node.id, mediaPreview.slot.id) : mediaPreview.node.id] : []),
            ),
        [compatibleOutputs, runs.detailByNode, inputConnectionsByTarget, nodesById, previewNodeId, mediaPreview],
    );
    const imageDimensions = useRef(new Map<string, { width: number; height: number }>());
    const resolveImageAccess = useCallback(async (node: CanvasNodeData) => {
        const mediaId = node.metadata!.mediaId!;
        const access = await getRemoteImageAccess(mediaId);
        if (access.width && access.height) imageDimensions.current.set(mediaId, { width: access.width, height: access.height });
        return access;
    }, []);
    useEffect(() => {
        if (!dirty) return;
        const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, [dirty]);
    useEffect(() => {
        if (!draftOwnerUID || !workflowId || !savedSnapshot || !lease.editable || draftRecoveryPending || typeof window === "undefined") return;
        if (dirty) writeWorkflowDraft(window.sessionStorage, draftOwnerUID, workflowId, { revision, document: { name, graph } });
        else clearWorkflowDraft(window.sessionStorage, draftOwnerUID, workflowId);
    }, [dirty, draftOwnerUID, graph, name, revision, savedSnapshot, workflowId, lease.editable, draftRecoveryPending]);
    useEffect(() => {
        if (assetPickerOpen && mediaTarget?.type === "image") void refreshAssets().catch((error) => message.error(error instanceof Error ? error.message : "素材加载失败"));
    }, [assetPickerOpen, mediaTarget?.type, message, refreshAssets]);

    saveCallbacks.current = {
        onSaved: (saved, submittedSnapshot) => {
            const result = applyWorkflowSaveResult(editorDocumentRef.current, submittedSnapshot, saved);
            cacheSavedWorkflow(queryClient, saved);
            loadedRef.current = saved.id;
            setName(result.document.name);
            setGraph(result.document.graph);
            setRevision(result.revision);
            setSavedSnapshot(result.savedSnapshot);
        },
        onError: (error) => {
            message.error(error instanceof Error ? error.message : "保存流程失败");
        },
    };
    const startRun = async (scope: WorkflowRunScope = { type: "workflow" }) => {
        const key = workflowRunScopeKey(scope);
        if (startingScopesRef.current.has(key) || readOnly) return;
        startingScopesRef.current.add(key); setStartingScopes(new Set(startingScopesRef.current));
        try {
            let confirmedRevision = revision;
            if (!runs.pendingByScope.has(key)) {
                autosave.update(editorDocumentRef.current);
                confirmedRevision = await autosave.flush();
            }
            await runs.start(scope, confirmedRevision);
            message.success("流程已开始运行");
        } catch (error) { message.error(error instanceof Error ? error.message : "运行请求结果待确认，可再次点击确认"); }
        finally { startingScopesRef.current.delete(key); setStartingScopes(new Set(startingScopesRef.current)); }
    };
    const stopRun = async (runId: string) => {
        setStoppingRuns((current) => new Set([...current, runId]));
        try { await runs.stop(runId); message.success("已停止领取新的生成任务"); }
        catch (error) { message.error(error instanceof Error ? error.message : "停止流程失败"); }
        finally { setStoppingRuns((current) => new Set([...current].filter((id) => id !== runId))); }
    };
    const startOutputRetry = async (runId: string, nodeId: string, slotId: string) => {
        const key = pendingWorkflowRetryKey({ runId, nodeId, slotId });
        if (retryingKeys.has(key)) return;
        setRetryingKeys((current) => new Set([...current, key]));
        try { await runs.retry(runId, nodeId, slotId); message.success("已重新提交失败输出"); }
        catch (error) { message.error(error instanceof Error ? error.message : "重试请求结果待确认，可再次点击确认"); }
        finally { setRetryingKeys((current) => new Set([...current].filter((item) => item !== key))); }
    };

    const updateNode = useCallback(
        (nodeId: string, update: (node: WorkflowNode) => WorkflowNode) => {
            if (!editBlockedRef.current) setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => (node.id === nodeId ? update(node) : node)) }));
        },
        [readOnly],
    );
    const screenToWorld = useCallback(
        (clientX: number, clientY: number) => {
            const rect = containerRef.current?.getBoundingClientRect();
            return { x: (clientX - (rect?.left || 0) - viewport.x) / viewport.k, y: (clientY - (rect?.top || 0) - viewport.y) / viewport.k };
        },
        [viewport],
    );
    const centerPosition = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return workflowViewportCenter(viewport, { width: rect?.width || 1000, height: rect?.height || 700 });
    }, [viewport]);

    const makeNode = useCallback(
        (type: WorkflowNodeType, position: WorkflowPosition) => {
            const node = createWorkflowNode(type, position);
            if (type === "image_generation" && aiStatus) node.config = workflowConfigFromAiConfig(type, reconcileProviderConfig(globalConfig, aiStatus));
            if (type === "video_generation" && aiStatus) node.config = workflowConfigFromAiConfig(type, reconcileVideoConfig(globalConfig, aiStatus));
            return node;
        },
        [aiStatus, globalConfig],
    );
    const addNode = useCallback(
        (type: WorkflowNodeType, mediaId?: string, dimensions?: { width: number; height: number }) => {
            if (editBlockedRef.current) return;
            let node = makeNode(type, { x: 0, y: 0 });
            if (type === "image_input" && dimensions) node = fitWorkflowImage(node, dimensions, true);
            const center = centerPosition();
            const position = { x: center.x - (node.width || 340) / 2, y: center.y - (node.height || 240) / 2 };
            const dx = position.x - node.position.x;
            const dy = position.y - node.position.y;
            node = { ...node, position, outputs: node.outputs?.map((slot) => ({ ...slot, position: { x: (slot.position?.x || 0) + dx, y: (slot.position?.y || 0) + dy } })) };
            if (mediaId) node.mediaId = mediaId;
            const visualId = workflowVisualNodeId(node.id);
            setGraph((current) => autoAssignWorkflowFrameMembers({ ...current, nodes: [...current.nodes, node] }, new Set([visualId])));
            canvas.setSelectedNodeIds(new Set([visualId]));
        },
        [makeNode, centerPosition],
    );

    const chooseMedia = (nodeId: string | undefined, type: "image" | "video") => {
        if (editBlockedRef.current) return;
        setMediaTarget({ nodeId, type });
        setAssetPickerOpen(true);
    };
    const uploadImage = async (file: File) => {
        setUploading(true);
        try {
            const localUrl = URL.createObjectURL(file);
            let dimensions: { width: number; height: number };
            try {
                dimensions = await readImageMeta(localUrl);
            } finally {
                URL.revokeObjectURL(localUrl);
            }
            const uploaded = await uploadUserImage(file, "canvas");
            if (editBlockedRef.current) return;
            if (mediaTarget?.nodeId) updateNode(mediaTarget.nodeId, (node) => fitWorkflowImage({ ...node, mediaId: uploaded.mediaId }, dimensions, true));
            else addNode("image_input", uploaded.mediaId, dimensions);
            setAssetPickerOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片上传失败");
        } finally {
            setUploading(false);
            setMediaTarget(undefined);
        }
    };
    const uploadVideo = async (file: File) => {
        setUploading(true);
        try {
            const uploaded = await uploadVideoMedia(file);
            if (mediaTarget?.nodeId) updateNode(mediaTarget.nodeId, (node) => ({ ...node, mediaId: uploaded.mediaId }));
            else addNode("video_input", uploaded.mediaId);
            setAssetPickerOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["workflow-video-assets"] });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频上传失败");
        } finally {
            setUploading(false);
            setMediaTarget(undefined);
        }
    };
    const selectAsset = (mediaId: string) => {
        const asset = assets.find((item) => item.kind === "image" && item.metadata?.mediaId === mediaId);
        const dimensions = asset?.kind === "image" ? asset.data : undefined;
        if (mediaTarget?.nodeId)
            updateNode(mediaTarget.nodeId, (node) => {
                const next = { ...node, mediaId };
                return node.type === "image_input" ? fitWorkflowImage(next, dimensions || { width: 340, height: 240 }, true) : next;
            });
        else addNode(mediaTarget?.type === "video" ? "video_input" : "image_input", mediaId, dimensions);
        setAssetPickerOpen(false);
        setMediaTarget(undefined);
    };

    const changeOutputCount = (nodeId: string, count: number) => {
        if (editBlockedRef.current) return;
        try {
            setGraph(setWorkflowOutputCount(graph, nodeId, count));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法调整输出数量");
        }
    };

    const fitLoadedImage = (nodeId: string, mediaId: string, dimensions: { width: number; height: number }, slotId?: string) => {
        if (editBlockedRef.current) return;
        const asset = assets.find((item) => item.kind === "image" && item.metadata?.mediaId === mediaId);
        dimensions = asset?.kind === "image" && asset.data.width > 0 && asset.data.height > 0 ? asset.data : imageDimensions.current.get(mediaId) || dimensions;
        setGraph((current) => {
            let changed = false;
            const nodes = current.nodes.map((node) => {
                if (node.id !== nodeId) return node;
                if (!slotId) {
                    if (node.mediaId !== mediaId || node.type !== "image_input") return node;
                    const next = fitWorkflowImage(node, dimensions);
                    changed ||= next !== node;
                    return next;
                }
                const detail = runs.detailByNode.get(nodeId);
                const output = detail && findCompatibleWorkflowOutput(detail, current, nodeId, slotId);
                if (output?.mediaId !== mediaId) return node;
                const outputs = node.outputs?.map((slot) => {
                    if (slot.id !== slotId || slot.type !== "image") return slot;
                    const next = fitWorkflowImage(slot, dimensions);
                    changed ||= next !== slot;
                    return next;
                });
                return changed ? { ...node, outputs } : node;
            });
            return changed ? { ...current, nodes } : current;
        });
    };

    const validateConnection = useCallback(
        (graph: WorkflowGraph, { sourceNodeId, sourceSlotId, targetNodeId }: { sourceNodeId: string; sourceSlotId: string; targetNodeId: string }) => {
            const source = graph.nodes.find((node) => node.id === sourceNodeId);
            const target = graph.nodes.find((node) => node.id === targetNodeId);
            const type = source ? workflowSourceType(source, sourceSlotId) : undefined;
            if (!type || !target?.config?.providerId) return;
            const model = target.type === "image_generation" ? aiStatus?.imageModels?.find((item) => item.id === target.config?.providerId) : aiStatus?.videoModels?.find((item) => item.id === target.config?.providerId);
            const currentCount = graph.connections
                .filter((item) => item.targetNodeId === target.id)
                .filter((item) => {
                    const input = graph.nodes.find((node) => node.id === item.sourceNodeId);
                    return input && workflowSourceType(input, item.sourceSlotId) === type;
                }).length;
            const limit = type === "image" ? (model?.imageRequestSchema?.maxReferenceImages ?? model?.videoRequestSchema?.maxReferenceImages) : type === "video" ? model?.videoRequestSchema?.maxReferenceVideos : undefined;
            if (typeof limit === "number" && currentCount >= limit) throw new Error(`当前模型最多支持 ${limit} 个${type === "image" ? "图片" : "视频"}输入`);
        },
        [graph, aiStatus],
    );
    const canvas = useWorkflowInteractions({
        graph,
        setGraph,
        viewport,
        screenToCanvas: screenToWorld,
        pause: history.pause,
        resume: history.resume,
        onWarning: (text: string) => {
            message.warning(text);
        },
        readOnly: editBlocked,
        validateConnection,
        makeNode,
        onNodeDragActiveChange: (active) => {
            nodeDragActiveRef.current = active;
        },
    });
    const { interactions } = canvas;
    const selectedImageResourceIds = useMemo(
        () => workflowSelectedImageResourceIds(graph, canvas.selectedNodeIds, compatibleOutputs),
        [canvas.selectedNodeIds, compatibleOutputs, graph],
    );
    const imageTargets = useMemo(() => {
        const inputTargets = graph.nodes.flatMap((node) => {
            if (node.type !== "image_input" || !node.mediaId) return [];
            const canvasNode = { id: node.id, type: CanvasNodeType.Image, title: "", position: node.position, width: node.width || 340, height: node.height || 240, metadata: { mediaId: node.mediaId } } satisfies CanvasNodeData;
            const visible = isCanvasNodeNearViewport(canvasNode, viewport, viewportSize);
            const preview = previewImageNodeIds.has(node.id);
            const pinned = preview || selectedImageResourceIds.has(node.id);
            const prefetch = !visible && isCanvasNodeNearViewport(canvasNode, viewport, viewportSize, 384);
            if (!visible && !prefetch && !pinned) return [];
            return [{ node: canvasNode, visible, pinned, prefetch, preview }];
        });
        const outputTargets = graph.nodes.flatMap((node) =>
            (node.outputs || []).flatMap((slot) => {
                if (slot.type !== "image") return [];
                const output = compatibleOutputs.get(workflowOutputKey(node.id, slot.id));
                if (output?.status !== "succeeded" || !output.mediaId) return [];
                const canvasNode = {
                    id: workflowOutputResourceNodeId(output.runId, node.id, slot.id),
                    type: CanvasNodeType.Image,
                    title: "",
                    position: slot.position || node.position,
                    width: slot.width || 340,
                    height: slot.height || 240,
                    metadata: { mediaId: output.mediaId },
                } satisfies CanvasNodeData;
                const visible = isCanvasNodeNearViewport(canvasNode, viewport, viewportSize);
                const preview = previewImageNodeIds.has(canvasNode.id);
                const pinned = preview || selectedImageResourceIds.has(canvasNode.id);
                const prefetch = !visible && isCanvasNodeNearViewport(canvasNode, viewport, viewportSize, 384);
                if (!visible && !prefetch && !pinned) return [];
                return [{ node: canvasNode, visible, pinned, prefetch, preview }];
            }),
        );
        return [...inputTargets, ...outputTargets];
    }, [compatibleOutputs, graph.nodes, previewImageNodeIds, selectedImageResourceIds, viewport, viewportSize]);
    const imageResources = useCanvasImageResources({ targets: imageTargets, scale: viewport.k, resolveAccess: resolveImageAccess });
    const previewInputs = useCallback(
        (targetId: string): WorkflowPreviewInput[] =>
            (inputConnectionsByTarget.get(targetId) || [])
                .flatMap((connection) => {
                    const source = nodesById.get(connection.sourceNodeId);
                    if (!source) return [];
                    const type = workflowSourceType(source, connection.sourceSlotId);
                    if (!type) return [];
                    const execution = connection.sourceSlotId === "output" ? undefined : compatibleOutputs.get(workflowOutputKey(source.id, connection.sourceSlotId));
                    const resourceNodeId = execution ? workflowOutputResourceNodeId(execution.runId, source.id, connection.sourceSlotId) : source.id;
                    const mediaId = source.mediaId || execution?.mediaId;
                    const resource = imageResources.resources.get(resourceNodeId);
                    return [
                        {
                            key: connection.targetPortId,
                            sourceNodeId: resourceNodeId,
                            type,
                            ...(type === "text" ? { text: source.text } : mediaId ? { mediaId } : {}),
                            ...(type === "image" && resource ? { imageUrl: resource.url, imageStorageKey: resource.storageKey } : {}),
                            ...(type === "image" && imageResources.errors.get(resourceNodeId) ? { imageError: imageResources.errors.get(resourceNodeId) } : {}),
                        },
                    ];
                }),
        [compatibleOutputs, inputConnectionsByTarget, nodesById, imageResources.errors, imageResources.resources],
    );
    const activePreviewInputs = previewNodeId ? previewInputs(previewNodeId) : [];
    const outputLinks = useMemo(() => workflowOutputLinks(graph), [graph]);
    const visualNodeById = useMemo(() => new Map(canvas.nodes.map((node) => [node.id, node])), [canvas.nodes]);
    const connectionPathCache = useMemo(() => workflowConnectionPathCache(canvas.connections, visualNodeById), [canvas.connections, visualNodeById]);
    const outputPathCache = useMemo(() => workflowOutputPathCache(outputLinks, visualNodeById), [outputLinks, visualNodeById]);
    const interactiveConnectionIds = useMemo(() => {
        const ids = new Set(interactions.cutConnectionState?.connectionIds || []);
        if (canvas.selectedConnectionId) ids.add(canvas.selectedConnectionId);
        return ids;
    }, [canvas.selectedConnectionId, interactions.cutConnectionState?.connectionIds]);
    const retainedVisualNodeIds = useMemo(() => {
        const ids = new Set(canvas.selectedNodeIds);
        if (interactions.connectingParams) ids.add(interactions.connectingParams.nodeId);
        for (const connection of canvas.connections) {
            if (!interactiveConnectionIds.has(connection.id)) continue;
            ids.add(connection.fromNodeId);
            ids.add(connection.toNodeId);
        }
        return ids;
    }, [canvas.connections, canvas.selectedNodeIds, interactions.connectingParams, interactiveConnectionIds]);
    const viewportScene = useMemo(() => selectWorkflowViewportScene({
        nodes: canvas.nodes,
        connections: canvas.connections,
        outputLinks,
        viewport,
        viewportSize,
        retainedNodeIds: retainedVisualNodeIds,
        interactiveConnectionIds,
    }), [canvas.connections, canvas.nodes, interactiveConnectionIds, outputLinks, retainedVisualNodeIds, viewport, viewportSize]);
    const renderDetail = getCanvasRenderDetail(viewport.k);
    const overviewConnectionPath = useMemo(
        () => buildWorkflowPathData(viewportScene.visibleConnections, connectionPathCache, interactiveConnectionIds),
        [connectionPathCache, interactiveConnectionIds, viewportScene.visibleConnections],
    );
    const overviewOutputPath = useMemo(
        () => buildWorkflowPathData(viewportScene.visibleOutputLinks, outputPathCache),
        [outputPathCache, viewportScene.visibleOutputLinks],
    );
    const frameGesture = useWorkflowFrameGestures({ updateGraph: setGraph, readOnly: editBlocked, scale: viewport.k, pause: history.pause, resume: history.resume,
        getViewport: () => {
            const current = canvasRef.current?.getViewport() || viewport;
            const rect = containerRef.current?.getBoundingClientRect();
            return { x: current.x + (rect?.left || 0), y: current.y + (rect?.top || 0), k: current.k };
        },
    });
    const frameOnlySelected = Boolean(targetFrameId && !canvas.selectedNodeIds.size && !canvas.selectedConnectionId);
    useEffect(() => { if (targetFrameId && !graph.frames?.some((frame) => frame.id === targetFrameId)) setTargetFrameId(undefined); }, [graph.frames, targetFrameId]);
    const addFrame = () => {
        if (editBlockedRef.current || frameGesture.active) return;
        const id = nanoid();
        const center = centerPosition();
        try {
            const next = createWorkflowFrame(graph, { id, name: `包裹框 ${(graph.frames?.length || 0) + 1}`, position: { x: center.x - 240, y: center.y - 160 } }, canvas.selectedNodeIds);
            setGraph(next);
            canvas.setSelectedNodeIds(new Set()); canvas.setSelectedConnectionId(null); setTargetFrameId(id);
        } catch (error) { message.warning(error instanceof Error ? error.message : "无法创建包裹框"); }
    };
    const deleteSelection = () => {
        if (editBlockedRef.current) return;
        if (frameOnlySelected) { setGraph((current) => deleteWorkflowFrame(current, targetFrameId!)); setTargetFrameId(undefined); }
        else canvas.deleteSelection();
    };
    const pendingSourceNode = interactions.pendingConnectionCreate ? canvas.nodes.find((item) => item.id === interactions.pendingConnectionCreate?.connection.nodeId) : undefined;
    const connectionCreateOptions: [WorkflowNodeType, string][] =
        interactions.pendingConnectionCreate?.connection.handleType === "source"
            ? pendingSourceNode?.type === CanvasNodeType.Video
                ? [["video_generation", "视频配置"]]
                : [
                      ["image_generation", "生图配置"],
                      ["video_generation", "视频配置"],
                  ]
            : graph.nodes.find((node) => workflowVisualNodeId(node.id) === pendingSourceNode?.id)?.type === "image_generation"
              ? [
                    ["text_input", "文本"],
                    ["image_input", "图片"],
                ]
              : [
                    ["text_input", "文本"],
                    ["image_input", "图片"],
                    ["video_input", "视频"],
                ];
    const deselect = () => {
        setTargetFrameId(undefined);
        canvas.setSelectedNodeIds(new Set());
        canvas.setSelectedConnectionId(null);
        interactions.resetInteractionState();
    };
    const startNodeDrag = (event: ReactPointerEvent, node: WorkflowNode) => {
        if (event.button !== 0 || (event.target as Element).closest("button,input,textarea,.ant-select,[contenteditable=true],[data-canvas-no-drag]")) return;
        if (!editBlockedRef.current) canvas.handleNodeMouseDown(event, workflowVisualNodeId(node.id));
    };
    const startOutputDrag = (event: ReactPointerEvent, node: WorkflowNode, slot: WorkflowOutputSlot) => {
        if (event.button !== 0 || (event.target as Element).closest("button,input,[data-canvas-no-drag]")) return;
        if (!editBlockedRef.current) canvas.handleNodeMouseDown(event, workflowVisualOutputId(node.id, slot.id));
    };
    useEffect(() => {
        autosave.update({ name, graph });
        autosave.setEnabled(!readOnly && !interactions.isNodeDragging && !resizing && !frameGesture.active);
    }, [autosave, name, graph, readOnly, interactions.isNodeDragging, resizing, frameGesture.active]);
    const resizeSession = useRef<{ id: string; clientX: number; clientY: number; start: Parameters<typeof resizeCanvasNode>[0]; config: boolean } | null>(null);
    const visualNodesRef = useRef(canvas.nodes);
    visualNodesRef.current = canvas.nodes;
    const startResize = (event: ReactPointerEvent, node: WorkflowNode, corner: CanvasResizeCorner, slot?: WorkflowOutputSlot) => {
        if (editBlockedRef.current || event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        const id = slot ? workflowVisualOutputId(node.id, slot.id) : workflowVisualNodeId(node.id);
        const visual = canvas.nodes.find((item) => item.id === id);
        if (!visual) return;
        const config = !slot && (node.type === "image_generation" || node.type === "video_generation");
        resizeSession.current = {
            id,
            clientX: event.clientX,
            clientY: event.clientY,
            config,
            start: { x: visual.position.x, y: visual.position.y, width: visual.width, height: visual.height, corner, keepRatio: !config && node.type !== "text_input", ratio: visual.width / visual.height },
        };
        canvas.setSelectedNodeIds(new Set([id]));
        history.pause();
        setResizing(true);
    };
    useEffect(() => {
        const move = (event: PointerEvent) => {
            const resize = resizeSession.current;
            if (!resize || editBlockedRef.current) return;
            const next = resizeCanvasNode(resize.start, { x: (event.clientX - resize.clientX) / viewport.k, y: (event.clientY - resize.clientY) / viewport.k }, resize.config ? { width: 360, height: 260 } : undefined);
            setGraph((current) =>
                applyWorkflowVisualNodes(
                    current,
                    visualNodesRef.current.map((item) => (item.id === resize.id ? { ...item, ...next } : item)),
                ),
            );
        };
        const finish = () => {
            if (!resizeSession.current) return;
            resizeSession.current = null;
            setResizing(false);
            history.resume();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
        window.addEventListener("blur", finish);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", finish);
            window.removeEventListener("blur", finish);
        };
    }, [viewport.k, history.resume]);
    const changeMode = (node: WorkflowNode, mode: "image" | "video") => {
        if (editBlockedRef.current || node.type === `${mode}_generation`) return;
        if (graph.connections.some((edge) => edge.sourceNodeId === node.id)) {
            message.warning("请先断开该配置输出的下游连线，再切换模式");
            return;
        }
        if (
            mode === "image" &&
            graph.connections.some((edge) => {
                const source = graph.nodes.find((item) => item.id === edge.sourceNodeId);
                return edge.targetNodeId === node.id && source && workflowSourceType(source, edge.sourceSlotId) === "video";
            })
        ) {
            message.warning("请先断开视频输入，再切换生图模式");
            return;
        }
        const config = aiStatus ? (mode === "image" ? reconcileProviderConfig(globalConfig, aiStatus) : reconcileVideoConfig(globalConfig, aiStatus)) : globalConfig;
        updateNode(node.id, (current) => ({
            ...current,
            type: mode === "image" ? "image_generation" : "video_generation",
            config: workflowConfigFromAiConfig(mode === "image" ? "image_generation" : "video_generation", config),
            outputs: current.outputs?.map((slot) => ({ ...slot, type: mode })),
        }));
    };
    const finishTitleEditing = () => {
        if (!titleEditing) return;
        const next = titleDraft.trim();
        if (next) setName(next.slice(0, 128));
        setTitleEditing(false);
    };
    const resetView = () => {
        if (!canvas.nodes.length) {
            setViewport(defaultWorkflowView.viewport);
            return;
        }
        const left = Math.min(...canvas.nodes.map((node) => node.position.x));
        const top = Math.min(...canvas.nodes.map((node) => node.position.y));
        const right = Math.max(...canvas.nodes.map((node) => node.position.x + node.width));
        const bottom = Math.max(...canvas.nodes.map((node) => node.position.y + node.height));
        const k = Math.min(1, Math.max(0.05, Math.min((viewportSize.width - 160) / (right - left), (viewportSize.height - 200) / (bottom - top))));
        setViewport({ x: (viewportSize.width - (right - left) * k) / 2 - left * k, y: (viewportSize.height - (bottom - top) * k) / 2 - top * k, k });
    };
    const retrySave = async () => {
        if (saveState.status === "conflict") {
            modal.confirm({ title: "流程已在其他页面更新", content: "重新加载后将检查本地草稿，可选择恢复草稿或使用远端版本。", okText: "重新加载", cancelText: "保留当前修改", onOk: async () => applyRemoteWorkflow(await fetchWorkflow(workflowId!)) });
            return;
        }
        try {
            await autosave.retry();
        } catch {
            /* Save state contains the actionable error. */
        }
    };
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (isEditableTarget(event.target) || document.querySelector(".ant-modal-wrap:not([style*='display: none']),.ant-drawer-open")) return;
            if (event.key === "Escape") {
                frameGesture.finish();
                deselect();
                return;
            }
            if (editBlocked || interactions.isNodeDragging || resizing || frameGesture.active || event.isComposing || event.repeat) return;
            const modifier = event.metaKey || event.ctrlKey;
            if (modifier && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void retrySave();
            } else if (modifier && event.key.toLowerCase() === "z") {
                event.preventDefault();
                event.shiftKey ? history.redo() : history.undo();
            } else if (modifier && event.key.toLowerCase() === "y") {
                event.preventDefault();
                history.redo();
            } else if (modifier && event.key.toLowerCase() === "c") {
                if (canvas.copySelection(frameOnlySelected ? targetFrameId : undefined)) event.preventDefault();
            } else if (modifier && event.key.toLowerCase() === "v") {
                const pasted = canvas.pasteSelection();
                if (pasted) { event.preventDefault(); setTargetFrameId(pasted.selectedFrameId); }
            } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                deleteSelection();
            }
        };
        window.addEventListener("keydown", keydown);
        return () => window.removeEventListener("keydown", keydown);
    });

    const navigateAway = async (href: string) => {
        if (!readOnly && draftOwnerUID && workflowId && viewScope === JSON.stringify([draftOwnerUID, workflowId])) {
            writeWorkflowView(window.localStorage, draftOwnerUID, workflowId, { viewport: canvasRef.current?.getViewport() || viewport, backgroundMode, showImageInfo });
        }
        if (!dirty || readOnly) {
            router.push(href);
            return;
        }
        try {
            autosave.update(editorDocumentRef.current);
            await autosave.flush();
            router.push(href);
        } catch {
            modal.confirm({ title: "修改尚未保存", content: "本地草稿已保留。离开后可返回继续处理保存。", okText: "离开", cancelText: "继续编辑", onOk: () => router.push(href) });
        }
    };
    const navigationRef = useRef(navigateAway);
    navigationRef.current = navigateAway;
    useEffect(() => editorNavigation?.register((href) => navigationRef.current(href)), [editorNavigation]);
    const downloadImages = async (runId = currentRun.data?.run.id) => {
        if (!runId || downloadController.current) return;
        const controller = new AbortController();
        downloadController.current = controller;
        setDownloading(true);
        try {
            const count = await downloadWorkflowImages(runId, controller.signal);
            if (count) message.success(`已发起下载，共 ${count} 张图片`);
        } catch (error) {
            if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : "发起下载失败");
        } finally {
            downloadController.current = null;
            if (!controller.signal.aborted) setDownloading(false);
        }
    };
    const leave = () => navigateAway(home.href);
    const anyActive = Boolean(runs.overview?.activeRuns.total);
    const fullActive = Boolean(scopeStates.get(workflowRunScopeKey({ type: "workflow" }))?.activeRunId);
    const unframedRun = graph.frames?.length ? undefined : scopeStates.get(workflowRunScopeKey({ type: "workflow" }))?.latestRun || undefined;
    const runDisabled = (scope: WorkflowRunScope) => (scope.type === "frame" && !graph.frames?.find((frame) => frame.id === scope.frameId)?.nodeIds.some((id) => nodesById.get(id)?.type.endsWith("_generation"))) || readOnly || resizing || interactions.isNodeDragging || frameGesture.active || startingScopes.has(workflowRunScopeKey(scope)) || (!runs.pendingByScope.has(workflowRunScopeKey(scope)) && (scope.type === "workflow" ? anyActive : fullActive || Boolean(scopeStates.get(workflowRunScopeKey(scope))?.activeRunId)));
    const openRun = (id: string) => { runs.selectRun(id); setRunDetailOpen(true); };
    const frameLabel = (frame: { id: string; name: string }) => {
        const duplicates = graph.frames?.filter((item) => item.name === frame.name) || [];
        if (duplicates.length < 2) return frame.name;
        const suffix = frame.id.slice(-6);
        return `${frame.name} · ${duplicates.filter((item) => item.id.endsWith(suffix)).length > 1 ? frame.id : suffix}`;
    };
    const visibleFrames = (graph.frames || []).filter((frame) => frame.id === targetFrameId || isCanvasNodeNearViewport({ ...frame, type: CanvasNodeType.Text, title: frame.name }, viewport, viewportSize, 128));
    const frameResizeHover = useCanvasFrameResize({
        containerRef, frames: visibleFrames, selectedFrameId: targetFrameId, readOnly: editBlocked, active: frameGesture.active,
        getViewport: () => canvasRef.current?.getViewport() || viewport,
        onSelect: (id) => { setTargetFrameId(id); canvas.setSelectedNodeIds(new Set()); canvas.setSelectedConnectionId(null); },
        onResizeStart: frameGesture.start,
    });
    const latestDownloadRuns = (runs.overview?.scopes || []).flatMap((item) => item.latestRun ? [item.latestRun] : []);

    if (session.isPending || workflow.isPending || (!loadedRef.current && (session.isFetching || workflow.isFetching)))
        return (
            <div className="flex h-full items-center justify-center">
                <Spin />
            </div>
        );
    if (session.isError || workflow.isError || !workflow.data)
        return (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-stone-500">
                <span>{workflow.error instanceof Error ? workflow.error.message : session.error instanceof Error ? session.error.message : "流程加载失败"}</span>
                <Button onClick={() => void Promise.all([session.refetch(), workflow.refetch()])}>重新加载</Button>
            </div>
        );

    return (
        <ScopedVideoResourceProvider
            scope={`workflow:${draftOwnerUID}:${workflowId}`}
            nodeIds={[
                ...graph.nodes.filter((node) => node.type === "video_input").map((node) => node.id),
                ...graph.nodes.flatMap((node) =>
                    (node.outputs || []).flatMap((slot) =>
                        slot.type === "video" && compatibleOutputs.get(workflowOutputKey(node.id, slot.id))?.mediaId ? [workflowOutputResourceNodeId(compatibleOutputs.get(workflowOutputKey(node.id, slot.id))!.runId, node.id, slot.id)] : [],
                    ),
                ),
                ...activePreviewInputs.filter((input) => input.type === "video" && input.mediaId).map((input) => `preview-${input.sourceNodeId}-${input.key}`),
            ]}
        >
            <main className="relative flex h-full min-h-0 flex-col overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
                <CanvasEditorTopBar
                    title={name}
                    titleDraft={titleDraft}
                    editing={titleEditing}
                    onDraftChange={setTitleDraft}
                    onStartEditing={() => {
                        if (!editBlocked) {
                            setTitleDraft(name);
                            setTitleEditing(true);
                        }
                    }}
                    onFinishEditing={finishTitleEditing}
                    onCancelEditing={() => setTitleEditing(false)}
                    menuLabel="打开流程菜单"
                    titleHint="双击修改流程名称"
                    menu={{
                        items: [
                            { key: "library", label: "我的流程", onClick: leave },
                            { key: "frame", label: canvas.selectedNodeIds.size ? "从所选节点创建包裹框" : "新建包裹框", disabled: editBlocked, onClick: addFrame },
                            { key: "dissolve-frame", label: "解散包裹框（保留节点）", disabled: editBlocked || !targetFrameId, onClick: () => { setGraph((current) => deleteWorkflowFrame(current, targetFrameId!)); setTargetFrameId(undefined); } },
                            { type: "divider" },
                            { key: "undo", label: "撤销", disabled: readOnly || !history.canUndo, onClick: history.undo },
                            { key: "redo", label: "重做", disabled: readOnly || !history.canRedo, onClick: history.redo },
                            { key: "save", label: saveState.status === "conflict" ? "处理保存冲突" : "立即保存", disabled: readOnly, onClick: () => void retrySave() },
                        ],
                    }}
                    status={<EditorSyncStatus
                        kind={readOnly ? "blocked" : saveState.status === "conflict" ? "conflict" : saveState.status === "error" ? "error" : saveState.status === "saving" || dirty ? "saving" : "saved"}
                        label={readOnly ? lease.status === "readonly" ? "另一标签页正在编辑" : lease.status === "error" ? "编辑权限检查失败" : "正在获取编辑权限" : saveState.status === "conflict" ? "版本冲突" : saveState.status === "error" ? "保存失败" : saveState.status === "saving" || dirty ? "保存中" : "已保存"}
                        detail={`流程版本 v${revision}`}
                        action={!readOnly && (saveState.status === "conflict" || saveState.status === "error") ? { label: saveState.status === "conflict" ? "处理冲突" : "重试", onClick: () => void retrySave() } : undefined}
                    />}
                    actions={
                        <>
                            {graph.frames?.length ? <Dropdown trigger={["click"]} menu={{ items: latestDownloadRuns.map((run) => ({ key: run.id, label: run.scopeType === "frame" ? run.frameName || "包裹框" : "整个流程", onClick: () => void downloadImages(run.id) })) }}>
                                <Button type="text" icon={<Download className="size-4" />} loading={downloading} disabled={!latestDownloadRuns.length}>下载 <ChevronDown className="size-3" /></Button>
                            </Dropdown> : <Button type="text" icon={<Download className="size-4" />} loading={downloading} disabled={!unframedRun || (currentRun.data?.run.id === unframedRun.id && !downloadImageCount)} onClick={() => void downloadImages(unframedRun?.id)}>下载</Button>}
                            {anyActive ? <Dropdown trigger={["click"]} menu={{ items: (runs.overview?.activeRuns.items || []).map((run) => ({ key: run.id, label: `${run.scopeType === "frame" ? run.frameName || "包裹框" : "整个流程"} · ${workflowRunStatusText(run.status)}`, onClick: () => openRun(run.id) })).concat([{ key: "history", label: "查看全部运行记录", onClick: () => void navigateAway(appPath("/workflow-runs")) }]) }}>
                                <Button type="text">{runs.overview?.activeRuns.total} 个运行中 <ChevronDown className="size-3" /></Button>
                            </Dropdown> : runs.selectedRun ? <Button type="text" onClick={() => openRun(runs.selectedRun!.id)}>{workflowRunStatusText(runs.selectedRun.status)}</Button> : unframedRun ? <Button type="text" onClick={() => openRun(unframedRun.id)}>{workflowRunStatusText(unframedRun.status)}</Button> : null}
                            {graph.frames?.length ? <Dropdown trigger={["click"]} menu={{ items: [
                                ...graph.frames.map((frame) => { const scope: WorkflowRunScope = { type: "frame", frameId: frame.id }; const state = scopeStates.get(workflowRunScopeKey(scope)); return { key: frame.id, label: `${frameLabel(frame)}${state?.activeRunId ? " · 运行中" : ""}`, disabled: runDisabled(scope), onClick: () => void startRun(scope) }; }),
                                { type: "divider" as const }, { key: "all", label: "运行全部", disabled: runDisabled({ type: "workflow" }), onClick: () => void startRun() },
                            ] }}><Button icon={<Play className="size-4" />} disabled={readOnly}>运行 <ChevronDown className="size-3" /></Button></Dropdown>
                            : <Button icon={<Play className="size-4" />} disabled={runDisabled({ type: "workflow" })} loading={startingScopes.has(workflowRunScopeKey({ type: "workflow" }))} onClick={() => void startRun()}>{runs.pendingByScope.has(workflowRunScopeKey({ type: "workflow" })) ? "确认上次运行" : "运行"}</Button>}
                        </>
                    }
                />
                <div className="relative min-h-0 flex-1">
                    <InfiniteCanvas
                        ref={canvasRef}
                        containerRef={containerRef}
                        viewport={viewport}
                        backgroundMode={backgroundMode}
                        onViewportChange={setViewport}
                        onCanvasMouseDown={readOnly ? undefined : (event) => { setTargetFrameId(undefined); interactions.handleCanvasMouseDown(event); }}
                        onCanvasDeselect={deselect}
                        onContextMenu={(event) => event.preventDefault()}
                    >
                        {visibleFrames.map((frame) => <CanvasFrame key={frame.id} frame={frame} selected={targetFrameId === frame.id} readOnly={editBlocked}
                            onSelect={() => { setTargetFrameId(frame.id); canvas.setSelectedNodeIds(new Set()); canvas.setSelectedConnectionId(null); }}
                            onMoveStart={frameGesture.start} hoveredDirection={frameResizeHover?.frameId === frame.id ? frameResizeHover.direction : undefined}
                            onRename={(id, nextName) => { if (!editBlockedRef.current) setGraph((current) => renameWorkflowFrame(current, id, nextName)); }}
                            headerActions={(() => {
                                const scope: WorkflowRunScope = { type: "frame", frameId: frame.id };
                                const key = workflowRunScopeKey(scope); const state = scopeStates.get(key);
                                return <><Button size="small" type="text" aria-label={`运行 ${frame.name}`} icon={<Play className="size-3.5" />} disabled={runDisabled(scope)} loading={startingScopes.has(key)} onClick={() => void startRun(scope)}><span data-frame-run-label>{runs.pendingByScope.has(key) ? "确认" : "运行"}</span></Button>
                                    {state?.activeRunId ? <Button size="small" type="text" aria-label={`停止 ${frame.name}`} icon={<Square className="size-3.5" />} loading={stoppingRuns.has(state.activeRunId)} onClick={() => void stopRun(state.activeRunId!)} /> : null}
                                    {state?.latestRun ? <button data-frame-run-status className="px-1 text-xs opacity-65" onClick={() => openRun(state.latestRun!.id)}>{workflowRunStatusText(state.latestRun.status)}</button> : null}</>;
                            })()}
                        />)}
                        <svg className="pointer-events-none absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible">
                            {renderDetail === "overview" && overviewConnectionPath ? <path data-workflow-connection-batch d={overviewConnectionPath} fill="none" stroke={theme.node.muted} strokeWidth="2" strokeOpacity=".82" /> : null}
                            {viewportScene.visibleConnections.filter((connection) => renderDetail === "full" || interactiveConnectionIds.has(connection.id)).map((connection) => {
                                const from = viewportScene.nodeById.get(connection.fromNodeId);
                                const to = viewportScene.nodeById.get(connection.toNodeId);
                                return from && to ? (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        pathD={connectionPathCache.get(connection.id)}
                                        active={canvas.selectedConnectionId === connection.id}
                                        pendingCut={interactions.cutConnectionState?.connectionIds.has(connection.id)}
                                        onSelect={(id) => {
                                            canvas.setSelectedConnectionId(id);
                                            canvas.setSelectedNodeIds(new Set());
                                        }}
                                    />
                                ) : null;
                            })}
                            {renderDetail === "overview" && overviewOutputPath ? <path data-workflow-output-batch d={overviewOutputPath} fill="none" stroke={theme.node.muted} strokeWidth="2" strokeOpacity=".55" /> : null}
                            {renderDetail === "full" ? viewportScene.visibleOutputLinks.map((link) => {
                                    const from = viewportScene.nodeById.get(link.fromNodeId);
                                    const to = viewportScene.nodeById.get(link.toNodeId);
                                    return from && to ? (
                                        <path
                                            key={link.id}
                                            d={outputPathCache.get(link.id)}
                                            fill="none"
                                            stroke={theme.node.muted}
                                            strokeWidth="2"
                                            strokeOpacity=".55"
                                        />
                                    ) : null;
                                }) : null}
                            {interactions.connectingParams ? <ActiveConnectionPath node={viewportScene.nodeById.get(interactions.connectingParams.nodeId)} handle={interactions.connectingParams} mouseWorld={interactions.mouseWorld} /> : null}
                            {interactions.cutConnectionState ? <polyline points={interactions.cutConnectionState.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={theme.node.activeStroke} strokeWidth="2" /> : null}
                        </svg>
                        {graph.nodes.filter((node) => viewportScene.visibleNodeIds.has(workflowVisualNodeId(node.id))).map((node) => (
                            <WorkflowNodeCard
                                key={node.id}
                                node={node}
                                selected={canvas.selectedNodeIds.has(workflowVisualNodeId(node.id))}
                                canvasNodeId={workflowVisualNodeId(node.id)}
                                renderDetail={workflowVisualRenderDetail(renderDetail, workflowVisualNodeId(node.id), retainedVisualNodeIds)}
                                readOnly={editBlocked}
                                onLayoutHeightChange={(height) => {
                                    if (height > (node.height || 240)) updateNode(node.id, (current) => ({ ...current, height }));
                                }}
                                onResizeStart={startResize}
                                onModeChange={(mode) => changeMode(node, mode)}
                                onPreviewMedia={() => setMediaPreview({ node })}
                                connecting={Boolean(interactions.connectingParams)}
                                videoVisible={isCanvasNodeNearViewport({ id: node.id, type: CanvasNodeType.Video, title: "", position: node.position, width: node.width || 420, height: node.height || 236 } satisfies CanvasNodeData, viewport, viewportSize)}
                                inputs={previewInputs(node.id)}
                                imageUrl={imageResources.resources.get(node.id)?.url}
                                imageStorageKey={imageResources.resources.get(node.id)?.storageKey}
                                imageError={imageResources.errors.get(node.id)}
                                onRetryImage={() => imageResources.retry(node.id)}
                                onImageLoaded={(storageKey) => imageResources.acknowledgeRendered(node.id, storageKey)}
                                onImageDimensions={(dimensions) => node.mediaId && fitLoadedImage(node.id, node.mediaId, dimensions)}
                                onDragStart={startNodeDrag}
                                onRemove={() => {
                                    if (!editBlockedRef.current) setGraph((current) => removeWorkflowNode(current, node.id));
                                }}
                                onChooseMedia={() => chooseMedia(node.id, node.type === "video_input" ? "video" : "image")}
                                onTextChange={(text) => updateNode(node.id, (current) => ({ ...current, text }))}
                                onConfigChange={(config) => updateNode(node.id, (current) => ({ ...current, config }))}
                                onOutputCountChange={(count) => changeOutputCount(node.id, count)}
                                onPreview={() => setPreviewNodeId(node.id)}
                                onConnectTarget={(event) => {
                                    if (event && !editBlocked) interactions.handleConnectStart(event, workflowVisualNodeId(node.id), "target");
                                }}
                                onStartSource={(event) => {
                                    if (event && !editBlocked) interactions.handleConnectStart(event, workflowVisualNodeId(node.id), "source");
                                }}
                            />
                        ))}
                        {graph.nodes.flatMap((node) =>
                            (node.outputs || []).filter((slot) => viewportScene.visibleNodeIds.has(workflowVisualOutputId(node.id, slot.id))).map((slot) => {
                                const output = compatibleOutputs.get(workflowOutputKey(node.id, slot.id));
                                const detail = runs.detailByNode.get(node.id);
                                const resourceNodeId = detail ? workflowOutputResourceNodeId(detail.run.id, node.id, slot.id) : undefined;
                                const retryKey = detail ? pendingWorkflowRetryKey({ runId: detail.run.id, nodeId: node.id, slotId: slot.id }) : "";
                                const resource = resourceNodeId ? imageResources.resources.get(resourceNodeId) : undefined;
                                return <WorkflowOutputCard
                                    key={workflowOutputKey(node.id, slot.id)}
                                    parent={node}
                                    slot={slot}
                                    execution={output}
                                    loadingExecution={Boolean(runs.overview?.nodeRunIds[node.id] && !detail)}
                                    executionLoadError={!detail && runs.error instanceof Error ? runs.error.message : undefined}
                                    resourceNodeId={resourceNodeId}
                                    videoVisible={isCanvasNodeNearViewport(
                                        { id: workflowOutputKey(node.id, slot.id), type: CanvasNodeType.Video, title: "", position: slot.position || node.position, width: slot.width || 420, height: slot.height || 236 } satisfies CanvasNodeData,
                                        viewport,
                                        viewportSize,
                                    )}
                                    imageUrl={resource?.url}
                                    imageStorageKey={resource?.storageKey}
                                    imageError={resourceNodeId ? imageResources.errors.get(resourceNodeId) : undefined}
                                    retrying={retryingKeys.has(retryKey)}
                                    confirmingRetry={runs.pendingRetryKeys.has(retryKey)}
                                    onReloadMedia={resourceNodeId ? () => imageResources.retry(resourceNodeId) : undefined}
                                    onRetryOutput={detail && isRetryableImageOutput(slot, output, detail.run) ? () => void startOutputRetry(detail.run.id, node.id, slot.id) : undefined}
                                    onImageLoaded={(storageKey) => resourceNodeId && imageResources.acknowledgeRendered(resourceNodeId, storageKey)}
                                    onImageDimensions={(dimensions) => {
                                        if (output?.mediaId) fitLoadedImage(node.id, output.mediaId, dimensions, slot.id);
                                    }}
                                    selected={canvas.selectedNodeIds.has(workflowVisualOutputId(node.id, slot.id))}
                                    canvasNodeId={workflowVisualOutputId(node.id, slot.id)}
                                    renderDetail={workflowVisualRenderDetail(renderDetail, workflowVisualOutputId(node.id, slot.id), retainedVisualNodeIds)}
                                    readOnly={editBlocked}
                                    onResizeStart={startResize}
                                    onPreviewMedia={() => setMediaPreview({ node, slot })}
                                    onDragStart={startOutputDrag}
                                    onRemove={() => {
                                        if (editBlockedRef.current) return;
                                        try {
                                            setGraph(removeWorkflowOutput(graph, node.id, slot.id));
                                        } catch (error) {
                                            message.error(error instanceof Error ? error.message : "无法删除输出");
                                        }
                                    }}
                                    onStartSource={(event) => {
                                        if (event && !editBlocked) interactions.handleConnectStart(event, workflowVisualOutputId(node.id, slot.id), "source");
                                    }}
                                />;
                            }),
                        )}
                        {interactions.selectionBox ? (
                            <div
                                className="pointer-events-none absolute z-[100] border"
                                style={{
                                    left: Math.min(interactions.selectionBox.startWorldX, interactions.selectionBox.currentWorldX),
                                    top: Math.min(interactions.selectionBox.startWorldY, interactions.selectionBox.currentWorldY),
                                    width: Math.abs(interactions.selectionBox.currentWorldX - interactions.selectionBox.startWorldX),
                                    height: Math.abs(interactions.selectionBox.currentWorldY - interactions.selectionBox.startWorldY),
                                    borderColor: theme.canvas.selectionStroke,
                                    background: theme.canvas.selectionFill,
                                }}
                            />
                        ) : null}
                        {interactions.pendingConnectionCreate ? (
                            <CanvasConnectionCreateMenu
                                title="连接并创建"
                                position={interactions.pendingConnectionCreate.position}
                                theme={theme}
                                onClose={interactions.cancelPendingConnectionCreate}
                                options={connectionCreateOptions.map(([type, label]) => ({
                                    id: type,
                                    title: label,
                                    icon: type === "text_input" ? <List className="size-5" /> : type === "video_input" || type === "video_generation" ? <Video className="size-5" /> : <ImageIcon className="size-5" />,
                                    onClick: () => canvas.createConnectedNode(type),
                                }))}
                            />
                        ) : null}
                    </InfiniteCanvas>
                    {readOnly ? <div className="pointer-events-none absolute inset-x-0 bottom-24 z-40 text-center text-xs opacity-60">{lease.status === "readonly" ? "当前流程由另一标签页编辑" : "正在确认编辑权限"}</div> : null}
                    <CanvasToolbar
                        homeLabel={home.label}
                        onHome={leave}
                        selectedCount={canvas.selectedNodeIds.size + (canvas.selectedConnectionId ? 1 : 0) + (frameOnlySelected ? 1 : 0)}
                        canUndo={!editBlocked && history.canUndo}
                        canRedo={!editBlocked && history.canRedo}
                        backgroundMode={backgroundMode}
                        showImageInfo={showImageInfo}
                        onAddText={() => {
                            if (!editBlocked) addNode("text_input");
                        }}
                        onAddImage={() => {
                            if (!editBlocked) chooseMedia(undefined, "image");
                        }}
                        onAddVideo={() => {
                            if (!editBlocked) chooseMedia(undefined, "video");
                        }}
                        onAddConfig={() => {
                            if (!editBlocked) addNode("image_generation");
                        }}
                        onUndo={() => {
                            if (!editBlocked) history.undo();
                        }}
                        onRedo={() => {
                            if (!editBlocked) history.redo();
                        }}
                        onUpload={() => {
                            if (!editBlocked) imageInputRef.current?.click();
                        }}
                        onDelete={deleteSelection}
                        onAddFrame={editBlocked ? undefined : addFrame}
                        onClear={() => {
                            if (!editBlocked)
                                modal.confirm({
                                    title: "清空当前流程？",
                                    content: "可以通过撤销恢复。",
                                    okText: "清空",
                                    cancelText: "取消",
                                    onOk: () => {
                                        setGraph(emptyWorkflowGraph());
                                        deselect();
                                    },
                                });
                        }}
                        onDeselect={deselect}
                        onBackgroundModeChange={setBackgroundMode}
                    />
                    <CanvasZoomControls
                        frameShortcuts
                        scale={viewport.k}
                        onScaleChange={(k) => setViewport((current) => ({ x: viewportSize.width / 2 - ((viewportSize.width / 2 - current.x) * k) / current.k, y: viewportSize.height / 2 - ((viewportSize.height / 2 - current.y) * k) / current.k, k }))}
                        onReset={resetView}
                        isMiniMapOpen={miniMapOpen}
                        onToggleMiniMap={() => setMiniMapOpen((open) => !open)}
                    />
                    {miniMapOpen ? <Minimap nodes={canvas.nodes} viewport={viewport} viewportSize={viewportSize} onViewportChange={setViewport} /> : null}
                </div>
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadImage(file);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/mp4"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadVideo(file);
                        event.target.value = "";
                    }}
                />
                <Modal
                    title={mediaTarget?.type === "video" ? "选择视频" : "选择图片"}
                    open={assetPickerOpen}
                    footer={
                        <Button
                            icon={mediaTarget?.type === "video" ? <Video className="size-4" /> : <ImageIcon className="size-4" />}
                            loading={uploading}
                            onClick={() => (mediaTarget?.type === "video" ? videoInputRef.current?.click() : imageInputRef.current?.click())}
                        >
                            上传{mediaTarget?.type === "video" ? "视频" : "图片"}
                        </Button>
                    }
                    onCancel={() => {
                        setAssetPickerOpen(false);
                        setMediaTarget(undefined);
                    }}
                    width={760}
                    destroyOnHidden
                >
                    {mediaTarget?.type === "video" ? (
                        workflowVideos.isPending ? (
                            <div className="flex min-h-48 items-center justify-center">
                                <Spin />
                            </div>
                        ) : workflowVideos.isError ? (
                            <Empty description={workflowVideos.error instanceof Error ? workflowVideos.error.message : "视频素材加载失败"}>
                                <Button onClick={() => void workflowVideos.refetch()}>重新加载</Button>
                            </Empty>
                        ) : workflowVideos.data.items.length ? (
                            <div className="grid max-h-[55vh] grid-cols-3 gap-3 overflow-auto sm:grid-cols-4">
                                {workflowVideos.data.items.map((video) => (
                                    <button key={video.id} type="button" className="overflow-hidden rounded-xl border border-stone-200 text-left dark:border-stone-700" onClick={() => selectAsset(video.id)}>
                                        <span className="flex aspect-[4/3] items-center justify-center bg-black text-white">
                                            <Video className="size-7" />
                                        </span>
                                        <span className="block truncate px-2 pt-1.5 text-xs">{video.title || video.filename || "视频素材"}</span>
                                        <span className="block px-2 pb-1.5 text-[11px] text-stone-500">{video.duration > 0 ? `${video.duration.toFixed(1)} 秒` : "视频"}</span>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <Empty description="暂无可用视频素材" />
                        )
                    ) : (
                        <div className="grid max-h-[55vh] grid-cols-3 gap-3 overflow-auto sm:grid-cols-4">
                            {assets.flatMap((asset) =>
                                asset.kind === "image" && typeof asset.metadata?.mediaId === "string"
                                    ? [<WorkflowImageAssetCard key={asset.id} mediaId={asset.metadata!.mediaId as string} title={asset.title} onSelect={() => selectAsset(asset.metadata!.mediaId as string)} />]
                                    : [],
                            )}
                        </div>
                    )}
                </Modal>
                <Modal title="预览" open={Boolean(mediaPreview)} footer={null} width={900} onCancel={() => setMediaPreview(undefined)} destroyOnHidden>
                    {mediaPreview
                        ? (() => {
                              const { node, slot } = mediaPreview;
                              const output = slot ? compatibleOutputs.get(workflowOutputKey(node.id, slot.id)) : undefined;
                              const mediaId = slot ? output?.mediaId : node.mediaId;
                              const resourceId = slot && output ? workflowOutputResourceNodeId(output.runId, node.id, slot.id) : node.id;
                              const resource = imageResources.resources.get(resourceId);
                              return (
                                  <div className="h-[65vh]">
                                      <WorkflowMediaPreview
                                          nodeId={resourceId}
                                          type={slot?.type || (node.type === "video_input" ? "video" : "image")}
                                          mediaId={mediaId}
                                          imageUrl={resource?.url}
                                          imageStorageKey={resource?.storageKey}
                                          imageError={imageResources.errors.get(resourceId)}
                                      />
                                  </div>
                              );
                          })()
                        : null}
                </Modal>
                <Modal title="输入预览" open={Boolean(previewNodeId)} footer={null} width={760} onCancel={() => setPreviewNodeId(undefined)} destroyOnHidden>
                    {activePreviewInputs.length ? (
                        <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-auto sm:grid-cols-3">
                            {activePreviewInputs.map((input) => (
                                <div key={input.key} className="aspect-square overflow-hidden rounded-xl border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
                                    {input.type === "text" ? (
                                        <div className="h-full overflow-auto whitespace-pre-wrap p-3 text-xs leading-5">{input.text || "空文本"}</div>
                                    ) : input.mediaId ? (
                                        <WorkflowMediaPreview
                                            nodeId={`preview-${input.sourceNodeId}-${input.key}`}
                                            type={input.type}
                                            mediaId={input.mediaId}
                                            imageUrl={input.imageUrl}
                                            imageStorageKey={input.imageStorageKey}
                                            imageError={input.imageError}
                                        />
                                    ) : (
                                        <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-stone-400">{input.type === "image" ? <ImageIcon className="size-6" /> : <Video className="size-6" />}运行后显示</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="py-12 text-center text-sm text-stone-500">暂无输入</div>
                    )}
                </Modal>
                <Drawer title="本次运行" open={runDetailOpen} width="min(920px, 94vw)" destroyOnHidden onClose={() => setRunDetailOpen(false)}>
                    {currentRun.isError ? (
                        <Empty description={currentRun.error instanceof Error ? currentRun.error.message : "运行详情加载失败"}>
                            <Button onClick={() => void currentRun.refetch()}>重新加载</Button>
                        </Empty>
                    ) : (
                        <WorkflowRunDetail
                            detail={currentRun.data}
                            stopping={Boolean(currentRun.data && stoppingRuns.has(currentRun.data.run.id))}
                            retryingKey={currentRun.data?.outputs.filter((output) => retryingKeys.has(pendingWorkflowRetryKey(output))).map((output) => workflowOutputKey(output.nodeId, output.slotId))[0]}
                            confirmingRetryKeys={new Set(currentRun.data?.outputs.filter((output) => runs.pendingRetryKeys.has(pendingWorkflowRetryKey(output))).map((output) => workflowOutputKey(output.nodeId, output.slotId)))}
                            onStop={currentRun.data ? () => void stopRun(currentRun.data!.run.id) : undefined}
                            onRetry={currentRun.data ? (nodeId, slotId) => void startOutputRetry(currentRun.data!.run.id, nodeId, slotId) : undefined}
                        />
                    )}
                </Drawer>
            </main>
        </ScopedVideoResourceProvider>
    );
}
