import { useEffect, useState } from "react";
import { useCanvasStore, type CanvasProject } from "../stores/use-canvas-store";

export function useCanvasProjectDetail(projectId: string, ready: boolean, scope: string | null, generation: number) {
    const ensureProjectDetail = useCanvasStore((state) => state.ensureProjectDetail);
    const [attempt, setAttempt] = useState(0);
    const identity = JSON.stringify([scope, projectId, generation, attempt]);
    const [result, setResult] = useState<{ identity: string; project: CanvasProject | null; error: string | null }>({ identity: "", project: null, error: null });
    useEffect(() => {
        if (!ready) return;
        let disposed = false;
        setResult({ identity, project: null, error: null });
        void ensureProjectDetail(projectId, { revalidate: true }).then(
            (project) => {
                if (!disposed) setResult({ identity, project, error: null });
            },
            (error) => {
                if (!disposed) setResult({ identity, project: null, error: error instanceof Error ? error.message : "画布加载失败" });
            },
        );
        return () => {
            disposed = true;
        };
    }, [ensureProjectDetail, projectId, ready, identity]);
    const current = ready && result.identity === identity;
    return { project: current ? result.project : null, error: current ? result.error : null, loading: !current || (!result.project && !result.error), loadAttempt: attempt, retry: () => setAttempt((value) => value + 1) };
}
