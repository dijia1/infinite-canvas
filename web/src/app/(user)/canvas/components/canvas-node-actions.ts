import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";

export type CanvasImageNodeWithContent = CanvasNodeData & {
    type: CanvasNodeType.Image;
    metadata: CanvasNodeMetadata & { content: string };
};

export function canSaveNodeAsAsset(node: CanvasNodeData): node is CanvasImageNodeWithContent {
    return node.type === CanvasNodeType.Image && !node.metadata?.localUploadState && Boolean(node.metadata?.content);
}

export function canOpenNodeGenerationDialog(node: CanvasNodeData) {
    return (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content);
}
