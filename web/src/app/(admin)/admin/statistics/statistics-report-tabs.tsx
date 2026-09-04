"use client";

import { ChevronDown } from "lucide-react";
import { Empty, Table, Tabs } from "antd";
import { useState } from "react";

import { formatCNYAmount } from "@/lib/money";
import type { StatisticsModel, StatisticsUser } from "@/services/api/admin-statistics";

type StatisticsReportTabsProps = {
    users: StatisticsUser[];
    models: StatisticsModel[];
};

export function StatisticsReportTabs({ users, models }: StatisticsReportTabsProps) {
    return (
        <Tabs
            className="statistics-report-tabs"
            items={[
                { key: "users", label: "按用户消耗", children: <UserUsageList users={users} /> },
                { key: "models", label: "按模型消耗", children: <ModelUsageTable models={models} /> },
            ]}
        />
    );
}

function UserUsageList({ users }: { users: StatisticsUser[] }) {
    if (users.length === 0) return <Empty className="rounded-lg border border-stone-200 py-10 dark:border-stone-800" image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选时间范围暂无成功图片任务" />;
    return (
        <div className="space-y-2">
            {users.map((user) => (
                <UserUsageCard key={user.userUid} user={user} />
            ))}
        </div>
    );
}

function UserUsageCard({ user }: { user: StatisticsUser }) {
    const [expanded, setExpanded] = useState(false);
    const displayName = user.displayName || user.userUid || "未知用户";
    return (
        <article className="overflow-hidden rounded-lg border border-stone-200 bg-white transition-colors hover:border-stone-300 dark:border-stone-800 dark:bg-stone-950 dark:hover:border-stone-700">
            <button type="button" className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left sm:px-5" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
                <div className="flex min-w-0 items-center gap-3">
                    <div className="grid size-9 shrink-0 place-items-center rounded-full bg-stone-100 text-sm font-semibold text-stone-700 dark:bg-stone-800 dark:text-stone-200">{displayName.slice(0, 1)}</div>
                    <div className="min-w-0">
                        <p className="truncate font-medium">{displayName}</p>
                        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                            {user.successfulCalls} 次成功调用{user.unpricedImageCount ? ` · ${user.unpricedImageCount} 张未计价` : ""}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-4 sm:gap-8">
                    <UsageMetric label="总费用" value={formatCNYAmount(user.amount)} />
                    <UsageMetric label="成功图片" value={`${user.imageCount} 张`} />
                    <ChevronDown className={`size-4 text-stone-400 transition-transform ${expanded ? "rotate-180" : ""}`} />
                </div>
            </button>
            {expanded ? (
                <div className="border-t border-stone-200 px-4 py-3 dark:border-stone-800 sm:px-5">
                    <ModelUsageTable models={user.models} compact />
                </div>
            ) : null}
        </article>
    );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-20 text-right">
            <span className="block text-base font-semibold tabular-nums text-stone-950 dark:text-stone-50">{value}</span>
            <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">{label}</span>
        </div>
    );
}

function ModelUsageTable({ models, compact = false }: { models: StatisticsModel[]; compact?: boolean }) {
    return <Table<StatisticsModel> size={compact ? "small" : "middle"} rowKey={(item) => `${item.providerId}-${item.providerName}`} pagination={false} dataSource={models} locale={{ emptyText: "暂无模型消耗" }} columns={modelColumns} />;
}

const modelColumns = [
    { title: "模型", render: (_: unknown, item: StatisticsModel) => item.providerName || item.providerId || "未知模型" },
    { title: "成功调用", dataIndex: "successfulCalls", align: "right" as const },
    { title: "成功图片", dataIndex: "imageCount", align: "right" as const, render: (value: number) => `${value} 张` },
    { title: "费用", dataIndex: "amount", align: "right" as const, render: (value: string) => formatCNYAmount(value) },
    { title: "未计价图片", dataIndex: "unpricedImageCount", align: "right" as const, render: (value: number) => (value ? `${value} 张` : "—") },
];
