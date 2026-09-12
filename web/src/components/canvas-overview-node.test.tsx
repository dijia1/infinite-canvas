import assert from "node:assert/strict";
import test from "node:test";

import { CanvasOverviewNode } from "./canvas-overview-node";

const base = {
    nodeId: "node-1",
    title: "图片",
    position: { x: 40, y: 80 },
    width: 320,
    height: 240,
    selected: false,
    media: true,
    fill: "#222",
    placeholderFill: "#333",
    stroke: "#444",
    selectionStroke: "#0af",
};

test("overview node keeps the full node geometry and rounded media shell", () => {
    const element = CanvasOverviewNode({ ...base, imageSource: "/thumbnail.jpg", imageStorageKey: "thumb-key" });
    assert.equal(element.props["data-node-id"], "node-1");
    assert.equal(element.props.style.width, 320);
    assert.equal(element.props.style.height, 240);

    const shell = element.props.children;
    assert.match(shell.props.className, /rounded-3xl/);
    assert.equal(shell.props.style.background, "transparent");
    assert.equal(shell.props.children.type, "img");
    assert.equal(shell.props.children.props.src, "/thumbnail.jpg");
});

test("overview node carries caller data attributes and renders a lightweight placeholder", () => {
    const element = CanvasOverviewNode({
        ...base,
        media: false,
        dataAttributes: { "data-workflow-object": "", "data-workflow-node-id": "workflow-node" },
    });
    assert.equal(element.props["data-workflow-object"], "");
    assert.equal(element.props["data-workflow-node-id"], "workflow-node");
    assert.equal(element.props.children.props.children.props.style.background, "#333");
});

