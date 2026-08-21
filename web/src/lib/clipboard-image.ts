type ClipboardItemLike = {
    type: string;
    getAsFile: () => File | null;
};

export function clipboardImageFile(items: Iterable<ClipboardItemLike>) {
    for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) return file;
    }
    return null;
}
