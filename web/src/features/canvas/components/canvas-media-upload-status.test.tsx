import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasMediaUploadStatus } from "./canvas-media-upload-status";

test("media upload progress remains visible while confirming and exposes failure actions", () => {
    const uploading = renderToStaticMarkup(<CanvasMediaUploadStatus stage="uploading" progress={42} />);
    assert.match(uploading, /正在上传/);
    assert.match(uploading, /aria-valuenow="42"/);
    assert.match(uploading, /width:42%/);
    const finishing = renderToStaticMarkup(<CanvasMediaUploadStatus stage="verifying" progress={42} />);
    assert.match(finishing, /正在完成上传/);
    assert.match(finishing, /aria-valuenow="100"/);
    const failed = renderToStaticMarkup(<CanvasMediaUploadStatus stage="failed" error="确认请求中断" onRetry={() => {}} onCancel={() => {}} />);
    assert.match(failed, /确认请求中断/);
    assert.match(failed, /重试/);
    assert.match(failed, /取消上传/);
    assert.doesNotMatch(failed, /role="progressbar"/);
});
