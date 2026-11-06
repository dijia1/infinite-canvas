import { useEffect, useMemo } from "react";
import type { WorkflowEditorDocument } from "./workflow-editor-state";
import { createWorkflowDraftWriter } from "./workflow-draft-writer";

export function useWorkflowDraft({ ownerUID, workflowId, enabled, dirty, revision, document: editorDocument }: {
    ownerUID?: string;
    workflowId?: string;
    enabled: boolean;
    dirty: boolean;
    revision: number;
    document: WorkflowEditorDocument;
}) {
    const writer = useMemo(() => ownerUID && workflowId ? createWorkflowDraftWriter(typeof window === "undefined" ? undefined : window.sessionStorage, ownerUID, workflowId) : undefined, [ownerUID, workflowId]);
    useEffect(() => {
        if (!writer) return;
        const onVisibility = () => { if (window.document.visibilityState === "hidden") writer.flush(); };
        window.addEventListener("pagehide", writer.flush);
        window.addEventListener("beforeunload", writer.flush);
        window.document.addEventListener("visibilitychange", onVisibility);
        return () => {
            writer.flush();
            window.removeEventListener("pagehide", writer.flush);
            window.removeEventListener("beforeunload", writer.flush);
            window.document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [writer]);
    useEffect(() => {
        if (!writer) return;
        if (!enabled) { writer.flush(); return; }
        if (dirty) writer.schedule({ revision, document: editorDocument });
        else writer.clear();
    }, [dirty, editorDocument, enabled, revision, writer]);
}
