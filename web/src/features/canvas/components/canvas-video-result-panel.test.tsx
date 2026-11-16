import assert from "node:assert/strict";
import test from "node:test";
import { canvasThemes } from "@/lib/canvas-theme";
import { oneElement, sourceModule } from "@/test-utils/source-component";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { generatedVideoDetails, isGeneratedVideoResult } from "../utils/canvas-generated-result";
import { CanvasNodeResultPanel } from "./canvas-node-result-panel";
import type { CanvasVideoResultPanel } from "./canvas-video-result-panel";
import type { VideoGenerationSource } from "@/services/api/video";

const node: CanvasNodeData = { id: "library-video", type: CanvasNodeType.Video, title: "视频素材", position: { x: 0, y: 0 }, width: 420, height: 236, metadata: { mediaId: "library-media", status: "success" } };
const fallback = <div>原有视频输入面板</div>;

test("library drafts retain a final action based on verified media provenance without changing canvas metadata", () => {
    const source: VideoGenerationSource = { taskId: "sample-task", providerId: "seedance25", mode: "draft", createdAt: "2026-11-16T00:00:00Z", seconds: 5, size: "9:16", generateAudio: false };
    let queriedMedia: string | undefined;
    const { CanvasVideoResultPanel: Panel } = sourceModule<{ CanvasVideoResultPanel: typeof CanvasVideoResultPanel }>(new URL("./canvas-video-result-panel.tsx", import.meta.url), {
        "../utils/canvas-generated-result": { generatedVideoDetails, isGeneratedVideoResult },
        "./canvas-node-result-panel": { CanvasNodeResultPanel },
        "./canvas-video-content": { CanvasVideoFinalAction: "final-action", useVideoGenerationSource: (id: string | undefined) => { queriedMedia = id; return { generation: id ? source : undefined }; } },
    });
    const tree = Panel({ node, models: [{ id: "seedance25", name: "Seedance 2.5" }], theme: canvasThemes.dark, fallback });
    const panel = oneElement(tree, CanvasNodeResultPanel);
    assert.equal(queriedMedia, "library-media");
    assert.equal(panel.props.details.model, "Seedance 2.5");
    assert.deepEqual(panel.props.details.parameters.map((p: { value: string }) => p.value), ["480p", "9:16", "5 秒"]);
    assert.equal(panel.props.actions.props.mediaId, "library-media");
    assert.equal(node.metadata?.generationMode, undefined);
    const recorded = { ...node, metadata: { ...node.metadata, generationMode: "video" as const, videoProviderName: "生成时模型", vquality: "720p", seconds: "8" } };
    const historical = oneElement(Panel({ node: recorded, theme: canvasThemes.dark, fallback }), CanvasNodeResultPanel);
    assert.equal(queriedMedia, undefined, "recorded results should not fetch metadata to reconstruct their snapshot");
    assert.equal(historical.props.details.model, "生成时模型");
    assert.equal(historical.props.details.parameters[0].value, "720p");
});

test("unconfirmed and ordinary imported videos keep their input panel; legacy generated videos keep their information panel", () => {
    const { CanvasVideoResultPanel: Panel } = sourceModule<{ CanvasVideoResultPanel: typeof CanvasVideoResultPanel }>(new URL("./canvas-video-result-panel.tsx", import.meta.url), {
        "../utils/canvas-generated-result": { generatedVideoDetails, isGeneratedVideoResult },
        "./canvas-node-result-panel": { CanvasNodeResultPanel },
        "./canvas-video-content": { CanvasVideoFinalAction: "final-action", useVideoGenerationSource: () => ({}) },
    });
    const ordinary = Panel({ node, theme: canvasThemes.light, fallback });
    assert.equal(oneElement(ordinary, "div").props.children, "原有视频输入面板");
    const legacy = { ...node, metadata: { content: "/legacy.mp4", generationMode: "video" as const, prompt: "历史提示词" } };
    const historical = oneElement(Panel({ node: legacy, theme: canvasThemes.light, fallback }), CanvasNodeResultPanel);
    assert.equal(historical.props.details.prompt, "历史提示词");
    assert.equal(historical.props.actions, undefined);
});
