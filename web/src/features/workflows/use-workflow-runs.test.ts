import assert from "node:assert/strict";
import test from "node:test";

import { sourceBehavior } from "@/test-utils/source-behavior";
import { createWorkflowRunRequestLimiter, workflowRunDetailQueryKey, workflowRunOverviewQueryKey, workflowRunRelevantDetailIds } from "./use-workflow-runs";
import type { WorkflowRunState } from "./types";

const overview: WorkflowRunState = {
    workflowId: "workflow",
    revision: 8,
    scopes: [],
    nodeRunIds: { a: "run-a", b: "run-b", hidden: "run-hidden" },
    activeRuns: { items: [], total: 0, page: 1, pageSize: 20 },
};
const sourceURL = new URL("./use-workflow-runs.ts", import.meta.url);

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

test("resume video uses the original task ID and refreshes workflow state", async () => {
    const resumed: string[] = [];
    const invalidated: unknown[] = [];
    const resumeVideo = sourceBehavior(sourceURL, {
        useCallback: (callback: unknown) => callback,
        identityRef: { current: "owner/workflow" },
        withOperation: async (_identity: string, operation: () => Promise<unknown>) => operation(),
        ownerUID: "owner",
        workflowId: "workflow",
        resumeVideoTask: async (taskID: string) => {
            resumed.push(taskID);
            return { id: taskID };
        },
        assertCurrent: () => undefined,
        queryClient: { invalidateQueries: (value: unknown) => invalidated.push(value) },
        workflowRunOverviewQueryKey,
    }).named("resumeVideo") as (taskID: string) => Promise<{ id: string }>;

    assert.deepEqual(await resumeVideo("original-video-task"), { id: "original-video-task" });
    assert.deepEqual(resumed, ["original-video-task"]);
    assert.deepEqual(invalidated, [
        { queryKey: workflowRunOverviewQueryKey("owner", "workflow") },
        { queryKey: ["workflow-run", "owner", "workflow"] },
    ]);
});
