import { formatCNYAmount } from "./money";

export type ImageRequestFieldType = "select" | "boolean" | "text" | "number";

export type ImageRequestFieldOption = {
    value: string;
    label: string;
    price?: string;
};

export type ImageRequestField = {
    key: string;
    label: string;
    type: ImageRequestFieldType;
    description?: string;
    required: boolean;
    default?: unknown;
    options?: ImageRequestFieldOption[];
    fixedOptions?: boolean;
};

export type ImageRequestSchema = {
    version: string;
    fields: ImageRequestField[];
    maxReferenceImages: number;
    supportsMask: boolean;
};

export type ImageRequestOptions = Record<string, unknown>;

export function normalizeImageRequestOptions(schema: ImageRequestSchema | undefined, input: ImageRequestOptions | undefined): ImageRequestOptions {
    if (!schema) return {};
    const options: ImageRequestOptions = {};
    for (const field of schema.fields) {
        const value = input?.[field.key];
        // Keep an explicit ratio visible so model changes require a deliberate selection.
        if (field.key === "size" && typeof value === "string") {
            options[field.key] = value;
        } else if (isValidOption(field, value)) {
            options[field.key] = value;
        } else if (isValidOption(field, field.default)) {
            options[field.key] = field.default;
        }
    }
    return options;
}

export function schemaOptionString(options: ImageRequestOptions | undefined, key: string): string {
    const value = options?.[key];
    return typeof value === "string" ? value : "";
}

export function imageRequestOptionLabel(option: ImageRequestFieldOption) {
    return option.price ? `${option.label} · ${formatCNYAmount(option.price)}` : option.label;
}

function isValidOption(field: ImageRequestField, value: unknown): boolean {
    if (value === undefined) return false;
    if (field.type === "boolean") return typeof value === "boolean";
    if (field.type === "text") return typeof value === "string";
    if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === "string" && Boolean(field.options?.some((option) => option.value === value));
}
