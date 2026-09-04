import assert from "node:assert/strict";
import test from "node:test";

import { statisticsPresetRange } from "./statistics-range";

const reference = new Date("2026-09-04T16:30:00.000Z");

test("statistics presets use Asia/Shanghai calendar days", () => {
    assert.deepEqual(statisticsPresetRange("today", reference), { start: "2026-09-05", end: "2026-09-05" });
    assert.deepEqual(statisticsPresetRange("last7Days", reference), { start: "2026-08-30", end: "2026-09-05" });
    assert.deepEqual(statisticsPresetRange("last30Days", reference), { start: "2026-08-07", end: "2026-09-05" });
});
