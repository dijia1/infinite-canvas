import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasVideoContent } from "./canvas-video-content";
test("visible video exposes native controls without preloading or a central play button", () => {
    const html = renderToStaticMarkup(<CanvasVideoContent nodeId="v" mediaId="m" />);
    assert.match(html, /<video/);
    assert.match(html, /controls=""/);
    assert.match(html, /preload="none"/);
    assert.match(html, /data-video-drag-surface/);
    assert.doesNotMatch(html, /<button|播放视频/);
});
test("offscreen unused video does not initialize a player", () => {
    const html = renderToStaticMarkup(<CanvasVideoContent nodeId="v" mediaId="m" visible={false} />);
    assert.doesNotMatch(html, /<video/);
});
