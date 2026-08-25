import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./page.tsx", import.meta.url);

test("operation records initialize their actor filter from a selected member", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /useSearchParams/);
    assert.match(source, /searchParams\.get\("actor"\)/);
    assert.match(source, /查看请求参数/);
    assert.match(source, /requestSummary/);
    assert.match(source, /已提交/);
    assert.doesNotMatch(source, /OperationMediaThumbnail/);
    assert.doesNotMatch(source, /getRemoteImageAccess/);
});
