import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasNodeData } from "../types.ts";
import { canvasImageDownloadTargets, selectedDownloadableImageNodes } from "./canvas-download-utils.ts";

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

test("download targets keep image identities and local previews independent of later node edits", () => {
    const image = { ...node("input", CanvasNodeType.Image), metadata: { mediaId: "remote", storageKey: "image:replacement", content: "blob:replacement", mimeType: "image/png" } };
    const selection = [image, node("note", CanvasNodeType.Text, "text")];
    const targets = canvasImageDownloadTargets(selection);
    assert.equal(targets.length, 1);
    assert.deepEqual(targets[0], { filename: "canvas-image-input", mediaId: "remote", storageKey: "image:replacement", url: "blob:replacement", mimeType: "image/png", publicImageId: undefined });
    image.metadata.mediaId = "later"; image.metadata.content = "blob:later";
    assert.equal(targets[0]!.mediaId, "remote"); assert.equal(targets[0]!.url, "blob:replacement");
    const publicNode = { ...node("public", CanvasNodeType.Image), metadata: { publicImageId: "public-1" } };
    assert.equal(selectedDownloadableImageNodes([publicNode], new Set(["public"])).length, 1);
});
