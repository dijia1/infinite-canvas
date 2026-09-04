"use client";

import { CalendarDays } from "lucide-react";
import { Button, DatePicker, Popover, Space } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useState } from "react";

import type { StatisticsPreset, StatisticsRange } from "@/lib/statistics-range";

type StatisticsRangeFilterProps = {
    range: StatisticsRange;
    onPreset: (preset: StatisticsPreset) => void;
    onRangeChange: (range: StatisticsRange) => void;
    onSearch: () => void;
};

const presetLabels: Record<StatisticsPreset, string> = {
    today: "今天",
    last7Days: "近 7 天",
    last30Days: "近 30 天",
};

export function StatisticsRangeFilter({ range, onPreset, onRangeChange, onSearch }: StatisticsRangeFilterProps) {
    const [open, setOpen] = useState(false);
    const pickerValue: [Dayjs, Dayjs] = [dayjs(range.start), dayjs(range.end)];
    const selectRange = (dates: [Dayjs | null, Dayjs | null] | null) => {
        if (!dates?.[0] || !dates[1]) return;
        onRangeChange({ start: dates[0].format("YYYY-MM-DD"), end: dates[1].format("YYYY-MM-DD") });
        setOpen(false);
    };

    return (
        <Space wrap>
            {(Object.keys(presetLabels) as StatisticsPreset[]).map((preset) => (
                <Button key={preset} onClick={() => onPreset(preset)}>
                    {presetLabels[preset]}
                </Button>
            ))}
            <Popover open={open} onOpenChange={setOpen} trigger="click" content={<DatePicker.RangePicker value={pickerValue} allowClear={false} onChange={selectRange} />}>
                <Button icon={<CalendarDays size={15} />}>{formatRangeLabel(range)}</Button>
            </Popover>
            <Button type="primary" onClick={onSearch}>
                查询
            </Button>
        </Space>
    );
}

function formatRangeLabel(range: StatisticsRange) {
    return range.start === range.end ? range.start : `${range.start} 至 ${range.end}`;
}
