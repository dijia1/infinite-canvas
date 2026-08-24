import { imageStorageKeyForMedia } from "@/services/image-storage";
import type { PrivateFolder, PrivateFolderList, PrivateImageList } from "@/services/api/private-images";
import type { Asset, PrivateAssetFolder } from "./use-asset-store";

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
            source: image.source === "generated" ? "AI 生成" : "本地上传",
            folderId: image.folderId || undefined,
            data: {
                dataUrl: "",
                storageKey: imageStorageKeyForMedia(image.id),
                width: image.width,
                height: image.height,
                bytes: image.bytes,
                mimeType: image.contentType,
            },
            metadata: { mediaId: image.id, uploadState: "uploaded" },
            createdAt: image.createdAt,
            updatedAt: image.createdAt,
        })),
    };
}
