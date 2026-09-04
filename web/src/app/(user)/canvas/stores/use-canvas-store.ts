import { nanoid } from "nanoid";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { persist, type PersistStorage, type StateStorage, type StorageValue } from "zustand/middleware";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { canvasDocumentStorage } from "@/lib/localforage-storage";
import { canvasProjectsApi, type CanvasProjectDocument, type CanvasProjectRecord, type CanvasProjectsApi, type CanvasProjectWriteTrace } from "@/services/api/canvas-projects";
import { ApiRequestError } from "@/services/api/request";
import { sanitizeCanvasProjectDocument } from "@/services/canvas-project-document";
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
    adoptImportedProjects: (projects: CanvasProjectRecord[], snapshots: Map<string, CanvasProject>) => void;
    applyLegacyImageNormalization: (id: string, capturedNodes: CanvasNodeData[], normalizedNodes: CanvasNodeData[]) => boolean;
    replaceProjectsFromServer: (projects: CanvasProjectRecord[]) => void;
    refreshProjectFromServer: (id: string) => Promise<void>;
    retryPendingSaves: () => Promise<void>;
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

function localProject(project: CanvasProjectRecord): CanvasProject {
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
        (connection) =>
            !serverConnectionIds.has(connection.id) &&
            (localNodeIds.has(connection.fromNodeId) || localNodeIds.has(connection.toNodeId)) &&
            allNodeIds.has(connection.fromNodeId) &&
            allNodeIds.has(connection.toNodeId),
    );
    return { ...server, nodes: [...server.nodes, ...localNodes], connections: [...server.connections, ...localConnections] };
}

function sanitizeStoredCanvasValue(value: StorageValue<CanvasStore>) {
    value.state.projects = (value.state.projects || []).map(sanitizeCanvasProject);
    value.state.projectSync = Object.fromEntries(Object.entries(value.state.projectSync || {}).map(([id, metadata]) => [id, metadata.saving ? { ...metadata, saving: false, dirty: true, pending: true } : metadata]));
    return value;
}

export function createCanvasStorage(storage: StateStorage = canvasDocumentStorage): PersistStorage<CanvasStore> {
    const cachedProjects = new Map<string, CanvasStore["projects"]>();
    const projectsKey = (name: string) => `${name}:projects`;
    const syncKey = (name: string) => `${name}:sync`;

    return {
        getItem: async (name) => {
            const [storedProjects, storedSync] = await Promise.all([storage.getItem(projectsKey(name)), storage.getItem(syncKey(name))]);
            if (storedProjects) {
                const projects = JSON.parse(storedProjects) as CanvasStore["projects"];
                const projectSync = storedSync ? (JSON.parse(storedSync) as CanvasStore["projectSync"]) : {};
                const parsed = sanitizeStoredCanvasValue({ state: { projects, projectSync } } as StorageValue<CanvasStore>);
                cachedProjects.set(name, parsed.state.projects);
                return parsed;
            }

            const legacyValue = await storage.getItem(name);
            if (!legacyValue) return null;
            return sanitizeStoredCanvasValue(JSON.parse(legacyValue) as StorageValue<CanvasStore>);
        },
        setItem: async (name, value) => {
            const state = value.state as Pick<CanvasStore, "projects" | "projectSync">;
            if (cachedProjects.get(name) !== state.projects) {
                await storage.setItem(projectsKey(name), JSON.stringify(state.projects));
                cachedProjects.set(name, state.projects);
            }
            await storage.setItem(syncKey(name), JSON.stringify(state.projectSync));
        },
        removeItem: async (name) => {
            cachedProjects.delete(name);
            await Promise.all([storage.removeItem(projectsKey(name)), storage.removeItem(syncKey(name)), storage.removeItem(name)]);
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
                const write = writeQueue.catch(() => undefined).then(async () => {
                    await storage.setItem(name, value);
                });
                writeQueue = write;
                latestWrite = write;
                return write;
            },
            removeItem: (name: string) => storage.removeItem(name),
        } satisfies PersistStorage<CanvasStore>,
        waitForLatestWrite: async () => {
            while (latestWrite) {
                const observed = latestWrite;
                await observed;
                if (latestWrite === observed) return;
            }
        },
    };
}

function hasUnsyncedChanges(metadata?: CanvasProjectSync) {
    return Boolean(metadata && (metadata.dirty || metadata.pending || metadata.saving || metadata.conflict));
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

function serverRecordMatchesSubmittedProject(record: CanvasProjectRecord, project: CanvasProject, document: CanvasProjectDocument) {
    return record.title === project.title && sameCanvasJSON(record.document, document);
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
    const refreshing = new Set<string>();
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

                const queueChange = (id: string, operation: CanvasProjectSync["operation"] = "save", deletedProject?: CanvasProject) => {
                    const state = get();
                    const tracksAuthenticatedChanges = Boolean(state.syncScope) && state.syncScope !== CANVAS_GUEST_SCOPE;
                    if (!tracksAuthenticatedChanges) return;
                    let conflict = false;
                    updateSync(id, (current) => {
                        conflict = current?.conflict || false;
                        const next = pendingSyncState(current, operation, deletedProject);
                        const offline = current?.offline || state.bootstrapStatus === "offline" || !isOnline();
                        return conflict ? { ...next, pending: false, offline } : { ...next, offline };
                    });
                    if (state.syncEnabled && !conflict && !state.blockedProjectSync[id]) scheduleSave(id);
                };

                    const saveProject = async (id: string) => {
                    let state = get();
                    let metadata = state.projectSync[id];
                    if (refreshing.has(id) || !state.syncEnabled || isProjectSyncBlocked(id) || !metadata || metadata.conflict || (!metadata.dirty && !metadata.pending)) return;
                    if (!isOnline()) {
                        updateSync(id, (current) => (current ? { ...current, offline: true, pending: true, saving: false } : current));
                        return;
                    }
                    if (inFlight.has(id)) {
                        updateSync(id, (current) => (current ? { ...current, pending: true } : current));
                        return;
                    }

                    try {
                        await persistence.waitForLatestWrite();
                    } catch (error) {
                        updateSync(id, (current) =>
                            current
                                ? {
                                      ...current,
                                      saving: false,
                                      dirty: true,
                                      pending: true,
                                      error: error instanceof Error ? error.message : "画布本地保存失败",
                                  }
                                : current,
                        );
                        return;
                    }

                    state = get();
                    metadata = state.projectSync[id];
                    if (refreshing.has(id) || !state.syncEnabled || isProjectSyncBlocked(id) || !metadata || metadata.conflict || (!metadata.dirty && !metadata.pending)) return;
                    if (!isOnline()) {
                        updateSync(id, (current) => (current ? { ...current, offline: true, pending: true, saving: false } : current));
                        return;
                    }
                    if (inFlight.has(id)) {
                        updateSync(id, (current) => (current ? { ...current, pending: true } : current));
                        return;
                    }

                    const operation = metadata.operation;
                    const project = state.projects.find((item) => item.id === id);
                    if (operation === "save" && !project) return;
                    const unknownRequest = operation === "save" ? metadata.unknownRequest : undefined;
                    const submittedDocument = unknownRequest?.document || (project ? canvasDocument(project) : undefined);
                    const submittedTitle = unknownRequest?.title || project?.title;
                    const submittedRevision = unknownRequest?.baseRevision ?? metadata.serverRevision;
                    const trace = unknownRequest?.trace || writeTracer.next(operation === "delete" ? "delete" : metadata.offline ? "retry" : "autosave");

                    inFlight.add(id);
                    inFlightDone.set(
                        id,
                        new Promise<void>((resolve) => {
                            finishInFlight.set(id, resolve);
                        }),
                    );
                    updateSync(id, (current) => (current ? { ...current, saving: true, dirty: false, pending: false, offline: false, error: null } : current));
                    let completed = false;
                    try {
                        if (operation === "delete") {
                            await api.delete(id, metadata.serverRevision ?? 1, trace);
                            updateSync(id, () => undefined);
                        } else if (project && submittedDocument) {
                            const record =
                                metadata.serverRevision === null
                                    ? await api.create({
                                          id: project.id,
                                          title: project.title,
                                          document: submittedDocument,
                                          createdAt: project.createdAt,
                                          updatedAt: project.updatedAt,
                                      })
                                    : await api.update(id, {
                                      revision: submittedRevision ?? 1,
                                      title: submittedTitle || project.title,
                                      document: submittedDocument,
                                  }, trace);
                            updateSync(id, (current) => {
                                if (!current) return cleanSyncState(record.revision);
                                const latestProject = get().projects.find((item) => item.id === id);
                                const changedWhileSaving = current.dirty || current.pending || current.operation !== operation || !latestProject || latestProject.title !== submittedTitle || !sameCanvasJSON(canvasDocument(latestProject), submittedDocument) || (metadata.serverRevision === null && !serverRecordMatchesSubmittedProject(record, project, submittedDocument));
                                const { unknownRequest: _unknownRequest, ...synced } = current;
                                return {
                                    ...synced,
                                    serverRevision: record.revision,
                                    saving: false,
                                    dirty: changedWhileSaving,
                                    pending: changedWhileSaving,
                                    offline: false,
                                    error: null,
                                };
                            });
                        }
                        completed = true;
                    } catch (error) {
                        const conflict = error instanceof ApiRequestError && error.status === 409;
                        const resultUnknown = operation === "save" && !conflict && (!(error instanceof ApiRequestError) || error.status >= 500);
                        set((state) => {
                            const current = state.projectSync[id];
                            if (!current) return state;
                            const projectSync = {
                                ...state.projectSync,
                                [id]: {
                                    ...current,
                                    saving: false,
                                    dirty: true,
                                    pending: !conflict,
                                    offline: resultUnknown || !isOnline(),
                                    error: error instanceof Error ? error.message : "画布保存失败",
                                    conflict,
                                    unknownRequest: resultUnknown && submittedDocument && submittedTitle && submittedRevision !== null ? { trace, baseRevision: submittedRevision, title: submittedTitle, document: submittedDocument } : current.unknownRequest,
                                },
                            };
                            const shouldRestoreDelete = conflict && operation === "delete" && current.deletedProject && !state.projects.some((item) => item.id === id);
                            return {
                                projectSync,
                                projects: shouldRestoreDelete ? [current.deletedProject as CanvasProject, ...state.projects] : state.projects,
                            };
                        });
                    } finally {
                        inFlight.delete(id);
                        finishInFlight.get(id)?.();
                        finishInFlight.delete(id);
                        inFlightDone.delete(id);
                        const current = get().projectSync[id];
                        if (current && !current.offline && !isProjectSyncBlocked(id) && !current.conflict && (current.dirty || current.pending) && (completed || current.operation !== operation)) scheduleSave(id);
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
                            set({ hydrated: true, syncScope: scope, syncEnabled: false, bootstrapStatus: guest ? "ready" : "loading", bootstrapError: null, readyForCanvasMutations: guest });
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
                            set((state) =>
                                state.bootstrapStatus === "loading" && state.syncScope === previous.scope
                                    ? { bootstrapStatus: previous.status, bootstrapError: previous.error }
                                    : state,
                            );
                        }
                    },
                    startSync: (scope) => {
                        const enabled = Boolean(scope) && scope !== CANVAS_GUEST_SCOPE;
                        set({ syncScope: scope || null, syncEnabled: enabled, bootstrapStatus: "ready", bootstrapError: null, readyForCanvasMutations: true });
                        if (!enabled) return;
                        if (!subscribedToOnline) {
                            subscribeToBrowserOnline(() => get().retryPendingSaves());
                            subscribedToOnline = true;
                        }
                        get().retryPendingSaves();
                    },
                    setProjectSyncBlocked: (id, blocked) => {
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
                    },
                    applyLegacyImageNormalization: (id, capturedNodes, normalizedNodes) => {
                        if (isProjectSyncBlocked(id)) return false;
                        let complete = false;
                        let changed = false;
                        set((state) => ({
                            projects: state.projects.map((project) => {
                                if (project.id !== id) return project;
                                const merged = mergeNormalizedLegacyNodes(project.nodes, capturedNodes, normalizedNodes);
                                complete = merged.complete;
                                changed = merged.nodes !== project.nodes;
                                return changed ? { ...project, nodes: merged.nodes, updatedAt: new Date().toISOString() } : project;
                            }),
                        }));
                        if (changed) queueChange(id);
                        return complete;
                    },
                    replaceProjectsFromServer: (records) => {
                        set((state) => {
                            const localById = new Map(state.projects.map((project) => [project.id, project]));
                            const projects: CanvasProject[] = [];
                            const included = new Set<string>();
                            const projectSync: Record<string, CanvasProjectSync> = {};

                            for (const record of records) {
                                const metadata = state.projectSync[record.id];
                                const local = localById.get(record.id);
                                if (hasUnsyncedChanges(metadata)) {
                                    if (local) {
                                        projects.push(local);
                                        included.add(record.id);
                                    }
                                    projectSync[record.id] = metadata?.serverRevision === null && !metadata.conflict ? { ...metadata, serverRevision: record.revision } : (metadata as CanvasProjectSync);
                                    continue;
                                }
                                projects.push(local ? preserveLocalImageUploads(localProject(record), local) : localProject(record));
                                included.add(record.id);
                                projectSync[record.id] = cleanSyncState(record.revision);
                            }

                            for (const project of state.projects) {
                                const metadata = state.projectSync[project.id];
                                if (!included.has(project.id) && hasUnsyncedChanges(metadata)) {
                                    projects.push(project);
                                    projectSync[project.id] = metadata as CanvasProjectSync;
                                }
                            }
                            for (const [id, metadata] of Object.entries(state.projectSync)) {
                                if (!(id in projectSync) && hasUnsyncedChanges(metadata)) projectSync[id] = metadata;
                            }

                            return { projects, projectSync, canonicalGeneration: state.canonicalGeneration + 1 };
                        });
                    },
                    refreshProjectFromServer: async (id) => {
                        if (!get().syncEnabled) return;
                        const currentTimer = saveTimers.get(id);
                        if (currentTimer) clearTimeout(currentTimer);
                        saveTimers.delete(id);
                        refreshing.add(id);
                        try {
                            await inFlightDone.get(id);
                            const record = await api.get(id);
                            const serverProject = localProject(record);
                            set((state) => {
                                const index = state.projects.findIndex((item) => item.id === id);
                                const project = index >= 0 ? preserveLocalImageUploads(serverProject, state.projects[index]!) : serverProject;
                                const projects = [...state.projects];
                                if (index >= 0) projects[index] = project;
                                else projects.unshift(project);
                                return { projects, projectSync: { ...state.projectSync, [id]: cleanSyncState(record.revision) }, canonicalGeneration: state.canonicalGeneration + 1 };
                            });
                        } catch (error) {
                            updateSync(id, (current) => (current ? { ...current, saving: false, error: error instanceof Error ? error.message : "画布刷新失败" } : current));
                            throw error;
                        } finally {
                            refreshing.delete(id);
                        }
                    },
                    retryPendingSaves: async () => {
                        if (!get().syncEnabled || !isOnline()) return;
                        const pending = Object.entries(get().projectSync);
                        set((state) => ({
                            projectSync: Object.fromEntries(Object.entries(state.projectSync).map(([id, metadata]) => [id, { ...metadata, offline: false }])),
                        }));
                        for (const [id, previous] of pending) {
                            const metadata = get().projectSync[id];
                            if (!metadata) continue;
                            if (get().blockedProjectSync[id] || metadata.conflict || (!metadata.dirty && !metadata.pending)) continue;
                            if (metadata.unknownRequest) {
                                await saveProject(id);
                                continue;
                            }
                            if (metadata.serverRevision === null || !previous.offline) {
                                scheduleSave(id, 0);
                                continue;
                            }
                            try {
                                const server = await api.get(id);
                                if (server.revision !== metadata.serverRevision) {
                                    updateSync(id, (current) => (current ? { ...current, conflict: true, pending: false, error: "画布已在其他位置更新，请刷新后重试" } : current));
                                    continue;
                                }
                                scheduleSave(id, 0);
                            } catch (error) {
                                updateSync(id, (current) => (current ? { ...current, offline: true, error: error instanceof Error ? error.message : "画布刷新失败" } : current));
                            }
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
                        set((state) => ({ projects: [project, ...state.projects] }));
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
                            title: nextCanvasProjectCopyTitle(source.title, get().projects.map((item) => item.title)),
                            now,
                        });
                        set((state) => ({ projects: [project, ...state.projects] }));
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
                        }));
                        queueChange(id);
                    },
                    deleteProjects: (ids) => {
                        const current = get();
                        const deletableIDs = ids.filter((id) => !isProjectSyncBlocked(id));
                        if (deletableIDs.length === 0) return;
                        set((state) => ({ projects: state.projects.filter((project) => !deletableIDs.includes(project.id)) }));
                        for (const id of deletableIDs) {
                            const metadata = current.projectSync[id];
                            const timer = saveTimers.get(id);
                            if (timer) clearTimeout(timer);
                            saveTimers.delete(id);
                            const syncScope = get().syncScope;
                            if (!syncScope || syncScope === CANVAS_GUEST_SCOPE) continue;
                            const deletedProject = current.projects.find((project) => project.id === id);
                            queueChange(id, "delete", deletedProject);
                        }
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
                        projectSync: state.projectSync,
                    }) as StorageValue<CanvasStore>["state"],
            },
        ),
    );

    return store;
}

export const useCanvasStore = createCanvasStore();
