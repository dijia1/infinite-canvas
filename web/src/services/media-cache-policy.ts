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

type InFlightMediaLoad = {
    promise: Promise<unknown>;
    signal?: AbortSignal;
};

const inFlightMediaLoads = new Map<string, InFlightMediaLoad>();

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

export function coalesceMediaLoad<T>(key: string, load: MediaRemoteLoader<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
    const existing = inFlightMediaLoads.get(key);
    if (existing && !existing.signal?.aborted) return existing.promise as Promise<T>;

    let pending: Promise<T>;
    try {
        pending = load();
    } catch (error) {
        pending = Promise.reject(error);
    }
    let entry!: InFlightMediaLoad;
    const tracked = pending.finally(() => {
        if (inFlightMediaLoads.get(key) === entry) inFlightMediaLoads.delete(key);
    });
    entry = { promise: tracked, signal };
    inFlightMediaLoads.set(key, entry);
    return tracked;
}
