import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasNodeData } from "../types.ts";
import { selectedDownloadableImageNodes } from "./canvas-download-utils.ts";

function node(id: string, type: CanvasNodeType, content?: string): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: content ? { content } : undefined };
}

test("selects only image nodes with downloadable content from a multi-selection", () => {
    const first = node("first", CanvasNodeType.Image, "blob:first");
    const second = node("second", CanvasNodeType.Image, "blob:second");
    const text = node("text", CanvasNodeType.Text, "note");
    const pending = node("pending", CanvasNodeType.Image);

    assert.deepEqual(selectedDownloadableImageNodes([first, second, text, pending], new Set([first.id, second.id, text.id, pending.id])).map((item) => item.id), ["first", "second"]);
});
