"use client";

import { DeleteOutlined, UploadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Empty, Input, Pagination, Popconfirm, Spin } from "antd";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";

import { clipboardImageFile } from "@/lib/clipboard-image";
import { deleteAdminPublicImage, fetchPublicImageAccess, fetchPublicImages, uploadAdminPublicImage, type PublicImage } from "@/services/api/public-images";

const PAGE_SIZE = 12;

export function PublicImageManager() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const inputRef = useRef<HTMLInputElement>(null);
    const [keyword, setKeyword] = useState("");
    const deferredKeyword = useDeferredValue(keyword);
    const [page, setPage] = useState(1);
    const query = useQuery({ queryKey: ["admin-public-images", deferredKeyword, page], queryFn: () => fetchPublicImages({ keyword: deferredKeyword, page, pageSize: PAGE_SIZE }), retry: false });
    const upload = useMutation({
        mutationFn: (file: File) => uploadAdminPublicImage(file, file.name),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin-public-images"] });
            await queryClient.invalidateQueries({ queryKey: ["public-images"] });
            message.success("公共图片已上传");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "上传失败"),
    });
    const remove = useMutation({
        mutationFn: deleteAdminPublicImage,
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin-public-images"] });
            await queryClient.invalidateQueries({ queryKey: ["public-images"] });
            message.success("公共图片已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });

    const uploadFile = useCallback(
        (file: File) => {
            if (!file.type.startsWith("image/")) {
                message.error("仅支持图片文件");
                return;
            }
            upload.mutate(file);
        },
        [message, upload],
    );

    useEffect(() => {
        setPage(1);
    }, [deferredKeyword]);

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            if (isEditableTarget(event.target)) return;
            const file = clipboardImageFile(event.clipboardData?.items || []);
            if (!file) return;
            event.preventDefault();
            uploadFile(file);
        };
        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [uploadFile]);

    return (
        <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold">公共图片素材</h1>
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">可选择文件或直接粘贴图片上传。</p>
                </div>
                <>
                    <input
                        ref={inputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) uploadFile(file);
                        }}
                    />
                    <Button type="primary" icon={<UploadOutlined />} loading={upload.isPending} onClick={() => inputRef.current?.click()}>
                        上传公共图片
                    </Button>
                </>
            </div>
            <Input.Search value={keyword} allowClear placeholder="搜索公共图片" className="max-w-sm" onChange={(event) => setKeyword(event.target.value)} />
            {query.isLoading ? (
                <div className="flex justify-center py-12">
                    <Spin />
                </div>
            ) : query.data?.items.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                    {query.data.items.map((image) => (
                        <AdminPublicImageCard key={image.id} image={image} onDelete={() => remove.mutate(image.id)} deleting={remove.isPending} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.isError ? "读取公共图片失败" : "暂无公共图片"} />
            )}
            {(query.data?.total || 0) > PAGE_SIZE ? <Pagination current={page} pageSize={PAGE_SIZE} total={query.data?.total} showSizeChanger={false} onChange={setPage} /> : null}
        </section>
    );
}

function AdminPublicImageCard({ image, onDelete, deleting }: { image: PublicImage; onDelete: () => void; deleting: boolean }) {
    const [url, setURL] = useState("");

    useEffect(() => {
        let cancelled = false;
        void fetchPublicImageAccess(image.id)
            .then((result) => {
                if (!cancelled) setURL(result.url);
            })
            .catch(() => {
                if (!cancelled) setURL("");
            });
        return () => {
            cancelled = true;
        };
    }, [image.id]);

    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700">
            {url ? <img src={url} alt={image.title} className="aspect-square w-full object-cover" /> : <div className="aspect-square animate-pulse bg-stone-100 dark:bg-stone-800" />}
            <div className="flex items-center gap-1 p-2">
                <span className="min-w-0 flex-1 truncate text-xs">{image.title}</span>
                <Popconfirm title="删除这张公共图片？" onConfirm={onDelete} okButtonProps={{ danger: true }}>
                    <Button danger type="text" size="small" icon={<DeleteOutlined />} loading={deleting} aria-label={`删除 ${image.title}`} />
                </Popconfirm>
            </div>
        </div>
    );
}

function isEditableTarget(target: EventTarget | null) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}
