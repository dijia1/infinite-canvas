"use client";

import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Empty, Spin, Table } from "antd";

import { formatCNYAmount } from "@/lib/money";
import { fetchTodayStatistics, type TodayStatisticsModel } from "@/services/api/admin-statistics";
import { useAdminStore } from "@/stores/use-admin-store";

export default function AdminStatisticsPage() {
    const token = useAdminStore((state) => state.token);
    const statistics = useQuery({ queryKey: ["admin-today-statistics"], queryFn: () => fetchTodayStatistics(token), enabled: Boolean(token), retry: false });

    if (statistics.isLoading) return <div className="flex justify-center py-16"><Spin /></div>;
    if (!statistics.data) return <main className="p-6"><Empty description={statistics.isError ? "读取今日统计失败" : "暂无统计数据"} /></main>;

    const data = statistics.data;
    return (
        <main className="space-y-5 p-6">
            <div>
                <h1 className="text-xl font-semibold">今日统计</h1>
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">按北京时间 {data.date} 统计成功完成的 AI 图片生成与编辑任务。</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
                <StatisticCard label="今日费用" value={formatCNYAmount(data.amount)} />
                <StatisticCard label="成功图片" value={`${data.imageCount} 张`} />
            </div>
            {data.unpricedImageCount > 0 ? <Alert type="warning" showIcon message={`有 ${data.unpricedImageCount} 张历史成功图片没有费用快照，已计入图片数量但未计入费用。`} /> : null}
            <Card title="模型明细">
                <Table<TodayStatisticsModel> rowKey={(item) => `${item.providerId}-${item.providerName}`} pagination={false} dataSource={data.models} locale={{ emptyText: "今日暂无成功图片任务" }} columns={[
                    { title: "模型", render: (_, item) => item.providerName || item.providerId || "未知模型" },
                    { title: "成功调用", dataIndex: "successfulCalls", align: "right" },
                    { title: "成功图片", dataIndex: "imageCount", align: "right", render: (value) => `${value} 张` },
                    { title: "费用", dataIndex: "amount", align: "right", render: (value: string) => formatCNYAmount(value) },
                    { title: "未计价图片", dataIndex: "unpricedImageCount", align: "right", render: (value) => value ? `${value} 张` : "—" },
                ]} />
            </Card>
        </main>
    );
}

function StatisticCard({ label, value }: { label: string; value: string }) {
    return <Card><p className="text-sm text-stone-500 dark:text-stone-400">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p></Card>;
}
