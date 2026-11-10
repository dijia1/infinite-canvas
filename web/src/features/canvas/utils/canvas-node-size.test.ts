import assert from "node:assert/strict";
import test from "node:test";

import { fitNodeSize, videoNodeSize, fitVideoNode } from "./canvas-node-size.ts";

test("uses a visible default size when legacy media dimensions are missing", () => {
    assert.deepEqual(fitNodeSize(0, 0), { width: 640, height: 640 });
});

test("portrait and landscape videos reserve room for native playback controls", () => {
    assert.deepEqual(videoNodeSize({ width: 720, height: 1280 }), { width: 360, height: 640 });
    assert.deepEqual(videoNodeSize({ width: 1280, height: 720 }), { width: 420, height: 236.25 });
    assert.deepEqual(videoNodeSize({ width: 180, height: 320 }), { width: 360, height: 640 });
});

test("legacy default, ratio placeholder and old automatic video sizes are fitted once", () => {
    const dimensions = { width: 720, height: 1280 };
    for (const size of [{ width: 420, height: 236 }, { width: 132.75, height: 236 }, { width: 236.25, height: 420 }]) {
        const node = { ...size, position: { x: 100, y: 200 } };
        const next = fitVideoNode(node, dimensions);
        assert.equal(next.width, 360);
        assert.equal(next.height, 640);
        assert.equal(next.position.x + next.width / 2, node.position.x + node.width / 2);
        assert.equal(next.position.y + next.height / 2, node.position.y + node.height / 2);
        assert.equal(fitVideoNode(next, dimensions), next);
    }
});

test("metadata cannot overwrite a custom resize made while a video is loading", () => {
    const custom = { width: 280, height: 500, position: { x: 10, y: 30 } };
    assert.equal(fitVideoNode(custom, { width: 720, height: 1280 }), custom);
    const requestPlaceholder = { width: 420, height: 420, position: { x: 10, y: 30 } };
    assert.equal(fitVideoNode(requestPlaceholder, { width: 720, height: 1280 }, false, "1:1").width, 360);
});
