import assert from "node:assert/strict";
import test from "node:test";

import ts from "typescript";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { imageInputLabel } from "@/lib/generation-input-order";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { hydrateNodeGenerationContext, buildNodeGenerationInputs, buildNodeGenerationContext } from "./canvas-node-generation.ts";

test("keeps all stable media references out of the browser original-image hydration path", async () => {
    let originalLoads = 0;
    const context = {
        prompt: "edit",
        textCount: 0,
        imageCount: 2,
        referenceImages: [
            { id: "a", name: "a.png", type: "image/png", dataUrl: "", mediaId: "media-a", storageKey: "media:media-a:v1:original" },
            { id: "b", name: "b.png", type: "image/png", dataUrl: "", mediaId: "media-b", storageKey: "media:media-b:v1:original" },
        ],
    };

    const hydrated = await hydrateNodeGenerationContext(context, async () => {
        originalLoads += 1;
        throw new Error("should not load a browser original");
    });

    assert.equal(originalLoads, 0);
    assert.equal(hydrated, context);
});

test("preview reordering is the source of truth for image badges and actual generation references", () => {
    const nodes: CanvasNodeData[] = [
        ...["a", "b", "c"].map(id => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { mediaId: id === "b" ? "same-a" : id === "a" ? "same-a" : "other" } })),
        { id: "text", type: CanvasNodeType.Text, title: "text", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "把图1放在图2上" } },
        { id: "video", type: CanvasNodeType.Video, title: "video", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { mediaId: "video" } },
        { id: "config", type: CanvasNodeType.Config, title: "config", position: { x: 0, y: 0 }, width: 360, height: 274, metadata: {} },
    ];
    const node = nodes.at(-1)!;
    const connections = ["a", "text", "b", "video", "c"].map(id => ({ id, fromNodeId: id, toNodeId: node.id }));
    const inputs = buildNodeGenerationInputs(node.id, nodes, connections);
    let calls = 0;
    const reorder = sourceBehavior(new URL("./canvas-config-node-panel.tsx", import.meta.url), {
        inputs, imageInputs: inputs.filter(input => input.type === "image"), node,
        onConfigChange: (_id: string, patch: object) => { calls++; node.metadata = { ...node.metadata, ...patch }; },
    }).select(element => ts.isArrowFunction(element) && ts.isJsxExpression(element.parent) && ts.isJsxAttribute(element.parent.parent) && element.parent.parent.name.getText() === "onReorder");
    reorder(["c", "a", "b"]);
    assert.equal(calls, 1);
    assert.deepEqual(node.metadata?.inputOrder, ["c", "text", "a", "video", "b"]);
    const saved: CanvasNodeData[] = JSON.parse(JSON.stringify(nodes));
    const nextInputs = buildNodeGenerationInputs(node.id, saved, connections).filter(input => input.type === "image");
    assert.deepEqual(nextInputs.map((input, index) => [input.nodeId, imageInputLabel(index)]), [["c", "图1"], ["a", "图2"], ["b", "图3"]]);
    const context = buildNodeGenerationContext(node.id, saved, connections, "");
    assert.deepEqual(context.referenceImages.map(input => input.id), ["c", "a", "b"]);
    assert.match(context.prompt, /把图1放在图2上/);
});


test("editor preview resolves persisted mask resources before showing numbered image inputs", () => {
    const mask = { version: 1 as const, strokes: [{ id: "paint", tool: "paint" as const, radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }] };
    const nodes: CanvasNodeData[] = [
        { id: "image", type: CanvasNodeType.Image, title: "image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { mediaId: "media", maskId: "mask-image" } },
        { id: "config", type: CanvasNodeType.Config, title: "config", position: { x: 0, y: 0 }, width: 360, height: 274, metadata: {} },
    ];
    const previews = sourceBehavior(new URL("../editor/canvas-client-page.tsx", import.meta.url), {
        useMemo: (read: () => unknown) => read(), nodes, connections: [{ id: "link", fromNodeId: "image", toNodeId: "config" }],
        maskResources: { "mask-image": mask }, CanvasNodeType, buildNodeGenerationInputs,
    }).named("configInputsById");
    assert.deepEqual(previews.get("config")[0].image.mask, mask);
});
