# 依照现有 bun.lock 安装前端依赖。
FROM oven/bun:1.4.0 AS web-deps

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --registry=https://registry.npmmirror.com --cache-dir=/root/.bun/install/cache

# 在 Node.js 中运行 Next.js，避免 Bun 在 Buildx 环境执行 Next 构建时触发 SIGILL。
FROM node:22-bookworm-slim AS web-build

WORKDIR /app/web
ARG NEXT_PUBLIC_BASE_PATH=/apps/infinite-canvas
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
COPY --from=web-deps /app/web/node_modules ./node_modules
COPY web ./
# Production deployments must give changed client bundles new content-hashed URLs.
# Turbopack's stable chunk paths combined with Next's immutable cache headers can
# leave an already-open browser running chunks from the preceding deployment.
RUN ./node_modules/.bin/next build --webpack

# 构建 Go 后端入口。
FROM golang:1.25-alpine AS api-build

WORKDIR /app
COPY go.mod go.sum ./
COPY ai ./ai
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN go build -o /server .

# 运行镜像：Next.js 对外监听 3000，Go 只在容器内部监听 8082。
FROM node:22-bookworm-slim

WORKDIR /app
ARG NEXT_PUBLIC_BASE_PATH=/apps/infinite-canvas
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
COPY --from=api-build /server /app/server
COPY --from=web-build /app/web /app/web
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*

COPY scripts/start-app.mjs /app/start-app.mjs

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=75s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# 后端就绪后才启动前端；任一子进程退出都会终止容器。
CMD ["node", "/app/start-app.mjs"]
