import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hookURL = new URL("./use-visible-media-preview.ts", import.meta.url);

test("visible media previews use a bounded viewport prefetch queue and release object URLs", async () => {
    const source = await readFile(hookURL, "utf8");

    assert.match(source, /MAX_CONCURRENT_PREVIEW_LOADS = 4/);
    assert.ok(source.includes("new IntersectionObserver"));
    assert.ok(source.includes("rootMargin: PREFETCH_MARGIN"));
    assert.match(source, /const PREFETCH_MARGIN = "400px"/);
    assert.match(source, /releaseImageObjectURL\(storageKeyRef\.current\)/);
    assert.ok(source.includes("if (!isNearViewport)"));
    assert.ok(source.includes('setURL("")'));
});
