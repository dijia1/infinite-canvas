import { Maximize2 } from "lucide-react";

export const navigationTools = [
    {
        slug: "canvas",
        label: "我的画布",
        icon: Maximize2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
