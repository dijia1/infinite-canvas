import assert from "node:assert/strict";
import test from "node:test";
import dayjs from "dayjs";

import type { StatisticsPreset, StatisticsRange } from "@/lib/statistics-range";
import { elements, hookHarness, oneElement, sourceModule } from "@/test-utils/source-component";
import type { StatisticsRangeFilter } from "./statistics-range-filter";

const sourceURL = new URL("./statistics-range-filter.tsx", import.meta.url);

function rangeFilter() {
    const harness = hookHarness();
    const changes: StatisticsRange[] = [];
    const presets: StatisticsPreset[] = [];
    let searches = 0;
    const range = { start: "2026-09-01", end: "2026-09-07" };
    const module = sourceModule<{ StatisticsRangeFilter: typeof StatisticsRangeFilter }>(sourceURL, {
        react: harness.hooks,
        dayjs: { default: dayjs },
        antd: { Button: "Button", Space: "Space", Popover: "Popover", DatePicker: { RangePicker: "RangePicker" } },
        "lucide-react": { CalendarDays: "CalendarDays" },
    });
    const render = () => harness.render(() => module.StatisticsRangeFilter({
        range,
        onPreset: (preset) => presets.push(preset),
        onRangeChange: (selected) => changes.push(selected),
        onSearch: () => { searches += 1; },
    }));
    return { render, range, changes, presets, get searches() { return searches; } };
}

test("the wired RangePicker submits a complete formatted range and closes its popover", () => {
    const filter = rangeFilter();
    const initial = filter.render();
    assert.equal(oneElement(initial, "Popover").props.open, false);
    oneElement(initial, "Popover").props.onOpenChange(true);
    const opened = filter.render();
    assert.equal(oneElement(opened, "Popover").props.open, true);
    const picker = oneElement(opened, "RangePicker");
    assert.deepEqual(picker.props.value.map((value: dayjs.Dayjs) => value.format("YYYY-MM-DD")), [filter.range.start, filter.range.end]);
    picker.props.onChange([dayjs("2026-08-29T14:35:00"), dayjs("2026-09-10T08:12:00")]);
    assert.deepEqual(filter.changes, [{ start: "2026-08-29", end: "2026-09-10" }]);
    assert.equal(oneElement(filter.render(), "Popover").props.open, false);
    assert.equal(filter.searches, 0, "range selection must not implicitly run a search");
});

test("clearing or selecting only one date neither submits nor closes the popover", () => {
    const filter = rangeFilter();
    oneElement(filter.render(), "Popover").props.onOpenChange(true);
    for (const incomplete of [null, [dayjs("2026-09-01"), null], [null, dayjs("2026-09-10")]]) {
        oneElement(filter.render(), "RangePicker").props.onChange(incomplete);
        assert.deepEqual(filter.changes, []);
        assert.equal(oneElement(filter.render(), "Popover").props.open, true);
    }
});

test("preset and search buttons invoke their supplied callbacks independently", () => {
    const filter = rangeFilter();
    const buttons = elements(filter.render(), (element) => element.type === "Button");
    for (const preset of ["today", "last7Days", "last30Days"]) {
        const button = buttons.find((element) => element.key === preset);
        assert.ok(button);
        button.props.onClick();
    }
    assert.deepEqual(filter.presets, ["today", "last7Days", "last30Days"]);
    const search = buttons.find((element) => element.props.type === "primary");
    assert.ok(search);
    search.props.onClick();
    assert.equal(filter.searches, 1);
    assert.deepEqual(filter.changes, []);
});
