import assert from "node:assert/strict";
import test from "node:test";

import { canOpenNodeGenerationDialog, canSaveNodeAsAsset } from "../components/canvas-node-actions.ts";
import { defaultMode } from "../components/canvas-node-prompt-panel.tsx";
import { CanvasNodeType, type CanvasNodeData } from "../types.ts";

function node(type: CanvasNodeType, content?: string): CanvasNodeData {
    return { id: type, type, title: type, position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content } };
}

test("saving a non-image node does not create an invisible private asset", () => {
    assert.equal(canSaveNodeAsAsset(node(CanvasNodeType.Text, "note")), false);
    assert.equal(canSaveNodeAsAsset(node(CanvasNodeType.Video, "blob:video")), false);
    assert.equal(canSaveNodeAsAsset(node(CanvasNodeType.Image)), false);
    assert.equal(canSaveNodeAsAsset(node(CanvasNodeType.Image, "blob:image")), true);
});

test("a locally uploading or failed image cannot be saved as a private asset", () => {
    const uploading = node(CanvasNodeType.Image, "blob:local");
    uploading.metadata!.storageKey = "image:pending";
    uploading.metadata!.localUploadState = "uploading";
    assert.equal(canSaveNodeAsAsset(uploading), false);

    const failed = node(CanvasNodeType.Image, "blob:local");
    failed.metadata!.storageKey = "image:failed";
    failed.metadata!.localUploadState = "failed";
    assert.equal(canSaveNodeAsAsset(failed), false);
});

test("text nodes cannot enter an unavailable text-model generation path", () => {
    assert.equal(defaultMode(CanvasNodeType.Text), "image");
    assert.equal(canOpenNodeGenerationDialog(node(CanvasNodeType.Text, "note")), false);
    assert.equal(canOpenNodeGenerationDialog(node(CanvasNodeType.Image, "blob:image")), true);
});
