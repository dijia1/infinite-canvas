"use client";

import { useDeferredValue, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button, Checkbox, Empty, Input, Modal, Pagination, Spin } from "antd";

import { fetchCanvasShareRecipients, shareCanvasProject, type CanvasShareRecipient } from "@/services/api/canvas-share";

const PAGE_SIZE = 20;
const MAX_RECIPIENTS = 50;

export function describeCanvasShareRecipient(recipient: CanvasShareRecipient) {
    return `${recipient.displayName}－${recipient.departments.length ? recipient.departments.join("、") : "未设置部门"}`;
}

export function stopCanvasShareEvent(event: { stopPropagation: () => void }) {
    event.stopPropagation();
}

export function CanvasShareDialog({ projectId, revision, open, onClose }: { projectId: string; revision: number; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [selected, setSelected] = useState<string[]>([]);
    const deferredSearch = useDeferredValue(search);
    const recipients = useQuery({
        queryKey: ["canvas-share-recipients", page, deferredSearch],
        queryFn: () => fetchCanvasShareRecipients({ page, pageSize: PAGE_SIZE, query: deferredSearch }),
        enabled: open,
        retry: false,
    });
    const share = useMutation({
        mutationFn: () => shareCanvasProject(projectId, { revision, recipientUserUids: selected }),
        onSuccess: (result) => {
            const shared = result.deliveries.filter((item) => item.status === "shared").length;
            const failed = result.deliveries.length - shared;
            if (shared) message.success(`已分享给 ${shared} 位成员`);
            if (failed) message.error(`${failed} 位成员分享失败，请稍后重试`);
            if (shared) onClose();
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "分享失败，请稍后重试"),
    });

    useEffect(() => {
        if (open) return;
        setSearch("");
        setPage(1);
        setSelected([]);
    }, [open]);

    const toggleRecipient = (userUid: string, checked: boolean) => {
        setSelected((current) => checked ? [...new Set([...current, userUid])] : current.filter((item) => item !== userUid));
    };

    return (
        <Modal
            title="分享画布"
            open={open}
            centered
            destroyOnHidden
            modalRender={(modal) => <div onClick={stopCanvasShareEvent}>{modal}</div>}
            onCancel={onClose}
            footer={
                <>
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" loading={share.isPending} disabled={!selected.length} onClick={() => share.mutate()}>
                        分享给 {selected.length} 位成员
                    </Button>
                </>
            }
        >
            <p className="mb-4 text-sm text-stone-500 dark:text-stone-400">接收者会获得可独立编辑的画布副本，画布图片将复制到其“我的素材”。</p>
            <Input.Search
                value={search}
                allowClear
                placeholder="搜索成员姓名或 UID"
                onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                }}
            />
            <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-stone-200 dark:border-stone-800">
                {recipients.isLoading ? (
                    <div className="flex justify-center py-10"><Spin /></div>
                ) : recipients.data?.items.length ? recipients.data.items.map((recipient) => {
                    const checked = selected.includes(recipient.userUid);
                    return (
                        <label key={recipient.userUid} className="flex cursor-pointer items-center gap-3 border-b border-stone-100 px-3 py-3 last:border-b-0 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900">
                            <Checkbox checked={checked} disabled={!checked && selected.length >= MAX_RECIPIENTS} onChange={(event) => toggleRecipient(recipient.userUid, event.target.checked)} />
                            <span className="min-w-0 truncate text-sm">{describeCanvasShareRecipient(recipient)}</span>
                        </label>
                    );
                }) : <Empty className="py-7" image={Empty.PRESENTED_IMAGE_SIMPLE} description={recipients.isError ? "读取成员失败" : "没有可分享的成员"} />}
            </div>
            {(recipients.data?.total || 0) > PAGE_SIZE ? <Pagination className="mt-3" current={page} pageSize={PAGE_SIZE} total={recipients.data?.total} showSizeChanger={false} onChange={setPage} /> : null}
        </Modal>
    );
}
