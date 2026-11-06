import { withCanvasProjectLocks } from "./canvas-project-editor-lease";
import assert from "node:assert/strict";
import test from "node:test";

import { canvasProjectEditorLeaseKey, claimCanvasProjectEditorLease, readCanvasProjectEditorLease, type CanvasProjectEditorLeaseStorage } from "./canvas-project-editor-lease.ts";

class MemoryLeaseStorage implements CanvasProjectEditorLeaseStorage {
    private readonly values = new Map<string, string>();

    getItem(key: string) {
        return this.values.get(key) || null;
    }

    setItem(key: string, value: string) {
        this.values.set(key, value);
    }

    removeItem(key: string) {
        this.values.delete(key);
    }
}

test("fallback lease keeps a follower readonly until the owner lease expires", () => {
    const storage = new MemoryLeaseStorage();
    const key = canvasProjectEditorLeaseKey("project-1");

    assert.equal(claimCanvasProjectEditorLease(storage, key, "tab-1", 1_000, 60_000), true);
    assert.equal(claimCanvasProjectEditorLease(storage, key, "tab-2", 2_000, 60_000), false);
    assert.deepEqual(readCanvasProjectEditorLease(storage, key), { tabId: "tab-1", expiresAt: 61_000 });
    assert.equal(claimCanvasProjectEditorLease(storage, key, "tab-2", 61_001, 60_000), true);
    assert.deepEqual(readCanvasProjectEditorLease(storage, key), { tabId: "tab-2", expiresAt: 121_001 });
});

test("library mutations wait for the same editor lock and multi-canvas locks use a fixed order", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const held = new Set<string>(),
        names: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) => {
                    names.push(name);
                    if (held.has(name)) return callback(null);
                    held.add(name);
                    try {
                        return await callback({});
                    } finally {
                        held.delete(name);
                    }
                },
            },
        },
    });
    const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    try {
        const editing = withCanvasProjectLocks(["a"], "editor", async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        await assert.rejects(
            withCanvasProjectLocks(["a"], "library", async () => {
                assert.fail("mutated an active editor");
            }),
            /另一标签页/,
        );
        release.resolve();
        await editing;
        names.length = 0;
        await withCanvasProjectLocks(["b", "a", "a"], "library", async () => {});
        assert.deepEqual(names, ["infinite-canvas:project-editor:a", "infinite-canvas:project-editor:b"]);
    } finally {
        release.resolve();
        if (original) Object.defineProperty(globalThis, "navigator", original);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});
