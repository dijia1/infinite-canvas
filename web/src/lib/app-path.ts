export function appPath(path: string, basePath = process.env.NEXT_PUBLIC_BASE_PATH || "") {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const normalizedBasePath = basePath.replace(/\/$/, "");

    return `${normalizedBasePath}${normalizedPath}`;
}

export function appApiPath(path: string, basePath = process.env.NEXT_PUBLIC_BASE_PATH || "") {
    return path.startsWith("/api/") ? appPath(path, basePath) : path;
}
