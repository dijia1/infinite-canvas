import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("saving a generated image to private assets preserves its media identity", async () => {
    const source = await readFile(new URL("./canvas-client-page.tsx", import.meta.url), "utf8");
    const saveAssetStart = source.indexOf("const saveNodeAsset");
    const saveAssetEnd = source.indexOf("const cropImageNode", saveAssetStart);
    const saveAsset = source.slice(saveAssetStart, saveAssetEnd);

    assert.match(saveAsset, /metadata: \{[\s\S]*mediaId: node\.metadata\?\.mediaId/);
});

test("saving a public canvas image to private assets preserves its public access identity", async () => {
    const source = await readFile(new URL("./canvas-client-page.tsx", import.meta.url), "utf8");
    const saveAssetStart = source.indexOf("const saveNodeAsset");
    const saveAssetEnd = source.indexOf("const cropImageNode", saveAssetStart);
    const saveAsset = source.slice(saveAssetStart, saveAssetEnd);

    assert.match(saveAsset, /metadata: \{[\s\S]*publicImageId: node\.metadata\?\.publicImageId/);
});
