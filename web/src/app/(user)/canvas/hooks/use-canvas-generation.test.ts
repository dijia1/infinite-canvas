import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasGenerationController } from "./use-canvas-generation.ts";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types.ts";
import type { AiConfig } from "@/lib/ai-config";

type Ref<T> = { current: T };

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

const config: AiConfig = {
    model: "image-model",
    imageModel: "image-model",
    videoModel: "video-model",
    textModel: "text-model",
    models: [],
    systemPrompt: "",
    videoSeconds: "6",
    vquality: "medium",
    quality: "auto",
    size: "1:1",
    resolution: "1k",
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

function setup(initialNodes: CanvasNodeData[], initialConnections: CanvasConnection[] = [], overrides: Record<string, unknown> = {}) {
    const nodesRef = ref(initialNodes);
    const connectionsRef = ref(initialConnections);
    const calls = { generation: 0, edit: 0, video: 0, configDialog: 0, errors: [] as string[], warnings: [] as string[] };
    let sequence = 0;
    const controller = createCanvasGenerationController({
        nodesRef,
        connectionsRef,
        effectiveConfig: config,
        defaultConfig: config,
        isAiConfigReady: () => true,
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
            return [{ id: `image-${calls.generation}`, dataUrl: `data:image/png;base64,${calls.generation}`, mediaId: `media-${calls.generation}` }];
        },
        requestEdit: async () => {
            calls.edit++;
            return [{ id: `edit-${calls.edit}`, dataUrl: `data:image/png;base64,edit-${calls.edit}`, mediaId: `edit-media-${calls.edit}` }];
        },
        requestImageQuestion: async () => {
            throw new Error("文本生成功能已移除");
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
});

test("dispatches every batch image request before completion and uses one image per request", async () => {
    const source = node("source", CanvasNodeType.Config, { count: 3 });
    const requests: AiConfig[] = [];
    const pending = Array.from({ length: 3 }, () => deferred<Array<{ id: string; dataUrl: string; mediaId: string }>>());
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

    pending.forEach((request, index) => request.resolve([{ id: `image-${index}`, dataUrl: `data:image/png;base64,${index}`, mediaId: `media-${index}` }]));
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
});

test("preserves successful batch children when another child fails", async () => {
    const source = node("source", CanvasNodeType.Config, { count: 3 });
    let attempts = 0;
    const { controller, nodesRef, calls } = setup([source], [], {
        requestGeneration: async () => {
            attempts++;
            calls.generation++;
            if (attempts === 2) throw new Error("provider failed");
            return [{ id: `image-${attempts}`, dataUrl: "data:image/png;base64,ok", mediaId: `media-${attempts}` }];
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
    const retryable = node("retry", CanvasNodeType.Image, { prompt: "retry me", generationType: "edit", model: "image-model", size: "1:1", resolution: "1k", quality: "auto", count: 3, references: ["data:image/png;base64,reference"] });
    const { controller, calls } = setup([retryable]);

    await controller.retryNode(retryable);
    assert.equal(calls.edit, 1);

    const missing = node("missing", CanvasNodeType.Image, { prompt: "retry me", generationType: "edit", references: ["image:gone"] });
    const failed = setup([missing], [], { resolveMetadataReferences: async () => null });
    await failed.controller.retryNode(missing);
    assert.equal(failed.nodesRef.current[0].metadata?.status, "error");
    assert.equal(failed.nodesRef.current[0].metadata?.errorDetails, "参考图片已丢失，无法继续重试");
});

test("retries a batch child with root metadata without changing the batch", async () => {
    const root = node("root", CanvasNodeType.Image, {
        prompt: "retry this batch",
        generationType: "edit",
        model: "root-model",
        size: "16:9",
        resolution: "2k",
        quality: "high",
        count: 3,
        references: ["data:image/png;base64,reference"],
        isBatchRoot: true,
        batchChildIds: ["child-a", "child-b", "child-c"],
        primaryImageId: "child-a",
    });
    const child = node("child-b", CanvasNodeType.Image, { batchRootId: "root", status: "error" });
    const rootMetadataBefore = { ...root.metadata };
    const editRequests: AiConfig[] = [];
    const { controller, nodesRef } = setup([root, child], [], {
        requestEdit: async (requestConfig: AiConfig) => {
            editRequests.push(requestConfig);
            return [{ id: "retry-image", dataUrl: "data:image/png;base64,retry", mediaId: "retry-media" }];
        },
    });

    await controller.retryNode(child);

    assert.deepEqual(
        editRequests.map((request) => ({ model: request.model, size: request.size, resolution: request.resolution, quality: request.quality, count: request.count })),
        [{ model: "root-model", size: "16:9", resolution: "2k", quality: "high", count: "1" }],
    );
    assert.equal(nodesRef.current.length, 2);
    assert.deepEqual(nodesRef.current.find((item) => item.id === "root")?.metadata, rootMetadataBefore);
    const retriedChild = nodesRef.current.find((item) => item.id === "child-b");
    assert.equal(retriedChild?.metadata?.batchRootId, "root");
    assert.equal(retriedChild?.metadata?.status, "success");
});

test("routes video generation through the video service", async () => {
    const source = node("source", CanvasNodeType.Config, { generationMode: "video" });
    const { controller, nodesRef, calls } = setup([source]);

    await controller.generateNode("source", "video", "make it move");

    assert.equal(calls.video, 1);
    assert.equal(nodesRef.current.find((item) => item.type === CanvasNodeType.Video)?.metadata?.status, "success");
});

test("text-to-image creates and opens an image config node instead of calling text generation", () => {
    const source = node("source", CanvasNodeType.Text, { content: "a composed prompt" });
    const { controller, nodesRef, connectionsRef } = setup([source]);

    controller.generateImageFromTextNode(source);

    const configNode = nodesRef.current.find((item) => item.type === CanvasNodeType.Config);
    assert.ok(configNode);
    assert.equal(configNode.metadata?.model, "image-model");
    assert.deepEqual(
        connectionsRef.current.map(({ fromNodeId, toNodeId }) => ({ fromNodeId, toNodeId })),
        [{ fromNodeId: "source", toNodeId: configNode.id }],
    );
});
