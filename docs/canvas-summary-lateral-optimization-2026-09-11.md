# Canvas Summary：LATERAL + OFFSET 0 优化与 50 人验证

日期：2026-09-11。基线：`f43a53d`，已完成 Summary / Full Document 拆分及媒体 expires_at 重复写优化。

## 改动

生产代码只调整 `repository/canvas_project.go` 中的 `ListCanvasProjects`：通过 `CROSS JOIN LATERAL (SELECT canvas_projects.document::jsonb AS document OFFSET 0)` 独立计算 JSONB，再复用它计算节点数和连线数。`OFFSET 0` 用来防止子查询展开，把转换重新复制到每个 CASE 分支；注释已说明原因。

输出仍为 CanvasSummary；字段、归属过滤、updated_at 降序、缺失/null/非数组字段计数为 0 的规则不变。SQL NULL 和 JSON null 仍可读取；非法 JSON 保留数据库 22P02 错误。未新增数据库字段、索引或迁移，未改变详情/保存接口、revision、媒体引用、清理、Workflow 或前端。

## 回归验证

- 先增加实际 EXPLAIN ANALYZE 计划测试：旧查询不存在按行独立求值的转换节点，测试失败；优化后 3 行正常文档对应 3 次独立转换求值，测试通过。测试读取真实 Repository 发出的 SQL，避免仅检查字符串中是否出现 OFFSET。
- 原有 owner 隔离、计数、Summary 无 document、详情/导入完整性测试通过。
- 新增 SQL NULL、JSON null、根数组/字符串、同账号非法 JSON、其他账号非法 JSON 的回归；结果与原 SQL 一致。
- Go 定向、`go test ./...`、`go test -race ./repository ./router ./service` 全部通过。两组压测入口均构建成功。
- 本轮未修改前端，未重复运行 Bun/typecheck/前端 build；前端验证结果见上一轮 Summary 拆分报告。

## A/B 方法

相同现有脚本、随机种子 1000、50 个独立用户和夹具，先 A 后 B，每组新建专用 PostgreSQL 容器。30 秒升压、180 秒稳态、30 秒降压，之后进行数据回读和观察。每用户 3 张 Canvas（30/150/250 节点）、200 条素材元数据、5 文件夹、12 节点 Workflow 和 10 个预置运行。比例为浏览 50%、Canvas 编辑 30%、Workflow 操作 20%；生成仅使用进程内 fake provider。

API 百分位与响应体统计稳态正常请求，预期权限/409 响应单列。SQL 时间来自 pg_stat_statements，窗口包含整个运行；不是 API 延迟。资源采样覆盖升压、稳态、降压及短期恢复。测试期间没有并行构建或测试，但宿主是共享开发机；单次 A/B 不构成生产容量保证。

环境：Apple M1 Pro、10 核、32 GiB；Go 原生 darwin/arm64，GOMAXPROCS=4；PostgreSQL 17.11 容器限制 2 CPU、1 GiB，连接池 20 open / 10 idle / 30m lifetime。

## 实测结果

| 指标 | A：原 Summary SQL | B：LATERAL + OFFSET 0 |
| --- | ---: | ---: |
| 开始时间（UTC+8） | 00:44:47 | 00:50:08 |
| 全部请求记录数 | 16309 | 16311 |
| 稳态正常请求数 / RPS | 13658 / 75.88 | 13678 / 75.99 |
| 列表 API 平均 | 11.450 ms | 5.091 ms |
| 列表 API p50 | 10.836 ms | 4.596 ms |
| 列表 API p95 | 15.981 ms | 8.902 ms |
| 列表 API p99 | 20.795 ms | 12.286 ms |
| 列表 SQL 平均执行时间 | 9.886 ms | 3.235 ms |
| 列表 SQL 调用数 | 1504 | 1505 |
| 列表 SQL shared buffer hit 总数 | 48456 | 15197 |
| 列表平均响应体 | 586.33 B | 586.32 B |
| 稳态总响应体 | 211.36 MiB | 211.60 MiB |
| PostgreSQL 平均 CPU | 11.62% | 7.56% |
| Go 平均 CPU（100% 为一核） | 11.29% | 15.41% |
| Go RSS 峰值 | 36.41 MiB | 36.16 MiB |
| Go goroutine 起始 / 结束 / 峰值 | 17 / 25 / 34 | 17 / 25 / 33 |
| 连接池 open / in-use 峰值 | 6 / 5 | 6 / 3 |
| 连接池等待次数 / 等待时间 | 0 / 0 ms | 0 / 0 ms |
| PG 锁等待 / 阻塞峰值 | 0 / 0 | 0 / 0 |
| GORM >200ms / 查询错误 | 0 / 0 | 0 / 0 |
| 正常业务 5xx / 异常响应 / 传输错误 | 0 / 0 / 0 | 0 / 0 / 0 |

列表 p95 减少 **44.29%**，p99 减少 **40.92%**；数据库列表 SQL 平均执行时间减少 **67.27%**，PostgreSQL 平均 CPU 减少 **34.96%**。本次没有进一步减少 Summary 响应体，两组约为 586 字节；总响应体微小差异来自完成的请求数不同。

**未观察到所有指标同时改善。** Go 平均 CPU 从 11.29% 上升到 15.41%（相对增加 36.53%），部分非列表 API 的延迟也上升，见下表。Go RSS 峰值基本相同，不能声明显著节省 Go 内存。此次没有用 CPU profiling 或重复交错 A/B 定位 Go CPU 上升原因，不能直接归因为 SQL，也不能直接排除为宿主噪声；本次证据支持列表查询与 PostgreSQL 开销改善，不支持整体资源开销全面下降。

| API | A p95 / p99（ms） | B p95 / p99（ms） |
| --- | ---: | ---: |
| Asset list | 4.05 / 5.13 | 6.19 / 8.12 |
| Canvas GET | 4.39 / 5.76 | 7.11 / 8.67 |
| Canvas PUT | 18.48 / 22.29 | 21.21 / 25.79 |
| Canvas list | 15.98 / 20.79 | 8.90 / 12.29 |
| Folder list | 1.59 / 2.56 | 1.81 / 2.98 |
| Session | 4.90 / 6.73 | 6.89 / 10.70 |
| Workflow GET | 2.11 / 3.42 | 2.94 / 5.97 |
| Workflow PUT | 10.55 / 13.21 | 13.93 / 17.14 |
| Workflow Run create | 18.77 / 23.10 | 21.83 / 22.84 |
| Workflow Run list | 2.38 / 3.28 | 3.32 / 4.45 |
| Workflow Run poll | 3.79 / 5.28 | 4.70 / 6.63 |
| Workflow list | 2.15 / 4.18 | 2.58 / 3.44 |

两组各 50 个 Session 隔离与素材归属检查通过；10 轮同 revision 写入竞争均得到预期 409，401/403 等权限拒绝单列，未计为系统故障。两组均有 1,425 条成功 Canvas 保存回执、151 张 Canvas（含竞争测试项目）、50 个 Workflow，280 个 fake attempt 全部成功；包含预置运行在内的 540 个运行均完成。

revision 不匹配、输出数量错误、媒体缺失、归属错误、重复 attempt 均为 0；媒体创建和引用审计计数相同，expires_at UPDATE 均为 0。读取验证与复审未发现保存或媒体生命周期语义变化。

当前单次 50 人场景稳定，无崩溃、超时、连接池等待或读回一致性问题；每用户只有 3 张画布，不用于推断更大目录规模的生产容量。PostgreSQL 升级时需复查计划测试，因为此优化依赖独立求值边界。


## 证据与交付

- 独立 Sol/high 只读复审：两个代码文件，无阻塞问题；核对了权限、结果契约、边界与实际执行计划测试。
- `git diff --check` 通过；源码指纹对应通过回归和本次 A/B 的版本。
- [完整 A/B 结果](canvas-summary-lateral-2026-09-11-results.json)：每个 API 的 RPS、延迟、错误、SQL、资源与一致性。
- [可复核证据归档](canvas-summary-lateral-2026-09-11-evidence.tar.gz)：原始请求、资源采样、红绿测试、Go 全量/race 输出、代码差异/指纹、构建信息及汇总脚本。

复现方式保持现有 `scripts/loadtest/run.sh` 不变，分别构建 f43a53d 和本次版本的 `./cmd/loadtest`，通过 `LOADTEST_USERS=50 LOADTEST_BINARY=<对应二进制>` 指定每组；使用不同的新目录，顺序执行。归档中的 `summarize-ab.py` 可在解压目录重算结果。

A 二进制在修改前构建，受跟踪代码为 f43a53d；构建信息中的 modified=true 源于已有未跟踪文档。B 在本次修改后构建。未提交凭据或可执行文件，临时回归和压测数据库已按所属容器清理。

本轮只做本地修改与独立提交，不推送、部署、重启或重建正在运行的应用。前一轮 SQL 实验及更早压测的未跟踪文档保持原状。
