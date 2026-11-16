// Isolated browser acceptance: real canvas node, result panel, media cache and
// generation controller. Axios never reaches a backend or a paid supplier.
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import axios, { type AxiosResponse } from "axios";
import { CanvasNode } from "@/features/canvas/components/canvas-node";
import { CanvasNodePromptPanel } from "@/features/canvas/components/canvas-node-prompt-panel";
import { CanvasVideoResultPanel } from "@/features/canvas/components/canvas-video-result-panel";
import { ScopedVideoResourceProvider } from "@/features/canvas/components/canvas-video-content";
import { WorkflowMediaPreview } from "@/features/workflows/workflow-media-preview";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/features/canvas/types";
import { useCanvasGeneration } from "@/features/canvas/hooks/use-canvas-generation";
import { requestVideoGeneration, type VideoGenerationSource } from "@/services/api/video";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const noop = () => {};
const blocked = async () => { throw new Error("隔离测试阻止了无关请求"); };
const requests: unknown[] = [];
const reads: Record<string, number> = {};
let sequence = 0;
const source = (id: string): VideoGenerationSource => ({ taskId: `task-${id}`, providerId: "mock25", mode: id === "ordinary" ? "" : id === "final" || id.startsWith("generated") ? "final" : "draft", createdAt: "2026-11-16T00:00:00Z", seconds: 30, size: "16:9", generateAudio: true });
const access = (id: string) => ({ mediaId: id, url: "/sample.mp4", width: 640, height: 360, contentType: "video/mp4", bytes: 1000, duration: 30, expiresAt: "2099-01-01T00:00:00Z", videoGeneration: source(id) });
axios.defaults.adapter = async config => {
    let data: unknown;
    if (config.method === "post" && String(config.url).endsWith("/videos")) {
        requests.push(JSON.parse(config.data));
        await new Promise(resolve => setTimeout(resolve, 800));
        const id = `generated-${++sequence}`;
        data = { id: `task-${id}`, status: "succeeded", progress: 100, resultMediaIds: [id], videos: [access(id)] };
    } else if (String(config.url).includes("/media/") && String(config.url).endsWith("/access")) {
        const id = String(config.url).split("/").at(-2)!;
        reads[id] = (reads[id] || 0) + 1;
        data = access(id);
    } else throw new Error(`隔离测试阻止了请求：${config.method} ${config.url}`);
    document.getElementById("requests")!.textContent = JSON.stringify({ requests, reads });
    return { data: { code: 0, data }, status: 200, statusText: "OK", headers: {}, config } as AxiosResponse;
};
const initial: CanvasNodeData[] = ["draft", "final", "ordinary"].map((id, i) => ({ id, type: CanvasNodeType.Video, title: id, position: { x: 180 + i * 550, y: 30 }, width: 420, height: 236, metadata: { mediaId: id, status: "success", generationMode: "video", videoMode: id === "ordinary" ? undefined : id as "draft" | "final", prompt: "一只橙色小猫坐在窗边，旁边是一盆绿色植物，清晨柔和阳光，清晰细腻的水彩插画，方形构图，不要文字。", videoProviderId: "mock25", videoProviderName: "Seedance 2.5", vquality: id === "final" ? "1080p" : "480p", videoSize: "16:9", seconds: "30" } }));
initial.push({ ...initial[0]!, id: "asset-draft", position: { x: 180, y: 30 }, metadata: { mediaId: "asset-draft", status: "success" } });
useConfigStore.setState({ config: { ...defaultConfig, videoProviderId: "mock25" } });
useThemeStore.setState({ theme: "dark" });

function Harness() {
    const [nodes, setNodes] = useState(initial);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [selected, setSelected] = useState(new Set(["draft"]));
    const [panel, setPanel] = useState(true);
    const [light, setLight] = useState(false);
    const [scale, setScale] = useState(0.86);
    const [readOnly, setReadOnly] = useState(false);
    const [longModel, setLongModel] = useState(false);
    const [narrow, setNarrow] = useState(false);
    const [fail, setFail] = useState(false);
    const [workflow, setWorkflow] = useState(false);
    const [feedback, setFeedback] = useState("");
    const nodesRef = useRef(nodes), connectionsRef = useRef(connections);
    nodesRef.current = nodes;
    connectionsRef.current = connections;
    const theme = canvasThemes[light ? "light" : "dark"];
    const generation = useCanvasGeneration({
        nodesRef, connectionsRef, setNodes, setConnections,
        effectiveConfig: useConfigStore.getState().config, defaultConfig,
        isAiConfigReady: () => true, openConfigDialog: noop,
        message: { error: setFeedback, warning: setFeedback },
        setSelectedNodeIds: noop, setSelectedConnectionId: noop, setDialogNodeId: noop, setAngleNodeId: noop,
        createId: () => `node-${++sequence}`, createConfigNode: () => { throw new Error("无关配置请求"); },
        requestVideoGeneration,
        requestGeneration: blocked, requestEdit: blocked, getImageTask: blocked, getImageTaskByClientRequest: blocked, resumeImageTask: blocked, uploadImage: blocked, uploadMediaFile: blocked, hydrateGenerationContext: blocked,
    });
    useLayoutEffect(() => {
        document.getElementById("document")!.textContent = JSON.stringify({ nodes: nodes.map(n => ({ id: n.id, mediaId: n.metadata?.mediaId, sourceDraftTaskId: n.metadata?.sourceDraftTaskId, status: n.metadata?.status, width: n.width, height: n.height })), connections });
    }, [nodes, connections]);
    const onGenerateFinal = async (id: string, from: VideoGenerationSource) => {
        if (fail) throw new Error("模拟提交失败，请重试");
        await generation.generateFinalVideo(id, from);
    };
    return <ScopedVideoResourceProvider scope="video-result-isolated" nodeIds={nodes.map(n => n.id)} onGenerateFinal={readOnly ? undefined : workflow ? () => setFeedback("已创建正式片步骤（隔离模拟）") : onGenerateFinal} finalActionLabel={workflow ? "创建正式片步骤" : undefined}>
        <main className="min-h-screen p-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <h1 className="mb-3 text-lg">我的画布 · 视频结果验收</h1>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                <span>隔离数据 · 模拟供应商</span>
                {([0.62, 0.86, 1.33] as const).map(value => <button key={value} onClick={() => setScale(value)}>{Math.round(value * 100)}%</button>)}
                <button onClick={() => { useThemeStore.setState({ theme: light ? "dark" : "light" }); setLight(!light); }}>切换主题</button>
                <button onClick={() => setPanel(!panel)}>切换信息面板</button>
                <button onClick={() => setReadOnly(!readOnly)}>只读：{readOnly ? "是" : "否"}</button>
                <button onClick={() => setLongModel(!longModel)}>长模型名</button>
                <button onClick={() => setNarrow(!narrow)}>窄信息面板</button>
                <button onClick={() => setFail(!fail)}>模拟失败：{fail ? "开" : "关"}</button>
                <button onClick={() => setWorkflow(!workflow)}>工作流：{workflow ? "开" : "关"}</button>
            </div>
            <div className="mb-3 flex gap-4 text-sm">
                {nodes.map(n => <button key={n.id} onClick={() => setSelected(new Set([n.id]))}>选择{n.id === "draft" ? "样片" : n.id === "asset-draft" ? "素材样片" : n.id === "final" ? "正式片" : n.id === "ordinary" ? "普通视频" : n.id}</button>)}
                <span role="status">{feedback}</span>
            </div>
            <div className="relative" style={{ height: 610, backgroundImage: `linear-gradient(${theme.canvas.line} 1px,transparent 1px),linear-gradient(90deg,${theme.canvas.line} 1px,transparent 1px)`, backgroundSize: "32px 32px" }}>
                <div className="absolute inset-0" style={{ transform: `scale(${scale})`, transformOrigin: "top left", "--canvas-inverse-scale": 1 / scale } as React.CSSProperties}>
                    {workflow ? <div className="absolute" style={{ left: 180, top: 30, width: 420, height: 236 }}><WorkflowMediaPreview nodeId="workflow-draft" type="video" mediaId="draft" readOnly={readOnly} /></div> : nodes.filter(n => n.id !== "asset-draft" || selected.has(n.id)).map(n => <CanvasNode key={n.id}
                        data={n} getScale={() => scale} videoVisible renderDetail="full"
                        isSelected={selected.has(n.id)} isRelated={false} isFocusRelated={false} isConnectionTarget={false} isConnecting={false}
                        showPanel={selected.has(n.id) && panel} showImageInfo={false}
                        panelVersion={JSON.stringify([readOnly, longModel, narrow, light])}
                        renderPanel={node => <div style={narrow ? { width: 230 } : undefined}><CanvasVideoResultPanel node={{ ...node, metadata: { ...node.metadata, ...(longModel ? { videoProviderName: "Seedance 2.5 · 这是一个很长的模型名称用于验证右侧按钮不会被挤压或遮挡" } : {}) } }} models={[{ id: "mock25", name: "Seedance 2.5" }]} theme={theme} fallback={<CanvasNodePromptPanel node={node} isRunning={false} onPromptChange={noop} onConfigChange={noop} onGenerate={noop} />} /></div>}
                        onMouseDown={(_event, id) => setSelected(new Set([id]))}
                        onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onContentChange={noop} onContextMenu={noop}
                    />)}
                </div>
            </div>
        </main>
    </ScopedVideoResourceProvider>;
}
createRoot(document.getElementById("app")!).render(<Harness />);
