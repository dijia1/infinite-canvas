import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./admin-statistics.ts", import.meta.url);

test("today statistics API preserves amount as a string", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /amount: string/);
    assert.match(source, /apiGet<TodayStatistics>\("\/api\/admin\/statistics\/today", undefined, token\)/);
});
