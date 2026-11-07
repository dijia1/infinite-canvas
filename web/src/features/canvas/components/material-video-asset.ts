import type { VideoAsset } from "@/stores/use-asset-store";
import { getVideoMediaAccess } from "@/services/api/video-media";
import { loadMediaThumbnail } from "@/services/image-storage";

export async function videoAssetDimensions(asset: VideoAsset, mediaId: string) {
    if (asset.data.width > 0 && asset.data.height > 0) return { width: asset.data.width, height: asset.data.height };
    // Generated media can lack dimensions. Its cached poster supplies the ratio
    // without loading the video bytes or probing it on the server.
    const poster = await loadMediaThumbnail(mediaId, async () => {
        const access = await getVideoMediaAccess(mediaId);
        if (!access.previewUrl) throw new Error("视频封面暂不可用，请重试");
        return access.previewUrl;
    });
    return { width: poster.width, height: poster.height };
}
