import { sanitizeCanvasProjectDocument } from "@/services/canvas-project-document";
import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasProjectDetail, CanvasProjectsApi } from "@/services/api/canvas-projects";
import { createCanvasStore } from "./use-canvas-store";

const detail = (id = "a", revision = 1): CanvasProjectDetail => ({
    id,
    title: `Canvas ${id}`,
    revision,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    document: {
        nodes: [{ id: "text", type: "text" as never, title: "", position: { x: 5, y: 8 }, width: 100, height: 90, metadata: { content: "preserve me", storageKey: "image:local-only" } }],
        connections: [],
        maskResources: {},
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 80, y: 60, k: 0.8 },
    },
});
const summary = (id = "a", revision = 1) => ({ id, title: `Canvas ${id}`, revision, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", nodeCount: 1, connectionCount: 0 });
function setup(overrides: Partial<CanvasProjectsApi> = {}) {
    const requests: string[] = [];
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async (id) => {
            requests.push(id);
            return detail(id);
        },
        create: async (input) => detail(input.id),
        importProjects: async () => ({ items: [], total: 0 }),
        update: async (id, input) => ({ ...detail(id, input.revision + 1), title: input.title, document: input.document }),
        delete: async () => {},
        ...overrides,
    };
    const store = createCanvasStore({ api, isOnline: () => false, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.setState({ syncScope: "owner", syncEnabled: true });
    return { store, requests };
}

test("summary refresh does not fetch details, create empty documents or advance canonical generation", () => {
    const { store, requests } = setup();
    const generation = store.getState().canonicalGeneration;
    store.getState().mergeProjectSummaries([summary()]);
    assert.equal(store.getState().summaries[0]?.nodeCount, 1);
    assert.equal(store.getState().openProject("a"), null);
    assert.deepEqual(requests, []);
    assert.equal(store.getState().canonicalGeneration, generation);
});

test("summary refresh preserves dirty document and its original base revision", () => {
    const { store } = setup();
    store.getState().replaceProjectsFromServer([detail()]);
    store.getState().renameProject("a", "unsaved local title");
    const project = store.getState().openProject("a");
    const sync = store.getState().projectSync.a;
    store.getState().mergeProjectSummaries([summary("a", 9)]);
    assert.equal(store.getState().openProject("a"), project);
    assert.deepEqual(store.getState().projectSync.a, sync);
    assert.equal(store.getState().projectSync.a?.serverRevision, 1);
    assert.equal(store.getState().summaries[0]?.revision, 9);
});

test("safe detail loading returns full document and shares an in-flight request", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    let calls = 0;
    const { store } = setup({
        get: async () => {
            calls++;
            return response.promise;
        },
    });
    store.getState().mergeProjectSummaries([summary()]);
    const a = store.getState().ensureProjectDetail("a");
    const b = store.getState().ensureProjectDetail("a");
    response.resolve(detail());
    const [first, second] = await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal(first.nodes[0]?.metadata?.content, "preserve me");
    assert.deepEqual(first.viewport, { x: 80, y: 60, k: 0.8 });
});

test("safe loading uses new and dirty local documents without GET", async () => {
    const { store, requests } = setup();
    const id = store.getState().createProject("local new");
    const local = store.getState().openProject(id);
    assert.equal(await store.getState().ensureProjectDetail(id), local);
    store.getState().replaceProjectsFromServer([detail()]);
    store.getState().renameProject("a", "dirty");
    store.getState().mergeProjectSummaries([summary("a", 8)]);
    assert.equal((await store.getState().ensureProjectDetail("a")).title, "dirty");
    assert.deepEqual(requests, []);
});

test("late detail cannot overwrite an edit made while it was loading", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const { store } = setup({ get: async () => response.promise });
    store.getState().replaceProjectsFromServer([detail()]);
    store.getState().mergeProjectSummaries([summary("a", 2)]);
    const loading = store.getState().ensureProjectDetail("a");
    store.getState().renameProject("a", "new edit");
    response.resolve(detail("a", 2));
    assert.equal((await loading).title, "new edit");
    assert.equal(store.getState().projectSync.a?.serverRevision, 1);
    assert.equal(store.getState().projectSync.a?.dirty, true);
});

test("late detail from a previous session cannot populate the current store", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const { store } = setup({ get: async () => response.promise });
    store.getState().mergeProjectSummaries([summary()]);
    const loading = store.getState().ensureProjectDetail("a");
    store.setState({ syncScope: "someone-else", projects: [], summaries: [], projectSync: {} });
    response.resolve(detail());
    await assert.rejects(loading);
    assert.equal(store.getState().openProject("a"), null);
    assert.deepEqual(store.getState().projectSync, {});
});

test("deleting a summary during GET does not resurrect its document", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const { store } = setup({ get: async () => response.promise });
    store.getState().mergeProjectSummaries([summary()]);
    const loading = store.getState().ensureProjectDetail("a");
    store.getState().deleteProjects(["a"]);
    response.resolve(detail());
    await assert.rejects(loading);
    assert.equal(store.getState().openProject("a"), null);
    assert.equal(store.getState().projectSync.a?.operation, "delete");
});

test("failed detail loading leaves no empty canvas and can be retried", async () => {
    let calls = 0;
    const { store } = setup({
        get: async () => {
            if (++calls === 1) throw new Error("offline");
            return detail();
        },
    });
    store.getState().mergeProjectSummaries([summary()]);
    await assert.rejects(store.getState().ensureProjectDetail("a"), /offline/);
    assert.equal(store.getState().openProject("a"), null);
    assert.equal((await store.getState().ensureProjectDetail("a")).nodes.length, 1);
});

test("summaries do not discard locally persisted media reference documents", () => {
    const { store } = setup();
    store.getState().replaceProjectsFromServer([detail()]);
    const cached = store.getState().openProject("a");
    store.getState().mergeProjectSummaries([summary("a", 5), summary("unopened")]);
    assert.equal(store.getState().openProject("a"), cached);
    assert.equal(store.getState().projects[0]?.nodes[0]?.metadata?.storageKey, "image:local-only");
    assert.equal(store.getState().openProject("unopened"), null);
});

test("an older detail cannot replace a newer known summary revision", async () => {
    const { store } = setup({ get: async () => detail("a", 1) });
    store.getState().mergeProjectSummaries([summary("a", 2)]);
    await assert.rejects(store.getState().ensureProjectDetail("a"));
    assert.equal(store.getState().openProject("a"), null);
});

test("a clean cached document is refreshed without borrowing summary revision for its base", async () => {
    const { store } = setup({ get: async () => detail("a", 3) });
    store.getState().replaceProjectsFromServer([detail()]);
    store.getState().mergeProjectSummaries([summary("a", 3)]);
    assert.equal(store.getState().projectSync.a?.serverRevision, 1);
    assert.equal((await store.getState().ensureProjectDetail("a")).nodes.length, 1);
    assert.equal(store.getState().projectSync.a?.serverRevision, 3);
});

test("safe detail caching does not reset another mounted editor canonical generation", async () => {
    const { store } = setup();
    store.getState().mergeProjectSummaries([summary()]);
    const generation = store.getState().canonicalGeneration;
    await store.getState().ensureProjectDetail("a");
    assert.equal(store.getState().canonicalGeneration, generation);
});

test("a real summary bootstrap retains rehydrated dirty content, replay metadata and base revision", async () => {
    const { bootstrapCanvasProjects } = await import("@/services/canvas-project-bootstrap");
    const record = detail();
    const saved = { ...record.document, maskResources: {}, id: record.id, title: "local dirty", createdAt: record.createdAt, updatedAt: record.updatedAt };
    const pending = {
        serverRevision: 1,
        dirty: true,
        pending: true,
        saving: false,
        offline: true,
        error: "response lost",
        conflict: false,
        operation: "save" as const,
        unknownRequest: { baseRevision: 1, title: "original request", document: sanitizeCanvasProjectDocument(record.document), trace: { tabId: "tab", requestId: "request", requestSeq: 1, reason: "autosave" as const } },
    };
    let gets = 0;
    let imports = 0;
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [summary("a", 9)], total: 1 }),
        get: async () => {
            gets++;
            return record;
        },
        importProjects: async () => {
            imports++;
            return { items: [], total: 0 };
        },
        create: async () => record,
        update: async () => record,
        delete: async () => {},
    };
    const store = createCanvasStore({ api, isOnline: () => false, storage: { getItem: async () => ({ state: { projects: [saved], projectSync: { a: pending } } }) as never, setItem: async () => {}, removeItem: async () => {} } });
    await store.getState().hydrate("owner");
    const local = store.getState().openProject("a");
    const generation = store.getState().canonicalGeneration;
    await bootstrapCanvasProjects({
        uid: "owner",
        api,
        getProjects: () => store.getState().projects,
        adoptImportedProjects: store.getState().adoptImportedProjects,
        mergeProjectSummaries: store.getState().mergeProjectSummaries,
        startSync: store.getState().startSync,
    });
    assert.equal(store.getState().openProject("a"), local);
    assert.deepEqual(store.getState().projectSync.a, pending);
    assert.equal(store.getState().canonicalGeneration, generation);
    assert.equal(gets, 0);
    assert.equal(imports, 0);
});

test("a dirty save still submits its original revision and receives 409 after a newer summary", async () => {
    const { ApiRequestError } = await import("@/services/api/request");
    const revisions: number[] = [];
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => detail("a", 9),
        importProjects: async () => ({ items: [], total: 0 }),
        create: async () => detail(),
        delete: async () => {},
        update: async (_id, input) => {
            revisions.push(input.revision);
            throw new ApiRequestError("conflict", 409, 1);
        },
    };
    const store = createCanvasStore({ api, serverDebounceMs: 1, isOnline: () => true, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.getState().replaceProjectsFromServer([detail()]);
    store.setState({ syncScope: "owner", syncEnabled: true });
    store.getState().renameProject("a", "dirty title");
    store.getState().mergeProjectSummaries([summary("a", 9)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(revisions, [1]);
    assert.equal(store.getState().projectSync.a?.serverRevision, 1);
    assert.equal(store.getState().projectSync.a?.conflict, true);
    assert.equal(store.getState().openProject("a")?.title, "dirty title");
});

test("summary-only deletion uses the latest listed revision and restores its card on 409", async () => {
    const { ApiRequestError } = await import("@/services/api/request");
    const { selectCanvasProjectSummaries } = await import("./use-canvas-store");
    const revisions: number[] = [];
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => {
            throw new Error("delete must not fetch detail");
        },
        importProjects: async () => ({ items: [], total: 0 }),
        create: async () => detail(),
        update: async () => detail(),
        delete: async (_id, revision) => {
            revisions.push(revision);
            throw new ApiRequestError("conflict", 409, 1);
        },
    };
    const store = createCanvasStore({ api, serverDebounceMs: 1, isOnline: () => true, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.setState({ syncScope: "owner", syncEnabled: true });
    store.getState().mergeProjectSummaries([summary("a", 1)]);
    store.getState().mergeProjectSummaries([summary("a", 9)]);
    store.getState().deleteProjects(["a"]);
    assert.deepEqual(selectCanvasProjectSummaries(store.getState()), []);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(revisions, [9]);
    assert.equal(selectCanvasProjectSummaries(store.getState())[0]?.id, "a");
    assert.equal(store.getState().projectSync.a?.conflict, true);
    assert.equal(store.getState().openProject("a"), null);
});

test("successful summary-only deletion stays removed after sync metadata is cleared", async () => {
    const { selectCanvasProjectSummaries } = await import("./use-canvas-store");
    const deleted = Promise.withResolvers<void>();
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => {
            throw new Error("unexpected detail GET");
        },
        importProjects: async () => ({ items: [], total: 0 }),
        create: async () => detail(),
        update: async () => detail(),
        delete: async () => deleted.resolve(),
    };
    const store = createCanvasStore({ api, serverDebounceMs: 1, isOnline: () => true, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.setState({ syncScope: "owner", syncEnabled: true });
    store.getState().mergeProjectSummaries([summary()]);
    store.getState().deleteProjects(["a"]);
    await deleted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.getState().projectSync.a, undefined);
    assert.deepEqual(store.getState().summaries, []);
    assert.deepEqual(selectCanvasProjectSummaries(store.getState()), []);
});

test("summary bootstrap finishing after scope change cannot publish or start synchronization", async () => {
    const { bootstrapCanvasProjects } = await import("@/services/canvas-project-bootstrap");
    const response = Promise.withResolvers<{ items: ReturnType<typeof summary>[]; total: number }>();
    let current = true;
    const calls: string[] = [];
    const run = bootstrapCanvasProjects({
        uid: "old",
        isCurrent: () => current,
        getProjects: () => [],
        api: {
            list: async () => response.promise,
            importProjects: async () => {
                throw new Error("unexpected import");
            },
        },
        mergeProjectSummaries: () => {
            calls.push("merge");
        },
        startSync: () => {
            calls.push("start");
        },
    });
    current = false;
    response.resolve({ items: [summary()], total: 1 });
    assert.equal(await run, false);
    assert.deepEqual(calls, []);
});

test("a late force-refresh response cannot undo a deletion made while GET was pending", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const { store } = setup({ get: async () => response.promise });
    store.getState().replaceProjectsFromServer([detail()]);
    const loading = store.getState().refreshProjectFromServer("a");
    await Promise.resolve();
    store.getState().deleteProjects(["a"]);
    response.resolve(detail("a", 2));
    await assert.rejects(loading, /失效/);
    assert.equal(store.getState().openProject("a"), null);
    assert.equal(store.getState().projectSync.a?.operation, "delete");
    assert.equal(store.getState().projectSync.a?.dirty, true);
});

test("a detail response cannot restore an ID removed by a newer catalog", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const { store } = setup({ get: async () => response.promise });
    store.getState().mergeProjectSummaries([summary()]);
    const loading = store.getState().ensureProjectDetail("a");
    store.getState().mergeProjectSummaries([]);
    response.resolve(detail());
    await assert.rejects(loading, /失效/);
    assert.equal(store.getState().openProject("a"), null);
    assert.deepEqual(store.getState().summaries, []);
});

test("a force refresh from the previous account cannot change current documents or sync errors", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const { store } = setup({ get: async () => response.promise });
    const loading = store.getState().refreshProjectFromServer("a");
    await Promise.resolve();
    store.setState({ syncScope: "other", projects: [], summaries: [], projectSync: {} });
    response.resolve(detail());
    await assert.rejects(loading, /失效/);
    assert.deepEqual(store.getState().projects, []);
    assert.deepEqual(store.getState().projectSync, {});
});

test("deletion queued during a force refresh still reaches the server after the late GET", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const deleted = Promise.withResolvers<void>();
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => response.promise,
        importProjects: async () => ({ items: [], total: 0 }),
        create: async () => detail(),
        update: async () => detail(),
        delete: async () => deleted.resolve(),
    };
    const store = createCanvasStore({ api, serverDebounceMs: 1, isOnline: () => true, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.setState({ syncScope: "owner", syncEnabled: true });
    store.getState().replaceProjectsFromServer([detail()]);
    const loading = store.getState().refreshProjectFromServer("a");
    await Promise.resolve();
    store.getState().deleteProjects(["a"]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    response.resolve(detail("a", 2));
    await assert.rejects(loading);
    const timer = setTimeout(() => deleted.reject(new Error("pending delete never resumed")), 1000);
    try {
        await deleted.promise;
    } finally {
        clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.getState().openProject("a"), null);
    assert.equal(store.getState().projectSync.a, undefined);
});
