import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasVideoUploadContent } from "./canvas-video-upload-content";
const render = (stage: "uploading" | "verifying" | "failed" | "ready") => renderToStaticMarkup(<CanvasVideoUploadContent nodeId="v" upload={{ url: "blob:local-video", stage, progress: 37, error: "请重试" }} onRetry={() => {}} onCancel={() => {}} />);
test("video card distinguishes upload progress, completion, failure and ready", () => {
    assert.match(render("uploading"), /正在上传/);
    assert.match(render("uploading"), /37%/);
    assert.match(render("uploading"), /aria-valuenow="37"/);
    assert.match(render("verifying"), /正在完成上传/);
    assert.match(render("verifying"), /aria-valuenow="100"/);
    assert.match(render("failed"), /重试/);
    assert.match(render("failed"), /取消上传/);
    assert.doesNotMatch(render("ready"), /role="status"|取消上传|正在上传/);
});
