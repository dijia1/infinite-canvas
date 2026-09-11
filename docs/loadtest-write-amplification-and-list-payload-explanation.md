# Canvas 重复媒体写入与列表数据量增长说明

日期：2026-09-10。适用代码：infinite-canvas 本地 `main`，基线 `86ee114111f245eef2bb7ea819a32961241cee13`。

本文解释两项压测发现的原因、实际影响和优化边界，只整理说明，不实施业务修改。

## 1. 先说结论

这两项开销来自当前实现的不同选择：

| 现象 | 当前实现为什么产生这项开销 | 后续优化方向 |
| --- | --- | --- |
| 保存一次画布，执行多次媒体 UPDATE | 保存时既维护画布文档，也维护媒体的保留状态；即使保留状态未改变，仍逐张执行 UPDATE | 保留校验和事务，只跳过没有实际变化的写入 |
| 打开列表，返回很多 JSON | 列表承担完整数据同步，返回了所有画布 document；私有素材也先全量获取，再在前端分页 | 区分列表摘要与编辑详情；私有素材改为服务端分页 |

前者随“保存次数 × 涉及的不同媒体数量”增长，后者随“列表请求次数 × 每人内容数量 × 单条内容大小”增长。

本轮 50 人压测仍通过，不能把这些开销说成已经造成系统故障。它们说明了数据量继续增长时，哪些地方会先产生不必要的工作。

## 2. 为什么保存画布会更新媒体

### 2.1 `expires_at` 管的是媒体保留时间

画布文档中保存 `mediaId`，图片或视频本体由媒体存储管理。保存画布时，系统需要保证仍被使用的媒体不会被后台清理误删。

在当前这条保留逻辑中：

- `expires_at = NULL`：没有安排按该过期时间清理。它不表示用户永远不能删除素材。
- `expires_at = 某个时间`：设置了可供清理流程检查的过期时间，不代表到这个时刻文件一定已经删除。
- 当前画布移除媒体后，还要检查其他画布、Workflow 等引用，满足条件才安排清理；画布路径的延迟值是 5 分钟。

因此，“保存画布时维护媒体引用和保留状态”本身是必要行为。问题出在最后执行写入前，没有排除状态未改变的情况。

依据：[媒体引用与保留逻辑](/Users/Admin/codexprogram/infinite-canvas/repository/canvas_media.go:74)。

### 2.2 一次保存实际做了什么

当前 Canvas 保存大致按以下顺序，在同一事务中执行：

1. 核对请求幂等标识与画布 revision，锁定当前画布。
2. 从旧、新 document 提取并去重媒体 ID。
3. 写入新的完整 document，将 revision 加 1。
4. 按稳定顺序锁定相关媒体，校验媒体是否存在、是否有权限、是否正在删除。
5. 根据引用变化记录审计事件，计算媒体应该保留还是安排过期。
6. 更新媒体 `expires_at`，提交事务。

任何一步失败都会影响事务提交；不是先保存成功，再随意补一轮媒体写入。冲突请求和同一请求的幂等重放也有自己的提前返回处理。

依据：[幂等保存事务](/Users/Admin/codexprogram/infinite-canvas/repository/canvas_project.go:165)、[媒体校验](/Users/Admin/codexprogram/infinite-canvas/repository/canvas_media.go:98)。

### 2.3 重复 UPDATE 出现在什么位置

代码把新文档中保留的、自有的媒体统一加入更新集合，目标值是 `nil`，也就是数据库中的 NULL：

```go
for id := range change.after {
    if media[id].OwnerUID == change.ownerUID {
        updates[id] = nil
    }
}
```

随后，只要 ID 存在于这个集合，就执行 UPDATE：

```go
expiry, changed := updates[id]
if !changed {
    continue
}
// 中间包含必要的审计处理。
tx.Model(&model.Media{}).Where("id = ?", id).Update("expires_at", expiry)
```

这里的 `changed` 是 Go map 查询返回的“键是否存在”，**不是数据库旧值和新值是否不同**。

假设画布已经引用了图片 A，A 的 `expires_at` 已经为 NULL。用户只移动一个文本节点，下一次保存仍会把 A 加入集合，执行：

```sql
UPDATE media SET expires_at = NULL WHERE id = 'A';
```

虽然 A 的保留状态没有变化，这条 SQL 仍会执行。代码中的“引用是否变化”判断用于减少引用审计事件，没有阻止后面的重复 UPDATE。

依据：[生成更新集合](/Users/Admin/codexprogram/infinite-canvas/repository/canvas_media.go:144)、[执行 UPDATE](/Users/Admin/codexprogram/infinite-canvas/repository/canvas_media.go:174)。

### 2.4 为什么数量能达到十万级

单次保存的这部分写入量，主要取决于保留的不同自有媒体 ID 数量，不是只取决于这一次拖动了几个节点。同一个媒体 ID 在多个节点中出现，提取阶段已经去重，不会按重复节点再重复计算。

举例说明，以下是计算示例，不是本次实测分项：

```text
画布保留 50 个不同自有媒体
每 3 秒保存一次
一分钟保存 20 次
→ 仅此用户约执行 50 × 20 = 1,000 次媒体保留 UPDATE
```

本次又包含 10、30、50 人三档、数据初始化和 Workflow 操作，累计数量自然会放大。

**106,664 次需要按正确范围理解：**这是 `pg_stat_statements` 对下面这种归一化 SQL 的累计调用数，包含初始化和三档运行：

```sql
UPDATE "media" SET "expires_at"=$1 WHERE id = $2
```

它不是“精确测出了 Canvas 产生 106,664 次无效写入”。原因有两个：

- [Workflow 媒体引用维护](/Users/Admin/codexprogram/infinite-canvas/repository/workflow_media.go:114)、[素材过期设置](/Users/Admin/codexprogram/infinite-canvas/repository/media.go:125)也会执行同样形式的 SQL，聚合统计没有记录每条 SQL 的业务调用来源。
- 其中既可能有 NULL→NULL 的重复写入，也可能有确实需要改变保留状态的写入；本轮未逐条记录 UPDATE 前后的值。

已确认的是：**Canvas 路径确实存在重复保留状态写入，Workflow 也有同类写法，相关 SQL 总调用量很高。**各来源占比、其中多少条可以消除，需要优化前后的分项计数或对照测试确认。

### 2.5 数值没变，为什么也有成本

PostgreSQL 的 UPDATE 不会因为应用层“觉得值没变化”，就自动等价为没有执行。官方文档明确说明，UPDATE 的影响行数包含命中但值没有改变的行。执行更新还涉及数据库行版本的维护，旧版本需要后续回收。[PostgreSQL UPDATE](https://www.postgresql.org/docs/17/sql-update.html)、[旧行版本与 VACUUM](https://www.postgresql.org/docs/17/routine-vacuuming.html)。

对本项目而言，额外 SQL 至少增加应用与数据库之间的往返和事务中的工作量；也可能增加 WAL、旧版本回收及页面写回工作。HOT 等数据库机制可以降低部分更新成本，但不能把重复 UPDATE 视为免费操作。[PostgreSQL HOT](https://www.postgresql.org/docs/17/storage-hot.html)。

本次该 SQL 的数据库执行总耗时约 **4,337.63 ms**，平均约 **0.0407 ms**，并没有形成已观测到的瓶颈。这是数据库端累计执行时间，不是用户总等待时间，也不包含所有网络往返和事务等待。

本轮没有测量这类重复写入单独造成多少 WAL、多少磁盘占用或多少可节省的延迟，因此不能承诺优化后节省具体百分比。它也不表示图片文件被复制了十万次，UPDATE 操作的是媒体元数据。

## 3. 为什么 Canvas 列表会返回完整 document

### 3.1 当前列表返回的是完整画布对象

`GET /api/v1/canvas/projects` 查询用户的全部画布，Repository 使用 `Find(&items)` 读取完整模型，没有只选择列表摘要字段，也没有分页。

模型的 `document` 会直接序列化到响应中，里面包括：

```text
nodes：位置、尺寸、文本、模型参数、媒体引用等
connections
maskResources
backgroundMode / showImageInfo
viewport
```

因此，用户看到的卡片虽然只显示名称、节点数、连线数和更新时间，接口却已经把每张画布的编辑数据一起带回来了。

依据：[列表 SQL](/Users/Admin/codexprogram/infinite-canvas/repository/canvas_project.go:114)、[返回模型](/Users/Admin/codexprogram/infinite-canvas/model/canvas_project.go:20)、[列表服务](/Users/Admin/codexprogram/infinite-canvas/service/canvas_projects.go:53)。

### 3.2 为什么当前不能只删掉这个字段

这是列表展示和完整数据同步共用接口造成的耦合。当前前端确实依赖完整响应：

- 初始化时通过 `api.list()` 获取服务器画布集合，用于识别本地旧画布、处理导入、接纳服务器数据，再启动同步。
- Store 将 `project.document.nodes`、connections、viewport 等转换为本地完整画布对象。
- 画布卡片直接通过 `project.nodes.length`、`project.connections.length` 显示数量。

这种实现让列表展示与本地状态初始化共用一套对象，规模较小时实现直接；代价是用户只看列表也要取得全量编辑数据。这是根据当前调用关系得到的解释，不推断最初开发者的个人意图。

依据：[初始化同步](/Users/Admin/codexprogram/infinite-canvas/web/src/services/canvas-project-bootstrap.ts:183)、[Store 接纳完整 document](</Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/stores/use-canvas-store.ts:148>)、[卡片读取节点数](</Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/canvas-project-card.tsx:58>)。

如果只在后端移除 document 或只返回第一页，前端仍按“完整画布 / 完整集合”理解响应，就可能初始化失败，或把未返回的画布误判为服务器不存在。优化需要同时调整这些调用方。

### 3.3 177.7 MiB 是怎样算出的

50 人档稳定期为 180 秒，Canvas list 的实际数据如下：

| 项目 | 数值 |
| --- | ---: |
| 请求次数 | 1,277 |
| 累计响应体字节 | 186,334,284 bytes，约 177.70 MiB |
| 每次平均响应体 | 约 142.50 KiB |
| 同期全部正常负载响应体 | 406,978,696 bytes，约 388.13 MiB |
| Canvas list 占比 | 45.78% |

计算方式：`186,334,284 ÷ 406,978,696 ≈ 45.78%`。

**这不是一个用户打开一次列表就下载了 177.7 MiB。**压测中 50% 的浏览用户每轮都会读取列表，反复获取相同用户的多张完整文档，所以累计体积较大。压测脚本中每个普通用户初始有 3 张画布；另外还有独立冲突测试创建的画布。

这个比例取决于本轮操作组合和访问频率，不能直接当作生产每天的流量占比。实际浏览器也不是每次移动节点都会请求全部画布列表。

此外，驱动统计的是读取到的 HTTP 响应体长度，不是链路抓包流量，未包含 HTTP/TCP/TLS 开销，也不能直接当作生产压缩后的带宽账单。这里主要是画布 JSON，**不是 OSS 图片原图的下载量**。

依据：[50 人结果 JSON](/Users/Admin/codexprogram/infinite-canvas/docs/loadtest-2026-09-10-results.json)、[响应体字节采集](/Users/Admin/codexprogram/infinite-canvas/cmd/loadtest/client.go:122)。

## 4. 为什么素材界面有分页，接口仍然没有分页

### 4.1 当前“我的素材”先全量获取，再本地筛选

私有素材接口 `/api/v1/private-images` 当前读取用户全部符合条件的媒体：按用户、图片/视频类型、可用状态等过滤，再按创建时间排序；没有 LIMIT / OFFSET。返回的 total 就是这个完整数组的长度。

前端拿到所有素材后，才按文件夹、关键词等过滤，再执行：

```ts
filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
```

所以界面只显示一页，并不代表数据库只查询一页、网络只传输一页。前端分页可以限制当前渲染数量，却没有减少获取整个素材目录的成本。

依据：[私有素材查询](/Users/Admin/codexprogram/infinite-canvas/repository/media.go:82)、[私有素材服务](/Users/Admin/codexprogram/infinite-canvas/service/private_images.go:26)、[前端筛选和切片](</Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/asset-picker-modal.tsx:491>)。

这里说的是私有素材，不是所有素材接口。[公共素材列表](/Users/Admin/codexprogram/infinite-canvas/repository/public_image.go:67)已经使用服务端分页，其查询参数与 UI 可以作为后续调整的参考。

### 4.2 增长的是素材元数据，不是把原图全下载回来

素材列表返回 ID、标题、文件名、格式、尺寸、字节数、文件夹等元数据。图片显示资源随后由现有资源加载体系获取，不能把“列表无分页”理解为它直接把全部 OSS 原图放进这个 JSON。

本次 50 人稳定期的 Asset list 累计返回 **76,491,243 bytes，约 72.95 MiB**，共 1,431 次请求，平均约 52.20 KiB。每人初始有 200 条素材，部分用户还增加了 fake 生成结果。

素材从几百条增长到几千、几万条时，全量查询、JSON 编码/解码、前端 Store 替换和本地筛选都要处理更多条目；即使只看第一页，这些前置成本依然存在。具体何时变慢，本轮尚未验证，不能由 200 条数据直接外推极限。

### 4.3 改分页时还要处理“完整目录”的语义

当前素材刷新会用新结果替换 Store，并把“旧目录中存在、新目录中缺失”的媒体当作已移除，清理相应本地图片缓存。

如果仅让后端返回第一页，第二页以后没有出现在本次响应里的素材，就可能被误当作已经移除。正确分页需要区分“这一页没加载”与“这个媒体确实被删除”，不能把部分响应当作完整目录。

依据：[刷新并接纳素材](/Users/Admin/codexprogram/infinite-canvas/web/src/stores/use-asset-store.ts:152)、[缺失媒体的本地缓存清理](/Users/Admin/codexprogram/infinite-canvas/web/src/stores/use-asset-store.ts:110)。这里说的是本地缓存清理，不是服务器因此删除 OSS 文件。

## 5. 为什么当前没明显变慢，仍值得优化

本轮的数据量和并发还没有把系统资源压满：50 人档应用连接池最多打开 8/20 条连接、累计等待 0，Canvas 保存 p95 为 51.04 ms，Workflow 保存 p95 为 13.22 ms。

媒体 UPDATE 单条 SQL 很快，列表在本机网络中传输也快，因此“存在浪费”和“已经形成瓶颈”是两件需要分别证明的事。

两项风险的增长因素不同：

| 场景变化 | 主要增加的工作 |
| --- | --- |
| 每张画布引用更多不同媒体 | 每次保存要维护更多媒体行 |
| 保存更频繁、更多人编辑 | 重复 UPDATE 总次数增加，事务工作量增加 |
| 每个用户保存更多画布、每张 document 更大 | 每次 Canvas list 都返回更多 JSON |
| 素材库更大、刷新更频繁 | 私有素材全量扫描、传输和前端处理增加 |
| 用户网络更慢、设备更弱 | 相同 JSON 的下载与解析成本更容易表现为等待 |

这些是依据代码结构得到的增长方向。当前没有测出导致故障的具体阈值，也没有证据把过去的自动保存故障归因于这两项问题。

## 6. 后续如何优化，哪些行为要保留

### 第一步：减少状态未变的媒体写入

优先在现有事务内，利用已经锁定并读取的媒体状态，只对真正变化的 `expires_at` 执行写入。例如保留媒体已经为 NULL 时跳过 UPDATE；需要取消过期或重新安排过期时仍正常更新。

必须保留：媒体有效性和权限校验、稳定锁顺序、Canvas / Workflow 交叉引用判断、清理协议、revision / 幂等及审计语义。不能仅因媒体 ID 集合相同就跳过整段校验，也不能过滤失效节点来让保存通过。

是否进一步合并批量 UPDATE，可以在减少无变化写入后再评估。单纯把 50 条相同目标值的更新合并成一条 SQL，虽然减少往返，但如果仍更新所有未变化的行，并没有消除全部行写入。

### 第二步：Canvas 列表使用摘要，进入画布再取详情

列表只取显示所需的 ID、标题、revision、更新时间、节点数、连线数等摘要；进入画布时通过现有详情接口获取完整 document。

这需要同步调整初始化、Store 和卡片数据类型，明确“摘要已加载”与“完整文档已加载”。不能把未加载详情默认为空 document 后送入自动保存，也要保护本地待保存内容与冲突处理。节点数如何计算可以单独设计，不必为了这一步预先增加数据库字段或新缓存系统。

如果用户画布数量本身很多，摘要列表也需要分页；仅移除 document 解决的是单条数据过大，不能无限承载条目数量增长。

### 第三步：私有素材采用服务端分页与筛选

把当前文件夹、关键词、素材类型等筛选与分页移到查询层；前端按页接纳结果，保留未加载资源的状态，不把页外项目误判为删除。沿用公共素材的成熟交互与资源加载服务，避免另建一套图片缓存。

后续验证应对比同一数据、同一负载下的 SQL 次数、实际更新行数、保存延迟、列表响应体大小，并覆盖本地草稿、刷新恢复、同 revision 冲突、跨用户权限和媒体清理竞态。

**本次只形成原因说明，以上是后续优化方向，未执行优化，也没有承诺未经验证的性能收益。**

## 7. 证据与阅读入口

- [完整压力测试报告](/Users/Admin/codexprogram/infinite-canvas/docs/loadtest-2026-09-10.md)：环境、各 API 分位数、资源和一致性检查。
- [机器可读结果](/Users/Admin/codexprogram/infinite-canvas/docs/loadtest-2026-09-10-results.json)：字节数、请求量与统计范围。
- [原始证据包](/Users/Admin/codexprogram/infinite-canvas/docs/loadtest-2026-09-10-evidence.tar.gz)：归一化 SQL、逐请求记录与监测样本；其中 SQL 聚合没有业务来源和逐次新旧值。
- [复跑说明](/Users/Admin/codexprogram/infinite-canvas/scripts/loadtest/README.md)：测试模型和覆盖边界。

编写时重新核对了当前前后端调用链和压测原始统计，并参考 PostgreSQL 17 官方文档解释数据库机制。本轮没有重新压测、修改业务代码、操作生产数据库或提交部署。
