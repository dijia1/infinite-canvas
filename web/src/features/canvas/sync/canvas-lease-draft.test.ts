import assert from "node:assert/strict";
import test from "node:test";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { createCanvasDocumentPublisher, type CanvasEditorDocument } from "../hooks/use-canvas-document-sync";
import { CanvasNodeType } from "../types";

for (const conflict of [false, true]) {
    test(`lease loss preserves pending editor data locally even after an old save conflict: ${conflict}`, async () => {
        const baseline: CanvasEditorDocument = { nodes: [], connections: [], maskResources: {}, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
        const latest = { ...baseline, nodes: [{ id: "B", type: CanvasNodeType.Text, title: "B", width: 100, height: 100, position: { x: 0, y: 0 } }] };
        const stored = { id: "P", title: "draft", ...baseline };
        let blocked = false;
        let hasConflict = false;
        let recovery: unknown;
        const publisher = createCanvasDocumentPublisher({ publish: () => assert.fail("lease recovery must never force a Store or server write"), isCurrent: () => !blocked && !hasConflict });
        publisher.capture(latest, baseline);
        hasConflict = conflict;
        const url = new URL("./use-canvas-project-open.ts", import.meta.url);
        try {
            const loseLease = sourceBehavior(url, {
                useCanvasStore: { getState: () => ({ projectSync: { P: { conflict: hasConflict } } }) },
                store: {
                    openProject: () => stored,
                    preserveProjectDraft: async (_id: string, document: unknown) => { recovery = document; },
                    reportProjectRecoveryError: () => assert.fail("backup failed"),
                },
                projectId: "P",
                owner: () => {},
                active: () => true,
                claimFallback: () => "occupied",
                readDraft: publisher.getPendingDocument,
                release: (saveDraft: boolean, keepBlocked: boolean) => {
                    assert.equal(saveDraft, false);
                    blocked = keepBlocked;
                },
                waitForEditor: () => assert.equal(blocked, true),
            }).named("checkFallback");
            loseLease();
            await Promise.resolve();
            assert.deepEqual(recovery, { ...stored, ...latest });
            assert.equal(blocked, true);
            assert.deepEqual(stored.nodes, []);
        } finally {
            publisher.cancel();
        }
    });
}
