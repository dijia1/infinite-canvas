import type { ImageMask, ReferenceImage } from "@/types/image";

import { drawImageMask } from "./mask-utils";

export async function createImageMaskFile(mask: ImageMask, image: ReferenceImage): Promise<File> {
    const { width, height } = await imageDimensions(image);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持遮罩绘制");
    drawImageMask(context, mask, width, height, "#ffffff");
    const blob = await canvasToBlob(canvas);
    return new File([blob], "mask.png", { type: "image/png" });
}

async function imageDimensions(image: ReferenceImage): Promise<{ width: number; height: number }> {
    if (image.width && image.height) return { width: image.width, height: image.height };
    const source = image.dataUrl;
    if (!source) throw new Error("遮罩参考图尺寸缺失");
    const element = new Image();
    element.src = source;
    await element.decode();
    if (!element.naturalWidth || !element.naturalHeight) throw new Error("遮罩参考图尺寸无效");
    return { width: element.naturalWidth, height: element.naturalHeight };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("生成遮罩 PNG 失败"))), "image/png");
    });
}
