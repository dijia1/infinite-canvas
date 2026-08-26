import axios from "axios";

import { appApiPath } from "@/lib/app-path";

export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

type ApiResponse<T> = {
    code: number;
    data: T;
    msg: string;
};

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}

export function aiApiPath(path: string, basePath = process.env.NEXT_PUBLIC_BASE_PATH || "") {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return appApiPath(`/api/v1${suffix}`, basePath);
}

export function apiRequestError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

export function debugApiRequest(label: string, payload: Record<string, unknown>) {
    if (process.env.NODE_ENV !== "development") return;
    console.groupCollapsed(`[canvas-api] ${label}`);
    console.log(payload);
    console.groupEnd();
}

export function authorizationHeaders(token?: string) {
    if (!token || token === "portal") return undefined;
    return { Authorization: `Bearer ${token}` };
}

export function jsonRequestHeaders(body: unknown, token?: string) {
    return {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...authorizationHeaders(token),
    };
}

export async function apiGet<T>(url: string, params?: ApiParams, token?: string) {
    return apiRequest<T>({
        url,
        method: "GET",
        params: params || undefined,
        headers: authorizationHeaders(token),
    });
}

export async function apiPost<T>(url: string, body?: unknown, token?: string) {
    return apiRequest<T>({
        url,
        method: "POST",
        data: body,
        headers: jsonRequestHeaders(body, token),
    });
}

export async function apiDelete<T>(url: string, token?: string) {
    return apiRequest<T>({
        url,
        method: "DELETE",
        headers: authorizationHeaders(token),
    });
}

export async function apiPatch<T>(url: string, body: unknown, token?: string) {
    return apiRequest<T>({
        url,
        method: "PATCH",
        data: body,
        headers: jsonRequestHeaders(body, token),
    });
}

async function apiRequest<T>(config: { url: string; method: "GET" | "POST" | "PATCH" | "DELETE"; params?: ApiParams; data?: unknown; headers?: Record<string, string> }) {
    let response;
    try {
        response = await axios.request<ApiResponse<T>>({
            url: appApiPath(config.url),
            method: config.method,
            params: config.params,
            paramsSerializer: { serialize: (params) => serializeApiParams(params as ApiParams).toString() },
            data: config.data,
            headers: config.headers,
            validateStatus: () => true,
        });
    } catch {
        throw new Error("接口连接失败，请确认后端服务已启动");
    }

    const result = response.data;
    if (!result || typeof result !== "object") {
        throw new Error(response.status === 404 ? "接口不存在，请确认后端服务已启动" : "接口返回异常，请稍后重试");
    }

    const payload = result as ApiResponse<T>;
    if (response.status < 200 || response.status >= 300 || payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }

    return payload.data;
}
