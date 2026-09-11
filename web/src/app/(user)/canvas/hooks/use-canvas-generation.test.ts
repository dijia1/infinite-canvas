import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasGenerationController } from "./use-canvas-generation.ts";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types.ts";
import type { AiConfig } from "@/lib/ai-config";
import type { ImageGenerationTask } from "@/services/api/image";
import type { VideoGenerationTask } from "@/services/api/video";
import type { StoredCanvasImage } from "@/services/canvas-image-hydration";

type Ref<T> = { current: T };

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

const config: AiConfig = {
    videoSeconds: "6",
    videoSize: "16:9",
    vquality: "medium",
    quality: "auto",
    size: "1:1",
    resolution: "1k",
    outputFormat: "jpeg",
    count: "1",
};

function ref<T>(current: T): Ref<T> {
    return { current };
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

function node(id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 340, height: 240, metadata };
}

function completedTask(id: string, mediaId: string): ImageGenerationTask {
    return { id: `task-${id}`, clientRequestId: `client-${id}`, status: "succeeded", progress: 100, images: [{ id, dataUrl: `data:image/png;base64,${id}`, mediaId }] };
}

function setup(initialNodes: CanvasNodeData[], initialConnections: CanvasConnection[] = [], overrides: Record<string, unknown> = {}) {
    const nodesRef = ref(initialNodes);
    const connectionsRef = ref(initialConnections);
    const calls = { generation: 0, edit: 0, video: 0, configDialog: 0, readiness: [] as string[], errors: [] as string[], warnings: [] as string[] };
    let sequence = 0;
    const controller = createCanvasGenerationController({
        nodesRef,
        connectionsRef,
        effectiveConfig: config,
        getVideoModelStatus: () => ({
            videoModels: [
                {
                    id: "video-test",
                    name: "Video",
                    type: "test",
                    videoRequestSchema: {
                        resolutions: [{ value: "medium", label: "Medium", price: "0.1" }],
                        aspectRatios: ["16:9"],
                        minDuration: 4,
                        maxDuration: 15,
                        defaultDuration: 5,
                        maxReferenceImages: 9,
                        maxReferenceVideos: 3,
                        maxReferenceVideoDuration: 15,
                    },
                },
            ],
        }),
        defaultConfig: config,
        isAiConfigReady: (capability) => {
            calls.readiness.push(typeof capability === "string" ? capability : "config");
            return true;
        },
        openConfigDialog: () => calls.configDialog++,
        message: { error: (text: string) => calls.errors.push(text), warning: (text: string) => calls.warnings.push(text) },
        setNodes: (next) => {
            nodesRef.current = typeof next === "function" ? next(nodesRef.current) : next;
        },
        setConnections: (next) => {
            connectionsRef.current = typeof next === "function" ? next(connectionsRef.current) : next;
        },
        setSelectedNodeIds: () => undefined,
        setSelectedConnectionId: () => undefined,
        setDialogNodeId: () => undefined,
        setAngleNodeId: () => undefined,
        createId: () => `id-${++sequence}`,
        createConfigNode: (position, metadata) => ({ id: `config-${++sequence}`, type: CanvasNodeType.Config, title: "生成配置", position, width: 340, height: 240, metadata }),
        requestGeneration: async () => {
            calls.generation++;
            return completedTask(`image-${calls.generation}`, `media-${calls.generation}`);
        },
        requestEdit: async () => {
            calls.edit++;
            return completedTask(`edit-${calls.edit}`, `edit-media-${calls.edit}`);
        },
        getImageTask: async () => {
            throw new Error("unexpected task polling");
        },
        getImageTaskByClientRequest: async () => {
            throw new Error("unexpected task polling");
        },
        requestVideoGeneration: async () => {
            calls.video++;
            return { id: "video-task", status: "succeeded", progress: 100, resultMediaIds: ["video-media"], videos: [{ mediaId: "video-media", url: "https://example.com/video.mp4" }] };
        },
        uploadImage: async (_input, mediaId) => ({ url: `blob:${mediaId}`, storageKey: `media:${mediaId}`, mediaId, width: 512, height: 512, bytes: 12, mimeType: "image/png" }),
        uploadMediaFile: async () => ({ url: "blob:video", storageKey: "video:1", bytes: 12, mimeType: "video/mp4", width: 1280, height: 720 }),
        hydrateGenerationContext: async (_nodeId, prompt) => ({ prompt, referenceImages: [], textCount: 0, imageCount: 0 }),
        resolveMetadataReferences: async (metadata) => (metadata.references?.length ? metadata.references.map((dataUrl, index) => ({ id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl })) : null),
        ...overrides,
    });
    return { controller, nodesRef, connectionsRef, calls };
}

test("creates a batch root and three children with three parallel single-image requests", async () => {
    const source = node("source", CanvasNodeType.Config, { count: 3 });
    const { controller, nodesRef, connectionsRef, calls } = setup([source]);

    await controller.generateNode("source", "image", "a forest");

    assert.equal(calls.generation, 3);
    const root = nodesRef.current.find((item) => item.metadata?.isBatchRoot);
    assert.ok(root);
    assert.equal(root.metadata?.batchChildIds?.length, 3);
    assert.equal(nodesRef.current.filter((item) => item.metadata?.batchRootId === root.id).length, 3);
    assert.equal(connectionsRef.current.filter((item) => item.fromNodeId === root.id).length, 3);
    assert.equal(root.metadata?.primaryImageId, root.metadata?.batchChildIds?.[0]);
    assert.equal("model" in (root.metadata || {}), false);
    assert.equal(
        nodesRef.current.filter((item) => item.metadata?.batchRootId === root.id).every((item) => !("model" in (item.metadata || {}))),
        true,
    );
});

test("snapshots one exact image model name and isolated provider options across a batch", async () => {
    const source = node("source", CanvasNodeType.Config, { count: 2 });
    const providerOptions = { style: { preset: "photo" }, steps: [20, 28] };
    const pending = [deferred<ImageGenerationTask>(), deferred<ImageGenerationTask>()];
    const requestedProviderIds: Array<string | undefined> = [];
    let requestIndex = 0;
    const { controller, nodesRef } = setup([source], [], {
        effectiveConfig: {
            ...config,
            imageProviderId: "image-model-v1",
            imageProviderType: "image-provider",
            providerOptions,
        },
        getImageModelName: (providerId: string | undefined) => {
            requestedProviderIds.push(providerId);
            return providerId === "image-model-v1" ? "Image Model V1" : undefined;
        },
        requestGeneration: () => pending[requestIndex++]!.promise,
    });

    const generation = controller.generateNode(source.id, "image", "a forest");
    await Promise.resolve();
    await Promise.resolve();

    const generated = nodesRef.current.filter((item) => item.type === CanvasNodeType.Image);
    assert.deepEqual(requestedProviderIds, ["image-model-v1"]);
    assert.equal(generated.length, 3);
    assert.equal(generated.every((item) => item.metadata?.imageProviderName === "Image Model V1"), true);

    providerOptions.style.preset = "illustration";
    providerOptions.steps[0] = 4;
    assert.equal(generated.every((item) => item.metadata?.providerOptions && (item.metadata.providerOptions.style as { preset: string }).preset === "photo"), true);
    assert.equal(generated.every((item) => item.metadata?.providerOptions && (item.metadata.providerOptions.steps as number[])[0] === 20), true);

    pending.forEach((task, index) => task.resolve(completedTask(`batch-${index}`, `batch-media-${index}`)));
    await generation;
});

test("reusing a historical empty image removes its obsolete model metadata", async () => {
    const source = JSON.parse('{"id":"source","type":"image","title":"source","position":{"x":0,"y":0},"width":340,"height":240,"metadata":{"model":"historical-model","freeResize":true}}') as CanvasNodeData;
    const { controller, nodesRef } = setup([source]);

    await controller.generateNode(source.id, "image", "a forest");

    const result = nodesRef.current.find((item) => item.id === source.id);
    assert.equal("model" in (result?.metadata || {}), false);
    assert.equal(result?.metadata?.freeResize, true);
});

test("dispatches every batch image request before completion and uses one image per request", async () => {
    const source = node("source", CanvasNodeType.Config, { count: 3 });
    const requests: AiConfig[] = [];
    const pending = Array.from({ length: 3 }, () => deferred<ImageGenerationTask>());
    const { controller } = setup([source], [], {
        requestGeneration: (requestConfig: AiConfig) => {
            requests.push(requestConfig);
            return pending[requests.length - 1].promise;
        },
    });

    const generation = controller.generateNode("source", "image", "a forest");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(requests.length, 3);
    assert.deepEqual(
        requests.map((request) => request.count),
        ["1", "1", "1"],
    );
    assert.equal(
        requests.every((request) => !("model" in request)),
        true,
    );

    pending.forEach((request, index) => request.resolve(completedTask(`image-${index}`, `media-${index}`)));
    await generation;
});

test("uses image edit only when references exist", async () => {
    const reference = node("reference", CanvasNodeType.Image, { content: "data:image/png;base64,reference" });
    const source = node("source", CanvasNodeType.Config);
    const { controller, calls } = setup([reference, source], [{ id: "connection", fromNodeId: "reference", toNodeId: "source" }], {
        hydrateGenerationContext: async (_nodeId: string, prompt: string) => ({
            prompt,
            referenceImages: [{ id: reference.id, name: "reference.png", type: "image/png", dataUrl: reference.metadata!.content! }],
            textCount: 0,
            imageCount: 1,
        }),
    });

    await controller.generateNode("source", "image", "change it");

    assert.equal(calls.edit, 1);
    assert.equal(calls.generation, 0);
    assert.deepEqual(calls.readiness, ["imageEdit"]);
});

test("uses image readiness when generating without references", async () => {
    const source = node("source", CanvasNodeType.Config);
    const { controller, calls } = setup([source]);

    await controller.generateNode("source", "image", "a forest");

    assert.deepEqual(calls.readiness, ["image"]);
});

test("uses video readiness for video generation", async () => {
    const source = node("source", CanvasNodeType.Video);
    const { controller, calls } = setup([source]);

    await controller.generateNode("source", "video", "a waterfall");

    assert.deepEqual(calls.readiness, ["video"]);
});

test("keeps the submitted prompt on an existing image after editing", async () => {
    const source = node("source", CanvasNodeType.Image, { content: "data:image/png;base64,source" });
    const { controller, nodesRef } = setup([source], [], {
        hydrateGenerationContext: async (_nodeId: string, prompt: string) => ({
            prompt,
            referenceImages: [{ id: source.id, name: "source.png", type: "image/png", dataUrl: source.metadata!.content! }],
            textCount: 0,
            imageCount: 1,
        }),
    });

    await controller.generateNode("source", "image", "将图片修改为水彩风格");

    assert.equal(nodesRef.current.find((item) => item.id === source.id)?.metadata?.prompt, "将图片修改为水彩风格");
});

test("submits an ordered masked main image with additional reference images", async () => {
    const source = node("source", CanvasNodeType.Config);
    const maskedReference = { id: "masked", name: "masked.png", type: "image/png", dataUrl: "data:image/png;base64,masked", mask: { version: 1 as const, strokes: [{ id: "stroke", tool: "paint" as const, radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }] } };
    const extraReference = { id: "extra", name: "extra.png", type: "image/png", dataUrl: "data:image/png;base64,extra" };
    const { controller, nodesRef, calls } = setup([source], [], {
        hydrateGenerationContext: async (_nodeId: string, prompt: string) => ({ prompt, referenceImages: [maskedReference, extraReference], textCount: 0, imageCount: 2 }),
    });

    await controller.generateNode("source", "image", "只编辑遮罩区域");

    assert.equal(calls.edit, 1);
    assert.equal(calls.generation, 0);
    assert.deepEqual(calls.errors, []);
    assert.equal(nodesRef.current.filter((item) => item.type === CanvasNodeType.Image).length, 1);
});

test("rejects a masked image when it is not the first ordered reference", async () => {
    const source = node("source", CanvasNodeType.Config);
    const primaryReference = { id: "primary", name: "primary.png", type: "image/png", dataUrl: "data:image/png;base64,primary" };
    const maskedReference = { id: "masked", name: "masked.png", type: "image/png", dataUrl: "data:image/png;base64,masked", mask: { version: 1 as const, strokes: [{ id: "stroke", tool: "paint" as const, radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }] } };
    const { controller, nodesRef, calls } = setup([source], [], {
        hydrateGenerationContext: async (_nodeId: string, prompt: string) => ({ prompt, referenceImages: [primaryReference, maskedReference], textCount: 0, imageCount: 2 }),
    });

    await controller.generateNode("source", "image", "只编辑遮罩区域");

    assert.equal(calls.edit, 0);
    assert.equal(calls.generation, 0);
    assert.deepEqual(calls.errors, ["带遮罩的主图必须位于第一张参考图"]);
    assert.equal(nodesRef.current.length, 1);
});

test("preserves successful batch children when another child fails", async () => {
    const source = node("source", CanvasNodeType.Config, { count: 3 });
    let attempts = 0;
    const { controller, nodesRef, calls } = setup([source], [], {
        requestGeneration: async () => {
            attempts++;
            calls.generation++;
            if (attempts === 2) throw new Error("provider failed");
            return completedTask(`image-${attempts}`, `media-${attempts}`);
        },
    });

    await controller.generateNode("source", "image", "a forest");

    const children = nodesRef.current.filter((item) => item.metadata?.batchRootId);
    assert.equal(children.filter((item) => item.metadata?.status === "success").length, 2);
    assert.equal(children.filter((item) => item.metadata?.status === "error").length, 1);
    assert.deepEqual(calls.errors, ["部分图片生成失败"]);
});

test("blocks invalid provider configuration before adding generation nodes", async () => {
    const source = node("source", CanvasNodeType.Config);
    const { controller, nodesRef, calls } = setup([source], [], { isAiConfigReady: () => false });

    await controller.generateNode("source", "image", "a forest");

    assert.equal(calls.configDialog, 1);
    assert.equal(nodesRef.current.length, 1);
    assert.equal(calls.generation, 0);
});

test("angle generation always uses edit and creates a connected child", async () => {
    const source = node("source", CanvasNodeType.Image, { content: "data:image/png;base64,source" });
    const { controller, nodesRef, connectionsRef, calls } = setup([source], [], {
        effectiveConfig: {
            ...config,
            imageProviderId: "image-model-v1",
            imageProviderType: "image-provider",
        },
        getImageModelName: (providerId: string) => (providerId === "image-model-v1" ? "Image Model V1" : undefined),
    });

    await controller.generateAngleNode(source, { horizontalAngle: 30, pitchAngle: 0, cameraDistance: 1.5, wideAngle: false });

    assert.equal(calls.edit, 1);
    assert.equal(calls.generation, 0);
    assert.equal(nodesRef.current.length, 2);
    assert.equal(connectionsRef.current.length, 1);
    assert.equal(nodesRef.current[1]?.metadata?.imageProviderName, "Image Model V1");
});

test("retries persisted image metadata and marks a missing reference as an error", async () => {
    const retryable = JSON.parse(
        '{"id":"retry","type":"image","title":"retry","position":{"x":0,"y":0},"width":340,"height":240,"metadata":{"prompt":"retry me","generationType":"edit","model":"historical-model","size":"1:1","resolution":"1k","quality":"auto","count":3,"references":["data:image/png;base64,reference"]}}',
    ) as CanvasNodeData;
    const { controller, calls } = setup([retryable]);

    await controller.retryNode(retryable);
    assert.equal(calls.edit, 1);
    assert.deepEqual(calls.readiness, ["imageEdit"]);

    const missing = node("missing", CanvasNodeType.Image, { prompt: "retry me", generationType: "edit", references: ["image:gone"] });
    const failed = setup([missing], [], { resolveMetadataReferences: async () => null });
    await failed.controller.retryNode(missing);
    assert.equal(failed.nodesRef.current[0].metadata?.status, "error");
    assert.equal(failed.nodesRef.current[0].metadata?.errorDetails, "参考图片已丢失，无法继续重试");
});

test("retries persisted media references through the stored-image resolver", async () => {
    const retryable = node("retry-media", CanvasNodeType.Image, {
        prompt: "retry media",
        generationType: "edit",
        references: ["image:temporary-reference", "media:persistent-reference:v1:original"],
    });
    const resolvedKeys: string[] = [];
    let submittedReferences: Array<{ dataUrl: string; storageKey?: string }> = [];
    const { controller, calls } = setup([retryable], [], {
        resolveMetadataReferences: undefined,
        resolveStoredImageReference: async (storageKey: string) => {
            resolvedKeys.push(storageKey);
            return `blob:${storageKey}`;
        },
        requestEdit: async (_config: AiConfig, _prompt: string, references: Array<{ dataUrl: string; storageKey?: string }>) => {
            calls.edit++;
            submittedReferences = references;
            return completedTask("retry-media", "retry-media-result");
        },
    });

    await controller.retryNode(retryable);

    assert.deepEqual(resolvedKeys, ["image:temporary-reference", "media:persistent-reference:v1:original"]);
    assert.deepEqual(submittedReferences, [
        { id: "0", name: "reference-0.png", type: "image/png", dataUrl: "blob:image:temporary-reference", storageKey: "image:temporary-reference" },
        { id: "1", name: "reference-1.png", type: "image/png", dataUrl: "blob:media:persistent-reference:v1:original", storageKey: "media:persistent-reference:v1:original" },
    ]);
    assert.equal(calls.edit, 1);
});

test("retries with the mask snapshot saved by the original generation instead of the source node's current mask", async () => {
    const submittedMask = { version: 1 as const, strokes: [{ id: "submitted", tool: "paint" as const, radius: 0.1, points: [{ x: 0.2, y: 0.2 }] }] };
    const source = node("source", CanvasNodeType.Image, { mediaId: "media-source", maskId: "mask-edited-later" });
    const generated = node("generated", CanvasNodeType.Image, {
        prompt: "retry this edit",
        generationType: "edit",
        references: ["media:media-source:v1:original"],
        maskId: "mask-at-submission",
        sourceNodeId: source.id,
    });
    let resolvedMaskID = "";
    let submittedMaskFromRetry: unknown;
    const { controller, calls } = setup([source, generated], [], {
        resolveMetadataReferences: undefined,
        resolveStoredImageReference: async () => "blob:source",
        resolveMask: (maskId: string) => {
            resolvedMaskID = maskId;
            return submittedMask;
        },
        requestEdit: async (_config: AiConfig, _prompt: string, references: Array<{ mask?: unknown }>) => {
            calls.edit++;
            submittedMaskFromRetry = references[0]?.mask;
            return completedTask("retried", "media-retried");
        },
    });

    await controller.retryNode(generated);

    assert.equal(resolvedMaskID, "mask-at-submission");
    assert.deepEqual(submittedMaskFromRetry, submittedMask);
    assert.equal(calls.edit, 1);
});

test("retries historical batch metadata without copying its obsolete model", async () => {
    const root = JSON.parse(
        '{"id":"root","type":"image","title":"root","position":{"x":0,"y":0},"width":340,"height":240,"metadata":{"prompt":"retry this batch","generationType":"edit","model":"root-model","size":"16:9","resolution":"2k","quality":"high","count":3,"references":["data:image/png;base64,reference"],"isBatchRoot":true,"batchChildIds":["child-a","child-b","child-c"],"primaryImageId":"child-a"}}',
    ) as CanvasNodeData;
    const child = node("child-b", CanvasNodeType.Image, { batchRootId: "root", status: "error" });
    const rootMetadataBefore = { ...root.metadata };
    const editRequests: AiConfig[] = [];
    const { controller, nodesRef } = setup([root, child], [], {
        requestEdit: async (requestConfig: AiConfig) => {
            editRequests.push(requestConfig);
            return completedTask("retry-image", "retry-media");
        },
    });

    await controller.retryNode(child);

    assert.deepEqual(
        editRequests.map((request) => ({ size: request.size, resolution: request.resolution, quality: request.quality, count: request.count })),
        [{ size: "16:9", resolution: "2k", quality: "high", count: "1" }],
    );
    assert.equal(
        editRequests.every((request) => !("model" in request)),
        true,
    );
    assert.equal(nodesRef.current.length, 2);
    assert.deepEqual(nodesRef.current.find((item) => item.id === "root")?.metadata, rootMetadataBefore);
    const retriedChild = nodesRef.current.find((item) => item.id === "child-b");
    assert.equal(retriedChild?.metadata?.batchRootId, "root");
    assert.equal(retriedChild?.metadata?.status, "success");
    assert.equal("model" in (retriedChild?.metadata || {}), false);
});

test("retry preserves the original image model name instead of resolving the current catalog", async () => {
    const retryable = node("retry", CanvasNodeType.Image, {
        prompt: "retry this image",
        generationType: "generation",
        imageProviderId: "image-model-v1",
        imageProviderName: "Image Model Before Rename",
        imageProviderType: "image-provider",
        outputFormat: "jpeg",
        background: "transparent",
        providerOptions: { style: { preset: "photo" } },
        status: "error",
    });
    let nameLookups = 0;
    const { controller, nodesRef } = setup([retryable], [], {
        getImageModelName: () => {
            nameLookups++;
            return "Image Model After Rename";
        },
        requestGeneration: async (requestConfig: AiConfig) => {
            ((requestConfig.providerOptions?.style as { preset: string })).preset = "illustration";
            return completedTask("retried", "retried-media");
        },
    });

    await controller.retryNode(retryable);

    assert.equal(nameLookups, 0);
    assert.equal(nodesRef.current[0]?.metadata?.imageProviderName, "Image Model Before Rename");
    assert.equal(nodesRef.current[0]?.metadata?.outputFormat, "png");
    assert.equal(nodesRef.current[0]?.metadata?.background, "transparent");
    assert.deepEqual(nodesRef.current[0]?.metadata?.providerOptions, { style: { preset: "photo" } });
});

test("restores an in-flight image task from its persisted client request ID", async () => {
    const pending = node("pending", CanvasNodeType.Image, {
        status: "loading",
        imageTaskClientRequestId: "client-refresh",
        imageProviderId: "image-model-v1",
        imageProviderName: "Image Model V1",
        providerOptions: { style: { preset: "photo" } },
    });
    let taskLookups = 0;
    const { controller, nodesRef } = setup([pending], [], {
        getImageTask: async () => {
            taskLookups++;
            return completedTask("unexpected", "unexpected");
        },
        getImageTaskByClientRequest: async (clientRequestId: string) => {
            assert.equal(clientRequestId, "client-refresh");
            return { ...completedTask("restored", "media-restored"), clientRequestId };
        },
    });

    controller.resumePendingImageTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(taskLookups, 0);
    assert.equal(nodesRef.current[0].metadata?.status, "success");
    assert.equal(nodesRef.current[0].metadata?.mediaId, "media-restored");
    assert.equal(nodesRef.current[0].metadata?.imageTaskId, "task-restored");
    assert.equal(nodesRef.current[0].metadata?.imageProviderName, "Image Model V1");
    assert.deepEqual(nodesRef.current[0].metadata?.providerOptions, { style: { preset: "photo" } });
});

test("recovers a task by client request ID when the create response is lost", async () => {
    const source = node("source", CanvasNodeType.Config);
    let recoveredClientRequestID = "";
    const { controller, nodesRef } = setup([source], [], {
        requestGeneration: async () => {
            throw new Error("网络连接中断");
        },
        getImageTaskByClientRequest: async (clientRequestId: string) => {
            recoveredClientRequestID = clientRequestId;
            return { ...completedTask("recovered-create", "media-recovered-create"), clientRequestId };
        },
    });

    await controller.generateNode("source", "image", "a forest");

    const image = nodesRef.current.find((item) => item.type === CanvasNodeType.Image);
    assert.ok(recoveredClientRequestID);
    assert.equal(image?.metadata?.status, "success");
    assert.equal(image?.metadata?.mediaId, "media-recovered-create");
});

test("routes video generation through the video service", async () => {
    const source = node("source", CanvasNodeType.Config, { generationMode: "video" });
    const { controller, nodesRef, calls } = setup([source]);

    await controller.generateNode("source", "video", "make it move");

    assert.equal(calls.video, 1);
    const video = nodesRef.current.find((item) => item.type === CanvasNodeType.Video);
    assert.equal(video?.metadata?.status, "success");
    assert.equal("model" in (video?.metadata || {}), false);
});

test("text-to-image creates and opens an image config node instead of calling text generation", () => {
    const source = node("source", CanvasNodeType.Text, { content: "a composed prompt" });
    const { controller, nodesRef, connectionsRef } = setup([source]);

    controller.generateImageFromTextNode(source);

    const configNode = nodesRef.current.find((item) => item.type === CanvasNodeType.Config);
    assert.ok(configNode);
    assert.equal("model" in (configNode.metadata || {}), false);
    assert.deepEqual(
        connectionsRef.current.map(({ fromNodeId, toNodeId }) => ({ fromNodeId, toNodeId })),
        [{ fromNodeId: "source", toNodeId: configNode.id }],
    );
});

test("editing a media-only image preserves the source and creates a result node", async () => {
    const source = node("remote-source", CanvasNodeType.Image, { mediaId: "original-media" });
    const { controller, nodesRef } = setup([source]);
    await controller.generateNode(source.id, "image", "change the style");
    assert.equal(nodesRef.current.find((item) => item.id === source.id)?.metadata?.mediaId, "original-media");
    assert.equal(nodesRef.current.find((item) => item.id === source.id)?.metadata?.content, undefined);
    assert.ok(nodesRef.current.some((item) => item.id !== source.id && item.type === CanvasNodeType.Image));
});

test("video completion preserves stable media only and never uploads generated bytes", async () => {
    const { controller, nodesRef } = setup([node("source", CanvasNodeType.Config)], [], {
        uploadMediaFile: async () => {
            throw new Error("must not upload generated video");
        },
    });
    await controller.generateNode("source", "video", "dance");
    const result = nodesRef.current.find((item) => item.type === CanvasNodeType.Video)!;
    assert.equal(result.metadata?.mediaId, "video-media");
    assert.equal(result.metadata?.content, undefined);
    assert.equal(result.metadata?.videoTaskId, "video-task");
});
test("video create result cannot cross A B A scope generations", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
        finish = resolve;
    });
    let scope = "A:1";
    const { controller, nodesRef } = setup([node("source", CanvasNodeType.Config)], [], { getSessionScope: () => scope, requestVideoGeneration: () => pending });
    const generation = controller.generateNode("source", "video", "dance");
    await Promise.resolve();
    scope = "B:2";
    scope = "A:3";
    const replacement = [node("new-session", CanvasNodeType.Text)];
    nodesRef.current = replacement;
    finish({ id: "old", status: "succeeded", progress: 100, resultMediaIds: ["old-media"], videos: [{ mediaId: "old-media", url: "https://example.com/old.mp4" }] });
    await generation;
    assert.equal(nodesRef.current, replacement);
});
test("video restores task using client request id without resubmitting", async () => {
    let done!: () => void;
    const called = new Promise<void>((resolve) => {
        done = resolve;
    });
    const pending = node("video", CanvasNodeType.Video, { status: "loading", videoTaskClientRequestId: "client" });
    const { controller, nodesRef, calls } = setup([pending], [], {
        getVideoTaskByClientRequest: async (id: string) => {
            assert.equal(id, "client");
            done();
            return { id: "restored", status: "succeeded", progress: 100, resultMediaIds: ["restored-media"], videos: [{ mediaId: "restored-media", url: "https://example.com/v.mp4" }] };
        },
    });
    controller.resumePendingImageTasks();
    await called;
    await Promise.resolve();
    assert.equal(calls.video, 0);
    assert.equal(nodesRef.current[0].metadata?.mediaId, "restored-media");
});
test("video paused task retries resume same task without a new generation", async () => {
    let resumed = 0;
    const source = node("video", CanvasNodeType.Video, { status: "error", videoTaskId: "existing", videoTaskStatus: "paused" });
    const { controller, calls, nodesRef } = setup([source], [], {
        getVideoTask: async () => ({ id: "existing", status: "paused", progress: 0, resultMediaIds: [], videos: [] }),
        resumeVideoTask: async (id: string) => {
            resumed++;
            assert.equal(id, "existing");
            return { id, status: "succeeded", progress: 100, resultMediaIds: ["media"], videos: [{ mediaId: "media", url: "https://example.com/v.mp4" }] };
        },
    });
    await controller.retryNode(source);
    assert.equal(resumed, 1);
    assert.equal(calls.video, 0);
    assert.equal(nodesRef.current[0].metadata?.mediaId, "media");
});
test("video observation waits twelve seconds between local task queries", async () => {
    const original = globalThis.setTimeout;
    const waits: { delay: number; run: () => void }[] = [];
    let queries = 0;
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
        waits.push({ delay, run: callback });
        return 1;
    }) as unknown as typeof setTimeout;
    try {
        const { controller, nodesRef } = setup([node("source", CanvasNodeType.Config)], [], {
            requestVideoGeneration: async () => ({ id: "poll", status: "running", progress: 0, videos: [], resultMediaIds: [] }),
            getVideoTask: async () => {
                queries++;
                return { id: "poll", status: "succeeded", progress: 100, resultMediaIds: ["media"], videos: [{ mediaId: "media", url: "https://example.com/v.mp4" }] };
            },
        });
        await controller.generateNode("source", "video", "dance");
        assert.equal(queries, 0);
        assert.equal(waits.length, 1);
        assert.equal(waits[0].delay, 12000);
        waits[0].run();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(queries, 1);
        assert.equal(nodesRef.current.find((item) => item.type === CanvasNodeType.Video)?.metadata?.mediaId, "media");
    } finally {
        globalThis.setTimeout = original;
    }
});
test("explicit rejected video request remains retryable while ambiguous submission retains client identity", async () => {
    const { VideoRequestRejectedError } = await import("@/services/api/video");
    for (const explicit of [true, false]) {
        const { controller, nodesRef } = setup([node("source", CanvasNodeType.Config)], [], {
            requestVideoGeneration: async () => {
                throw explicit ? new VideoRequestRejectedError("参数无效") : new Error("network");
            },
            getVideoTaskByClientRequest: async () => {
                throw new Error("unavailable");
            },
        });
        await controller.generateNode("source", "video", "dance");
        const result = nodesRef.current.find((item) => item.type === CanvasNodeType.Video)!;
        assert.equal(result.metadata?.status, "error");
        assert.equal(Boolean(result.metadata?.videoTaskClientRequestId), !explicit);
    }
});
test("retrying after a transient video query failure reads existing task without resuming or recreating", async () => {
    const source = node("video", CanvasNodeType.Video, { status: "error", videoTaskId: "existing" });
    const { controller, nodesRef, calls } = setup([source], [], {
        getVideoTask: async () => ({ id: "existing", status: "succeeded", progress: 100, resultMediaIds: ["media"], videos: [{ mediaId: "media", url: "https://example.com/v.mp4" }] }),
        resumeVideoTask: async () => {
            throw new Error("must not resume a task that is not paused");
        },
    });
    await controller.retryNode(source);
    assert.equal(calls.video, 0);
    assert.equal(nodesRef.current[0].metadata?.mediaId, "media");
});

test("fresh retry of legacy video uses current model resolution instead of saved invalid value", async () => {
    const source = node("legacy-video", CanvasNodeType.Video, { prompt: "dance", vquality: "720", status: "error" });
    const submitted: Array<string | null> = [];
    const { controller } = setup([source], [], {
        requestVideoGeneration: async (config: AiConfig) => {
            submitted.push(config.vquality);
            return { id: "retry-video", status: "succeeded", progress: 100, resultMediaIds: ["media"], videos: [{ mediaId: "media", url: "https://example.test/video.mp4" }] };
        },
    });
    await controller.retryNode(source);
    assert.deepEqual(submitted, ["medium"]);
});

test("leaving canvas or deleting a video aborts its query without changing the task or submitting again", async () => {
    for (const reason of ["leave", "delete", "scope"]) {
        let scope = "A";
        let signal: AbortSignal | undefined;
        const source = node("v", CanvasNodeType.Video, { status: "loading", videoTaskId: "original", videoTaskClientRequestId: "client" });
        const { controller, nodesRef, calls } = setup([source], [], {
            getSessionScope: () => scope,
            getVideoTask: (_id: string, abortSignal: AbortSignal) => {
                signal = abortSignal;
                return new Promise((_resolve, reject) => abortSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
            },
        });
        controller.resumePendingImageTasks();
        assert.equal(signal?.aborted, false);
        if (reason === "delete") nodesRef.current = [];
        if (reason === "scope") scope = "B";
        controller.stopVideoObservations(reason === "leave");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(signal?.aborted, true);
        assert.equal(source.metadata?.status, "loading");
        assert.equal(source.metadata?.videoTaskId, "original");
        assert.equal(calls.video, 0);
        assert.equal(calls.errors.length, 0);
    }
});

test("stopping video observation clears its waiting timer", async () => {
    const set = globalThis.setTimeout,
        clear = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.setTimeout = (() => 123) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
        if (id === 123) cleared++;
    }) as unknown as typeof clearTimeout;
    try {
        const { controller, calls } = setup([node("source", CanvasNodeType.Config)], [], {
            requestVideoGeneration: async () => ({ id: "task", status: "running", progress: 0, resultMediaIds: [], videos: [] }),
        });
        await controller.generateNode("source", "video", "dance");
        controller.stopVideoObservations(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(cleared, 1);
        assert.equal(calls.errors.length, 0);
    } finally {
        globalThis.setTimeout = set;
        globalThis.clearTimeout = clear;
    }
});

test("transient video observation failures retry three times then preserve the original task", async () => {
    const { VideoQueryTransientError } = await import("@/services/api/video");
    const set = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((run: () => void, delay: number) => {
        delays.push(delay);
        queueMicrotask(run);
        return 1;
    }) as unknown as typeof setTimeout;
    try {
        let queries = 0;
        const { controller, nodesRef, calls } = setup([node("v", CanvasNodeType.Video, { status: "loading", videoTaskId: "original" })], [], {
            getVideoTask: async () => {
                queries++;
                throw new VideoQueryTransientError("请求超时，后台任务仍继续");
            },
        });
        controller.resumePendingImageTasks();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(queries, 4);
        assert.deepEqual(delays, [12000, 24000, 36000]);
        assert.equal(nodesRef.current[0].metadata?.videoTaskId, "original");
        assert.match(nodesRef.current[0].metadata?.errorDetails || "", /请求超时/);
        assert.equal(calls.video, 0);
    } finally {
        globalThis.setTimeout = set;
    }
});


test("retrying an uncertain image observes the original task without a new submission", async () => {
    const source = node("uncertain-image", CanvasNodeType.Image, { status: "error", imageTaskId: "original", prompt: "image" });
    const { controller, calls, nodesRef } = setup([source], [], {
        getImageTask: async () => ({ id: "original", clientRequestId: "original-client", status: "uncertain", progress: 0, images: [], error: "提交结果待确认" }),
    });
    await controller.retryNode(source);
    assert.equal(calls.generation, 0);
    assert.equal(calls.edit, 0);
    assert.equal(nodesRef.current[0].metadata?.imageTaskId, "original");
    assert.equal(nodesRef.current[0].metadata?.errorDetails, "提交结果待确认");
});

const settleGeneration = () => new Promise<void>((resolve) => setImmediate(resolve));

function completedVideoTask(id: string): VideoGenerationTask {
    return { id: `task-${id}`, status: "succeeded", progress: 100, resultMediaIds: [`media-${id}`], videos: [{ mediaId: `media-${id}`, url: `https://example.test/${id}.mp4` }] };
}

function pendingGenerationNode(kind: "image" | "video", id = "old") {
    return node("result", kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, {
        status: "loading",
        [`${kind}TaskId`]: `task-${id}`,
        [`${kind}TaskClientRequestId`]: `client-${id}`,
    });
}

test("image context hydration cannot create results in a later account, project or canonical generation", async () => {
    for (const nextScope of ["account-b:project:1", "account-a:other-project:1", "account-a:project:2"]) {
        let scope = "account-a:project:1";
        const hydration = deferred<{ prompt: string; referenceImages: []; textCount: number; imageCount: number }>();
        const { controller, nodesRef, calls } = setup([node("source", CanvasNodeType.Config)], [], {
            getSessionScope: () => scope,
            hydrateGenerationContext: () => hydration.promise,
        });
        const generation = controller.generateNode("source", "image", "forest");
        scope = nextScope;
        const replacement = [node("source", CanvasNodeType.Config, { prompt: "current" })];
        nodesRef.current = replacement;
        hydration.resolve({ prompt: "forest", referenceImages: [], textCount: 0, imageCount: 0 });
        await generation;
        assert.equal(nodesRef.current, replacement);
        assert.equal(calls.generation, 0);
    }
});

for (const kind of ["image", "video"] as const) {
    test(`${kind} create completion cannot overwrite a replacement task on the same node`, async () => {
        const created = deferred<ImageGenerationTask | VideoGenerationTask>();
        const { controller, nodesRef } = setup([node("result", kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video)], [], {
            [kind === "image" ? "requestGeneration" : "requestVideoGeneration"]: () => created.promise,
        });
        const generation = controller.generateNode("result", kind, "forest");
        await settleGeneration();
        const replacement = [pendingGenerationNode(kind, "new")];
        nodesRef.current = replacement;
        created.resolve(kind === "image" ? completedTask("old", "media-old") : completedVideoTask("old"));
        await generation;
        assert.equal(nodesRef.current, replacement);
    });

    for (const replacementKind of ["task", "client", "scope"] as const) {
        test(`${kind} observation ignores a stale ${replacementKind} and lets its replacement observation complete`, async () => {
            let scope = "account:project:1";
            const old = deferred<ImageGenerationTask | VideoGenerationTask>();
            let reads = 0;
            const { controller, nodesRef } = setup([pendingGenerationNode(kind)], [], {
                getSessionScope: () => scope,
                [kind === "image" ? "getImageTask" : "getVideoTask"]: (id: string) => {
                    reads++;
                    return reads === 1 ? old.promise : Promise.resolve({ ...(kind === "image" ? completedTask("new", "media-new") : completedVideoTask("new")), id });
                },
            });
            controller.resumePendingImageTasks();
            const replacement = pendingGenerationNode(kind, "new");
            if (replacementKind === "client") replacement.metadata![`${kind}TaskId`] = "task-old";
            if (replacementKind === "scope") {
                scope = "account:project:2";
                replacement.metadata = { ...pendingGenerationNode(kind).metadata };
            }
            nodesRef.current = [replacement];
            controller.resumePendingImageTasks();
            await settleGeneration();
            assert.equal(nodesRef.current[0].metadata?.mediaId, "media-new");
            const current = nodesRef.current;
            old.resolve(kind === "image" ? completedTask("old", "media-old") : completedVideoTask("old"));
            await settleGeneration();
            assert.equal(nodesRef.current, current);
        });
    }

    test(`${kind} completion merges into current nodes during Undo and Redo`, async () => {
        const result = deferred<ImageGenerationTask | VideoGenerationTask>();
        const { controller, nodesRef } = setup([pendingGenerationNode(kind)], [], {
            [kind === "image" ? "getImageTask" : "getVideoTask"]: () => result.promise,
        });
        controller.resumePendingImageTasks();
        const restored = { ...pendingGenerationNode(kind), title: "restored title", position: { x: 123, y: 456 } };
        const laterEdit = node("later-edit", CanvasNodeType.Text, { content: "keep me" });
        nodesRef.current = [restored, laterEdit];
        result.resolve(kind === "image" ? completedTask("old", "media-old") : completedVideoTask("old"));
        await settleGeneration();
        assert.equal(nodesRef.current[0].title, "restored title");
        assert.equal(nodesRef.current[0].position.x + nodesRef.current[0].width / 2, 293);
        assert.equal(nodesRef.current[0].metadata?.mediaId, "media-old");
        assert.equal(nodesRef.current[1], laterEdit);
    });

    test(`${kind} result rechecks task identity when the queued functional updater executes`, async () => {
        const updates: Array<(previous: CanvasNodeData[]) => CanvasNodeData[]> = [];
        const { controller, nodesRef } = setup([pendingGenerationNode(kind)], [], {
            [kind === "image" ? "getImageTask" : "getVideoTask"]: async () => kind === "image" ? completedTask("old", "media-old") : completedVideoTask("old"),
            setNodes: (update: (previous: CanvasNodeData[]) => CanvasNodeData[]) => updates.push(update),
        });
        controller.resumePendingImageTasks();
        await settleGeneration();
        assert.ok(updates.length > 0);
        const replacement = [pendingGenerationNode(kind, "new")];
        nodesRef.current = replacement;
        for (const update of updates) nodesRef.current = update(nodesRef.current);
        assert.equal(nodesRef.current, replacement);
    });

    test(`${kind} query failure cannot mark a newer task as failed`, async () => {
        const query = deferred<void>();
        const { controller, nodesRef } = setup([pendingGenerationNode(kind)], [], {
            [kind === "image" ? "getImageTask" : "getVideoTask"]: async () => {
                await query.promise;
                throw new Error("old task failed");
            },
        });
        controller.resumePendingImageTasks();
        const replacement = [pendingGenerationNode(kind, "new")];
        nodesRef.current = replacement;
        query.resolve();
        await settleGeneration();
        assert.equal(nodesRef.current, replacement);
    });

    test(`${kind} retry query cannot rebind an old result to a replacement task`, async () => {
        const query = deferred<ImageGenerationTask | VideoGenerationTask>();
        const original = pendingGenerationNode(kind);
        original.metadata!.status = "error";
        const { controller, nodesRef } = setup([original], [], {
            [kind === "image" ? "getImageTask" : "getVideoTask"]: () => query.promise,
        });
        const retry = controller.retryNode(original);
        const replacement = [pendingGenerationNode(kind, "new")];
        nodesRef.current = replacement;
        query.resolve(kind === "image" ? completedTask("old", "media-old") : completedVideoTask("old"));
        await retry;
        await settleGeneration();
        assert.equal(nodesRef.current, replacement);
    });

    test(`${kind} submission failure rechecks identity in every queued node update`, async () => {
        const submitted = deferred<void>();
        const updates: Array<(previous: CanvasNodeData[]) => CanvasNodeData[]> = [];
        let queue = false;
        const state = setup([node("result", kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video)], [], {
            [kind === "image" ? "requestGeneration" : "requestVideoGeneration"]: async () => {
                await submitted.promise;
                throw new Error("submission failed");
            },
            [kind === "image" ? "getImageTaskByClientRequest" : "getVideoTaskByClientRequest"]: async () => { throw new Error("missing request"); },
            setNodes: (update: (previous: CanvasNodeData[]) => CanvasNodeData[]) => {
                if (queue) updates.push(update);
                else state.nodesRef.current = update(state.nodesRef.current);
            },
        });
        const generation = state.controller.generateNode("result", kind, "forest");
        await settleGeneration();
        queue = true;
        submitted.resolve();
        await generation;
        const replacement = [pendingGenerationNode(kind, "new")];
        state.nodesRef.current = replacement;
        for (const update of updates) state.nodesRef.current = update(state.nodesRef.current);
        assert.equal(state.nodesRef.current, replacement);
    });
}

for (const reason of ["scope", "replacement", "deleted-child"] as const) {
    test(`image upload completion ignores ${reason} without populating its batch root`, async () => {
        let scope = "account:project:1";
        const uploaded = deferred<StoredCanvasImage>();
        const root = node("root", CanvasNodeType.Image, { isBatchRoot: true, batchChildIds: ["result"] });
        const child = pendingGenerationNode("image");
        child.metadata!.batchRootId = "root";
        const { controller, nodesRef } = setup([root, child], [], {
            getSessionScope: () => scope,
            getImageTask: async () => completedTask("old", "media-old"),
            uploadImage: () => uploaded.promise,
        });
        controller.resumePendingImageTasks();
        await settleGeneration();
        if (reason === "scope") scope = "account:project:2";
        if (reason === "replacement") nodesRef.current = [root, pendingGenerationNode("image", "new")];
        if (reason === "deleted-child") nodesRef.current = [root];
        const replacement = nodesRef.current;
        uploaded.resolve({ url: "blob:old", storageKey: "media:old", mediaId: "media-old", width: 512, height: 512, bytes: 12, mimeType: "image/png" });
        await settleGeneration();
        assert.equal(nodesRef.current, replacement);
        assert.equal(nodesRef.current[0].metadata?.mediaId, undefined);
    });
}


test("video submission snapshots the model and parameters before async completion", async () => {
    const pending = deferred<VideoGenerationTask>();
    const source = node("source", CanvasNodeType.Config, { generationMode: "video", seconds: "8", videoSize: "16:9" });
    let submitted: AiConfig | undefined;
    const { controller, nodesRef } = setup([source], [], { requestVideoGeneration: async (config: AiConfig) => { submitted = config; return pending.promise; } });
    const generation = controller.generateNode("source", "video", "运动镜头");
    await new Promise(resolve => setTimeout(resolve, 0));
    const before = nodesRef.current.find(n => n.type === CanvasNodeType.Video)!;
    assert.equal(before.metadata?.generationMode, "video");
    assert.equal(before.metadata?.videoProviderName, "Video");
    assert.equal(before.metadata?.vquality, submitted?.vquality);
    assert.equal(before.metadata?.seconds, submitted?.videoSeconds);
    assert.equal(before.metadata?.videoSize, submitted?.videoSize);
    source.metadata!.seconds = "15";
    pending.resolve({ id: "video-task", status: "succeeded", progress: 100, resultMediaIds: ["m"], videos: [{ mediaId: "m", url: "unused", duration: 7.8 }] });
    await generation;
    const after = nodesRef.current.find(n => n.id === before.id)!;
    assert.equal(after.metadata?.seconds, "8");
    assert.equal(after.metadata?.videoProviderName, "Video");
    assert.equal(after.metadata?.status, "success");
    const restored = node("restored", CanvasNodeType.Video, { ...after.metadata, status: "loading", mediaId: undefined });
    const recovery = setup([restored], [], { getVideoTask: async () => ({ id: "video-task", status: "succeeded", progress: 100, resultMediaIds: ["m"], videos: [{ mediaId: "m", url: "unused" }] }) });
    recovery.controller.resumePendingImageTasks();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(recovery.nodesRef.current[0].metadata?.videoProviderName, "Video");
    assert.equal(recovery.nodesRef.current[0].metadata?.seconds, "8");
    assert.equal(recovery.nodesRef.current[0].metadata?.status, "success");
});
