"use client";

import { useRef, useState } from "react";

import type { AiConfig } from "@/lib/ai-config";
import type { AICapability } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ImageGenerationTask } from "@/services/api/image";
import { imageMetadata, type StoredCanvasImage } from "@/services/canvas-image-hydration";
import type { UploadedFile } from "@/services/file-storage";
import { normalizeImageResolution } from "@/lib/image-generation-config";
import { imageEditReferenceError } from "@/lib/image-edit-validation";
import { buildAngleLabel, buildAnglePrompt, buildGenerationConfig, buildImageGenerationMetadata, findRetrySourceNode, getGenerationCount, referenceUrl, sourceNodeReferenceImages, withoutLegacyModel, type CanvasAngleParameters } from "../utils/canvas-generation-utils";
import { fitNodeSize, nodeSizeFromRatio } from "../utils/canvas-node-size";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "../constants";
import type { CanvasMaskResources } from "../image-mask/mask-resources";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "../types";
import type { NodeGenerationContext } from "../components/canvas-node-generation";

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

type MutableRef<T> = { current: T };
type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
type MessageApi = { error: (text: string) => void; warning: (text: string) => void };

export type CanvasGenerationControllerOptions = {
    nodesRef: MutableRef<CanvasNodeData[]>;
    connectionsRef: MutableRef<CanvasConnection[]>;
    effectiveConfig: AiConfig;
    defaultConfig: AiConfig;
    isAiConfigReady: (capability: AICapability) => boolean;
    openConfigDialog: (open: boolean) => void;
    message: MessageApi;
    setNodes: StateSetter<CanvasNodeData[]>;
    setConnections: StateSetter<CanvasConnection[]>;
    setSelectedNodeIds: StateSetter<Set<string>>;
    setSelectedConnectionId: StateSetter<string | null>;
    setDialogNodeId: StateSetter<string | null>;
    setAngleNodeId: StateSetter<string | null>;
    setRunningNodeId?: StateSetter<string | null>;
    createId: () => string;
    createConfigNode: (position: Position, metadata: CanvasNodeMetadata) => CanvasNodeData;
    requestGeneration: (config: AiConfig, prompt: string, clientRequestId: string) => Promise<ImageGenerationTask>;
    requestEdit: (config: AiConfig, prompt: string, references: ReferenceImage[], clientRequestId: string) => Promise<ImageGenerationTask>;
    getImageTask: (taskId: string) => Promise<ImageGenerationTask>;
    getImageTaskByClientRequest: (clientRequestId: string) => Promise<ImageGenerationTask>;
    requestVideoGeneration: (config: AiConfig, prompt: string, references: ReferenceImage[]) => Promise<Blob>;
    uploadImage: (input: string | Blob, mediaId?: string) => Promise<StoredCanvasImage>;
    uploadMediaFile: (input: Blob, prefix: string) => Promise<UploadedFile>;
    hydrateGenerationContext: (nodeId: string, prompt: string) => Promise<NodeGenerationContext>;
    resolveImageUrl?: (storageKey?: string, fallback?: string) => Promise<string>;
    resolveStoredImageReference?: (storageKey: string) => Promise<string>;
    resolveMetadataReferences?: (metadata: CanvasNodeMetadata) => Promise<ReferenceImage[] | null>;
    resolveMask?: (maskId: string) => ReferenceImage["mask"] | undefined;
    maskResources?: CanvasMaskResources;
};

export type CanvasGenerationController = {
    readonly runningNodeId: string | null;
    updateOptions: (options: CanvasGenerationControllerOptions) => void;
    generateNode: (nodeId: string, mode: CanvasGenerationMode, prompt: string) => Promise<void>;
    retryNode: (node: CanvasNodeData) => Promise<void>;
    generateImageFromTextNode: (node: CanvasNodeData) => void;
    generateAngleNode: (node: CanvasNodeData, params: CanvasAngleParameters, source?: string) => Promise<void>;
    resumePendingImageTasks: () => void;
    clearRunningNode: (nodeIds?: Set<string>) => void;
};

function mediaMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4" };
}

export function createCanvasGenerationController(initialOptions: CanvasGenerationControllerOptions): CanvasGenerationController {
    let options = initialOptions;
    let runningNodeId: string | null = null;
    const activeImageTaskNodeIds = new Set<string>();
    const setRunningNodeId = (next: string | null) => {
        runningNodeId = next;
        options.setRunningNodeId?.(next);
    };
    const createConnection = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: options.createId(), fromNodeId, toNodeId });
    const missingReference = (nodeId: string) => {
        const errorDetails = "参考图片已丢失，无法继续重试";
        options.message.error(errorDetails);
        options.setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
    };
    const resolveMetadataReferences = async (metadata: CanvasNodeMetadata): Promise<ReferenceImage[] | null> => {
        if (options.resolveMetadataReferences) return options.resolveMetadataReferences(metadata);
        if (metadata.generationType !== "edit") return [];
        if (!metadata.references?.length || (!options.resolveImageUrl && !options.resolveStoredImageReference)) return null;
        const references = await Promise.all(
            metadata.references.map(async (url, index) => {
                const isStoredImage = /^(?:image|media|preview):/.test(url);
                const dataUrl = isStoredImage ? await (options.resolveStoredImageReference?.(url) || options.resolveImageUrl!(url, "")) : url;
                const mask = index === 0 ? (metadata.maskId ? options.resolveMask?.(metadata.maskId) : metadata.referenceMasks?.[index]) : undefined;
                return dataUrl
                    ? {
                          id: `${index}`,
                          name: `reference-${index}.png`,
                          type: "image/png",
                          dataUrl,
                          storageKey: isStoredImage ? url : undefined,
                          ...(mask ? { mask } : {}),
                          ...(mask && metadata.maskId ? { maskId: metadata.maskId, sourceNodeId: metadata.sourceNodeId } : {}),
                      }
                    : null;
            }),
        );
        return references.every(Boolean) ? (references as ReferenceImage[]) : null;
    };
    const imageTaskError = (task: ImageGenerationTask) => task.error || "图片生成失败";
    const setImageTaskState = (nodeId: string, task: ImageGenerationTask) => {
        options.setNodes((previous) =>
            previous.map((node) =>
                node.id === nodeId
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              imageTaskId: task.id,
                              imageTaskClientRequestId: task.clientRequestId || node.metadata?.imageTaskClientRequestId,
                              status: task.status === "failed" ? NODE_STATUS_ERROR : task.status === "succeeded" ? NODE_STATUS_SUCCESS : NODE_STATUS_LOADING,
                              errorDetails: task.status === "failed" ? imageTaskError(task) : undefined,
                          },
                      }
                    : node,
            ),
        );
    };
    const completeImageTaskNode = async (nodeId: string, rootId: string, task: ImageGenerationTask) => {
        const image = task.images[0];
        if (!image?.dataUrl) throw new Error("图片任务完成但未返回图片");
        const uploaded = await options.uploadImage(image.dataUrl, image.mediaId);
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
        options.setNodes((previous) => {
            const root = previous.find((node) => node.id === rootId);
            return previous.map((node) => {
                if (node.id !== nodeId && node.id !== rootId) return node;
                const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                if (node.id === rootId && (nodeId === rootId || !root?.metadata?.primaryImageId)) {
                    return {
                        ...node,
                        position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                        width: imageSize.width,
                        height: imageSize.height,
                        metadata: { ...node.metadata, ...imageMetadata(uploaded), imageTaskId: task.id, imageTaskClientRequestId: task.clientRequestId || node.metadata?.imageTaskClientRequestId, primaryImageId: nodeId, errorDetails: undefined },
                    };
                }
                if (node.id === nodeId) {
                    return {
                        ...node,
                        position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                        width: imageSize.width,
                        height: imageSize.height,
                        metadata: { ...node.metadata, ...imageMetadata(uploaded), imageTaskId: task.id, imageTaskClientRequestId: task.clientRequestId || node.metadata?.imageTaskClientRequestId, errorDetails: undefined },
                    };
                }
                return node;
            });
        });
    };
    const observeImageTask = async (nodeId: string, rootId: string, initialTask?: ImageGenerationTask) => {
        if (activeImageTaskNodeIds.has(nodeId)) return;
        activeImageTaskNodeIds.add(nodeId);
        try {
            let task = initialTask;
            if (!task) {
                const node = options.nodesRef.current.find((item) => item.id === nodeId);
                const taskID = node?.metadata?.imageTaskId;
                const clientRequestID = node?.metadata?.imageTaskClientRequestId;
                task = taskID ? await options.getImageTask(taskID) : clientRequestID ? await options.getImageTaskByClientRequest(clientRequestID) : undefined;
            }
            while (task) {
                setImageTaskState(nodeId, task);
                if (task.status === "succeeded") {
                    await completeImageTaskNode(nodeId, rootId, task);
                    return;
                }
                if (task.status === "failed") throw new Error(imageTaskError(task));
                await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000));
                task = await options.getImageTask(task.id);
            }
            throw new Error("图片任务不存在");
        } catch (error) {
            const errorDetails = error instanceof Error ? error.message : "图片生成失败";
            options.setNodes((previous) => previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
        } finally {
            activeImageTaskNodeIds.delete(nodeId);
        }
    };
    const startImageTask = async (nodeId: string, rootId: string, create: (clientRequestId: string) => Promise<ImageGenerationTask>) => {
        const clientRequestId = options.createId();
        options.setNodes((previous) =>
            previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, imageTaskClientRequestId: clientRequestId, imageTaskId: undefined, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)),
        );
        let task: ImageGenerationTask;
        try {
            task = await create(clientRequestId);
        } catch (error) {
            try {
                task = await options.getImageTaskByClientRequest(clientRequestId);
            } catch {
                throw error;
            }
        }
        if (task.status === "succeeded" || task.status === "failed") {
            await observeImageTask(nodeId, rootId, task);
            return;
        }
        setImageTaskState(nodeId, task);
        void observeImageTask(nodeId, rootId, task);
    };
    const resumePendingImageTasks = () => {
        options.nodesRef.current
            .filter((node) => node.type === CanvasNodeType.Image && node.metadata?.status === NODE_STATUS_LOADING && (node.metadata.imageTaskId || node.metadata.imageTaskClientRequestId))
            .forEach((node) => void observeImageTask(node.id, node.metadata?.batchRootId || node.id));
    };

    const generateAngleNode = async (node: CanvasNodeData, params: CanvasAngleParameters, source?: string) => {
        const dataUrl = source || node.metadata?.content || "";
        if (!dataUrl) return;
        const generationConfig = { ...buildGenerationConfig(options.effectiveConfig, node, options.defaultConfig), count: "1" };
        if (!options.isAiConfigReady("imageEdit")) {
            options.openConfigDialog(true);
            return;
        }
        const childId = options.createId();
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const title = buildAngleLabel(params);
        const prompt = buildAnglePrompt(params);
        const references = [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl, storageKey: node.metadata?.storageKey, mediaId: node.metadata?.mediaId }];
        const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
        options.setAngleNodeId(null);
        setRunningNodeId(childId);
        options.setNodes((prev) => [
            ...prev,
            {
                id: childId,
                type: CanvasNodeType.Image,
                title,
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: imageConfig.width,
                height: imageConfig.height,
                metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
            },
        ]);
        options.setConnections((prev) => [...prev, createConnection(node.id, childId)]);
        options.setSelectedNodeIds(new Set([childId]));
        options.setDialogNodeId(childId);
        try {
            await startImageTask(childId, childId, (clientRequestId) => options.requestEdit(generationConfig, prompt, references, clientRequestId));
        } catch (error) {
            const errorDetails = error instanceof Error ? error.message : "生成失败";
            options.setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
        } finally {
            setRunningNodeId(null);
        }
    };

    const generateNode = async (nodeId: string, mode: CanvasGenerationMode, prompt: string) => {
        const sourceNode = options.nodesRef.current.find((node) => node.id === nodeId);
        const generationConfig = buildGenerationConfig(options.effectiveConfig, sourceNode, options.defaultConfig);
        if (mode === "video" && !options.isAiConfigReady("video")) {
            options.openConfigDialog(true);
            return;
        }
        const generationContext = await options.hydrateGenerationContext(nodeId, prompt);
        const effectivePrompt = generationContext.prompt.trim();
        const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image;
        if (!effectivePrompt) {
            setRunningNodeId(null);
            return;
        }
        const sourceReference = sourceNode?.type === CanvasNodeType.Image && (sourceNode.metadata?.content || sourceNode.metadata?.mediaId) ? sourceNodeReferenceImages(sourceNode, options.maskResources) : [];
        const referenceImages = sourceReference.length ? sourceReference : generationContext.referenceImages;
        if (mode === "image") {
            const referenceError = referenceImages.length ? imageEditReferenceError(referenceImages) : undefined;
            if (referenceError) {
                options.message.error(referenceError);
                return;
            }
            if (!options.isAiConfigReady(referenceImages.length ? "imageEdit" : "image")) {
                options.openConfigDialog(true);
                return;
            }
        }
        setRunningNodeId(nodeId);
        let pendingChildIds: string[] = [];
        if (markSourceStatus) options.setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
        try {
            if (mode === "image") {
                const count = getGenerationCount(generationConfig.count);
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                const generationMetadata = buildImageGenerationMetadata(referenceImages.length ? "edit" : "generation", generationConfig, count, referenceImages);
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const rootId = isEmptyImageNode ? nodeId : options.createId();
                const childIds = count > 1 ? Array.from({ length: count }, () => options.createId()) : [];
                const targetIds = count > 1 ? childIds : [rootId];
                pendingChildIds = isEmptyImageNode ? childIds : [rootId, ...childIds];
                const rootNode: CanvasNodeData = {
                    id: rootId,
                    type: CanvasNodeType.Image,
                    title: effectivePrompt.slice(0, 32) || "Generated Image",
                    position: { x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96, y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2 },
                    width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                    height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                    metadata: {
                        prompt: effectivePrompt,
                        status: NODE_STATUS_LOADING,
                        isBatchRoot: count > 1,
                        batchChildIds: count > 1 ? childIds : undefined,
                        batchUsesReferenceImages: referenceImages.length > 0,
                        ...generationMetadata,
                        imageBatchExpanded: count > 1 ? true : undefined,
                    },
                };
                const childNodes = childIds.map((id, index): CanvasNodeData => ({
                    id,
                    type: CanvasNodeType.Image,
                    title: effectivePrompt.slice(0, 32) || "Generated Image",
                    position: { x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36), y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + 36) },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                }));
                const batchConnections = [...(isEmptyImageNode ? [] : [createConnection(nodeId, rootId)]), ...childIds.map((childId) => createConnection(rootId, childId))];
                options.setNodes((prev) => [
                    ...prev.map((node) =>
                        node.id !== nodeId
                            ? node
                            : isConfigNode
                              ? { ...node, metadata: { ...node.metadata, prompt, status: NODE_STATUS_SUCCESS, errorDetails: undefined } }
                              : isEmptyImageNode
                                ? { ...node, position: rootNode.position, width: rootNode.width, height: rootNode.height, title: rootNode.title, metadata: { ...withoutLegacyModel(node.metadata), ...rootNode.metadata, errorDetails: undefined } }
                                : isImageNode
                                  ? { ...node, metadata: { ...node.metadata, prompt: effectivePrompt, status: NODE_STATUS_SUCCESS, errorDetails: undefined } }
                                  : {
                                        ...node,
                                        type: CanvasNodeType.Text,
                                        title: prompt.slice(0, 32) || "Prompt",
                                        width: parentConfig.width,
                                        height: parentConfig.height,
                                        metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                    },
                    ),
                    ...(isEmptyImageNode ? [] : [rootNode]),
                    ...childNodes,
                ]);
                options.setConnections((prev) => [...prev, ...batchConnections]);
                options.setSelectedNodeIds(new Set([nodeId]));
                options.setSelectedConnectionId(null);
                options.setDialogNodeId(nodeId);
                const submissionResults = await Promise.allSettled(
                    targetIds.map((targetId) =>
                        startImageTask(targetId, rootId, (clientRequestId) =>
                            referenceImages.length
                                ? options.requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, clientRequestId)
                                : options.requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, clientRequestId),
                        ),
                    ),
                );
                const failures = submissionResults.filter((result) => result.status === "rejected");
                if (failures.length) {
                    options.setNodes((previous) =>
                        previous.map((node) => {
                            const index = targetIds.indexOf(node.id);
                            const result = index < 0 ? undefined : submissionResults[index];
                            if (!result || result.status !== "rejected") return node;
                            const errorDetails = result.reason instanceof Error ? result.reason.message : "图片任务提交失败";
                            return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } };
                        }),
                    );
                    options.message.error(failures.length === targetIds.length ? "全部图片生成失败" : "部分图片生成失败");
                }
                return;
            }

            if (mode === "video") {
                const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                const videoId = isEmptyVideoNode ? nodeId : options.createId();
                const parent = sourceNode?.position || { x: 0, y: 0 };
                const videoNode: CanvasNodeData = {
                    id: videoId,
                    type: CanvasNodeType.Video,
                    title: effectivePrompt.slice(0, 32) || "Generated Video",
                    position: isEmptyVideoNode ? sourceNode!.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                    width: isEmptyVideoNode ? sourceNode!.width : spec.width,
                    height: isEmptyVideoNode ? sourceNode!.height : spec.height,
                    metadata: {
                        prompt: effectivePrompt,
                        status: NODE_STATUS_LOADING,
                        size: generationConfig.size,
                        seconds: generationConfig.videoSeconds,
                        vquality: generationConfig.vquality,
                        references: generationContext.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
                    },
                };
                pendingChildIds = [videoId];
                options.setNodes((prev) =>
                    isEmptyVideoNode
                        ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                        : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                );
                if (!isEmptyVideoNode) options.setConnections((prev) => [...prev, createConnection(nodeId, videoId)]);
                const video = await options.uploadMediaFile(await options.requestVideoGeneration(generationConfig, effectivePrompt, generationContext.referenceImages), "video");
                const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                options.setNodes((prev) =>
                    prev.map((node) =>
                        node.id === videoId
                            ? {
                                  ...node,
                                  width: videoSize.width,
                                  height: videoSize.height,
                                  position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                  metadata: {
                                      ...node.metadata,
                                      ...mediaMetadata(video),
                                      prompt: effectivePrompt,
                                      size: generationConfig.size,
                                      seconds: generationConfig.videoSeconds,
                                      vquality: generationConfig.vquality,
                                      references: generationContext.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
                                  },
                              }
                            : node,
                    ),
                );
                return;
            }

            return;
        } catch (error) {
            const errorDetails = error instanceof Error ? error.message : "生成失败";
            options.message.error(errorDetails);
            options.setNodes((prev) =>
                prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
            );
        } finally {
            setRunningNodeId(null);
        }
    };

    const retryNode = async (node: CanvasNodeData) => {
		if (node.type === CanvasNodeType.Text) {
			options.message.warning("文本节点不支持重新生成");
			return;
		}
        const sourceNode = findRetrySourceNode(node.id, options.nodesRef.current, options.connectionsRef.current) || node;
        const batchRoot = node.metadata?.batchRootId ? options.nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
        const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...withoutLegacyModel(batchRoot?.metadata), ...withoutLegacyModel(node.metadata) } : undefined;
        const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
        const generationConfig = {
            ...buildGenerationConfig(options.effectiveConfig, hasSavedImageMetadata && savedImageMetadata ? { ...node, metadata: savedImageMetadata } : sourceNode, options.defaultConfig),
            count: "1",
        };
        const context = hasSavedImageMetadata ? null : await options.hydrateGenerationContext(sourceNode.id, sourceNode.metadata?.prompt || node.metadata?.prompt || "");
        const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
        if (!prompt) {
            options.message.warning("找不到提示词，无法重试");
            return;
        }
        const useReferenceImages = savedImageMetadata?.generationType ? savedImageMetadata.generationType === "edit" : Boolean(context?.referenceImages.length);
        const retryCapability = node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Image ? (useReferenceImages ? "imageEdit" : "image") : null;
        if (retryCapability && !options.isAiConfigReady(retryCapability)) {
            options.openConfigDialog(true);
            return;
        }
        const retryReferenceImages =
            hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(batchRoot || sourceNode, options.maskResources)) : [];
        if (useReferenceImages && !retryReferenceImages) {
            missingReference(node.id);
            return;
        }
        setRunningNodeId(node.id);
        options.setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...withoutLegacyModel(item.metadata), status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
        try {
            if (node.type === CanvasNodeType.Video) {
                const video = await options.uploadMediaFile(await options.requestVideoGeneration(generationConfig, prompt, retryReferenceImages || []), "video");
                const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                options.setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  width: videoSize.width,
                                  height: videoSize.height,
                                  position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                  metadata: { ...withoutLegacyModel(item.metadata), ...mediaMetadata(video), prompt, size: generationConfig.size, seconds: generationConfig.videoSeconds, vquality: generationConfig.vquality },
                              }
                            : item,
                    ),
                );
                return;
            }
            const generationMetadata = savedImageMetadata?.generationType
                ? {
                      generationType: savedImageMetadata.generationType,
                      size: generationConfig.size,
                      resolution: generationConfig.resolution,
					  outputFormat: generationConfig.outputFormat,
					  background: generationConfig.background,
					  imageProviderId: generationConfig.imageProviderId,
					  videoProviderId: generationConfig.videoProviderId,
					  imageProviderType: generationConfig.imageProviderType,
					  imageRequestSchemaVersion: generationConfig.imageRequestSchemaVersion,
					  providerOptions: generationConfig.providerOptions,
                      quality: generationConfig.quality,
                      count: savedImageMetadata.count || 1,
                      references: savedImageMetadata.references,
                      ...(savedImageMetadata.maskId ? { maskId: savedImageMetadata.maskId, sourceNodeId: savedImageMetadata.sourceNodeId } : {}),
                  }
                : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryReferenceImages || []);
            options.setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Image, metadata: { ...withoutLegacyModel(item.metadata), prompt, ...generationMetadata } } : item)));
            await startImageTask(node.id, node.metadata?.batchRootId || node.id, (clientRequestId) =>
                useReferenceImages ? options.requestEdit(generationConfig, prompt, retryReferenceImages || [], clientRequestId) : options.requestGeneration(generationConfig, prompt, clientRequestId),
            );
        } catch (error) {
            const errorDetails = error instanceof Error ? error.message : "生成失败";
            options.message.error(errorDetails);
            options.setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
        } finally {
            setRunningNodeId(null);
        }
    };

    const generateImageFromTextNode = (node: CanvasNodeData) => {
        const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
        if (!prompt) {
            options.message.warning("文本节点为空，无法生图");
            return;
        }
        const sourceNode = options.nodesRef.current.find((item) => item.id === node.id);
        if (!sourceNode) return;
        const nodeSize = getNodeSpec(CanvasNodeType.Config);
        const configNode = options.createConfigNode(
            { x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2, y: sourceNode.position.y + sourceNode.height / 2 },
            {
                prompt: "",
                size: options.effectiveConfig.size,
                resolution: normalizeImageResolution(options.effectiveConfig.resolution),
                count: Number(options.effectiveConfig.count) || 1,
            },
        );
        const nextNodes = options.nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
        const nextConnections = [...options.connectionsRef.current, createConnection(sourceNode.id, configNode.id)];
        options.nodesRef.current = nextNodes;
        options.connectionsRef.current = nextConnections;
        options.setNodes(nextNodes);
        options.setConnections(nextConnections);
        options.setSelectedNodeIds(new Set([configNode.id]));
        options.setSelectedConnectionId(null);
        options.setDialogNodeId(configNode.id);
    };
    const clearRunningNode = (nodeIds?: Set<string>) => {
        if (!runningNodeId || (nodeIds && !nodeIds.has(runningNodeId))) return;
        setRunningNodeId(null);
    };

    return {
        get runningNodeId() {
            return runningNodeId;
        },
        updateOptions(next) {
            options = next;
        },
        generateNode,
        retryNode,
        generateImageFromTextNode,
        generateAngleNode,
        resumePendingImageTasks,
        clearRunningNode,
    };
}

export type UseCanvasGenerationOptions = Omit<CanvasGenerationControllerOptions, "setRunningNodeId">;

export function useCanvasGeneration(options: UseCanvasGenerationOptions) {
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const controllerRef = useRef<CanvasGenerationController | null>(null);
    const controllerOptions = { ...options, setRunningNodeId };
    if (!controllerRef.current) controllerRef.current = createCanvasGenerationController(controllerOptions);
    else controllerRef.current.updateOptions(controllerOptions);
    const controller = controllerRef.current;
    return {
        runningNodeId,
        generateNode: controller.generateNode,
        retryNode: controller.retryNode,
        generateImageFromTextNode: controller.generateImageFromTextNode,
        generateAngleNode: controller.generateAngleNode,
        resumePendingImageTasks: controller.resumePendingImageTasks,
        clearRunningNode: controller.clearRunningNode,
    };
}
