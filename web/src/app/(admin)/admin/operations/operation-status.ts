import type { GenerationTaskStatus, OperationLog } from "@/services/api/operation-logs";

export const generationTaskStatusLabels: Record<GenerationTaskStatus, string> = {
    queued: "排队中",
    submitting: "提交中",
    running: "生成中",
    saving: "保存中",
    paused: "已暂停",
    uncertain: "结果不确定",
    succeeded: "已完成",
    failed: "任务失败",
};

export const generationStatusOptions = Object.entries(generationTaskStatusLabels).map(([value, label]) => ({ value, label: `任务 · ${label}` }));

export function operationStatusPresentation(item: OperationLog): { status: string; label: string; color: string } {
    const taskStatus = item.image?.status || item.video?.status;
    if (taskStatus) {
        return { status: taskStatus, label: generationTaskStatusLabels[taskStatus], color: taskStatusColor(taskStatus) };
    }
    if (item.status === "submitted") return { status: item.status, label: "已提交", color: "blue" };
    if (item.status === "success") return { status: item.status, label: "成功", color: "green" };
    return { status: item.status, label: "失败", color: "red" };
}

function taskStatusColor(status: GenerationTaskStatus): string {
    if (status === "succeeded") return "green";
    if (status === "failed") return "red";
    if (status === "uncertain" || status === "paused") return "orange";
    return "processing";
}
