import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasViewportCommitScheduler } from "./canvas-viewport-commit-scheduler.ts";

test("samples high-frequency viewport updates at most once per interval and flushes the final position", () => {
    const commits: number[] = [];
    const scheduler = createCanvasViewportCommitScheduler({ minIntervalMs: 100, onCommit: (viewport) => commits.push(viewport.x) });

    scheduler.update({ x: 1, y: 0, k: 1 }, 0);
    scheduler.update({ x: 2, y: 0, k: 1 }, 16);
    scheduler.update({ x: 3, y: 0, k: 1 }, 99);
    scheduler.update({ x: 4, y: 0, k: 1 }, 100);
    scheduler.flush({ x: 5, y: 0, k: 1 }, 105);

    assert.deepEqual(commits, [1, 4, 5]);
});

test("does not emit a redundant final viewport when the latest position is already committed", () => {
    const commits: number[] = [];
    const scheduler = createCanvasViewportCommitScheduler({ onCommit: (viewport) => commits.push(viewport.x) });

    scheduler.update({ x: 1, y: 0, k: 1 }, 0);
    scheduler.flush({ x: 1, y: 0, k: 1 }, 10);

    assert.deepEqual(commits, [1]);
});

test("commits a horizontal or vertical pan once it moves half the render buffer before the interval", () => {
    const commits: Array<{ x: number; y: number }> = [];
    const scheduler = createCanvasViewportCommitScheduler({ minIntervalMs: 100, onCommit: (viewport) => commits.push({ x: viewport.x, y: viewport.y }) });

    scheduler.update({ x: 0, y: 0, k: 1 }, 0);
    scheduler.update({ x: 31, y: 0, k: 1 }, 10);
    scheduler.update({ x: 32, y: 0, k: 1 }, 11);
    scheduler.update({ x: 32, y: 31, k: 1 }, 12);
    scheduler.update({ x: 32, y: 32, k: 1 }, 13);

    assert.deepEqual(commits, [
        { x: 0, y: 0 },
        { x: 32, y: 0 },
        { x: 32, y: 32 },
    ]);
});

test("commits a zoom change of roughly five percent before the interval", () => {
    const commits: number[] = [];
    const scheduler = createCanvasViewportCommitScheduler({ minIntervalMs: 100, onCommit: (viewport) => commits.push(viewport.k) });

    scheduler.update({ x: 0, y: 0, k: 1 }, 0);
    scheduler.update({ x: 0, y: 0, k: 1.04 }, 10);
    scheduler.update({ x: 0, y: 0, k: 1.06 }, 11);

    assert.deepEqual(commits, [1, 1.06]);
});
