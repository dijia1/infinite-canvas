export type MediaCacheReader<T> = () => Promise<T | undefined>;
export type MediaRemoteLoader<T> = () => Promise<T>;

export type ResolveOriginalOptions<T> = {
    readOriginal: MediaCacheReader<T>;
    loadRemoteOriginal: MediaRemoteLoader<T>;
};

export type ResolvePreviewOptions<T> = {
    readPreview: MediaCacheReader<T>;
    readOriginal: MediaCacheReader<T>;
    createPreview: (original: T) => Promise<T>;
    loadRemotePreview: MediaRemoteLoader<T>;
};

const inFlightMediaLoads = new Map<string, Promise<unknown>>();

export async function resolveOriginal<T>({ readOriginal, loadRemoteOriginal }: ResolveOriginalOptions<T>): Promise<T> {
    const original = await readOriginal();
    return original === undefined ? loadRemoteOriginal() : original;
}

export async function resolvePreview<T>({ readPreview, readOriginal, createPreview, loadRemotePreview }: ResolvePreviewOptions<T>): Promise<T> {
    const preview = await readPreview();
    if (preview !== undefined) return preview;

    const original = await readOriginal();
    if (original === undefined) return loadRemotePreview();
    try {
        return await createPreview(original);
    } catch {
        return original;
    }
}

export function coalesceMediaLoad<T>(key: string, load: MediaRemoteLoader<T>): Promise<T> {
    const existing = inFlightMediaLoads.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    let pending: Promise<T>;
    try {
        pending = load();
    } catch (error) {
        pending = Promise.reject(error);
    }
    const tracked = pending.finally(() => {
        if (inFlightMediaLoads.get(key) === tracked) inFlightMediaLoads.delete(key);
    });
    inFlightMediaLoads.set(key, tracked);
    return tracked;
}
