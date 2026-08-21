"use client";

import { Button, Input } from "antd";
import { ImagePlus, Search } from "lucide-react";

type MaterialDrawerToolbarProps = {
    keyword: string;
    placeholder: string;
    onKeywordChange: (value: string) => void;
    onAddImage?: () => void;
    isUploading?: boolean;
};

export function MaterialDrawerToolbar({ keyword, placeholder, onKeywordChange, onAddImage, isUploading = false }: MaterialDrawerToolbarProps) {
    return (
        <div className="flex items-center gap-2">
            <Input
                className="min-w-0 flex-1"
                size="small"
                prefix={<Search className="size-3.5 text-stone-400" />}
                placeholder={placeholder}
                value={keyword}
                allowClear
                onChange={(event) => onKeywordChange(event.target.value)}
            />
            {onAddImage ? (
                <Button size="small" icon={<ImagePlus className="size-3.5" />} loading={isUploading} disabled={isUploading} onClick={onAddImage}>
                    添加图片
                </Button>
            ) : null}
        </div>
    );
}
