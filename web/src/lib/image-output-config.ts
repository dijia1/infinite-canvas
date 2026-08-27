export type ImageOutputFormat = "jpeg" | "png";
export type ImageBackground = "auto" | "opaque" | "transparent";

export function normalizeImageOutputFormat(value: unknown): ImageOutputFormat {
    return typeof value === "string" && value.trim().toLowerCase() === "png" ? "png" : "jpeg";
}

export function normalizeImageBackground(value: unknown): ImageBackground {
    const background = typeof value === "string" ? value.trim().toLowerCase() : "";
    return background === "opaque" || background === "transparent" ? background : "auto";
}

export function imageOutputSettings(value: unknown, backgroundValue?: unknown): { outputFormat: ImageOutputFormat; background: ImageBackground } {
    const outputFormat = normalizeImageOutputFormat(value);
    const background = normalizeImageBackground(backgroundValue);
    return outputFormat === "jpeg" && background === "transparent" ? { outputFormat: "png", background } : { outputFormat, background };
}
