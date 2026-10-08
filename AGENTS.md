# AGENTS.md

## Project overview

Infinite Canvas：Go（Gin、GORM、PostgreSQL）后端，`web/` 下为 Next.js 前端（bun）。应用部署在 Portal Gateway 之后，用户身份由网关注入。

后端分层：`router` → `middleware` / `handler` → `service` → `repository` → `model`；`config` 和 `ai`（模型供应商适配）为共享依赖。`cmd/migrate` 是独立的数据库迁移入口。

新增依赖前检查 `go.mod` 和 `web/package.json`。

## Contextual docs

只在任务相关时读取对应文档，不需要在每次修改前全部阅读：

- 表结构、迁移与兼容升级：`docs/backend-database.md`
- 部署、发布与回滚：`docs/deployment.md`
- 前后端接口响应约定：`docs/api-response.md`
- 系统配置数据结构：`docs/system-settings.md`
- 画布数据结构：`docs/canvas-data-structure.md`
- 功能范围：`docs/features.md`

仓库没有独立的架构文档，服务边界调整以上面的分层说明为准；做出关键架构决策时，把结论写进对应的领域文档。

## Working boundaries

以下命令需要先停止并说明，不要直接运行：

- 读取 `.env` 的命令：`go run ./cmd/migrate`、直接启动后端、`docker compose -f docker-compose.local.yml` 等。`.env` 中的数据库和 OSS 配置不保证指向本地环境。
- 发布脚本：`scripts/deploy-production.sh`、`scripts/initialize-release-state.sh`、`scripts/cleanup-release-images.sh`，以及 `scripts/transition-canvas-health.sh --apply`（默认的 `--plan` 只打印计划）。

## Project checks

以下检查只使用一次性测试数据库，不读取 `.env`，可以直接运行。根据实际修改选择相关检查，不需要为了形式运行无关命令。

- 修改 Go 后端：`scripts/test-backend-postgres.sh`
  需要 Docker。脚本在 5433 端口启动临时 PostgreSQL，结束后连同数据卷一起删除。可以传包路径缩小范围，例如 `scripts/test-backend-postgres.sh ./repository/...`。依赖 PostgreSQL 的测试需要 `TEST_DATABASE_DSN`，所以不要直接运行 `go test ./...`。
- 修改 Web 前端：在 `web/` 下运行 `bun test`、`bun run typecheck`、`bun run build`
- 修改发布脚本或 compose 文件：`node --test scripts/*.test.mjs`；修改 Shell 脚本时额外运行 `bash -n <脚本>`
- 修改 schema 或迁移：
  - 新模型在 `repository/db.go` 的 `MigrateDatabase` 中注册。`AutoMigrate` 只增加表、列和索引，不会删除旧表或旧列。
  - 存量数据的搬迁、修复或回填写成显式迁移函数，由 `MigrateDatabase` 或 `cmd/migrate` 调用，并在 `repository/*_migration_test.go` 中补测试。
  - 迁移必须可重复执行，并兼容上一个发布版本：发布失败时只回滚镜像，不回滚数据库。
  - 用 `scripts/test-backend-postgres.sh` 验证，不要对 `.env` 中的数据库运行 `go run ./cmd/migrate`。
