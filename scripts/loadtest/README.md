# infinite-canvas 隔离并发压测

测试对象是当前 Go Router、服务、Repository、PostgreSQL、完整文档保存和 Workflow 调度。普通程序入口和业务实现均不修改。Go 驱动使用实际 HTTP 请求，复用项目已有依赖；无需安装 k6。

## 运行

依赖：Go（匹配 `go.mod`）、Docker、Python 3.9+、OpenSSL。需要允许 Docker 操作，以及 `ps` 读取测试 API 进程资源。

从仓库根目录执行：

```sh
bash scripts/loadtest/run.sh
# 或指定一个全新、空的结果目录
bash scripts/loadtest/run.sh /tmp/infinite-canvas-loadtest-my-run
```

默认顺序为 10、30、50 用户，每档升压 30 秒、稳定 180 秒、降压 30 秒，另有短暂观察及最终 60 秒恢复观察。总运行约 14 分钟，另外需要编译、初始化数据库的时间。

只执行一档或用预先编译的程序做 A/B（每次仍创建全新数据库）：

```sh
LOADTEST_USERS=50 LOADTEST_BINARY=/tmp/before-loadtest bash scripts/loadtest/run.sh /tmp/loadtest-before
LOADTEST_USERS=50 LOADTEST_BINARY=/tmp/after-loadtest bash scripts/loadtest/run.sh /tmp/loadtest-after
```

两次必须顺序执行，使用相同 fixture、压测脚本和环境；压测时不要同时构建或跑其他压力任务。`binary-build.txt` 和 `binary-sha256.txt` 记录实际程序，目录内 `baseline.txt` 仅表示运行时仓库 HEAD，不能代替程序版本证明。

脚本创建新的 `postgres:17-alpine` 容器，限制 2 CPU / 1 GiB、使用 Docker 磁盘卷；不使用 tmpfs、不关闭 WAL/fsync。数据库仅绑定 `127.0.0.1` 随机端口，名称固定 `infinite_canvas_test`。程序再创建唯一隔离 schema，拒绝其他主机及数据库。API 为本机独立进程，`GOMAXPROCS=4`；连接池沿用默认 20/10、30 分钟寿命。结束后只移除本次创建的进程、容器和卷，保留结果目录。

测试入口不执行 `config.Load()`，不会加载项目 `.env`。只注册进程内 fake image provider，无真实供应商注册或密钥；HTTP 出站只允许该测试 API 自身的 loopback 地址。fake 返回 64×64 PNG，供真实图片任务持久化、媒体引用及 Workflow 后续步骤处理，价格为零。当前未覆盖视频任务的完整生成链路。

## 负载与数据

- 50 个独立账号，每人三张 Canvas：30 / 150 / 250 节点，包含图片、配置、文本及连线。按用户分配三种活跃文档尺寸。
- 每人一个 12 节点 Workflow，两条多输出分支汇合，合计 7 个输出槽。
- 每人 200 条素材元数据、5 个文件夹、10 条带快照的历史运行。只有 Workflow 的两张输入需要本地小图文件，其余不下载原图。
- 当前私有素材接口不分页，测试读取的是每账号完整列表；画布库接口也返回该用户三张画布的完整文档。图片节点复用本账号素材，三种尺寸画布分别涉及 15 / 50 / 50 个不同媒体 ID，未覆盖每节点都引用不同原图的最大素材多样性。
- 用户比例为普通浏览 50%、Canvas 编辑 30%、Workflow 操作 20%。编辑间隔随机 2～5 秒，发送完整文档并核对响应 revision 和内容，结束后重新读取核对持久化。
- Workflow 用户最多每分钟创建一次 fake 运行，持续查询运行列表和详情。使用原有 Image Worker 和 Workflow Scheduler。
- 每档中段额外进行 10 轮同一 Canvas、同一 revision 的双会话竞争写入，必须恰好一项成功、另一项 409，并读回验证胜出者文档。该短暂冲突会在基础用户之外增加最多两个请求。
- 401、合法 403、409 与跨用户不可访问响应单独计数。HTTP 200 但正文 `code != 0` 也会检查，非预期业务失败不能算成功。
- 最后并发读取 50 个 Session，检查身份、普通用户权限及 `Cache-Control: no-store`；核对数据库 revision、输出媒体所有者及任务唯一性。

## 结果文件

- `10|30|50/requests.ndjson`：逐请求状态、响应体 code、耗时、阶段、场景、响应字节，不存原始文档。
- `10|30|50/checks.json`：请求及一致性断言；失败使该档非零退出，后续档仍保留实际结果。
- `10|30|50/metrics.ndjson`：每两秒记录 Go CPU/内存/goroutine、SQL 计时、连接池及 PostgreSQL 活跃连接/锁等待/任务状态。
- `resources.ndjson`：约每六秒的进程 RSS、数据库容器 CPU/内存/I/O。
- `pg-statements.csv`、`postgres.log`：数据库聚合语句统计、200 ms 以上慢查询和锁等待日志。
- `database-before.json`、`database-after.json`：在种子数据完成后、负载结束后分别采集 expiry UPDATE 的 calls、rows、执行时间和语句 WAL。两者取差，不把初始化写入计入 A/B。数据库 WAL 位置差包含其他 SQL 及后台活动；dead tuples 是采样估计，会受 autovacuum 影响，不能作为累计写入量。
- `cooldown.ndjson`、`session-isolation.json`、`consistency.json`：恢复期资源与数据检查。
- `summary.json`：分档及分 API 汇总。单独重算：`python3 scripts/loadtest/summarize.py 结果目录`。

API 的 p50/p95/p99 使用实际请求样本 nearest-rank 计算；稳态 RPS 只统计稳定 180 秒中的普通用户请求。预期冲突与权限测试另列。GORM 计时包含驱动和网络等待，`pg_stat_statements` 表示数据库执行时间，两者不能混用。资源采样可能漏掉短暂峰值；连接池累计等待计数不会因为采样而漏掉等待。

## 解释边界

这是带思考时间的封闭用户模型，衡量指定操作组合下的稳定性，不是最大 HTTP 吞吐测试。Session 从可信 Portal 身份头进入应用，未压门户登录、网关、Next 代理、TLS、OSS 传输及真实供应商。

Canvas/Workflow 自动保存测试重放的是前端防抖后的 HTTP 文档保存；未运行浏览器 React 状态、Undo/Redo 或离页 flush。约三分钟稳态不能证明长期无内存泄漏，也不能直接作为生产 SLA。

发现非预期失败时，应先保留 `checks.json`、原始请求、数据库和 API 日志，依据证据定位；本脚本不自动调整连接池、增加索引或修改核心业务。
