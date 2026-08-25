import assert from "node:assert/strict";
import test from "node:test";

import { collectImageStorageKeys } from "./image-storage.ts";

test("keeps durable media images and their thumbnails during cache cleanup", () => {
    const keys = collectImageStorageKeys({ storageKey: "media:media-123:v1:original" });

    assert.deepEqual(keys, new Set(["media:media-123:v1:original", "media:media-123:v1:thumbnail"]));
});
