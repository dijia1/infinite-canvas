import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasStore } from "./use-canvas-store";
import type { CanvasProjectsApi, CanvasProjectDetail, CanvasSummary } from "@/services/api/canvas-projects";

const base: CanvasProjectDetail = { id: "summary", title: "base", revision: 1, createdAt: "2026-10-03", updatedAt: "2026-10-03", document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } } };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const ack = (revision: number, title: string): CanvasSummary => ({ id: base.id, title, revision, createdAt: base.createdAt, updatedAt: "2026-10-03T01:00:00Z", nodeCount: 0, connectionCount: 0 });
function setup(update: CanvasProjectsApi["update"]) {
    let gets = 0;
    const api: CanvasProjectsApi = { list: async () => ({ items: [], total: 0 }), get: async () => { gets++; return base; }, create: async () => base, importProjects: async () => ({ items: [], total: 0 }), delete: async () => {}, update };
    const store = createCanvasStore({ api, serverDebounceMs: 0, isOnline: () => true });
    store.getState().replaceProjectsFromServer([base]);
    store.getState().startSync("summary-owner");
    return { store, gets: () => gets };
}

test("a compact save acknowledgement updates counts without a follow-up GET or document replacement", async (t) => {
    const started = Promise.withResolvers<void>(), done = Promise.withResolvers<CanvasSummary>();
    const { store, gets } = setup(async () => { started.resolve(); return done.promise; });
    t.after(() => store.getState().releaseProjectEditor(base.id));
    store.getState().renameProject(base.id, "A");
    const submitted = store.getState().projects[0];
    await started.promise;
    done.resolve(ack(2, "A"));
    await settle();
    assert.equal(store.getState().projectSync[base.id].serverRevision, 2);
    assert.equal(store.getState().projectSync[base.id].unknownRequest, undefined);
    assert.equal(store.getState().projectSync[base.id].dirty, false);
    assert.equal(store.getState().projectSync[base.id].error, null);
    assert.equal(store.getState().projects[0], submitted);
    assert.deepEqual(store.getState().summaries[0], ack(2, "A"));
    assert.equal(gets(), 0);
});

test("an older compact acknowledgement leaves newer edits dirty until their own save", async (t) => {
    const first = Promise.withResolvers<CanvasSummary>(), second = Promise.withResolvers<CanvasSummary>();
    const firstStarted = Promise.withResolvers<void>(), secondStarted = Promise.withResolvers<void>();
    const inputs: string[] = [];
    const { store } = setup(async (_id, input) => {
        inputs.push(input.title);
        if (inputs.length === 1) { firstStarted.resolve(); return first.promise; }
        secondStarted.resolve(); return second.promise;
    });
    t.after(() => store.getState().releaseProjectEditor(base.id));
    store.getState().renameProject(base.id, "A");
    await firstStarted.promise;
    store.getState().renameProject(base.id, "B");
    first.resolve(ack(2, "A"));
    await secondStarted.promise;
    assert.equal(store.getState().projects[0].title, "B");
    assert.equal(store.getState().projectSync[base.id].serverRevision, 2);
    assert.equal(store.getState().projectSync[base.id].saving, true);
    assert.deepEqual(inputs, ["A", "B"]);
    second.resolve(ack(3, "B"));
    await settle();
    assert.equal(store.getState().projectSync[base.id].dirty, false);
    assert.equal(store.getState().projectSync[base.id].serverRevision, 3);
});

test("a full save response from an old server remains supported", async (t) => {
    const started = Promise.withResolvers<void>();
    const { store } = setup(async (_id, input) => { started.resolve(); return { ...base, ...input, revision: 2 }; });
    t.after(() => store.getState().releaseProjectEditor(base.id));
    store.getState().renameProject(base.id, "legacy");
    await started.promise; await settle();
    assert.equal(store.getState().projectSync[base.id].dirty, false);
    assert.equal(store.getState().summaries[0].title, "legacy");
});

for (const invalid of [{ nodeCount: -1 }, { connectionCount: 0.5 }, { updatedAt: undefined }, { id: "other" }, { revision: 3 }]) {
    test(`a malformed compact acknowledgement stays unconfirmed: ${JSON.stringify(invalid)}`, async (t) => {
        const started = Promise.withResolvers<void>();
        const { store } = setup(async () => { started.resolve(); return { ...ack(2, "A"), ...invalid } as never; });
        t.after(() => store.getState().releaseProjectEditor(base.id));
        store.getState().renameProject(base.id, "A");
        await started.promise; await settle();
        const sync = store.getState().projectSync[base.id];
        assert.equal(sync.serverRevision, 1);
        assert.ok(sync.unknownRequest);
        assert.equal(sync.dirty, true);
        assert.ok(sync.error);
    });
}
