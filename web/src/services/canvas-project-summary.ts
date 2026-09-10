import type { CanvasProjectDetail, CanvasSummary } from "./api/canvas-projects";

export function summarizeCanvasProject(record: CanvasProjectDetail): CanvasSummary {
    return { id: record.id, title: record.title, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, nodeCount: record.document.nodes.length, connectionCount: record.document.connections.length };
}
