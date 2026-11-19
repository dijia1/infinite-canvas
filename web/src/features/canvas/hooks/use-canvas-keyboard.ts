import { useEffect, useRef } from "react";
import { isEditableTarget } from "@/lib/editable-target";

type CanvasKeyboardActions = {
    readOnly: boolean;
    undo: () => void;
    redo: () => void;
    selectAll: () => void;
    copy: (clipboard: DataTransfer) => boolean;
    paste: (clipboard: DataTransfer) => boolean;
    deleteSelection: () => void;
    escape: () => void;
};

export function useCanvasKeyboard(actions: CanvasKeyboardActions) {
    const current = useRef(actions);
    current.current = actions;
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const actions = current.current;
            if (actions.readOnly) return;
            if (isEditableTarget(event.target) || event.target instanceof HTMLSelectElement) return;
            const key = event.key.toLowerCase();
            if ((event.metaKey || event.ctrlKey) && !event.altKey) {
                const shortcut = key === "z" ? (event.shiftKey ? actions.redo : actions.undo) : key === "y" ? actions.redo : key === "a" ? actions.selectAll : undefined;
                if (shortcut) { event.preventDefault(); shortcut(); return; }
            }
            if (event.key === "Delete" || event.key === "Backspace") actions.deleteSelection();
            if (event.key === "Escape") actions.escape();
        };
        const handleClipboard = (event: ClipboardEvent) => {
            if (current.current.readOnly || event.defaultPrevented || !event.clipboardData) return;
            if (isEditableTarget(event.target) || isEditableTarget(document.activeElement) ||
                event.target instanceof HTMLSelectElement || document.activeElement instanceof HTMLSelectElement ||
                window.getSelection()?.isCollapsed === false) return;
            const action = event.type === "copy" ? current.current.copy : current.current.paste;
            if (action(event.clipboardData)) event.preventDefault();
        };
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("copy", handleClipboard);
        window.addEventListener("paste", handleClipboard);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("copy", handleClipboard);
            window.removeEventListener("paste", handleClipboard);
        };
    }, []);
}
