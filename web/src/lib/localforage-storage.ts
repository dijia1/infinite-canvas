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

// A Canvas commit includes both its document and sync marker. Individual
// localforage calls are separate transactions; use the public IndexedDB API
// after localforage initializes the existing database and object store.
export type CanvasDocumentStorage = StateStorage & {
    getItems: (keys: string[]) => Promise<(string | null)[]>;
    setItems: (entries: [string, string][]) => Promise<void>;
};

async function canvasTransaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    await canvasDocumentStorageReady;
    await canvasDocumentForage.ready();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("infinite-canvas");
        let blocked = false;
        request.onsuccess = () => {
            if (blocked) request.result.close();
            else resolve(request.result);
        };
        request.onerror = () => reject(request.error || new Error("画布本地存储打开失败"));
        request.onblocked = () => {
            blocked = true;
            reject(new Error("画布本地存储被其他页面占用，请关闭旧页面后重试"));
        };
    });
    database.onversionchange = () => database.close();
    return new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        let value: T;
        try {
            transaction = database.transaction("canvas_documents", mode);
            transaction.oncomplete = () => {
                database.close();
                resolve(value);
            };
            transaction.onabort = () => {
                database.close();
                reject(transaction.error || new Error("画布本地保存事务已中止"));
            };
            try {
                run(transaction.objectStore("canvas_documents"), (next) => {
                    value = next;
                });
            } catch (error) {
                transaction.abort();
                database.close();
                reject(error);
            }
        } catch (error) {
            database.close();
            reject(error);
        }
    });
}

export const canvasDocumentStorage: CanvasDocumentStorage = {
    getItems: async (keys) => {
        if (typeof window === "undefined") return keys.map(() => null);
        return canvasTransaction("readonly", (store, result) => {
            const values: (string | null)[] = keys.map(() => null);
            keys.forEach((key, index) => {
                const request = store.get(key);
                request.onsuccess = () => {
                    values[index] = request.result ?? null;
                };
            });
            result(values);
        });
    },
    setItems: async (entries) => {
        if (typeof window === "undefined") return;
        await canvasTransaction<void>("readwrite", (store) => {
            entries.forEach(([key, value]) => store.put(value, key));
        });
    },
    getItem: async (name) => (await canvasDocumentStorage.getItems([name]))[0],
    setItem: (name, value) => canvasDocumentStorage.setItems([[name, value]]),
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        await canvasTransaction<void>("readwrite", (store) => {
            store.delete(name);
        });
    },
};
