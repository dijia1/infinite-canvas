import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, sourceModule, flushAsync } from "@/test-utils/source-component";
import { createCanvasStore } from "../stores/use-canvas-store";
import type { useCanvasProjectEditorLease } from "./use-canvas-project-editor-lease";
import type { CanvasProjectDetail, CanvasProjectsApi } from "@/services/api/canvas-projects";

const record: CanvasProjectDetail = { id: "a", title: "server", revision: 1, createdAt: "2026-09-01", updatedAt: "2026-09-01", document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 5, y: 6, k: 0.8 } } };

test("initial editor lease activation preserves a dirty restored document and its save baseline", async () => {
    let reads = 0;
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => {
            reads++;
            return record;
        },
        create: async () => record,
        importProjects: async () => ({ items: [], total: 0 }),
        update: async () => record,
        delete: async () => {},
    };
    const store = createCanvasStore({ api, isOnline: () => false, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.getState().replaceProjectsFromServer([record]);
    store.setState({ syncScope: "owner", syncEnabled: true, readyForCanvasMutations: true });
    store.getState().renameProject("a", "dirty draft");
    const original = store.getState().openProject("a");
    const originalSync = store.getState().projectSync.a;
    const harness = hookHarness();
    const useStore = Object.assign((selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), { getState: store.getState });
    const lease = sourceModule<{ useCanvasProjectEditorLease: typeof useCanvasProjectEditorLease }>(
        new URL("./use-canvas-project-editor-lease.ts", import.meta.url),
        {
            react: { ...harness.hooks, useLayoutEffect: harness.hooks.useEffect },
            "../stores/use-canvas-store": { useCanvasStore: useStore },
            "./canvas-project-editor-lease": { canvasProjectEditorLeaseKey: () => "lease", claimCanvasProjectEditorLease: () => true, readCanvasProjectEditorLease: () => null },
            "./canvas-project-recovery-snapshot": { saveCanvasProjectRecoverySnapshot: async () => {}, cleanupExpiredCanvasProjectRecoverySnapshots: async () => {} },
            "./canvas-project-write-trace": { createCanvasProjectWriteTracer: () => ({ tabId: "test" }) },
        },
        { window: { addEventListener() {}, removeEventListener() {} }, navigator: { locks: { request: (_name: string, _options: unknown, cb: (lock: unknown) => Promise<void>) => cb({}) } }, BroadcastChannel: undefined },
    );
    harness.render(() => lease.useCanvasProjectEditorLease("a"));
    await flushAsync();
    try {
        assert.equal(store.getState().openProject("a"), original);
        assert.equal(store.getState().openProject("a")?.title, "dirty draft");
        assert.deepEqual(store.getState().projectSync.a, originalSync);
        assert.equal(store.getState().blockedProjectSync.a, undefined);
        assert.equal(reads, 0);
    } finally {
        harness.unmount();
    }
});

test("retry after initial detail failure reactivates the owner lease", async () => {
    let reads = 0;
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => {
            if (++reads === 1) throw new Error("offline");
            return record;
        },
        create: async () => record,
        importProjects: async () => ({ items: [], total: 0 }),
        update: async () => record,
        delete: async () => {},
    };
    const store = createCanvasStore({ api, isOnline: () => false, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.setState({ syncScope: "owner", syncEnabled: true, readyForCanvasMutations: true });
    const harness = hookHarness();
    const useStore = Object.assign((selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), { getState: store.getState });
    const lease = sourceModule<{ useCanvasProjectEditorLease: (...args: unknown[]) => void }>(
        new URL("./use-canvas-project-editor-lease.ts", import.meta.url),
        {
            react: { ...harness.hooks, useLayoutEffect: harness.hooks.useEffect },
            "../stores/use-canvas-store": { useCanvasStore: useStore },
            "./canvas-project-editor-lease": { canvasProjectEditorLeaseKey: () => "lease", claimCanvasProjectEditorLease: () => true, readCanvasProjectEditorLease: () => null },
            "./canvas-project-recovery-snapshot": { saveCanvasProjectRecoverySnapshot: async () => {}, cleanupExpiredCanvasProjectRecoverySnapshots: async () => {} },
            "./canvas-project-write-trace": { createCanvasProjectWriteTracer: () => ({ tabId: "test" }) },
        },
        { window: { addEventListener() {}, removeEventListener() {} }, navigator: { locks: { request: (_name: string, _options: unknown, cb: (lock: unknown) => Promise<void>) => cb({}) } }, BroadcastChannel: undefined },
    );
    harness.render(() => lease.useCanvasProjectEditorLease("a", undefined, 0));
    await flushAsync();
    try {
        assert.equal(store.getState().blockedProjectSync.a, true);
        assert.equal(store.getState().openProject("a"), null);
        harness.render(() => lease.useCanvasProjectEditorLease("a", undefined, 1));
        await flushAsync();
        assert.equal(store.getState().blockedProjectSync.a, undefined);
        assert.equal(store.getState().openProject("a")?.title, "server");
    } finally {
        harness.unmount();
    }
});

test("leaving during detail load releases the web lock after the response", async () => {
    const response = Promise.withResolvers<CanvasProjectDetail>();
    let released = false;
    const api: CanvasProjectsApi = { list: async () => ({ items: [], total: 0 }), get: async () => response.promise, create: async () => record, importProjects: async () => ({ items: [], total: 0 }), update: async () => record, delete: async () => {} };
    const store = createCanvasStore({ api, isOnline: () => false, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.setState({ syncScope: "owner", syncEnabled: true, readyForCanvasMutations: true });
    const harness = hookHarness();
    const useStore = Object.assign((selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), { getState: store.getState });
    const lease = sourceModule<{ useCanvasProjectEditorLease: (...args: unknown[]) => void }>(
        new URL("./use-canvas-project-editor-lease.ts", import.meta.url),
        {
            react: { ...harness.hooks, useLayoutEffect: harness.hooks.useEffect },
            "../stores/use-canvas-store": { useCanvasStore: useStore },
            "./canvas-project-editor-lease": { canvasProjectEditorLeaseKey: () => "lease", claimCanvasProjectEditorLease: () => true, readCanvasProjectEditorLease: () => null },
            "./canvas-project-recovery-snapshot": { saveCanvasProjectRecoverySnapshot: async () => {}, cleanupExpiredCanvasProjectRecoverySnapshots: async () => {} },
            "./canvas-project-write-trace": { createCanvasProjectWriteTracer: () => ({ tabId: "test" }) },
        },
        {
            window: { addEventListener() {}, removeEventListener() {} },
            navigator: {
                locks: {
                    request: (_name: string, _options: unknown, cb: (lock: unknown) => Promise<void>) =>
                        cb({}).then(() => {
                            released = true;
                        }),
                },
            },
            BroadcastChannel: undefined,
        },
    );
    harness.render(() => lease.useCanvasProjectEditorLease("a", undefined, 0));
    await flushAsync();
    harness.unmount();
    response.resolve(record);
    await flushAsync();
    assert.equal(released, true);
});
