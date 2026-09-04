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
