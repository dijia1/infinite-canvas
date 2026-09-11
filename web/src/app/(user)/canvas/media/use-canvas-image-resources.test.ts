import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasImageResourceRequests, buildCanvasMediaTargets } from "./use-canvas-image-resources.ts";
import { CanvasNodeType, type CanvasNodeData } from "../types.ts";

function imageNode(id: string): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 576,
        height: 576,
        metadata: { mediaId: id },
    };
}

test("keeps prefetches thumbnail-only while screen and pinned images retain their stronger demand", () => {
    const prefetchOnly = imageNode("prefetch");
    const onScreen = imageNode("screen");
    const pinned = imageNode("pinned");

    assert.deepEqual(
        buildCanvasMediaTargets({
            onScreenNodes: [onScreen],
            prefetchNodes: [prefetchOnly, onScreen],
            pinnedNodes: [pinned],
        }).map(({ node, visible, pinned, prefetch }) => ({ id: node.id, visible, pinned, prefetch })),
        [
            { id: "prefetch", visible: false, pinned: false, prefetch: true },
            { id: "screen", visible: true, pinned: false, prefetch: false },
            { id: "pinned", visible: false, pinned: true, prefetch: false },
        ],
    );
});

test("preview keeps offscreen images targeted without forcing original quality and releases them on close", () => {
    const node = imageNode("preview");
    const targets = buildCanvasMediaTargets({ onScreenNodes: [], prefetchNodes: [], pinnedNodes: [], previewNodes: [node] });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].preview, true);
    assert.equal(targets[0].pinned, false);
    const shared = buildCanvasMediaTargets({ onScreenNodes: [node], prefetchNodes: [], pinnedNodes: [], previewNodes: [node] });
    assert.equal(shared.length, 1);
    assert.equal(shared[0].visible, true);
    assert.deepEqual(buildCanvasMediaTargets({ onScreenNodes: [], prefetchNodes: [], pinnedNodes: [] }), []);
});

test("pinned preview requests the original at low zoom", () => {
    const node = imageNode("pinned-preview");
    const targets = buildCanvasMediaTargets({ onScreenNodes: [], prefetchNodes: [], pinnedNodes: [node], previewNodes: [node] });
    const requests = buildCanvasImageResourceRequests({
        targets,
        scale: 0.1,
        controller: { get: () => undefined },
        resolveAccess: async () => ({ url: "https://example.test/original", previewUrl: "https://example.test/thumbnail" }),
    });

    assert.equal(requests[0]?.variant, "original");
    assert.equal(requests[0]?.priority, "interactive");
});

test("visible preview follows zoom demand", () => {
    const node = imageNode("visible-preview");
    const targets = buildCanvasMediaTargets({ onScreenNodes: [node], prefetchNodes: [], pinnedNodes: [], previewNodes: [node] });
    const requests = buildCanvasImageResourceRequests({
        targets,
        scale: 1,
        controller: { get: () => undefined },
        resolveAccess: async () => ({ url: "https://example.test/original", previewUrl: "https://example.test/thumbnail" }),
    });

    assert.equal(requests[0]?.variant, "original");
    assert.equal(requests[0]?.priority, "interactive");
});
