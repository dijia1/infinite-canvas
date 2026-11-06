import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";

export type CanvasImageNodeWithReference = CanvasNodeData & {
    type: CanvasNodeType.Image;
    metadata: CanvasNodeMetadata;
};

export function hasCanvasImage(node: CanvasNodeData | null | undefined): node is CanvasImageNodeWithReference {
    return node?.type === CanvasNodeType.Image && [node.metadata?.mediaId, node.metadata?.publicImageId, node.metadata?.storageKey, node.metadata?.content].some((value) => Boolean(value?.trim()));
}

export function canSaveNodeAsAsset(node: CanvasNodeData): node is CanvasImageNodeWithReference {
    return hasCanvasImage(node) && !node.metadata.localUploadState;
}

export function canOpenNodeGenerationDialog(node: CanvasNodeData) {
    return hasCanvasImage(node) || (node.type === CanvasNodeType.Video && Boolean(node.metadata?.content || node.metadata?.mediaId || node.metadata?.storageKey));
}
