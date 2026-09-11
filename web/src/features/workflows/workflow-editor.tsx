"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Empty, Modal, Spin } from "antd";
import { Download, Image as ImageIcon, List, Play, Square, Video } from "lucide-react";
import { nanoid } from "nanoid";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

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
import { isCanvasNodeNearViewport } from "@/app/(user)/canvas/utils/canvas-node-visibility";
import { readImageMeta } from "@/lib/image-utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { isEditableTarget } from "@/lib/editable-target";
import { uploadUserImage } from "@/services/api/image";
import { ApiRequestError } from "@/services/api/request";
import { uploadVideoMedia } from "@/services/api/video-media";
import { createWorkflowRun, fetchWorkflow, fetchWorkflowRun, fetchWorkflowRuns, fetchWorkflowVideos, retryWorkflowOutput, stopWorkflowRun, updateWorkflow } from "@/services/api/workflows";
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
import {
    clearPendingWorkflowRetryRequest,
    clearPendingWorkflowRunRequest,
    ensureWorkflowRetryRequest,
    ensureWorkflowRunRequest,
    pendingWorkflowRetryKey,
    readPendingWorkflowRetryRequests,
    readPendingWorkflowRunRequest,
    workflowRetryWasAccepted,
    writePendingWorkflowRetryRequest,
    writePendingWorkflowRunRequest,
    type PendingWorkflowRetryRequest,
    type PendingWorkflowRunRequest,
} from "./workflow-run-requests";
import { workflowDownloadImageCount, indexCompatibleWorkflowOutputs, findCompatibleWorkflowOutput, findWorkflowOutput, isRetryableImageOutput, isWorkflowRunActive, latestWorkflowRun, workflowOutputKey, workflowOutputResourceNodeId, workflowRunStatusText } from "./workflow-run-state";
import { observeWorkflowViewport } from "./workflow-viewport";
import type { WorkflowConnection, WorkflowGraph, WorkflowNode, WorkflowNodeType, WorkflowOutputSlot, WorkflowPosition } from "./types";

type Viewport = { x: number; y: number; k: number };

function isDefinitiveWorkflowMutationError(error: unknown) {
    return error instanceof ApiRequestError && error.status >= 400 && error.status < 500;
}

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

    const requestRestoreScopeRef = useRef("");
    const retryRestoreScopeRef = useRef("");
    const [name, setName] = useState("");
    const [graph, setGraph] = useState<WorkflowGraph>(emptyWorkflowGraph);
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
    const [starting, setStarting] = useState(false);
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

    const [currentRunId, setCurrentRunId] = useState<string | null>();
    const [runDetailOpen, setRunDetailOpen] = useState(false);
    const [pendingRunRequest, setPendingRunRequest] = useState<PendingWorkflowRunRequest>();
    const [pendingRetryRequests, setPendingRetryRequests] = useState<Record<string, PendingWorkflowRetryRequest>>({});

    const workflow = useQuery({ queryKey: workflowDetailQueryKey(workflowId), queryFn: () => fetchWorkflow(workflowId!), enabled: Boolean(workflowId), refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false });
    const lease = useWorkflowEditorLease(draftOwnerUID, workflow.data ? workflowId : undefined, async (signal?: AbortSignal) => refreshForLease.current(signal));
    const readOnly = !lease.editable || draftRecoveryPending;
    const editBlocked = readOnly || starting || Boolean(pendingRunRequest);
    const editBlockedRef = useRef(editBlocked);
    editBlockedRef.current = editBlocked;
    const workflowVideos = useQuery({ queryKey: ["workflow-video-assets"], queryFn: fetchWorkflowVideos, enabled: assetPickerOpen && mediaTarget?.type === "video" });
    const workflowRuns = useQuery({
        queryKey: ["workflow-runs", "workflow", workflowId],
        queryFn: () => fetchWorkflowRuns(1, 1, workflowId),
        enabled: Boolean(workflowId && workflow.data),
        refetchInterval: (query) => (query.state.data?.items.some((run) => run.workflowId === workflowId && isWorkflowRunActive(run.status)) ? 2500 : false),
    });
    const currentRun = useQuery({
        queryKey: ["workflow-run", currentRunId],
        queryFn: () => fetchWorkflowRun(currentRunId!),
        enabled: Boolean(currentRunId),
        refetchInterval: (query) => (isWorkflowRunActive(query.state.data?.run.status) ? 1500 : false),
    });
    const compatibleOutputs = useMemo(() => indexCompatibleWorkflowOutputs(currentRun.data, graph), [currentRun.data, graph]);
    const downloadImageCount = useMemo(() => workflowDownloadImageCount(currentRun.data), [currentRun.data]);
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
    useEffect(() => {
        setCurrentRunId(undefined);
        setRunDetailOpen(false);
        setPendingRunRequest(undefined);
        setPendingRetryRequests({});
        requestRestoreScopeRef.current = "";
        retryRestoreScopeRef.current = "";
    }, [workflowId]);
    useEffect(() => {
        if (!draftOwnerUID || !workflowId || !workflow.data || revision < 1 || typeof window === "undefined") return;
        const scope = `${draftOwnerUID}:${workflowId}:${revision}`;
        if (requestRestoreScopeRef.current === scope) return;
        requestRestoreScopeRef.current = scope;
        setPendingRunRequest(readPendingWorkflowRunRequest(window.sessionStorage, draftOwnerUID, workflowId));
    }, [draftOwnerUID, revision, workflow.data, workflowId]);
    useEffect(() => {
        if (currentRunId !== undefined || !workflowRuns.data) return;
        setCurrentRunId(latestWorkflowRun(workflowRuns.data.items, workflowId)?.id || null);
    }, [currentRunId, workflowId, workflowRuns.data]);
    useEffect(() => {
        if (!draftOwnerUID || !currentRunId || typeof window === "undefined") return;
        const scope = `${draftOwnerUID}:${currentRunId}`;
        if (retryRestoreScopeRef.current === scope) return;
        retryRestoreScopeRef.current = scope;
        const restored = readPendingWorkflowRetryRequests(window.sessionStorage, draftOwnerUID, currentRunId);
        if (restored.length) setPendingRetryRequests((current) => ({ ...current, ...Object.fromEntries(restored.map((request) => [pendingWorkflowRetryKey(request), request])) }));
    }, [currentRunId, draftOwnerUID]);
    useEffect(() => {
        if (!pendingRunRequest || !workflowRuns.data) return;
        const accepted = workflowRuns.data.items.find((run) => run.requestId === pendingRunRequest.requestId && run.workflowId === pendingRunRequest.workflowId);
        if (!accepted) return;
        setCurrentRunId(accepted.id);
        if (draftOwnerUID && typeof window !== "undefined") clearPendingWorkflowRunRequest(window.sessionStorage, draftOwnerUID, pendingRunRequest.workflowId);
        setPendingRunRequest(undefined);
    }, [draftOwnerUID, pendingRunRequest, workflowRuns.data]);
    useEffect(() => {
        if (!currentRun.data) return;
        const accepted = Object.entries(pendingRetryRequests).filter(([, pending]) => pending.runId === currentRun.data!.run.id && workflowRetryWasAccepted(pending, findWorkflowOutput(currentRun.data!.outputs, pending.nodeId, pending.slotId)));
        if (!accepted.length) return;
        if (draftOwnerUID && typeof window !== "undefined") accepted.forEach(([, pending]) => clearPendingWorkflowRetryRequest(window.sessionStorage, draftOwnerUID, pending));
        setPendingRetryRequests((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !accepted.some(([acceptedKey]) => acceptedKey === key))));
    }, [currentRun.data, draftOwnerUID, pendingRetryRequests]);

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
                        return output?.mediaId && currentRun.data ? [workflowOutputResourceNodeId(currentRun.data.run.id, source.id, connection.sourceSlotId)] : [];
                    })
                    .concat(mediaPreview ? [mediaPreview.slot && currentRun.data ? workflowOutputResourceNodeId(currentRun.data.run.id, mediaPreview.node.id, mediaPreview.slot.id) : mediaPreview.node.id] : []),
            ),
        [compatibleOutputs, currentRun.data, inputConnectionsByTarget, nodesById, previewNodeId, mediaPreview],
    );
    const imageTargets = useMemo(() => {
        const inputTargets = graph.nodes.flatMap((node) => {
            if (node.type !== "image_input" || !node.mediaId) return [];
            const canvasNode = { id: node.id, type: CanvasNodeType.Image, title: "", position: node.position, width: node.width || 340, height: node.height || 240, metadata: { mediaId: node.mediaId } } satisfies CanvasNodeData;
            const visible = isCanvasNodeNearViewport(canvasNode, viewport, viewportSize);
            const preview = previewImageNodeIds.has(node.id);
            const prefetch = !visible && isCanvasNodeNearViewport(canvasNode, viewport, viewportSize, 384);
            if (!visible && !prefetch && !preview) return [];
            return [{ node: canvasNode, visible, pinned: preview, prefetch, preview }];
        });
        const outputTargets = graph.nodes.flatMap((node) =>
            (node.outputs || []).flatMap((slot) => {
                if (slot.type !== "image" || !currentRun.data) return [];
                const output = compatibleOutputs.get(workflowOutputKey(node.id, slot.id));
                if (output?.status !== "succeeded" || !output.mediaId) return [];
                const canvasNode = {
                    id: workflowOutputResourceNodeId(currentRun.data.run.id, node.id, slot.id),
                    type: CanvasNodeType.Image,
                    title: "",
                    position: slot.position || node.position,
                    width: slot.width || 340,
                    height: slot.height || 240,
                    metadata: { mediaId: output.mediaId },
                } satisfies CanvasNodeData;
                const visible = isCanvasNodeNearViewport(canvasNode, viewport, viewportSize);
                const preview = previewImageNodeIds.has(canvasNode.id);
                const prefetch = !visible && isCanvasNodeNearViewport(canvasNode, viewport, viewportSize, 384);
                if (!visible && !prefetch && !preview) return [];
                return [{ node: canvasNode, visible, pinned: preview, prefetch, preview }];
            }),
        );
        return [...inputTargets, ...outputTargets];
    }, [compatibleOutputs, currentRun.data, graph.nodes, previewImageNodeIds, viewport, viewportSize]);
    const imageDimensions = useRef(new Map<string, { width: number; height: number }>());
    const resolveImageAccess = useCallback(async (node: CanvasNodeData) => {
        const mediaId = node.metadata!.mediaId!;
        const access = await getRemoteImageAccess(mediaId);
        if (access.width && access.height) imageDimensions.current.set(mediaId, { width: access.width, height: access.height });
        return access;
    }, []);
    const imageResources = useCanvasImageResources({ targets: imageTargets, scale: viewport.k, resolveAccess: resolveImageAccess });
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
    const cacheRun = useCallback(
        (detail: NonNullable<typeof currentRun.data>) => {
            queryClient.setQueryData(["workflow-run", detail.run.id], detail);
            setCurrentRunId(detail.run.id);
            void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
        },
        [queryClient],
    );
    const createRun = useMutation({
        retry: false,
        mutationFn: (request: PendingWorkflowRunRequest) => createWorkflowRun(request.workflowId, request.requestId, request.revision),
        onSuccess: (detail, request) => {
            cacheRun(detail);
            if (draftOwnerUID && typeof window !== "undefined") clearPendingWorkflowRunRequest(window.sessionStorage, draftOwnerUID, request.workflowId);
            setPendingRunRequest((current) => (current?.requestId === request.requestId ? undefined : current));
            message.success("流程已开始运行");
        },
        onError: (error, request) => {
            if (isDefinitiveWorkflowMutationError(error)) {
                if (draftOwnerUID && typeof window !== "undefined") clearPendingWorkflowRunRequest(window.sessionStorage, draftOwnerUID, request.workflowId);
                setPendingRunRequest((current) => (current?.requestId === request.requestId ? undefined : current));
            } else {
                void workflowRuns.refetch();
                message.warning("运行请求结果待确认，可再次点击并使用同一请求确认");
                return;
            }
            message.error(error instanceof Error ? error.message : "启动流程失败");
        },
    });
    const stopRun = useMutation({
        mutationFn: (runId: string) => stopWorkflowRun(runId),
        onSuccess: (detail) => {
            cacheRun(detail);
            message.success("已停止领取新的生成任务");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "停止流程失败"),
    });
    const retryOutput = useMutation({
        retry: false,
        mutationFn: (request: PendingWorkflowRetryRequest) => retryWorkflowOutput(request.runId, { requestId: request.requestId, nodeId: request.nodeId, slotId: request.slotId }),
        onSuccess: (detail, request) => {
            cacheRun(detail);
            const key = pendingWorkflowRetryKey(request);
            if (draftOwnerUID && typeof window !== "undefined") clearPendingWorkflowRetryRequest(window.sessionStorage, draftOwnerUID, request);
            setPendingRetryRequests((current) => {
                if (current[key]?.requestId !== request.requestId) return current;
                const next = { ...current };
                delete next[key];
                return next;
            });
            message.success("已重新提交失败输出");
        },
        onError: (error, request) => {
            if (isDefinitiveWorkflowMutationError(error)) {
                const key = pendingWorkflowRetryKey(request);
                if (draftOwnerUID && typeof window !== "undefined") clearPendingWorkflowRetryRequest(window.sessionStorage, draftOwnerUID, request);
                setPendingRetryRequests((current) => {
                    if (current[key]?.requestId !== request.requestId) return current;
                    const next = { ...current };
                    delete next[key];
                    return next;
                });
                message.error(error instanceof Error ? error.message : "重试输出失败");
                return;
            }
            void currentRun.refetch();
            message.warning("重试请求结果待确认，可再次点击并使用同一请求确认");
        },
    });

    const startRun = async () => {
        if (starting || createRun.isPending || readOnly) return;
        setStarting(true);
        try {
            let confirmedRevision = revision;
            if (!pendingRunRequest) {
                autosave.update(editorDocumentRef.current);
                confirmedRevision = await autosave.flush();
            }
            const request = ensureWorkflowRunRequest(pendingRunRequest, workflowId!, confirmedRevision, nanoid);
            if (draftOwnerUID) writePendingWorkflowRunRequest(window.sessionStorage, draftOwnerUID, request);
            setPendingRunRequest(request);
            createRun.mutate(request);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存完成后才能运行");
        } finally {
            setStarting(false);
        }
    };
    const startOutputRetry = (nodeId: string, slotId: string) => {
        if (!currentRun.data) return;
        const output = compatibleOutputs.get(workflowOutputKey(nodeId, slotId));
        if (!output) return;
        const key = pendingWorkflowRetryKey({ runId: currentRun.data.run.id, nodeId, slotId });
        const request = ensureWorkflowRetryRequest(pendingRetryRequests[key], { runId: currentRun.data.run.id, nodeId, slotId, attempt: output.attempt }, nanoid);
        if (draftOwnerUID && typeof window !== "undefined") writePendingWorkflowRetryRequest(window.sessionStorage, draftOwnerUID, request);
        setPendingRetryRequests((current) => ({ ...current, [key]: request }));
        retryOutput.mutate(request);
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
            setGraph((current) => ({ ...current, nodes: [...current.nodes, node] }));
            canvas.setSelectedNodeIds(new Set([workflowVisualNodeId(node.id)]));
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
                const output = currentRun.data && findCompatibleWorkflowOutput(currentRun.data, current, nodeId, slotId);
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

    const previewInputs = useCallback(
        (targetId: string): WorkflowPreviewInput[] =>
            (inputConnectionsByTarget.get(targetId) || [])
                .flatMap((connection) => {
                    const source = nodesById.get(connection.sourceNodeId);
                    if (!source) return [];
                    const type = workflowSourceType(source, connection.sourceSlotId);
                    if (!type) return [];
                    const execution = connection.sourceSlotId === "output" || !currentRun.data ? undefined : compatibleOutputs.get(workflowOutputKey(source.id, connection.sourceSlotId));
                    const resourceNodeId = execution && currentRun.data ? workflowOutputResourceNodeId(currentRun.data.run.id, source.id, connection.sourceSlotId) : source.id;
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
        [compatibleOutputs, currentRun.data, inputConnectionsByTarget, nodesById, imageResources.errors, imageResources.resources],
    );
    const activePreviewInputs = previewNodeId ? previewInputs(previewNodeId) : [];

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
    });
    const { interactions } = canvas;
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
        canvas.setSelectedNodeIds(new Set());
        canvas.setSelectedConnectionId(null);
        interactions.resetInteractionState();
    };
    const startNodeDrag = (event: ReactPointerEvent, node: WorkflowNode) => {
        if (event.button !== 0 || (event.target as Element).closest("button,input,textarea,.ant-select,[contenteditable=true],[data-canvas-no-drag]")) return;
        if (!editBlockedRef.current) interactions.handleNodeMouseDown(event, workflowVisualNodeId(node.id));
    };
    const startOutputDrag = (event: ReactPointerEvent, node: WorkflowNode, slot: WorkflowOutputSlot) => {
        if (event.button !== 0 || (event.target as Element).closest("button,input,[data-canvas-no-drag]")) return;
        if (!editBlockedRef.current) interactions.handleNodeMouseDown(event, workflowVisualOutputId(node.id, slot.id));
    };
    useEffect(() => {
        autosave.update({ name, graph });
        autosave.setEnabled(!readOnly && !interactions.isNodeDragging && !resizing && !pendingRunRequest);
    }, [autosave, name, graph, readOnly, interactions.isNodeDragging, resizing, pendingRunRequest]);
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
                deselect();
                return;
            }
            if (editBlocked || interactions.isNodeDragging || resizing) return;
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
                if (canvas.copySelection()) event.preventDefault();
            } else if (modifier && event.key.toLowerCase() === "v") {
                if (canvas.pasteSelection()) event.preventDefault();
            } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                canvas.deleteSelection();
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
    const downloadImages = async () => {
        if (!currentRun.data || downloadController.current) return;
        const controller = new AbortController();
        downloadController.current = controller;
        setDownloading(true);
        try {
            const count = await downloadWorkflowImages(currentRun.data.run.id, controller.signal);
            if (count) message.success(`已发起下载，共 ${count} 张图片`);
        } catch (error) {
            if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : "发起下载失败");
        } finally {
            downloadController.current = null;
            if (!controller.signal.aborted) setDownloading(false);
        }
    };
    const leave = () => navigateAway(home.href);
    const latestRunSummary = latestWorkflowRun(workflowRuns.data?.items, workflowId);
    const runActive = isWorkflowRunActive(currentRun.data?.run.status || latestRunSummary?.status);

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
            scope={`workflow:${workflowId}:run:${currentRun.data?.run.id || "definition"}`}
            nodeIds={[
                ...graph.nodes.filter((node) => node.type === "video_input").map((node) => node.id),
                ...graph.nodes.flatMap((node) =>
                    (node.outputs || []).flatMap((slot) =>
                        slot.type === "video" && currentRun.data && compatibleOutputs.get(workflowOutputKey(node.id, slot.id))?.mediaId ? [workflowOutputResourceNodeId(currentRun.data.run.id, node.id, slot.id)] : [],
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
                            { type: "divider" },
                            { key: "undo", label: "撤销", disabled: readOnly || !history.canUndo, onClick: history.undo },
                            { key: "redo", label: "重做", disabled: readOnly || !history.canRedo, onClick: history.redo },
                            { key: "save", label: saveState.status === "conflict" ? "处理保存冲突" : "立即保存", disabled: readOnly || Boolean(pendingRunRequest), onClick: () => void retrySave() },
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
                            <Button type="text" icon={<Download className="size-4" />} loading={downloading} disabled={!downloadImageCount} onClick={() => void downloadImages()}>
                                下载
                            </Button>
                            {currentRun.data ? (
                                <Button type="text" onClick={() => setRunDetailOpen(true)}>
                                    {workflowRunStatusText(currentRun.data.run.status)}
                                </Button>
                            ) : null}
                            {runActive && currentRun.data && !currentRun.data.run.stopRequested ? (
                                <Button danger icon={<Square className="size-4" />} loading={stopRun.isPending} onClick={() => stopRun.mutate(currentRun.data.run.id)}>
                                    停止
                                </Button>
                            ) : null}
                            <Button icon={<Play className="size-4" />} disabled={readOnly || runActive || resizing || interactions.isNodeDragging} loading={starting || createRun.isPending} onClick={() => void startRun()}>
                                {pendingRunRequest ? "确认上次运行" : "运行"}
                            </Button>
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
                        onCanvasMouseDown={readOnly ? undefined : interactions.handleCanvasMouseDown}
                        onCanvasDeselect={deselect}
                        onContextMenu={(event) => event.preventDefault()}
                    >
                        <svg className="pointer-events-none absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible">
                            {canvas.connections.map((connection) => {
                                const from = canvas.nodes.find((node) => node.id === connection.fromNodeId);
                                const to = canvas.nodes.find((node) => node.id === connection.toNodeId);
                                return from && to ? (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={canvas.selectedConnectionId === connection.id}
                                        pendingCut={interactions.cutConnectionState?.connectionIds.has(connection.id)}
                                        onSelect={(id) => {
                                            canvas.setSelectedConnectionId(id);
                                            canvas.setSelectedNodeIds(new Set());
                                        }}
                                    />
                                ) : null;
                            })}
                            {graph.nodes.flatMap((node) =>
                                (node.outputs || []).map((slot) => {
                                    const from = canvas.nodes.find((item) => item.id === workflowVisualNodeId(node.id));
                                    const to = canvas.nodes.find((item) => item.id === workflowVisualOutputId(node.id, slot.id));
                                    return from && to ? (
                                        <path
                                            key={workflowVisualOutputId(node.id, slot.id)}
                                            d={`M ${from.position.x + from.width} ${from.position.y + from.height / 2} C ${from.position.x + from.width + 48} ${from.position.y + from.height / 2}, ${to.position.x - 48} ${to.position.y + to.height / 2}, ${to.position.x} ${to.position.y + to.height / 2}`}
                                            fill="none"
                                            stroke={theme.node.muted}
                                            strokeWidth="2"
                                            strokeOpacity=".55"
                                        />
                                    ) : null;
                                }),
                            )}
                            {interactions.connectingParams ? <ActiveConnectionPath node={canvas.nodes.find((node) => node.id === interactions.connectingParams?.nodeId)} handle={interactions.connectingParams} mouseWorld={interactions.mouseWorld} /> : null}
                            {interactions.cutConnectionState ? <polyline points={interactions.cutConnectionState.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={theme.node.activeStroke} strokeWidth="2" /> : null}
                        </svg>
                        {graph.nodes.map((node) => (
                            <WorkflowNodeCard
                                key={node.id}
                                node={node}
                                selected={canvas.selectedNodeIds.has(workflowVisualNodeId(node.id))}
                                canvasNodeId={workflowVisualNodeId(node.id)}
                                viewport={viewport}
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
                            (node.outputs || []).map((slot) => {
                                const output = compatibleOutputs.get(workflowOutputKey(node.id, slot.id));
                                const resourceNodeId = currentRun.data ? workflowOutputResourceNodeId(currentRun.data.run.id, node.id, slot.id) : undefined;
                                const resource = resourceNodeId ? imageResources.resources.get(resourceNodeId) : undefined;
                                return <WorkflowOutputCard
                                    key={workflowOutputKey(node.id, slot.id)}
                                    parent={node}
                                    slot={slot}
                                    execution={output}
                                    resourceNodeId={resourceNodeId}
                                    videoVisible={isCanvasNodeNearViewport(
                                        { id: workflowOutputKey(node.id, slot.id), type: CanvasNodeType.Video, title: "", position: slot.position || node.position, width: slot.width || 420, height: slot.height || 236 } satisfies CanvasNodeData,
                                        viewport,
                                        viewportSize,
                                    )}
                                    imageUrl={resource?.url}
                                    imageStorageKey={resource?.storageKey}
                                    imageError={resourceNodeId ? imageResources.errors.get(resourceNodeId) : undefined}
                                    retrying={retryOutput.isPending && retryOutput.variables?.nodeId === node.id && retryOutput.variables.slotId === slot.id}
                                    confirmingRetry={Boolean(currentRun.data && pendingRetryRequests[pendingWorkflowRetryKey({ runId: currentRun.data.run.id, nodeId: node.id, slotId: slot.id })])}
                                    onReloadMedia={resourceNodeId ? () => imageResources.retry(resourceNodeId) : undefined}
                                    onRetryOutput={currentRun.data && isRetryableImageOutput(slot, output, currentRun.data.run) ? () => startOutputRetry(node.id, slot.id) : undefined}
                                    onImageLoaded={(storageKey) => resourceNodeId && imageResources.acknowledgeRendered(resourceNodeId, storageKey)}
                                    onImageDimensions={(dimensions) => {
                                        if (output?.mediaId) fitLoadedImage(node.id, output.mediaId, dimensions, slot.id);
                                    }}
                                    selected={canvas.selectedNodeIds.has(workflowVisualOutputId(node.id, slot.id))}
                                    canvasNodeId={workflowVisualOutputId(node.id, slot.id)}
                                    viewport={viewport}
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
                        selectedCount={canvas.selectedNodeIds.size + (canvas.selectedConnectionId ? 1 : 0)}
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
                        onDelete={canvas.deleteSelection}
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
                              const output = slot && currentRun.data ? compatibleOutputs.get(workflowOutputKey(node.id, slot.id)) : undefined;
                              const mediaId = slot ? output?.mediaId : node.mediaId;
                              const resourceId = slot && currentRun.data ? workflowOutputResourceNodeId(currentRun.data.run.id, node.id, slot.id) : node.id;
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
                            stopping={stopRun.isPending}
                            retryingKey={retryOutput.isPending && retryOutput.variables ? workflowOutputKey(retryOutput.variables.nodeId, retryOutput.variables.slotId) : undefined}
                            confirmingRetryKeys={
                                new Set(
                                    Object.values(pendingRetryRequests)
                                        .filter((request) => request.runId === currentRun.data?.run.id)
                                        .map((request) => workflowOutputKey(request.nodeId, request.slotId)),
                                )
                            }
                            onStop={currentRun.data ? () => stopRun.mutate(currentRun.data.run.id) : undefined}
                            onRetry={currentRun.data ? startOutputRetry : undefined}
                        />
                    )}
                </Drawer>
            </main>
        </ScopedVideoResourceProvider>
    );
}
