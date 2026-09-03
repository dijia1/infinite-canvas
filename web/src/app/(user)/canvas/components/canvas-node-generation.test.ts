import assert from "node:assert/strict";
import test from "node:test";

import { hydrateNodeGenerationContext } from "./canvas-node-generation.ts";

test("keeps all stable media references out of the browser original-image hydration path", async () => {
    let originalLoads = 0;
    const context = {
        prompt: "edit",
        textCount: 0,
        imageCount: 2,
        referenceImages: [
            { id: "a", name: "a.png", type: "image/png", dataUrl: "", mediaId: "media-a", storageKey: "media:media-a:v1:original" },
            { id: "b", name: "b.png", type: "image/png", dataUrl: "", mediaId: "media-b", storageKey: "media:media-b:v1:original" },
        ],
    };

    const hydrated = await hydrateNodeGenerationContext(context, async () => {
        originalLoads += 1;
        throw new Error("should not load a browser original");
    });

    assert.equal(originalLoads, 0);
    assert.equal(hydrated, context);
});
