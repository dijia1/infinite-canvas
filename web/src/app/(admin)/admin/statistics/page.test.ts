import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./page.tsx", import.meta.url);

test("statistics page queries by date range and expands user model usage", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /statisticsPresetRange/);
    assert.match(source, /queryKey: \["admin-statistics", range\.start, range\.end\]/);
    assert.match(source, /StatisticsRangeFilter/);
    assert.match(source, /StatisticsReportTabs/);
    assert.match(source, /activeUsers/);
    assert.doesNotMatch(source, /按北京时间 .*统计成功完成的 AI 图片生成与编辑任务/);
});
