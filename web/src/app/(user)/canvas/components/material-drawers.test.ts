import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentURL = (name: string) => new URL(`./${name}`, import.meta.url);

test("my assets drawer is an image-only library with a file picker", async () => {
    const source = await readFile(componentURL("asset-picker-modal.tsx"), "utf8");

    assert.match(source, /asset\.kind === "image"/);
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

test("public assets use the same discrete grid and card ratio as my assets", async () => {
    const [source, privateSource] = await Promise.all([readFile(componentURL("public-image-drawer.tsx"), "utf8"), readFile(componentURL("asset-picker-modal.tsx"), "utf8")]);

    assert.match(source, /gridColumnClass\(thumbnailStage\)/);
    assert.match(privateSource, /gridColumnClass\(thumbnailStage\)/);
    assert.match(source, /aspect-\[4\/3\]/);
    assert.match(source, /thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4/);
});

test("material drawers reuse the same search and upload toolbar", async () => {
    const [myAssets, publicAssets, toolbar] = await Promise.all([readFile(componentURL("asset-picker-modal.tsx"), "utf8"), readFile(componentURL("public-image-drawer.tsx"), "utf8"), readFile(componentURL("material-drawer-toolbar.tsx"), "utf8")]);

    assert.match(myAssets, /MaterialDrawerToolbar/);
    assert.match(publicAssets, /MaterialDrawerToolbar/);
    assert.match(myAssets, /MaterialThumbnailControl/);
    assert.match(publicAssets, /MaterialThumbnailControl/);
    assert.match(toolbar, /type="range"/);
    assert.match(toolbar, /min="0"[\s\S]*max="3"[\s\S]*step="1"/);
    assert.match(toolbar, /缩略图列数：/);
});

test("material toolbar keeps icon-only controls below the search row", async () => {
    const toolbar = await readFile(componentURL("material-drawer-toolbar.tsx"), "utf8");

    assert.match(toolbar, /aria-label="添加图片"/);
    assert.doesNotMatch(toolbar, />\s*添加图片\s*</);
    assert.doesNotMatch(toolbar, /<span className="shrink-0">缩略图列数<\/span>/);
    assert.doesNotMatch(toolbar, /\{materialThumbnailColumns\(thumbnailStage\)\} 列/);
    assert.match(toolbar, /justify-end/);
});

test("public assets keep pagination inside the shared content flow", async () => {
    const source = await readFile(componentURL("public-image-drawer.tsx"), "utf8");

    assert.doesNotMatch(source, /shrink-0 border-t/);
    assert.match(source, /total > PAGE_SIZE/);
});

test("material drawers reuse the shared shell and editable target helper", async () => {
    const [privateDrawer, publicDrawer, adminManager] = await Promise.all([
        readFile(componentURL("asset-picker-modal.tsx"), "utf8"),
        readFile(componentURL("public-image-drawer.tsx"), "utf8"),
        readFile(componentURL("../../../../app/(admin)/admin/assets/public-image-manager.tsx"), "utf8"),
    ]);

    assert.match(privateDrawer, /from "\.\/material-drawer"/);
    assert.match(publicDrawer, /from "\.\/material-drawer"/);
    assert.match(privateDrawer, /from "@\/lib\/editable-target"/);
    assert.match(publicDrawer, /from "@\/lib\/editable-target"/);
    assert.match(adminManager, /from "@\/lib\/editable-target"/);
});

test("material drawers remain mounted through their left-side close animation", async () => {
    const [shell, privateDrawer, publicDrawer] = await Promise.all([readFile(componentURL("material-drawer.tsx"), "utf8"), readFile(componentURL("asset-picker-modal.tsx"), "utf8"), readFile(componentURL("public-image-drawer.tsx"), "utf8")]);

    assert.match(shell, /requestAnimationFrame\(\(\) => \{\s*\w+ = window\.requestAnimationFrame/);
    assert.match(shell, /-translate-x-full/);
    assert.match(shell, /transition-\[translate,opacity\]/);
    assert.match(shell, /onTransitionEnd/);
    assert.match(privateDrawer, /open=\{open\}/);
    assert.match(publicDrawer, /open=\{open\}/);
    assert.doesNotMatch(privateDrawer, /if \(!open\) return null/);
    assert.doesNotMatch(publicDrawer, /if \(!open\) return null/);
});

test("material cards keep destructive actions in their context menus", async () => {
    const [privateDrawer, publicDrawer, imageAPI] = await Promise.all([
        readFile(componentURL("asset-picker-modal.tsx"), "utf8"),
        readFile(componentURL("public-image-drawer.tsx"), "utf8"),
        readFile(componentURL("../../../../services/api/image.ts"), "utf8"),
    ]);

    assert.match(privateDrawer, /onPreview/);
    assert.match(privateDrawer, /deleteUserImage/);
    assert.match(privateDrawer, /deleteStoredImages/);
    assert.match(privateDrawer, /if \(mediaId\) await deleteUserImage\(mediaId\);[\s\S]*removeAsset\(asset\.id\);[\s\S]*deleteStoredImages/);
    assert.match(publicDrawer, /deleteAdminPublicImage/);
    assert.match(publicDrawer, /\{isAdmin \?/);
    assert.match(privateDrawer, /imageContextMenu/);
    assert.match(publicDrawer, /imageContextMenu/);
    assert.doesNotMatch(privateDrawer, /<Maximize2/);
    assert.doesNotMatch(publicDrawer, /<Maximize2/);
    assert.doesNotMatch(privateDrawer, /<Trash2/);
    assert.doesNotMatch(publicDrawer, /<Trash2/);
    assert.match(imageAPI, /apiDelete<.*>\(`\/api\/v1\/media\/\$\{encodeURIComponent\(mediaId\)\}`\)/);
});

test("failed remote material previews render a broken state while retaining deletion", async () => {
    const [privateDrawer, publicDrawer] = await Promise.all([readFile(componentURL("asset-picker-modal.tsx"), "utf8"), readFile(componentURL("public-image-drawer.tsx"), "utf8")]);

    assert.match(privateDrawer, /ImageOff/);
    assert.match(publicDrawer, /ImageOff/);
    assert.match(privateDrawer, /图片已损坏/);
    assert.match(publicDrawer, /图片已损坏/);
    assert.match(privateDrawer, /setLoadFailed\(true\)/);
    assert.match(publicDrawer, /setLoadFailed\(true\)/);
    assert.match(privateDrawer, /draggable=\{Boolean\(preview\)\}/);
    assert.match(publicDrawer, /draggable=\{Boolean\(url\) && !loadFailed\}/);
    assert.match(privateDrawer, /void deleteImage\(imageContextMenu\.asset\)/);
    assert.match(publicDrawer, /remove\.mutate\(imageContextMenu\.image\.id\)/);
});

test("material drawers provide folder navigation and admin-only public management", async () => {
    const [privateDrawer, publicDrawer, toolbar, folderUI] = await Promise.all([
        readFile(componentURL("asset-picker-modal.tsx"), "utf8"),
        readFile(componentURL("public-image-drawer.tsx"), "utf8"),
        readFile(componentURL("material-drawer-toolbar.tsx"), "utf8"),
        readFile(componentURL("material-folder-ui.tsx"), "utf8"),
    ]);

    assert.match(privateDrawer, /MaterialFolderBreadcrumbs/);
    assert.match(privateDrawer, /MaterialFolderTree/);
    assert.match(privateDrawer, /createFolder\(value, currentFolderId\)/);
    assert.match(privateDrawer, /moveAsset\(payload\.assetId, folderId\)/);
    assert.match(privateDrawer, /renameImageAsset/);
    assert.match(privateDrawer, /effectAllowed = "copyMove"/);
    assert.match(privateDrawer, /folderPath\(folders, folder\.id\)/);
    assert.match(privateDrawer, /重命名/);
    assert.match(privateDrawer, /移动到文件夹/);
    assert.match(privateDrawer, /删除/);
    assert.match(publicDrawer, /fetchPublicImageFolders/);
    assert.match(publicDrawer, /createAdminPublicImageFolder/);
    assert.match(publicDrawer, /updateAdminPublicImage/);
    assert.match(publicDrawer, /if \(!isAdmin\) return/);
    assert.match(publicDrawer, /PUBLIC_IMAGE_DRAG_TYPE/);
    assert.match(publicDrawer, /imageContextMenu/);
    assert.match(publicDrawer, /effectAllowed = "copyMove"/);
    assert.match(publicDrawer, /folderPath\(folders, folder\.id\)/);
    assert.match(publicDrawer, /uploadAdminPublicImage\(file, file\.name, currentFolderId\)/);
    assert.doesNotMatch(publicDrawer, /updateAdminPublicImage\(item\.id, \{ folderId: currentFolderId \}\)/);
    assert.match(toolbar, /materialThumbnailColumns/);
    assert.match(folderUI, /MATERIAL_THUMBNAIL_COLUMNS = \[6, 4, 3, 2\]/);
    assert.match(folderUI, /DEFAULT_MATERIAL_THUMBNAIL_STAGE = 1/);
    assert.match(folderUI, /folderBreadcrumbs/);
    assert.match(folderUI, /export function folderPath/);
    assert.match(folderUI, /MaterialFolderTree/);
    assert.match(folderUI, /data-folder-id/);
});

test("material context menus render outside the transformed drawer and folders expand as a tree", async () => {
    const [privateDrawer, publicDrawer, folderUI] = await Promise.all([readFile(componentURL("asset-picker-modal.tsx"), "utf8"), readFile(componentURL("public-image-drawer.tsx"), "utf8"), readFile(componentURL("material-folder-ui.tsx"), "utf8")]);

    assert.match(privateDrawer, /MaterialContextMenu/);
    assert.match(publicDrawer, /MaterialContextMenu/);
    assert.match(folderUI, /createPortal/);
    assert.match(folderUI, /document\.body/);
    assert.match(folderUI, /aria-expanded/);
    assert.match(folderUI, /onNavigate\(folder\.id\)/);
});

test("folder rows show an icon and use a context menu for rename and safe deletion", async () => {
    const [privateDrawer, publicDrawer, folderUI] = await Promise.all([readFile(componentURL("asset-picker-modal.tsx"), "utf8"), readFile(componentURL("public-image-drawer.tsx"), "utf8"), readFile(componentURL("material-folder-ui.tsx"), "utf8")]);

    assert.match(folderUI, /Folder/);
    assert.match(folderUI, /onFolderContextMenu/);
    assert.match(privateDrawer, /renameFolder/);
    assert.match(privateDrawer, /removeFolder/);
    assert.match(publicDrawer, /updateAdminPublicImageFolder/);
    assert.match(publicDrawer, /deleteAdminPublicImageFolder/);
});
