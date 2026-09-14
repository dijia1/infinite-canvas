import type { WorkflowGraph, WorkflowRunDetail, WorkflowOutputExecution, WorkflowOutputSlot, WorkflowRun, WorkflowRunStatus } from "./types";

const runStatusText: Record<WorkflowRunStatus, string> = {
    pending: "等待调度",
    running: "运行中",
    stopping: "正在停止",
    attention_required: "需要确认",
    completed: "已完成",
    partially_completed: "部分完成",
    failed: "运行失败",
    stopped: "已停止",
};

const outputStatusText: Record<WorkflowOutputExecution["status"], string> = {
    waiting: "等待依赖",
    ready: "等待提交",
    claimed: "等待提交",
    submitting: "正在提交",
    running: "生成中",
    succeeded: "已完成",
    failed: "生成失败",
    blocked: "上游失败",
    uncertain: "需要确认",
    stopped: "未执行即停止",
};

export function isWorkflowRunActive(status: WorkflowRunStatus | undefined) {
    return status === "pending" || status === "running" || status === "stopping" || status === "attention_required";
}

export function workflowRunStatusText(status: WorkflowRunStatus) {
    return runStatusText[status];
}

export function workflowRunScopeLabel(run: Pick<WorkflowRun, "scopeType" | "frameName">) {
    return run.scopeType === "frame" ? run.frameName || "包裹框" : "整个流程";
}

export function workflowOutputStatusText(status: WorkflowOutputExecution["status"] | undefined) {
    return status ? outputStatusText[status] : "等待运行结果";
}

export function workflowOutputKey(nodeId: string, slotId: string) {
    return JSON.stringify([nodeId, slotId]);
}

export function workflowOutputResourceNodeId(runId: string, nodeId: string, slotId: string) {
    return `workflow-run:${JSON.stringify([runId, nodeId, slotId])}`;
}

export function findWorkflowOutput(outputs: WorkflowOutputExecution[] | undefined, nodeId: string, slotId: string) {
    return outputs?.find((output) => output.nodeId === nodeId && output.slotId === slotId);
}

function indexWorkflowOutputs(outputs: WorkflowOutputExecution[] | undefined) {
    const index = new Map<string, WorkflowOutputExecution>();
    for (const output of outputs || []) {
        const key = workflowOutputKey(output.nodeId, output.slotId);
        if (!index.has(key)) index.set(key, output);
    }
    return index;
}

function indexWorkflowSlots(graph: WorkflowGraph) {
    const index = new Map<string, { nodeType: WorkflowGraph["nodes"][number]["type"]; slotType: WorkflowOutputSlot["type"] }>();
    const seenNodes = new Set<string>();
    for (const node of graph.nodes) {
        if (seenNodes.has(node.id)) continue;
        seenNodes.add(node.id);
        for (const slot of node.outputs || []) {
            const key = workflowOutputKey(node.id, slot.id);
            if (!index.has(key)) index.set(key, { nodeType: node.type, slotType: slot.type });
        }
    }
    return index;
}

export function indexCompatibleWorkflowOutputs(detail: Pick<WorkflowRunDetail, "graph" | "outputs"> | undefined, graph: WorkflowGraph) {
    const compatible = new Map<string, WorkflowOutputExecution>();
    if (!detail) return compatible;
    const originalSlots = indexWorkflowSlots(detail.graph);
    const currentSlots = indexWorkflowSlots(graph);
    for (const [key, output] of indexWorkflowOutputs(detail.outputs)) {
        const original = originalSlots.get(key);
        const current = currentSlots.get(key);
        if (original && current && original.nodeType === current.nodeType && original.slotType === current.slotType) compatible.set(key, output);
    }
    return compatible;
}

export function indexWorkflowRunDetailsByNode(
    detailsByRunId: ReadonlyMap<string, WorkflowRunDetail>,
    nodeRunIds: Readonly<Record<string, string>>,
    graph: WorkflowGraph,
) {
    const indexed = new Map<string, WorkflowRunDetail>();
    const currentNodes = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const [nodeId, runId] of Object.entries(nodeRunIds)) {
        const detail = detailsByRunId.get(runId);
        const current = currentNodes.get(nodeId);
        const original = detail?.graph.nodes.find((node) => node.id === nodeId);
        if (!detail || !current || !original || current.type !== original.type) continue;
        const originalSlots = new Map((original.outputs || []).map((slot) => [slot.id, slot.type]));
        if (!(current.outputs || []).some((slot) => originalSlots.get(slot.id) === slot.type)) continue;
        indexed.set(nodeId, detail);
    }
    return indexed;
}

export function indexWorkflowRunOutputsByNode(detailsByNode: ReadonlyMap<string, WorkflowRunDetail>, graph: WorkflowGraph) {
    const indexed = new Map<string, WorkflowOutputExecution>();
    const currentNodes = new Map<string, WorkflowGraph["nodes"][number]>();
    for (const node of graph.nodes) if (!currentNodes.has(node.id)) currentNodes.set(node.id, node);
    const runs = new Map<string, {
        nodes: Map<string, { type: WorkflowGraph["nodes"][number]["type"]; slots: Map<string, WorkflowOutputSlot["type"]> }>;
        outputs: Map<string, WorkflowOutputExecution>;
    }>();
    for (const [nodeId, detail] of detailsByNode) {
        let run = runs.get(detail.run.id);
        if (!run) {
            const nodes = new Map<string, { type: WorkflowGraph["nodes"][number]["type"]; slots: Map<string, WorkflowOutputSlot["type"]> }>();
            for (const node of detail.graph.nodes) {
                if (nodes.has(node.id)) continue;
                nodes.set(node.id, { type: node.type, slots: new Map((node.outputs || []).map((slot) => [slot.id, slot.type])) });
            }
            run = { nodes, outputs: indexWorkflowOutputs(detail.outputs) };
            runs.set(detail.run.id, run);
        }
        const current = currentNodes.get(nodeId);
        const original = run.nodes.get(nodeId);
        if (!current || !original || current.type !== original.type) continue;
        for (const slot of current.outputs || []) {
            if (original.slots.get(slot.id) !== slot.type) continue;
            const key = workflowOutputKey(nodeId, slot.id);
            const output = run.outputs.get(key);
            if (output) indexed.set(key, output);
        }
    }
    return indexed;
}

export function latestWorkflowRun(items: WorkflowRun[] | undefined, workflowId: string | undefined) {
    return items?.find((run) => run.workflowId === workflowId);
}

export function isRetryableImageOutput(slot: WorkflowOutputSlot, output: WorkflowOutputExecution | undefined, run: WorkflowRun | undefined) {
    return slot.type === "image" && output?.status === "failed" && Boolean(run && !run.stopRequested && run.status !== "stopped");
}

export function workflowVideoResumeTaskID(detail: WorkflowRunDetail, output: WorkflowOutputExecution) {
    if (detail.run.status !== "attention_required" || output.status !== "uncertain") return undefined;
    const node = detail.graph.nodes.find((item) => item.id === output.nodeId);
    const slot = node?.outputs?.find((item) => item.id === output.slotId);
    if (node?.type !== "video_generation" || slot?.type !== "video") return undefined;
    const attempt = detail.attempts.find((item) => item.nodeId === output.nodeId && item.slotId === output.slotId && item.attempt === output.attempt && item.status === "uncertain" && item.taskType === "video");
    return attempt?.resumeTaskId?.trim() || undefined;
}

export function workflowRunAttentionText(detail: WorkflowRunDetail) {
    return detail.outputs.some((output) => Boolean(workflowVideoResumeTaskID(detail, output)))
        ? "视频任务需要确认。请恢复原任务，页面会继续刷新同一任务的状态，不会创建新的生成任务。"
        : "生成任务需要确认。页面会继续刷新原任务状态，不会创建新的生成任务。";
}


export function findCompatibleWorkflowOutput(detail: Pick<WorkflowRunDetail, "graph" | "outputs">, graph: WorkflowGraph, nodeId: string, slotId: string) {
    const original = detail.graph.nodes.find((node) => node.id === nodeId);
    const current = graph.nodes.find((node) => node.id === nodeId);
    const originalSlot = original?.outputs?.find((slot) => slot.id === slotId);
    const currentSlot = current?.outputs?.find((slot) => slot.id === slotId);
    if (!originalSlot || !currentSlot || original?.type !== current?.type || originalSlot.type !== currentSlot.type) return undefined;
    return findWorkflowOutput(detail.outputs, nodeId, slotId);
}

export function workflowDownloadImageCount(detail: Pick<WorkflowRunDetail, "graph" | "outputs"> | undefined) {
    if (!detail) return 0;
    const outputs = indexWorkflowOutputs(detail.outputs);
    return detail.graph.nodes.reduce((total, node) => total + (node.outputs || []).filter((slot) => {
        const output = outputs.get(workflowOutputKey(node.id, slot.id));
        return (node.type === "image_generation" || node.type === "video_generation") && slot.type === "image" && output?.status === "succeeded" && Boolean(output.mediaId);
    }).length, 0);
}
