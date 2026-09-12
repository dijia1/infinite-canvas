import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasFrame, canvasFrameHeaderPointerAction, canvasFrameTitleKeyAction, canvasFrameTitleReducer } from "./canvas-frame";

const frame = { id: "frame-a", name: "素材准备", position: { x: 80, y: -40 }, width: 600, height: 360, nodeIds: ["node-a"] };

test("CanvasFrame renders world coordinates, accessible controlled naming, and caller actions", () => {
    const html = renderToStaticMarkup(<CanvasFrame frame={frame} selected headerActions={<button type="button">运行</button>} onSelect={() => {}} onRename={() => {}} />);
    assert.match(html, /data-canvas-frame="frame-a"/);
    assert.match(html, /transform:translate\(80px, -40px\)/);
    assert.match(html, /width:600px;height:360px/);
    assert.match(html, /data-canvas-frame-title/);
    assert.match(html, /title="素材准备"/);
    assert.match(html, />素材准备</);
    assert.match(html, />运行</);
    assert.doesNotMatch(html, /<input/);
    assert.doesNotMatch(html, /will-change/);
});

test("title reducer owns the draft and exits editing when the Frame becomes read-only", () => {
    const initial = { editing: false, draft: "素材准备" };
    const editing = canvasFrameTitleReducer(initial, { type: "edit", name: "素材准备", readOnly: false });
    assert.deepEqual(editing, { editing: true, draft: "素材准备" });
    const changed = canvasFrameTitleReducer(editing, { type: "change", draft: "新名称" });
    assert.deepEqual(canvasFrameTitleReducer(changed, { type: "sync", name: "远端名称", readOnly: false }), changed);
    assert.deepEqual(canvasFrameTitleReducer(changed, { type: "sync", name: "远端名称", readOnly: true }), { editing: false, draft: "远端名称" });
});

test("editing key and header pointer decisions ignore IME, repeats, and drag while editing", () => {
    assert.equal(canvasFrameTitleKeyAction({ key: "Enter", repeat: false, isComposing: true }), null);
    assert.equal(canvasFrameTitleKeyAction({ key: "Enter", repeat: true, isComposing: false }), null);
    assert.equal(canvasFrameTitleKeyAction({ key: "Enter", repeat: false, isComposing: false }), "commit");
    assert.equal(canvasFrameTitleKeyAction({ key: "Escape", repeat: false, isComposing: false }), "cancel");
    assert.equal(canvasFrameHeaderPointerAction({ button: 0, editing: true, readOnly: false }), "ignore");
    assert.equal(canvasFrameHeaderPointerAction({ button: 0, editing: false, readOnly: false }), "select-move");
    assert.equal(canvasFrameHeaderPointerAction({ button: 0, editing: false, readOnly: true }), "select");
    assert.equal(canvasFrameHeaderPointerAction({ button: 1, editing: false, readOnly: false }), "ignore");
});

test("read-only CanvasFrame omits editing and resize affordances", () => {
    const html = renderToStaticMarkup(
        <CanvasFrame
            frame={frame}
            selected={false}
            readOnly
            onSelect={() => {
                throw new Error("render must not select");
            }}
            onRename={() => {
                throw new Error("render must not rename");
            }}
        />,
    );
    assert.doesNotMatch(html, /<input/);
    assert.doesNotMatch(html, /data-canvas-resize="/);
    assert.match(html, />素材准备</);
});

test("Frame controls render separately above the background even when unselected", () => {
    const html = renderToStaticMarkup(<CanvasFrame frame={frame} selected={false} onSelect={() => {}} headerActions={<button>运行</button>} />);
    assert.match(html, /data-canvas-frame-controls="frame-a"/);
    assert.match(html, /data-canvas-frame-body/);
    assert.match(html, /width:calc\(600px \* var\(--canvas-scale, 1\)\)/);
    assert.match(html, /scale\(var\(--canvas-inverse-scale, 1\)\)/);
    assert.doesNotMatch(html, /data-canvas-resize=/);
});

test("Frame outline renders in the inverse-scaled controls layer", () => {
    const html = renderToStaticMarkup(<CanvasFrame frame={frame} selected onSelect={() => {}} />);
    const bodyTag = html.match(/<div data-canvas-frame="frame-a"[^>]*>/)?.[0];
    assert.ok(bodyTag);
    assert.doesNotMatch(bodyTag, /border-color|box-shadow/);
    assert.match(html, /data-canvas-frame-outline="true"[^>]*style="border-color:#2f80ff;box-shadow:/);
});

test("Frame hover marks both highlighted edges for a resize corner", () => {
    const html = renderToStaticMarkup(<CanvasFrame frame={frame} selected hoveredDirection="top-left" onSelect={() => {}} />);
    assert.match(html, /data-canvas-frame-edge="top" data-active="true"/);
    assert.match(html, /data-canvas-frame-edge="left" data-active="true"/);
    assert.doesNotMatch(html, /data-canvas-frame-edge="right" data-active="true"/);
    assert.doesNotMatch(html, /data-canvas-frame-edge="bottom" data-active="true"/);
});

test("Frame edge highlights share one rounded clipping layer", () => {
    const html = renderToStaticMarkup(<CanvasFrame frame={frame} selected hoveredDirection="left" onSelect={() => {}} />);
    const clipStart = html.indexOf("data-canvas-frame-edge-clip");
    const edgeStart = html.indexOf('data-canvas-frame-edge="left"');
    const clipEnd = html.indexOf("</div>", clipStart);

    assert.notEqual(clipStart, -1);
    assert.ok(edgeStart > clipStart);
    assert.ok(edgeStart < clipEnd);
});
