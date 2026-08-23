import assert from "node:assert/strict";
import test from "node:test";

import type { StorageValue } from "zustand/middleware";

import { type Asset, type PrivateAssetFolder, useAssetStore } from "./use-asset-store.ts";

function imageAsset(id: string, title = "图片"): Asset {
    return {
        id,
        kind: "image",
        title,
        coverUrl: "blob:image",
        tags: [],
        data: { dataUrl: "blob:image", width: 100, height: 100, bytes: 100, mimeType: "image/png" },
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
    };
}

test("creates nested private folders and rejects duplicate sibling names", () => {
    useAssetStore.setState({ assets: [], folders: [] });

    const rootId = useAssetStore.getState().createFolder("  产品图  ");
    const childId = useAssetStore.getState().createFolder("细节", rootId);

    assert.deepEqual(
        useAssetStore.getState().folders.map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId })),
        [
            { id: rootId, name: "产品图", parentId: undefined },
            { id: childId, name: "细节", parentId: rootId },
        ],
    );
    assert.throws(() => useAssetStore.getState().createFolder("产品图"), /同级文件夹/);
    assert.throws(() => useAssetStore.getState().createFolder("不存在的父目录", "missing"), /不存在/);

    useAssetStore.setState({ assets: [], folders: [] });
});

test("moves a private image only to an existing folder or the root", () => {
    const folder: PrivateAssetFolder = { id: "folder-1", name: "图片", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
    useAssetStore.setState({ assets: [imageAsset("image-1")], folders: [folder] });

    useAssetStore.getState().moveAsset("image-1", "folder-1");
    assert.equal(useAssetStore.getState().assets[0]?.folderId, "folder-1");
    assert.throws(() => useAssetStore.getState().moveAsset("image-1", "missing"), /不存在/);

    useAssetStore.getState().moveAsset("image-1");
    assert.equal(useAssetStore.getState().assets[0]?.folderId, undefined);

    useAssetStore.setState({ assets: [], folders: [] });
});

test("rejects unknown folder IDs from generic private asset writes", () => {
    const folder: PrivateAssetFolder = { id: "folder-1", name: "图片", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
    const { id, createdAt, updatedAt, ...input } = imageAsset("image-1");
    useAssetStore.setState({ assets: [imageAsset("image-1")], folders: [folder] });

    assert.throws(() => useAssetStore.getState().addAsset({ ...input, folderId: "missing" }), /不存在/);
    assert.throws(() => useAssetStore.getState().updateAsset("image-1", { folderId: "missing" }), /不存在/);

    useAssetStore.getState().updateAsset("image-1", { folderId: "folder-1", metadata: { source: "test" } });
    assert.equal(useAssetStore.getState().assets[0]?.folderId, "folder-1");
    assert.deepEqual(useAssetStore.getState().assets[0]?.metadata, { source: "test" });

    useAssetStore.setState({ assets: [], folders: [] });
});

test("renames a private image without changing its media metadata", () => {
    const image = { ...imageAsset("image-1", "原名称"), metadata: { mediaId: "media-1" } };
    useAssetStore.setState({ assets: [image], folders: [] });

    useAssetStore.getState().renameImageAsset("image-1", "  新名称  ");

    const renamed = useAssetStore.getState().assets[0];
    assert.equal(renamed?.title, "新名称");
    assert.deepEqual(renamed?.metadata, { mediaId: "media-1" });
    assert.throws(() => useAssetStore.getState().renameImageAsset("image-1", " "), /1–64/);

    useAssetStore.setState({ assets: [], folders: [] });
});

test("renames an empty private folder and rejects deleting a folder with contents", () => {
    const parent: PrivateAssetFolder = { id: "parent", name: "父目录", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
    const child: PrivateAssetFolder = { id: "child", name: "子目录", parentId: parent.id, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
    const empty: PrivateAssetFolder = { id: "empty", name: "空目录", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
    useAssetStore.setState({ assets: [{ ...imageAsset("image-1"), folderId: parent.id }], folders: [parent, child, empty] });

    useAssetStore.getState().renameFolder(empty.id, "  新目录  ");
    assert.equal(useAssetStore.getState().folders.find((folder) => folder.id === empty.id)?.name, "新目录");
    assert.throws(() => useAssetStore.getState().removeFolder(parent.id), /包含图片或子文件夹/);

    useAssetStore.getState().removeFolder(empty.id);
    assert.equal(
        useAssetStore.getState().folders.some((folder) => folder.id === empty.id),
        false,
    );
    useAssetStore.setState({ assets: [], folders: [] });
});

test("hydrates folders with the active user scope while legacy assets remain in the root", async () => {
    const persistedFolders: PrivateAssetFolder[] = [{ id: "folder-1", name: "项目", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" }];
    const options = useAssetStore.persist.getOptions();
    const storage = {
        getItem: async () => ({ state: { assets: [imageAsset("legacy-image")], folders: persistedFolders } }) as never,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    };

    useAssetStore.setState({ assets: [imageAsset("other-user")], folders: [] });
    useAssetStore.persist.setOptions({ storage: storage as never });

    try {
        await useAssetStore.getState().hydrate("portal-user");

        assert.deepEqual(
            useAssetStore.getState().folders.map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId })),
            [{ id: "folder-1", name: "项目", parentId: undefined }],
        );
        assert.equal(useAssetStore.getState().assets[0]?.folderId, undefined);
    } finally {
        useAssetStore.persist.setOptions(options);
        useAssetStore.setState({ assets: [], folders: [] });
    }
});

test("hydrating a user scope does not persist an empty asset list before reading it", async () => {
    const persistedAssets: Asset[] = [
        {
            id: "persisted-image",
            kind: "text",
            title: "保留的素材",
            coverUrl: "",
            tags: [],
            data: { content: "素材" },
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:00:00.000Z",
        },
    ];
    const writes: StorageValue<unknown>[] = [];
    const options = useAssetStore.persist.getOptions();
    const storage = {
        getItem: async () => ({ state: { assets: persistedAssets } }) as never,
        setItem: async (_name: string, value: StorageValue<unknown>) => {
            writes.push(value);
        },
        removeItem: async () => undefined,
    };

    useAssetStore.setState({ assets: [] });
    useAssetStore.persist.setOptions({ storage: storage as never });

    try {
        await useAssetStore.getState().hydrate("test-user");

        assert.deepEqual(useAssetStore.getState().assets, persistedAssets);
        assert.deepEqual(writes, []);
    } finally {
        useAssetStore.persist.setOptions(options);
        useAssetStore.setState({ assets: [] });
    }
});

test("hydrating an empty user scope clears the previous user's assets without writing an empty list", async () => {
    const previousAsset: Asset = {
        id: "another-user-image",
        kind: "text",
        title: "不应泄露的素材",
        coverUrl: "",
        tags: [],
        data: { content: "private" },
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
    };
    const writes: StorageValue<unknown>[] = [];
    const options = useAssetStore.persist.getOptions();
    const storage = {
        getItem: async () => null,
        setItem: async (_name: string, value: StorageValue<unknown>) => {
            writes.push(value);
        },
        removeItem: async () => undefined,
    };

    useAssetStore.setState({ assets: [previousAsset] });
    useAssetStore.persist.setOptions({ storage: storage as never });

    try {
        await useAssetStore.getState().hydrate("new-user");

        assert.deepEqual(useAssetStore.getState().assets, []);
        assert.deepEqual(writes, []);
    } finally {
        useAssetStore.persist.setOptions(options);
        useAssetStore.setState({ assets: [] });
    }
});
