import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasNodeData } from "../types.ts";
import { isHiddenBatchChild, isHiddenBatchConnectionEndpoint, normalizeConnection } from "./canvas-graph-utils.ts";

function node(id: string, type: CanvasNodeType, metadata?: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}

test("rejects missing, self, and config-to-config connections", () => {
    const image = node("image", CanvasNodeType.Image);
    const config = node("config", CanvasNodeType.Config);
    const secondConfig = node("second-config", CanvasNodeType.Config);
    const nodes = [image, config, secondConfig];

    assert.equal(normalizeConnection("missing", image.id, nodes, "source"), null);
    assert.equal(normalizeConnection(image.id, "missing", nodes, "source"), null);
    assert.equal(normalizeConnection(image.id, image.id, nodes, "source"), null);
    assert.equal(normalizeConnection(config.id, secondConfig.id, nodes, "source"), null);
});

test("ends connections into config nodes at the config node", () => {
    const image = node("image", CanvasNodeType.Image);
    const config = node("config", CanvasNodeType.Config);

    assert.deepEqual(normalizeConnection(image.id, config.id, [image, config], "target"), { fromNodeId: image.id, toNodeId: config.id });
});

test("normalizes connections started from config handles by handle direction", () => {
    const image = node("image", CanvasNodeType.Image);
    const config = node("config", CanvasNodeType.Config);
    const nodes = [image, config];

    assert.deepEqual(normalizeConnection(config.id, image.id, nodes, "target"), { fromNodeId: image.id, toNodeId: config.id });
    assert.deepEqual(normalizeConnection(config.id, image.id, nodes, "source"), { fromNodeId: config.id, toNodeId: image.id });
});

test("hides a collapsed batch child and its connection endpoint", () => {
    const root = node("root", CanvasNodeType.Image, { imageBatchExpanded: false });
    const child = node("child", CanvasNodeType.Image, { batchRootId: root.id });
    const nodes = [root, child];

    assert.equal(isHiddenBatchChild(child, nodes), true);
    assert.equal(isHiddenBatchConnectionEndpoint(child, nodes), true);
});

test("keeps collapsing batch children visible without changing endpoint visibility", () => {
    const root = node("root", CanvasNodeType.Image, { imageBatchExpanded: false });
    const child = node("child", CanvasNodeType.Image, { batchRootId: root.id });
    const nodes = [root, child];

    assert.equal(isHiddenBatchChild(child, nodes, new Set([root.id])), false);
    assert.equal(isHiddenBatchConnectionEndpoint(child, nodes), true);
});

test("does not hide children without an existing batch root", () => {
    const standalone = node("standalone", CanvasNodeType.Image);
    const missingRootChild = node("missing-root", CanvasNodeType.Image, { batchRootId: "unknown" });
    const nodes = [standalone, missingRootChild];

    assert.equal(isHiddenBatchChild(standalone, nodes), false);
    assert.equal(isHiddenBatchConnectionEndpoint(standalone, nodes), false);
    assert.equal(isHiddenBatchChild(missingRootChild, nodes), false);
    assert.equal(isHiddenBatchConnectionEndpoint(missingRootChild, nodes), false);
});
