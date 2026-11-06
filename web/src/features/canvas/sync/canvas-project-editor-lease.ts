export type CanvasProjectEditorLeaseRecord = {
    tabId: string;
    expiresAt: number;
};

export type CanvasProjectEditorLeaseStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function canvasProjectEditorLeaseKey(projectId: string) {
    return `infinite-canvas:project-editor-lease:${projectId}`;
}

export function readCanvasProjectEditorLease(storage: CanvasProjectEditorLeaseStorage, key: string): CanvasProjectEditorLeaseRecord | null {
    try {
        const value = storage.getItem(key);
        if (!value) return null;
        const parsed = JSON.parse(value) as CanvasProjectEditorLeaseRecord;
        return typeof parsed.tabId === "string" && typeof parsed.expiresAt === "number" ? parsed : null;
    } catch {
        return null;
    }
}

// localStorage cannot provide the same crash-safe exclusivity as Web Locks, so
// this is only the fallback. The caller verifies the stored winner on every
// heartbeat and BroadcastChannel makes ownership changes visible immediately.
export function claimCanvasProjectEditorLease(storage: CanvasProjectEditorLeaseStorage, key: string, tabId: string, now: number, durationMs: number) {
    const current = readCanvasProjectEditorLease(storage, key);
    if (current && current.expiresAt > now && current.tabId !== tabId) return false;
    try {
        storage.setItem(key, JSON.stringify({ tabId, expiresAt: now + durationMs } satisfies CanvasProjectEditorLeaseRecord));
    } catch {
        return false;
    }
    return readCanvasProjectEditorLease(storage, key)?.tabId === tabId;
}

// Use the existing editor lock name so pages from the previous release also
// exclude library mutations. Keep the fallback heartbeat during network waits.
export async function withCanvasProjectLocks<T>(ids: string[], tabId: string, action: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(ids)].sort();
    const acquire = async (index: number): Promise<T> => {
        if (index === sorted.length) return action();
        const id = sorted[index];
        if (typeof navigator !== "undefined" && navigator.locks) {
            return navigator.locks.request(`infinite-canvas:project-editor:${id}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
                if (!lock) throw new Error("另一标签页正在编辑这张画布，请稍后重试");
                return acquire(index + 1);
            });
        }
        if (typeof window === "undefined") return acquire(index + 1);
        const key = canvasProjectEditorLeaseKey(id),
            duration = 60_000;
        if (!claimCanvasProjectEditorLease(window.localStorage, key, tabId, Date.now(), duration)) throw new Error("另一标签页正在编辑这张画布，请稍后重试");
        let lost = false;
        const heartbeat = setInterval(() => {
            if (!claimCanvasProjectEditorLease(window.localStorage, key, tabId, Date.now(), duration)) lost = true;
        }, 10_000);
        try {
            const result = await acquire(index + 1);
            if (lost || readCanvasProjectEditorLease(window.localStorage, key)?.tabId !== tabId) throw new Error("画布编辑权已失效，请保留草稿并重试");
            return result;
        } finally {
            clearInterval(heartbeat);
            if (readCanvasProjectEditorLease(window.localStorage, key)?.tabId === tabId) window.localStorage.removeItem(key);
        }
    };
    return acquire(0);
}
