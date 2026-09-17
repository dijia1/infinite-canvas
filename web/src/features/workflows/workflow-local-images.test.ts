import assert from "node:assert/strict";
import test from "node:test";
import { currentImageBindings, localImageHistory, materializeLocalImages, pendingRunImages, replaceLocalImageSize, readLocalImageRecovery } from "./workflow-local-images";
import type { LocalImageOperations } from "./workflow-local-images";
import type { WorkflowGraph } from "./types";
const graph: WorkflowGraph = { version: 1, nodes: [{ id: "image", type: "image_input", position: { x: 100, y: 100 }, width: 100, height: 100, mediaId: "old" }, { id: "generate", type: "image_generation", position: { x: 800, y: 100 } }], connections: [{ sourceNodeId: "image", sourceSlotId: "output", targetNodeId: "generate", targetPortId: "reference", order: 0 }], frames: [{ id: "A", name: "A", position: { x: 700, y: 0 }, width: 1000, height: 800, nodeIds: ["generate"] }, { id: "B", name: "B", position: { x: 2000, y: 0 }, width: 1000, height: 800, nodeIds: [] }] };
const operations: LocalImageOperations = { op: { id: "op", nodeId: "image", fileName: "image.png", lastModified: 0, image: { storageKey: "image:local", width: 100, height: 100, bytes: 100, mimeType: "image/png" }, original: { mediaId: "old", width: 100, height: 100 }, state: "uploading", progress: 0 } };

test("upload completion does not add history; redo resolves the operation's latest confirmed result", () => {
    const before = localImageHistory({ name: "workflow", graph }, { image: "op" }, operations);
    const done: LocalImageOperations = { op: { ...operations.op, state: "completed", remote: { mediaId: "new" }, progress: 100 } };
    const after = materializeLocalImages(before, done);
    assert.equal(after.graph.nodes[0].mediaId, "new");
    assert.deepEqual(localImageHistory(after, { image: "op" }, done), before);
    const moved = { ...after, graph: { ...after.graph, nodes: after.graph.nodes.map(node => ({ ...node, position: { x: node.position.x + 30, y: node.position.y } })) } };
    assert.notDeepEqual(localImageHistory(moved, { image: "op" }, done), before);
    assert.equal(JSON.stringify(after).includes("imageImports"), false);
    assert.equal(materializeLocalImages({ name: "workflow", graph }, done).graph.nodes[0].mediaId, "old");
});
test("external Frame inputs block only their consuming run scope", () => {
    assert.equal(pendingRunImages(graph, { type: "frame", frameId: "A" }, { image: "op" }, operations).length, 1);
    assert.equal(pendingRunImages(graph, { type: "frame", frameId: "B" }, { image: "op" }, operations).length, 0);
    assert.equal(pendingRunImages(graph, { type: "workflow" }, { image: "op" }, operations).length, 1);
});
test("deleted or superseded media cannot receive old import callbacks", () => {
    assert.deepEqual(currentImageBindings({ ...graph, nodes: [] }, { image: "op" }, operations), {});
    assert.deepEqual(currentImageBindings({ ...graph, nodes: graph.nodes.map(node => ({ ...node, mediaId: "asset" })) }, { image: "op" }, operations), {});
});
test("replacement dimensions keep Frame membership and fall back if expansion would overlap", () => {
    const framed = { ...graph, frames: [{ id: "A", name: "A", position: { x: 0, y: 0 }, width: 300, height: 300, nodeIds: ["image"] }, { id: "B", name: "B", position: { x: 300, y: 0 }, width: 1000, height: 1000, nodeIds: [] }] };
    assert.equal(replaceLocalImageSize(framed, "image", { width: 4000, height: 1000 }), framed);
    assert.equal(framed.nodes[0].mediaId, "old");
});
test("recovery records never need a Blob URL and reject malformed persisted data", () => {
    const record = { version: 1, revision: 7, document: localImageHistory({ name: "workflow", graph }, { image: "op" }, operations), operations };
    assert.deepEqual(readLocalImageRecovery({ getItem: () => JSON.stringify(record) }, "u", "w"), record);
    assert.throws(() => readLocalImageRecovery({ getItem: () => "{}" }, "u", "w"));
});
