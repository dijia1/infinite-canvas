import assert from "node:assert/strict";
import test from "node:test";

import { collectImageStorageKeys } from "./image-storage.ts";

test("keeps durable media images and their previews during cache cleanup", () => {
    const keys = collectImageStorageKeys({ storageKey: "media:media-123" });

    assert.deepEqual(keys, new Set(["media:media-123", "preview:media-123"]));
});
