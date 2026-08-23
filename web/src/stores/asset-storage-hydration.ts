type StoredImageAsset = {
    kind: "image";
    coverUrl?: string;
    data?: {
        dataUrl?: string;
        storageKey?: string;
        width?: number;
        height?: number;
        bytes?: number;
        mimeType?: string;
    };
    metadata?: Record<string, unknown>;
};

type StoredAsset = { kind?: string } & Record<string, unknown>;

type StoredImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type ImageHydrationDependencies = {
    resolveImageUrl: (storageKey?: string, fallback?: string) => Promise<string>;
    resolveRemoteImage: (mediaId: string) => Promise<string>;
    resolvePublicImage?: (publicImageId: string) => Promise<string>;
    loadMediaImage: (mediaId: string, remoteURL: () => Promise<string>) => Promise<StoredImage>;
    uploadImage: (source: string, mediaId?: string) => Promise<StoredImage>;
};

export async function hydrateStoredAssets<T extends StoredAsset>(assets: T[], dependencies: ImageHydrationDependencies): Promise<T[]> {
    return Promise.all(assets.map(async (asset) => hydrateStoredAsset(asset, dependencies)));
}

async function hydrateStoredAsset<T extends StoredAsset>(asset: T, dependencies: ImageHydrationDependencies): Promise<T> {
    if (asset.kind !== "image") return asset;

    const imageAsset = asset as T & StoredImageAsset;
    const data = imageAsset.data;
    if (!data) return asset;

    try {
        if (data.storageKey) {
            const cached = await dependencies.resolveImageUrl(data.storageKey, "");
            if (cached) return withImage(asset, cached, data.storageKey, data);

            const mediaId = typeof imageAsset.metadata?.mediaId === "string" ? imageAsset.metadata.mediaId : "";
            if (!mediaId) return asset;

            const publicImageId = typeof imageAsset.metadata?.publicImageId === "string" ? imageAsset.metadata.publicImageId : "";
            const restored = await dependencies.loadMediaImage(mediaId, async () =>
                publicImageId && dependencies.resolvePublicImage ? dependencies.resolvePublicImage(publicImageId) : dependencies.resolveRemoteImage(mediaId),
            );
            return withImage(asset, restored.url, restored.storageKey, restored);
        }

        if (!data.dataUrl?.startsWith("data:image/")) return asset;
        const stored = await dependencies.uploadImage(data.dataUrl);
        return withImage(asset, imageAsset.coverUrl?.startsWith("data:image/") ? stored.url : imageAsset.coverUrl || stored.url, stored.storageKey, stored);
    } catch {
        // A failed remote recovery must not prevent unrelated persisted assets from hydrating.
        return asset;
    }
}

function withImage<T extends StoredAsset>(asset: T, url: string, storageKey: string, image: NonNullable<StoredImageAsset["data"]>): T {
    const imageAsset = asset as T & StoredImageAsset;
    return {
        ...asset,
        coverUrl: url,
        data: {
            ...imageAsset.data,
            dataUrl: url,
            storageKey,
            width: image.width ?? 0,
            height: image.height ?? 0,
            bytes: image.bytes ?? 0,
            mimeType: image.mimeType || "image/*",
        },
    } as T;
}
