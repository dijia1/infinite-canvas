import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasNodeData } from "../types.ts";
import { migrateCanvasMaskResources, resolveCanvasNodeMask } from "./mask-resources.ts";

const sharedMask = {
    version: 1 as const,
    strokes: [{ id: "stroke-1", tool: "paint" as const, radius: 0.08, points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }] }],
};

function imageNode(id: string, metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata };
}

test("deduplicates legacy masks into one immutable canvas resource", () => {
    const source = imageNode("source", { content: "data:image/png;base64,source", imageMask: sharedMask });
    const firstResult = imageNode("result-a", { generationType: "edit", references: ["media:source:v1:original"], referenceMasks: [sharedMask] });
    const secondResult = imageNode("result-b", { generationType: "edit", references: ["media:source:v1:original"], referenceMasks: [sharedMask] });

    const migrated = migrateCanvasMaskResources([source, firstResult, secondResult]);
    const migratedSource = migrated.nodes[0]!;
    const migratedFirst = migrated.nodes[1]!;
    const migratedSecond = migrated.nodes[2]!;
    const maskId = migratedSource.metadata?.maskId;

    assert.ok(maskId);
    assert.equal(Object.keys(migrated.maskResources).length, 1);
    assert.equal(migratedFirst.metadata?.maskId, maskId);
    assert.equal(migratedSecond.metadata?.maskId, maskId);
    assert.equal("imageMask" in (migratedSource.metadata || {}), false);
    assert.equal("referenceMasks" in (migratedFirst.metadata || {}), false);
    assert.deepEqual(resolveCanvasNodeMask(migratedSecond, migrated.maskResources), sharedMask);
});

test("keeps an existing mask ID stable while retaining legacy read fallback", () => {
    const node = imageNode("source", { maskId: "mask-persisted" });
    const resources = { "mask-persisted": sharedMask };

    const migrated = migrateCanvasMaskResources([node], resources);

    assert.equal(migrated.nodes[0]?.metadata?.maskId, "mask-persisted");
    assert.deepEqual(resolveCanvasNodeMask(migrated.nodes[0]!, migrated.maskResources), sharedMask);
});
