import type { Position } from "../types";

export const MAX_DROPPED_IMAGE_COUNT = 20;
export const DROPPED_IMAGE_UPLOAD_CONCURRENCY = 3;

const DROPPED_IMAGE_GRID_CELL_SIZE = 672;
const DROPPED_IMAGE_GRID_MAX_COLUMNS = 4;

type DroppedImageFiles = {
    files: File[];
    omittedCount: number;
};

type DroppedImageImportResult = {
    nodeIds: string[];
    failedCount: number;
    omittedCount: number;
};

export function collectDroppedImageFiles(files: Iterable<File>): DroppedImageFiles {
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    return {
        files: images.slice(0, MAX_DROPPED_IMAGE_COUNT),
        omittedCount: Math.max(0, images.length - MAX_DROPPED_IMAGE_COUNT),
    };
}

export function layoutDroppedImageGrid(count: number, center: Position): Position[] {
    if (count < 1) return [];
    const columns = Math.min(DROPPED_IMAGE_GRID_MAX_COLUMNS, Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / columns);
    const offsetX = ((columns - 1) * DROPPED_IMAGE_GRID_CELL_SIZE) / 2;
    const offsetY = ((rows - 1) * DROPPED_IMAGE_GRID_CELL_SIZE) / 2;
    return Array.from({ length: count }, (_, index) => ({
        x: center.x + (index % columns) * DROPPED_IMAGE_GRID_CELL_SIZE - offsetX,
        y: center.y + Math.floor(index / columns) * DROPPED_IMAGE_GRID_CELL_SIZE - offsetY,
    }));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await map(items[index]!, index);
        }
    });
    await Promise.all(workers);
    return results;
}

export async function importDroppedImageFiles(files: Iterable<File>, center: Position, createNode: (file: File, position: Position) => Promise<string>): Promise<DroppedImageImportResult> {
    const selection = collectDroppedImageFiles(files);
    const positions = layoutDroppedImageGrid(selection.files.length, center);
    const results = await mapWithConcurrency(selection.files, DROPPED_IMAGE_UPLOAD_CONCURRENCY, async (file, index) => {
        try {
            return { nodeId: await createNode(file, positions[index]!), failed: false };
        } catch {
            return { nodeId: "", failed: true };
        }
    });
    return {
        nodeIds: results.flatMap((result) => (result.nodeId ? [result.nodeId] : [])),
        failedCount: results.filter((result) => result.failed).length,
        omittedCount: selection.omittedCount,
    };
}
