import { nanoid } from "nanoid";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { canvasDocumentStorage, type CanvasDocumentStorage } from "@/lib/localforage-storage";
import { canvasProjectsApi, type CanvasProjectDocument, type CanvasProjectDetail, type CanvasSummary, type CanvasProjectsApi, type CanvasProjectWriteTrace } from "@/services/api/canvas-projects";
import { ApiRequestError } from "@/services/api/request";
import { sanitizeCanvasProjectDocument } from "@/services/canvas-project-document";
import { summarizeCanvasProject } from "@/services/canvas-project-summary";
import { mergeNormalizedLegacyNodes } from "@/services/canvas-project-bootstrap";
import { migrateCanvasMaskResources, type CanvasMaskResources } from "../image-mask/mask-resources";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "../types";
import { createCanvasProjectCopy, nextCanvasProjectCopyTitle } from "../utils/canvas-project-copy";
import { isLocalImageUploadNode } from "../utils/canvas-local-image-upload";
import { createCanvasProjectWriteTracer } from "../sync/canvas-project-write-trace";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    maskResources: CanvasMaskResources;
    connections: CanvasConnection[];
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasProjectSync = {
    serverRevision: number | null;
    dirty: boolean;
    pending: boolean;
    saving: boolean;
    offline: boolean;
    error: string | null;
    conflict: boolean;
    operation: "save" | "delete";
    deletedProject?: CanvasProject;
    unknownRequest?: CanvasProjectSaveRequestSnapshot;
    needsRevalidation?: boolean;
    pauseReason?: "rejected" | "permission" | "recovery";
};

type CanvasProjectSaveRequestSnapshot = {
    trace: CanvasProjectWriteTrace;
    baseRevision: number;
    title: string;
    document: CanvasProjectDocument;
};

export type CanvasBootstrapStatus = "loading" | "ready" | "offline" | "error";
type CanvasProjectPatch = Partial<Pick<CanvasProject, "nodes" | "maskResources" | "connections" | "backgroundMode" | "showImageInfo" | "viewport">>;

export type CanvasStore = {
    hydrated: boolean;
    bootstrapStatus: CanvasBootstrapStatus;
    bootstrapError: string | null;
    bootstrapRetry: (() => Promise<void>) | null;
    readyForCanvasMutations: boolean;
    canonicalGeneration: number;
    projects: CanvasProject[];
    summaries: CanvasSummary[];
    summariesLoaded: boolean;
    projectSync: Record<string, CanvasProjectSync>;
    blockedProjectSync: Record<string, true>;
    syncScope: string | null;
    syncEnabled: boolean;
    hydrate: (scope?: string) => Promise<void>;
    markBootstrapUnavailable: (scope: string, error?: unknown) => void;
    setBootstrapRetry: (retry: (() => Promise<void>) | null) => void;
    retryBootstrap: () => Promise<void>;
    startSync: (scope: string) => void;
    setProjectSyncBlocked: (id: string, blocked: boolean) => void;
    releaseProjectEditor: (id: string) => void;
    adoptImportedProjects: (projects: CanvasProjectDetail[], snapshots: Map<string, CanvasProject>) => void;
    applyLegacyImageNormalization: (id: string, capturedNodes: CanvasNodeData[], normalizedNodes: CanvasNodeData[]) => boolean;
    replaceProjectsFromServer: (projects: CanvasProjectDetail[], notifyEditor?: boolean) => void;
    mergeProjectSummaries: (summaries: CanvasSummary[]) => void;
    ensureProjectDetail: (id: string, options?: { revalidate?: boolean }) => Promise<CanvasProject>;
    refreshProjectFromServer: (id: string) => Promise<void>;
    retryPendingSaves: (projectId?: string) => Promise<void>;
    createProject: (title?: string) => string;
    duplicateProject: (id: string) => string | null;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: CanvasProjectPatch) => void;
};

type CanvasStoreOptions = {
    api?: CanvasProjectsApi;
    storage?: PersistStorage<CanvasStore>;
    serverDebounceMs?: number;
    isOnline?: () => boolean;
    writeTracer?: { next: (reason: CanvasProjectWriteTrace["reason"]) => CanvasProjectWriteTrace };
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const CANVAS_GUEST_SCOPE = "guest";
const DEFAULT_SERVER_DEBOUNCE_MS = 300;

const onlineCallbacks = new Set<() => void>();
let onlineListenerInstalled = false;

function subscribeToBrowserOnline(callback: () => void) {
    onlineCallbacks.add(callback);
    if (typeof window === "undefined" || onlineListenerInstalled) return;
    window.addEventListener("online", () => onlineCallbacks.forEach((listener) => listener()));
    onlineListenerInstalled = true;
}

function browserIsOnline() {
    return typeof navigator === "undefined" || navigator.onLine;
}

function cleanSyncState(serverRevision: number | null): CanvasProjectSync {
    return {
        serverRevision,
        dirty: false,
        pending: false,
        saving: false,
        offline: false,
        error: null,
        conflict: false,
        operation: "save",
    };
}

function pendingSyncState(previous?: CanvasProjectSync, operation: CanvasProjectSync["operation"] = "save", deletedProject?: CanvasProject): CanvasProjectSync {
    const next: CanvasProjectSync = {
        ...(previous || cleanSyncState(null)),
        dirty: true,
        pending: true,
        error: null,
        operation,
    };
    if (deletedProject) next.deletedProject = deletedProject;
    else if (operation === "save") delete next.deletedProject;
    return next;
}

function canvasDocument(project: CanvasProject): CanvasProjectDocument {
    return sanitizeCanvasProjectDocument({
        nodes: project.nodes,
        maskResources: project.maskResources,
        connections: project.connections,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    });
}

function localProject(project: CanvasProjectDetail): CanvasProject {
    return sanitizeCanvasProject({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodes: project.document.nodes,
        maskResources: project.document.maskResources || {},
        connections: project.document.connections,
        backgroundMode: project.document.backgroundMode,
        showImageInfo: project.document.showImageInfo,
        viewport: project.document.viewport,
    });
}

function preserveLocalImageUploads(server: CanvasProject, local: CanvasProject): CanvasProject {
    const serverNodeIds = new Set(server.nodes.map((node) => node.id));
    const localNodes = local.nodes.filter((node) => isLocalImageUploadNode(node) && !serverNodeIds.has(node.id));
    if (!localNodes.length) return server;

    const localNodeIds = new Set(localNodes.map((node) => node.id));
    const allNodeIds = new Set([...serverNodeIds, ...localNodeIds]);
    const serverConnectionIds = new Set(server.connections.map((connection) => connection.id));
    const localConnections = local.connections.filter(
        (connection) => !serverConnectionIds.has(connection.id) && (localNodeIds.has(connection.fromNodeId) || localNodeIds.has(connection.toNodeId)) && allNodeIds.has(connection.fromNodeId) && allNodeIds.has(connection.toNodeId),
    );
    return { ...server, nodes: [...server.nodes, ...localNodes], connections: [...server.connections, ...localConnections] };
}

function validSaveRequest(value: CanvasProjectSaveRequestSnapshot) {
    try {
        return (
            Number.isInteger(value.baseRevision) &&
            value.baseRevision >= 1 &&
            typeof value.title === "string" &&
            value.title.length > 0 &&
            typeof value.trace?.requestId === "string" &&
            value.trace.requestId.length > 0 &&
            typeof value.trace.tabId === "string" &&
            Number.isInteger(value.trace.requestSeq) &&
            ["autosave", "retry", "delete"].includes(value.trace.reason) &&
            Array.isArray(value.document?.nodes) &&
            Array.isArray(value.document.connections) &&
            sameCanvasJSON(value.document, sanitizeCanvasProjectDocument(value.document))
        );
    } catch {
        return false;
    }
}

function restoredSync(sync: Record<string, CanvasProjectSync>) {
    return Object.fromEntries(
        Object.entries(sync || {}).map(([id, metadata]) => {
            if (metadata.unknownRequest && !validSaveRequest(metadata.unknownRequest)) {
                return [id, { ...metadata, saving: false, dirty: true, pending: false, pauseReason: "recovery", error: "画布保存请求损坏或不兼容，请保留草稿并核对服务器副本" }];
            }
            if (!metadata.saving && !metadata.unknownRequest) return [id, metadata];
            return [id, { ...metadata, saving: false, dirty: true, pending: !metadata.conflict && !metadata.pauseReason, ...(!metadata.unknownRequest ? { needsRevalidation: true } : {}) }];
        }),
    ) as Record<string, CanvasProjectSync>;
}

function sanitizeStoredCanvasValue(value: StorageValue<CanvasStore>) {
    value.state.projects = (value.state.projects || []).map(sanitizeCanvasProject);
    value.state.projectSync = restoredSync(value.state.projectSync);
    return value;
}

export function createCanvasStorage(storage: CanvasDocumentStorage = canvasDocumentStorage): PersistStorage<CanvasStore> {
    const cachedSummaries = new Map<string, CanvasSummary[]>();
    const cachedProjects = new Map<string, CanvasStore["projects"]>();
    const projectsKey = (name: string) => `${name}:projects`;
    const syncKey = (name: string) => `${name}:sync`;
    const summariesKey = (name: string) => `${name}:summaries`;

    return {
        getItem: async (name) => {
            const [storedProjects, storedSync, storedSummaries, legacyValue] = await storage.getItems([projectsKey(name), syncKey(name), summariesKey(name), name]);
            if (storedProjects) {
                const projects = JSON.parse(storedProjects) as CanvasStore["projects"];
                const projectSync = storedSync ? (JSON.parse(storedSync) as CanvasStore["projectSync"]) : {};
                const summaries: CanvasSummary[] = storedSummaries ? JSON.parse(storedSummaries) : [];
                const parsed = sanitizeStoredCanvasValue({ state: { projects, projectSync, summaries } } as StorageValue<CanvasStore>);
                cachedProjects.set(name, parsed.state.projects);
                cachedSummaries.set(name, summaries);
                return parsed;
            }

            if (!legacyValue) return null;
            return sanitizeStoredCanvasValue(JSON.parse(legacyValue) as StorageValue<CanvasStore>);
        },
        setItem: async (name, value) => {
            const state = value.state as Pick<CanvasStore, "projects" | "projectSync" | "summaries">;
            const entries: [string, string][] = [];
            if (cachedProjects.get(name) !== state.projects) entries.push([projectsKey(name), JSON.stringify(state.projects)]);
            if (cachedSummaries.get(name) !== state.summaries) entries.push([summariesKey(name), JSON.stringify(state.summaries || [])]);
            entries.push([syncKey(name), JSON.stringify(state.projectSync)]);
            await storage.setItems(entries);
            cachedProjects.set(name, state.projects);
            cachedSummaries.set(name, state.summaries);
        },
        removeItem: async (name) => {
            cachedProjects.delete(name);
            cachedSummaries.delete(name);
            await Promise.all([storage.removeItem(projectsKey(name)), storage.removeItem(syncKey(name)), storage.removeItem(summariesKey(name)), storage.removeItem(name)]);
        },
    };
}

function withPersistenceBarrier(storage: PersistStorage<CanvasStore>) {
    let latestWrite: Promise<void> | null = null;
    let writeQueue = Promise.resolve();
    return {
        storage: {
            getItem: (name: string) => storage.getItem(name),
            setItem: (name: string, value: StorageValue<CanvasStore>) => {
                const write = writeQueue
                    .catch(() => undefined)
                    .then(async () => {
                        await storage.setItem(name, value);
                    });
                writeQueue = write;
                latestWrite = write;
                // Zustand ignores set() promises; the barrier retains the error.
                return write.catch(() => undefined);
            },
            removeItem: (name: string) => storage.removeItem(name),
        } satisfies PersistStorage<CanvasStore>,
        waitForLatestWrite: () => latestWrite || Promise.resolve(),
    };
}

function hasUnsyncedChanges(metadata?: CanvasProjectSync) {
    return Boolean(metadata && (metadata.dirty || metadata.pending || metadata.saving || metadata.conflict || metadata.unknownRequest));
}

function canvasProjectPatchChanges(project: CanvasProject, patch: CanvasProjectPatch) {
    return (
        (patch.nodes !== undefined && patch.nodes !== project.nodes) ||
        (patch.maskResources !== undefined && patch.maskResources !== project.maskResources) ||
        (patch.connections !== undefined && patch.connections !== project.connections) ||
        (patch.backgroundMode !== undefined && patch.backgroundMode !== project.backgroundMode) ||
        (patch.showImageInfo !== undefined && patch.showImageInfo !== project.showImageInfo) ||
        (patch.viewport !== undefined && patch.viewport !== project.viewport)
    );
}

function sameCanvasJSON(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameCanvasJSON(value, right[index]));
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameCanvasJSON(leftRecord[key], rightRecord[key]));
}

function serverRecordMatchesSubmittedProject(record: CanvasProjectDetail, project: CanvasProject, document: CanvasProjectDocument) {
    return record.title === project.title && sameCanvasJSON(record.document, document);
}

export function selectCanvasProjectSummaries(state: Pick<CanvasStore, "summaries" | "projects" | "projectSync" | "summariesLoaded">): CanvasSummary[] {
    const items = new Map(state.summaries.map((summary) => [summary.id, summary]));
    for (const project of state.projects) {
        const sync = state.projectSync[project.id];
        if (!state.summariesLoaded || !sync || sync.serverRevision === null || hasUnsyncedChanges(sync)) {
            items.set(project.id, { id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, revision: sync?.serverRevision ?? 0, nodeCount: project.nodes.length, connectionCount: project.connections.length });
        }
    }
    return [...items.values()]
        .filter((item) => {
            const sync = state.projectSync[item.id];
            return sync?.operation !== "delete" || sync.conflict;
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function sanitizeCanvasProject(project: CanvasProject): CanvasProject {
    const migratedMasks = migrateCanvasMaskResources(project.nodes, project.maskResources);
    return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodes: migratedMasks.nodes,
        maskResources: migratedMasks.maskResources,
        connections: project.connections,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    };
}

export function createCanvasStore(options: CanvasStoreOptions = {}): UseBoundStore<StoreApi<CanvasStore>> {
    const api = options.api || canvasProjectsApi;
    const serverDebounceMs = options.serverDebounceMs ?? DEFAULT_SERVER_DEBOUNCE_MS;
    const isOnline = options.isOnline || browserIsOnline;
    const writeTracer = options.writeTracer || createCanvasProjectWriteTracer();
    const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const inFlight = new Set<string>();
    const inFlightDone = new Map<string, Promise<void>>();
    const finishInFlight = new Map<string, () => void>();
    const refreshing = new Map<string, number>();
    const detailLoads = new Map<string, Promise<CanvasProject>>();
    const detailGenerations = new Map<string, number>();
    let catalogGeneration = 0;
    let sessionGeneration = 0;
    const writerGenerations = new Map<string, number>();
    const releasedEditors = new Set<string>();
    const persistence = withPersistenceBarrier(options.storage || createCanvasStorage());
    let subscribedToOnline = false;

    const store = create<CanvasStore>()(
        persist(
            (set, get) => {
                const updateSync = (id: string, updater: (current: CanvasProjectSync | undefined) => CanvasProjectSync | undefined) => {
                    set((state) => {
                        const next = updater(state.projectSync[id]);
                        const projectSync = { ...state.projectSync };
                        if (next) projectSync[id] = next;
                        else delete projectSync[id];
                        return { projectSync };
                    });
                };

                const isProjectSyncBlocked = (id: string) => Boolean(get().blockedProjectSync[id]);

                const scheduleSave = (id: string, delay = serverDebounceMs) => {
                    if (!get().syncEnabled) return;
                    const currentTimer = saveTimers.get(id);
                    if (currentTimer) clearTimeout(currentTimer);
                    saveTimers.set(
                        id,
                        setTimeout(() => {
                            saveTimers.delete(id);
                            void saveProject(id);
                        }, delay),
                    );
                };

                const changedSync = (state: CanvasStore, id: string, operation: CanvasProjectSync["operation"] = "save", deletedProject?: CanvasProject) => {
                    if (!state.syncScope || state.syncScope === CANVAS_GUEST_SCOPE) return state.projectSync;
                    const previous = state.projectSync[id] || (state.summaries.find((item) => item.id === id) ? cleanSyncState(state.summaries.find((item) => item.id === id)!.revision) : undefined);
                    const next = pendingSyncState(previous, operation, deletedProject);
                    if (next.pauseReason === "rejected") delete next.pauseReason;
                    if (next.conflict || next.pauseReason) {
                        next.pending = false;
                        next.error = previous?.error || null;
                    }
                    next.offline = previous?.offline || state.bootstrapStatus === "offline" || !isOnline();
                    return { ...state.projectSync, [id]: next };
                };

                const queueChange = (id: string) => {
                    // An explicit library mutation may start a new operation after leaving an editor.
                    releasedEditors.delete(id);
                    const state = get(),
                        sync = state.projectSync[id];
                    if (state.syncEnabled && sync && !sync.conflict && !sync.pauseReason && !state.blockedProjectSync[id]) scheduleSave(id);
                };

                const saveProject = async (id: string) => {
                    let state = get(),
                        metadata = state.projectSync[id];
                    if (releasedEditors.has(id) || refreshing.has(id) || !state.syncEnabled || isProjectSyncBlocked(id) || !metadata || metadata.conflict || metadata.pauseReason || (!metadata.dirty && !metadata.pending && !metadata.unknownRequest))
                        return;
                    if (inFlight.has(id)) return;
                    const scope = state.syncScope,
                        session = sessionGeneration,
                        writer = writerGenerations.get(id) || 0;
                    const ownsOperation = () => get().syncScope === scope && sessionGeneration === session && (writerGenerations.get(id) || 0) === writer;
                    const maySend = () => ownsOperation() && !releasedEditors.has(id) && get().syncEnabled && !isProjectSyncBlocked(id) && !refreshing.has(id);
                    inFlight.add(id);
                    inFlightDone.set(id, new Promise<void>((resolve) => finishInFlight.set(id, resolve)));
                    let operation = metadata.operation;
                    let request = metadata.unknownRequest;
                    const replaying = Boolean(request);
                    let completed = false,
                        sent = false,
                        confirming = false;
                    let submittedDocument: CanvasProjectDocument | undefined;
                    let submittedTitle: string | undefined;
                    let submittedRevision = metadata.serverRevision;
                    try {
                        if (!isOnline()) {
                            updateSync(id, (current) => (current ? { ...current, offline: true, pending: true, saving: false } : current));
                            return;
                        }
                        if (metadata.needsRevalidation && !request && metadata.serverRevision !== null) {
                            const remote = await api.get(id);
                            if (!maySend()) return;
                            if (remote.revision !== metadata.serverRevision) throw new ApiRequestError("画布已在其他位置更新，请保留草稿并核对", 409, 1);
                            updateSync(id, (current) => {
                                if (!current) return current;
                                const { needsRevalidation: _, ...rest } = current;
                                return rest;
                            });
                        }
                        state = get();
                        metadata = state.projectSync[id];
                        if (!maySend() || !metadata || metadata.conflict || metadata.pauseReason) return;
                        // Resolve an unknown PUT before a queued deletion uses its revision.
                        operation = request ? "save" : metadata.operation;
                        const project = state.projects.find((item) => item.id === id) || metadata.deletedProject;
                        if (operation === "save" && !project) return;
                        if (request && !validSaveRequest(request)) {
                            updateSync(id, (current) => (current ? { ...current, pauseReason: "recovery", error: "画布保存请求损坏或不兼容，请保留草稿并核对服务器副本" } : current));
                            return;
                        }
                        submittedDocument = request?.document || (project ? (JSON.parse(JSON.stringify(canvasDocument(project))) as CanvasProjectDocument) : undefined);
                        submittedTitle = request?.title ?? project?.title;
                        submittedRevision = request?.baseRevision ?? metadata.serverRevision;
                        const trace = request?.trace || writeTracer.next(operation === "delete" ? "delete" : metadata.offline ? "retry" : "autosave");
                        if (!request && operation === "save" && submittedRevision !== null && submittedDocument && submittedTitle) {
                            request = { trace, baseRevision: submittedRevision, title: submittedTitle, document: submittedDocument };
                        }
                        updateSync(id, (current) => (current ? { ...current, ...(request ? { unknownRequest: request } : {}), saving: true, dirty: false, pending: false, offline: false, error: null } : current));
                        await persistence.waitForLatestWrite();
                        const matchesRequest = () => !request || get().projectSync[id]?.unknownRequest?.trace.requestId === request.trace.requestId;
                        if (!maySend() || !matchesRequest() || get().projectSync[id]?.conflict) return;
                        sent = true;
                        if (operation === "delete") {
                            await api.delete(id, submittedRevision ?? 1, trace);
                            if (!ownsOperation()) return;
                            set((state) => {
                                const projectSync = { ...state.projectSync };
                                delete projectSync[id];
                                return { projectSync, summaries: state.summaries.filter((item) => item.id !== id) };
                            });
                        } else if (project && submittedDocument) {
                            const record =
                                submittedRevision === null
                                    ? await api.create({ id, title: submittedTitle!, document: submittedDocument, createdAt: project.createdAt, updatedAt: project.updatedAt })
                                    : await api.update(id, { revision: submittedRevision, title: submittedTitle!, document: submittedDocument }, trace);
                            if (!ownsOperation() || !matchesRequest()) return;
                            if (record.id !== id || !Number.isInteger(record.revision) || (submittedRevision !== null && record.revision !== submittedRevision + 1)) throw new Error("画布保存回执无效，请重试确认");
                            if ((get().projectSync[id]?.serverRevision ?? 0) > record.revision) throw new ApiRequestError("画布已在其他位置更新，请保留草稿并核对", 409, 1);
                            confirming = true;
                            set((state) => {
                                const current = state.projectSync[id];
                                if (!current) return state;
                                const latest = state.projects.find((item) => item.id === id);
                                const changed =
                                    current.operation !== operation ||
                                    !latest ||
                                    latest.title !== submittedTitle ||
                                    !sameCanvasJSON(canvasDocument(latest), submittedDocument) ||
                                    (submittedRevision === null && !serverRecordMatchesSubmittedProject(record, project, submittedDocument!));
                                const { unknownRequest: _, needsRevalidation: _validation, ...synced } = current;
                                const summary = state.summaries.find((item) => item.id === id);
                                return {
                                    summaries: !latest || (summary && summary.revision > record.revision) ? state.summaries : [...state.summaries.filter((item) => item.id !== id), summarizeCanvasProject(record)],
                                    projectSync: { ...state.projectSync, [id]: { ...synced, serverRevision: record.revision, saving: false, dirty: changed, pending: changed, offline: false, error: null } },
                                };
                            });
                        }
                        await persistence.waitForLatestWrite();
                        completed = true;
                    } catch (error) {
                        if (!ownsOperation()) return;
                        const conflict = error instanceof ApiRequestError && error.status === 409;
                        const code = error instanceof ApiRequestError && error.data && typeof error.data === "object" ? (error.data as { code?: string }).code : undefined;
                        // A rejection of a retry alone cannot disprove an earlier acceptance.
                        const rejected = sent && !confirming && !replaying && code === "canvas_save_rejected";
                        const permission = error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
                        const recovery = code === "canvas_save_request_mismatch";
                        const resultUnknown = sent && !conflict && !rejected && !permission && !recovery;
                        set((state) => {
                            const current = state.projectSync[id];
                            if (!current) return state;
                            const next: CanvasProjectSync = {
                                ...current,
                                saving: false,
                                dirty: true,
                                pending: !conflict && !rejected && !permission && !recovery,
                                offline: resultUnknown || !isOnline(),
                                error: error instanceof Error ? error.message : "画布保存失败",
                                conflict,
                            };
                            if (confirming) next.serverRevision = submittedRevision;
                            if (request) next.unknownRequest = request;
                            if (rejected) {
                                delete next.unknownRequest;
                                next.pauseReason = "rejected";
                            }
                            if (permission) next.pauseReason = "permission";
                            if (recovery) next.pauseReason = "recovery";
                            const restoreDeleted = conflict && operation === "delete" && current.deletedProject && !state.projects.some((item) => item.id === id);
                            return { projectSync: { ...state.projectSync, [id]: next }, projects: restoreDeleted ? [current.deletedProject!, ...state.projects] : state.projects };
                        });
                        try {
                            await persistence.waitForLatestWrite();
                            completed = rejected;
                        } catch (storageError) {
                            if (!ownsOperation()) return;
                            updateSync(id, (current) =>
                                current
                                    ? {
                                          ...current,
                                          ...(request ? { unknownRequest: request } : {}),
                                          saving: false,
                                          dirty: true,
                                          pending: false,
                                          error: storageError instanceof Error ? storageError.message : "画布本地保存失败",
                                      }
                                    : current,
                            );
                        }
                    } finally {
                        inFlight.delete(id);
                        finishInFlight.get(id)?.();
                        finishInFlight.delete(id);
                        inFlightDone.delete(id);
                        const current = get().projectSync[id];
                        if (ownsOperation() && current?.saving) updateSync(id, (sync) => (sync ? { ...sync, saving: false, pending: true } : sync));
                        if (
                            !releasedEditors.has(id) &&
                            get().syncScope === scope &&
                            current &&
                            !current.offline &&
                            !current.pauseReason &&
                            !isProjectSyncBlocked(id) &&
                            !current.conflict &&
                            (current.dirty || current.pending || current.unknownRequest) &&
                            (completed || current.operation !== operation || !ownsOperation())
                        )
                            scheduleSave(id);
                    }
                };

                return {
                    hydrated: false,
                    bootstrapStatus: "loading",
                    bootstrapError: null,
                    bootstrapRetry: null,
                    readyForCanvasMutations: false,
                    canonicalGeneration: 0,
                    projects: [],
                    summaries: [],
                    summariesLoaded: false,
                    projectSync: {},
                    blockedProjectSync: {},
                    syncScope: null,
                    syncEnabled: false,
                    hydrate: async (scope = CANVAS_GUEST_SCOPE) => {
                        if (get().hydrated) return;
                        store.persist.setOptions({ name: `${CANVAS_STORE_KEY}:${scope}` });
                        try {
                            await store.persist.rehydrate();
                        } finally {
                            const guest = !scope || scope === CANVAS_GUEST_SCOPE;
                            const projectSync = restoredSync(get().projectSync);
                            const blockedProjectSync =
                                typeof window === "undefined"
                                    ? {}
                                    : Object.fromEntries(
                                          Object.entries(projectSync)
                                              .filter(([, sync]) => hasUnsyncedChanges(sync))
                                              .map(([id]) => [id, true as const]),
                                      );
                            set({ projectSync, blockedProjectSync, hydrated: true, syncScope: scope, syncEnabled: false, bootstrapStatus: guest ? "ready" : "loading", bootstrapError: null, readyForCanvasMutations: guest });
                        }
                    },
                    markBootstrapUnavailable: (scope, error) => {
                        if (!scope || scope === CANVAS_GUEST_SCOPE || get().syncScope !== scope) return;
                        const message = error instanceof Error ? error.message : typeof error === "string" ? error : "画布同步启动失败";
                        set({ bootstrapStatus: isOnline() ? "error" : "offline", bootstrapError: message, readyForCanvasMutations: true, syncEnabled: false });
                    },
                    setBootstrapRetry: (bootstrapRetry) => set({ bootstrapRetry }),
                    retryBootstrap: async () => {
                        const retry = get().bootstrapRetry;
                        if (!retry) return;
                        const previous = { status: get().bootstrapStatus, error: get().bootstrapError, scope: get().syncScope };
                        set({ bootstrapStatus: "loading", bootstrapError: null });
                        try {
                            await retry();
                        } finally {
                            set((state) => (state.bootstrapStatus === "loading" && state.syncScope === previous.scope ? { bootstrapStatus: previous.status, bootstrapError: previous.error } : state));
                        }
                    },
                    startSync: (scope) => {
                        const enabled = Boolean(scope) && scope !== CANVAS_GUEST_SCOPE;
                        if (get().syncScope !== scope) sessionGeneration++;
                        set({ syncScope: scope || null, syncEnabled: enabled, bootstrapStatus: "ready", bootstrapError: null, readyForCanvasMutations: true });
                        if (!enabled) return;
                        if (!subscribedToOnline) {
                            subscribeToBrowserOnline(() => get().retryPendingSaves());
                            subscribedToOnline = true;
                        }
                        get().retryPendingSaves();
                    },
                    setProjectSyncBlocked: (id, blocked) => {
                        if (!blocked) releasedEditors.delete(id);
                        if (blocked && !get().blockedProjectSync[id]) writerGenerations.set(id, (writerGenerations.get(id) || 0) + 1);
                        const timer = saveTimers.get(id);
                        if (blocked && timer) clearTimeout(timer);
                        if (blocked) saveTimers.delete(id);
                        set((state) => {
                            const blockedProjectSync = { ...state.blockedProjectSync };
                            if (blocked) blockedProjectSync[id] = true;
                            else delete blockedProjectSync[id];
                            return { blockedProjectSync };
                        });
                        const sync = get().projectSync[id];
                        if (!blocked && get().syncEnabled && sync && !sync.conflict && (sync.dirty || sync.pending)) scheduleSave(id);
                    },
                    releaseProjectEditor: (id) => {
                        releasedEditors.add(id);
                        writerGenerations.set(id, (writerGenerations.get(id) || 0) + 1);
                        const timer = saveTimers.get(id);
                        if (timer) clearTimeout(timer);
                        saveTimers.delete(id);
                        set((state) => {
                            const blockedProjectSync = { ...state.blockedProjectSync };
                            delete blockedProjectSync[id];
                            const current = state.projectSync[id];
                            return { blockedProjectSync, projectSync: current?.saving ? { ...state.projectSync, [id]: { ...current, saving: false, dirty: true, pending: true } } : state.projectSync };
                        });
                    },
                    adoptImportedProjects: (records, snapshots) => {
                        set((state) => {
                            const projectSync = { ...state.projectSync };
                            for (const record of records) {
                                const snapshot = snapshots.get(record.id);
                                const currentProject = state.projects.find((project) => project.id === record.id);
                                if (snapshot && currentProject === snapshot) {
                                    projectSync[record.id] = cleanSyncState(record.revision);
                                    continue;
                                }
                                const current = projectSync[record.id];
                                const operation = current?.operation || (currentProject ? "save" : "delete");
                                const pending = pendingSyncState(current, operation, current?.deletedProject || (!currentProject ? snapshot : undefined));
                                projectSync[record.id] = { ...pending, serverRevision: record.revision, dirty: true, pending: !pending.conflict, saving: false };
                            }
                            return { projectSync };
                        });
                        if (records.length) get().replaceProjectsFromServer(records);
                    },
                    applyLegacyImageNormalization: (id, capturedNodes, normalizedNodes) => {
                        if (isProjectSyncBlocked(id)) return false;
                        const state = get();
                        const project = state.projects.find((item) => item.id === id);
                        if (!project) return false;
                        const merged = mergeNormalizedLegacyNodes(project.nodes, capturedNodes, normalizedNodes);
                        const complete = merged.complete;
                        if (merged.nodes !== project.nodes) {
                            set({ projects: state.projects.map((item) => (item.id === id ? { ...item, nodes: merged.nodes, updatedAt: new Date().toISOString() } : item)), projectSync: changedSync(state, id) });
                            queueChange(id);
                        }
                        return complete;
                    },
                    mergeProjectSummaries: (records) => {
                        catalogGeneration++;
                        set((state) => {
                            const projectSync = { ...state.projectSync };
                            const summaries = records.map(({ id, title, revision, createdAt, updatedAt, nodeCount, connectionCount }) => {
                                // A catalog revision is never the base of an existing local document.
                                if (!hasUnsyncedChanges(projectSync[id]) && !state.projects.some((project) => project.id === id)) projectSync[id] = cleanSyncState(revision);
                                return { id, title, revision, createdAt, updatedAt, nodeCount, connectionCount };
                            });
                            return { summaries, summariesLoaded: true, projectSync };
                        });
                    },
                    replaceProjectsFromServer: (records, notifyEditor = true) => {
                        set((state) => {
                            const projects = new Map(state.projects.map((project) => [project.id, project]));
                            const summaries = new Map(state.summaries.map((summary) => [summary.id, summary]));
                            const projectSync = { ...state.projectSync };
                            for (const record of records) {
                                const metadata = projectSync[record.id];
                                const local = projects.get(record.id);
                                summaries.set(record.id, summarizeCanvasProject(record));
                                if (hasUnsyncedChanges(metadata)) {
                                    if (metadata?.serverRevision === null && !metadata.conflict) projectSync[record.id] = { ...metadata, serverRevision: record.revision };
                                    continue;
                                }
                                projects.set(record.id, local ? preserveLocalImageUploads(localProject(record), local) : localProject(record));
                                projectSync[record.id] = cleanSyncState(record.revision);
                            }
                            return { projects: [...projects.values()], summaries: [...summaries.values()], projectSync, canonicalGeneration: state.canonicalGeneration + (notifyEditor ? 1 : 0) };
                        });
                    },
                    ensureProjectDetail: async (id, options = {}) => {
                        const initial = get();
                        const scope = initial.syncScope;
                        const local = initial.projects.find((project) => project.id === id);
                        const sync = initial.projectSync[id];
                        const summary = initial.summaries.find((item) => item.id === id);
                        if (sync?.operation === "delete") throw new Error("画布已删除或正在删除");
                        if (local && (hasUnsyncedChanges(sync) || sync?.serverRevision === null || !scope || scope === CANVAS_GUEST_SCOPE || !initial.syncEnabled)) return local;
                        if (local && !options.revalidate && sync?.serverRevision != null && (!summary || summary.revision <= sync.serverRevision)) return local;
                        const key = JSON.stringify([scope, id]);
                        const existing = detailLoads.get(key);
                        if (existing) return existing;
                        const generation = detailGenerations.get(id) || 0;
                        const catalog = catalogGeneration;
                        const load = (async () => {
                            const record = await api.get(id);
                            const state = get();
                            const latest = state.projects.find((project) => project.id === id);
                            const current = state.projectSync[id];
                            if (state.syncScope !== scope || (detailGenerations.get(id) || 0) !== generation || current?.operation === "delete") throw new Error("画布加载已失效，请重试");
                            if (catalogGeneration !== catalog && state.summariesLoaded && !state.summaries.some((item) => item.id === id)) throw new Error("画布加载已失效，请重试");
                            if (latest && (latest !== local || hasUnsyncedChanges(current))) return latest;
                            if (record.id !== id || !Array.isArray(record.document?.nodes) || !Array.isArray(record.document?.connections)) throw new Error("画布详情数据无效");
                            const knownRevision = state.summaries.find((item) => item.id === id)?.revision ?? 0;
                            if (record.revision < knownRevision || record.revision < (current?.serverRevision ?? 0)) throw new Error("画布版本已更新，请重新加载");
                            get().replaceProjectsFromServer([record], false);
                            return get().projects.find((project) => project.id === id)!;
                        })();
                        detailLoads.set(key, load);
                        try {
                            return await load;
                        } finally {
                            if (detailLoads.get(key) === load) detailLoads.delete(key);
                        }
                    },
                    refreshProjectFromServer: async (id) => {
                        if (!get().syncEnabled) return;
                        const scope = get().syncScope;
                        const generation = (detailGenerations.get(id) || 0) + 1;
                        detailGenerations.set(id, generation);
                        const isCurrent = () => get().syncScope === scope && detailGenerations.get(id) === generation;
                        const currentTimer = saveTimers.get(id);
                        if (currentTimer) clearTimeout(currentTimer);
                        saveTimers.delete(id);
                        refreshing.set(id, generation);
                        try {
                            await inFlightDone.get(id);
                            if (!isCurrent()) throw new Error("画布刷新已失效，请重试");
                            const record = await api.get(id);
                            if (!isCurrent()) throw new Error("画布刷新已失效，请重试");
                            const serverProject = localProject(record);
                            set((state) => {
                                const index = state.projects.findIndex((item) => item.id === id);
                                const project = index >= 0 ? preserveLocalImageUploads(serverProject, state.projects[index]!) : serverProject;
                                const projects = [...state.projects];
                                if (index >= 0) projects[index] = project;
                                else projects.unshift(project);
                                return {
                                    projects,
                                    summaries: [...state.summaries.filter((item) => item.id !== id), summarizeCanvasProject(record)],
                                    projectSync: { ...state.projectSync, [id]: cleanSyncState(record.revision) },
                                    canonicalGeneration: state.canonicalGeneration + 1,
                                };
                            });
                        } catch (error) {
                            if (isCurrent()) updateSync(id, (current) => (current ? { ...current, saving: false, error: error instanceof Error ? error.message : "画布刷新失败" } : current));
                            throw error;
                        } finally {
                            if (refreshing.get(id) === generation) {
                                refreshing.delete(id);
                                const current = get().projectSync[id];
                                if (get().syncScope === scope && current?.operation === "delete" && current.pending && !current.conflict) scheduleSave(id);
                            }
                        }
                    },
                    retryPendingSaves: async (projectId) => {
                        if (!get().syncEnabled || !isOnline()) return;
                        const scope = get().syncScope,
                            session = sessionGeneration;
                        const pending = Object.entries(get().projectSync).filter(([id]) => !projectId || id === projectId);
                        for (const [id] of pending) {
                            const metadata = get().projectSync[id];
                            if (!metadata || get().blockedProjectSync[id] || metadata.conflict || metadata.pauseReason === "recovery" || (metadata.pauseReason && !projectId) || (!metadata.dirty && !metadata.pending && !metadata.unknownRequest)) continue;
                            if (get().syncScope !== scope || sessionGeneration !== session) return;
                            updateSync(id, (current) => {
                                if (!current) return current;
                                const { pauseReason: _, ...next } = current;
                                return { ...next, offline: false, ...(!current.unknownRequest && current.offline && current.serverRevision !== null ? { needsRevalidation: true } : {}) };
                            });
                            await saveProject(id);
                        }
                    },
                    createProject: (title = "未命名画布") => {
                        const now = new Date().toISOString();
                        const id = nanoid();
                        const project: CanvasProject = {
                            id,
                            title,
                            createdAt: now,
                            updatedAt: now,
                            nodes: [],
                            maskResources: {},
                            connections: [],
                            backgroundMode: "lines",
                            showImageInfo: false,
                            viewport: initialViewport,
                        };
                        set((state) => ({ projects: [project, ...state.projects], projectSync: changedSync(state, id) }));
                        queueChange(id);
                        return id;
                    },
                    duplicateProject: (sourceId) => {
                        const source = get().projects.find((project) => project.id === sourceId);
                        if (!source) return null;
                        const now = new Date().toISOString();
                        const id = nanoid();
                        const project = createCanvasProjectCopy(source, {
                            id,
                            title: nextCanvasProjectCopyTitle(
                                source.title,
                                selectCanvasProjectSummaries(get()).map((item) => item.title),
                            ),
                            now,
                        });
                        set((state) => ({ projects: [project, ...state.projects], projectSync: changedSync(state, id) }));
                        queueChange(id);
                        return id;
                    },
                    openProject: (id) => get().projects.find((item) => item.id === id) || null,
                    renameProject: (id, title) => {
                        if (isProjectSyncBlocked(id)) return;
                        const current = get().projects.find((project) => project.id === id);
                        if (!current) return;
                        const nextTitle = title.trim() || current.title;
                        if (nextTitle === current.title) return;
                        set((state) => ({
                            projects: state.projects.map((project) => {
                                if (project.id !== id) return project;
                                return { ...project, title: nextTitle, updatedAt: new Date().toISOString() };
                            }),
                            projectSync: changedSync(state, id),
                        }));
                        queueChange(id);
                    },
                    deleteProjects: (ids) => {
                        const current = get();
                        const deletableIDs = ids.filter((id) => !isProjectSyncBlocked(id));
                        if (deletableIDs.length === 0) return;
                        let projectSync = current.projectSync;
                        for (const id of deletableIDs) {
                            const timer = saveTimers.get(id);
                            if (timer) clearTimeout(timer);
                            saveTimers.delete(id);
                            detailGenerations.set(id, (detailGenerations.get(id) || 0) + 1);
                            projectSync = changedSync(
                                { ...current, projectSync },
                                id,
                                "delete",
                                current.projects.find((item) => item.id === id),
                            );
                        }
                        set({ projects: current.projects.filter((item) => !deletableIDs.includes(item.id)), projectSync });
                        deletableIDs.forEach(queueChange);
                    },
                    updateProject: (id, patch) => {
                        if (isProjectSyncBlocked(id)) return;
                        const current = get().projects.find((project) => project.id === id);
                        if (!current || !canvasProjectPatchChanges(current, patch)) return;
                        const nextProject: CanvasProject = { ...current, ...patch, updatedAt: new Date().toISOString() };
                        const changesServerDocument = !sameCanvasJSON(canvasDocument(current), canvasDocument(nextProject));
                        set((state) => ({
                            projects: state.projects.map((project) => {
                                if (project.id !== id) return project;
                                return nextProject;
                            }),
                            projectSync: changesServerDocument ? changedSync(state, id) : state.projectSync,
                        }));
                        if (changesServerDocument) queueChange(id);
                    },
                };
            },
            {
                name: `${CANVAS_STORE_KEY}:${CANVAS_GUEST_SCOPE}`,
                storage: persistence.storage,
                skipHydration: true,
                partialize: (state) =>
                    ({
                        projects: state.projects,
                        summaries: state.summaries,
                        projectSync: state.projectSync,
                    }) as StorageValue<CanvasStore>["state"],
            },
        ),
    );

    return store;
}

export const useCanvasStore = createCanvasStore();
