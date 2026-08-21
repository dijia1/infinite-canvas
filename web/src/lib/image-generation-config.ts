export const imageResolutionOptions = [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
] as const;

export type ImageResolution = (typeof imageResolutionOptions)[number]["value"];

export function normalizeImageResolution(value?: string): ImageResolution {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "1k" || normalized === "2k" || normalized === "4k") return normalized;
    const dimensions = normalized?.match(/^(\d+)x(\d+)$/);
    const largest = dimensions ? Math.max(Number(dimensions[1]), Number(dimensions[2])) : 0;
    if (largest <= 1792) return "1k";
    return largest <= 2048 ? "2k" : "4k";
}
