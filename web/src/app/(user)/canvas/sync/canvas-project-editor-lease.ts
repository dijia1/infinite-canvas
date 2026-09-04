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
