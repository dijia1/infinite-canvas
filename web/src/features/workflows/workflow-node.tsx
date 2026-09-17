"use client";

import { Button } from "antd";
import { Image as ImageIcon, LoaderCircle, Maximize2, Pencil, RefreshCw, Trash2, Upload, Video } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { CanvasConnectionHandle, CanvasNodeFrame, CanvasResizeHandle, canvasNodeSelectionColor, canvasResizeCorners, type CanvasResizeCorner } from "@/components/canvas-node-primitives";
import { CanvasOverviewNode } from "@/components/canvas-overview-node";
import { CanvasNodeToolbarAction, CanvasNodeToolbarIconAction, CanvasNodeToolbarShell } from "@/components/canvas-node-toolbar-shell";
import type { CanvasRenderDetail } from "@/app/(user)/canvas/media/canvas-media-policy";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { WorkflowGenerationConfig, WorkflowNode, WorkflowOutputExecution, WorkflowOutputSlot } from "./types";
import { WorkflowConfigPanel } from "./workflow-config-panel";
import { WorkflowMediaPreview } from "./workflow-media-preview";
import { workflowOutputStatusText } from "./workflow-run-state";

export type WorkflowPreviewInput = { key: string; sourceNodeId: string; type: "image" | "video" | "text"; text?: string; mediaId?: string; imageUrl?: string; imageStorageKey?: string; imageError?: string };
type ResizeStart = (event: ReactPointerEvent, node: WorkflowNode, corner: CanvasResizeCorner, slot?: WorkflowOutputSlot) => void;

export function WorkflowNodeCard({
    node,
    canvasNodeId,
    renderDetail = "full",
    selected,
    readOnly = false,
    connecting,
    videoVisible,
    inputs,
    imageUrl,
    imageStorageKey,
    imageError,
    onRetryImage,
    onImageLoaded,
    onImageDimensions,
    onDragStart,
    onContextMenu,
    onResizeStart,
    onRemove,
    onChooseMedia,
    onTextChange,
    onConfigChange,
    onModeChange,
    onLayoutHeightChange,
    onOutputCountChange,
    onPreview,
    onPreviewMedia,
    onConnectTarget,
    onStartSource,
}: {
    node: WorkflowNode;
    canvasNodeId?: string;
    renderDetail?: CanvasRenderDetail;
    selected: boolean;
    readOnly?: boolean;
    connecting: boolean;
    videoVisible?: boolean;
    inputs: WorkflowPreviewInput[];
    imageUrl?: string;
    imageStorageKey?: string;
    imageError?: string;
    onRetryImage: () => void;
    onImageLoaded: (storageKey: string) => void;
    onImageDimensions?: (dimensions: { width: number; height: number }) => void;
    onDragStart: (event: ReactPointerEvent, node: WorkflowNode) => void;
    onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
    onResizeStart?: ResizeStart;
    onRemove: () => void;
    onChooseMedia: () => void;
    onTextChange: (value: string) => void;
    onConfigChange: (config: WorkflowGenerationConfig) => void;
    onModeChange?: (mode: "image" | "video") => void;
    onLayoutHeightChange?: (height: number) => void;
    onOutputCountChange: (count: number) => void;
    onPreview: () => void;
    onPreviewMedia?: () => void;
    onConnectTarget: (event?: ReactPointerEvent) => void;
    onStartSource: (event?: ReactPointerEvent) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const rootRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [editing, setEditing] = useState(false);
    const { hovered, keepHover, leaveHover } = useNodeHover();
    const width = node.width || 340;
    const height = node.height || 240;
    const generation = node.type === "image_generation" || node.type === "video_generation";
    const mediaType = node.type === "image_input" ? "image" : node.type === "video_input" ? "video" : undefined;
    const hasMedia = Boolean(mediaType && node.mediaId);
    useEffect(() => {
        if (editing) textareaRef.current?.focus();
    }, [editing]);
    useEffect(() => {
        if (!selected || readOnly) setEditing(false);
    }, [selected, readOnly]);
    if (renderDetail === "overview") {
        return <CanvasOverviewNode
            nodeId={canvasNodeId || node.id}
            title={node.text || (generation ? "生成配置" : mediaType === "image" ? "图片" : mediaType === "video" ? "视频" : "节点")}
            position={node.position}
            width={width}
            height={height}
            selected={selected}
            media={hasMedia}
            imageSource={mediaType === "image" ? imageUrl : undefined}
            imageStorageKey={imageStorageKey}
            imageIdentity={node.mediaId}
            fill={theme.node.fill}
            placeholderFill={theme.toolbar.activeBg}
            stroke={theme.node.stroke}
            selectionStroke={canvasNodeSelectionColor}
            dataAttributes={{ "data-workflow-object": "", "data-workflow-node-id": node.id }}
            onPointerDown={(event) => onDragStart(event, node)}
            onImageLoaded={onImageLoaded}
            onContextMenu={onContextMenu}
        />;
    }
    return (
        <div
            ref={rootRef}
            data-workflow-object
            data-node-id={canvasNodeId || node.id}
            data-workflow-node-id={node.id}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${selected ? "z-50" : "z-10"}`}
            style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)`, width, height, contain: "layout style" }}
            onPointerDown={(event) => onDragStart(event, node)}
            onContextMenu={onContextMenu}
            onMouseEnter={keepHover}
            onMouseLeave={leaveHover}
            onDoubleClick={(event) => {
                if (!readOnly && node.type === "text_input") {
                    event.stopPropagation();
                    setEditing(true);
                }
            }}
        >
            <CanvasNodeFrame
                selected={selected}
                style={{ background: hasMedia ? "transparent" : theme.node.fill, borderColor: selected ? canvasNodeSelectionColor : theme.node.stroke, boxShadow: selected ? `0 0 0 1px ${canvasNodeSelectionColor}55` : undefined, color: theme.node.text }}
            >
                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[inherit]">
                    {node.type === "text_input" ? (
                        editing ? (
                            <textarea
                                ref={textareaRef}
                                aria-label="流程文本输入"
                                value={node.text || ""}
                                placeholder="输入提示词"
                                readOnly={readOnly}
                                className="thin-scrollbar block h-full w-full resize-none border-none bg-transparent px-4 pb-4 pt-14 font-mono text-sm leading-relaxed outline-none select-text"
                                onChange={(event) => onTextChange(event.target.value)}
                                onBlur={() => setEditing(false)}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") {
                                        event.stopPropagation();
                                        setEditing(false);
                                    }
                                }}
                                onPointerDown={(event) => {
                                    if (event.button !== 1) event.stopPropagation();
                                }}
                                onWheel={(event) => event.stopPropagation()}
                            />
                        ) : (
                            <div className="thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pb-4 pt-14 font-mono text-sm leading-relaxed">
                                {node.text || <span style={{ color: theme.node.placeholder }}>双击编辑文字</span>}
                            </div>
                        )
                    ) : mediaType ? (
                        <WorkflowMediaPreview
                            nodeId={node.id}
                            readOnly={readOnly}
                            type={mediaType}
                            mediaId={node.mediaId}
                            visible={videoVisible}
                            imageUrl={imageUrl}
                            imageStorageKey={imageStorageKey}
                            imageError={imageError}
                            onRetryImage={onRetryImage}
                            onImageLoaded={onImageLoaded}
                            onImageDimensions={onImageDimensions}
                            onChoose={readOnly ? undefined : onChooseMedia}
                        />
                    ) : generation ? (
                        <WorkflowConfigPanel
                            node={node}
                            readOnly={readOnly}
                            inputs={inputs}
                            onConfigChange={onConfigChange}
                            onModeChange={onModeChange}
                            onLayoutHeightChange={onLayoutHeightChange}
                            onOutputCountChange={onOutputCountChange}
                            onPreview={onPreview}
                        />
                    ) : null}
                </div>
                {!readOnly && onResizeStart ? canvasResizeCorners.map((corner) => <CanvasResizeHandle key={corner} corner={corner} onPointerDown={(event) => onResizeStart(event, node, corner)} />) : null}
            </CanvasNodeFrame>
            {!readOnly && generation ? (
                <CanvasConnectionHandle
                    side="left"
                    visible={hovered || selected || connecting}
                    label="连接到生成配置"
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        onConnectTarget(event);
                    }}
                />
            ) : !readOnly ? (
                <CanvasConnectionHandle
                    side="right"
                    visible={hovered || selected || connecting}
                    label="开始连接"
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        onStartSource(event);
                    }}
                />
            ) : null}
            {hovered && !editing && (!readOnly || (hasMedia && onPreviewMedia)) ? (
                <WorkflowNodeToolbar anchor={rootRef} positionKey={`${node.position.x}:${node.position.y}:${width}:${height}`} onMouseEnter={keepHover} onMouseLeave={leaveHover}>
                    {!readOnly && node.type === "text_input" ? <CanvasNodeToolbarAction title="编辑文本" label="编辑文字" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)} /> : null}
                    {!readOnly && mediaType ? (
                        <CanvasNodeToolbarAction
                            title={mediaType === "image" ? "替换图片" : "替换视频"}
                            label={mediaType === "image" ? "替换图片" : "替换视频"}
                            icon={mediaType === "image" ? <Upload className="size-4" /> : <Video className="size-4" />}
                            onClick={onChooseMedia}
                        />
                    ) : null}
                    {hasMedia && onPreviewMedia ? (
                        <CanvasNodeToolbarAction title={mediaType === "image" ? "查看图片详情" : "查看视频"} label={mediaType === "image" ? "查看大图" : "查看视频"} icon={<Maximize2 className="size-4" />} onClick={onPreviewMedia} />
                    ) : null}
                    {!readOnly ? <CanvasNodeToolbarIconAction title="删除节点" icon={<Trash2 className="size-4" />} onClick={onRemove} /> : null}
                </WorkflowNodeToolbar>
            ) : null}
        </div>
    );
}

export function WorkflowOutputCard({
    parent,
    slot,
    canvasNodeId,
    renderDetail = "full",
    selected,
    readOnly = false,
    connecting = false,
    execution,
    loadingExecution,
    executionLoadError,
    resourceNodeId,
    videoVisible,
    imageUrl,
    imageStorageKey,
    imageError,
    retrying,
    confirmingRetry,
    onReloadMedia,
    onRetryOutput,
    onImageLoaded,
    onImageDimensions,
    onDragStart,
    onContextMenu,
    onResizeStart,
    onRemove,
    onPreviewMedia,
    onStartSource,
}: {
    parent: WorkflowNode;
    slot: WorkflowOutputSlot;
    canvasNodeId?: string;
    renderDetail?: CanvasRenderDetail;
    selected: boolean;
    readOnly?: boolean;
    connecting?: boolean;
    execution?: WorkflowOutputExecution;
    loadingExecution?: boolean;
    executionLoadError?: string;
    resourceNodeId?: string;
    videoVisible?: boolean;
    imageUrl?: string;
    imageStorageKey?: string;
    imageError?: string;
    retrying?: boolean;
    confirmingRetry?: boolean;
    onReloadMedia?: () => void;
    onRetryOutput?: () => void;
    onImageLoaded?: (storageKey: string) => void;
    onImageDimensions?: (dimensions: { width: number; height: number }) => void;
    onDragStart: (event: ReactPointerEvent, parent: WorkflowNode, slot: WorkflowOutputSlot) => void;
    onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
    onResizeStart?: ResizeStart;
    onRemove: () => void;
    onPreviewMedia?: () => void;
    onStartSource: (event?: ReactPointerEvent) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const rootRef = useRef<HTMLDivElement>(null);
    const { hovered, keepHover, leaveHover } = useNodeHover();
    const position = slot.position || { x: parent.position.x + (parent.width || 360) + 96, y: parent.position.y };
    const width = slot.width || (slot.type === "image" ? 340 : 420);
    const height = slot.height || (slot.type === "image" ? 240 : 236);
    const hasMedia = execution?.status === "succeeded" && execution.mediaId && resourceNodeId;
    if (renderDetail === "overview") {
        return <CanvasOverviewNode
            nodeId={canvasNodeId || slot.id}
            title={slot.type === "image" ? "图片结果" : "视频结果"}
            position={position}
            width={width}
            height={height}
            selected={selected}
            media={Boolean(hasMedia)}
            imageSource={hasMedia && slot.type === "image" ? imageUrl : undefined}
            imageStorageKey={imageStorageKey}
            imageIdentity={execution?.mediaId}
            fill={theme.node.fill}
            placeholderFill={theme.toolbar.activeBg}
            stroke={theme.node.stroke}
            selectionStroke={canvasNodeSelectionColor}
            dataAttributes={{ "data-workflow-object": "", "data-workflow-node-id": parent.id, "data-workflow-slot-id": slot.id }}
            onPointerDown={(event) => onDragStart(event, parent, slot)}
            onImageLoaded={onImageLoaded}
            onContextMenu={onContextMenu}
        />;
    }
    return (
        <div
            ref={rootRef}
            data-workflow-object
            data-node-id={canvasNodeId}
            data-workflow-node-id={parent.id}
            data-workflow-slot-id={slot.id}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${selected ? "z-50" : "z-10"}`}
            style={{ transform: `translate(${position.x}px, ${position.y}px)`, width, height, contain: "layout style" }}
            onPointerDown={(event) => onDragStart(event, parent, slot)}
            onContextMenu={onContextMenu}
            onMouseEnter={keepHover}
            onMouseLeave={leaveHover}
        >
            <CanvasNodeFrame
                selected={selected}
                style={{
                    background: hasMedia ? "transparent" : theme.node.fill,
                    borderColor: selected ? canvasNodeSelectionColor : theme.node.stroke,
                    boxShadow: selected ? `0 0 0 1px ${canvasNodeSelectionColor}55` : undefined,
                    color: theme.node.placeholder,
                }}
            >
                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[inherit]">
                    {hasMedia ? (
                        <WorkflowMediaPreview
                            nodeId={resourceNodeId!}
                            type={slot.type}
                            mediaId={execution!.mediaId}
                            visible={videoVisible}
                            imageUrl={imageUrl}
                            imageStorageKey={imageStorageKey}
                            imageError={imageError}
                            onRetryImage={onReloadMedia}
                            onImageLoaded={onImageLoaded}
                            onImageDimensions={onImageDimensions}
                        />
                    ) : (
                        <div className={`flex max-w-[85%] flex-col items-center gap-2 text-center text-xs ${execution?.status === "failed" || execution?.status === "blocked" ? "text-red-500" : "opacity-55"}`}>
                            {loadingExecution || (execution && ["ready", "claimed", "submitting", "running"].includes(execution.status)) ? (
                                <LoaderCircle className="size-6 animate-spin" />
                            ) : slot.type === "image" ? (
                                <ImageIcon className="size-7" />
                            ) : (
                                <Video className="size-7" />
                            )}
                            <span>{executionLoadError || (loadingExecution ? "正在加载运行结果" : workflowOutputStatusText(execution?.status))}</span>
                            {execution?.error ? <span className="line-clamp-3 opacity-80">{execution.error}</span> : null}
                        </div>
                    )}
                    {!readOnly && slot.type === "image" && execution?.status === "failed" && onRetryOutput ? (
                        <Button
                            type="text"
                            size="small"
                            loading={retrying}
                            icon={<RefreshCw className="size-3.5" />}
                            className="!absolute !bottom-2 !right-2"
                            onPointerDown={(event) => {
                                if (event.button !== 1) event.stopPropagation();
                            }}
                            onClick={(event) => {
                                event.stopPropagation();
                                onRetryOutput();
                            }}
                        >
                            {confirmingRetry ? "确认重试" : "重试"}
                        </Button>
                    ) : null}
                </div>
                {!readOnly && onResizeStart ? canvasResizeCorners.map((corner) => <CanvasResizeHandle key={corner} corner={corner} onPointerDown={(event) => onResizeStart(event, parent, corner, slot)} />) : null}
            </CanvasNodeFrame>
            {!readOnly ? (
                <CanvasConnectionHandle
                    side="right"
                    visible={hovered || selected || connecting}
                    label="从输出开始连接"
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        onStartSource(event);
                    }}
                />
            ) : null}
            {hovered && (!readOnly || (hasMedia && onPreviewMedia)) ? (
                <WorkflowNodeToolbar anchor={rootRef} positionKey={`${position.x}:${position.y}:${width}:${height}`} onMouseEnter={keepHover} onMouseLeave={leaveHover}>
                    {hasMedia && onPreviewMedia ? (
                        <CanvasNodeToolbarAction title={slot.type === "image" ? "查看图片详情" : "查看视频"} label={slot.type === "image" ? "查看大图" : "查看视频"} icon={<Maximize2 className="size-4" />} onClick={onPreviewMedia} />
                    ) : null}
                    {!readOnly ? <CanvasNodeToolbarIconAction title="删除输出" icon={<Trash2 className="size-4" />} onClick={onRemove} /> : null}
                </WorkflowNodeToolbar>
            ) : null}
        </div>
    );
}

function useNodeHover() {
    const [hovered, setHovered] = useState(false);
    const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timeout.current), []);
    return {
        hovered,
        keepHover: () => {
            clearTimeout(timeout.current);
            setHovered(true);
        },
        leaveHover: () => {
            clearTimeout(timeout.current);
            timeout.current = setTimeout(() => setHovered(false), 100);
        },
    };
}

function WorkflowNodeToolbar({
    anchor,
    positionKey,
    children,
    onMouseEnter,
    onMouseLeave,
}: {
    anchor: RefObject<HTMLDivElement | null>;
    positionKey: string;
    children: ReactNode;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}) {
    const [position, setPosition] = useState<{ left: number; top: number }>();
    useLayoutEffect(() => {
        const update = () => {
            const rect = anchor.current?.getBoundingClientRect();
            if (rect) setPosition({ left: rect.left + rect.width / 2, top: rect.top - 14 });
        };
        update();
        const canvas = anchor.current?.closest<HTMLElement>("[data-infinite-canvas]");
        canvas?.addEventListener("canvasviewportchange", update);
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        return () => {
            canvas?.removeEventListener("canvasviewportchange", update);
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
        };
    }, [anchor, positionKey]);
    return position
        ? createPortal(
              <CanvasNodeToolbarShell className="fixed" style={position} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
                  {children}
              </CanvasNodeToolbarShell>,
              document.body,
          )
        : null;
}
