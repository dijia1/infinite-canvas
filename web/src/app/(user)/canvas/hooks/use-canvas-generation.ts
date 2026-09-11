"use client";

import { hasCanvasImage } from "../components/canvas-node-actions";

import { useEffect, useRef, useState } from "react";

import type { AiConfig } from "@/lib/ai-config";
import { reconcileVideoConfig, type VideoModelStatus } from "@/lib/video-config";
import type { AICapability } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { VideoQueryTransientError, VideoRequestRejectedError, validateVideoGeneration, getVideoTask, getVideoTaskByClientRequest, resumeVideoTask, type VideoGenerationTask } from "@/services/api/video";
import type { ImageGenerationTask } from "@/services/api/image";
import { imageMetadata, type StoredCanvasImage } from "@/services/canvas-image-hydration";
import type { UploadedFile } from "@/services/file-storage";
import { imageEditReferenceError } from "@/lib/image-edit-validation";
import {
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    buildImageGenerationMetadata,
    findRetrySourceNode,
    getGenerationCount,
    referenceUrl,
    sourceNodeReferenceImages,
    withoutLegacyModel,
    type CanvasAngleParameters,
} from "../utils/canvas-generation-utils";
import { fitNodeSize, nodeSizeFromRatio } from "../utils/canvas-node-size";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "../constants";
import type { CanvasMaskResources } from "../image-mask/mask-resources";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "../types";
import type { NodeGenerationContext } from "../components/canvas-node-generation";

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

type MutableRef<T> = { current: T };
type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
type MessageApi = { error: (text: string) => void; warning: (text: string) => void };
type TaskIdentity = { scope: string | undefined; nodeId: string; kind: "image" | "video"; taskId?: string; clientRequestId?: string };

export type CanvasGenerationControllerOptions = {
    nodesRef: MutableRef<CanvasNodeData[]>;
    connectionsRef: MutableRef<CanvasConnection[]>;
    effectiveConfig: AiConfig;
    getImageModelName?: (providerId: string) => string | undefined;
    getVideoModelStatus?: () => VideoModelStatus | null;
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
    requestVideoGeneration: (config: AiConfig, prompt: string, references: ReferenceImage[], clientRequestId?: string, videoMediaIds?: string[]) => Promise<VideoGenerationTask>;
    getVideoTask?: (id: string, signal?: AbortSignal) => Promise<VideoGenerationTask>;
    resumeVideoTask?: (id: string, signal?: AbortSignal) => Promise<VideoGenerationTask>;
    sessionScope?: string;
    getSessionScope?: () => string;
    getVideoTaskByClientRequest?: (id: string, signal?: AbortSignal) => Promise<VideoGenerationTask>;
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
    stopVideoObservations: (all?: boolean) => void;
    readonly runningNodeId: string | null;
    updateOptions: (options: CanvasGenerationControllerOptions) => void;
    generateNode: (nodeId: string, mode: CanvasGenerationMode, prompt: string) => Promise<void>;
    retryNode: (node: CanvasNodeData) => Promise<void>;
    generateImageFromTextNode: (node: CanvasNodeData) => void;
    generateAngleNode: (node: CanvasNodeData, params: CanvasAngleParameters, source?: string) => Promise<void>;
    resumePendingImageTasks: () => void;
    clearRunningNode: (nodeIds?: Set<string>) => void;
};

export function createCanvasGenerationController(initialOptions: CanvasGenerationControllerOptions): CanvasGenerationController {
    let options = initialOptions;
    let runningNodeId: string | null = null;
    const imageModelName = (config: AiConfig) => (config.imageProviderId ? options.getImageModelName?.(config.imageProviderId) : undefined);
    const sessionScope = () => options.getSessionScope?.() ?? options.sessionScope;
    const taskIdentity = (nodeId: string, kind: TaskIdentity["kind"]): TaskIdentity => {
        const metadata = options.nodesRef.current.find((node) => node.id === nodeId)?.metadata;
        return { scope: sessionScope(), nodeId, kind, taskId: metadata?.[`${kind}TaskId`], clientRequestId: metadata?.[`${kind}TaskClientRequestId`] };
    };
    const taskCurrent = (identity: TaskIdentity, nodes = options.nodesRef.current, task?: { id: string; clientRequestId?: string }) => {
        if (sessionScope() !== identity.scope) return false;
        const node = nodes.find((item) => item.id === identity.nodeId && item.type === identity.kind);
        if (!node) return false;
        const taskId = node.metadata?.[`${identity.kind}TaskId`];
        const clientRequestId = node.metadata?.[`${identity.kind}TaskClientRequestId`];
        return (
            (taskId === (identity.taskId || task?.id) || (!identity.taskId && !taskId)) &&
            (clientRequestId === (identity.clientRequestId || task?.clientRequestId) || (!identity.clientRequestId && !clientRequestId))
        );
    };
    const activeVideoTaskNodeIds = new Set<string>();
    const videoOperations = new Set<{ controller: AbortController; scope: string | undefined; nodeId: string }>();
    const beginVideoOperation = (nodeId: string) => {
        const operation = { controller: new AbortController(), scope: options.getSessionScope?.() ?? options.sessionScope, nodeId };
        videoOperations.add(operation);
        return operation;
    };
    const stopVideoObservations = (all = false) => {
        const scope = options.getSessionScope?.() ?? options.sessionScope;
        for (const operation of videoOperations) {
            if (all || operation.scope !== scope || !options.nodesRef.current.some((node) => node.id === operation.nodeId)) {
                operation.controller.abort();
                videoOperations.delete(operation);
            }
        }
    };
    const waitForVideo = (signal: AbortSignal, delay: number) =>
        new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, delay);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
                signal.removeEventListener("abort", abort);
                abort();
            }
        });
    const queryVideo = async (query: () => Promise<VideoGenerationTask>, signal: AbortSignal) => {
        for (let retry = 0; ; retry++) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            try {
                return await query();
            } catch (error) {
                if (!(error instanceof VideoQueryTransientError) || retry >= 3 || signal.aborted) throw error;
                await waitForVideo(signal, 12_000 * (retry + 1));
            }
        }
    };
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
    const imageTaskError = (task: ImageGenerationTask) => task.error || (task.status === "uncertain" ? "提交结果待确认，请勿重复生成" : "图片生成失败");
    const setImageTaskState = (identity: TaskIdentity, task: ImageGenerationTask) => {
        options.setNodes((previous) =>
            !taskCurrent(identity, previous, task) ? previous : previous.map((node) =>
                node.id === identity.nodeId
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              imageTaskId: task.id,
                              imageTaskClientRequestId: identity.clientRequestId || task.clientRequestId,
                              status: (task.status === "failed" || task.status === "uncertain") ? NODE_STATUS_ERROR : task.status === "succeeded" ? NODE_STATUS_SUCCESS : NODE_STATUS_LOADING,
                              errorDetails: (task.status === "failed" || task.status === "uncertain") ? imageTaskError(task) : undefined,
                          },
                      }
                    : node,
            ),
        );
    };
    const completeImageTaskNode = async (identity: TaskIdentity, rootId: string, task: ImageGenerationTask) => {
        if (!taskCurrent(identity, options.nodesRef.current, task)) return;
        const nodeId = identity.nodeId;
        const image = task.images[0];
        if (!image?.dataUrl) throw new Error("图片任务完成但未返回图片");
        const uploaded = await options.uploadImage(image.dataUrl, image.mediaId);
        if (!taskCurrent(identity, options.nodesRef.current, task)) return;
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
        options.setNodes((previous) => {
            if (!taskCurrent(identity, previous, task)) return previous;
            const root = previous.find((node) => node.id === rootId);
            const child = previous.find((node) => node.id === nodeId)!;
            const rootMatches = nodeId === rootId || (child.metadata?.batchRootId === rootId && root?.metadata?.batchChildIds?.includes(nodeId));
            return previous.map((node) => {
                if (node.id !== nodeId && node.id !== rootId) return node;
                const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                if (node.id === rootId && rootMatches && (nodeId === rootId || !root?.metadata?.primaryImageId)) {
                    return {
                        ...node,
                        position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                        width: imageSize.width,
                        height: imageSize.height,
                        metadata: { ...node.metadata, ...imageMetadata(uploaded), imageTaskId: task.id, imageTaskClientRequestId: identity.clientRequestId || task.clientRequestId, primaryImageId: nodeId, errorDetails: undefined },
                    };
                }
                if (node.id === nodeId) {
                    return {
                        ...node,
                        position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                        width: imageSize.width,
                        height: imageSize.height,
                        metadata: { ...node.metadata, ...imageMetadata(uploaded), imageTaskId: task.id, imageTaskClientRequestId: identity.clientRequestId || task.clientRequestId, errorDetails: undefined },
                    };
                }
                return node;
            });
        });
    };
    const observeImageTask = async (nodeId: string, rootId: string, initialTask?: ImageGenerationTask, identity = taskIdentity(nodeId, "image")) => {
        const observationKey = JSON.stringify([identity.scope, nodeId, identity.taskId || initialTask?.id, identity.clientRequestId]);
        if (activeImageTaskNodeIds.has(observationKey) || !taskCurrent(identity, options.nodesRef.current, initialTask)) return;
        activeImageTaskNodeIds.add(observationKey);
        let task = initialTask;
        try {
            if (!task) {
                const taskID = identity.taskId;
                const clientRequestID = identity.clientRequestId;
                task = taskID ? await options.getImageTask(taskID) : clientRequestID ? await options.getImageTaskByClientRequest(clientRequestID) : undefined;
            }
            while (task && taskCurrent(identity, options.nodesRef.current, task)) {
                setImageTaskState(identity, task);
                if (task.status === "succeeded") {
                    await completeImageTaskNode(identity, rootId, task);
                    return;
                }
                if ((task.status === "failed" || task.status === "uncertain")) throw new Error(imageTaskError(task));
                await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000));
                if (!taskCurrent(identity, options.nodesRef.current, task)) return;
                task = await options.getImageTask(task.id);
            }
            if (!task) throw new Error("图片任务不存在");
        } catch (error) {
            const observedTask = task;
            const errorDetails = error instanceof Error ? error.message : "图片生成失败";
            options.setNodes((previous) => !taskCurrent(identity, previous, observedTask) ? previous : previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
        } finally {
            activeImageTaskNodeIds.delete(observationKey);
        }
    };
    const startImageTask = async (nodeId: string, rootId: string, create: (clientRequestId: string) => Promise<ImageGenerationTask>) => {
        const clientRequestId = options.createId();
        const identity: TaskIdentity = { scope: sessionScope(), nodeId, kind: "image", clientRequestId };
        options.setNodes((previous) =>
            sessionScope() !== identity.scope ? previous : previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, imageTaskClientRequestId: clientRequestId, imageTaskId: undefined, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)),
        );
        let task: ImageGenerationTask;
        try {
            task = await create(clientRequestId);
        } catch (error) {
            if (!taskCurrent(identity)) return;
            try {
                task = await options.getImageTaskByClientRequest(clientRequestId);
            } catch {
                if (!taskCurrent(identity)) return;
                const errorDetails = error instanceof Error ? error.message : "图片任务提交失败";
                options.setNodes((previous) => !taskCurrent(identity, previous) ? previous : previous.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node));
                throw error;
            }
        }
        if (!taskCurrent(identity, options.nodesRef.current, task)) return;
        if (task.status === "succeeded" || (task.status === "failed" || task.status === "uncertain")) {
            await observeImageTask(nodeId, rootId, task, identity);
            return;
        }
        setImageTaskState(identity, task);
        void observeImageTask(nodeId, rootId, task, identity);
    };
    const observeVideoTask = async (nodeId: string, initial?: VideoGenerationTask, identity = taskIdentity(nodeId, "video")) => {
        const observationKey = JSON.stringify([identity.scope, nodeId, identity.taskId || initial?.id, identity.clientRequestId]);
        if (activeVideoTaskNodeIds.has(observationKey) || !taskCurrent(identity, options.nodesRef.current, initial)) return;
        activeVideoTaskNodeIds.add(observationKey);
        const operation = beginVideoOperation(nodeId);
        const signal = operation.controller.signal;
        let task = initial;
        const current = (nodes = options.nodesRef.current, observedTask = task) => !signal.aborted && taskCurrent(identity, nodes, observedTask);
        try {
            const id = identity.taskId;
            const clientID = identity.clientRequestId;
            task =
                initial ||
                (id ? await queryVideo(() => (options.getVideoTask || getVideoTask)(id, signal), signal) : clientID ? await queryVideo(() => (options.getVideoTaskByClientRequest || getVideoTaskByClientRequest)(clientID, signal), signal) : undefined);
            while (task && current()) {
                const observedTask = task;
                const terminal = ["failed", "uncertain", "paused"].includes(task.status);
                const video = task.videos[0];
                if (task.status === "succeeded" && !video?.mediaId) throw new Error("视频任务完成但未返回媒体引用");
                options.setNodes((previous) =>
                    !current(previous, observedTask) ? previous : previous.map((node) =>
                        node.id === nodeId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      videoTaskId: observedTask.id,
                                      videoTaskClientRequestId: identity.clientRequestId,
                                      videoTaskStatus: observedTask.status,
                                      videoTaskProgress: observedTask.progress,
                                      status: terminal ? NODE_STATUS_ERROR : observedTask.status === "succeeded" ? NODE_STATUS_SUCCESS : NODE_STATUS_LOADING,
                                      errorDetails: terminal ? observedTask.error || (observedTask.status === "uncertain" ? "提交结果不确定，请勿重复生成" : "视频任务已暂停或失败") : undefined,
                                      ...(observedTask.status === "succeeded" ? { mediaId: video.mediaId, content: undefined, mimeType: "video/mp4", duration: video.duration, naturalWidth: video.width, naturalHeight: video.height } : {}),
                                  },
                              }
                            : node,
                    ),
                );
                if (terminal || task.status === "succeeded") return;
                await waitForVideo(signal, 12_000);
                if (!current()) return;
                const taskId = task.id;
                task = await queryVideo(() => (options.getVideoTask || getVideoTask)(taskId, signal), signal);
            }
        } catch (error) {
            const observedTask = task;
            if (current())
                options.setNodes((previous) => !current(previous, observedTask) ? previous : previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: error instanceof Error ? error.message : "读取视频任务失败" } } : node)));
        } finally {
            videoOperations.delete(operation);
            activeVideoTaskNodeIds.delete(observationKey);
        }
    };
    const startVideoTask = async (nodeId: string, config: AiConfig, prompt: string, references: ReferenceImage[], videos: string[]) => {
        const clientRequestId = options.createId();
        const identity: TaskIdentity = { scope: sessionScope(), nodeId, kind: "video", clientRequestId };
        options.setNodes((previous) => sessionScope() !== identity.scope ? previous : previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, videoTaskClientRequestId: clientRequestId, videoTaskId: undefined } } : node)));
        let task: VideoGenerationTask;
        try {
            task = await options.requestVideoGeneration(config, prompt, references, clientRequestId, videos);
        } catch (error) {
            if (!taskCurrent(identity)) return;
            if (error instanceof VideoRequestRejectedError) {
                options.setNodes((previous) => !taskCurrent(identity, previous) ? previous : previous.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, videoTaskClientRequestId: undefined, status: NODE_STATUS_ERROR, errorDetails: error.message } } : node)));
                throw error;
            }
            const operation = beginVideoOperation(nodeId);
            try {
                task = await queryVideo(() => (options.getVideoTaskByClientRequest || getVideoTaskByClientRequest)(clientRequestId, operation.controller.signal), operation.controller.signal);
            } catch {
                if (operation.controller.signal.aborted || !taskCurrent(identity)) return;
                const errorDetails = error instanceof Error ? error.message : "视频任务提交失败";
                options.setNodes((previous) => !taskCurrent(identity, previous) ? previous : previous.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node));
                throw error;
            } finally {
                videoOperations.delete(operation);
            }
        }
        if (!taskCurrent(identity, options.nodesRef.current, task)) return;
        if (["succeeded", "failed", "uncertain", "paused"].includes(task.status)) await observeVideoTask(nodeId, task, identity);
        else void observeVideoTask(nodeId, task, identity);
    };
    const resumePendingImageTasks = () => {
        options.nodesRef.current
            .filter((node) => node.type === CanvasNodeType.Video && node.metadata?.status === NODE_STATUS_LOADING && (node.metadata.videoTaskId || node.metadata.videoTaskClientRequestId))
            .forEach((node) => void observeVideoTask(node.id));
        options.nodesRef.current
            .filter((node) => node.type === CanvasNodeType.Image && node.metadata?.status === NODE_STATUS_LOADING && (node.metadata.imageTaskId || node.metadata.imageTaskClientRequestId))
            .forEach((node) => void observeImageTask(node.id, node.metadata?.batchRootId || node.id));
    };

    const generateAngleNode = async (node: CanvasNodeData, params: CanvasAngleParameters, source?: string) => {
        const scope = sessionScope();
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
        const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references, imageModelName(generationConfig));
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
            if (sessionScope() === scope) options.message.error(error instanceof Error ? error.message : "生成失败");
        } finally {
            if (sessionScope() === scope && runningNodeId === childId) setRunningNodeId(null);
        }
    };

    const generateNode = async (nodeId: string, mode: CanvasGenerationMode, prompt: string) => {
        const generationScope = options.getSessionScope?.() ?? options.sessionScope;
        const scopeValid = () => sessionScope() === generationScope;
        const sourceNode = options.nodesRef.current.find((node) => node.id === nodeId);
        const generationConfig = reconcileVideoConfig(buildGenerationConfig(options.effectiveConfig, sourceNode, options.defaultConfig), options.getVideoModelStatus?.());
        if (mode === "video" && !options.isAiConfigReady("video")) {
            options.openConfigDialog(true);
            return;
        }
        const generationContext = await options.hydrateGenerationContext(nodeId, prompt);
        if (!scopeValid()) return;
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
        if (mode === "video") {
            const videos = generationContext.referenceVideos || [];
            try {
                validateVideoGeneration(
                    generationConfig,
                    referenceImages,
                    videos.map((video) => video.mediaId || ""),
                );
                if (videos.some((video) => !video.mediaId) || videos.reduce((total, video) => total + (video.duration || 0), 0) > 15) throw new Error("参考视频必须上传完成，累计不超过 15 秒");
            } catch (error) {
                options.message.error(error instanceof Error ? error.message : "视频参数无效");
                return;
            }
        }
        setRunningNodeId(nodeId);
        let pendingChildIds: string[] = [];
        let submissionStarted = false;
        if (markSourceStatus) options.setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
        try {
            if (mode === "image") {
                const count = getGenerationCount(generationConfig.count);
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                const isEmptyImageNode = isImageNode && !hasCanvasImage(sourceNode);
                const generationMetadata = buildImageGenerationMetadata(referenceImages.length ? "edit" : "generation", generationConfig, count, referenceImages, imageModelName(generationConfig));
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
                const childNodes = childIds.map(
                    (id, index): CanvasNodeData => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: { x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36), y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + 36) },
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }),
                );
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
                submissionStarted = true;
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
                if (failures.length && scopeValid()) {
                    options.message.error(failures.length === targetIds.length ? "全部图片生成失败" : "部分图片生成失败");
                }
                return;
            }

            if (mode === "video") {
                const spec = nodeSizeFromRatio(generationConfig.videoSize || "", NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content && !sourceNode.metadata?.mediaId;
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
                        videoSize: generationConfig.videoSize,
                        generateAudio: generationConfig.generateAudio,
                        videoProviderId: generationConfig.videoProviderId,
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
                const videoInputs = generationContext.referenceVideos || [];
                if (videoInputs.length > 3 || videoInputs.some((video) => !video.mediaId) || videoInputs.reduce((total, video) => total + (video.duration || 0), 0) > 15) throw new Error("参考视频必须上传完成，最多 3 个且累计不超过 15 秒");
                submissionStarted = true;
                await startVideoTask(
                    videoId,
                    generationConfig,
                    effectivePrompt,
                    referenceImages,
                    videoInputs.map((video) => video.mediaId!),
                );
                return;
            }

            return;
        } catch (error) {
            if (!scopeValid()) return;
            const errorDetails = error instanceof Error ? error.message : "生成失败";
            options.message.error(errorDetails);
            if (!submissionStarted) options.setNodes((prev) =>
                !scopeValid() ? prev : prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
            );
        } finally {
            if (scopeValid() && runningNodeId === nodeId) setRunningNodeId(null);
        }
    };

    const retryNode = async (node: CanvasNodeData) => {
        const identity = taskIdentity(node.id, node.type === CanvasNodeType.Video ? "video" : "image");
        const current = (nodes = options.nodesRef.current) => node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video
            ? taskCurrent(identity, nodes)
            : sessionScope() === identity.scope && nodes.some((item) => item.id === node.id && item.type === node.type);
        if (!current()) return;
        if (node.type === CanvasNodeType.Image && node.metadata?.status === NODE_STATUS_ERROR && (node.metadata.imageTaskId || node.metadata.imageTaskClientRequestId)) {
            try {
                const task = node.metadata.imageTaskId
                    ? await options.getImageTask(node.metadata.imageTaskId)
                    : await options.getImageTaskByClientRequest(node.metadata.imageTaskClientRequestId!);
                if (!current()) return;
                if (task.status !== "failed") {
                    await observeImageTask(node.id, node.metadata.batchRootId || node.id, task, identity);
                    return;
                }
            } catch (error) {
                if (current()) options.message.error(error instanceof Error ? error.message : "查询原图片任务失败，请稍后重试");
                return;
            }
        }
        if (node.type === CanvasNodeType.Video && (node.metadata?.videoTaskId || node.metadata?.videoTaskClientRequestId)) {
            const operation = beginVideoOperation(node.id);
            const signal = operation.controller.signal;
            try {
                let task = node.metadata.videoTaskId
                    ? await queryVideo(() => (options.getVideoTask || getVideoTask)(node.metadata!.videoTaskId!, signal), signal)
                    : await queryVideo(() => (options.getVideoTaskByClientRequest || getVideoTaskByClientRequest)(node.metadata!.videoTaskClientRequestId!, signal), signal);
                if (signal.aborted || !current()) return;
                if (task.status === "paused") task = await (options.resumeVideoTask || resumeVideoTask)(task.id, signal);
                if (!signal.aborted && current()) void observeVideoTask(node.id, task, identity);
            } catch (error) {
                if (!signal.aborted && current()) options.message.error(error instanceof Error ? error.message : "恢复视频任务失败");
            } finally {
                videoOperations.delete(operation);
            }
            return;
        }
        if (node.type === CanvasNodeType.Text) {
            options.message.warning("文本节点不支持重新生成");
            return;
        }
        const sourceNode = findRetrySourceNode(node.id, options.nodesRef.current, options.connectionsRef.current) || node;
        const batchRoot = node.metadata?.batchRootId ? options.nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
        const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...withoutLegacyModel(batchRoot?.metadata), ...withoutLegacyModel(node.metadata) } : undefined;
        const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
        const generationConfig = {
            ...reconcileVideoConfig(buildGenerationConfig(options.effectiveConfig, hasSavedImageMetadata && savedImageMetadata ? { ...node, metadata: savedImageMetadata } : sourceNode, options.defaultConfig), options.getVideoModelStatus?.()),
            count: "1",
        };
        const context = hasSavedImageMetadata ? null : await options.hydrateGenerationContext(sourceNode.id, sourceNode.metadata?.prompt || node.metadata?.prompt || "");
        if (!current()) return;
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
            hasSavedImageMetadata && savedImageMetadata
                ? await resolveMetadataReferences(savedImageMetadata)
                : useReferenceImages
                  ? context?.referenceImages.length
                      ? context.referenceImages
                      : sourceNodeReferenceImages(batchRoot || sourceNode, options.maskResources)
                  : [];
        if (!current()) return;
        if (useReferenceImages && !retryReferenceImages) {
            missingReference(node.id);
            return;
        }
        setRunningNodeId(node.id);
        options.setNodes((prev) => !current(prev) ? prev : prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...withoutLegacyModel(item.metadata), status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
        let submissionStarted = false;
        try {
            if (node.type === CanvasNodeType.Video) {
                submissionStarted = true;
                await startVideoTask(
                    node.id,
                    generationConfig,
                    prompt,
                    retryReferenceImages || [],
                    (context?.referenceVideos || []).map((video) => {
                        if (!video.mediaId) throw new Error("请先上传参考视频");
                        return video.mediaId;
                    }),
                );
                return;
            }
            const generationMetadata = savedImageMetadata?.generationType
                ? {
                      ...buildImageGenerationMetadata(savedImageMetadata.generationType, generationConfig, savedImageMetadata.count || 1, [], savedImageMetadata.imageProviderName),
                      references: savedImageMetadata.references,
                      ...(savedImageMetadata.maskId ? { maskId: savedImageMetadata.maskId, sourceNodeId: savedImageMetadata.sourceNodeId } : {}),
                  }
                : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryReferenceImages || [], imageModelName(generationConfig));
            options.setNodes((prev) => !current(prev) ? prev : prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Image, metadata: { ...withoutLegacyModel(item.metadata), prompt, ...generationMetadata } } : item)));
            submissionStarted = true;
            await startImageTask(node.id, node.metadata?.batchRootId || node.id, (clientRequestId) =>
                useReferenceImages ? options.requestEdit(generationConfig, prompt, retryReferenceImages || [], clientRequestId) : options.requestGeneration(generationConfig, prompt, clientRequestId),
            );
        } catch (error) {
            if (sessionScope() !== identity.scope) return;
            const errorDetails = error instanceof Error ? error.message : "生成失败";
            options.message.error(errorDetails);
            if (!submissionStarted) options.setNodes((prev) => !current(prev) ? prev : prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
        } finally {
            if (sessionScope() === identity.scope && runningNodeId === node.id) setRunningNodeId(null);
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
                resolution: options.effectiveConfig.resolution,
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
        stopVideoObservations,
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
    useEffect(() => {
        controller.stopVideoObservations();
    });
    useEffect(() => {
        const stop = () => controller.stopVideoObservations(true);
        const restore = (event: PageTransitionEvent) => {
            if (event.persisted) controller.resumePendingImageTasks();
        };
        window.addEventListener("pagehide", stop);
        window.addEventListener("pageshow", restore);
        return () => {
            window.removeEventListener("pagehide", stop);
            window.removeEventListener("pageshow", restore);
            stop();
        };
    }, [controller]);
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
