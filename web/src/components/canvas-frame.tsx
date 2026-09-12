"use client";

import { Fragment, useEffect, useReducer, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { canvasNodeSelectionColor } from "@/components/canvas-node-primitives";
import type { CanvasFrameData, CanvasFrameResizeDirection } from "@/lib/canvas-frame";

import styles from "./canvas-frame.module.css";

export type CanvasFrameProps = {
    frame: CanvasFrameData;
    selected: boolean;
    readOnly?: boolean;
    hoveredDirection?: CanvasFrameResizeDirection;
    headerActions?: ReactNode;
    onSelect: (event: ReactPointerEvent<HTMLDivElement>, frame: CanvasFrameData) => void;
    onMoveStart?: (event: ReactPointerEvent<HTMLDivElement>, frame: CanvasFrameData) => void;
    onRename?: (frameId: string, name: string) => void;
};

export type CanvasFrameTitleState = { editing: boolean; draft: string };
export type CanvasFrameTitleEvent = { type: "edit"; name: string; readOnly: boolean } | { type: "change"; draft: string } | { type: "sync"; name: string; readOnly: boolean } | { type: "finish"; name: string };

export function canvasFrameTitleReducer(state: CanvasFrameTitleState, event: CanvasFrameTitleEvent): CanvasFrameTitleState {
    if (event.type === "change") return state.editing && state.draft !== event.draft ? { ...state, draft: event.draft } : state;
    if (event.type === "finish") return !state.editing && state.draft === event.name ? state : { editing: false, draft: event.name };
    if (event.type === "edit") return event.readOnly ? { editing: false, draft: event.name } : { editing: true, draft: event.name };
    if (event.readOnly || !state.editing) return !state.editing && state.draft === event.name ? state : { editing: false, draft: event.name };
    return state;
}

export function canvasFrameTitleKeyAction(event: { key: string; repeat: boolean; isComposing: boolean }): "commit" | "cancel" | null {
    if (event.repeat || event.isComposing) return null;
    if (event.key === "Enter") return "commit";
    if (event.key === "Escape") return "cancel";
    return null;
}

export function canvasFrameHeaderPointerAction(input: { button: number; editing: boolean; readOnly: boolean }): "ignore" | "select" | "select-move" {
    if (input.button !== 0 || input.editing) return "ignore";
    return input.readOnly ? "select" : "select-move";
}

const frameEdges = ["top", "right", "bottom", "left"] as const;

export function CanvasFrame({ frame, selected, readOnly = false, hoveredDirection, headerActions, onSelect, onMoveStart, onRename }: CanvasFrameProps) {
    const [titleState, dispatchTitle] = useReducer(canvasFrameTitleReducer, { editing: false, draft: frame.name });
    const cancelBlurRef = useRef(false);
    const canRename = !readOnly && Boolean(onRename);
    const editing = canRename && titleState.editing;
    useEffect(() => {
        dispatchTitle({ type: "sync", name: frame.name, readOnly: !canRename });
    }, [canRename, frame.name]);
    const finishRename = () => {
        const nextName = titleState.draft.trim().slice(0, 128);
        dispatchTitle({ type: "finish", name: nextName || frame.name });
        if (nextName && nextName !== frame.name) onRename?.(frame.id, nextName);
    };
    const borderColor = selected ? canvasNodeSelectionColor : "color-mix(in srgb, currentColor 24%, transparent)";
    const frameTransform = `translate(${frame.position.x}px, ${frame.position.y}px)`;

    return (
        <Fragment>
            <div data-canvas-frame={frame.id} data-canvas-frame-body data-canvas-frame-selected={selected || undefined} aria-hidden="true" className={styles.body} style={{ transform: frameTransform, width: frame.width, height: frame.height }} />
            <div
                data-canvas-frame-controls={frame.id}
                data-canvas-frame-selected={selected || undefined}
                role="group"
                aria-label={`Frame ${frame.name}`}
                className={styles.controls}
                style={{
                    transform: `${frameTransform} scale(var(--canvas-inverse-scale, 1))`,
                    width: `calc(${frame.width}px * var(--canvas-scale, 1))`,
                    height: `calc(${frame.height}px * var(--canvas-scale, 1))`,
                }}
            >
                <div data-canvas-frame-outline aria-hidden="true" className={styles.outline} style={{ borderColor, boxShadow: selected ? `0 0 0 var(--canvas-frame-border-screen-width, 2px) ${canvasNodeSelectionColor}24` : undefined }} />
                <div
                    data-canvas-frame-header
                    className={`${styles.header} ${readOnly ? styles.readOnlyHeader : styles.movableHeader}`}
                    onPointerDown={(event) => {
                        const action = canvasFrameHeaderPointerAction({ button: event.button, editing, readOnly });
                        if (action === "ignore") {
                            if (event.button === 0) event.stopPropagation();
                            return;
                        }
                        event.stopPropagation();
                        onSelect(event, frame);
                        if (action === "select-move") onMoveStart?.(event, frame);
                    }}
                >
                    {headerActions ? (
                        <div data-canvas-frame-actions className={styles.actions} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                            {headerActions}
                        </div>
                    ) : null}
                    {editing ? (
                        <input
                            autoFocus
                            data-canvas-frame-title-input
                            data-canvas-no-drag
                            aria-label="Frame 名称"
                            value={titleState.draft}
                            maxLength={128}
                            className={styles.titleInput}
                            onChange={(event) => dispatchTitle({ type: "change", draft: event.currentTarget.value })}
                            onBlur={() => {
                                if (cancelBlurRef.current) {
                                    cancelBlurRef.current = false;
                                    return;
                                }
                                finishRename();
                            }}
                            onPointerDown={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                                const action = canvasFrameTitleKeyAction({ key: event.key, repeat: event.repeat, isComposing: event.nativeEvent.isComposing });
                                if (!action) return;
                                event.preventDefault();
                                event.stopPropagation();
                                if (action === "cancel") {
                                    cancelBlurRef.current = true;
                                    dispatchTitle({ type: "finish", name: frame.name });
                                }
                                event.currentTarget.blur();
                            }}
                        />
                    ) : (
                        <span
                            data-canvas-frame-title
                            role={canRename ? "button" : undefined}
                            tabIndex={canRename ? 0 : undefined}
                            aria-label={canRename ? `${frame.name}，双击重命名` : undefined}
                            title={frame.name}
                            className={styles.title}
                            onDoubleClick={(event) => {
                                if (!canRename) return;
                                event.stopPropagation();
                                dispatchTitle({ type: "edit", name: frame.name, readOnly: false });
                            }}
                            onKeyDown={(event) => {
                                if (!canRename || event.repeat || event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "F2")) return;
                                event.preventDefault();
                                event.stopPropagation();
                                dispatchTitle({ type: "edit", name: frame.name, readOnly: false });
                            }}
                        >
                            {frame.name}
                        </span>
                    )}
                </div>
                <div data-canvas-frame-edge-clip aria-hidden="true" className={styles.edgeClip}>
                    {frameEdges.map((edge) => (
                        <span key={edge} data-canvas-frame-edge={edge} data-active={hoveredDirection?.includes(edge) || undefined} className={`${styles.edge} ${styles[edge]}`} />
                    ))}
                </div>
            </div>
        </Fragment>
    );
}
