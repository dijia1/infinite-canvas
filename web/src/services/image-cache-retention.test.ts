import assert from "node:assert/strict";
import test from "node:test";
import { retainedImageCacheKeys, retainImageCache } from "./image-cache-retention";
test("persistent cache references are isolated by user and owner across fresh readers", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) || null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); }, key: (i: number) => [...map.keys()][i], get length() { return map.size; } } as Storage;
    retainImageCache(storage, "portal:a", "workflow:one", ["image:local", "media:undo"]);
    retainImageCache(storage, "portal:a", "workflow:two", ["media:active"]);
    retainImageCache(storage, "portal:b", "workflow:one", ["private"]);
    assert.deepEqual(retainedImageCacheKeys("portal:a", storage), new Set(["image:local", "media:undo", "media:active"]));
    retainImageCache(storage, "portal:a", "workflow:one", []);
    assert.deepEqual(retainedImageCacheKeys("portal:a", storage), new Set(["media:active"]));
    assert.deepEqual(retainedImageCacheKeys("portal:b", storage), new Set(["private"]));
});
