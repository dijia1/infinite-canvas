export function imageInputLabel(index: number) {
    return `图${index + 1}`;
}

export function moveInputKey(keys: readonly string[], from: number, to: number): string[] {
    const next = [...keys];
    const [key] = next.splice(from, 1);
    next.splice(to, 0, key!);
    return next;
}
