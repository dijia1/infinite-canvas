import assert from "node:assert/strict";
import test from "node:test";

import { createWorkflowRunRequestLimiter, workflowRunDetailQueryKey, workflowRunOverviewQueryKey, workflowRunRelevantDetailIds } from "./use-workflow-runs";
import type { WorkflowRunState } from "./types";

const overview: WorkflowRunState = {
    workflowId: "workflow",
    revision: 8,
    scopes: [],
    nodeRunIds: { a: "run-a", b: "run-b", hidden: "run-hidden" },
    activeRuns: { items: [], total: 0, page: 1, pageSize: 20 },
};

test("query identities include both owner and workflow scopes", () => {
    assert.notDeepEqual(workflowRunOverviewQueryKey("owner-a", "workflow"), workflowRunOverviewQueryKey("owner-b", "workflow"));
    assert.notDeepEqual(workflowRunDetailQueryKey("owner", "workflow-a", "run"), workflowRunDetailQueryKey("owner", "workflow-b", "run"));
});

test("detail loading is bounded to visible node sources and the explicitly selected history run", () => {
    assert.deepEqual(workflowRunRelevantDetailIds(overview, new Set(["a", "b"]), "run-history"), ["run-a", "run-b", "run-history"]);
    assert.deepEqual(workflowRunRelevantDetailIds(overview, new Set(), undefined), []);
    assert.deepEqual(workflowRunRelevantDetailIds(undefined, new Set(["a"]), "run-history"), ["run-history"]);
});

test("detail request limiter never starts more than four loads concurrently", async () => {
    const limiter = createWorkflowRunRequestLimiter(4);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 7 }, (_, index) =>
        limiter.run(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => (releases[index] = resolve));
            active--;
            return index;
        }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(active, 4);
    for (let index = 0; index < 7; index++) {
        releases[index]?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(peak, 4);
});

test("an aborted queued detail never consumes a request slot", async () => {
    const limiter = createWorkflowRunRequestLimiter(1);
    const first = Promise.withResolvers<void>();
    let called = false;
    const controller = new AbortController();
    const active = limiter.run(() => first.promise);
    const queued = limiter.run(async () => {
        called = true;
    }, controller.signal);
    controller.abort();
    await assert.rejects(queued, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    first.resolve();
    await active;
    assert.equal(called, false);
});
