"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Empty, Input, Pagination, Select, Spin, Tag } from "antd";
import Link from "next/link";
import { useDeferredValue, useState } from "react";

import { appPath } from "@/lib/app-path";
import { apiRequestError } from "@/services/api/request";
import { fetchPortalMembers, updatePortalMemberAppRole, type AppRole, type PortalMember } from "@/services/api/members";
import { portalSessionQuery } from "@/services/api/session";
import { syncPortalMembers } from "@/services/api/operation-logs";
import { useAdminStore } from "@/stores/use-admin-store";

const PAGE_SIZE = 20;

export default function AdminMembersPage() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const adminUser = useAdminStore((state) => state.user);
    const clearSession = useAdminStore((state) => state.clearSession);
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
    const revokeOwnAdminSession = async () => {
        await queryClient.invalidateQueries({ queryKey: ["portal-session"] });
        const session = await queryClient.fetchQuery({ ...portalSessionQuery, staleTime: 0 });
        if (!session.isAdmin) {
            clearSession();
            return;
        }
        await queryClient.invalidateQueries({ queryKey: ["portal-members"] });
        message.success("应用角色已更新");
    };

    return (
        <main className="space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold">成员管理</h1>
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">成员来自 Portal 用户目录；可在此分配应用角色或查看最近 7 天的操作记录。</p>
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
                    {members.data.items.map((member) => <MemberRow key={member.userUid} member={member} adminUID={adminUser?.id} onSelfAdminRoleRevoked={revokeOwnAdminSession} />)}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={members.isError ? "读取成员失败" : "暂无已同步成员"} />
            )}
            {(members.data?.total || 0) > PAGE_SIZE ? <Pagination current={page} pageSize={PAGE_SIZE} total={members.data?.total} showSizeChanger={false} onChange={setPage} /> : null}
        </main>
    );
}

function MemberRow({ member, adminUID, onSelfAdminRoleRevoked }: { member: PortalMember; adminUID?: string; onSelfAdminRoleRevoked: () => Promise<void> }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const href = appPath(`/admin/operations?actor=${encodeURIComponent(member.userUid)}`);
    const roleUpdate = useMutation({
        mutationKey: ["portal-member-app-role", member.userUid],
        mutationFn: (appRole: AppRole) => updatePortalMemberAppRole(member.userUid, appRole),
        onSuccess: async (updatedMember) => {
            if (updatedMember.userUid === adminUID && updatedMember.appRole !== "admin") {
                await onSelfAdminRoleRevoked();
                return;
            }
            await queryClient.invalidateQueries({ queryKey: ["portal-members"] });
            message.success("应用角色已更新");
        },
        onError: (error) => message.error(apiRequestError(error, "应用角色更新失败")),
    });

    return (
        <article className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-100 px-4 py-3 last:border-b-0 dark:border-stone-800">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{member.displayName}</span>
                    <Tag color={member.enabled ? "green" : "default"}>{member.enabled ? "已启用" : "已停用"}</Tag>
                </div>
                <p className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{member.userUid}</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
                {member.roles.map((role) => <Tag key={role}>{role}</Tag>)}
                <Select<AppRole>
                    aria-label={`${member.displayName} 的应用角色`}
                    className="w-36"
                    size="small"
                    value={member.appRole}
                    disabled={roleUpdate.isPending}
                    options={[
                        { value: "member", label: "普通成员" },
                        { value: "public_assets_manager", label: "公共素材管理员" },
                        { value: "admin", label: "管理员" },
                    ]}
                    onChange={(appRole) => roleUpdate.mutate(appRole)}
                />
                <Link href={href} className="text-sm text-stone-600 hover:text-stone-950 dark:text-stone-300 dark:hover:text-white">
                    查看操作记录
                </Link>
                <time className="text-xs text-stone-500 dark:text-stone-400">{new Date(member.syncedAt).toLocaleString()}</time>
            </div>
        </article>
    );
}
