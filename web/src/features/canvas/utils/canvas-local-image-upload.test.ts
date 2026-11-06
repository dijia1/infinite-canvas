import assert from "node:assert/strict";
import test from "node:test";

import { excludeLocalUploadNodes } from "./canvas-local-image-upload.ts";
import { CanvasNodeType } from "../types.ts";

test("excludes an uploading local image and its connections from the server document", () => {
    const document = excludeLocalUploadNodes({
        nodes: [
            { id: "ready", type: CanvasNodeType.Image, title: "已完成", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { mediaId: "media-ready" } },
            { id: "pending", type: CanvasNodeType.Image, title: "本地文件", position: { x: 100, y: 0 }, width: 100, height: 100, metadata: { localUploadState: "uploading", storageKey: "image:pending" } },
            { id: "text", type: CanvasNodeType.Text, title: "说明", position: { x: 200, y: 0 }, width: 100, height: 100 },
        ],
        connections: [
            { id: "keep", fromNodeId: "ready", toNodeId: "text" },
            { id: "drop-source", fromNodeId: "pending", toNodeId: "text" },
            { id: "drop-target", fromNodeId: "ready", toNodeId: "pending" },
        ],
        viewport: { x: 0, y: 0, k: 1 },
        backgroundMode: "lines",
        showImageInfo: false,
    });

    assert.deepEqual(document.nodes.map((node) => node.id), ["ready", "text"]);
    assert.deepEqual(document.connections.map((connection) => connection.id), ["keep"]);
});

test("keeps completed images in the server document", () => {
    const document = excludeLocalUploadNodes({
        nodes: [{ id: "image", type: CanvasNodeType.Image, title: "已完成", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { mediaId: "media-1" } }],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
        backgroundMode: "lines",
        showImageInfo: false,
    });

    assert.equal(document.nodes.length, 1);
    assert.equal(document.nodes[0]?.metadata?.mediaId, "media-1");
});
