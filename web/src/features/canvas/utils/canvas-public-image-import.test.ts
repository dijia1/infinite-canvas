import assert from "node:assert/strict";
import test from "node:test";
import { createPublicImageImportController } from "./canvas-public-image-import";

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}
const access = { mediaId: "personal-copy", sourceMediaId: "source", width: 1024, height: 512, bytes: 12, contentType: "image/png" };

test("public imports retry the same operation and commit only private references at the original drop point", async () => {
    const ids: string[] = [];
    const nodes: any[] = [];
    let attempt = 0;
    let scope = "canvas-A";
    const controller = createPublicImageImportController({
        importImage: async (_id, request) => {
            ids.push(request);
            if (attempt++ === 0) throw new Error("timeout");
            return access;
        },
        seedCache: async () => ({ url: "blob:cached", storageKey: "media:personal-copy", mediaId: access.mediaId, width: 1024, height: 512, bytes: 12, mimeType: "image/png" }),
        isCurrent: (s) => s === scope,
        commit: (n) => nodes.push(n),
        onStatus: () => {},
        newRequestId: () => "uuid",
        newNodeId: () => "node",
    });
    const operation = controller.start({ id: "public", mediaId: "source", title: "图" }, { x: 100, y: 200 }, scope);
    await operation.done;
    assert.equal(nodes.length, 0);
    await controller.retry(operation.id);
    assert.deepEqual(ids, ["uuid", "uuid"]);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].metadata.mediaId, "personal-copy");
    assert.equal(nodes[0].metadata.publicImageId, undefined);
    assert.equal(nodes[0].metadata.assetId, undefined);
    assert.equal(nodes[0].metadata.content, "blob:cached");
    assert.equal(nodes[0].position.x + nodes[0].width / 2, 100);
    assert.equal(nodes[0].position.y + nodes[0].height / 2, 200);
});
test("cancel, scope changes and lost permission prevent late import writes", async () => {
    for (const action of ["cancel", "navigate", "readonly", "dispose"]) {
        const response = deferred<typeof access>();
        let allowed = true;
        const nodes: any[] = [];
        const controller = createPublicImageImportController({
            importImage: () => response.promise,
            seedCache: async () => null,
            isCurrent: () => allowed,
            commit: (n) => nodes.push(n),
            onStatus: () => {},
            newRequestId: () => "uuid",
            newNodeId: () => "node",
        });
        const operation = controller.start({ id: "public", mediaId: "source", title: "图" }, { x: 5, y: 6 }, "canvas");
        if (action === "cancel") controller.cancel(operation.id);
        else if (action === "dispose") controller.dispose();
        else allowed = false;
        response.resolve(access);
        await operation.done;
        assert.equal(nodes.length, 0, action);
    }
});
test("completion merges into current editor state and repeated retry does not duplicate nodes", async () => {
    const response = deferred<typeof access>();
    const nodes: any[] = [{ id: "existing" }];
    let calls = 0;
    const controller = createPublicImageImportController({
        importImage: () => {
            calls++;
            return response.promise;
        },
        seedCache: async () => null,
        isCurrent: () => true,
        commit: (n) => nodes.push(n),
        onStatus: () => {},
        newRequestId: () => "uuid",
        newNodeId: () => "new",
    });
    const operation = controller.start({ id: "public", mediaId: "source", title: "图" }, { x: 5, y: 6 }, "canvas");
    nodes.push({ id: "edited-while-copying" });
    await controller.retry(operation.id);
    response.resolve(access);
    await operation.done;
    await controller.retry(operation.id);
    assert.deepEqual(
        nodes.map((n) => n.id),
        ["existing", "edited-while-copying", "new"],
    );
    assert.equal(calls, 1);
});
