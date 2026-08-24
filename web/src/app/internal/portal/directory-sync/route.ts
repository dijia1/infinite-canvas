import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    const apiBaseURL = process.env.API_BASE_URL || "http://127.0.0.1:8082";
    const response = await fetch(`${apiBaseURL.replace(/\/$/, "")}/internal/portal/directory-sync`, {
        method: "POST",
        headers: {
            "content-type": request.headers.get("content-type") || "application/json",
            "x-portal-service-key": request.headers.get("x-portal-service-key") || "",
            "x-portal-service-secret": request.headers.get("x-portal-service-secret") || "",
        },
        body: request.body,
        duplex: "half",
    } as RequestInit & { duplex: "half" });

    return new Response(null, { status: response.status });
}
