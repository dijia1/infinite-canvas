"use client";

import { useMutation } from "@tanstack/react-query";
import { App, Input, Modal, Select } from "antd";
import { useState } from "react";

import { resolveGenerationTask } from "@/services/api/operation-logs";

export function TaskResolutionDialog({ kind, taskId, providerTaskId, onClose, onResolved }: {
    kind: "image" | "video";
    taskId: string;
    providerTaskId: string;
    onClose: () => void;
    onResolved: () => void;
}) {
    const { message } = App.useApp();
    const [action, setAction] = useState<"attach" | "close">("attach");
    const [upstreamId, setUpstreamId] = useState(providerTaskId);
    const [reason, setReason] = useState("");
    const mutation = useMutation({
        retry: false,
        mutationFn: () => resolveGenerationTask(kind, taskId, { action, providerTaskId: upstreamId.trim(), reason: reason.trim() }),
        onSuccess: () => {
            message.success(action === "attach" ? "已绑定原任务，后台会继续检查" : "已核对并结案");
            onResolved();
            onClose();
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "任务核对失败"),
    });
    return (
        <Modal open title="核对生成任务" okText={action === "attach" ? "绑定并检查原任务" : "确认失败并结案"} onCancel={mutation.isPending ? undefined : onClose} onOk={() => mutation.mutate()} confirmLoading={mutation.isPending} okButtonProps={{ disabled: !reason.trim() || action === "attach" && !upstreamId.trim() }}>
            <div className="space-y-4 py-3">
                <Select className="w-full" value={action} disabled={mutation.isPending} onChange={setAction} options={[{ value: "attach", label: "绑定原供应商任务，继续检查" }, { value: "close", label: "已在供应商处核对，确认失败并结案" }]} />
                {action === "attach" ? <label className="block space-y-2"><span>原供应商任务 ID</span><Input value={upstreamId} maxLength={512} disabled={mutation.isPending || Boolean(providerTaskId)} onChange={(event) => setUpstreamId(event.target.value)} /><p className="text-sm text-stone-500">仅继续查询这一个原任务，不会重新提交生成。</p></label> : <p className="text-sm text-stone-500">请先核对供应商记录。结案会将应用内任务记为失败，并结束后续查询。</p>}
                <label className="block space-y-2"><span>核对原因</span><Input.TextArea value={reason} maxLength={500} rows={3} disabled={mutation.isPending} onChange={(event) => setReason(event.target.value)} /></label>
            </div>
        </Modal>
    );
}
