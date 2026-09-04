import localforage from "localforage";

import type { CanvasProject } from "../stores/use-canvas-store";

const recoverySnapshots = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "canvas_recovery_snapshots",
});
const recoverySnapshotsReady = typeof window === "undefined" ? Promise.resolve() : recoverySnapshots.setDriver([recoverySnapshots.INDEXEDDB]);
const retentionMs = 24 * 60 * 60 * 1000;

type RecoverySnapshot = {
    savedAt: number;
    project: CanvasProject;
};

function snapshotKey(projectId: string, tabId: string) {
    return `project:${projectId}:tab:${tabId}`;
}

export async function saveCanvasProjectRecoverySnapshot(projectId: string, tabId: string, project: CanvasProject) {
    await recoverySnapshotsReady;
    await recoverySnapshots.setItem<RecoverySnapshot>(snapshotKey(projectId, tabId), {
        savedAt: Date.now(),
        project,
    });
}

export async function cleanupExpiredCanvasProjectRecoverySnapshots(now = Date.now()) {
    await recoverySnapshotsReady;
    const keys = await recoverySnapshots.keys();
    await Promise.all(
        keys.map(async (key) => {
            const snapshot = await recoverySnapshots.getItem<RecoverySnapshot>(key);
            if (!snapshot || snapshot.savedAt + retentionMs <= now) await recoverySnapshots.removeItem(key);
        }),
    );
}
