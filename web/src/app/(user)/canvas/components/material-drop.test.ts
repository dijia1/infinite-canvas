import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("canvas accepts private and public material drag payloads", async () => {
    const source = await readFile(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");

    assert.match(source, /PRIVATE_IMAGE_DRAG_TYPE/);
    assert.match(source, /PUBLIC_IMAGE_DRAG_TYPE/);
    assert.match(source, /createImageAssetNode/);
    assert.match(source, /createPublicImageNode/);
    assert.match(source, /loadMediaImage\(payload\.mediaId, async \(\) => \(await fetchPublicImageAccess\(payload\.id\)\)\.url\)/);
    assert.match(source, /const publicImageId = typeof asset\.metadata\?\.publicImageId === "string"/);
    assert.match(source, /publicImageId \? \(await fetchPublicImageAccess\(publicImageId\)\)\.url : resolveRemoteImage\(mediaId\)/);
    assert.match(source, /metadata: \{ \.\.\.imageMetadata\(image\), assetId: asset\.id, publicImageId: publicImageId \|\| undefined \}/);
    assert.match(source, /event\.dataTransfer\.getData\(PRIVATE_IMAGE_DRAG_TYPE\)/);
    assert.match(source, /event\.dataTransfer\.getData\(PUBLIC_IMAGE_DRAG_TYPE\)/);
});
