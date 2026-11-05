import { create } from "zustand";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
};

// Theme switching is disabled; ignore previously persisted light preferences.
export const useThemeStore = create<ThemeStore>()(() => ({ theme: "dark" }));
