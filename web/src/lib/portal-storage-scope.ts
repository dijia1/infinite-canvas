export function portalStorageScope(uid?: string) {
    const normalized = uid?.trim() || "guest";
    return `portal:${normalized}`;
}
