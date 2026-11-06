import { clearWorkflowDraft, writeWorkflowDraft, type WorkflowDraft } from "./workflow-editor-state";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createWorkflowDraftWriter(storage: DraftStorage | undefined, ownerUID: string, workflowId: string, delayMs = 300) {
    let pending: WorkflowDraft | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const flush = () => {
        cancel();
        if (!pending) return;
        const draft = pending;
        pending = undefined;
        writeWorkflowDraft(storage, ownerUID, workflowId, draft);
    };
    return {
        schedule(draft: WorkflowDraft) {
            cancel();
            pending = draft;
            // SPA recovery gets the newest immutable graph immediately, without
            // serializing the whole graph on every pointer movement.
            writeWorkflowDraft(undefined, ownerUID, workflowId, draft);
            timer = setTimeout(flush, delayMs);
        },
        clear() {
            cancel();
            pending = undefined;
            clearWorkflowDraft(storage, ownerUID, workflowId);
        },
        flush,
    };
}
