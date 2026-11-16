// Isolated browser harness: bundle with Bun, serve with the built app CSS and a
// local sample.mp4. Every API request is intercepted; no supplier is contacted.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import axios, { type AxiosResponse } from "axios";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/features/canvas/types";
import { CanvasConfigNodePanel } from "@/features/canvas/components/canvas-config-node-panel";
import { CanvasVideoContent, VideoResourceProvider } from "@/features/canvas/components/canvas-video-content";
import { useCanvasInteractions } from "@/features/canvas/hooks/use-canvas-interactions";
import { useCanvasGeneration } from "@/features/canvas/hooks/use-canvas-generation";
import { useCanvasHistory } from "@/features/canvas/hooks/use-canvas-history";
import { buildNodeGenerationInputs, buildNodeGenerationContext } from "@/features/canvas/components/canvas-node-generation";
import { requestVideoGeneration, type VideoGenerationSource } from "@/services/api/video";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { WorkflowConfigPanel } from "@/features/workflows/workflow-config-panel";
import { createWorkflowFinalStep } from "@/features/workflows/workflow-drafts";
import { emptyWorkflowGraph, createWorkflowNode } from "@/features/workflows/workflow-graph";
import type { WorkflowGraph } from "@/features/workflows/types";
import { useThemeStore } from "@/stores/use-theme-store";

const status = {
    imageAvailable: false,
    imageEditable: false,
    videoAvailable: true,
    defaultVideoModelId: "mock25",
    imageModels: [],
    videoModels: [
        {
            id: "mock25",
            name: "Seedance 2.5",
            type: "maizi-video-seedance-2-5",
            videoRequestSchema: {
                supportsDraft: true,
                resolutions: [
                    { value: "480p", label: "480p", price: "0.77" },
                    { value: "720p", label: "720p", price: "1.4" },
                    { value: "1080p", label: "1080p", price: "4.2" },
                ],
                aspectRatios: ["16:9", "9:16", "1:1"],
                minDuration: 4,
                maxDuration: 30,
                defaultDuration: 5,
                maxReferenceImages: 30,
                maxReferenceVideos: 10,
                maxReferenceVideoDuration: 0,
                supportsAudio: true,
            },
        },
    ],
};
useConfigStore.setState({ status, config: { ...defaultConfig, videoProviderId: "mock25", vquality: "480p", videoSize: "16:9" } });
useThemeStore.setState({ theme: "dark" });
let sequence = 0;
const tasks = new Map<string, { mode: string; seconds: number; size: string; generateAudio: boolean }>();
const access = (id: string) => {
    const t = tasks.get(id)!;
    return {
        mediaId: id,
        url: "/sample.mp4",
        contentType: "video/mp4",
        bytes: 50000,
        width: 640,
        height: 360,
        duration: t?.seconds || 5,
        expiresAt: "2099-01-01T00:00:00Z",
        videoGeneration: { taskId: id, providerId: "mock25", mode: t?.mode || "draft", createdAt: new Date().toISOString(), seconds: t?.seconds || 5, size: t?.size || "16:9", generateAudio: t?.generateAudio || false },
    };
};
axios.defaults.adapter = async (c) => {
    let data: unknown;
    if (c.method === "post" && String(c.url).endsWith("/videos")) {
        const input = JSON.parse(c.data);
        const id = `mock-task-${++sequence}`;
        const source = tasks.get(input.sourceDraftTaskId);
        tasks.set(id, { mode: input.mode || "", seconds: source?.seconds || input.seconds, size: source?.size || input.size, generateAudio: source?.generateAudio || input.generateAudio });
        data = { id, status: "succeeded", progress: 100, resultMediaIds: [id], videos: [access(id)] };
        document.getElementById("request")!.textContent = JSON.stringify(input, null, 2);
    } else if (String(c.url).includes("/media/") && String(c.url).endsWith("/access")) data = access(String(c.url).split("/").at(-2)!);
    else throw new Error(`Isolated test blocked request: ${c.method} ${c.url}`);
    return { data: { code: 0, data }, status: 200, statusText: "OK", headers: {}, config: c } as AxiosResponse;
};

const initial: CanvasNodeData[] = [0, 1, 2].map((i) => ({
    id: `image-${i}`,
    type: CanvasNodeType.Image,
    title: `图${i + 1}`,
    position: { x: 20, y: 35 + i * 145 },
    width: 120,
    height: 110,
    metadata: { mediaId: `reference-${i}`, content: "data:image/png;base64,AA==" },
}));
initial.push({ id: "text", type: CanvasNodeType.Text, title: "提示词", position: { x: 180, y: 30 }, width: 200, height: 70, metadata: { content: "拍摄一段产品短片" } });
initial.push({ id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 280, y: 160 }, width: 360, height: 274, metadata: { generationMode: "video", videoProviderId: "mock25", vquality: "480p", seconds: "5", videoSize: "16:9" } });

function Harness() {
    const { message } = App.useApp();
    const [nodes, setNodes] = useState(initial),
        [connections, setConnections] = useState<CanvasConnection[]>([{ id: "text-config", fromNodeId: "text", toNodeId: "config" }]);
    const [selected, setSelected] = useState(new Set(["image-0", "image-1", "image-2"]));
    const [workflow, setWorkflow] = useState<WorkflowGraph>(emptyWorkflowGraph());
    const [compact, setCompact] = useState(false);
    const stage = useRef<HTMLDivElement>(null),
        nodesRef = useRef(nodes),
        connectionsRef = useRef(connections),
        selectedRef = useRef(selected),
        viewportRef = useRef({ x: 0, y: 0, k: 1 });
    nodesRef.current = nodes;
    connectionsRef.current = connections;
    selectedRef.current = selected;
    const snapshot = useMemo(() => ({ nodes, connections }), [nodes, connections]);
    const history = useCanvasHistory({
        snapshot,
        isReady: true,
        applySnapshot: (s) => {
            setNodes(s.nodes);
            setConnections(s.connections);
        },
        isSameSnapshot: (a, b) => a.nodes === b.nodes && a.connections === b.connections,
    });
    const interactions = useCanvasInteractions({
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef: selectedRef,
        viewportRef,
        setNodes,
        setConnections,
        setSelectedNodeIds: setSelected,
        setSelectedConnectionId: () => {},
        pause: history.pause,
        resume: history.resume,
        screenToCanvas: (x, y) => {
            const r = stage.current!.getBoundingClientRect();
            return { x: x - r.left, y: y - r.top };
        },
        createConnectionId: () => `edge-${++sequence}`,
        createNode: (type, position) => ({ id: `created-${++sequence}`, type, title: "配置", position, width: 360, height: 274, metadata: { generationMode: "video", videoProviderId: "mock25", vquality: "480p", seconds: "5", videoSize: "16:9" } }),
    });
    const generation = useCanvasGeneration({
        nodesRef,
        connectionsRef,
        effectiveConfig: useConfigStore.getState().config,
        defaultConfig,
        isAiConfigReady: () => true,
        getVideoModelStatus: () => status,
        openConfigDialog: () => {},
        message,
        setNodes,
        setConnections,
        setSelectedNodeIds: setSelected,
        setSelectedConnectionId: () => {},
        setDialogNodeId: () => {},
        setAngleNodeId: () => {},
        createId: () => `node-${++sequence}`,
        createConfigNode: (position) => ({ ...initial[4]!, position }),
        requestVideoGeneration,
        requestGeneration: async () => {
            throw Error("No images in this harness");
        },
        requestEdit: async () => {
            throw Error("No images in this harness");
        },
        getImageTask: async () => {
            throw Error("No images in this harness");
        },
        getImageTaskByClientRequest: async () => {
            throw Error("No images");
        },
        resumeImageTask: async () => {
            throw Error("No images");
        },
        uploadImage: async () => {
            throw Error("No upload");
        },
        uploadMediaFile: async () => {
            throw Error("No upload");
        },
        hydrateGenerationContext: async (id) => buildNodeGenerationContext(id, nodesRef.current, connectionsRef.current, ""),
        getRemoteImage: async () => {
            throw Error("No image download");
        },
        getImageBlob: async () => {
            throw Error("No image download");
        },
    } as Parameters<typeof useCanvasGeneration>[0]);
    useLayoutEffect(() => {
        document.getElementById("document")!.textContent = JSON.stringify({
            connections: connections.map((c) => [c.fromNodeId, c.toNodeId]),
            videos: nodes.filter((n) => n.type === CanvasNodeType.Video).map((n) => n.metadata),
            workflowFrames: workflow.frames?.length || 0,
        });
    }, [nodes, connections, workflow]);
    return (
        <VideoResourceProvider projectId="isolated" nodeIds={nodes.map((n) => n.id)} onGenerateFinal={(id, source) => generation.generateFinalVideo(id, source)}>
            <div className="flex gap-3 p-4">
                <button onClick={history.undo}>撤销</button>
                <button onClick={history.redo}>重做</button>
                <button onClick={() => setCompact(!compact)}>切换 LOD</button>
                <span>隔离测试 · 模拟供应商</span>
            </div>
            <div ref={stage} className="relative" style={{ height: 560, minWidth: 1180, background: "#191816" }}>
                <svg className="absolute inset-0 h-full w-full" style={{ pointerEvents: "none" }}>
                    {connections.map((c) => {
                        const a = nodes.find((n) => n.id === c.fromNodeId)!,
                            b = nodes.find((n) => n.id === c.toNodeId)!;
                        return <path key={c.id} fill="none" stroke="#bbb" d={`M${a.position.x + a.width},${a.position.y + a.height / 2} L${b.position.x},${b.position.y + b.height / 2}`} />;
                    })}
                </svg>
                {nodes.map((n) => (
                    <div
                        key={n.id}
                        data-test-node={n.id}
                        className="absolute"
                        style={
                            {
                                left: n.position.x,
                                top: n.position.y,
                                width: n.width,
                                height: n.height,
                                border: `1px solid ${selected.has(n.id) ? "#5293ff" : "#777"}`,
                                borderRadius: 15,
                                background: "#282522",
                                "--config-card-design-scale": 1,
                            } as React.CSSProperties
                        }
                    >
                        {n.type === CanvasNodeType.Image ? (
                            <>
                                <button className="h-full w-full" aria-pressed={selected.has(n.id)} onClick={() => setSelected((s) => new Set(s.has(n.id) ? [...s].filter((id) => id !== n.id) : [...s, n.id]))}>
                                    {n.title}
                                </button>
                                <button
                                    aria-label={`连接${n.title}`}
                                    style={{ position: "absolute", right: -8, top: "48%", width: 16, height: 16, borderRadius: 20, background: "#ddd" }}
                                    onPointerDown={(e) => interactions.handleConnectStart(e, n.id, "source")}
                                />
                            </>
                        ) : n.type === CanvasNodeType.Config ? (
                            <CanvasConfigNodePanel
                                node={n}
                                compact={compact}
                                inputs={buildNodeGenerationInputs(n.id, nodes, connections)}
                                inputSummary={{ textCount: 1, imageCount: connections.filter((c) => c.toNodeId === n.id && c.fromNodeId.startsWith("image")).length }}
                                onConfigChange={(id, patch) => setNodes((p) => p.map((n) => (n.id === id ? { ...n, metadata: { ...n.metadata, ...patch } } : n)))}
                                onTextInputChange={() => {}}
                                onGenerate={(id) => void generation.generateNode(id, "video", "")}
                            />
                        ) : n.type === CanvasNodeType.Video ? (
                            <CanvasVideoContent nodeId={n.id} mediaId={n.metadata?.mediaId} />
                        ) : (
                            n.metadata?.content
                        )}
                    </div>
                ))}
            </div>
            {interactions.pendingConnectionCreate ? <button onClick={() => interactions.createConnectedNode(CanvasNodeType.Config, interactions.pendingConnectionCreate!)}>创建配置并连接全部图片</button> : null}
            <button
                onClick={() => {
                    const video = nodes.find((n) => n.metadata?.videoMode === "draft" && n.metadata?.mediaId);
                    if (!video) return;
                    const result = createWorkflowFinalStep(workflow, video.metadata!.mediaId!, access(video.metadata!.mediaId!).videoGeneration as VideoGenerationSource);
                    setWorkflow(result.graph);
                }}
            >
                从样片创建工作流正式片步骤
            </button>
            {workflow.nodes
                .filter((n) => n.type === "video_generation")
                .map((n) => (
                    <div key={n.id} className="relative" style={{ width: 360, height: 274, background: "#282522" }}>
                        <WorkflowConfigPanel node={n} inputs={[]} onConfigChange={() => {}} onOutputCountChange={() => {}} onPreview={() => {}} />
                    </div>
                ))}
        </VideoResourceProvider>
    );
}
createRoot(document.getElementById("app")!).render(
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
        <App>
            <Harness />
        </App>
    </ConfigProvider>,
);
