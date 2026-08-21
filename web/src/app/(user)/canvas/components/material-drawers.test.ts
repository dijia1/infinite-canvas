import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentURL = (name: string) => new URL(`./${name}`, import.meta.url);

test("my assets drawer is an image-only library with a file picker", async () => {
    const source = await readFile(componentURL("asset-picker-modal.tsx"), "utf8");

    assert.match(source, /\.filter\(\(asset\) => asset\.kind === "image"\)/);
    assert.doesNotMatch(source, /kindOptions/);
    assert.doesNotMatch(source, /Tag\.CheckableTag/);
    assert.match(source, /type="file"/);
    assert.match(source, /loading=\{isUploading\}/);
    assert.doesNotMatch(source, /<span[^>]*>\{title\}<\/span>/);
});

test("my assets drawer takes image paste priority and keeps a local preview while uploading", async () => {
    const source = await readFile(componentURL("asset-picker-modal.tsx"), "utf8");
    const imageStorage = await readFile(componentURL("../../../../services/image-storage.ts"), "utf8");

    assert.match(source, /addEventListener\("keydown", handlePasteKeyDown, true\)/);
    assert.match(source, /event\.stopImmediatePropagation\(\)/);
    assert.match(source, /drawerPointerInsideRef\.current/);
    assert.match(source, /const image = await uploadImage\(file\)/);
    assert.match(source, /promoteImageStorageKey/);
    assert.match(source, /draggable/);
    assert.match(imageStorage, /export async function promoteImageStorageKey/);
});

test("public assets drawer only exposes uploads to Portal administrators", async () => {
    const source = await readFile(componentURL("public-image-drawer.tsx"), "utf8");
    const toolbar = await readFile(componentURL("material-drawer-toolbar.tsx"), "utf8");

    assert.match(source, /isAdmin/);
    assert.match(source, /type="file"/);
    assert.match(source, /isUploading=\{upload\.isPending\}/);
    assert.match(toolbar, /disabled=\{isUploading\}/);
    assert.doesNotMatch(source, /管理员可直接粘贴图片上传/);
    assert.doesNotMatch(source, /text-xs text-stone-700/);
});

test("public assets use the same compact grid and card ratio as my assets", async () => {
    const source = await readFile(componentURL("public-image-drawer.tsx"), "utf8");

    assert.match(source, /grid grid-cols-4 gap-3/);
    assert.match(source, /aspect-\[4\/3\]/);
    assert.match(source, /thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4/);
});

test("material drawers reuse the same search and upload toolbar", async () => {
    const myAssets = await readFile(componentURL("asset-picker-modal.tsx"), "utf8");
    const publicAssets = await readFile(componentURL("public-image-drawer.tsx"), "utf8");

    assert.match(myAssets, /MaterialDrawerToolbar/);
    assert.match(publicAssets, /MaterialDrawerToolbar/);
});

test("public assets keep pagination inside the shared content flow", async () => {
    const source = await readFile(componentURL("public-image-drawer.tsx"), "utf8");

    assert.doesNotMatch(source, /shrink-0 border-t/);
    assert.match(source, /\{total > PAGE_SIZE \? \(/);
});
