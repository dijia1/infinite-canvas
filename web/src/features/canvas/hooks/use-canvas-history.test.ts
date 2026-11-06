import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasHistoryController } from "./use-canvas-history";

type Snapshot = { value: number };

function createScheduler() {
    let nextId = 0;
    const callbacks = new Map<number, () => void>();

    return {
        schedule(callback: () => void) {
            const id = nextId++;
            callbacks.set(id, callback);
            return id;
        },
        clear(id: number) {
            callbacks.delete(id);
        },
        flush() {
            const pending = Array.from(callbacks.values());
            callbacks.clear();
            pending.forEach((callback) => callback());
        },
    };
}

test("commits one debounced snapshot and clears redo after a new edit", () => {
    const scheduler = createScheduler();
    const applied: Snapshot[] = [];
    let applicationId = 0;
    const controller = createCanvasHistoryController<Snapshot>({
        applySnapshot: (snapshot, id) => { applicationId = id; applied.push(snapshot); },
        schedule: scheduler.schedule,
        clear: scheduler.clear,
        isSameSnapshot: (left, right) => left.value === right.value,
    });

    controller.replaceBaseline({ value: 0 });
    controller.observe({ value: 1 });
    controller.observe({ value: 2 });
    scheduler.flush();

    assert.deepEqual(controller.getRetainedHistory().history.past, [{ value: 0 }]);
    assert.equal(controller.canUndo, true);

    controller.undo();
    assert.deepEqual(applied, [{ value: 0 }]);
    controller.completeApplication(applicationId);
    assert.equal(controller.canRedo, true);

    controller.observe({ value: 3 });
    scheduler.flush();

    assert.deepEqual(controller.getRetainedHistory().history, { past: [{ value: 0 }], future: [] });
    assert.equal(controller.canRedo, false);
});

test("does not record changes while paused and resumes from the final drag state", () => {
    const scheduler = createScheduler();
    let applicationId = 0;
    const controller = createCanvasHistoryController<Snapshot>({
        applySnapshot: (_snapshot, id) => { applicationId = id; },
        schedule: scheduler.schedule,
        clear: scheduler.clear,
        isSameSnapshot: (left, right) => left.value === right.value,
    });

    controller.replaceBaseline({ value: 0 });
    controller.pause();
    controller.observe({ value: 1 });
    controller.observe({ value: 2 });
    scheduler.flush();
    controller.resume();
    controller.observe({ value: 3 });
    scheduler.flush();

    assert.deepEqual(controller.getRetainedHistory().history, { past: [{ value: 0 }], future: [] });
    assert.equal(controller.canUndo, true);
});

test("bounds undo history to fifty snapshots and reset clears both stacks", () => {
    const scheduler = createScheduler();
    let applicationId = 0;
    const controller = createCanvasHistoryController<Snapshot>({
        applySnapshot: (_snapshot, id) => { applicationId = id; },
        schedule: scheduler.schedule,
        clear: scheduler.clear,
        isSameSnapshot: (left, right) => left.value === right.value,
    });

    controller.replaceBaseline({ value: 0 });
    for (let value = 1; value <= 51; value += 1) {
        controller.observe({ value });
        scheduler.flush();
    }

    assert.equal(controller.getRetainedHistory().history.past.length, 50);

    controller.undo();
    controller.completeApplication(applicationId);
    controller.reset();

    assert.deepEqual(controller.getRetainedHistory().history, { past: [], future: [] });
    assert.equal(controller.canUndo, false);
    assert.equal(controller.canRedo, false);
});

test("resuming records the final drag snapshot even without another observe", () => {
    const applied: string[] = [];
    let applicationId = 0;
    const controller = createCanvasHistoryController<string>({ applySnapshot: (value, id) => { applicationId = id; applied.push(value); } });
    controller.observe("before");
    controller.pause();
    controller.observe("intermediate");
    controller.observe("after");
    controller.resume();
    controller.undo();
    assert.deepEqual(applied, ["before"]);
    controller.completeApplication(applicationId);
    controller.redo();
    assert.deepEqual(applied, ["before", "after"]);
    controller.dispose();
});
