# infinite-canvas 最新代码简化核查报告

日期：2026-09-10。依据：`project-simplification`，并按技术文档技能整理证据。范围：infinite-canvas 前端、Go 后端、测试及相关入口配置。本文记录先审查、后按用户授权分四批实施的结果。**第 1～11 节保留 `314cf81` 的审查证据；最新实施结果和验证见第 12 节。** 前述章节中的“当前”、源码行号及已删除文件链接均指审查基线，不代表实施后的文件仍存在。

## 1. 结论与代码基线

**适合做局部清理和定向优化，不建议整体重构 Canvas / Workflow。** 两者已经共享编辑器 UI、交互和媒体资源能力，主要剩余问题是改造后的旧入口、无效参数、重复派生计算，以及部分只检查源码文字的测试。

开始检查的基线为 `3e58c88f1fb9cd16f877f5a68fa79c780a6f8236`，包含工作流编辑器改造和两个自动保存修复提交。期间顶栏测试被更新，随后形成最新提交 `314cf81`。已核对两个提交间仅该测试变化，并按最新内容复跑；**审查基线为 `314cf81`**。最终测试文件 SHA-256：`7ef292926cfab6d5d6053b0cb09daaefd581edec24018b3a9d31111f56c28c13`。本报告没有将该测试更新计为本轮实施成果。

审查阶段验证结果：

- 前端全套 Bun：**551 通过、0 失败，122 个文件**。
- 常规 TypeScript：通过。
- 额外启用未使用项检查：9 处诊断，其中 2 处是应保留的编译期类型断言。
- Go `vet`：通过。
- 用临时 overlay 移除部分确定旧代码后的全包 `go build`：通过。
- 对三个测试文件进行隔离故障注入：原版 6 项通过，破坏实际行为后仍 6 项通过，证实存在检测能力不足。

报告中 **P2** 表示有实际维护、性能或测试可靠性收益；**P3** 表示低风险清理或可选整理。“已确认”只针对列出的调用链、检查或实验，不代表完整生产安全审计，也不等于已经实施。

## 2. 前端：确认可以清理的残留代码（P3）

核验采用 TypeScript 编译器符号引用、以 Next 页面/layout/route 为入口的模块可达性分析，以及全仓搜索交叉检查。分析覆盖 313 个 `src` 下 TS/TSX 文件，包含测试和手动浏览器测试文件。框架约定导出、CSS 引入及测试辅助代码单独排除误报。

| 位置 | 当前证据 | 最小建议 |
| --- | --- | --- |
| [admin-navigation.ts:10](/Users/Admin/codexprogram/infinite-canvas/web/src/components/layout/admin-navigation.ts:10) | `adminNavigationItems` 的唯一引用来自自己的测试。真实全局配置走 `AppActions`，后台菜单在 admin layout；Next 入口图也无法到达该模块。 | 删除孤立模块及其两个测试。不要把真实后台导航删掉。 |
| [workflow-graph.ts:32](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-graph.ts:32) | `findAvailableWorkflowNodePosition` 只被测试调用。当前添加节点已走 [workflow-editor.tsx:494](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-editor.tsx:494) 的视口中心定位。 | 删除旧定位函数；`NODE_GAP` 随删除检查。保留仍被输出布局使用的 `rectanglesOverlap`。 |
| [workflow-graph.ts:173](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-graph.ts:173) | `findWorkflowConnection` 只被测试调用。当前连接查删由 [workflow-canvas-adapter.ts:84](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-canvas-adapter.ts:84) 按连接 key 处理。 | 删除旧查找函数及对应孤立断言，保留连接身份类型和实际查删逻辑。 |
| [use-config-store.ts:56](/Users/Admin/codexprogram/infinite-canvas/web/src/stores/use-config-store.ts:56) | Store 的 `updateConfig`、`selectImageModel`、`selectVideoModel` 没有当前调用。配置节点中同名 `selectImageModel` 是组件自己的函数，不是调用这个 Store action。 | 清理三个无调用 action 及其类型声明。保留默认配置、持久化配置恢复、`reconcileProviderConfig`、节点模型选择。 |
| [image-storage.ts:827](/Users/Admin/codexprogram/infinite-canvas/web/src/services/image-storage.ts:827) | 模块导出的 `setImageBlob` 包装函数没有调用；测试调用的是内部 operations 的同名方法。 | 可以先只删除无用导出包装。内部方法及缓存并发测试另行评估，不顺带删除。 |
| [canvas-client-page.tsx:10](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/[id]/canvas-client-page.tsx:10) | `Menu`、51 行 `Dropdown` 未使用。 | 删除导入。 |
| [canvas-node.tsx:7](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/canvas-node.tsx:7) | `Video` 图标导入未使用。 | 删除导入。 |
| [workflow-editor.tsx:4](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-editor.tsx:4) | `Input`、33 行 `appPath` 导入未使用。 | 删除导入。 |

`noUnused` 还报告 history 测试的一个未使用参数和 image-storage 的一个 iterate 参数，可顺手收敛，但收益很小。**不能删除** [canvas-image-hydration.test.ts:12](/Users/Admin/codexprogram/infinite-canvas/web/src/services/canvas-image-hydration.test.ts:12) 和第 14 行的类型断言：它们用于让错误的类型变更在编译时失败。

没有证据支持批量卸载依赖。例如 [globals.css:3](/Users/Admin/codexprogram/infinite-canvas/web/src/app/globals.css:3) 仍导入 `shadcn/tailwind.css`，不能因为缺少组件 JS import 就卸载 `shadcn`。

## 3. 前端：无效参数与未消费的交互状态（P3）

### 3.1 组件参数看似有效，实际不参与行为

[canvas-image-settings-popover.tsx:17](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx:17) 声明了 `onMissingConfig`、`getPopupContainer`、`autoAdjustOverflow`，但组件没有解构、读取或转发它们。

当前仍有两处传值：

- [canvas-node-prompt-panel.tsx:89](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx:89) 传 `onMissingConfig`。
- [canvas-config-node-panel.tsx:194](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/canvas-config-node-panel.tsx:194) 传 `autoAdjustOverflow={false}`。

`getPopupContainer` 只剩声明。应删除无效声明及传值，让调用方不再误以为它们控制配置提示、Portal 容器或溢出调整。本轮没有根据参数名称推断实际功能缺失；这是接口残留。

[workflow-node.tsx:64](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-node.tsx:64) 与第 263 行的两个 `onSelect` 参数也没有读取；[workflow-editor.tsx:1039](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-editor.tsx:1039) 和第 1088 行仍构造回调。实际选择经过 `onDragStart → handleNodeMouseDown`，可去掉无效参数及传值。

### 3.2 Workflow 适配器存在无人使用的 UI 状态和包装

[use-workflow-interactions.ts:41](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/use-workflow-interactions.ts:41) 创建并返回 `contextMenu`、`hoveredNodeId`、`toolbarNodeId`、`dialogNodeId`，但唯一调用方不消费这些值或 setter。Workflow 节点自己维护 hover/edit，页面也有独立的预览状态。

同文件第 122、127、133 行的 `onNodePointerDown`、`onSourcePointerDown`、`onTargetPointerDown` 返回后也没有调用。实际页面使用 [workflow-editor.tsx:703](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-editor.tsx:703) 的拖动处理及第 1049 行起的连接处理。

建议先删除未使用事件包装和返回项。对于四份 UI 状态，可将共享交互 hook 的相应通知设为可选，避免 Workflow 为满足接口创建无消费者状态。普通 Canvas 仍使用这些通知，不能直接从共享 hook 删除功能，也不要借此合并保存或历史状态机。

验收应覆盖真实选择、拖动、连线、文本编辑和复制粘贴，而不是只检查 props 名称消失。

## 4. 前端：已有复用与进一步复用边界

### 已经复用，不需要重新建设

当前 [workflow-editor.tsx:10](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-editor.tsx:10) 及其节点、配置组件已经使用：

| 能力 | 已有共享实现 |
| --- | --- |
| 顶部、保存反馈、底部工具、缩放、小地图 | `CanvasEditorTopBar`、`EditorSyncStatus`、`CanvasToolbar`、`CanvasZoomControls`、`Minimap` |
| 画布与编辑交互 | `InfiniteCanvas`、`useCanvasInteractions`、`useCanvasHistory`，通过 Workflow adapter 转换 |
| 节点外壳、端口、缩放柄、悬浮工具栏 | `canvas-node-primitives`、`canvas-node-toolbar-shell` |
| 模型与生成设置 | `CanvasConfigModelSelect`、图片/视频 SettingsPopover 和 SettingsPanel |
| 图片资源、视频、素材预览 | `useCanvasImageResources`、`CanvasVideoContent`、`useMaterialMediaPreview` |

因此“Workflow 完全另写了一套编辑器 UI”不符合最新代码。

### 可选复用：设置浮层外壳（P3）

图片 [canvas-image-settings-popover.tsx:32](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/canvas-image-settings-popover.tsx:32) 与视频 [canvas-video-settings-popover.tsx:25](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/canvas-video-settings-popover.tsx:25) 重复维护完整浮层生命周期：

- open、按钮矩形和 panel ref；
- resize/scroll 定位、外部 pointerdown 关闭、监听器释放；
- body Portal、层级、滚动区域、事件隔离和样式。

这是一个有独立职责的复用机会。可收敛一个设置浮层外壳，图片和视频各自保留参数、摘要、模型 schema 和输出数量语义；不要把全部配置合成带大量模式开关的组件。

提取后需验证嵌套下拉选择不关闭外层、外部点击关闭、长菜单、缩放定位及卸载清理。本轮只确认重复实现，未执行改造后的浏览器验收。

### 不建议合并的部分

- Workflow 的定义、输出槽、运行快照、服务端调度，与普通 Canvas 的文档和生成任务不是相同数据模型。
- 两者各自自动保存、租约、冲突处理，不能仅因名称相似就共用一个业务 Store。
- 不因 `workflow-editor.tsx` 或 Canvas 主页面较长而整体拆分。先删除残留、降低计算重复，再评估是否仍有可独立拥有状态的职责。
- 列表卡片有相似外观，但 Canvas 本地同步/分享条件与 Workflow revision/服务端列表不同，优先级低于本报告的确定问题。

## 5. 前端：Workflow 输出查找的重复计算（P2）

[workflow-run-state.ts:60](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-run-state.ts:60) 的 `findCompatibleWorkflowOutput` 每次扫描快照节点、当前节点、各自槽位及结果列表。

当前使用方式放大了扫描：

- [workflow-editor.tsx:1063](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-editor.tsx:1063) 和第 1076 行在同一输出渲染中分别查一次；资源目标构建第 324 行再次查找。
- [workflow-run-state.ts:69](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-run-state.ts:69) 下载计数对每个槽位再扫描结果列表。
- [workflow-editor.tsx:617](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-editor.tsx:617) 的 `previewInputs` 对每个节点过滤全部连线；第 1032 行对所有节点调用。
- [use-workflow-interactions.ts:29](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/use-workflow-interactions.ts:29) 每次渲染重新转换整个图，视角或保存状态变化也会重建适配数组。

**操作量验证：**直接导入当前 helper，用代理统计真实 `.find` 的元素访问次数。100 个配置、每个 9 个输出，仅对每槽查询一次就发生 **405,450 次结果访问**，快照节点与当前节点各 **45,450 次访问**；下载计数另有 **405,450 次结果访问**。20 个配置、180 个输出时，一轮结果访问为 **16,290 次**。100 个配置未超过后端 1,000 节点限制。

这是确定的扫描量，不是浏览器耗时基准，也不能据此宣称某个百分比的提速。

最小优化：按当前 graph/run 在组件内建立局部 `Map`，同槽查询一次并复用，按目标节点分组输入连线；适配数组按 graph memo。保留原来的节点类型、槽位类型、运行身份兼容判断和结果顺序；不新增全局缓存，不把旧运行结果混入当前运行。

## 6. 后端：旧路径与仅测试使用的代码

Go 核验使用 `go/packages` 和 `types.Info` 区分真实符号，避免把接口同名方法误当调用。路由、worker 及事务完成入口另行人工确认。引用统计发现 14 个没有生产引用的包级函数，但**不建议将这 14 个函数全部机械删除**。

### 6.1 旧视频入口和 multipart 解析可以删除（P3）

[service/video_tasks.go:13](/Users/Admin/codexprogram/infinite-canvas/service/video_tasks.go:13)、第 30、51 行的 `CreateVideo`、`GetVideo`、`GetVideoContent` 都是 0 生产引用、0 测试引用。实际 handler 走 [handler/ai.go:152](/Users/Admin/codexprogram/infinite-canvas/handler/ai.go:152) 的持久化任务接口；worker 在 [video_task_worker.go:107](/Users/Admin/codexprogram/infinite-canvas/service/video_task_worker.go:107) 直接调用供应商。

[handler/ai.go:215](/Users/Admin/codexprogram/infinite-canvas/handler/ai.go:215) 的 `videoRequestFromForm` 和第 18 行 `maxVideoRequestBytes` 也无人使用。当前视频提交使用 JSON。

建议删除这条旧 service 路径、专属 `provider:` 编解码、旧 form/helper 常量；[video_model_selection_test.go:5](/Users/Admin/codexprogram/infinite-canvas/service/video_model_selection_test.go:5) 只测试该废弃编解码，可随之删除。**保留 `ai.VideoGenerator` 和供应商实现**，它们仍在实际生成链路中使用。

### 6.2 先迁移测试，再删除旧持久化入口（P3）

| 位置 | 已确认调用关系 | 最小建议 |
| --- | --- | --- |
| [generated_images.go:28](/Users/Admin/codexprogram/infinite-canvas/service/generated_images.go:28) `persistGeneratedImages` | 0 生产引用、1 处测试引用。实际路径是同文件第 51 行准备媒体，再经 `CompleteImageGenerationTask` 校验租约并原子发布。 | 删除旧逐张保存函数；将缺少 Portal 身份的测试迁移到真实准备入口，不删除身份校验覆盖。 |
| [workflow_media_result.go:15](/Users/Admin/codexprogram/infinite-canvas/repository/workflow_media_result.go:15) `WithWorkflowGenerationRequest` | 0 生产引用、1 处测试引用。因此 [media.go:27](/Users/Admin/codexprogram/infinite-canvas/repository/media.go:27) 按该私有 context key 取值的分支在生产不可达。 | 删除 setter、专属类型和死分支。**保留 `holdWorkflowGeneratedMedia`**，图片/视频完成事务仍直接调用它；将即时保留结果测试迁移到这些事务。 |
| [image_generation_task.go:16](/Users/Admin/codexprogram/infinite-canvas/repository/image_generation_task.go:16) `CreateImageGenerationTask` | 0 生产引用、17 处测试引用。真实入口是第 35 行 `CreateImageGenerationTaskWithOperationLog`。这是旧报告中仍然成立的一项。 | 幂等测试迁移到带审计事务的真实入口；纯造数据调用改测试 fixture，再删除旧入口和专属 `firstImageTaskLookupError`。不能删除任务租约测试。 |

隔离编译实验：只在 `/tmp` 制作 Go overlay，屏蔽旧视频路径、旧 multipart 解析、`persistGeneratedImages`、Workflow context setter 和相应死分支，`go build -overlay … ./...` 通过。它确认当前生产编译不依赖这些路径，**不替代后续清理后的事务测试**。

`BootstrapAppAdmins`、`ClaimCanvasMediaCleanup`、`ListExpiredPrivateMedia`、`SetPrivateMediaExpiry` 等也只有测试调用，但承载有价值的测试入口或兼容验证，应逐项判断保留、移入 fixture 或迁移测试，不能据此整批删掉。结论限定本应用仓库，未评估仓库外 Go 使用者。

## 7. 后端：运行列表加载未使用的快照（P2）

[repository/workflow_run.go:109](/Users/Admin/codexprogram/infinite-canvas/repository/workflow_run.go:109) 使用完整模型 `Find`，SQL 为 `SELECT *`，会读取 `Snapshot`。

但 [model/workflow_run.go:13](/Users/Admin/codexprogram/infinite-canvas/model/workflow_run.go:13) 将该字段标为 `json:"-"`，唯一生产列表调用 [service/workflow_run.go:128](/Users/Admin/codexprogram/infinite-canvas/service/workflow_run.go:128) 不读取快照，只包装返回列表。

最小优化是**仅列表查询**增加 `Omit("snapshot")` 或等价的显式字段选择。详情、任务恢复、调度仍需要快照，保持不变。

验证：GORM SQL dry-run 证实当前是 `SELECT *`，候选查询不再选取 snapshot；使用真实模型做 JSON 序列化对比，删除该隐藏字段前后响应相同。没有连接数据库，也没有执行真实查询性能测试。

正常入口对图 JSON 的上限为 4 MiB，默认每页 20、上限 500；这说明不必要的数据读取可能较大，但不代表实际用户数据达到上限。没有测量生产内存或承诺固定性能收益。

## 8. 测试：可删除项、应替换项和必须保留项

统计：122 个前端 `.test.*` 文件、69 个 Go `_test.go` 文件。前端有 21 个文件涉及源码读取/解析，其中 10 个纯源码字符串断言、1 个混合静态与导入行为、10 个执行真实 AST 代码。统计是文件数，不是测试用例数，也不包含非标准命名的手动 browser harness。

### 8.1 精准删除保护孤立代码的测试（P3）

- [admin-navigation.test.ts:9](/Users/Admin/codexprogram/infinite-canvas/web/src/components/layout/admin-navigation.test.ts:9) 和第 16 行可随孤立模块删除。
- [workflow-graph.test.ts:121](/Users/Admin/codexprogram/infinite-canvas/web/src/features/workflows/workflow-graph.test.ts:121) 与第 138 行分别只验证已无生产调用的两个 helper。只删对应断言及导入，不能删除整块：相邻断言仍保护输出补位和相同 port ID 在不同目标节点间的隔离。
- Go 旧视频 ID 编解码测试可随旧实现删除；图片创建、媒体保留等测试则应迁移到实际入口。

### 8.2 三处已做故障注入验证的薄弱测试（P2）

以下实验只修改 `/tmp` 副本，未破坏仓库代码。复制当前测试原样执行，基线 6/6 通过；注入以下故障后仍 6/6 通过。

| 当前测试 | 临时注入的故障 | 真实行为核验 | 建议 |
| --- | --- | --- | --- |
| [use-visible-media-preview.test.ts:7](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(user)/canvas/components/use-visible-media-preview.test.ts:7) | 放开队列并发限制，删除卸载时的 URL 释放；保留常量和其他位置的同名调用。 | 执行真实队列/cleanup 回调：5 个请求同时启动数由 4 变 5，卸载释放由 1 次变 0 次，原测试仍通过。 | 用可控 Promise、Observer 与卸载测试验证并发上限、排队补位、取消和资源释放。 |
| [members/page.test.ts:30](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(admin)/admin/members/page.test.ts:30) | 自我降权判断前加入 `false &&`。 | 执行真实成功回调：撤销管理员状态的调用由 1 次变 0 次，本文件 4 项仍通过。 | 调用实际成功/失败回调，验证自己降权、修改他人、失败及缓存处理。现有 API 请求测试不能替代页面副作用。 |
| [statistics-range-filter.test.ts:7](/Users/Admin/codexprogram/infinite-canvas/web/src/app/(admin)/admin/statistics/statistics-range-filter.test.ts:7) | 将 RangePicker 的 onChange 换成空回调。 | 源码接线已不再执行区间选择，但只查 Popover、RangePicker、图标及函数名的测试仍通过。 | 验证完整区间输出、半选不提交、完成后关闭；去掉仅锁定组件名和图标的断言。 |

这证明测试没有检出对应故障，**不代表当前产品已经存在实验中注入的故障**。不建议直接把这些测试删光；应保留保护意图，换成可观察行为断言。

### 8.3 顶栏陈旧断言已在检查期间更新

基线 [app-top-nav.test.ts:10](/Users/Admin/codexprogram/infinite-canvas/web/src/components/layout/app-top-nav.test.ts:10) 固定要求 `href="/"` 和“返回工作台”，与实际 `home.href`、`home.label` 冲突。第一次全套运行是 550 通过、1 失败。

检查期间断言已更新为动态 home 接线，并提交为 `314cf81`；最终 551/551 通过，因此**不再把该失败列为当前未修问题**。现有 [navigation-route.test.ts:17](/Users/Admin/codexprogram/infinite-canvas/web/src/lib/navigation-route.test.ts:17) 已覆盖两个编辑器/列表、路径前缀及返回目标；顶栏测试目前仍是源码检查，后续可补真实渲染和点击，防止路由函数正确而组件未接通。

### 8.4 部署测试可以局部去重，但不能整体删除

[deployment_config_test.go:127](/Users/Admin/codexprogram/infinite-canvas/deployment_config_test.go:127) 仍查 `rollback()`、`wait_for_healthy` 等名称。现在 [deployment_behavior_test.go:73](/Users/Admin/codexprogram/infinite-canvas/deployment_behavior_test.go:73) 已实际执行脚本，通过假 Docker 验证成功、失败回滚和清理边界。

定向执行 5 个顶层测试、14 个子场景通过。可以删去已被真实行为覆盖、仅锁定函数名称的重复断言；保留配置安全约束。夹具中的假 `flock` 总是成功，**没有验证真实锁竞争**，不能将其描述为并发锁已经动态验证。

### 8.5 明确保留

- history application ID、连续 Undo/Redo、异步生成/上传回调和完整文档发布测试。
- 保存期间再次编辑、旧请求确认、租约失效草稿和缓存用户隔离测试。
- 媒体缓存删除/写入竞态、任务幂等、工作流媒体引用事务测试。
- 类型契约断言。
- 执行真实 AST 回调的 `sourceBehavior` 测试。它不是复制一份业务逻辑来测试；但仍不能代替 React 生命周期和浏览器事件接线验证。
- Workflow 素材卡片的 SSR loading 测试可保留为初始展示检查，不能把它当作“仅 mediaId 图片最终成功加载”的完整证明。

## 9. 旧报告复核：已经处理的内容

[2026-09-07 报告](/Users/Admin/codexprogram/infinite-canvas/docs/code-simplification-review-2026-09-07.md) 只作为线索，以下不再重复列为当前问题。

| 旧问题 | 最新证据 |
| --- | --- |
| 初始化和顶栏重复获取 session | [client-root-init.tsx:21](/Users/Admin/codexprogram/infinite-canvas/web/src/components/layout/client-root-init.tsx:21) 与顶栏使用同一 `portalSessionQuery`。 |
| 批量上传目录刷新无合并/过期保护 | [asset-refresh-scheduler.ts:4](/Users/Admin/codexprogram/infinite-canvas/web/src/stores/asset-refresh-scheduler.ts:4) 已合并刷新并处理作用域；Store 已接入。 |
| 普通媒体清理不释放 Object URL | [file-storage.ts:53](/Users/Admin/codexprogram/infinite-canvas/web/src/services/file-storage.ts:53) 已串行按 key 清理、释放 URL，并保护较新的操作。 |
| 图片统计读取完整任务快照 | [image_generation_task.go:302](/Users/Admin/codexprogram/infinite-canvas/repository/image_generation_task.go:302) 已显式选择统计字段。 |
| 清理不分页、逐媒体重复扫描全部画布 | [media.go:162](/Users/Admin/codexprogram/infinite-canvas/repository/media.go:162) 已分页，认领批次已按 owner 复用引用扫描。 |
| 清理与保存缺少认领协议 | [media.go:212](/Users/Admin/codexprogram/infinite-canvas/repository/media.go:212) 已有事务锁、状态及租约认领。这里只确认旧实现已更换，本轮没有重新证明全部生产交错时序。 |
| 旧图片工具、重复订阅、部分无用参数 | 原报告中的 `transformAngleDataUrl`、`readFileAsDataUrl` 等已移除；本轮报告的是新核验残留。 |
| 多个测试只是复制表达式/文字 | 公共素材操作、供应商筛选、统计 Tabs、统计 API 已执行实际代码或模拟请求；Store 防抖已使用可控时钟。 |

## 10. 审查阶段建议实施顺序

1. **低风险清理。** 删除确定无调用的导入、孤立模块、无效 props、旧 Workflow helper 和旧视频入口；精准删除对应孤立测试。保持业务行为和接口不变。
2. **测试迁移。** 将旧生成/媒体入口的保护迁到真实事务入口；替换本报告已经证实会假通过的源码测试。涉及数据库的行为必须在专用测试数据库验证。
3. **定向性能优化。** Workflow 当前运行结果建立局部索引；运行列表不读取 Snapshot。保留权限、运行身份、顺序和一致性校验。
4. **可选组件收敛。** 最后考虑图片/视频设置浮层壳；没有后续维护需求时可以暂缓，不为缩短文件而提取。

每批检查 diff、跑对应测试及类型/静态检查；有前端行为变化再构建并做相应浏览器验收。不要把这些建议一次性变成全项目重构，也不要借清理改变媒体校验、保存协议、生成任务或数据库语义。

## 11. 审查阶段验证方法、证据与限制

| 检查 | 结果与范围 |
| --- | --- |
| `bun test` | 初始 HEAD 为 550/1；顶栏测试更新后最新工作区为 **551/0**，122 文件。 |
| `bun x --no-install tsc --noEmit --incremental false` | 通过；不用增量避免修改 tsbuildinfo。 |
| 同命令增加 `--noUnusedLocals --noUnusedParameters` | 9 处诊断；不是常规 typecheck 失败，已剔除两处有价值的类型断言。 |
| TypeScript 入口图/符号分析、全仓调用搜索 | 确认孤立模块与导出；排除 Next 路由导出、CSS 和测试工具误报。 |
| Workflow 操作量实验 | 直接调用当前函数，确认重复线性扫描；没有浏览器耗时结论。 |
| 隔离故障注入 | `/tmp` 原版与变体各 6/6 通过；额外执行实际回调证明两类行为确已破坏。日期项验证接线变为空回调。 |
| `GOCACHE=/tmp/infinite-backend-audit-gocache GOPROXY=off go vet ./...` | 通过。 |
| `go build -overlay /tmp/infinite-backend-dead-overlay/overlay.json ./...` | 通过。主代理复跑也通过；出现模块 stat 缓存写权限的非致命提示，不影响退出码 0 的编译结果。 |
| handler-only overlay 定向测试 | 4 项 multipart/options 测试通过，不访问数据库。 |
| `go test deployment_config_test.go deployment_behavior_test.go -run TestRelease -count=1 -v` | 5 顶层、14 子场景通过；假 Docker、临时目录，无真实部署。 |
| GORM dry-run / 模型 JSON 对等比较 | 确认列表可省 Snapshot 且当前响应 JSON 不变；没有数据库性能测量。 |
| 最终 diff 检查 | 最新提交 `314cf81` 相比初始基线仅改变顶栏测试；本轮新增本报告，不改业务实现。 |

本机临时证据：

- [最终 Bun 日志](/tmp/canvas-simplify-20260910-bun-final.log)、[初始 Bun 日志](/tmp/canvas-simplify-20260910-bun-all.log)、[额外未使用项诊断](/tmp/canvas-simplify-20260910-unused.log)。
- [测试分类及故障注入目录](/tmp/canvas-test-audit-3e58c88)、[主代理反向验证](/tmp/canvas-simplify-20260910-mutation-behavior.log)。
- [Workflow 访问次数](/tmp/canvas-simplify-20260910-render-visits.log)、[Go 符号引用](/tmp/infinite-backend-uses-with-tests.json)、[SQL/JSON 对等证据](/tmp/infinite-workflow-list-audit.log)。

临时证据可能被系统清理，关键方法、结果与源码位置已记录在正文。

**审查阶段未执行（实施阶段结果见下节）：**生产服务器/数据库核查、service/router 的数据库测试、真实供应商生成、生产构建及新一轮浏览器交互验收。本次没有行为修改，未为文档重复构建；数据库测试会创建 schema（见 [service/app_permissions_test.go:14](/Users/Admin/codexprogram/infinite-canvas/service/app_permissions_test.go:14)），本轮没有连接用户数据库来制造“全套通过”。未自动提交、推送、部署或重建 Docker。


## 12. 分批实施结果与验证

用户确认后，在本地当前分支完成四批修改，每批验证后分别提交。未改变 Canvas / Workflow 的保存、租约、媒体校验或生成任务语义。

### 12.1 已完成的四批修改

| 批次 | 本地提交 | 实施结果 | 验证 |
| --- | --- | --- | --- |
| 1. 低风险清理 | `7beb164` | 删除孤立后台导航、旧 Workflow 定位/连接查询 helper、无调用 Store action、无效 props 与导入、无人消费的交互状态，以及旧视频 service/form 入口。共享 Canvas 通知改为可选，保留普通画布使用它们的行为。 | 93 项定向 Bun、TypeScript、Go 编译、真实视频 service 定向测试、前端生产构建、diff 检查及独立复审通过。 |
| 2. 测试迁移与检测能力修复 | `9e9b0df` | 删除仅旧测试使用的生成/媒体持久化入口，将身份校验、幂等、操作日志及媒体引用事务覆盖迁移到实际生产入口。素材预览、成员权限、日期筛选改为执行真实模块与回调；删除重复的部署源码文字断言，保留部署行为测试。 | 全套 558 项 Bun、TypeScript、前端构建通过；专用 PostgreSQL 上的 repository/service/router 测试通过。隔离注入 15 个前端故障和 3 个后端故障，新测试均能识别。 |
| 3. Workflow 局部索引 | `205fd1c` | 按当前运行/图构建输出兼容索引，输入连线按目标分组，渲染复用同一输出结果，图适配数组按 graph 缓存。异步图片尺寸回调仍核对回调时的当前图与媒体身份。 | 先用旧实现确认访问次数与数组复用测试失败，再验证优化后通过。46 项定向测试、全套 568 项 Bun、TypeScript、前端生产构建及独立复审通过。 |
| 4. 运行列表省略快照 | 本报告所在提交 | 仅在 `ListWorkflowRuns` 增加 `Omit("snapshot")`。运行详情、请求幂等查询及调度器的完整快照读取不变。 | 先加入非空快照的真实数据库测试，旧实现在 5 个有结果的场景失败；修改后全包 `go test ./...` 通过。 |

第四批的 [数据库回归测试](/Users/Admin/codexprogram/infinite-canvas/repository/workflow_run_list_test.go) 使用每条 65,587 字节的非空快照，覆盖所有者隔离、流程过滤、分页、相同创建时间的稳定排序、空结果、对外 JSON 字段不变，以及详情/幂等/调度查询继续保留快照。它验证查询读取范围与业务结果，不代表已测得数据库延迟或生产内存降幅。

### 12.2 性能与测试真实性

直接执行生产 helper 并计数数组元素访问，100 个配置节点、900 个输出槽的一轮结果查询从 **405,450 次扫描减少到索引构建的 900 次访问**；原图和当前图的节点访问各从 45,450 次变为 100 次。下载计数的结果列表访问同样从 405,450 次变为 900 次。该数字是操作量，不是浏览器耗时或整页速度提升比例。

前端替换测试执行生产模块、JSX 中实际接线的事件回调与受控 hook 生命周期；成员权限测试还使用真实 TanStack Query mutation/cache。没有复制一份业务实现来替代被测代码。新增测试辅助器属于受控运行环境，**不等于 ReactDOM、StrictMode 或真实浏览器集成验收**。

后端用隔离 PostgreSQL 和实际事务入口验证图片/视频完成时的媒体引用，以及带操作日志的任务创建幂等性。18 项故障注入均在临时目录或 Go overlay 进行，故障代码未进入提交。

### 12.3 最终验证范围

- 最终前端代码：**568 项 Bun 通过、0 失败，123 个文件**；常规 TypeScript 与前端生产构建通过。最后一批仅修改 Go 查询、测试与本文，无后续前端代码变动。
- 最终后端代码：设置专用测试数据库 DSN 后，`go test ./...` 所有有测试的包通过；model 包无测试文件。
- 数据库测试使用临时 PostgreSQL 容器、专用 `infinite_canvas_test` 数据库和隔离 schema，没有连接用户业务数据库；没有新增数据库字段或迁移。测试结束后已移除本轮创建的临时容器。
- 每批检查差异及 `git diff --check`，并做独立复审；测试、日志与访问次数证据位于 `/tmp/canvas-simplification-implementation/`，临时文件可能被系统清理。
- 已按授权进行本地提交；未推送、部署、重建应用 Docker、调用收费生成，也未做生产服务器验证或新一轮浏览器交互验收。

### 12.4 可选浮层外壳暂缓

图片/视频设置浮层的重复外壳属实，但本轮未发现该外壳的功能缺陷；两者仍有打开状态通知、模型 schema 和输出数量等差异。当前已共享设置面板、下拉组件及定位计算。继续提取会新增接口和生命周期回归范围，相比本轮确定的清理与扫描优化收益较低，因此**本轮保留现状**。后续需要同时调整两类浮层交互时再收敛，不为减少行数增加抽象。
