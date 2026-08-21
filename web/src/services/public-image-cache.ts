export type PublicImageReference = { id: string; mediaId: string };

export async function loadPublicImage(
    image: PublicImageReference,
    dependencies: {
        readCachedImage: (storageKey: string) => Promise<string>;
        requestAccess: (publicImageID: string) => Promise<string>;
        cacheImage: (url: string, mediaId: string) => Promise<string>;
        storageKey?: (mediaId: string) => string;
    },
) {
    const storageKey = dependencies.storageKey?.(image.mediaId) || `media:${image.mediaId}`;
    const cached = await dependencies.readCachedImage(storageKey);
    if (cached) return { url: cached, storageKey, source: "cache" as const };

    const accessURL = await dependencies.requestAccess(image.id);
    const url = await dependencies.cacheImage(accessURL, image.mediaId);
    return { url, storageKey, source: "remote" as const };
}
