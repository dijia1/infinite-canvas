"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, GripVertical } from "lucide-react";
import { Button } from "antd";
import { imageInputLabel, moveInputKey } from "@/lib/generation-input-order";
import type { CanvasTheme } from "@/lib/canvas-theme";

type SortItem = { key: string; title?: string; preview: ReactNode; badge?: ReactNode };

export function ImageInputSorter({ items, theme, readOnly = false, onReorder }: {
    items: SortItem[];
    theme: CanvasTheme;
    readOnly?: boolean;
    onReorder: (keys: string[]) => void;
}) {
    const dragged = useRef<string | null>(null);
    const insertion = useRef<number | null>(null);
    const [dragKey, setDragKey] = useState<string | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const clear = () => {
        dragged.current = null;
        insertion.current = null;
        setDragKey(null);
        setDropIndex(null);
    };
    const locate = (event: DragEvent<HTMLDivElement>) => {
        const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-input-sort-key]"));
        const index = cards.findIndex((card) => event.clientX < card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2);
        return index < 0 ? cards.length : index;
    };
    return (
        <div
            role="list"
            aria-label="图片输入排序"
            className="thin-scrollbar flex gap-2 overflow-x-auto py-1"
            onPointerDown={(event) => event.stopPropagation()}
            onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!dragged.current || readOnly) return;
                event.dataTransfer.dropEffect = "move";
                const area = event.currentTarget.getBoundingClientRect();
                if (event.clientX < area.left + 28) event.currentTarget.scrollLeft -= 12;
                else if (event.clientX > area.right - 28) event.currentTarget.scrollLeft += 12;
                insertion.current = locate(event);
                setDropIndex(insertion.current);
            }}
            onDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                insertion.current = null;
                setDropIndex(null);
            }}
            onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const key = dragged.current;
                if (key && insertion.current !== null && !readOnly) {
                    const from = items.findIndex((item) => item.key === key);
                    const at = locate(event);
                    const to = at > from ? at - 1 : at;
                    if (from !== to) onReorder(moveInputKey(items.map((item) => item.key), from, to));
                }
                clear();
            }}
            onDragEnd={clear}
        >
            {items.map((item, index) => (
                <div
                    key={item.key}
                    role="listitem"
                    data-input-sort-key={item.key}
                    aria-label={`${imageInputLabel(index)}${readOnly ? "" : "，可拖动排序"}`}
                    draggable={!readOnly}
                    className={`relative w-24 shrink-0 select-none rounded-lg border ${readOnly ? "" : "cursor-grab active:cursor-grabbing"}`}
                    style={{ background: theme.node.fill, borderColor: theme.node.stroke, opacity: dragKey === item.key ? 0.45 : 1 }}
                    onDragStart={(event) => {
                        event.stopPropagation();
                        dragged.current = item.key;
                        setDragKey(item.key);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("application/x-canvas-input-order", item.key);
                    }}
                >
                    {dropIndex === index || (index === items.length - 1 && dropIndex === items.length) ? <div data-input-sort-insertion aria-hidden="true" className={`pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-blue-500 ${dropIndex === index ? "-left-1.5" : "-right-1.5"}`} /> : null}
                    <div className="relative overflow-hidden rounded-t-[inherit]">
                        {item.preview}
                        <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[9px] font-medium text-white">{item.badge || imageInputLabel(index)}</span>
                        {!readOnly ? <GripVertical aria-hidden="true" className="pointer-events-none absolute right-1 top-1 size-3 rounded bg-black/60 text-white" /> : null}
                        <div className="absolute inset-x-1 bottom-1 flex justify-between">
                            <Button aria-label={`将${imageInputLabel(index)}前移`} size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !text-stone-700 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={readOnly || index === 0} onClick={() => onReorder(moveInputKey(items.map((item) => item.key), index, index - 1))} />
                            <Button aria-label={`将${imageInputLabel(index)}后移`} size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !text-stone-700 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={readOnly || index === items.length - 1} onClick={() => onReorder(moveInputKey(items.map((item) => item.key), index, index + 1))} />
                        </div>
                    </div>
                    <div className="truncate px-1.5 py-1 text-[10px] opacity-60">{item.title || imageInputLabel(index)}</div>
                </div>
            ))}
        </div>
    );
}
