// Persistent owners keep local imports safe when another editor runs cache cleanup.
const prefix = "infinite-canvas:image-cache-retention:";
export function retainImageCache(storage: Storage, scope: string, owner: string, keys: Iterable<string>) {
    const key = `${prefix}${encodeURIComponent(scope)}:${encodeURIComponent(owner)}`;
    const values = [...new Set(keys)];
    if (values.length) storage.setItem(key, JSON.stringify(values));
    else storage.removeItem(key);
}
export function retainedImageCacheKeys(scope: string, storage?: Storage): Set<string> {
    const keys = new Set<string>();
    try {
        storage ??= typeof window === "undefined" ? undefined : window.localStorage;
        if (!storage) return keys;
        const scopePrefix = `${prefix}${encodeURIComponent(scope)}:`;
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key?.startsWith(scopePrefix)) continue;
            const values: unknown = JSON.parse(storage.getItem(key) || "[]");
            if (Array.isArray(values)) for (const value of values) if (typeof value === "string") keys.add(value);
        }
    } catch {
        // If browser storage cannot be read, do not evict potentially recoverable imports.
        keys.add("*");
    }
    return keys;
}
