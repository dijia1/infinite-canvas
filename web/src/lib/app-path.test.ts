import assert from "node:assert/strict";
import test from "node:test";

import { appApiPath, appPath } from "./app-path.ts";

test("prefixes application navigation paths with the configured base path", () => {
    assert.equal(appPath("/canvas", "/apps/infinite-canvas"), "/apps/infinite-canvas/canvas");
    assert.equal(appPath("assets", "/apps/infinite-canvas"), "/apps/infinite-canvas/assets");
});

test("keeps root navigation paths usable without a configured base path", () => {
    assert.equal(appPath("/canvas", ""), "/canvas");
});

test("prefixes local API URLs but preserves external image URLs", () => {
    assert.equal(appApiPath("/api/v1/media/media-1/content", "/apps/infinite-canvas"), "/apps/infinite-canvas/api/v1/media/media-1/content");
    assert.equal(appApiPath("https://images.example.com/result.png", "/apps/infinite-canvas"), "https://images.example.com/result.png");
});
