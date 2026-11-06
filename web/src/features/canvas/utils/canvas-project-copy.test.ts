import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType } from "../types";
import type { CanvasProject } from "../stores/use-canvas-store";
import { createCanvasProjectCopy, nextCanvasProjectCopyTitle } from "./canvas-project-copy";

const source: CanvasProject = {
    id: "source-project",
    title: "产品探索",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    nodes: [
        {
            id: "source-image",
            type: CanvasNodeType.Image,
            title: "参考图",
            position: { x: 20, y: 40 },
            width: 400,
            height: 300,
            metadata: { mediaId: "media-1", storageKey: "image:media-1", providerOptions: { seed: 42 } },
        },
    ],
    maskResources: {
        "mask-source-image": { version: 1, strokes: [{ id: "stroke-1", tool: "paint", radius: 4, points: [{ x: 1, y: 2 }] }] },
    },
    connections: [{ id: "connection-1", fromNodeId: "source-image", toNodeId: "source-image" }],
    backgroundMode: "dots",
    showImageInfo: true,
    viewport: { x: 50, y: 80, k: 0.8 },
};

test("creates a document-independent canvas copy while retaining graph and media identities", () => {
    const copy = createCanvasProjectCopy(source, {
        id: "copy-project",
        title: "产品探索 副本",
        now: "2026-09-03T00:00:00.000Z",
    });

    assert.deepEqual(copy, {
        ...source,
        id: "copy-project",
        title: "产品探索 副本",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
    });
    assert.notEqual(copy.nodes, source.nodes);
    assert.notEqual(copy.nodes[0]?.metadata, source.nodes[0]?.metadata);
    assert.notEqual(copy.maskResources["mask-source-image"], source.maskResources["mask-source-image"]);
    assert.notEqual(copy.connections, source.connections);
    assert.notEqual(copy.viewport, source.viewport);
    assert.equal(copy.nodes[0]?.id, "source-image");
    assert.equal(copy.nodes[0]?.metadata?.mediaId, "media-1");
});

test("allocates the next available copy title", () => {
    assert.equal(nextCanvasProjectCopyTitle("产品探索", ["产品探索", "产品探索 副本", "产品探索 副本 2"]), "产品探索 副本 3");
    assert.equal(nextCanvasProjectCopyTitle("产品探索", ["产品探索 副本 2"]), "产品探索 副本");
});
