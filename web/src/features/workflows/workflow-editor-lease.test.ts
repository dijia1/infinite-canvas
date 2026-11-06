import assert from "node:assert/strict";
import test from "node:test";
import { claimCanvasProjectEditorLease } from "@/features/canvas/sync/canvas-project-editor-lease";
import { workflowEditorLeaseKey } from "./workflow-editor-lease";

test("workflow lease keys isolate users and avoid delimiter collisions", () => {
    assert.notEqual(workflowEditorLeaseKey("owner-a", "w"), workflowEditorLeaseKey("owner-b", "w"));
    assert.notEqual(workflowEditorLeaseKey("a:b", "c"), workflowEditorLeaseKey("a", "b:c"));
});

test("workflow fallback uses Canvas exclusivity and expiry semantics", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const key = workflowEditorLeaseKey("owner", "workflow");
    assert.equal(claimCanvasProjectEditorLease(storage, key, "tab-a", 0, 60_000), true);
    assert.equal(claimCanvasProjectEditorLease(storage, key, "tab-b", 1, 60_000), false);
    assert.equal(claimCanvasProjectEditorLease(storage, key, "tab-b", 60_001, 60_000), true);
    assert.equal(claimCanvasProjectEditorLease(storage, key, "tab-a", 60_002, 60_000), false);
});
