import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./admin-statistics.ts", import.meta.url);

test("range statistics API preserves amounts as strings", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /amount: string/);
    assert.match(source, /startDate: string/);
    assert.match(source, /endDate: string/);
    assert.match(source, /users: StatisticsUser\[\]/);
    assert.match(source, /apiGet<Statistics>\("\/api\/admin\/statistics", range, token\)/);
});
