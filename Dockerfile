# 依照现有 bun.lock 安装前端依赖。
FROM oven/bun:1.3.13 AS web-deps

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
RUN ./node_modules/.bin/next build

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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
# 先启动内部 Go API，再由 Next.js 提供页面并代理 /api/*。
CMD ["sh", "-c", "PORT=8082 /app/server & cd /app/web && HOSTNAME=0.0.0.0 PORT=3000 ./node_modules/.bin/next start"]
