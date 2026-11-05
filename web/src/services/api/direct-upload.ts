export type DirectUploadOptions = { onProgress?: (percent: number) => void; signal?: AbortSignal };

function uploadAbortedError() {
    return Object.assign(new Error("上传已取消"), { name: "AbortError" });
}

export async function uploadDirectlyToOSS(uploadURL: string, file: Blob, options: DirectUploadOptions) {
    if (typeof XMLHttpRequest === "undefined") {
        const response = await fetch(uploadURL, {
            method: "PUT",
            body: file,
            headers: { "Content-Type": file.type },
            credentials: "omit",
            signal: options.signal,
        });
        if (!response.ok) throw new Error(`文件上传失败：OSS 返回 ${response.status}`);
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", abort);
            callback();
        };
        const abort = () => request.abort();

        request.open("PUT", uploadURL);
        request.setRequestHeader("Content-Type", file.type);
        request.upload.onprogress = (event) => {
            if (!event.lengthComputable || event.total <= 0) return;
            options.onProgress?.(Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))));
        };
        request.onload = () =>
            finish(() => {
                if (request.status >= 200 && request.status < 300) resolve();
                else reject(new Error(`文件上传失败：OSS 返回 ${request.status}`));
            });
        request.onerror = () => finish(() => reject(new Error("文件上传失败：无法连接 OSS")));
        request.onabort = () => finish(() => reject(uploadAbortedError()));
        if (options.signal?.aborted) {
            finish(() => reject(uploadAbortedError()));
            return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        request.send(file);
    });
}
