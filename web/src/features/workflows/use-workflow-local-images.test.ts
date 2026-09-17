import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, sourceModule, deferred } from "@/test-utils/source-component";
import * as queue from "@/app/(user)/canvas/media/canvas-local-image-upload-controller";
import * as files from "@/app/(user)/canvas/utils/canvas-file-drop";
import * as retention from "@/services/image-cache-retention";
import * as scope from "@/lib/portal-storage-scope";
import * as adapter from "./workflow-canvas-adapter";
import * as drop from "./workflow-image-drop";
import * as state from "./workflow-local-images";
import type { useWorkflowLocalImages } from "./use-workflow-local-images";
import type { UploadedImage } from "@/services/image-storage";
import type { WorkflowGraph } from "./types";

function storage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (i: number) => [...values.keys()][i] || null, get length() { return values.size; }, clear: () => values.clear() } satisfies Storage;
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function fixture(sharedStorage = storage(), blobs = new Map<string, Blob>()) {
    const h = hookHarness();
    let graph: WorkflowGraph = { version: 1, nodes: [], connections: [] };
    let readOnly = false, selections = 0, published = 0;
    const retained: string[] = [];
    const calls: Array<{ file: File; gate: ReturnType<typeof deferred<{ mediaId: string; url: string }>> }> = [];
    const warnings: string[] = [];
    let key = 0, failPromotion = false;
    const { useWorkflowLocalImages: useHook } = sourceModule<{ useWorkflowLocalImages: typeof useWorkflowLocalImages }>(new URL("./use-workflow-local-images.ts", import.meta.url), {
        react: h.hooks, nanoid: { nanoid: () => `op-${++key}` },
        "@/app/(user)/canvas/media/canvas-local-image-upload-controller": queue,
        "@/app/(user)/canvas/utils/canvas-file-drop": files,
        "@/services/api/image": { uploadUserImage: async (file: File, intent: string) => { assert.equal(intent, "library"); const gate = deferred<{ mediaId: string; url: string }>(); calls.push({ file, gate }); return gate.promise; } },
        "@/services/image-storage": {
            uploadImage: async (file: File): Promise<UploadedImage> => { const storageKey = `image:${file.name}:${++key}`; blobs.set(storageKey, file); return { url: `blob:${storageKey}`, storageKey, width: 800, height: 400, bytes: file.size, mimeType: file.type }; },
            releaseImageObjectURL: () => undefined,
            getImageBlob: async (key: string) => blobs.get(key), resolveImageUrl: async (key: string) => `blob:${key}`,
            imageStorageKeyForMedia: (id: string) => `media:${id}:v1:original`,
            promoteImageStorageKey: async (image: UploadedImage, mediaId: string) => { if (failPromotion) { failPromotion = false; throw new Error("cache unavailable"); } blobs.set(`media:${mediaId}:v1:original`, blobs.get(image.storageKey)!); return { ...image, mediaId }; },
        },
        "@/services/image-cache-retention": retention, "@/lib/portal-storage-scope": scope,
        "./workflow-canvas-adapter": adapter, "./workflow-image-drop": drop, "./workflow-local-images": state,
    }, { window: { localStorage: sharedStorage, addEventListener() {}, removeEventListener() {} } });
    const render = () => h.render(() => useHook({ uid: "u", workflowId: "w", revision: 7, readOnly, ready: true, document: { name: "Workflow", graph }, setGraph: update => { graph = typeof update === "function" ? update(graph) : update; }, onSelected: () => selections++, notify: text => warnings.push(text), beforeEdit() {}, retainedHistory: () => retained, onUploaded: () => published++ }));
    let hook = render();
    return { calls, blobs, sharedStorage, warnings, failPromotion: () => { failPromotion = true; }, retain: (snapshot: string) => retained.push(snapshot), get graph() { return graph; }, get hook() { return hook; }, get published() { return published; }, get selections() { return selections; },
        render: () => { hook = render(); return hook; }, graphChanged: (next: WorkflowGraph) => { graph = next; hook = render(); }, setReadonly: () => { readOnly = true; hook = render(); }, unmount: () => h.unmount(), get postUnmountUpdates() { return h.postUnmountUpdates; } };
}
const file = (name = "one.png") => new File([name], name, { type: "image/png" });

for (const end of ["complete", "readonly", "unmount", "delete", "undo"] as const) test(`local preview precedes upload; ${end} protects the current graph`, async () => {
    const f = fixture();
    const before = f.hook.snapshot({ name: "Workflow", graph: f.graph });
    await f.hook.importFiles([file()], { x: 400, y: 500 });
    assert.equal(f.graph.nodes.length, 1);
    assert.equal(f.graph.nodes[0].mediaId, undefined);
    f.render();
    const id = f.graph.nodes[0].id;
    assert.ok(f.hook.get(id)?.url?.startsWith("blob:"));
    await tick(); f.render();
    assert.equal(f.calls.length, 1);
    f.graphChanged({ ...f.graph, nodes: f.graph.nodes.map(node => ({ ...node, position: { x: 999, y: 55 } })), connections: [] });
    if (end === "readonly") f.setReadonly();
    if (end === "unmount") f.unmount();
    if (end === "delete") f.graphChanged({ ...f.graph, nodes: [] });
    if (end === "undo") f.graphChanged(f.hook.applyHistory(before).graph);
    f.calls[0].gate.resolve({ mediaId: "remote", url: "oss" });
    await tick();
    if (end !== "unmount") f.render();
    assert.equal(f.graph.nodes[0]?.mediaId, end === "complete" ? "remote" : undefined);
    if (end === "complete") assert.deepEqual(f.graph.nodes[0].position, { x: 999, y: 55 });
    assert.equal(f.published, end === "complete" ? 1 : 0);
    if (end !== "unmount") f.unmount();
    assert.equal(f.postUnmountUpdates, 0);
});

test("replacement fails, retries and cancels without losing position or the old server reference", async () => {
    const f = fixture();
    f.graphChanged({ ...f.graph, nodes: [{ id: "image", type: "image_input", mediaId: "old", width: 100, height: 100, position: { x: 10, y: 20 } }] });
    await f.hook.importFiles([file()], { x: 999, y: 999 }, "image"); f.render(); await tick();
    assert.equal(f.graph.nodes[0].mediaId, "old");
    f.calls[0].gate.reject(new Error("unavailable")); await tick(); f.render();
    assert.equal(f.hook.get("image")?.state, "failed");
    f.hook.retry("image"); await tick(); f.render();
    assert.equal(f.calls.length, 2);
    f.hook.cancelReplacement("image"); f.render();
    f.calls[1].gate.resolve({ mediaId: "too-late", url: "oss" }); await tick(); f.render();
    assert.equal(f.graph.nodes[0].mediaId, "old");
    assert.equal(f.graph.nodes[0].width, 100);
    assert.deepEqual(f.graph.nodes[0].position, { x: 10, y: 20 });
    f.unmount();
});

test("rapid replacements accept only the newest import; redo reuses its confirmed upload", async () => {
    const f = fixture();
    await f.hook.importFiles([file()], { x: 0, y: 0 }); f.render(); await tick();
    const id = f.graph.nodes[0].id;
    await f.hook.importFiles([file("new.png")], { x: 0, y: 0 }, id); f.render(); await tick();
    assert.equal(f.calls.length, 2);
    f.calls[1].gate.resolve({ mediaId: "new", url: "oss" }); await tick(); f.render();
    f.calls[0].gate.resolve({ mediaId: "old", url: "oss" }); await tick(); f.render();
    assert.equal(f.graph.nodes[0].mediaId, "new");
    const saved = f.hook.snapshot({ name: "Workflow", graph: f.graph });
    f.retain(saved);
    f.graphChanged({ ...f.graph, nodes: [] });
    f.graphChanged(f.hook.applyHistory(saved).graph); await tick(); f.render();
    assert.equal(f.graph.nodes[0].mediaId, "new");
    assert.equal(f.calls.length, 2);
    f.unmount();
});

test("reopened editor restores a pending preview and uploaded records reuse mediaId", async () => {
    const f = fixture();
    await f.hook.importFiles([file()], { x: 0, y: 0 }); f.render(); await tick();
    const record = f.hook.readRecovery()!;
    assert.equal(record.revision, 7);
    assert.equal(JSON.stringify(record).includes("blob:"), false);
    f.unmount();
    const g = fixture(f.sharedStorage, f.blobs);
    g.hook.recover(record); g.graphChanged(g.hook.restoreDocument(record).graph); await tick(); g.render();
    assert.equal(g.calls.length, 1);
    assert.ok(g.hook.get(g.graph.nodes[0].id)?.url);
    g.calls[0].gate.resolve({ mediaId: "done", url: "oss" }); await tick(); g.render();
    const completed = g.hook.readRecovery()!; g.unmount();
    const k = fixture(f.sharedStorage, f.blobs);
    k.hook.recover(completed); k.graphChanged(k.hook.restoreDocument(completed).graph); await tick(); k.render();
    assert.equal(k.graph.nodes[0].mediaId, "done");
    assert.equal(k.calls.length, 0);
    k.unmount();
});

test("lost pending cache is a visible retryable error and never becomes an empty successful input", async () => {
    const f = fixture();
    await f.hook.importFiles([file()], { x: 0, y: 0 }); f.render(); await tick();
    const record = f.hook.readRecovery()!; f.unmount();
    const g = fixture(f.sharedStorage);
    g.hook.recover(record); g.graphChanged(g.hook.restoreDocument(record).graph); await tick(); g.render();
    assert.match(g.hook.get(g.graph.nodes[0].id)?.error || "", /缓存已丢失/);
    assert.equal(g.calls.length, 0);
    assert.equal(g.hook.pending({ type: "workflow" }).length, 1);
    g.unmount();
});


test("cache promotion retry uses the acknowledged mediaId without uploading the file again", async () => {
    const f = fixture();
    await f.hook.importFiles([file()], { x: 0, y: 0 }); f.render(); await tick();
    const id = f.graph.nodes[0].id;
    f.failPromotion();
    f.calls[0].gate.resolve({ mediaId: "confirmed", url: "oss" }); await tick(); f.render();
    assert.equal(f.hook.get(id)?.state, "failed");
    assert.equal(f.hook.readRecovery()?.operations[f.hook.get(id)!.id]?.remote?.mediaId, "confirmed");
    f.hook.retry(id); await tick(); f.render();
    assert.equal(f.graph.nodes[0].mediaId, "confirmed");
    assert.equal(f.calls.length, 1);
    f.unmount();
});


test("undo references to an existing remote input retain its cached original too", () => {
    const f = fixture();
    f.graphChanged({ ...f.graph, nodes: [{ id: "existing", type: "image_input", mediaId: "existing-media", position: { x: 0, y: 0 } }] });
    f.retain(f.hook.snapshot({ name: "Workflow", graph: f.graph }));
    f.graphChanged({ ...f.graph, nodes: [] });
    assert.ok(retention.retainedImageCacheKeys("portal:u", f.sharedStorage).has("media:existing-media:v1:original"));
    f.unmount();
});
