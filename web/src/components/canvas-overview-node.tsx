import type { MouseEventHandler, PointerEventHandler } from "react";

import type { Position } from "@/app/(user)/canvas/types";
import { CanvasReadyImage } from "./canvas-ready-image";

type CanvasOverviewNodeProps = {
    nodeId: string;
    title: string;
    position: Position;
    width: number;
    height: number;
    selected: boolean;
    media: boolean;
    imageSource?: string;
    imageStorageKey?: string;
    imageIdentity?: string;
    fill: string;
    placeholderFill: string;
    stroke: string;
    selectionStroke: string;
    dataAttributes?: Record<string, string | undefined>;
    onMouseDown?: MouseEventHandler<HTMLDivElement>;
    onPointerDown?: PointerEventHandler<HTMLDivElement>;
    onContextMenu?: MouseEventHandler<HTMLDivElement>;
    onImageLoaded?: (storageKey: string) => void;
};

export function CanvasOverviewNode({
    nodeId,
    title,
    position,
    width,
    height,
    selected,
    media,
    imageSource,
    imageStorageKey,
    imageIdentity,
    fill,
    placeholderFill,
    stroke,
    selectionStroke,
    dataAttributes,
    onMouseDown,
    onPointerDown,
    onContextMenu,
    onImageLoaded,
}: CanvasOverviewNodeProps) {
    return (
        <div
            {...dataAttributes}
            data-node-id={nodeId}
            className={`node-element absolute select-none ${selected ? "z-50" : "z-10"}`}
            style={{ transform: `translate(${position.x}px, ${position.y}px)`, width, height, contain: "layout paint style" }}
            onPointerDown={onPointerDown}
            onContextMenu={onContextMenu}
        >
            <div
                className="relative h-full w-full overflow-hidden rounded-3xl border"
                style={{ background: media ? "transparent" : fill, borderColor: selected ? selectionStroke : stroke }}
                title={title}
                onMouseDown={onMouseDown}
            >
                {imageSource ? (
                    <CanvasReadyImage
                        key={imageIdentity || nodeId}
                        src={imageSource}
                        alt=""
                        className="object-cover"
                        loading={<div className="h-full w-full" style={{ background: placeholderFill }} />}
                        errorFallback={<div className="h-full w-full" style={{ background: placeholderFill }} />}
                        onReady={() => {
                            if (imageStorageKey) onImageLoaded?.(imageStorageKey);
                        }}
                    />
                ) : (
                    <div className="h-full w-full" style={{ background: placeholderFill }} />
                )}
            </div>
        </div>
    );
}
