import { recoverPersistedImage } from "./image-recovery.ts";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/app/(user)/canvas/types";

export type CanvasImageMetadata = Pick<CanvasNodeMetadata, "content" | "storageKey" | "mediaId" | "publicImageId" | "naturalWidth" | "naturalHeight" | "bytes" | "mimeType" | "status" | "errorDetails">;

export type StoredCanvasImage = {
    url: string;
    storageKey: string;
    mediaId?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type RestoredCanvasImageMetadata = {
    content: string;
    storageKey: string;
    mediaId?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasImageHydrationDependencies = {
    resolveMediaUrl: (storageKey: string, fallback: string) => Promise<string>;
    readCachedImage: (storageKey: string) => Promise<string>;
    resolveRemoteImage: (mediaId: string) => Promise<string>;
    fetchPublicImageAccess: (publicImageId: string) => Promise<{ url: string }>;
    uploadImage: (source: string, mediaId?: string) => Promise<StoredCanvasImage>;
};

export function imageMetadata(image: StoredCanvasImage): CanvasImageMetadata {
    return {
        ...restoredImageMetadata(image),
        status: "success",
    };
}

function restoredImageMetadata(image: StoredCanvasImage): RestoredCanvasImageMetadata {
    return {
        content: image.url,
        storageKey: image.storageKey,
        mediaId: image.mediaId,
        naturalWidth: image.width,
        naturalHeight: image.height,
        bytes: image.bytes,
        mimeType: image.mimeType,
    };
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[], dependencies: CanvasImageHydrationDependencies): Promise<CanvasNodeData[]> {
    return Promise.all(
        nodes.map(async (node) => {
            const metadata = node.metadata;
            const content = metadata?.content;
            if (node.type === "video" && metadata?.storageKey) {
                return { ...node, metadata: { ...metadata, content: await dependencies.resolveMediaUrl(metadata.storageKey, content || "") } };
            }
            if (node.type !== "image") return node;

            const recovery = await recoverPersistedImage(metadata || {}, {
                readCachedImage: dependencies.readCachedImage,
                downloadMediaImage: async (mediaId) => {
                    const remote = metadata?.publicImageId ? (await dependencies.fetchPublicImageAccess(metadata.publicImageId)).url : await dependencies.resolveRemoteImage(mediaId);
                    const image = await dependencies.uploadImage(remote, mediaId);
                    return restoredImageMetadata(image);
                },
            });

            if (recovery.status === "cached" || recovery.status === "remote") {
                return { ...node, metadata: { ...metadata, ...recovery, status: "success", errorDetails: undefined } };
            }
            if (recovery.status === "error") {
                return { ...node, metadata: { ...metadata, status: "error", errorDetails: `恢复图片失败：${recovery.error}` } };
            }

            if (!content) return node;
            if (metadata?.storageKey || content.startsWith("blob:")) {
                return { ...node, metadata: { ...metadata, status: "error", errorDetails: "本地图片缓存已丢失，且没有可恢复的媒体记录" } };
            }
            if (!content.startsWith("data:image/")) return node;

            try {
                return { ...node, metadata: { ...metadata, ...imageMetadata(await dependencies.uploadImage(content)), status: "success", errorDetails: undefined } };
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "图片恢复失败";
                return { ...node, metadata: { ...metadata, status: "error", errorDetails: `恢复图片失败：${errorDetails}` } };
            }
        }),
    );
}
