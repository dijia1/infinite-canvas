"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Empty, Input, Pagination, Spin, Tag } from "antd";
import Link from "next/link";
import { useDeferredValue, useState } from "react";

import { appPath } from "@/lib/app-path";
import { fetchPortalMembers, type PortalMember } from "@/services/api/members";
import { syncPortalMembers } from "@/services/api/operation-logs";

const PAGE_SIZE = 20;

export default function AdminMembersPage() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const members = useQuery({ queryKey: ["portal-members", page, deferredSearch], queryFn: () => fetchPortalMembers({ page, pageSize: PAGE_SIZE, query: deferredSearch }) });
    const sync = useMutation({
        mutationFn: syncPortalMembers,
        onSuccess: async (result) => {
            message.success(`已同步 ${result.count} 名 Portal 用户`);
            await queryClient.invalidateQueries({ queryKey: ["portal-members"] });
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "Portal 用户同步失败"),
    });

    return (
        <main className="space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold">成员管理</h1>
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">成员来自 Portal 用户目录；点击成员可查看其最近 7 天的操作记录。</p>
                </div>
                <Button icon={<ReloadOutlined />} loading={sync.isPending} onClick={() => sync.mutate()}>
                    同步 Portal 用户
                </Button>
            </div>
            <Input.Search
                value={search}
                allowClear
                placeholder="按成员姓名或 UID 搜索"
                className="w-72"
                onChange={(event) => {
                    setPage(1);
                    setSearch(event.target.value);
                }}
            />
            {members.isLoading ? (
                <div className="flex justify-center py-16">
                    <Spin />
                </div>
            ) : members.data?.items.length ? (
                <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                    {members.data.items.map((member) => <MemberRow key={member.userUid} member={member} />)}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={members.isError ? "读取成员失败" : "暂无已同步成员"} />
            )}
            {(members.data?.total || 0) > PAGE_SIZE ? <Pagination current={page} pageSize={PAGE_SIZE} total={members.data?.total} showSizeChanger={false} onChange={setPage} /> : null}
        </main>
    );
}

function MemberRow({ member }: { member: PortalMember }) {
    const href = appPath(`/admin/operations?actor=${encodeURIComponent(member.userUid)}`);

    return (
        <Link href={href} className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-100 px-4 py-3 last:border-b-0 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{member.displayName}</span>
                    <Tag color={member.enabled ? "green" : "default"}>{member.enabled ? "已启用" : "已停用"}</Tag>
                </div>
                <p className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{member.userUid}</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
                {member.roles.map((role) => <Tag key={role}>{role}</Tag>)}
                <time className="text-xs text-stone-500 dark:text-stone-400">{new Date(member.syncedAt).toLocaleString()}</time>
            </div>
        </Link>
    );
}
