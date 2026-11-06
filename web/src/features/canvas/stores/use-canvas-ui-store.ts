import { create } from "zustand";

type CanvasUiStore = {
    editingProjectId: string | null;
    editingProjectTitle: string;
    deleteProjectIds: string[];
    startEditingProject: (id: string, title: string) => void;
    setEditingProjectTitle: (title: string) => void;
    stopEditingProject: () => void;
    setDeleteProjectIds: (ids: string[]) => void;
};

export const useCanvasUiStore = create<CanvasUiStore>((set) => ({
    editingProjectId: null,
    editingProjectTitle: "",
    deleteProjectIds: [],
    startEditingProject: (editingProjectId, editingProjectTitle) => set({ editingProjectId, editingProjectTitle }),
    setEditingProjectTitle: (editingProjectTitle) => set({ editingProjectTitle }),
    stopEditingProject: () => set({ editingProjectId: null }),
    setDeleteProjectIds: (deleteProjectIds) => set({ deleteProjectIds }),
}));
