import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { GenerationTaskFeedback } from "@/components/generation-task-feedback";
import { generationTaskPresentation, regenerationNeedsConfirmation } from "./generation-task-state";

test("canvas and workflows distinguish retrying, paused, uncertain and failed tasks", () => {
    const retry = generationTaskPresentation("running", "限流", { kind: "transient", stage: "query", consecutiveFailures: 1, nextRetryAt: "2026-11-07T01:02:03Z" });
    assert.equal(retry.title, "查询异常，正在重试");
    assert.match(retry.message, /连续失败 1 次/);
    assert.match(retry.message, /下次重查/);
    assert.equal(generationTaskPresentation("paused", "密钥无效").title, "查询已暂停");
    assert.equal(generationTaskPresentation("uncertain", "", { kind: "missing", stage: "query", consecutiveFailures: 0 }).title, "原任务需要确认");
    assert.equal(generationTaskPresentation("uncertain").title, "提交结果待确认");
    assert.equal(generationTaskPresentation("failed", "模型不存在").title, "生成失败");
    assert.equal(regenerationNeedsConfirmation("failed"), false);
    assert.equal(regenerationNeedsConfirmation("paused"), true);
    assert.equal(regenerationNeedsConfirmation("uncertain"), true);
});

test("paused recovery separates querying from generating and a browser failure only offers reconnect", () => {
    const paused = renderToStaticMarkup(createElement(GenerationTaskFeedback, { status: "paused", onResume: () => {}, onRegenerate: () => {} }));
    assert.match(paused, /恢复查询/);
    assert.match(paused, /重新生成/);
    const disconnected = renderToStaticMarkup(createElement(GenerationTaskFeedback, { status: "running", connectionError: "请求超时", onReconnect: () => {}, onRegenerate: () => {} }));
    assert.match(disconnected, /连接中断/);
    assert.match(disconnected, /重新连接/);
    assert.doesNotMatch(disconnected, /重新生成|生成失败/);
});
