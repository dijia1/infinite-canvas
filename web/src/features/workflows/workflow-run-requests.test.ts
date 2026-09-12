import assert from "node:assert/strict";
import test from "node:test";

import { clearPendingWorkflowRetryRequest, clearPendingWorkflowRunRequest, ensureWorkflowRetryRequest, ensureWorkflowRunRequest, pendingWorkflowRetryKey, readPendingWorkflowRetryRequests, readPendingWorkflowRunRequest, workflowRetryWasAccepted, workflowRunScopeKey, writePendingWorkflowRetryRequest, writePendingWorkflowRunRequest } from "./workflow-run-requests";

test("reuses a run request id after a transport failure even if the editor changed", () => {
    let sequence = 0;
    const create = () => `request-${++sequence}`;
    const first = ensureWorkflowRunRequest(undefined, "workflow-1", 4, create);
    const replay = ensureWorkflowRunRequest(first, "workflow-1", 5, create);
    assert.equal(replay, first);
    assert.deepEqual(replay, { workflowId: "workflow-1", revision: 4, requestId: "request-1", scope: { type: "workflow" } });
});

test("persists unresolved ids per authenticated owner across component remounts", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    const run = { workflowId: "workflow-persisted", revision: 7, requestId: "run-request", scope: { type: "workflow" } as const };
    const retry = { runId: "run-persisted", nodeId: "node", slotId: "slot", attempt: 2, requestId: "retry-request" };
    writePendingWorkflowRunRequest(storage, "owner-a", run);
    writePendingWorkflowRetryRequest(storage, "owner-a", retry);
    assert.deepEqual(readPendingWorkflowRunRequest(storage, "owner-a", run.workflowId), run);
    assert.equal(readPendingWorkflowRunRequest(storage, "owner-b", run.workflowId), undefined);
    assert.deepEqual(readPendingWorkflowRetryRequests(storage, "owner-a", retry.runId), [retry]);
    assert.deepEqual(readPendingWorkflowRetryRequests(storage, "owner-b", retry.runId), []);
    clearPendingWorkflowRunRequest(storage, "owner-a", run.workflowId);
    clearPendingWorkflowRetryRequest(storage, "owner-a", retry);
    assert.equal(readPendingWorkflowRunRequest(storage, "owner-a", run.workflowId), undefined);
    assert.deepEqual(readPendingWorkflowRetryRequests(storage, "owner-a", retry.runId), []);
});

test("reuses one retry id until the server confirms the attempt increment", () => {
    let sequence = 0;
    const create = () => `retry-${++sequence}`;
    const input = { runId: "run-1", nodeId: "node-1", slotId: "slot-1", attempt: 2 };
    const first = ensureWorkflowRetryRequest(undefined, input, create);
    assert.equal(ensureWorkflowRetryRequest(first, input, create), first);
    assert.equal(workflowRetryWasAccepted(first, { attempt: 2 }), false);
    assert.equal(workflowRetryWasAccepted(first, { attempt: 3 }), true);
    const next = ensureWorkflowRetryRequest(undefined, { ...input, attempt: 3 }, create);
    assert.notEqual(next.requestId, first.requestId);
});

test("keeps retry identities collision free when legal ids contain colons", () => {
    assert.notEqual(pendingWorkflowRetryKey({ runId: "run", nodeId: "a:b", slotId: "c" }), pendingWorkflowRetryKey({ runId: "run", nodeId: "a", slotId: "b:c" }));
});

test("persists uncertain starts independently for each run scope", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    const workflow = { type: "workflow" } as const;
    const frameA = { type: "frame", frameId: "a:b" } as const;
    const frameB = { type: "frame", frameId: "a" } as const;
    const requests = [
        { workflowId: "workflow", revision: 4, requestId: "all", scope: workflow },
        { workflowId: "workflow", revision: 5, requestId: "a", scope: frameA },
        { workflowId: "workflow", revision: 6, requestId: "b", scope: frameB },
    ];
    for (const request of requests) writePendingWorkflowRunRequest(storage, "owner", request);
    assert.deepEqual(readPendingWorkflowRunRequest(storage, "owner", "workflow", workflow), requests[0]);
    assert.deepEqual(readPendingWorkflowRunRequest(storage, "owner", "workflow", frameA), requests[1]);
    assert.deepEqual(readPendingWorkflowRunRequest(storage, "owner", "workflow", frameB), requests[2]);
    assert.notEqual(workflowRunScopeKey(frameA), workflowRunScopeKey({ type: "frame", frameId: "a:b:" }));
    clearPendingWorkflowRunRequest(storage, "owner", "workflow", frameA);
    assert.equal(readPendingWorkflowRunRequest(storage, "owner", "workflow", frameA), undefined);
    assert.deepEqual(readPendingWorkflowRunRequest(storage, "owner", "workflow", frameB), requests[2]);
    clearPendingWorkflowRunRequest(storage, "owner", "workflow", workflow);
    clearPendingWorkflowRunRequest(storage, "owner", "workflow", frameB);
});

test("reads a legacy unscoped pending start only as a whole-workflow request", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    values.set("infinite-canvas:workflow-run-request:owner-legacy:workflow", JSON.stringify({ workflowId: "workflow", revision: 3, requestId: "legacy" }));
    assert.deepEqual(readPendingWorkflowRunRequest(storage, "owner-legacy", "workflow", { type: "workflow" }), {
        workflowId: "workflow", revision: 3, requestId: "legacy", scope: { type: "workflow" },
    });
    assert.equal(readPendingWorkflowRunRequest(storage, "owner-legacy", "workflow", { type: "frame", frameId: "frame" }), undefined);
});

test("does not reuse an uncertain start id for another scope", () => {
    let sequence = 0;
    const create = () => `request-${++sequence}`;
    const first = ensureWorkflowRunRequest(undefined, "workflow", 4, create, { type: "frame", frameId: "a" });
    const replay = ensureWorkflowRunRequest(first, "workflow", 9, create, { type: "frame", frameId: "a" });
    const other = ensureWorkflowRunRequest(first, "workflow", 4, create, { type: "frame", frameId: "b" });
    assert.equal(replay, first);
    assert.notEqual(other.requestId, first.requestId);
    assert.deepEqual(other.scope, { type: "frame", frameId: "b" });
});
