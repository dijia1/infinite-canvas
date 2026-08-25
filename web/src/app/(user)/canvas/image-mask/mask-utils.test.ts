import assert from "node:assert/strict";
import test from "node:test";

import { appendMaskStroke, drawImageMask, hasImageMask, normalizeImageMask } from "./mask-utils.ts";

test("image masks keep normalized circular paint and erase strokes in drawing order", () => {
    const painted = appendMaskStroke(undefined, { id: "paint", tool: "paint", radius: 0.04, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] });
    const edited = appendMaskStroke(painted, { id: "erase", tool: "erase", radius: 0.08, points: [{ x: 0.2, y: 0.3 }] });

    assert.equal(hasImageMask(edited), true);
    assert.deepEqual(edited.strokes.map((stroke) => stroke.tool), ["paint", "erase"]);
    assert.deepEqual(edited.strokes[0].points[1], { x: 0.3, y: 0.4 });
});

test("image masks discard invalid strokes and clamp persisted normalized coordinates", () => {
    const normalized = normalizeImageMask({
        version: 1,
        strokes: [
            { id: "valid", tool: "paint", radius: 2, points: [{ x: -1, y: 2 }, { x: 0.5, y: 0.5 }] },
            { id: "invalid", tool: "rectangle", radius: 0.1, points: [{ x: 0.1, y: 0.1 }] },
        ],
    });

    assert.ok(normalized);
    assert.equal(normalized.strokes.length, 1);
    assert.equal(normalized.strokes[0].radius, 0.5);
    assert.deepEqual(normalized.strokes[0].points[0], { x: 0, y: 1 });
});

test("image masks draw circular paint before erasing with normalized radii", () => {
    const commands: string[] = [];
    const context = {
        clearRect: () => commands.push("clear"),
        save: () => commands.push("save"),
        restore: () => commands.push("restore"),
        beginPath: () => commands.push("begin"),
        moveTo: (x: number, y: number) => commands.push(`move:${x},${y}`),
        lineTo: (x: number, y: number) => commands.push(`line:${x},${y}`),
        stroke: () => commands.push("stroke"),
        arc: (x: number, y: number, radius: number) => commands.push(`arc:${x},${y},${radius}`),
        fill: () => commands.push("fill"),
        globalCompositeOperation: "source-over",
        strokeStyle: "",
        fillStyle: "",
        lineCap: "butt",
        lineJoin: "miter",
        lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;

    drawImageMask(context, { version: 1, strokes: [{ id: "paint", tool: "paint", radius: 0.1, points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }] }, { id: "erase", tool: "erase", radius: 0.05, points: [{ x: 0.6, y: 0.7 }] }] }, 200, 100, "#fff");

    assert.deepEqual(commands, ["clear", "save", "begin", "move:40,30", "line:80,50", "stroke", "begin", "arc:120,70,5", "fill", "restore"]);
});
