export type PersistedImage = {
    content?: string;
    storageKey?: string;
    mediaId?: string;
};

export type RestoredImage = {
    content: string;
    storageKey?: string;
    mediaId?: string;
    naturalWidth?: number;
    naturalHeight?: number;
    bytes?: number;
    mimeType?: string;
};

type ImageRecoveryDependencies = {
    readCachedImage: (storageKey: string) => Promise<string>;
    downloadMediaImage: (mediaId: string) => Promise<RestoredImage>;
};

export type ImageRecoveryResult =
    | ({ status: "cached" } & RestoredImage)
    | ({ status: "remote" } & RestoredImage)
    | { status: "unavailable" }
    | { status: "error"; error: string };

export async function recoverPersistedImage(image: PersistedImage, dependencies: ImageRecoveryDependencies): Promise<ImageRecoveryResult> {
    if (image.storageKey) {
        try {
            const content = await dependencies.readCachedImage(image.storageKey);
            if (content) return { status: "cached", content };
        } catch {
            // A missing or corrupted local cache can still be restored through mediaId.
        }
    }

    if (!image.mediaId) return { status: "unavailable" };

    try {
        return { status: "remote", ...(await dependencies.downloadMediaImage(image.mediaId)) };
    } catch (error) {
        return { status: "error", error: error instanceof Error ? error.message : "图片恢复失败" };
    }
}
