import assert from "node:assert/strict";
import test from "node:test";

import { describeCanvasShareRecipient, stopCanvasShareEvent } from "./canvas-share-dialog.tsx";

test("formats a share recipient using only name and department", () => {
    assert.equal(describeCanvasShareRecipient({ userUid: "user-1", displayName: "李小明", departments: ["设计", "增长"] }), "李小明－设计、增长");
    assert.equal(describeCanvasShareRecipient({ userUid: "user-2", displayName: "王敏", departments: [] }), "王敏－未设置部门");
});

test("stops clicks inside the share dialog from bubbling to the canvas card", () => {
    let stopped = false;

    stopCanvasShareEvent({ stopPropagation: () => { stopped = true; } });

    assert.equal(stopped, true);
});
