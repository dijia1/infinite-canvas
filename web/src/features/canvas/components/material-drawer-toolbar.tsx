"use client";

import { Button, Input } from "antd";
import { ImagePlus, Search } from "lucide-react";

import { materialThumbnailColumns } from "./material-folder-ui";

type MaterialDrawerToolbarProps = {
    keyword: string;
    placeholder: string;
    onKeywordChange: (value: string) => void;
    onAddImage?: () => void;
    isUploading?: boolean;
    addLabel?: string;
};

export function MaterialDrawerToolbar({ keyword, placeholder, onKeywordChange, onAddImage, isUploading = false, addLabel = "添加图片" }: MaterialDrawerToolbarProps) {
    return (
        <div className="flex items-center gap-2">
            <Input className="min-w-0 flex-1" size="small" prefix={<Search className="size-3.5 text-stone-400" />} placeholder={placeholder} value={keyword} allowClear onChange={(event) => onKeywordChange(event.target.value)} />
            {onAddImage ? <Button size="small" icon={<ImagePlus className="size-3.5" />} loading={isUploading} disabled={isUploading} onClick={onAddImage} aria-label={addLabel} title={addLabel} /> : null}
        </div>
    );
}

export function MaterialThumbnailControl({ thumbnailStage, onThumbnailStageChange }: { thumbnailStage: number; onThumbnailStageChange: (value: number) => void }) {
    return (
        <div className="flex shrink-0 items-center justify-end border-t border-stone-200 px-4 py-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
            <input
                aria-label={`缩略图列数：${materialThumbnailColumns(thumbnailStage)}`}
                className="h-1 w-28 accent-stone-900 dark:accent-stone-100"
                type="range"
                min="0"
                max="3"
                step="1"
                value={thumbnailStage}
                onChange={(event) => onThumbnailStageChange(Number(event.target.value))}
            />
        </div>
    );
}
