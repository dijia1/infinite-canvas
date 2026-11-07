import assert from "node:assert/strict";
import test from "node:test";

import { sourceBehavior } from "@/test-utils/source-behavior";
import { clearPendingWorkflowRetryRequest, ensureWorkflowRetryRequest, pendingWorkflowRetryKey, workflowRetryWasAccepted, writePendingWorkflowRetryRequest } from "./workflow-run-requests";

const uncertain = { nodeId: "image", slotId: "output", status: "uncertain", attempt: 1 };

test("editor asks before uncertain regeneration and submits confirmation only after acceptance", async () => {
    const calls: unknown[][] = [];
    let confirm: { onOk: () => Promise<void>; content: string } | undefined;
    const start = sourceBehavior(new URL("./workflow-editor.tsx", import.meta.url), {
        pendingWorkflowRetryKey,
        retryingKeys: new Set(),
        setRetryingKeys: () => undefined,
        runs: {
            detailsByRunId: new Map([["run", { outputs: [uncertain] }]]),
            retry: async (...args: unknown[]) => { calls.push(args); },
        },
        modal: { confirm: (value: typeof confirm) => { confirm = value; } },
        message: { success: () => undefined, error: (error: unknown) => { throw error; } },
    }).named("startOutputRetry") as (run: string, node: string, slot: string) => Promise<void>;
    await start("run", "image", "output");
    assert.deepEqual(calls, []);
    assert.match(confirm!.content, /可能重复扣费/);
    await confirm!.onOk();
    assert.deepEqual(calls, [["run", "image", "output", true]]);
});

test("history also waits for user confirmation and persists it with the retry identity", () => {
    const calls: unknown[] = [];
    let confirm: { onOk: () => void } | undefined;
    const start = sourceBehavior(new URL("./workflow-run-history.tsx", import.meta.url), {
        detail: { data: { run: { id: "run" }, outputs: [uncertain] } },
        pendingRetryRequests: {},
        ownerUID: undefined,
        pendingWorkflowRetryKey,
        ensureWorkflowRetryRequest,
        nanoid: () => "confirmed-request",
        setPendingRetryRequests: () => undefined,
        retry: { mutate: (request: unknown) => calls.push(request) },
        modal: { confirm: (value: typeof confirm) => { confirm = value; } },
    }).named("startRetry") as (node: string, slot: string) => void;
    start("image", "output");
    assert.deepEqual(calls, []);
    confirm!.onOk();
    assert.deepEqual(calls, [{ runId: "run", nodeId: "image", slotId: "output", attempt: 1, confirmUncertain: true, requestId: "confirmed-request" }]);
});

test("a lost retry response reuses the same request and confirmation without another paid attempt", async () => {
    const calls: unknown[] = [];
    let sequence = 0;
    const pending = new Map();
    const next = { run: { id: "run" }, outputs: [{ ...uncertain, status: "waiting", attempt: 2 }] };
    const retry = sourceBehavior(new URL("./use-workflow-runs.ts", import.meta.url), {
        useCallback: (callback: unknown) => callback,
        identityRef: { current: "owner/workflow" },
        withOperation: async (_: string, operation: () => Promise<unknown>) => operation(),
        ownerUID: "confirmation-test-owner",
        workflowId: "workflow",
        pendingWorkflowRetryKey,
        pendingRetriesRef: { current: pending },
        readPendingWorkflowRetryRequests: () => [],
        browserSessionStorage: () => undefined,
        detailsByRunId: new Map([["run", { outputs: [uncertain] }]]),
        findWorkflowOutput: (outputs: typeof uncertain[]) => outputs[0],
        queryClient: { invalidateQueries: () => undefined },
        workflowRunDetailQueryKey: () => [],
        workflowRetryWasAccepted,
        clearPendingWorkflowRetryRequest,
        ensureWorkflowRetryRequest,
        nanoid: () => `request-${++sequence}`,
        writePendingWorkflowRetryRequest,
        setPendingRetryKeys: () => undefined,
        retryWorkflowOutput: async (_: string, request: unknown) => {
            calls.push(request);
            if (calls.length === 1) throw new Error("response lost");
            return next;
        },
        assertCurrent: () => undefined,
        isDefinitiveWorkflowMutationError: () => false,
        setSelectedRunId: () => undefined,
        updateCachedDetail: () => undefined,
    }).named("retry") as (run: string, node: string, slot: string, confirmed?: boolean) => Promise<unknown>;
    await assert.rejects(retry("run", "image", "output", true), /response lost/);
    assert.equal(pending.size, 1);
    assert.deepEqual(await retry("run", "image", "output"), next);
    assert.equal(pending.size, 0);
    assert.equal(sequence, 1);
    assert.deepEqual(calls, [1, 2].map(() => ({ requestId: "request-1", nodeId: "image", slotId: "output", confirmUncertain: true })));
});
