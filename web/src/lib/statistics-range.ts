export type StatisticsPreset = "today" | "last7Days" | "last30Days";

export type StatisticsRange = {
    start: string;
    end: string;
};

export function statisticsPresetRange(preset: StatisticsPreset, reference = new Date()): StatisticsRange {
    const end = shanghaiDate(reference);
    const days = preset === "last7Days" ? 7 : preset === "last30Days" ? 30 : 1;
    return { start: subtractCalendarDays(end, days - 1), end };
}

function shanghaiDate(reference: Date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(reference);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function subtractCalendarDays(date: string, days: number) {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() - days);
    return value.toISOString().slice(0, 10);
}
