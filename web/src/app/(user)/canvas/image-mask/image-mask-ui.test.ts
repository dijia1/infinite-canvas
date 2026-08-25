import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const maskFile = (name: string) => new URL(`./${name}`, import.meta.url);

test("image hover tools replace node info, delete, and aspect-ratio lock with mask editing", async () => {
    const toolbar = await readFile(new URL("../components/canvas-node-hover-toolbar.tsx", import.meta.url), "utf8");

    assert.match(toolbar, /Brush/);
    assert.match(toolbar, /label="遮罩"/);
    assert.doesNotMatch(toolbar, /CanvasNodeInfoModal/);
    assert.doesNotMatch(toolbar, /LockOpen|<Lock\b|Trash2|<Info\b/);
});

test("the mask editor only provides circular paint and erase strokes with a red canvas overlay", async () => {
    const [dialog, overlay, node] = await Promise.all([
        readFile(maskFile("canvas-image-mask-dialog.tsx"), "utf8"),
        readFile(maskFile("canvas-image-mask-overlay.tsx"), "utf8"),
        readFile(new URL("../components/canvas-node.tsx", import.meta.url), "utf8"),
    ]);

    assert.match(dialog, /DEFAULT_BRUSH_SIZE = 24/);
    assert.match(dialog, /min=\{8\}[\s\S]*max=\{80\}/);
    assert.match(dialog, /tool === "paint"/);
    assert.match(dialog, /tool === "erase"/);
    assert.match(dialog, /rgba\(239, 68, 68, 0\.3\)/);
    assert.match(overlay, /pointer-events-none/);
    assert.match(node, /CanvasImageMaskOverlay/);
});

