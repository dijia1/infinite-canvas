import assert from "node:assert/strict";
import test from "node:test";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { elements } from "@/test-utils/source-component";

const source = new URL("./asset-picker-modal.tsx", import.meta.url);
const privateMediaSource = sourceBehavior(source).named("privateMediaSource");
const assets = [
    { id: "upload-image", kind: "image", title: "upload", metadata: { mediaSource: "upload" } },
    { id: "upload-video", kind: "video", title: "upload", metadata: { mediaSource: "upload" } },
    { id: "generated-image", kind: "image", title: "generated", metadata: { mediaSource: "generated" } },
    { id: "generated-video", kind: "video", title: "generated", folderId: "folder", metadata: { mediaSource: "generated" } },
];
function cards(currentSystemSource?: string, currentFolderId?: string, keyword = "") {
    let states = 0;
    const Tab = sourceBehavior(source, {
        useState: (initial: unknown) => [states++ === 0 ? keyword : initial, () => {}], useMemo: (fn: () => unknown) => fn(), useEffect() {},
        privateMediaSource, PAGE_SIZE: 24, materialThumbnailGridClass: () => "grid-cols-4",
        MaterialDrawerToolbar: "toolbar", PrivateSystemFolderTree: "system", MaterialFolderBreadcrumbs: "breadcrumbs", MaterialFolderTree: "folders", MaterialVideoCard: "video-card", PickerCard: "image-card", Empty: "empty", Pagination: "pagination",
    }).named("MyAssetsTab");
    const tree = Tab({ assets, folders: [], currentSystemSource, currentFolderId, thumbnailStage: 1 });
    return elements(tree, node => node.type === "image-card" || node.type === "video-card").map(node => (node.props as any).asset.id);
}

test("AI image and video categories are separate and retain moved assets", () => {
    assert.deepEqual(cards("generated_image"), ["generated-image"]);
    assert.deepEqual(cards("generated_video"), ["generated-video"]);
    assert.deepEqual(cards("upload"), ["upload-image", "upload-video"]);
});

test("folder and keyword filters apply to both media types", () => {
    assert.deepEqual(cards(undefined, "folder"), ["generated-video"]);
    assert.deepEqual(cards("generated_video", undefined, "missing"), []);
});
