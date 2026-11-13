import { hasImageMask } from "@/lib/image-mask/mask-utils";
import type { ImageRequestSchema } from "./image-request-schema";
import type { ReferenceImage } from "@/types/image";

export function imageEditReferenceError(references: ReferenceImage[], schema?: ImageRequestSchema) {
    if (references.length < 1 || references.length > 10) return "图像编辑需要 1–10 张参考图";
    if (schema && references.length > schema.maxReferenceImages) return `当前模型最多支持 ${schema.maxReferenceImages} 张参考图`;
    if (schema?.supportsMask === false && references.some((reference) => hasImageMask(reference.mask))) return "当前模型不支持遮罩编辑";
    const maskedIndexes = references.flatMap((reference, index) => (hasImageMask(reference.mask) ? [index] : []));
    if (maskedIndexes.length > 1) return "图像编辑只能使用一个遮罩";
    if (maskedIndexes[0] !== undefined && maskedIndexes[0] !== 0) return "带遮罩的主图必须位于第一张参考图";
    return undefined;
}
