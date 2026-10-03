import type { CanvasDocumentStorage } from "@/lib/localforage-storage";

export function memoryCanvasDisk() {
    const values = new Map<string, string>();
    const commits: string[][] = [];
    const disk: CanvasDocumentStorage = {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, val) => {
            values.set(key, val);
        },
        removeItem: async (key) => {
            values.delete(key);
        },
        getItems: async (keys) => keys.map((key) => values.get(key) ?? null),
        getEntries: async (prefix) => [...values].filter(([key]) => key.startsWith(prefix)),
        setItems: async (entries) => {
            entries.forEach(([key, val]) => values.set(key, val));
            commits.push(entries.map(([key]) => key));
        },
        compareAndSetItems: async (entries, expected) => {
            if (expected.some(([key, val]) => (values.get(key) ?? null) !== val)) return false;
            entries.forEach(([key, val]) => values.set(key, val));
            commits.push(entries.map(([key]) => key));
            return true;
        },
    };
    return { disk, values, commits };
}
