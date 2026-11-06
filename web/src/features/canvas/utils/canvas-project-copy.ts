import type { CanvasProject } from "../stores/use-canvas-store";

type CanvasProjectCopyOptions = {
    id: string;
    title: string;
    now: string;
};

export function createCanvasProjectCopy(source: CanvasProject, { id, title, now }: CanvasProjectCopyOptions): CanvasProject {
    return {
        ...structuredClone(source),
        id,
        title,
        createdAt: now,
        updatedAt: now,
    };
}

export function nextCanvasProjectCopyTitle(sourceTitle: string, existingTitles: Iterable<string>) {
    const base = `${sourceTitle.trim() || "未命名画布"} 副本`;
    const titles = new Set(existingTitles);
    if (!titles.has(base)) return base;

    let index = 2;
    while (titles.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
}
