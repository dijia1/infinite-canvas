// Bundle with Bun and serve locally with the built CSS and sample.mp4.
// All API calls are mocked; this entry cannot contact a paid provider.
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import axios, { type AxiosResponse } from "axios";
import { flashVideoModel } from "./flash-video";
import { useThemeStore } from "@/stores/use-theme-store";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { reconcileVideoConfig } from "@/lib/video-config";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/features/canvas/types";
import { CanvasConfigNodePanel } from "@/features/canvas/components/canvas-config-node-panel";
import { CanvasVideoContent, VideoResourceProvider } from "@/features/canvas/components/canvas-video-content";
import { buildNodeGenerationInputs, buildNodeGenerationContext } from "@/features/canvas/components/canvas-node-generation";
import { useCanvasGeneration } from "@/features/canvas/hooks/use-canvas-generation";
import { WorkflowConfigPanel } from "@/features/workflows/workflow-config-panel";
import { aiConfigForWorkflowNode, workflowModelInputError } from "@/features/workflows/workflow-config";
import { createWorkflowNode } from "@/features/workflows/workflow-graph";
import { requestVideoGeneration } from "@/services/api/video";
import type { WorkflowNode } from "@/features/workflows/types";

const standard = { ...flashVideoModel, id: "standard", name: "Seedance 2.5", type: "maizi-video-seedance-2-5", videoRequestSchema: { ...flashVideoModel.videoRequestSchema!, supportsDraft: true, maxReferenceImages: 30, maxReferenceVideos: 10, maxReferenceMedia: undefined, maxReferenceVideoDuration: 0, resolutions: [...flashVideoModel.videoRequestSchema!.resolutions, { value: "1080p", label: "1080p", price: "4.2" }] } };
const status = { imageAvailable: false, imageEditable: false, videoAvailable: true, defaultVideoModelId: "flash", imageModels: [], videoModels: [flashVideoModel, standard] };
useConfigStore.setState({ status, config: { ...defaultConfig, videoProviderId: "flash", vquality: "480p", videoSize: "16:9" } });
useThemeStore.setState({ theme: "dark" });
const noop = () => {};
const blocked = async () => { throw new Error("隔离验收阻止了无关请求"); };
let sequence = 0;
const requests: Record<string, any>[] = [];
const tasks = new Map<string, any>();
const access = (id: string) => ({ mediaId: id, url: "/sample.mp4", contentType: "video/mp4", width: 640, height: 360, duration: 5, bytes: 1000, expiresAt: "2099-01-01T00:00:00Z" });
axios.defaults.adapter = async config => {
    let data: unknown;
    if (config.method === "post" && String(config.url).endsWith("/videos")) {
        const input = JSON.parse(config.data);
        if (input.providerId === "flash" && (input.mode || input.sourceDraftTaskId || !["480p", "720p"].includes(input.resolution) || (input.imageMediaIds?.length || 0) + (input.videoMediaIds?.length || 0) > 6)) throw new Error("模拟供应商拒绝非法 Flash 请求");
        requests.push(input);
        const id = `mock-video-${++sequence}`;
        data = { id, status: "succeeded", progress: 100, resultMediaIds: [id], videos: [access(id)] };
        tasks.set(id, data);
        document.getElementById("requests")!.textContent = JSON.stringify(requests);
    } else if (String(config.url).includes("/media/") && String(config.url).endsWith("/access")) data = access(String(config.url).split("/").at(-2)!);
    else throw new Error(`隔离验收阻止了请求：${config.method} ${config.url}`);
    return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data } } as AxiosResponse;
};

const inputNodes = (imageCount: number, videoCount: number): CanvasNodeData[] => [
    { id: "prompt", type: CanvasNodeType.Text, title: "提示词", position: { x: 0, y: 0 }, width: 200, height: 80, metadata: { content: "拍摄一段产品展示视频" } },
    ...Array.from({ length: imageCount }, (_, i) => ({ id: `image-${i}`, type: CanvasNodeType.Image, title: `图${i + 1}`, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { mediaId: `reference-${i % 2}`, content: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#44403c"/><text x="40" y="46" text-anchor="middle" fill="white">${i + 1}</text></svg>`)}` } })),
    ...Array.from({ length: videoCount }, (_, i) => ({ id: `video-${i}`, type: CanvasNodeType.Video, title: `参考视频${i + 1}`, position: { x: 0, y: 0 }, width: 100, height: 60, metadata: { mediaId: `reference-video-${i}`, duration: 5 } })),
];
const connected = (inputs: CanvasNodeData[]): CanvasConnection[] => inputs.map(n => ({ id: `edge-${n.id}`, fromNodeId: n.id, toNodeId: "config" }));
const initialInputs = inputNodes(3, 3);
const initialConfig: CanvasNodeData = { id: "config", type: CanvasNodeType.Config, title: "视频配置", position: { x: 0, y: 0 }, width: 360, height: 274, metadata: { generationMode: "video", videoProviderId: "standard", videoMode: "draft", sourceDraftTaskId: "old-sample", vquality: "480p", videoSize: "16:9", seconds: "5" } };

function Harness() {
    const { message } = App.useApp();
    const [nodes, setNodes] = useState([...initialInputs, initialConfig]);
    const [connections, setConnections] = useState(connected(initialInputs));
    const [workflow, setWorkflow] = useState<WorkflowNode>({ ...createWorkflowNode("video_generation", { x: 0, y: 0 }, "workflow"), config: { providerId: "flash", size: "16:9", resolution: "480p", seconds: 5 } });
    const [workflowResult, setWorkflowResult] = useState("");
    const [compact, setCompact] = useState(false);
    const nodesRef = useRef(nodes), connectionsRef = useRef(connections);
    nodesRef.current = nodes;
    connectionsRef.current = connections;
    const controller = useCanvasGeneration({
        nodesRef, connectionsRef, setNodes, setConnections,
        effectiveConfig: useConfigStore.getState().config, defaultConfig,
        getVideoModelStatus: () => status, isAiConfigReady: () => true, openConfigDialog: noop, message,
        setSelectedNodeIds: noop, setSelectedConnectionId: noop, setDialogNodeId: noop, setAngleNodeId: noop,
        createId: () => `output-${++sequence}`, createConfigNode: () => initialConfig,
        requestVideoGeneration, requestGeneration: blocked, requestEdit: blocked, getImageTask: blocked, getImageTaskByClientRequest: blocked, resumeImageTask: blocked, uploadImage: blocked, uploadMediaFile: blocked,
        hydrateGenerationContext: async id => buildNodeGenerationContext(id, nodesRef.current, connectionsRef.current, ""),
    });
    const configNode = nodes.find(n => n.id === "config")!;
    const inputs = buildNodeGenerationInputs(configNode.id, nodes, connections);
    const counts = { image: inputs.filter(i => i.type === "image").length, video: inputs.filter(i => i.type === "video").length, text: inputs.filter(i => i.type === "text").length };
    useLayoutEffect(() => { document.getElementById("document")!.textContent = JSON.stringify({ canvas: configNode.metadata, workflow: workflow.config, results: nodes.filter(n => n.id.startsWith("output-")).map(n => n.metadata) }); }, [configNode, nodes, workflow]);
    const changeInputs = (images: number, videos: number) => {
        const next = inputNodes(images, videos);
        setNodes(previous => [...next, ...previous.filter(n => n.id === "config" || n.id.startsWith("output-"))]);
        setConnections(previous => [...connected(next), ...previous.filter(e => e.fromNodeId === "config")]);
    };
    return <VideoResourceProvider projectId="flash-isolated" nodeIds={nodes.map(n => n.id)}>
        <main className="min-h-screen bg-stone-950 p-6 text-stone-100">
            <h1 className="mb-4 text-lg">Seedance 2.5 Flash · 隔离验收</h1>
            <div className="mb-5 flex gap-4 text-sm">
                <span>模拟接口，不产生付费请求</span>
                <button onClick={() => changeInputs(0, 0)}>纯文本</button>
                <button onClick={() => changeInputs(6, 0)}>6 张图</button>
                <button onClick={() => changeInputs(3, 3)}>3 图 + 3 视频</button>
                <button onClick={() => changeInputs(4, 3)}>7 个素材</button>
                <button onClick={() => setCompact(!compact)}>切换 LOD</button>
            </div>
            <p className="mb-4 text-sm">输入：{counts.image} 张图、{counts.video} 个视频、{counts.text} 条文本</p>
            <div className="flex items-start gap-10">
                <section>
                    <h2 className="mb-3">我的画布</h2>
                    <div data-testid="canvas-config" className="relative rounded-2xl border border-stone-600 bg-stone-800" style={{ width: 360, height: 274, "--config-card-design-scale": 1 } as React.CSSProperties}>
                        <CanvasConfigNodePanel node={configNode} compact={compact} inputs={inputs} inputSummary={{ textCount: counts.text, imageCount: counts.image }} onConfigChange={(id, patch) => setNodes(p => p.map(n => n.id === id ? { ...n, metadata: { ...n.metadata, ...patch } } : n))} onTextInputChange={noop} onGenerate={id => void controller.generateNode(id, "video", "")} />
                    </div>
                    {nodes.filter(n => n.id.startsWith("output-")).map(n => <div key={n.id} className="mt-4" style={{ width: 420, height: 236 }}><CanvasVideoContent nodeId={n.id} mediaId={n.metadata?.mediaId} showGenerationFooter={false} /></div>)}
                </section>
                <section>
                    <h2 className="mb-3">自动化流程</h2>
                    <div data-testid="workflow-config" className="relative rounded-2xl border border-stone-600 bg-stone-800" style={{ width: 360, height: 274, "--config-card-design-scale": 1 } as React.CSSProperties}>
                        <WorkflowConfigPanel node={workflow} compact={compact} inputs={inputs.map(i => ({ key: i.nodeId, sourceNodeId: i.nodeId, type: i.type, text: i.text, mediaId: i.image?.mediaId || i.video?.mediaId }))} onConfigChange={config => setWorkflow(p => ({ ...p, config }))} onOutputCountChange={noop} onPreview={noop} />
                    </div>
                    <button className="mt-4 rounded border border-stone-600 px-4 py-2" onClick={async () => {
                        try {
                            const error = workflowModelInputError("video_generation", counts, status.videoModels.find(m => m.id === workflow.config?.providerId));
                            if (error) throw new Error(error);
                            const config = reconcileVideoConfig(aiConfigForWorkflowNode(workflow, defaultConfig), status);
                            const result = await requestVideoGeneration(config, "拍摄一段产品展示视频", inputs.flatMap(i => i.image ? [i.image] : []), `workflow-${++sequence}`, inputs.flatMap(i => i.video?.mediaId ? [i.video.mediaId] : []));
                            setWorkflowResult(result.resultMediaIds[0]);
                        } catch (error) { message.error(error instanceof Error ? error.message : "运行失败"); }
                    }}>运行流程（模拟）</button>
                    {workflowResult ? <div className="mt-4" style={{ width: 420, height: 236 }}><CanvasVideoContent nodeId="workflow-result" mediaId={workflowResult} /></div> : null}
                </section>
            </div>
        </main>
    </VideoResourceProvider>;
}
createRoot(document.getElementById("app")!).render(<ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><Harness /></App></ConfigProvider>);
