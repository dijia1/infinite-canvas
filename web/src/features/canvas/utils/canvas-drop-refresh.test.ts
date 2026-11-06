import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { collectDroppedImageFiles, importDroppedImageFiles } from "./canvas-file-drop.ts";

// Execute the actual page callback with UI dependencies supplied, without mounting
// the entire canvas/WebGL editor. This catches a refresh reintroduced in handleDrop.
test("batch local node completion selects nodes without requesting a remote catalog", async () => {
    const source = ts.createSourceFile("canvas.tsx", readFileSync(new URL("../editor/canvas-client-page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleDrop" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(callback);
    const compiled = ts.transpileModule(`const handler = ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    let refreshes = 0;
    let selected = new Set<string>();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const dependencies = {
        screenToCanvas: () => ({ x: 0, y: 0 }),
        readImageDropPayload: () => null,
        PRIVATE_IMAGE_DRAG_TYPE: "private",
        PUBLIC_IMAGE_DRAG_TYPE: "public",
        collectDroppedImageFiles,
        importDroppedImageFiles,
        createImageFileNode: async (file: File) => file.name,
        setSelectedNodeIds: (ids: Set<string>) => {
            selected = ids;
        },
        setSelectedConnectionId: () => undefined,
        setDialogNodeId: () => undefined,
        useAssetStore: {
            getState: () => ({
                refreshFromServer: async () => {
                    refreshes++;
                },
            }),
        },
        message: { success: finish, warning: finish },
    };
    const handler = new Function(...Object.keys(dependencies), `${compiled}\nreturn handler;`)(...Object.values(dependencies));
    handler({ preventDefault() {}, clientX: 0, clientY: 0, dataTransfer: { getData: () => "", files: Array.from({ length: 20 }, (_, i) => new File([], `${i}.png`, { type: "image/png" })) } });
    await completed;
    assert.equal(selected.size, 20);
    assert.equal(refreshes, 0);
});
