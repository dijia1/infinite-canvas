import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

import { sourceBehavior } from "@/test-utils/source-behavior";

const detailURL = new URL("./workflow-run-detail.tsx", import.meta.url);

test("the original-video resume action forwards the persisted task ID", () => {
    const resumed: string[] = [];
    const onClick = sourceBehavior(detailURL, {
        onResumeVideo: (taskID: string) => resumed.push(taskID),
        videoTaskID: "original-video-task",
    }).select((node) => ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "onClick" && node.getText().includes("onResumeVideo(videoTaskID)")) as () => void;

    onClick();
    assert.deepEqual(resumed, ["original-video-task"]);
});
