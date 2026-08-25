import assert from "node:assert/strict";
import test from "node:test";

import { imageEditReferenceError } from "./image-edit-validation.ts";
import type { ReferenceImage } from "@/types/image";

function reference(id: string, masked = false): ReferenceImage {
    return {
        id,
        name: `${id}.png`,
        type: "image/png",
        dataUrl: `data:image/png;base64,${id}`,
        ...(masked
            ? {
                  mask: { version: 1, strokes: [{ id: `${id}-stroke`, tool: "paint", radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }] },
              }
            : {}),
    };
}

test("accepts one masked main image followed by up to six ordered references", () => {
    assert.equal(imageEditReferenceError([reference("main", true)]), undefined);
    assert.equal(imageEditReferenceError([reference("main", true), ...Array.from({ length: 6 }, (_, index) => reference(`ref-${index}`))]), undefined);
});

test("rejects more than seven edit images and invalid mask placement", () => {
    assert.equal(imageEditReferenceError(Array.from({ length: 8 }, (_, index) => reference(`image-${index}`))), "图像编辑需要 1–7 张参考图");
    assert.equal(imageEditReferenceError([reference("main"), reference("masked", true)]), "带遮罩的主图必须位于第一张参考图");
    assert.equal(imageEditReferenceError([reference("main", true), reference("second", true)]), "图像编辑只能使用一个遮罩");
});
