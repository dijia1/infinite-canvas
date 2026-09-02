import assert from "node:assert/strict";
import test from "node:test";

import { privateCatalogToAssetState } from "./private-asset-sync.ts";

test("maps server private media into cache-backed image assets", () => {
    const state = privateCatalogToAssetState(
        {
            items: [
                {
                    id: "media-1",
                    source: "upload",
                    contentType: "image/png",
                    bytes: 2048,
                    width: 1200,
                    height: 800,
                    filename: "original.png",
                    title: "产品主图",
                    folderId: "folder-1",
                    createdAt: "2026-08-24T00:00:00Z",
                },
            ],
            total: 1,
        },
        {
            items: [{ id: "folder-1", title: "产品", parentId: "", createdAt: "2026-08-24T00:00:00Z" }],
            total: 1,
        },
    );

    assert.deepEqual(state.folders, [{ id: "folder-1", name: "产品", parentId: undefined, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z" }]);
    assert.deepEqual(state.assets, [
        {
            id: "media-1",
            kind: "image",
            title: "产品主图",
            coverUrl: "",
            tags: [],
            source: "我的上传",
            folderId: "folder-1",
            data: { dataUrl: "", storageKey: "media:media-1:v1:original", width: 1200, height: 800, bytes: 2048, mimeType: "image/png" },
            metadata: { mediaId: "media-1", mediaSource: "upload", uploadState: "uploaded" },
            createdAt: "2026-08-24T00:00:00Z",
            updatedAt: "2026-08-24T00:00:00Z",
        },
    ]);
});

test("maps a legacy temporary media source into the permanent upload system folder", () => {
    const state = privateCatalogToAssetState(
        {
            items: [
                {
                    id: "media-canvas",
                    source: "canvas_temporary",
                    contentType: "image/png",
                    bytes: 1024,
                    width: 800,
                    height: 600,
                    filename: "canvas.png",
                    title: "画板输入图",
                    createdAt: "2026-08-25T00:00:00Z",
                    expiresAt: "2026-09-01T00:00:00Z",
                },
            ],
            total: 1,
        },
        { items: [], total: 0 },
    );

    const asset = state.assets[0];
    assert.equal(asset?.source, "我的上传");
    assert.deepEqual(asset?.metadata, {
        mediaId: "media-canvas",
        mediaSource: "canvas_temporary",
        expiresAt: "2026-09-01T00:00:00Z",
        uploadState: "uploaded",
    });
});
