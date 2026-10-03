import localforage from "localforage";

import type { CanvasProject } from "../stores/use-canvas-store";

const recoverySnapshots = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "canvas_recovery_snapshots",
});
const recoverySnapshotsReady = typeof window === "undefined" ? Promise.resolve() : recoverySnapshots.setDriver([recoverySnapshots.INDEXEDDB]);
// Legacy snapshots had no user field. Import only IDs already present in the
// current user's local documents; retain unmatched snapshots for manual recovery.
type RecoverySnapshot = { savedAt: number; project: CanvasProject };

export async function readCanvasProjectRecoverySnapshots(projectIds: Set<string>) {
    if (typeof window === "undefined" || !projectIds.size) return [];
    await recoverySnapshotsReady;
    const result: { key: string; project: CanvasProject }[] = [];
    await recoverySnapshots.iterate<RecoverySnapshot, void>((snapshot, key) => {
        if (snapshot?.project && projectIds.has(snapshot.project.id) && Array.isArray(snapshot.project.nodes) && Array.isArray(snapshot.project.connections)) result.push({ key, project: snapshot.project });
    });
    return result;
}

export async function removeCanvasProjectRecoverySnapshot(key: string) {
    await recoverySnapshotsReady;
    await recoverySnapshots.removeItem(key);
}
