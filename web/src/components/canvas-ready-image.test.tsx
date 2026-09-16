import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasReadyImage } from "./canvas-ready-image";

test("an image URL keeps the loading placeholder until the browser can display it", () => {
    const html = renderToStaticMarkup(<CanvasReadyImage src="/result.png" alt="result" />);
    assert.match(html, /图片加载中/);
    assert.match(html, /visibility:hidden/);
    assert.match(html, /src="\/result.png"/);
});

test("a resource failure offers media reload instead of a generation action", () => {
    const html = renderToStaticMarkup(<CanvasReadyImage alt="result" error="offline" onRetry={() => { throw new Error("render must not retry"); }} />);
    assert.match(html, /图片加载失败/);
    assert.match(html, /重新加载/);
    assert.doesNotMatch(html, /生成中|重新生成/);
});
