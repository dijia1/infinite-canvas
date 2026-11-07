import assert from "node:assert/strict";
import test from "node:test";
import { sourceModule } from "@/test-utils/source-component";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { CanvasNodeType } from "../types";
import { fitNodeSize } from "../utils/canvas-node-size";

const dimensionsURL = new URL("./material-video-asset.ts", import.meta.url);
test("known video geometry needs no preview or video request", async () => {
    const { videoAssetDimensions: dimensions } = sourceModule<{ videoAssetDimensions: (asset: any, id: string) => Promise<any> }>(dimensionsURL, { "@/services/api/video-media": { getVideoMediaAccess() { assert.fail("unnecessary media request"); } }, "@/services/image-storage": { loadMediaThumbnail() { assert.fail("unnecessary poster request"); } } });
    assert.deepEqual(await dimensions({ data: { width: 720, height: 1280 } }, "video"), { width: 720, height: 1280 });
});

test("unknown generated-video geometry uses the cached first-frame loader", async () => {
    let previews = 0;
    const { videoAssetDimensions: dimensions } = sourceModule<{ videoAssetDimensions: (asset: any, id: string) => Promise<any> }>(dimensionsURL, {
        "@/services/api/video-media": { getVideoMediaAccess: async () => ({ url: "https://example.invalid/video.mp4", previewUrl: "https://example.invalid/poster.jpg" }) },
        "@/services/image-storage": { loadMediaThumbnail: async (id: string, remote: () => Promise<string>) => {
            assert.equal(id, "video");
            assert.equal(await remote(), "https://example.invalid/poster.jpg");
            previews++;
            return { width: 360, height: 640 };
        } },
    });
    assert.deepEqual(await dimensions({ data: { width: 0, height: 0 } }, "video"), { width: 360, height: 640 });
    assert.equal(previews, 1);
});

test("private video drops create a video reference without uploading or copying the object", async () => {
    const nodes: any[] = [];
    const create = sourceBehavior(new URL("../editor/canvas-client-page.tsx", import.meta.url), {
        useCallback: (callback: unknown) => callback,
        videoCanEditRef: { current: true },
        getVideoSessionScope: () => "canvas", videoAssetDimensions: async () => ({ width: 720, height: 1280 }), fitNodeSize,
        VIDEO_NODE_MAX_WIDTH: 640, VIDEO_NODE_MAX_HEIGHT: 640, CanvasNodeType,
        createCanvasNode: (type: string, position: unknown, metadata: unknown) => ({ id: "node", type, position, metadata }),
        setNodes: (update: (previous: any[]) => any[]) => nodes.push(...update([])),
        setSelectedNodeIds() {}, setSelectedConnectionId() {}, setDialogNodeId() {},
    }).named("createVideoAssetNode");
    await create({ id: "asset", title: "视频", data: { width: 720, height: 1280, mimeType: "video/mp4", duration: 6, bytes: 1000 }, metadata: { mediaId: "stable-video" } }, { x: 500, y: 400 });
    assert.equal(nodes[0].type, "video");
    assert.equal(nodes[0].metadata.mediaId, "stable-video");
    assert.equal(nodes[0].metadata.content, undefined);
    assert.equal(nodes[0].width / nodes[0].height, 720 / 1280);
});
