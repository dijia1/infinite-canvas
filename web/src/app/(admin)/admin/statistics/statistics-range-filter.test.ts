import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./statistics-range-filter.tsx", import.meta.url);

test("statistics range filter uses one date-range trigger with a two-step picker", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /<Popover/);
    assert.match(source, /<DatePicker\.RangePicker/);
    assert.match(source, /formatRangeLabel/);
    assert.match(source, /CalendarDays/);
});
