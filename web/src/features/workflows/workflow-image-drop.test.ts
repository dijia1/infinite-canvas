import assert from "node:assert/strict";
import test from "node:test";
import { prepareWorkflowDroppedImages, appendWorkflowDroppedImages } from "./workflow-image-drop";
import { layoutDroppedImageGrid } from "@/app/(user)/canvas/utils/canvas-file-drop";
import type { WorkflowGraph } from "./types";

const image = (name: string, type = "image/png") => new File([name], name, { type });
const dimensions = async () => ({ width: 800, height: 400 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("drop uses fixed centers, file order, capped batches and at most three interleaved uploads", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<{ mediaId: string }>>>();
    let active = 0, peak = 0;
    const started = deferred<void>();
    const progress: number[] = [];
    const files = [image("ignored.txt", "text/plain"), ...Array.from({ length: 22 }, (_, i) => image(String(i)))];
    const result = prepareWorkflowDroppedImages(files, { x: 900, y: -400 }, {
        readDimensions: dimensions, signal: new AbortController().signal,
        onProgress: p => progress.push(p.completed),
        upload: async (file) => {
            active++; peak = Math.max(peak, active);
            if (Number(file.name) < 3) {
                const gate = deferred<{ mediaId: string }>(); pending.set(file.name, gate);
                if (pending.size === 3) started.resolve();
                const result = await gate.promise; active--; return result;
            }
            active--;
            if (file.name === "4") throw new Error("invalid image");
            return { mediaId: `media-${file.name}` };
        },
    });
    await started.promise;
    assert.equal(active, 3);
    pending.get("2")!.resolve({ mediaId: "media-2" });
    pending.get("0")!.resolve({ mediaId: "media-0" });
    pending.get("1")!.resolve({ mediaId: "media-1" });
    const prepared = await result;
    assert.equal(peak, 3);
    assert.equal(prepared.failedCount, 1);
    assert.equal(prepared.omittedCount, 2);
    assert.equal(prepared.nodes.length, 19);
    assert.equal(progress.at(-1), 20);
    assert.deepEqual(prepared.nodes.map(n => n.mediaId), Array.from({ length: 20 }, (_, i) => i).filter(i => i !== 4).map(i => `media-${i}`));
    const centers = layoutDroppedImageGrid(20, { x: 900, y: -400 });
    for (const node of prepared.nodes) {
        const index = Number(node.mediaId!.slice(6));
        assert.deepEqual({ x: node.position.x + node.width! / 2, y: node.position.y + node.height! / 2 }, centers[index]);
    }
});

test("single-image import merges into the latest graph and assigns its Frame atomically", async () => {
    const result = await prepareWorkflowDroppedImages([image("one")], { x: 500, y: 500 }, {
        readDimensions: dimensions, upload: async () => ({ mediaId: "uploaded" }), signal: new AbortController().signal,
    });
    const graph: WorkflowGraph = { version: 1, nodes: [{ id: "other", type: "text_input", text: "edited during upload", position: { x: -200, y: 10 } }], connections: [],
        frames: [{ id: "frame", name: "Frame", position: { x: 0, y: 0 }, width: 1000, height: 1000, nodeIds: [] }] };
    const next = appendWorkflowDroppedImages(graph, result.nodes);
    assert.equal(next.nodes[0]!.text, "edited during upload");
    assert.deepEqual(next.frames![0]!.nodeIds, [result.nodes[0]!.id]);
    assert.deepEqual(graph.frames![0]!.nodeIds, []);
    const edge = { ...result.nodes[0]!, id: "edge", position: { x: 999, y: 999 } };
    assert.equal(appendWorkflowDroppedImages(graph, [edge]).frames![0]!.nodeIds.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
});

test("aborted import stops queued work and cannot publish partial uploaded nodes", async () => {
    const abort = new AbortController();
    let uploads = 0;
    await assert.rejects(prepareWorkflowDroppedImages([image("1"), image("2"), image("3"), image("4")], { x: 0, y: 0 }, {
        readDimensions: dimensions, signal: abort.signal,
        upload: async () => { uploads++; abort.abort(); return { mediaId: "late" }; },
    }), { name: "AbortError" });
    assert.ok(uploads <= 3);
});
