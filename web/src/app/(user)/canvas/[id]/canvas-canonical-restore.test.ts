import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasStore } from "../stores/use-canvas-store.ts";
import type { CanvasProjectRecord } from "@/services/api/canvas-projects";
import { createCanvasCanonicalRestore } from "./canvas-canonical-restore.ts";

function record(title: string, revision: number): CanvasProjectRecord {
    return { id: "project-1", title, revision, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } } };
}

test("an open page applies the bootstrap canonical snapshot and cancels stale hydration", async () => {
    const store = createCanvasStore();
    const restore = createCanvasCanonicalRestore<string>();
    const applied: string[] = [];
    let resolveLocal!: (value: string) => void;
    const localHydration = new Promise<string>((resolve) => (resolveLocal = resolve));

    const stale = restore.run(async () => localHydration, (title) => applied.push(title));
    store.getState().replaceProjectsFromServer([record("服务器画布", 2)]);
    const canonical = store.getState().openProject("project-1");
    await restore.run(async () => canonical?.title || "", (title) => applied.push(title));
    resolveLocal("过期本地画布");
    await stale;

    assert.deepEqual(applied, ["服务器画布"]);
    assert.equal(store.getState().canonicalGeneration, 1);
});
