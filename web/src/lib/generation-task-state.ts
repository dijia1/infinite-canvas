export type GenerationTaskStatus = "preparing" | "queued" | "submitting" | "running" | "saving" | "succeeded" | "failed" | "paused" | "uncertain";
export type GenerationTaskIssue = { kind: "transient" | "configuration" | "missing" | "unknown"; stage: "submit" | "query" | "save"; consecutiveFailures: number; nextRetryAt?: string };
export type GenerationRecoveryAction = "resume" | "regenerate" | "reconnect";
export type GenerationTaskReplacement = { replaceTaskId?: string; confirmUncertain?: boolean };

// A browser connection failure is local observation state, never a generation failure.
export class GenerationTaskQueryError extends Error {}

export function generationTaskPresentation(status: string | undefined, error?: string, issue?: GenerationTaskIssue, connectionError?: string) {
    if (connectionError) return { title: "连接中断", message: connectionError, tone: "warning" as const };
    if (status === "paused") return { title: issue?.stage === "save" ? "保存已暂停" : "查询已暂停", message: error || "可恢复原任务继续处理", tone: "warning" as const };
    if (status === "uncertain") return { title: issue?.stage === "query" ? "原任务需要确认" : "提交结果待确认", message: error || "无法确认原请求结果", tone: "warning" as const };
    if (status === "failed") return { title: "生成失败", message: error || "生成失败，请检查配置和输入", tone: "error" as const };
    if (issue && (status === "running" || status === "saving")) {
        const next = issue.nextRetryAt ? `，下次重查 ${new Date(issue.nextRetryAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "";
        return { title: issue.stage === "save" ? "保存异常，正在重试" : "查询异常，正在重试", message: `${error || "查询暂时失败"}。连续失败 ${issue.consecutiveFailures} 次${next}`, tone: "warning" as const };
    }
    const labels: Record<string, string> = {
        loading: "正在加载运行结果",
        preparing: "准备素材",
        queued: "排队中",
        submitting: "正在提交",
        running: "生成中",
        saving: "正在保存",
        succeeded: "已完成",
        waiting: "等待依赖",
        ready: "等待提交",
        claimed: "等待提交",
        blocked: "上游失败",
        stopped: "未执行即停止",
    };
    return { title: labels[status || ""] || "等待运行结果", message: error || "", tone: "normal" as const };
}

export function regenerationNeedsConfirmation(status?: string) {
    return status === "paused" || status === "uncertain";
}
