import assert from "node:assert/strict";
import test from "node:test";

import { collectDroppedImageFiles, importDroppedImageFiles, layoutDroppedImageGrid } from "./canvas-file-drop.ts";

function image(name: string, type = "image/png") {
    return { name, type } as File;
}

test("collects image files in source order and caps one drop at twenty", () => {
    const files = [image("first.png"), image("note.txt", "text/plain"), ...Array.from({ length: 21 }, (_, index) => image(`image-${index}.png`))];

    const result = collectDroppedImageFiles(files);

    assert.equal(result.files.length, 20);
    assert.equal(result.files[0]?.name, "first.png");
    assert.equal(result.files[19]?.name, "image-18.png");
    assert.equal(result.omittedCount, 2);
});

test("lays a single image at the drop point and batches around it on a fixed grid", () => {
    assert.deepEqual(layoutDroppedImageGrid(1, { x: 400, y: 300 }), [{ x: 400, y: 300 }]);
    assert.deepEqual(layoutDroppedImageGrid(3, { x: 400, y: 300 }), [
        { x: 64, y: -36 },
        { x: 736, y: -36 },
        { x: 64, y: 636 },
    ]);
});

test("imports a batch with at most three concurrent uploads and keeps successful node IDs in source order", async () => {
    const files = [image("one.png"), image("two.png"), image("broken.png"), image("four.png"), image("five.png")];
    let active = 0;
    let peak = 0;

    const result = await importDroppedImageFiles(files, { x: 0, y: 0 }, async (file) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (file.name === "broken.png") throw new Error("upload failed");
        return `node:${file.name}`;
    });

    assert.equal(peak, 3);
    assert.equal(result.failedCount, 1);
    assert.equal(result.omittedCount, 0);
    assert.deepEqual(result.nodeIds, ["node:one.png", "node:two.png", "node:four.png", "node:five.png"]);
});
