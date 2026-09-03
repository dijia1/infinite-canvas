import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasMediaTargets } from "./use-canvas-image-resources.ts";
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
