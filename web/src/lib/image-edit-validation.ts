import { hasImageMask } from "@/app/(user)/canvas/image-mask/mask-utils";
import type { ReferenceImage } from "@/types/image";

export function imageEditReferenceError(references: ReferenceImage[]) {
    if (references.length < 1 || references.length > 7) return "图像编辑需要 1–7 张参考图";
    const maskedIndexes = references.flatMap((reference, index) => (hasImageMask(reference.mask) ? [index] : []));
    if (maskedIndexes.length > 1) return "图像编辑只能使用一个遮罩";
    if (maskedIndexes[0] !== undefined && maskedIndexes[0] !== 0) return "带遮罩的主图必须位于第一张参考图";
    return undefined;
}
