import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
    const isDev = phase === PHASE_DEVELOPMENT_SERVER;
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

    return {
        assetPrefix: basePath || undefined,
        env: {
            NEXT_PUBLIC_BASE_PATH: basePath,
        },
        allowedDevOrigins: isDev ? ["*.*.*.*"] : [],
    };
}
