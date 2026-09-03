import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasGenerationController } from "./use-canvas-generation.ts";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types.ts";
import type { AiConfig } from "@/lib/ai-config";
import type { ImageGenerationTask } from "@/services/api/image";

type Ref<T> = { current: T };

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

const config: AiConfig = {
    videoSeconds: "6",
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
            return new Blob(["video"], { type: "video/mp4" });
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

test("reusing a historical empty image removes its obsolete model metadata", async () => {
    const source = JSON.parse(
        '{"id":"source","type":"image","title":"source","position":{"x":0,"y":0},"width":340,"height":240,"metadata":{"model":"historical-model","freeResize":true}}',
    ) as CanvasNodeData;
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
    assert.equal(requests.every((request) => !("model" in request)), true);

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
    const { controller, nodesRef, connectionsRef, calls } = setup([source]);

    await controller.generateAngleNode(source, { horizontalAngle: 30, pitchAngle: 0, cameraDistance: 1.5, wideAngle: false });

    assert.equal(calls.edit, 1);
    assert.equal(calls.generation, 0);
    assert.equal(nodesRef.current.length, 2);
    assert.equal(connectionsRef.current.length, 1);
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
    assert.equal(editRequests.every((request) => !("model" in request)), true);
    assert.equal(nodesRef.current.length, 2);
    assert.deepEqual(nodesRef.current.find((item) => item.id === "root")?.metadata, rootMetadataBefore);
    const retriedChild = nodesRef.current.find((item) => item.id === "child-b");
    assert.equal(retriedChild?.metadata?.batchRootId, "root");
    assert.equal(retriedChild?.metadata?.status, "success");
    assert.equal("model" in (retriedChild?.metadata || {}), false);
});

test("restores an in-flight image task from its persisted client request ID", async () => {
    const pending = node("pending", CanvasNodeType.Image, { status: "loading", imageTaskClientRequestId: "client-refresh" });
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
