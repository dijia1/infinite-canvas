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
            source: "本地上传",
            folderId: "folder-1",
            data: { dataUrl: "", storageKey: "media:media-1", width: 1200, height: 800, bytes: 2048, mimeType: "image/png" },
            metadata: { mediaId: "media-1", uploadState: "uploaded" },
            createdAt: "2026-08-24T00:00:00Z",
            updatedAt: "2026-08-24T00:00:00Z",
        },
    ]);
});
