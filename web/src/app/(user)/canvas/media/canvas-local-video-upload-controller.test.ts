import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvasLocalVideoUploadController } from "./canvas-local-video-upload-controller";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import type { VideoMediaAccess, VideoUploadOptions } from "@/services/api/video-media";
const remote = { mediaId: "remote", width: 160, height: 90 } as VideoMediaAccess;
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: Error) => void;
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}
function setup() {
    let node: CanvasNodeData | undefined = { id: "v", type: CanvasNodeType.Video, title: "video", position: { x: 0, y: 0 }, width: 300, height: 200 };
    let editable = true;
    const calls: Array<{ options: VideoUploadOptions; response: ReturnType<typeof deferred<VideoMediaAccess>> }> = [];
    const revoked: string[] = [];
    const c = createCanvasLocalVideoUploadController({
        upload: (_file, options) => {
            const response = deferred<VideoMediaAccess>();
            calls.push({ options: options || {}, response });
            return response.promise;
        },
        getNode: () => node,
        canEdit: () => editable,
        onChange: () => {},
        onCompleted: (_id, _file, value) => {
            node = { ...node!, metadata: { mediaId: value.mediaId } };
        },
        createURL: () => `blob:${calls.length}`,
        revokeURL: (url) => revoked.push(url),
    });
    return {
        c,
        calls,
        revoked,
        get node() {
            return node!;
        },
        setNode: (next: CanvasNodeData | undefined) => (node = next),
        setEditable: () => (editable = false),
    };
}
const file = () => new File(["video"], "v.mp4", { type: "video/mp4" });

test("local video preview appears before response; progress never changes the document", async () => {
    const s = setup();
    const source = s.node;
    const pending = s.c.start(source, file());
    assert.equal(s.c.views().get("v")?.url, "blob:0");
    assert.equal(s.c.isPending("v"), true);
    s.calls[0].options.onProgress?.(42);
    assert.equal(s.c.views().get("v")?.progress, 42);
    assert.equal(s.node, source);
    s.calls[0].options.onStage?.("verifying");
    assert.equal(s.c.views().get("v")?.stage, "verifying");
    s.setNode({ ...source, position: { x: 40, y: 50 } });
    s.calls[0].response.resolve(remote);
    await pending;
    assert.deepEqual(s.node.position, { x: 40, y: 50 });
    assert.equal(s.node.metadata?.mediaId, "remote");
    assert.equal(s.c.isPending("v"), false);
    assert.equal(s.c.views().get("v")?.url, "blob:0");
    s.c.dispose();
    assert.deepEqual(s.revoked, ["blob:0"]);
});

test("confirmation failure keeps original media, preview and uploaded intent for retry", async () => {
    const s = setup();
    s.setNode({ ...s.node, metadata: { mediaId: "original" } });
    const metadata = { width: 720, height: 1280, duration: 5 };
    const pending = s.c.start(s.node, file(), metadata);
    assert.equal(s.calls[0].options.metadata, metadata);
    s.calls[0].options.onUploaded?.("intent-once");
    s.calls[0].response.reject(Error("confirmation failed"));
    await pending;
    assert.equal(s.node.metadata?.mediaId, "original");
    assert.equal(s.c.views().get("v")?.stage, "failed");
    assert.equal(s.c.isPending("v"), true);
    const retry = s.c.retry("v");
    assert.equal(s.calls[1].options.uploadedIntentId, "intent-once");
    assert.equal(s.calls[1].options.metadata, metadata);
    s.calls[1].response.resolve(remote);
    await retry;
    assert.equal(s.node.metadata?.mediaId, "remote");
});

test("replaced, removed, readonly and disposed uploads cannot write stale results", async () => {
    for (const action of ["replace", "remove", "readonly", "dispose"]) {
        const s = setup();
        const pending = s.c.start(s.node, file());
        if (action === "replace") s.setNode({ ...s.node, metadata: { mediaId: "newer" } });
        if (action === "remove") s.setNode(undefined);
        if (action === "readonly") s.setEditable();
        if (action === "dispose") s.c.dispose();
        s.calls[0].response.resolve(remote);
        await pending;
        assert.notEqual(s.node?.metadata?.mediaId, "remote", action);
        s.c.dispose();
        assert.equal(s.revoked.length, 1);
    }
});

test("cancel and a second replacement isolate both completions", async () => {
    const s = setup();
    const first = s.c.start(s.node, file());
    const second = s.c.start(s.node, file());
    assert.equal(s.calls[0].options.signal?.aborted, true);
    s.calls[0].response.resolve(remote);
    await first;
    assert.equal(s.node.metadata?.mediaId, undefined);
    s.c.cancel("v");
    s.calls[1].response.resolve(remote);
    await second;
    assert.equal(s.node.metadata?.mediaId, undefined);
    assert.equal(s.c.views().size, 0);
});
