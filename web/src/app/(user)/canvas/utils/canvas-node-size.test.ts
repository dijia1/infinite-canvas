import assert from "node:assert/strict";
import test from "node:test";

import { fitNodeSize } from "./canvas-node-size.ts";

test("uses a visible default size when legacy media dimensions are missing", () => {
    assert.deepEqual(fitNodeSize(0, 0), { width: 640, height: 640 });
});
