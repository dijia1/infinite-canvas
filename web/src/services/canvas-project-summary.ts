import type { CanvasProjectSaveResult, CanvasSummary } from "./api/canvas-projects";

export function summarizeCanvasProject(record: CanvasProjectSaveResult): CanvasSummary {
    const nodeCount = "document" in record ? record.document.nodes.length : record.nodeCount;
    const connectionCount = "document" in record ? record.document.connections.length : record.connectionCount;
    if (!("document" in record) && (
        !Number.isInteger(nodeCount) || nodeCount < 0 || !Number.isInteger(connectionCount) || connectionCount < 0 ||
        typeof record.title !== "string" || !record.title || typeof record.createdAt !== "string" || !record.createdAt || typeof record.updatedAt !== "string" || !record.updatedAt
    )) throw new Error("画布保存回执无效，请重试确认");
    return { id: record.id, title: record.title, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, nodeCount, connectionCount };
}
