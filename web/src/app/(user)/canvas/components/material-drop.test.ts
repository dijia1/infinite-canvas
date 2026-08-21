import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("canvas accepts private and public material drag payloads", async () => {
    const source = await readFile(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");

    assert.match(source, /PRIVATE_IMAGE_DRAG_TYPE/);
    assert.match(source, /PUBLIC_IMAGE_DRAG_TYPE/);
    assert.match(source, /createImageAssetNode/);
    assert.match(source, /createPublicImageNode/);
    assert.match(source, /event\.dataTransfer\.getData\(PRIVATE_IMAGE_DRAG_TYPE\)/);
    assert.match(source, /event\.dataTransfer\.getData\(PUBLIC_IMAGE_DRAG_TYPE\)/);
});
