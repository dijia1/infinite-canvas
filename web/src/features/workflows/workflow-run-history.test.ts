import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

import { sourceBehavior } from "@/test-utils/source-behavior";
import type { WorkflowRunDetail } from "./types";

const historyURL = new URL("./workflow-run-history.tsx", import.meta.url);

test("owner changes remount history content and an old mutation completion stays in its captured owner cache", async () => {
    const historyContent = (ownerUID: string) => sourceBehavior(historyURL, {
        ownerUID,
        WorkflowRunHistoryContent: "history-content",
    }).select((node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "WorkflowRunHistoryContent") as { key: string };
    assert.equal(historyContent("owner-a").key, "owner-a");
    assert.equal(historyContent("owner-b").key, "owner-b");

    const writes: unknown[][] = [];
    const invalidations: unknown[] = [];
    const updateForOwnerA = sourceBehavior(historyURL, {
        ownerUID: "owner-a",
        queryClient: {
            setQueryData: (...args: unknown[]) => writes.push(args),
            invalidateQueries: (value: unknown) => invalidations.push(value),
        },
    }).named("updateDetail") as (detail: WorkflowRunDetail) => void;
    const deferred = Promise.withResolvers<WorkflowRunDetail>();
    const completed = deferred.promise.then(updateForOwnerA);
    deferred.resolve({ run: { id: "run-a" } } as WorkflowRunDetail);
    await completed;
    assert.deepEqual(writes[0]?.[0], ["workflow-run", "owner-a", "run-a"]);
    assert.equal(invalidations.length, 1);
});
