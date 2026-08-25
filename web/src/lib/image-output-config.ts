export type ImageOutputFormat = "jpeg" | "png";

export function normalizeImageOutputFormat(value: unknown): ImageOutputFormat {
    return typeof value === "string" && value.trim().toLowerCase() === "png" ? "png" : "jpeg";
}

export function imageOutputSettings(value: unknown): { outputFormat: ImageOutputFormat; background: "opaque" | "transparent" } {
    const outputFormat = normalizeImageOutputFormat(value);
    return outputFormat === "png" ? { outputFormat, background: "transparent" } : { outputFormat, background: "opaque" };
}
