"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const DEFAULT_MASK_COLOR = "#ef4444";
export const MASK_PREVIEW_OPACITY = 0.3;

export function normalizeMaskPreviewColor(value: unknown): string {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_MASK_COLOR;
}

type MaskPreferences = {
    previewColor: string;
    setPreviewColor: (color: string) => void;
};

export const useMaskPreferencesStore = create<MaskPreferences>()(
    persist(
        (set) => ({
            previewColor: DEFAULT_MASK_COLOR,
            setPreviewColor: (color) => set({ previewColor: normalizeMaskPreviewColor(color) }),
        }),
        {
            name: "infinite-canvas:mask_preferences",
            partialize: (state) => ({ previewColor: state.previewColor }),
            merge: (persisted, current) => ({
                ...current,
                previewColor: normalizeMaskPreviewColor((persisted as { previewColor?: unknown } | null)?.previewColor),
            }),
        },
    ),
);
