export const PRIVATE_IMAGE_DRAG_TYPE = "application/x-infinite-canvas-private-image";
export const PUBLIC_IMAGE_DRAG_TYPE = "application/x-infinite-canvas-public-image";

export type PrivateImageDropPayload = {
    assetId: string;
};

export type PublicImageDropPayload = {
    id: string;
    mediaId: string;
    title: string;
};

export function readImageDropPayload<T>(value: string): T | null {
    if (!value) return null;
    try {
        const payload = JSON.parse(value);
        return payload && typeof payload === "object" ? (payload as T) : null;
    } catch {
        return null;
    }
}
