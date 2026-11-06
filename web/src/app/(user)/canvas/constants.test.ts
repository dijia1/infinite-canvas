import assert from "node:assert/strict";
import test from "node:test";
import { getNodeSpec } from "./constants";
import { CanvasNodeType } from "./types";

test("new configuration nodes start at the shared 360 by 274 minimum without changing image defaults", () => {
    assert.deepEqual({ width: getNodeSpec(CanvasNodeType.Config).width, height: getNodeSpec(CanvasNodeType.Config).height }, { width: 360, height: 274 });
    assert.deepEqual({ width: getNodeSpec(CanvasNodeType.Image).width, height: getNodeSpec(CanvasNodeType.Image).height }, { width: 340, height: 240 });
});
