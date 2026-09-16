import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const maskFile = (name: string) => new URL(`./${name}`, import.meta.url);

test("image hover tools keep mask editing and reserve deletion for local uploads", async () => {
    const toolbar = await readFile(new URL("../components/canvas-node-hover-toolbar.tsx", import.meta.url), "utf8");

    assert.match(toolbar, /Brush/);
    assert.match(toolbar, /label="遮罩"/);
    assert.doesNotMatch(toolbar, /CanvasNodeInfoModal/);
    assert.doesNotMatch(toolbar, /LockOpen|<Lock\b|<Info\b/);
    assert.match(toolbar, /const canDeleteLocalUpload = Boolean\(node\.metadata\?\.localUploadState\)/);
    assert.match(toolbar, /\{canDeleteLocalUpload \? <ToolbarAction title="删除本地图片" label="删除" icon=\{<Trash2/);
});

test("the mask editor keeps paint and erase tools and shares display preferences with the overlay", async () => {
    const [dialog, overlay, node] = await Promise.all([
        readFile(maskFile("canvas-image-mask-dialog.tsx"), "utf8"),
        readFile(maskFile("canvas-image-mask-overlay.tsx"), "utf8"),
        readFile(new URL("../components/canvas-node.tsx", import.meta.url), "utf8"),
    ]);

    assert.match(dialog, /tool === "paint"/);
    assert.match(dialog, /tool === "erase"/);
    assert.match(dialog, /useMaskPreferencesStore/);
    assert.match(overlay, /useMaskPreferencesStore/);
    assert.match(dialog, /disabledAlpha/);
    assert.match(overlay, /pointer-events-none/);
    assert.match(node, /CanvasImageMaskOverlay/);
});
