import { useEffect, useRef } from "react";

type CanvasKeyboardActions = {
    readOnly: boolean;
    undo: () => void;
    redo: () => void;
    selectAll: () => void;
    copy: () => void;
    paste: () => void;
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
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
            const key = event.key.toLowerCase();
            if ((event.metaKey || event.ctrlKey) && !event.altKey) {
                const shortcut = key === "z" ? (event.shiftKey ? actions.redo : actions.undo) : key === "y" ? actions.redo : key === "a" ? actions.selectAll : key === "c" ? actions.copy : key === "v" ? actions.paste : undefined;
                if (shortcut) { event.preventDefault(); shortcut(); return; }
            }
            if (event.key === "Delete" || event.key === "Backspace") actions.deleteSelection();
            if (event.key === "Escape") actions.escape();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);
}
