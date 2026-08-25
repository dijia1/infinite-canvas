import { imageStorageKeyForMedia } from "@/services/image-storage";
import type { PrivateFolder, PrivateFolderList, PrivateImage, PrivateImageList } from "@/services/api/private-images";
import type { Asset, PrivateAssetFolder } from "./use-asset-store";

function sourceLabel(source: PrivateImage["source"]) {
    if (source === "generated") return "AI 生成";
    if (source === "canvas_temporary") return "画板临时素材";
    return "我的上传";
}

function toFolder(folder: PrivateFolder): PrivateAssetFolder {
    return {
        id: folder.id,
        name: folder.title,
        parentId: folder.parentId || undefined,
        createdAt: folder.createdAt,
        updatedAt: folder.createdAt,
    };
}

export function privateCatalogToAssetState(images: PrivateImageList, folders: PrivateFolderList): { assets: Asset[]; folders: PrivateAssetFolder[] } {
    return {
        folders: folders.items.map(toFolder),
        assets: images.items.map((image) => ({
            id: image.id,
            kind: "image" as const,
            title: image.title,
            coverUrl: "",
            tags: [],
            source: sourceLabel(image.source),
            folderId: image.folderId || undefined,
            data: {
                dataUrl: "",
                storageKey: imageStorageKeyForMedia(image.id),
                width: image.width,
                height: image.height,
                bytes: image.bytes,
                mimeType: image.contentType,
            },
            metadata: { mediaId: image.id, mediaSource: image.source, ...(image.expiresAt ? { expiresAt: image.expiresAt } : {}), uploadState: "uploaded" },
            createdAt: image.createdAt,
            updatedAt: image.createdAt,
        })),
    };
}
