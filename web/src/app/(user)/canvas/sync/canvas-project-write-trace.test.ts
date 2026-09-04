import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasProjectWriteTracer } from "./canvas-project-write-trace.ts";

test("keeps one tab identity while issuing UUID request IDs and diagnostic sequence numbers", () => {
    const tracer = createCanvasProjectWriteTracer({
        createTabId: () => "tab-7",
        createRequestId: (sequence) => `c75e2ccf-40e9-4d29-bbb9-b5de9ee39d7${sequence}`,
    });

    assert.deepEqual(tracer.next("autosave"), { tabId: "tab-7", requestId: "c75e2ccf-40e9-4d29-bbb9-b5de9ee39d71", requestSeq: 1, reason: "autosave" });
    assert.deepEqual(tracer.next("retry"), { tabId: "tab-7", requestId: "c75e2ccf-40e9-4d29-bbb9-b5de9ee39d72", requestSeq: 2, reason: "retry" });
    assert.equal(tracer.tabId, "tab-7");
});
