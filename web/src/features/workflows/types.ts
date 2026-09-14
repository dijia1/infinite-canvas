import type { CanvasFrameData } from "@/lib/canvas-frame";

export type WorkflowMediaType = "image" | "video" | "text";

export type WorkflowNodeType = "image_input" | "video_input" | "text_input" | "image_generation" | "video_generation";

export type WorkflowPosition = { x: number; y: number };

export type WorkflowInputPort = {
    id: string;
    type: WorkflowMediaType;
};

export type WorkflowGenerationConfig = {
    providerId?: string;
    size?: string;
    resolution?: string;
    quality?: string;
    outputFormat?: string;
    background?: string;
    seconds?: number;
    generateAudio?: boolean;
    options?: Record<string, unknown>;
};

export type WorkflowOutputSlot = {
    id: string;
    type: "image" | "video";
    position?: WorkflowPosition;
    width?: number;
    height?: number;
};

export type WorkflowNode = {
    id: string;
    type: WorkflowNodeType;
    position: WorkflowPosition;
    width?: number;
    height?: number;
    text?: string;
    mediaId?: string;
    inputPorts?: WorkflowInputPort[];
    config?: WorkflowGenerationConfig;
    outputs?: WorkflowOutputSlot[];
};

export type WorkflowConnection = {
    sourceNodeId: string;
    sourceSlotId: string;
    targetNodeId: string;
    targetPortId: string;
    order: number;
};

export type WorkflowGraph = {
    version: 1;
    nodes: WorkflowNode[];
    connections: WorkflowConnection[];
    frames?: CanvasFrameData[];
};

export type WorkflowRecord = {
    id: string;
    name: string;
    graph: WorkflowGraph;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

export type WorkflowListItem = Omit<WorkflowRecord, "graph"> & {
    nodeCount: number;
    connectionCount: number;
};

export type WorkflowList = {
    items: WorkflowListItem[];
    total: number;
    page: number;
    pageSize: number;
};

export type WorkflowRunStatus = "pending" | "running" | "stopping" | "attention_required" | "completed" | "partially_completed" | "failed" | "stopped";
export type WorkflowExecutionStatus = "waiting" | "ready" | "claimed" | "submitting" | "running" | "succeeded" | "failed" | "blocked" | "uncertain" | "stopped";

export type WorkflowRun = {
    id: string;
    requestId: string;
    workflowId: string;
    revision: number;
    title: string;
    scopeType: "workflow" | "frame";
    frameId: string;
    frameName: string;
    status: WorkflowRunStatus;
    stopRequested: boolean;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string;
};

export type WorkflowStepExecution = {
    runId: string;
    nodeId: string;
    status: WorkflowExecutionStatus;
    error?: string;
};

export type WorkflowOutputExecution = {
    runId: string;
    nodeId: string;
    slotId: string;
    status: WorkflowExecutionStatus;
    attempt: number;
    mediaId?: string;
    error?: string;
    updatedAt: string;
};

export type WorkflowOutputAttempt = {
    id: string;
    runId: string;
    nodeId: string;
    slotId: string;
    attempt: number;
    requestId: string;
    taskType: "image" | "video" | string;
    taskId?: string;
    resumeTaskId?: string;
    status: WorkflowExecutionStatus;
    error?: string;
    mediaId?: string;
    queuedAt?: string;
    startedAt?: string;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string;
};

export type WorkflowRunDetail = {
    run: WorkflowRun;
    graph: WorkflowGraph;
    steps: WorkflowStepExecution[];
    outputs: WorkflowOutputExecution[];
    attempts: WorkflowOutputAttempt[];
};

export type WorkflowRunList = {
    items: WorkflowRun[];
    total: number;
    page: number;
    pageSize: number;
};

export type WorkflowRunScope =
    | { type: "workflow" }
    | { type: "frame"; frameId: string };

export type CreateWorkflowRunInput = {
    requestId: string;
    revision: number;
    scope: WorkflowRunScope;
};

export type WorkflowRunScopeState = {
    scope: WorkflowRunScope;
    latestRun: WorkflowRun | null;
    activeRunId: string | null;
};

export type WorkflowRunState = {
    workflowId: string;
    revision: number;
    scopes: WorkflowRunScopeState[];
    nodeRunIds: Record<string, string>;
    activeRuns: WorkflowRunList;
};
