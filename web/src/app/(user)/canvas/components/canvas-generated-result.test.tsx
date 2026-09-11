import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { isGeneratedImageResult, generatedImageDetails, clearGeneratedImageIdentity } from "../utils/canvas-generated-result";
import { CanvasNodeResultPanel } from "./canvas-node-result-panel";
import { canvasThemes } from "@/lib/canvas-theme";

const result: CanvasNodeData = { id: "r", type: CanvasNodeType.Image, title: "r", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { generationType: "edit", status: "success", mediaId: "m", prompt: "生成提示词", imageProviderId: "model-a", size: "1:1", resolution: "2k", outputFormat: "jpeg", quality: "auto" } };

test("only completed generated images use the result panel, without mistaking replaced historical images for results", () => {
    assert.equal(isGeneratedImageResult(result), true);
    for (const patch of [{ generationType: undefined }, { status: "loading" }, { status: "error" }, { mediaId: undefined }]) {
        assert.equal(isGeneratedImageResult({ ...result, metadata: { ...result.metadata, ...patch } } as CanvasNodeData), false);
    }
    assert.equal(isGeneratedImageResult({ ...result, metadata: { ...result.metadata, generationType: undefined, imageTaskId: "old-task" } }), false);
    assert.equal(isGeneratedImageResult({ ...result, type: CanvasNodeType.Video }), false);
    assert.equal(isGeneratedImageResult({ ...result, metadata: { mediaId: "asset", prompt: "AI素材提示词", assetId: "asset" } }), false);
});

test("replacement clears generated identity while preserving unrelated input settings", () => {
    const cleaned = clearGeneratedImageIdentity({ ...result.metadata, imageTaskId: "old", imageTaskClientRequestId: "request", imageProviderName: "旧模型", fontSize: 16 });
    assert.equal(isGeneratedImageResult({ ...result, metadata: cleaned }), false);
    assert.equal(cleaned.imageProviderName, undefined);
    assert.equal(cleaned.imageTaskId, undefined);
    assert.equal(cleaned.imageTaskClientRequestId, undefined);
    assert.equal(cleaned.fontSize, 16);
    assert.equal(result.metadata?.generationType, "edit");
});

test("details prefer submitted provider options and never supply missing defaults", () => {
    const details = generatedImageDetails({ ...result.metadata, imageProviderName: "生成时名称", providerOptions: { size: "16:9", quality: "high", resolution: "4k" } }, [{ id: "model-a", name: "后来改名" }]);
    assert.equal(details.model, "生成时名称");
    assert.deepEqual(details.parameters.map(p => p.value), ["16:9", "4K", "JPEG", "高"]);
    const legacy = generatedImageDetails({ imageProviderId: "deleted" }, [{ id: "default", name: "默认模型" }]);
    assert.equal(legacy.model, "deleted");
    assert.deepEqual(legacy.parameters.map(p => p.value), ["未记录", "未记录", "未记录", "未记录"]);
    assert.equal(generatedImageDetails({ imageProviderId: "model-a" }, [{ id: "model-a", name: "精确匹配" }]).model, "精确匹配");
    assert.equal(generatedImageDetails({ outputFormat: "webp" }).parameters[2].value, "WEBP");
    assert.equal(generatedImageDetails({ outputFormat: "jpeg", providerOptions: { outputFormat: "png" } }).parameters[2].value, "PNG");
});

test("result markup contains readonly prompt and four parameters without generation controls", () => {
    for (const theme of [canvasThemes.dark, canvasThemes.light]) {
        const markup = renderToStaticMarkup(<CanvasNodeResultPanel details={generatedImageDetails(result.metadata)} theme={theme} />);
        assert.ok(markup.includes("生成提示词"));
        for (const label of ["比例", "分辨率", "格式", "质量", "复制提示词"]) assert.ok(markup.includes(label));
        assert.ok(!markup.includes("textarea"));
        assert.ok(!markup.includes("contenteditable"));
        assert.ok(!markup.includes("背景"));
        assert.ok(!markup.includes('aria-label="生成"'));
        assert.ok(markup.includes('aria-label="生成参数"'));
    }
});
