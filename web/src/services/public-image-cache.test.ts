import assert from "node:assert/strict";
import test from "node:test";

import { loadPublicImage } from "./public-image-cache.ts";

test("uses the user-scoped local image cache before requesting a public image URL", async () => {
    let accessRequests = 0;
    const result = await loadPublicImage(
        { id: "public-1", mediaId: "media-1" },
        {
            readCachedImage: async () => "blob:cached",
            requestAccess: async () => {
                accessRequests += 1;
                return "https://oss.example/image.png";
            },
            cacheImage: async () => "blob:remote",
        },
    );

    assert.deepEqual(result, { url: "blob:cached", storageKey: "media:media-1", source: "cache" });
    assert.equal(accessRequests, 0);
});

test("requests, downloads, and caches a public image when the local cache is absent", async () => {
    let accessID = "";
    let cachedURL = "";
    const result = await loadPublicImage(
        { id: "public-2", mediaId: "media-2" },
        {
            readCachedImage: async () => "",
            requestAccess: async (id) => {
                accessID = id;
                return "https://oss.example/image.png";
            },
            cacheImage: async (url) => {
                cachedURL = url;
                return "blob:cached-after-download";
            },
        },
    );

    assert.deepEqual(result, { url: "blob:cached-after-download", storageKey: "media:media-2", source: "remote" });
    assert.equal(accessID, "public-2");
    assert.equal(cachedURL, "https://oss.example/image.png");
});
