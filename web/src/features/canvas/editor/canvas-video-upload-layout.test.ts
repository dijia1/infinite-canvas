import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { videoNodeSize } from "../utils/canvas-node-size";
import { replaceNodeWithUploadedVideo } from "../utils/canvas-generation-utils";
import { videoUploadSourceIdentity } from "../media/canvas-local-video-upload-controller";
import { CanvasNodeType, type CanvasNodeData } from "../types";

for (const [width, height] of [
    [720, 1280],
    [1920, 1080],
    [720, 720],
])
    test(`new video starts at ${width}:${height} before its upload begins`, async () => {
        let resolveMetadata!: (metadata: object) => void;
        const pending = new Promise((resolve) => {
            resolveMetadata = resolve;
        });
        let nodes: CanvasNodeData[] = [];
        const starts: unknown[][] = [];
        const create = sourceBehavior(new URL("./canvas-client-page.tsx", import.meta.url), {
            useCallback: (callback: unknown) => callback,
            videoCanEditRef: { current: true },
            getVideoSessionScope: () => "scope",
            prepareVideoUpload: () => pending,
            videoNodeSize,
            createCanvasNode: (type: CanvasNodeType, position: object, metadata: object) => ({ id: "video", type, position, metadata }),
            CanvasNodeType,
            setNodes: (update: (current: CanvasNodeData[]) => CanvasNodeData[]) => {
                nodes = update(nodes);
            },
            setSelectedNodeIds: () => {},
            setSelectedConnectionId: () => {},
            setDialogNodeId: () => {},
            localVideoUploadController: {
                start: (...args: unknown[]) => {
                    starts.push(args);
                },
            },
        }).named("createVideoFileNode");
        const file = new File(["video"], "v.mp4", { type: "video/mp4" });
        const running = create(file, { x: 100, y: 200 });
        assert.equal(nodes.length, 0);
        assert.equal(starts.length, 0);
        const metadata = { width, height, duration: 5 };
        resolveMetadata(metadata);
        await running;
        const node = nodes[0];
        assert.equal(node.width / node.height, width / height);
        assert.equal(node.position.x + node.width / 2, 100);
        assert.equal(node.position.y + node.height / 2, 200);
        assert.equal(starts[0][0], node);
        assert.equal(starts[0][2], metadata);
    });

test("upload completion preserves a prepared video node's current size and position", () => {
    const source: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "local", width: 236.25, height: 420, position: { x: 10, y: 20 }, metadata: { status: "success" } };
    let nodes = [{ ...source, width: 300, height: 533.3333333333, position: { x: 200, y: 250 } }];
    const before = nodes[0];
    const callbacks = sourceBehavior(new URL("./canvas-client-page.tsx", import.meta.url), {
        useMemo: (create: () => unknown) => create(),
        createCanvasLocalVideoUploadController: (options: unknown) => options,
        canonicalGeneration: 1,
        projectId: "project",
        syncScope: "scope",
        uploadVideoMedia: () => {},
        videoCanEditRef: { current: true },
        nodesRef: { current: nodes },
        setLocalVideoUploads: () => {},
        videoNodeSize,
        videoMetadata: (value: { mediaId: string }) => ({ mediaId: value.mediaId }),
        videoUploadSourceIdentity,
        replaceNodeWithUploadedVideo,
        setNodes: (update: (current: CanvasNodeData[]) => typeof nodes) => {
            nodes = update(nodes);
        },
    }).named("localVideoUploadController");
    callbacks.onCompleted("video", new File(["video"], "v.mp4"), { mediaId: "saved", width: 720, height: 1280 }, source, { width: 720, height: 1280, duration: 5 });
    assert.equal(nodes[0].width, before.width);
    assert.equal(nodes[0].height, before.height);
    assert.deepEqual(nodes[0].position, before.position);
    assert.equal(nodes[0].metadata?.mediaId, "saved");
});
