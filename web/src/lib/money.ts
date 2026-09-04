const cnyAmountPattern = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/;

export function isCNYAmountInput(value: string) {
    return cnyAmountPattern.test(value.trim());
}

export function formatCNYAmount(value: string) {
    const normalized = value.trim();
    if (!isCNYAmountInput(normalized)) return `¥${normalized || "0.0000"}`;
    const [integer, fraction = ""] = normalized.split(".");
    return `¥${integer}.${fraction.padEnd(4, "0")}`;
}
