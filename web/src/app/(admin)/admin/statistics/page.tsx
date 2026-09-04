"use client";

import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Empty, Spin } from "antd";
import { useState } from "react";

import { formatCNYAmount } from "@/lib/money";
import { statisticsPresetRange, type StatisticsPreset, type StatisticsRange } from "@/lib/statistics-range";
import { fetchStatistics } from "@/services/api/admin-statistics";
import { useAdminStore } from "@/stores/use-admin-store";

import { StatisticsRangeFilter } from "./statistics-range-filter";
import { StatisticsReportTabs } from "./statistics-report-tabs";

export default function AdminStatisticsPage() {
    const token = useAdminStore((state) => state.token);
    const [range, setRange] = useState<StatisticsRange>(() => statisticsPresetRange("today"));
    const [selectedRange, setSelectedRange] = useState<StatisticsRange>(() => statisticsPresetRange("today"));
    const statistics = useQuery({
        queryKey: ["admin-statistics", range.start, range.end],
        queryFn: () => fetchStatistics(token, range),
        enabled: Boolean(token),
        retry: false,
    });

    const selectPreset = (preset: StatisticsPreset) => {
        const nextRange = statisticsPresetRange(preset);
        setSelectedRange(nextRange);
        setRange(nextRange);
    };

    if (statistics.isLoading)
        return (
            <div className="flex justify-center py-16">
                <Spin />
            </div>
        );
    if (!statistics.data)
        return (
            <main className="p-6">
                <Empty description={statistics.isError ? "读取统计失败" : "暂无统计数据"} />
            </main>
        );

    const data = statistics.data;
    const activeUsers = data.users.length;
    return (
        <main className="space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-5 dark:border-stone-800">
                <h1 className="text-xl font-semibold">统计</h1>
                <StatisticsRangeFilter range={selectedRange} onPreset={selectPreset} onRangeChange={setSelectedRange} onSearch={() => setRange(selectedRange)} />
            </div>
            <div className="grid gap-4 md:grid-cols-3">
                <StatisticCard label="费用" value={formatCNYAmount(data.amount)} hint="所选时间范围内的成功任务" />
                <StatisticCard label="成功图片" value={`${data.imageCount} 张`} hint="按实际生成结果统计" />
                <StatisticCard label="活跃用户" value={`${activeUsers} 人`} hint="产生成功图片任务的成员" />
            </div>
            {data.unpricedImageCount > 0 ? <Alert type="warning" showIcon message={`有 ${data.unpricedImageCount} 张历史成功图片没有费用快照，已计入图片数量但未计入费用。`} /> : null}
            <StatisticsReportTabs users={data.users} models={data.models} />
        </main>
    );
}

function StatisticCard({ label, value, hint }: { label: string; value: string; hint: string }) {
    return (
        <Card>
            <p className="text-sm text-stone-500 dark:text-stone-400">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{hint}</p>
        </Card>
    );
}
