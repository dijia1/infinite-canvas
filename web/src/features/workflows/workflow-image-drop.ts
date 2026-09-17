import { collectDroppedImageFiles, importDroppedImageFiles } from "@/app/(user)/canvas/utils/canvas-file-drop";
import { autoAssignWorkflowFrameMembers } from "./workflow-frames";
import { workflowVisualNodeId } from "./workflow-canvas-adapter";
import { createWorkflowNode, fitWorkflowImage } from "./workflow-graph";
import type { UploadedImage } from "@/services/image-storage";
import type { WorkflowGraph, WorkflowNode, WorkflowPosition } from "./types";

export type WorkflowDropProgress = { completed: number; total: number };

type ImportOptions = {
    readLocal: (file: File) => Promise<UploadedImage>;
    signal: AbortSignal;
    onDiscard?: (image: UploadedImage) => void;
    onProgress?: (progress: WorkflowDropProgress) => void;
};

// Prepare off-document; the editor commits only once, against its latest graph.
export async function prepareWorkflowDroppedImages(files: Iterable<File>, center: WorkflowPosition, options: ImportOptions) {
    const input = Array.from(files);
    const total = collectDroppedImageFiles(input).files.length;
    const nodes = new Map<string, WorkflowNode>();
    const localImages = new Map<string, { image: UploadedImage; file: File }>();
    let completed = 0;
    options.signal.throwIfAborted();
    options.onProgress?.({ completed, total });
    const result = await importDroppedImageFiles(input, center, async (file, position) => {
        options.signal.throwIfAborted();
        try {
            const image = await options.readLocal(file);
            if (options.signal.aborted) { options.onDiscard?.(image); options.signal.throwIfAborted(); }
            const node = fitWorkflowImage(createWorkflowNode("image_input", position), image, true);
            node.position = { x: position.x - node.width! / 2, y: position.y - node.height! / 2 };
            localImages.set(node.id, { image, file });
            nodes.set(node.id, node);
            return node.id;
        } finally {
            completed++;
            if (!options.signal.aborted) options.onProgress?.({ completed, total });
        }
    });
    if (options.signal.aborted) { for (const { image } of localImages.values()) options.onDiscard?.(image); options.signal.throwIfAborted(); }
    return { ...result, localImages, nodes: result.nodeIds.map(id => nodes.get(id)!) };
}

export function appendWorkflowDroppedImages(graph: WorkflowGraph, nodes: WorkflowNode[]): WorkflowGraph {
    if (!nodes.length) return graph;
    return autoAssignWorkflowFrameMembers({ ...graph, nodes: [...graph.nodes, ...nodes] }, new Set(nodes.map(node => workflowVisualNodeId(node.id))));
}
