import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { isLocalImageUploadNode } from "../utils/canvas-local-image-upload";
import { imageMetadata } from "@/services/canvas-image-hydration";
import { CanvasNodeType, type CanvasNodeData } from "../types";

for (const kind of ["current", "old-image", "old-scope"] as const) {
    test(`upload callbacks only apply to the matching local image: ${kind}`, () => {
        let nodes: CanvasNodeData[] = [{ id: "A", type: CanvasNodeType.Image, title: "A", position: { x: 0, y: 0 }, width: 100, height: 100,
            metadata: { storageKey: "current-image", localUploadState: "uploading" } }];
        const image = { url: "blob:result", storageKey: "media:result", mediaId: "result", width: 100, height: 100, bytes: 1, mimeType: "image/png" };
        const source = { scope: kind === "old-scope" ? "old" : "current", image: { storageKey: kind === "old-image" ? "old-image" : "current-image" } };
        const callbacks = sourceBehavior(new URL("./canvas-client-page.tsx", import.meta.url), {
            useMemo: (fn: () => unknown) => fn(), createCanvasLocalImageUploadController: (options: unknown) => options,
            canonicalGeneration: 1, projectId: "project-1", syncScope: "user-1",
            uploadUserImage: () => undefined, promoteImageStorageKey: () => undefined,
            isLocalImageUploadNode, imageMetadata, NODE_STATUS_SUCCESS: "success",
            getVideoSessionScope: () => "current",
            setNodes: (fn: (prev: CanvasNodeData[]) => CanvasNodeData[]) => { nodes = fn(nodes); },
            useAssetStore: { getState: () => ({ refreshFromServer: async () => undefined }) },
        }).named("localImageUploadController");
        callbacks.onProgress("A", 50, source);
        assert.equal(nodes[0].metadata?.localUploadProgress, kind === "current" ? 50 : undefined);
        callbacks.onStage("A", "verifying", source);
        assert.equal(nodes[0].metadata?.localUploadState, kind === "current" ? "verifying" : "uploading");
        callbacks.onCompleted("A", image, { mediaId: "result" }, source);
        assert.equal(nodes[0].metadata?.mediaId, kind === "current" ? "result" : undefined);
        callbacks.onFailed("A", "old error", source);
        assert.equal(nodes[0].metadata?.localUploadError, undefined);
    });
}

test("a resumed upload cannot fail or restart an image restored while local cache was loading", async () => {
    let finish!: (blob: Blob | null) => void;
    const pending = new Promise<Blob | null>((resolve) => { finish = resolve; });
    const original: CanvasNodeData = { id: "A", type: CanvasNodeType.Image, title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "old-image", localUploadState: "uploading" } };
    const nodesRef = { current: [original] };
    const failures: string[] = [];
    const source = sourceBehavior(new URL("./canvas-client-page.tsx", import.meta.url), {
        useCallback: (fn: unknown) => fn, isLocalImageUploadNode, nodesRef,
        getVideoSessionScope: () => "current", getImageBlob: () => pending,
        resolveImageUrl: async () => "blob:old",
        markLocalImageUploadFailed: () => failures.push("old failure"),
        startLocalImageUpload: () => failures.push("old restart"),
    });
    const resume = source.named("resumeLocalImageUpload");
    const running = resume(original);
    nodesRef.current = [{ ...original, metadata: { ...original.metadata, storageKey: "new-image" } }];
    finish(null);
    await running;
    assert.deepEqual(failures, []);
});


for (const stage of ["uploading", "verifying"] as const) test(`Undo can resume the same ${stage} local image after its previous upload finished`, async () => {
    const node = { id: "A", type: CanvasNodeType.Image, metadata: { storageKey: "local-A", localUploadState: stage } };
    let uploads = 0;
    let active = false;
    const runEffect = sourceBehavior(new URL("./canvas-client-page.tsx", import.meta.url), {
        documentReady: true, isProjectReadonly: false, nodes: [node], isLocalImageUploadNode,
        localImageUploadController: { isActive: () => active },
        getVideoSessionScope: () => "scope", resumedLocalUploadKeysRef: { current: new Set<string>() },
        resumeLocalImageUpload: async () => { uploads++; active = true; },
        markLocalImageUploadFailed: () => assert.fail("unexpected failure"),
    }).select((item) => ts.isArrowFunction(item) && ts.isCallExpression(item.parent) && item.parent.expression.getText() === "useEffect" && item.getText().includes("resumedLocalUploadKeysRef.current.has"));
    runEffect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    runEffect(); // The controller owns deduplication while the upload is active.
    assert.equal(uploads, 1);
    active = false; // Completion followed by Undo restores the same local snapshot.
    runEffect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(uploads, 2);
});
