import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

const canvasDocumentForage = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "canvas_documents",
});
const canvasDocumentStorageReady = typeof window === "undefined" ? Promise.resolve() : canvasDocumentForage.setDriver([canvasDocumentForage.INDEXEDDB]);

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};

// Canvas documents can grow to several megabytes. Do not silently fall back to
// localStorage when IndexedDB is unavailable: a failed local write is safer
// than claiming that a large working document has been persisted.
export const canvasDocumentStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        await canvasDocumentStorageReady;
        return (await canvasDocumentForage.getItem<string>(name)) || null;
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        await canvasDocumentStorageReady;
        await canvasDocumentForage.setItem(name, value);
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        await canvasDocumentStorageReady;
        await canvasDocumentForage.removeItem(name);
    },
};
