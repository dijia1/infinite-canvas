import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { createCanvasDocumentPublisher, type CanvasEditorDocument } from "../hooks/use-canvas-document-sync";

const page = new URL("./canvas-client-page.tsx", import.meta.url);
const document: CanvasEditorDocument = { nodes: [], connections: [], maskResources: {}, backgroundMode: "lines", showImageInfo: true, viewport: { x: 37, y: -21, k: 1.58 } };

for (const paused of [true, false]) {
    test(`complete editor documents still publish while history is ${paused ? "paused" : "applying"}`, () => {
        const writes: CanvasEditorDocument[] = [];
        const publisher = createCanvasDocumentPublisher({ publish: (next) => writes.push(next), isCurrent: () => true });
        const bindings = { ...document, useMemo: (fn: () => unknown) => fn(), projectLoaded: true, loadedProjectId: "project-1", loadedSyncScope: "user-1", syncScope: "user-1", loadedCanonicalGeneration: 1, canonicalGeneration: 1,
            isProjectReadonly: false, isPausedRef: { current: paused }, isApplyingRef: { current: !paused }, projectId: "project-1", documentBaseline: { ...document, nodes: [] }, getLiveViewport: () => document.viewport };
        const source = sourceBehavior(page, bindings);
        const editorDocument = source.named("editorDocument");
        sourceBehavior(page, { ...bindings, editorDocument, documentReady: source.named("documentReady"),
            useCanvasDocumentSync: ({ isReady, document: next, baseline }: { isReady: boolean; document: CanvasEditorDocument; baseline: CanvasEditorDocument }) => { if (isReady) publisher.capture(next, baseline); },
        }).select((node) => ts.isCallExpression(node) && node.expression.getText() === "useCanvasDocumentSync");
        publisher.flush();
        assert.deepEqual(writes, [document], "nodes, edges, masks, appearance and viewport must travel together");
    });
}

test("previous editor state is not ready under a new project, user or canonical generation", () => {
    const bindings = { projectLoaded: true, projectId: "project-1", loadedProjectId: "project-1", syncScope: "user-1", loadedSyncScope: "user-1", canonicalGeneration: 1, loadedCanonicalGeneration: 1 };
    for (const changed of [{ projectId: "project-2" }, { syncScope: "user-2" }, { canonicalGeneration: 2 }, { projectLoaded: false }]) {
        assert.equal(sourceBehavior(page, { ...bindings, ...changed }).named("documentReady"), false);
    }
    assert.equal(sourceBehavior(page, bindings).named("documentReady"), true);
});


test("node drag release publishes after React captures the final document, without flushing clicks", () => {
    const nodeDragWasActiveRef = { current: false };
    let flushes = 0;
    const run = (isNodeDragging: boolean) => sourceBehavior(page, {
        nodeDragWasActiveRef, isNodeDragging, flushDocument: () => { flushes++; }, useLayoutEffect: (fn: () => void) => fn(),
    }).select((node) => ts.isCallExpression(node) && node.expression.getText() === "useLayoutEffect" && node.arguments[0]?.getText().includes("nodeDragWasActiveRef"));
    run(false);
    assert.equal(flushes, 0);
    run(true);
    assert.equal(flushes, 0);
    run(false);
    assert.equal(flushes, 1);
    run(false);
    assert.equal(flushes, 1);
});
