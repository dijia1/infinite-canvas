import { nanoid } from "nanoid";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { localForageStorage } from "@/lib/localforage-storage";
import { canvasProjectsApi, type CanvasProjectDocument, type CanvasProjectRecord, type CanvasProjectsApi } from "@/services/api/canvas-projects";
import { ApiRequestError } from "@/services/api/request";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "../types";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
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
};

export type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    projectSync: Record<string, CanvasProjectSync>;
    syncScope: string | null;
    syncEnabled: boolean;
    hydrate: (scope?: string) => Promise<void>;
    startSync: (scope: string) => void;
    replaceProjectsFromServer: (projects: CanvasProjectRecord[]) => void;
    refreshProjectFromServer: (id: string) => Promise<void>;
    retryPendingSaves: () => void;
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

type CanvasStoreOptions = {
    api?: CanvasProjectsApi;
    storage?: PersistStorage<CanvasStore>;
    serverDebounceMs?: number;
    isOnline?: () => boolean;
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
    return {
        nodes: project.nodes,
        connections: project.connections,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    };
}

function localProject(project: CanvasProjectRecord): CanvasProject {
    return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodes: project.document.nodes,
        connections: project.document.connections,
        backgroundMode: project.document.backgroundMode,
        showImageInfo: project.document.showImageInfo,
        viewport: project.document.viewport,
    };
}

function createCanvasStorage(): PersistStorage<CanvasStore> {
    return {
        getItem: async (name) => {
            const value = await localForageStorage.getItem(name);
            if (!value) return null;
            const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
            parsed.state.projects = (parsed.state.projects || []).map(sanitizeCanvasProject);
            parsed.state.projectSync = Object.fromEntries(Object.entries(parsed.state.projectSync || {}).map(([id, metadata]) => [id, metadata.saving ? { ...metadata, saving: false, dirty: true, pending: true } : metadata]));
            return parsed;
        },
        setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => localForageStorage.removeItem(name),
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

export function sanitizeCanvasProject(project: CanvasProject): CanvasProject {
    return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodes: project.nodes,
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
    const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const inFlight = new Set<string>();
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
                    if (!get().syncEnabled) return;
                    let conflict = false;
                    updateSync(id, (current) => {
                        conflict = current?.conflict || false;
                        const next = pendingSyncState(current, operation, deletedProject);
                        return conflict ? { ...next, pending: false } : next;
                    });
                    if (!conflict) scheduleSave(id);
                };

                const saveProject = async (id: string) => {
                    let state = get();
                    let metadata = state.projectSync[id];
                    if (!state.syncEnabled || !metadata || metadata.conflict || (!metadata.dirty && !metadata.pending)) return;
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
                    if (!state.syncEnabled || !metadata || metadata.conflict || (!metadata.dirty && !metadata.pending)) return;
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
                    if (operation === "delete" && metadata.serverRevision === null) {
                        updateSync(id, () => undefined);
                        return;
                    }

                    inFlight.add(id);
                    updateSync(id, (current) => (current ? { ...current, saving: true, dirty: false, pending: false, offline: false, error: null } : current));
                    let completed = false;
                    try {
                        if (operation === "delete") {
                            await api.delete(id, metadata.serverRevision as number);
                            updateSync(id, () => undefined);
                        } else if (project) {
                            const record =
                                metadata.serverRevision === null
                                    ? await api.create({
                                          id: project.id,
                                          title: project.title,
                                          document: canvasDocument(project),
                                          createdAt: project.createdAt,
                                          updatedAt: project.updatedAt,
                                      })
                                    : await api.update(id, {
                                          revision: metadata.serverRevision,
                                          title: project.title,
                                          document: canvasDocument(project),
                                      });
                            updateSync(id, (current) => {
                                if (!current) return cleanSyncState(record.revision);
                                const changedWhileSaving = current.dirty || current.pending || current.operation !== operation;
                                return {
                                    ...current,
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
                                    offline: !isOnline(),
                                    error: error instanceof Error ? error.message : "画布保存失败",
                                    conflict,
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
                        const current = get().projectSync[id];
                        if (completed && current && !current.conflict && (current.dirty || current.pending)) scheduleSave(id, 0);
                    }
                };

                return {
                    hydrated: false,
                    projects: [],
                    projectSync: {},
                    syncScope: null,
                    syncEnabled: false,
                    hydrate: async (scope = CANVAS_GUEST_SCOPE) => {
                        if (get().hydrated) return;
                        store.persist.setOptions({ name: `${CANVAS_STORE_KEY}:${scope}` });
                        try {
                            await store.persist.rehydrate();
                        } finally {
                            set({ hydrated: true, syncScope: scope, syncEnabled: false });
                        }
                    },
                    startSync: (scope) => {
                        const enabled = Boolean(scope) && scope !== CANVAS_GUEST_SCOPE;
                        set({ syncScope: scope || null, syncEnabled: enabled });
                        if (!enabled) return;
                        if (!subscribedToOnline) {
                            subscribeToBrowserOnline(() => get().retryPendingSaves());
                            subscribedToOnline = true;
                        }
                        get().retryPendingSaves();
                    },
                    replaceProjectsFromServer: (records) => {
                        set((state) => {
                            const localById = new Map(state.projects.map((project) => [project.id, project]));
                            const projects: CanvasProject[] = [];
                            const included = new Set<string>();
                            const projectSync: Record<string, CanvasProjectSync> = {};

                            for (const record of records) {
                                const metadata = state.projectSync[record.id];
                                if (hasUnsyncedChanges(metadata)) {
                                    const local = localById.get(record.id);
                                    if (local) {
                                        projects.push(local);
                                        included.add(record.id);
                                    }
                                    projectSync[record.id] = metadata as CanvasProjectSync;
                                    continue;
                                }
                                projects.push(localProject(record));
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

                            return { projects, projectSync };
                        });
                    },
                    refreshProjectFromServer: async (id) => {
                        if (!get().syncEnabled) return;
                        try {
                            const record = await api.get(id);
                            const project = localProject(record);
                            const currentTimer = saveTimers.get(id);
                            if (currentTimer) clearTimeout(currentTimer);
                            saveTimers.delete(id);
                            set((state) => {
                                const index = state.projects.findIndex((item) => item.id === id);
                                const projects = [...state.projects];
                                if (index >= 0) projects[index] = project;
                                else projects.unshift(project);
                                return { projects, projectSync: { ...state.projectSync, [id]: cleanSyncState(record.revision) } };
                            });
                        } catch (error) {
                            updateSync(id, (current) => (current ? { ...current, saving: false, error: error instanceof Error ? error.message : "画布刷新失败" } : current));
                            throw error;
                        }
                    },
                    retryPendingSaves: () => {
                        if (!get().syncEnabled || !isOnline()) return;
                        set((state) => ({
                            projectSync: Object.fromEntries(Object.entries(state.projectSync).map(([id, metadata]) => [id, { ...metadata, offline: false }])),
                        }));
                        for (const [id, metadata] of Object.entries(get().projectSync)) {
                            if (!metadata.conflict && (metadata.dirty || metadata.pending)) scheduleSave(id, 0);
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
                            connections: [],
                            backgroundMode: "lines",
                            showImageInfo: false,
                            viewport: initialViewport,
                        };
                        set((state) => ({ projects: [project, ...state.projects] }));
                        queueChange(id);
                        return id;
                    },
                    importProject: (source) => {
                        const now = new Date().toISOString();
                        const project: CanvasProject = {
                            id: nanoid(),
                            title: source.title || "导入画布",
                            createdAt: source.createdAt || now,
                            updatedAt: now,
                            nodes: source.nodes || [],
                            connections: source.connections || [],
                            backgroundMode: source.backgroundMode || "lines",
                            showImageInfo: source.showImageInfo || false,
                            viewport: source.viewport || initialViewport,
                        };
                        set((state) => ({ projects: [project, ...state.projects] }));
                        queueChange(project.id);
                        return project.id;
                    },
                    openProject: (id) => get().projects.find((item) => item.id === id) || null,
                    renameProject: (id, title) => {
                        let changed = false;
                        set((state) => ({
                            projects: state.projects.map((project) => {
                                if (project.id !== id) return project;
                                changed = true;
                                return { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() };
                            }),
                        }));
                        if (changed) queueChange(id);
                    },
                    deleteProjects: (ids) => {
                        const current = get();
                        set((state) => ({ projects: state.projects.filter((project) => !ids.includes(project.id)) }));
                        for (const id of ids) {
                            const metadata = current.projectSync[id];
                            const timer = saveTimers.get(id);
                            if (timer) clearTimeout(timer);
                            saveTimers.delete(id);
                            if (!get().syncEnabled) continue;
                            if (!metadata || (metadata.serverRevision === null && !inFlight.has(id))) {
                                updateSync(id, () => undefined);
                                continue;
                            }
                            const deletedProject = current.projects.find((project) => project.id === id);
                            queueChange(id, "delete", deletedProject);
                        }
                    },
                    updateProject: (id, patch) => {
                        let changed = false;
                        set((state) => ({
                            projects: state.projects.map((project) => {
                                if (project.id !== id) return project;
                                changed = true;
                                return { ...project, ...patch, updatedAt: new Date().toISOString() };
                            }),
                        }));
                        if (changed) queueChange(id);
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
