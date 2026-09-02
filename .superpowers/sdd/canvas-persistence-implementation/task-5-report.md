# Task 5 完成报告

## 修复内容

1. 画布页面的初始与延迟图片恢复计划现在将仅含 `publicImageId` 的图片节点视为可恢复节点；两种恢复路径都会进入既有的公共访问恢复分支。
2. `CanvasProject.Document` 改为方言感知的 GORM 数据类型：MySQL 的 schema 目标明确为 `LONGTEXT`，避免 `AutoMigrate` 将既有 `LONGTEXT` 缩窄为 `MEDIUMTEXT`。SQLite 与 PostgreSQL 保持原有 JSON serializer 映射；旧 MySQL `TEXT` 会由 `AutoMigrate` 升级为新的 `LONGTEXT` 目标，支持超过 2 MiB 的文档。
3. 画布项目 ID 现在拒绝恰为 `.` 或 `..` 的路径段，create、read、update、delete 路由均覆盖该校验。

## TDD 证据

- `TestCanvasProjectDocumentUsesMySQLLongTextWithoutNarrowingExistingColumns` 首次失败，实际 GORM MySQL 目标为 `mediumtext`；改为方言感知类型后通过。
- `TestCanvasProjectRejectsDotPathSegmentsAcrossCRUD` 首次失败，`.` 与 `..` 的创建均返回 200；增加路径段校验后 create/read/update/delete 均返回 400。
- `canvas-image-hydration-plan.test.ts` 首次因缺少页面恢复计划导出而失败；页面计划接入公共图片节点后，初始和延迟候选都会调用公共访问恢复并得到稳定媒体 ID。

## 验证

- `go test ./...`：通过。
- `cd web && bun test`：244 pass，0 fail，50 files。
- `cd web && bun run typecheck`：通过。
- `cd web && bun run build`：通过。
- `git diff --check`：通过。

## 限制

当前环境没有真实 MySQL 实例，因此 MySQL 迁移通过 GORM DryRun schema target 回归验证；未执行在线 MySQL DDL 集成测试。
