import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./statistics-report-tabs.tsx", import.meta.url);

test("statistics reports use horizontal tabs and user-first consumption cards", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /<Tabs/);
    assert.match(source, /按用户消耗/);
    assert.match(source, /按模型消耗/);
    assert.match(source, /function UserUsageCard/);
    assert.match(source, /总费用/);
    assert.match(source, /成功图片/);
    assert.match(source, /function ModelUsageTable/);
});
