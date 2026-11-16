import { nanoid } from "nanoid";
import type { VideoGenerationSource } from "@/services/api/video";
import { videoNodeSize, nodeSizeFromRatio } from "@/features/canvas/utils/canvas-node-size";
import { createWorkflowFrame } from "./workflow-frames";
import { toWorkflowCanvasNodes, workflowVisualNodeId } from "./workflow-canvas-adapter";
import { addWorkflowConnection, createWorkflowNode } from "./workflow-graph";
import type { WorkflowGraph } from "./types";

export function createWorkflowFinalStep(graph: WorkflowGraph, mediaId: string, source: VideoGenerationSource) {
    if (source.mode !== "draft") throw new Error("请选择已完成的样片");
    if (graph.nodes.some((n) => n.type === "video_input" && n.mediaId === mediaId && graph.connections.some((c) => c.sourceNodeId === n.id && graph.nodes.some((target) => target.id === c.targetNodeId && target.config?.videoMode === "final"))))
        throw new Error("此样片已有正式片步骤");
    const x = Math.max(0, ...toWorkflowCanvasNodes(graph).map((n) => n.position.x + n.width), ...(graph.frames || []).map((f) => f.position.x + f.width)) + 160;
    const size = videoNodeSize(nodeSizeFromRatio(source.size, 420, 236) || { width: 420, height: 236 });
    // A pinned media input identifies the reviewed sample from this run. Running
    // the formal frame does not rerun the original sample or pick another slot.
    const input = { ...createWorkflowNode("video_input", { x, y: 100 }), mediaId, ...size };
    const output = createWorkflowNode("video_generation", { x: x + size.width + 96, y: 100 });
    output.config = { providerId: source.providerId, videoMode: "final", resolution: "1080p", size: source.size, seconds: source.seconds, generateAudio: source.generateAudio };
    output.outputs = output.outputs?.map((slot) => ({ ...slot, ...size }));
    let next = addWorkflowConnection({ ...graph, nodes: [...graph.nodes, input, output] }, { sourceNodeId: input.id, sourceSlotId: "output", targetNodeId: output.id });
    const frameId = nanoid();
    next = createWorkflowFrame(next, { id: frameId, name: "正式片", position: { x, y: 100 } }, new Set([workflowVisualNodeId(input.id), workflowVisualNodeId(output.id)]));
    return { graph: next, frameId, nodeId: output.id };
}
