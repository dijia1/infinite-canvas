# Canvas Summary SQL：重复 JSON 转换与候选对比

日期：2026-09-10。代码基线：`f43a53d`。本轮为独立测试库 SQL 实验，未修改 Repository、API、数据库结构或业务代码；未提交、推送、部署。

## 结论

当前 `document` 的实际数据库类型是 **text**。对 nodes、connections 都是数组的正常文档，当前表达式分别在类型检查与长度计算时转换 JSONB；诊断探针验证为每行 **4 次**。普通子查询或普通 LATERAL 被展开，未减少求值。

两种写法把每行转换降为 1 次：`MATERIALIZED CTE`、`LATERAL + OFFSET 0`。本轮更推荐后者进入后续代码实现：在 3/30/300 张画布实验中均较快，且没有 CTE 缓存整个解析结果带来的临时文件写入。此次只交付经过验证的候选，不把纯 SQL 收益当成新的 API/50 人压测收益。

## 方法与证据强度

使用与前次 A/B 相同的 PostgreSQL 17.11 / aarch64 官方镜像，独立容器限制 2 CPU、1 GiB，`work_mem=4MiB`、`shared_buffers=128MiB`。复用当前 fake 压测夹具：50 个账号、150 张 Canvas，每账号 30/150/250 节点各一张，document 总字节数 7,217,700。没有调用图片/视频供应商。

1. 对五种原生 SQL 执行 `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)`。
2. 对每个账号对比完整 Summary 结果，包括 id、title、revision、时间及两个计数，共 150 行。
3. 用独立 `IMMUTABLE STRICT` PL/pgSQL 函数包裹一次 `text::jsonb` 转换，以 `pg_stat_xact_user_functions` 记录调用次数。探针不写业务表，但函数实现会阻止其自身被内联，因此探针用于求值验证，不用于性能数字。
4. 所有耗时数据使用**未包裹探针的原生 SQL**，`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`，单连接交错随机顺序执行。原始规模每变体预热 4 次，统计 60 次；扩展规模每变体预热 2 次，统计 12 次。

`EXPLAIN` 本身没有输出内置 `jsonb_in` 调用次数；不能简单数 VERBOSE 各层重复显示的表达式。这里用执行计划、独立计数探针、原生 SQL 耗时和 BUFFERS 共同确认重复求值；没有声称做过内置 C 函数级 profiling。

## 原始规模：每次返回 3 张画布

| 写法 | 探针调用数 / 3 行 | 平均 ms | p50 ms | p95 ms | 平均 shared hit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 当前 SQL | 12 | 6.811 | 6.621 | 7.889 | 23.40 |
| 普通子查询 | 12 | 6.902 | 6.884 | 7.751 | 23.40 |
| 普通 LATERAL | 12 | 6.879 | 6.923 | 7.561 | 23.40 |
| MATERIALIZED CTE | 3 | 2.140 | 2.169 | 2.425 | 7.35 |
| LATERAL + OFFSET 0 | 3 | 2.003 | 2.029 | 2.252 | 7.35 |

`LATERAL + OFFSET 0` 平均耗时降低 **70.59%**。本组全部为热缓存，shared read 和临时读写为 0；shared hit 是逻辑缓冲访问次数，不能当作磁盘读取字节。

当前、普通子查询和普通 LATERAL 都变成 `Index Scan → Sort`，转换仍留在返回表达式中。普通子查询里的别名并不是一个复用缓存。

候选计划为：

```text
Index Scan：按 owner_uid 选中 3 行
  ↓
Nested Loop
  └── Result：document::jsonb，Actual Rows=1，Loops=3
  ↓
Sort：updated_at DESC，只排序摘要字段
```

原 SQL 和候选都使用已有 owner_uid 索引；不需要通过增加索引解决这次重复解析。`OFFSET 0` 不丢弃数据，在当前 PostgreSQL 17 优化器中阻止这层子查询被提升/展开；这是有意保留的执行边界，后续实现应写清原因，升级 PostgreSQL 时复查计划。[PostgreSQL 17 优化器源码](https://raw.githubusercontent.com/postgres/postgres/REL_17_STABLE/src/backend/optimizer/prep/prepjointree.c)

## 数量扩大后的差异

额外测试每账号 30、300 张 Canvas，按原 30/150/250 节点配比复制，并修改 viewport，避免全部 document 相同。这是合成扩展样本，JSON 重新序列化格式与原始 Go 夹具略有不同；只做同组候选横向对比。

| 每账号画布数 | 写法 | 平均 ms | p95 ms | 平均临时写 blocks |
| --- | --- | ---: | ---: | ---: |
| 30 | 当前 SQL | 61.861 | 64.581 | 0 |
| 30 | MATERIALIZED CTE | 17.318 | 17.851 | 0 |
| 30 | LATERAL + OFFSET 0 | 15.422 | 16.230 | 0 |
| 300 | 当前 SQL | 614.573 | 622.221 | 0 |
| 300 | MATERIALIZED CTE | 181.829 | 194.933 | 2240 |
| 300 | LATERAL + OFFSET 0 | 154.678 | 158.038 | 0 |

300 张画布时，MATERIALIZED CTE 每次平均写 2,240 个临时块（按 8KiB/block 约 **17.5 MiB**），计划将这项写入归于 CTE Scan；最终 Sort 仍是内存 quicksort（约 67KiB），因此不是最终摘要排序溢出。CTE 先存下完整 JSONB 中间结果，超过 work_mem 后产生临时写入。LATERAL 候选逐行转换、立即计算数量，实测临时写入为 0。

官方文档说明 `MATERIALIZED` 可确保独立计算，也会限制优化器下推条件；本实验 CTE 内已包含 owner 过滤，没有先物化全部用户的数据。[PostgreSQL CTE 文档](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION)

## 候选 SQL

```sql
SELECT
    c.id, c.title, c.revision, c.created_at, c.updated_at,
    CASE WHEN jsonb_typeof(p.doc -> 'nodes') = 'array'
         THEN jsonb_array_length(p.doc -> 'nodes') ELSE 0 END AS node_count,
    CASE WHEN jsonb_typeof(p.doc -> 'connections') = 'array'
         THEN jsonb_array_length(p.doc -> 'connections') ELSE 0 END AS connection_count
FROM canvas_projects AS c
CROSS JOIN LATERAL (
    SELECT c.document::jsonb AS doc
    OFFSET 0 -- 保持独立求值，避免子查询展开后重复转换。
) AS p
WHERE c.owner_uid = $1
ORDER BY c.updated_at DESC;
```

这条查询仅改变 Summary 的读表达式；输出 DTO、owner 条件、排序、计数默认值均保持原样。`$1` 继续绑定参数，不拼接用户输入。回退时恢复原 SELECT 即可，不涉及数据迁移。

## 边界结果

- 50 个原夹具账号：五种查询的全部 Summary 内容一致。
- 扩展 30/300 张规模：三种查询的完整结果摘要一致。
- SQL NULL、JSON null、缺失字段、非数组字段、空数组、根为数组/字符串：原有 0 计数语义保持。
- 合法数组按实际长度计数，正常结果一致。
- 非法 JSON 文本：五种写法仍抛出 `22P02`，没有将损坏数据静默当作空画布。
- 其他账号存在非法 JSON 时，合法账号查询仍成功，owner 过滤有效。
- SQL 不写入 Canvas，不触发 revision、媒体引用、清理、幂等或保存协议变化。

## 下一步与限制

建议下一步只把 `ListCanvasProjects` 切换到上述候选，并补真实 Repository 的结果/权限回归及计划防退化验证，然后再进行同夹具 50 人 A/B，以确认 API 延迟和 PostgreSQL CPU 的实际变化。本轮没有改业务代码，因此未重复运行前端构建或完整 Go 回归。

这里测得的是热缓存、单连接 SQL 执行时间；不是网络耗时、API p95，也不是 50 个并发查询。扩展组只有 12 个样本，p95 接近最大值，仅用于发现 CTE 溢出和数量增长趋势。即使解析仅做一次，成本仍随完整 document 大小与画布数量增长。

## 复现

[原始计划、探针、结果和实验脚本](canvas-summary-sql-2026-09-10-evidence.tar.gz) 可解压到新的临时目录。先从本项目构建专用 fake 压测入口：

```sh
go build -o /tmp/canvas-summary-sql-loadtest ./cmd/loadtest
# 在解压目录启动，保持该终端运行；会创建独立测试容器。
LOADTEST_BINARY=/tmp/canvas-summary-sql-loadtest bash run-owned.sh
# 另一个终端进入同一解压目录，依次执行：
python3 compare.py
python3 probe.py
python3 boundaries-scale.py
# 最后回到第一个终端 Ctrl+C，由脚本关闭 fake API 并删除测试容器。
```

复现目录必须没有旧 manifest，边界/扩展夹具只在新库执行一次。压测入口限制本地测试 DSN，禁止外部生成网络请求；归档不含数据库凭据、manifest 或可执行文件。SQL 实验完成后已清理本轮专用容器和进程。
