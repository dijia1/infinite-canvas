import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

import { emptyWorkflowGraph } from "@/features/workflows/workflow-graph";
import { ApiRequestError } from "./request";
import { copyWorkflow, createWorkflow, createWorkflowRun, deleteWorkflow, deleteWorkflowRun, fetchWorkflow, fetchWorkflowRun, fetchWorkflowRuns, fetchWorkflowRunState, fetchWorkflows, fetchWorkflowVideos, retryWorkflowOutput, stopWorkflowRun, updateWorkflow, workflowRunErrorData } from "./workflows";

test("uses the workflow definition CRUD contract including pagination and optimistic revisions", async () => {
    const originalRequest = axios.request;
    const requests: Array<{ url?: string; method?: string; params?: unknown; data?: unknown; headers?: unknown }> = [];
    axios.request = (async (config) => {
        requests.push(config);
        return { status: 200, data: { code: 0, data: config.method === "DELETE" ? true : {}, msg: "ok" } } as never;
    }) as typeof axios.request;
    const graph = emptyWorkflowGraph();

    try {
        await fetchWorkflows(2, 12);
        await fetchWorkflow("workflow/1");
        await fetchWorkflowVideos();
        await createWorkflow({ name: "新流程", graph });
        await updateWorkflow("workflow-1", { revision: 3, name: "更新流程", graph });
        await copyWorkflow("workflow-1", "流程副本");
        await deleteWorkflow("workflow-1", 4);

        assert.deepEqual(
            requests.map(({ url, method, params, data, headers }) => ({ url, method, params, data, headers })),
            [
                { url: "/api/v1/workflows", method: "GET", params: { page: 2, pageSize: 12 }, data: undefined, headers: undefined },
                { url: "/api/v1/workflows/workflow%2F1", method: "GET", params: undefined, data: undefined, headers: undefined },
                { url: "/api/v1/private-images", method: "GET", params: { kind: "video" }, data: undefined, headers: undefined },
                { url: "/api/v1/workflows", method: "POST", params: undefined, data: { name: "新流程", graph, frameSchemaVersion: 1 }, headers: { "Content-Type": "application/json" } },
                { url: "/api/v1/workflows/workflow-1", method: "PUT", params: undefined, data: { revision: 3, name: "更新流程", graph, frameSchemaVersion: 1 }, headers: { "Content-Type": "application/json" } },
                { url: "/api/v1/workflows/workflow-1/copy", method: "POST", params: undefined, data: { name: "流程副本" }, headers: { "Content-Type": "application/json" } },
                { url: "/api/v1/workflows/workflow-1", method: "DELETE", params: undefined, data: { revision: 4 }, headers: { "Content-Type": "application/json" } },
            ],
        );
    } finally {
        axios.request = originalRequest;
    }
});

test("uses the workflow run contract and preserves retry request ids across transport replays", async () => {
    const originalRequest = axios.request;
    const requests: Array<{ url?: string; method?: string; params?: unknown; data?: unknown }> = [];
    axios.request = (async (config) => {
        requests.push(config);
        return { status: 200, data: { code: 0, data: config.method === "DELETE" ? true : {}, msg: "ok" } } as never;
    }) as typeof axios.request;

    try {
        await createWorkflowRun("workflow/1", "run-click-1");
        await createWorkflowRun("workflow/1", "run-click-2", 7, { type: "frame", frameId: "frame/1" });
        await fetchWorkflowRuns(2, 20);
        await fetchWorkflowRuns(1, 1, "workflow/1");
        await fetchWorkflowRuns(3, 10, { workflowId: "workflow/1", scope: { type: "frame", frameId: "frame/1" }, active: true });
        const controller = new AbortController();
        await fetchWorkflowRunState("workflow/1", 2, 50, controller.signal);
        await fetchWorkflowRun("run/1", controller.signal);
        await stopWorkflowRun("run/1");
        const replay = { requestId: "retry-click-1", nodeId: "image-node", slotId: "output-a" };
        await retryWorkflowOutput("run/1", replay);
        await retryWorkflowOutput("run/1", replay);
        await retryWorkflowOutput("run/1", { ...replay, requestId: "retry-click-2" });
        await deleteWorkflowRun("run/1");

        assert.deepEqual(
            requests.map(({ url, method, params, data }) => ({ url, method, params, data })),
            [
                { url: "/api/v1/workflows/workflow%2F1/runs", method: "POST", params: undefined, data: { requestId: "run-click-1" } },
                { url: "/api/v1/workflows/workflow%2F1/runs", method: "POST", params: undefined, data: { requestId: "run-click-2", revision: 7, scope: { type: "frame", frameId: "frame/1" } } },
                { url: "/api/v1/workflow-runs", method: "GET", params: { page: 2, pageSize: 20 }, data: undefined },
                { url: "/api/v1/workflow-runs", method: "GET", params: { page: 1, pageSize: 1, workflowId: "workflow/1" }, data: undefined },
                { url: "/api/v1/workflow-runs", method: "GET", params: { page: 3, pageSize: 10, workflowId: "workflow/1", scopeType: "frame", frameId: "frame/1", active: 1 }, data: undefined },
                { url: "/api/v1/workflows/workflow%2F1/run-state", method: "GET", params: { activePage: 2, activePageSize: 50 }, data: undefined },
                { url: "/api/v1/workflow-runs/run%2F1", method: "GET", params: undefined, data: undefined },
                { url: "/api/v1/workflow-runs/run%2F1/stop", method: "POST", params: undefined, data: undefined },
                { url: "/api/v1/workflow-runs/run%2F1/retry", method: "POST", params: undefined, data: replay },
                { url: "/api/v1/workflow-runs/run%2F1/retry", method: "POST", params: undefined, data: replay },
                { url: "/api/v1/workflow-runs/run%2F1/retry", method: "POST", params: undefined, data: { ...replay, requestId: "retry-click-2" } },
                { url: "/api/v1/workflow-runs/run%2F1", method: "DELETE", params: undefined, data: undefined },
            ],
        );
    } finally {
        axios.request = originalRequest;
    }
});

test("narrows stable workflow run conflict data at the workflow API boundary", () => {
    const active = workflowRunErrorData(new ApiRequestError("active", 409, 1, { code: "workflow_run_scope_active", runId: "run-1" }));
    assert.deepEqual(active, { code: "workflow_run_scope_active", runId: "run-1" });
    assert.deepEqual(workflowRunErrorData(new ApiRequestError("revision", 400, 1, { code: "workflow_run_revision_required" })), { code: "workflow_run_revision_required" });
    assert.deepEqual(workflowRunErrorData(new ApiRequestError("conflict", 409, 1, { code: "workflow_revision_conflict" })), { code: "workflow_revision_conflict" });
    assert.equal(workflowRunErrorData(new ApiRequestError("other", 409, 1, { code: "unrelated_conflict" })), undefined);
    assert.equal(workflowRunErrorData(new Error("offline")), undefined);
});
