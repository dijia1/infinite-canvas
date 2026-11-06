import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { sourceBehavior } from "@/test-utils/source-behavior";

const drawerURL = new URL("./public-image-drawer.tsx", import.meta.url);
const capabilityURL = new URL("./use-public-asset-management-capability.ts", import.meta.url);

for (const allowed of [false, true]) {
    test(`public library operations ${allowed ? "execute with" : "reject without"} management capability`, async () => {
        const writes: unknown[][] = [];
        let invalidations = 0;
        const write = async (...args: unknown[]) => { writes.push(args); };
        const bindings = {
            canManagePublicAssets: allowed,
            currentFolderId: "parent",
            editorValue: " new title ",
            createAdminPublicImageFolder: write,
            updateAdminPublicImageFolder: write,
            updateAdminPublicImage: write,
            invalidatePublicLibrary: async () => { invalidations++; },
            setEditor() {},
            message: { success() {}, error(error: string) { assert.fail(error); } },
            readImageDropPayload: JSON.parse,
            PUBLIC_IMAGE_DRAG_TYPE: "public-image",
        };
        for (const editor of [{ kind: "folder" }, { kind: "folderRename", folder: { id: "folder-1" } }, { kind: "rename", image: { id: "image-1" } }]) {
            await sourceBehavior(drawerURL, { ...bindings, editor }).named("submitEditor")();
        }
        const source = sourceBehavior(drawerURL, bindings);
        await source.named("movePublicImage")({ id: "image-1" }, "destination");
        await source.named("handleFolderDrop")("drop-folder", { preventDefault() {}, stopPropagation() {}, dataTransfer: { getData: () => JSON.stringify({ id: "image-1" }) } });
        assert.deepEqual(writes, allowed ? [
            ["new title", "parent"], ["folder-1", "new title"], ["image-1", { title: "new title" }],
            ["image-1", { folderId: "destination" }], ["image-1", { folderId: "drop-folder" }],
        ] : []);
        assert.equal(invalidations, allowed ? 5 : 0);
    });

    test(`upload and delete clicks ${allowed ? "execute with" : "reject without"} management capability`, () => {
        const uploaded: File[] = [];
        const deleted: string[] = [];
        const source = sourceBehavior(drawerURL, {
            canManagePublicAssets: allowed,
            upload: { isPending: false, mutate: (file: File) => uploaded.push(file) },
            remove: { mutate: (id: string) => deleted.push(id) },
            imageContextMenu: { image: { id: "image-1" } },
            setImageContextMenu() {},
        });
        const handler = (attribute: string, call: string) => source.select((node) => ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === attribute && node.getText().includes(call));
        const file = new File([], "image.png", { type: "image/png" });
        handler("onChange", "upload.mutate")({ target: { files: [file], value: "selected" } });
        handler("onClick", "remove.mutate")();
        assert.deepEqual(uploaded, allowed ? [file] : []);
        assert.deepEqual(deleted, allowed ? ["image-1"] : []);
    });

    test(`folder deletion ${allowed ? "executes with" : "rejects without"} management capability`, async () => {
        const deleted: string[] = [];
        const folders: unknown[] = [];
        const completed = Promise.withResolvers<void>();
        const source = sourceBehavior(drawerURL, {
            canManagePublicAssets: allowed,
            folderContextMenu: { folder: { id: "folder-1", parentId: "parent" } },
            currentFolderId: "folder-1",
            setFolderContextMenu() {},
            setCurrentFolderId: (id: unknown) => folders.push(id),
            deleteAdminPublicImageFolder: async (id: string) => { deleted.push(id); },
            invalidatePublicLibrary: async () => undefined,
            message: { success: () => completed.resolve(), error: (error: string) => completed.reject(new Error(error)) },
        });
        source.select((node) => ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "onClick" && node.getText().includes("deleteAdminPublicImageFolder"))();
        if (allowed) await completed.promise;
        assert.deepEqual(deleted, allowed ? ["folder-1"] : []);
        assert.deepEqual(folders, allowed ? ["parent"] : []);
    });

    test(`paste upload listener ${allowed ? "accepts files" : "is not installed"} for the current capability`, () => {
        const listeners = new Map<string, (event: unknown) => void>();
        const uploaded: File[] = [];
        const file = new File([], "paste.png", { type: "image/png" });
        const source = sourceBehavior(drawerURL, {
            open: true, canManagePublicAssets: allowed,
            drawerPointerInsideRef: { current: true }, isEditableTarget: () => false,
            clipboardImageFile: () => file,
            upload: { isPending: false, mutate: (value: File) => uploaded.push(value) },
            window: {
                addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
                removeEventListener: (name: string) => listeners.delete(name),
            },
        });
        const effect = source.select((node) => ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.expression.getText() === "useEffect" && node.getText().includes("handlePasteKeyDown"));
        const dispose = effect();
        listeners.get("paste")?.({ target: {}, clipboardData: { items: [] }, preventDefault() {} });
        assert.deepEqual(uploaded, allowed ? [file] : []);
        dispose?.();
        assert.equal(listeners.size, 0);
    });
}

test("public asset management capability is fail-closed until the current opening has a fresh successful response", async () => {
    let capability: typeof import("./use-public-asset-management-capability");
    try {
        capability = await import(capabilityURL.href);
    } catch (error) {
        assert.fail(`public asset capability helper is missing: ${String(error)}`);
    }

    const freshAllow = {
        open: true,
        openingId: 2,
        confirmedOpeningId: 2,
        isFetching: false,
        isError: false,
        canManagePublicAssets: true,
    };

    assert.equal(capability.hasFreshPublicAssetManagementCapability({ ...freshAllow, confirmedOpeningId: 1 }), false, "cached allow from a prior opening must be ignored");
    assert.equal(capability.hasFreshPublicAssetManagementCapability({ ...freshAllow, isFetching: true }), false, "an in-flight refresh must stay readonly");
    assert.equal(capability.hasFreshPublicAssetManagementCapability({ ...freshAllow, isError: true }), false, "a failed refresh must stay readonly");
    assert.equal(capability.hasFreshPublicAssetManagementCapability({ ...freshAllow, canManagePublicAssets: false }), false, "a normal member must stay readonly");
    assert.equal(capability.hasFreshPublicAssetManagementCapability({ ...freshAllow, open: false }), false, "a closed drawer must stay readonly");
    assert.equal(capability.hasFreshPublicAssetManagementCapability(freshAllow), true, "a fresh manager response must allow management");
});
