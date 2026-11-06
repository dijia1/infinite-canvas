import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicImageReferences, canApplyPublicImageMigration, hasPublicImageMigrationCandidates } from "./canvas-public-image-migration";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { createCanvasHistoryController } from "../hooks/use-canvas-history";

const node: CanvasNodeData = {
    id: "image",
    type: CanvasNodeType.Image,
    title: "image",
    position: { x: 11, y: 22 },
    width: 300,
    height: 200,
    metadata: { mediaId: "public-source", publicImageId: "public-id", assetId: "public-asset", maskId: "mask", imageTaskId: "generation" },
};
const replacements = [{ nodeId: "image", sourceMediaId: "public-source", sourcePublicImageId: "public-id", mediaId: "private-copy" }];
test("public reference normalization preserves graph properties and does not change unrelated replacements", () => {
    const unrelated = { ...node, id: "other", metadata: { mediaId: "other-media" } };
    const nodes = normalizePublicImageReferences([node, unrelated], replacements, []);
    assert.equal(nodes[0]!.id, node.id);
    assert.equal(nodes[0]!.position, node.position);
    assert.equal(nodes[0]!.width, node.width);
    assert.equal(nodes[0]!.metadata!.mediaId, "private-copy");
    assert.equal(nodes[0]!.metadata!.publicImageId, undefined);
    assert.equal(nodes[0]!.metadata!.assetId, undefined);
    assert.equal(nodes[0]!.metadata!.maskId, "mask");
    assert.equal(nodes[0]!.metadata!.imageTaskId, "generation");
    assert.equal(nodes[1], unrelated);
    const missing = normalizePublicImageReferences([node], [], ["image"])[0]!;
    assert.equal(missing.metadata!.status, "error");
    assert.match(missing.metadata!.errorDetails!, /替换或删除/);
    assert.equal(missing.metadata!.mediaId, "public-source");
});
test("conversion results require the same scope, revision, clean document and editor ownership", () => {
    const expected = { scope: "owner", projectId: "canvas", generation: 1, revision: 2, nodes: [node] };
    const current = { ...expected, blocked: false, dirty: false, pending: false };
    assert.equal(canApplyPublicImageMigration(expected, current), true);
    for (const patch of [{ scope: "other" }, { projectId: "other" }, { generation: 2 }, { revision: 3 }, { nodes: [] }, { blocked: true }, { dirty: true }, { pending: true }])
        assert.equal(canApplyPublicImageMigration(expected, { ...current, ...patch }), false);
});
test("automatic conversion normalizes retained undo and redo without creating an undo entry", () => {
    let applied: CanvasNodeData[] = [];
    let application = 0;
    const history = createCanvasHistoryController<CanvasNodeData[]>({
        applySnapshot: (nodes, id) => {
            applied = nodes;
            application = id;
        },
        schedule: () => 1,
        clear: () => {},
    });
    const before = [node];
    const moved = [{ ...node, position: { x: 99, y: 99 } }];
    history.observe(before);
    history.observe(moved);
    history.pause();
    const converted = normalizePublicImageReferences(moved, replacements, []);
    history.rebase((snapshot) => normalizePublicImageReferences(snapshot, replacements, []), converted);
    history.observe(converted);
    history.undo();
    assert.equal(applied[0]!.position.x, 11);
    assert.equal(applied[0]!.metadata!.mediaId, "private-copy");
    history.completeApplication(application);
    history.redo();
    assert.equal(applied[0]!.position.x, 99);
    assert.equal(applied[0]!.metadata!.mediaId, "private-copy");
    history.completeApplication(application);
    assert.equal(history.canRedo, false);
});

test("new private imports do not trigger the scan reserved for restored media-only references", () => {
    const privateImage = { ...node, metadata: { mediaId: "personal-copy" } };
    assert.equal(hasPublicImageMigrationCandidates([privateImage], [], true), false);
    assert.equal(hasPublicImageMigrationCandidates([privateImage], [privateImage], true), true);
    assert.equal(hasPublicImageMigrationCandidates([privateImage], [privateImage], false), false);
    assert.equal(hasPublicImageMigrationCandidates([node], [node], false), true);
});
