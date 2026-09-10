# media.expires_at 重复写入优化与 50 人 A/B 报告

测试日期：2026-09-10，Asia/Shanghai。业务基线：86ee114111f245eef2bb7ea819a32961241cee13。

## 结论

本次窄范围优化消除了负载中未改变过期时间的写入：**UPDATE 调用和实际更新行数均从 56,084 降至 0**。两组的媒体保留状态、媒体审计数量及运行结果一致，未发现 revision 静默覆盖或生命周期回归。

Canvas PUT 的 p95 从 **50.75 ms 降到 21.67 ms**（下降 57.3%），p99 从 **113.14 ms 降到 44.63 ms**（下降 60.6%）。PostgreSQL 平均 CPU 从 9.22% 降至 7.73%。这是一次本地 A/B 的观测结果，不是生产容量承诺。

本次负载保留既有引用，运行结果也以保留状态创建，因此目标过期时间均未变化；**0 UPDATE 不代表以后所有保存都不写媒体状态**。真正的时间变化仍需 UPDATE，已通过真实数据库测试验证。

## 修改范围与语义

三个现有入口在行锁及校验后比较当前 expires_at 与目标值：Canvas 引用维护、Workflow 引用维护、SetPrivateMediaExpiry。值相同不调用 UPDATE；不以“引用集合未变化”跳过校验。

- nil 与 nil 相等；非空时间按 PostgreSQL/pgx 的微秒精度比较同一时刻，时区表示不同不算变化。
- Setter 合法 no-op 仍返回 true，表示请求有效，不改变调用方已有成功判定。
- Canvas/Workflow 的引用新增、移除及其引用审计照常执行；期限变化时的既有审计也保留，guard 仅在期限不变时跳过后续写入。
- 媒体锁顺序、所有者/公开素材权限、active/deleting 检查、事务回滚、清理 claim、5 分钟延迟、revision/409 和幂等回放不变。
- 未修改 Canvas 列表、素材分页、媒体删除、数据库结构、前端或生成接口。

## 测试先行

新增真实 PostgreSQL 集成测试，通过 GORM Update 回调统计 SQL 调用及 RowsAffected；不是仅断言最终字段值，也不是允许 UPDATE 发出后影响 0 行。

旧代码的 NULL→NULL、时间A→时间A、时区/微秒等值、Canvas 和 Workflow 保留引用场景均出现 1 次 UPDATE / 1 行更新，违反 0/0 断言。优化后通过。

覆盖 NULL→NULL、A→A 不写，A→NULL、NULL→B、A→B 正常写；引用增删和审计、保留引用仍拒绝 missing/foreign/deleting、Canvas revision 与幂等重放。既有清理并发、claim 租约、事务回滚、Workflow 保存和权限测试也参与全量回归。

## A/B 方法

A 使用修改业务代码前保存的压测二进制，B 使用本次修改后编译的二进制；共享相同 cmd/loadtest 源码、fixtures 和随机种子 1000。两次顺序执行，各自创建全新 PostgreSQL 容器及 schema，不复用旧报告中已经过 10/30 人预热的 50 人数据。

每次 50 个用户，30 秒升压、180 秒稳态、30 秒降压，再完成读回和恢复期观察。用户组合 50% 浏览、30% Canvas 编辑、20% Workflow 操作，保存间隔 2～5 秒；独立账号及文档，中途附加 10 轮同 revision 竞争保存。运行真实 Workflow 调度，但只有进程内免费 fake provider。

每人 3 张 Canvas（30/150/250 节点）、200 条素材元数据、5 文件夹、12 节点 Workflow（分支汇合共 7 输出）、10 条历史运行。相同画布内会复用媒体；不是每个图片节点都对应不同文件。

环境：MacBookPro18,1 / arm64 / 10 CPU / 32 GiB；Docker VM 10 CPU / 7.75 GiB；PostgreSQL 17.11 容器限制 2 CPU / 1 GiB，磁盘卷，fsync 和 synchronous_commit 开启。原生 Go 1.26.6 / GOMAXPROCS=4，池 20 open / 10 idle / 30m lifetime。未测试生产网关、TLS、门户登录、浏览器状态或 OSS 原图传输。

## 统计口径

- expiry UPDATE：pg_stat_statements 中该语句的 calls/rows，在初始化结束后与负载结束后取差；包括三阶段、冲突和校验期间，排除种子数据。Canvas、Workflow 及 setter 使用同类 SQL，合并统计，不能把总数全部归为 Canvas。
- API p95/p99：只统计 180 秒稳态正常业务请求，nearest-rank；预期 409/401/403 单列。
- PostgreSQL CPU：docker stats 抽样，100% 相当于一个 CPU；Go CPU 单独统计。连接池等待是累计 WaitCount/WaitDuration 的差。
- 语句 WAL：同一 UPDATE 聚合的 wal_bytes 差；实例 WAL：LSN 字节差，包含其他 SQL 和后台活动，不能等同于 media UPDATE 的 WAL。
- dead tuples 为异步统计估计，autovacuum 会回收；记录末态及 autovacuum 次数，不能把末态差当成累计新增死元组。
- 封闭用户模型下耗时变化可能改变完成循环数，因此同时报告请求数与每次成功 Canvas 保存对应的聚合 UPDATE 数；后者仍包含 Workflow 工作，不能解释为一次 Canvas 的精确成本。
- 单次 A/B、每次三分钟稳态，且与其他开发进程共享主机；延迟/CPU 是本次观测，不能直接推定生产容量增幅。

## A/B 实测结果

A 升压开始于 17:47:06，B 于 17:53:06；每次稳态 180 秒。SQL 快照窗口分别是 17:47:05～17:51:16 和 17:53:05～17:57:16。资源汇总覆盖该档升压至最后短暂观察，CPU 不仅取稳态。

| 指标 | A：修改前 | B：优化后 |
| --- | ---: | ---: |
| 全部记录请求 | 16298 | 16323 |
| 稳态正常请求 | 13628 | 13681 |
| 稳态 RPS | 75.71 | 76.01 |
| 成功 Canvas 保存回执（含冲突胜出者） | 1420 | 1425 |
| expires_at UPDATE calls | 56084 | 0 |
| expires_at UPDATE 实际 rows | 56084 | 0 |
| 该 SQL 累计数据库执行时间（ms） | 2108.38 | 0.00 |
| 聚合 UPDATE calls / 成功 Canvas 保存回执 | 39.50 | 0.00 |
| Canvas PUT p95 / p99（ms） | 50.75 / 113.14 | 21.67 / 44.63 |
| Workflow PUT p95 / p99（ms） | 13.75 / 29.30 | 13.15 / 29.70 |
| PostgreSQL CPU 平均 / 峰值 | 9.22% / 27.52% | 7.73% / 24.27% |
| 连接池等待次数 / 总等待 ms | 0 / 0 | 0 / 0 |
| 连接池占用峰值 | 6 | 4 |
| PG 锁等待者 / 被阻塞者峰值 | 0 / 0 | 0 / 0 |
| 正常负载 5xx / 非预期错误率 | 0 / 0% | 0 / 0% |
| 预期 409 | 10 | 10 |
| 该 UPDATE 的 WAL（bytes） | 6748157 | 0 |
| 整个测试 PG 实例的 WAL 增量（bytes） | 31848584 | 24187296 |
| media 末态 dead tuples 估计 | 1429 | 0 |
| media autovacuum 次数（含初始化阶段） | 2 | 1 |

B 完成的正常请求和保存略多，减少 UPDATE 并非通过少做业务获得。分母使用全部成功 Canvas 保存回执；聚合 SQL 仍包含 Workflow 相关调用，该比率只用于负载量归一化。

语句 WAL 减少 6,748,157 bytes（约 6.44 MiB）。实例 WAL 从 30.37 MiB 降至 23.07 MiB；不能把全部差额都归因于一个 SQL。保留的 SELECT FOR UPDATE、引用事务等仍可能产生 WAL。

Workflow PUT 的改善很小，p99 从 29.30 ms 小幅升至 29.70 ms，不据此宣称所有接口都提速。两组初始化也各自使用对应版本代码：A 初始化有 5,850 次 expiry UPDATE，B 为 0；这些不计入表中 UPDATE 差值，但可能影响初始物理表状态、autovacuum 和后续延迟。

## 一致性和回归证据

- 两次各完成 10 轮同 revision 的竞争保存，每轮恰好一胜一 409；最终读回文档与 revision 正确，没有 500 或旧数据静默覆盖。
- 各自有 500 条历史运行和 40 条新增 fake 运行，最终 540 条均 completed；280 次新增 attempt 均 succeeded，结果数、媒体归属、任务唯一性均通过。
- 各自最终 10,280 条媒体均 retained；媒体审计均为 `media_created=280`、`media_reference_added=6225`。全量审计计数相同仅作辅助证据；实际清理、重设期限、回滚的语义由集成测试验证。
- 50 个 Session 的身份隔离、非管理员权限、no-store 响应及各自素材查询通过。预期 401/403 和无权限业务响应不计为系统故障。
- Go 全量 `go test ./... -count=1`、repository 全套、`go test -race ./repository ./service -count=1`、`go vet ./...` 均通过。
- 前端 Bun **568 pass / 0 fail**，TypeScript 和 Next 生产构建通过；没有修改前端代码。
- 独立只读复审未发现锁、审计、返回值或生命周期语义变化。`git diff --check` 通过。
- 两套 A/B 容器及回归专用容器均已自动或定向清理，没有修改生产或现有应用 Docker。

## 复现与文件

- 生产改动：`repository/media.go`、`repository/canvas_media.go`、`repository/workflow_media.go`，共增加 18 行。
- 新回归：`repository/media_expiry_write_test.go`。
- 复用压测入口：`cmd/loadtest/`；脚本 `scripts/loadtest/run.sh` 增加指定用户档位与预编译二进制选项，`database-snapshot.py` 采集 SQL/WAL，`finish.py` 补充最终媒体状态及审计计数。
- 结构化结果：[A/B results](media-expiry-write-optimization-2026-09-10-results.json)。包含逐 API 指标、数据库前后快照、最终一致性及源码/二进制 SHA-256。
- 原始证据：[A/B evidence](media-expiry-write-optimization-2026-09-10-evidence.tar.gz)。含 requests/metrics、统计结果、测试日志、源码 diff 和程序校验值，不含二进制、密码或真实用户素材。
- 证据包 SHA-256：`3fb782ec64d11d0beb2abe68e7bd3e78530614ae1c00e4b5d75c76b35766ce7e`，48 个文件，已逐项读回核对。
- 运行方式见 [压测 README](../scripts/loadtest/README.md)。重做 A/B 时，先分别编译同一驱动搭配基线与优化业务代码的程序，再按顺序运行；不要只凭当前工作区 HEAD 判断预编译程序内容。

```sh
LOADTEST_USERS=50 LOADTEST_BINARY=/tmp/before-loadtest bash scripts/loadtest/run.sh /tmp/loadtest-before
LOADTEST_USERS=50 LOADTEST_BINARY=/tmp/after-loadtest bash scripts/loadtest/run.sh /tmp/loadtest-after
```

本次仅做本地优化和一个独立 commit，不推送或部署。回退时恢复这三个生产文件的 guard/helper 即可，不涉及数据迁移。已有校验和状态变更仍为后续维护的边界，不应为了进一步减少 SQL 跳过。
