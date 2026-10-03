import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createCanvasDocumentPublisher, type CanvasEditorDocument } from "../hooks/use-canvas-document-sync";
import { createCanvasStore } from "./use-canvas-store";
import type { CanvasProjectsApi, CanvasProjectDetail } from "@/services/api/canvas-projects";

const baseline: CanvasEditorDocument = { nodes: [], connections: [], maskResources: {}, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("local publication coalesces at 100ms without postponing continuous edits", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const writes: CanvasEditorDocument[] = [];
    const publisher = createCanvasDocumentPublisher({ publish: (next) => writes.push(next), isCurrent: () => true });
    try {
        publisher.capture({ ...baseline, showImageInfo: true }, baseline);
        mock.timers.tick(50);
        const latest = { ...baseline, showImageInfo: true, backgroundMode: "dots" as const };
        publisher.capture(latest, baseline);
        mock.timers.tick(49);
        assert.equal(writes.length, 0);
        mock.timers.tick(1);
        assert.deepEqual(writes, [latest]);
    } finally {
        publisher.cancel();
        mock.timers.reset();
    }
});

test("continuous local publications produce one cloud save 300ms after release", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls: CanvasProjectDetail[] = [];
    const base: CanvasProjectDetail = { id: "scheduling", title: "test", revision: 1, createdAt: "2026-10-03", updatedAt: "2026-10-03", document: baseline };
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }), get: async () => base,
        create: async () => base, importProjects: async () => ({ items: [], total: 0 }), delete: async () => {},
        update: async (id, input) => { const result = { ...base, id, ...input, revision: input.revision + 1 }; calls.push(result); return result; },
    };
    const store = createCanvasStore({ api, isOnline: () => true });
    store.getState().replaceProjectsFromServer([base]);
    store.getState().startSync("scheduling-owner");
    const publisher = createCanvasDocumentPublisher({ publish: (next) => store.getState().updateProject(base.id, next), isCurrent: () => true });
    try {
        for (let index = 1; index <= 20; index++) {
            publisher.capture({ ...baseline, viewport: { x: index, y: 0, k: 1 } }, baseline);
            mock.timers.tick(100);
            await settle();
            assert.equal(store.getState().projects[0].viewport.x, index, "local draft must stay current during a long gesture");
            assert.equal(calls.length, 0, "continuous publication must not flood cloud saves");
        }
        publisher.capture({ ...baseline, viewport: { x: 21, y: 0, k: 1 } }, baseline);
        publisher.flush();
        await settle();
        mock.timers.tick(299);
        await settle();
        assert.equal(calls.length, 0);
        mock.timers.tick(1);
        await settle();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].document.viewport.x, 21);
        assert.equal(store.getState().projectSync[base.id].dirty, false);
    } finally {
        publisher.cancel();
        store.getState().releaseProjectEditor(base.id);
        mock.timers.reset();
    }
});
