export async function imageBlobFromResponse(response: Response) {
    if (!response.ok) throw new Error("下载图片失败");

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) throw new Error("媒体服务未返回图片内容");

    return response.blob();
}
