import { fitNodeSize } from "./canvas-node-size";
import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";
import { imageStorageKeyForMedia, type UploadedImage } from "@/services/image-storage";
import { imageMetadata } from "@/services/canvas-image-hydration";

export type PublicImportSource = { id: string; mediaId?: string; title: string };
export type PublicImportAccess = { mediaId: string; sourceMediaId: string; width: number; height: number; bytes: number; contentType: string };
export type PublicImportOperation = { id: string; source: PublicImportSource; position: Position; scope: string; running: boolean };

export function createPublicImageImportController(dependencies: {
    importImage: (id: string, requestId: string) => Promise<PublicImportAccess>;
    seedCache: (access: PublicImportAccess) => Promise<UploadedImage | null>;
    isCurrent: (scope: string) => boolean;
    commit: (node: CanvasNodeData) => void;
    onStatus: (operation: PublicImportOperation, state: "loading" | "failed" | "closed", error?: string) => void;
    newRequestId: () => string;
    newNodeId: () => string;
}) {
    const pending = new Map<string, PublicImportOperation>();
    let disposed = false;
    const current = (op: PublicImportOperation) => !disposed && pending.get(op.id) === op && dependencies.isCurrent(op.scope);
    const cancel = (id: string) => {
        const op = pending.get(id);
        if (!op) return;
        pending.delete(id);
        dependencies.onStatus(op, "closed");
    };
    const run = async (op: PublicImportOperation) => {
        if (op.running || !current(op)) return;
        op.running = true;
        dependencies.onStatus(op, "loading");
        try {
            const access = await dependencies.importImage(op.source.id, op.id);
            if (!current(op)) return;
            const cached = await dependencies.seedCache(access);
            if (!current(op)) return;
            const image = cached || { url: "", storageKey: imageStorageKeyForMedia(access.mediaId), mediaId: access.mediaId, width: access.width, height: access.height, bytes: access.bytes, mimeType: access.contentType };
            const size = fitNodeSize(access.width, access.height);
            dependencies.commit({ id: dependencies.newNodeId(), type: CanvasNodeType.Image, title: op.source.title, position: { x: op.position.x - size.width / 2, y: op.position.y - size.height / 2 }, ...size, metadata: imageMetadata(image) });
            cancel(op.id);
        } catch (error) {
            if (current(op)) dependencies.onStatus(op, "failed", error instanceof Error ? error.message : "公共图片导入失败");
        } finally {
            op.running = false;
            if (!dependencies.isCurrent(op.scope)) cancel(op.id);
        }
    };
    return {
        start(source: PublicImportSource, position: Position, scope: string) {
            const op: PublicImportOperation = { id: dependencies.newRequestId(), source: { ...source }, position: { ...position }, scope, running: false };
            pending.set(op.id, op);
            return { id: op.id, done: run(op) };
        },
        retry: async (id: string) => {
            const op = pending.get(id);
            if (op) await run(op);
        },
        cancel,
        activate() {
            disposed = false;
        },
        dispose() {
            disposed = true;
            for (const id of pending.keys()) cancel(id);
        },
    };
}
