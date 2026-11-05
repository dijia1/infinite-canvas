import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasVideoUploadContent } from "./canvas-video-upload-content";
const render = (stage: "uploading" | "verifying" | "failed" | "ready") => renderToStaticMarkup(<CanvasVideoUploadContent nodeId="v" upload={{ url: "blob:local-video", stage, progress: 37, error: "请重试" }} onRetry={() => {}} onCancel={() => {}} />);
test("video card distinguishes upload progress, verification, failure and ready", () => {
    assert.match(render("uploading"), /视频上传中 37%/);
    assert.match(render("uploading"), /value="37"/);
    assert.match(render("verifying"), /视频校验中/);
    assert.doesNotMatch(render("verifying"), /视频上传中|<progress/);
    assert.match(render("failed"), /重试上传/);
    assert.match(render("failed"), /取消上传/);
    assert.doesNotMatch(render("ready"), /role="status"|取消上传|视频上传中/);
});
