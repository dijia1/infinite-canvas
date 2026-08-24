# 持久化图片生成任务设计

## 目标

将 MaiziAI 的文生图和参考图编辑从 HTTP 同步等待改为持久化异步任务。浏览器刷新、网络中断和应用重启不得取消已提交的供应商任务；任务完成后由服务端保存图片媒体，再由画布恢复结果。

## 范围

- 本期仅覆盖 `maizi-image` 的图片生成和图片编辑。
- 视频保持现有实现，后续可接入相同的任务接口。
- 不引入 Redis、消息队列或新的外部服务。
- 任务与结果映射保存 30 天；临时参考图在任务进入终态后清理。

## 数据模型

新增 `ImageGenerationTask`：

- `ID`：服务端任务 ID。
- `OwnerUID`：Portal 用户 UID；所有读取和恢复均按此校验。
- `ClientRequestID`：浏览器在创建画布节点前生成的稳定 ID；同一用户唯一，用于 POST 响应丢失后的恢复。
- `Mode`：`generation` 或 `edit`。
- `Status`：`queued`、`submitting`、`running`、`succeeded`、`failed`。
- `ProviderID`、`ProviderType`、`ProviderConfig`：提交瞬间的供应商实例快照。私有配置不经公开接口返回。
- `Prompt`、`Quality`、`Size`、`Resolution`、`Count`：请求快照。
- `ProviderTaskID`：MaiziAI 返回的任务 ID。
- `References`：参考图的临时对象 Key、名称和 MIME；不将图片 Base64 写入数据库。
- `ResultMediaIDs`、`ErrorMessage`、`Progress`、`CreatedAt`、`UpdatedAt`、`FinishedAt`。

默认供应商只在创建任务时解析。之后切换默认供应商、禁用、删除或修改原实例均不影响已有任务，因为 Worker 使用任务中的快照。

## 任务执行

创建接口先在数据库写入 `queued` 记录，再将任务 ID 投递给进程内 Worker。Worker 使用有界并发池；上限来自 `AI_TASK_WORKER_CONCURRENCY`，默认 `4`，必须为正整数。启动时 Worker 会扫描 `queued`、超时的 `submitting` 和 `running` 任务，使服务重启可继续处理。

Worker 不持有数据库连接执行 HTTP 请求。每次仅短暂读取或更新任务状态；创建供应商任务、2 秒轮询、下载结果和上传 OSS 均在数据库事务之外进行。完成后 Worker 先将全部结果存为私有 `Media`，成功写入全部 `mediaId` 后才标记 `succeeded`。

MaiziAI 无幂等提交键：若进程恰好在供应商返回 `task_id` 与写入 `ProviderTaskID` 之间崩溃，重试可能创建重复的上游任务。该窗口不能由本地数据库消除；实现将记录明确错误而不是静默假定失败，并保持其余刷新/断网/正常重启场景可恢复。

## API 与前端恢复

`POST /api/v1/images/generations` 与 `POST /api/v1/images/edits` 接受 `clientRequestId`，立即返回 `202` 和任务概要，不再等待结果。新增：

- `GET /api/v1/image-tasks/:id`：仅所属用户或管理员可读，返回状态、进度、错误和成功媒体访问数据。
- `GET /api/v1/image-tasks/by-client/:clientRequestId`：供 POST 响应丢失后的画布恢复使用。

画布图片节点在提交前保存 `clientRequestId`，收到响应后保存 `generationTaskId`。页面加载和生成期间以短轮询查询任务：成功时把 `mediaId`、尺寸与缓存 Key 写回节点；失败时标记节点错误。每张批量图片维持独立任务和独立节点，任一任务失败不覆盖其他已完成节点。

## 临时参考图与存储

编辑接口在创建任务时将 multipart 参考图写入 `tasks/<task-id>/inputs/...`。本地模式写到应用数据目录；OSS 模式经 internal Endpoint 写入同一 Bucket，不暴露给浏览器。Worker 在调用 MaiziAI 前读取这些对象，完成或失败后删除。媒体输出仍通过既有 `saveImage` 流程写入用户隔离的 `images/private/<uid>/...` 对象路径。

## 权限、审计与清理

任务创建、查询和恢复均要求 Portal 身份。普通用户只能读取自己的任务，`portal-admin` 可以读取任意用户任务。创建、成功与失败均写操作记录；完整提示词仅管理员可见。每天清理 30 天前的终态任务，并补删遗留临时参考图；不删除已经保存的媒体。

## 验证

- 测试任务创建立即返回、Worker 轮询后成功保存媒体，以及 Worker 重启扫描恢复。
- 测试供应商切换、禁用、删除后已有任务仍用配置快照轮询。
- 测试所有权、客户端请求 ID 恢复、失败状态、临时参考图删除和 30 天清理。
- 测试画布刷新后恢复进行中任务及成功媒体。
- 执行 `go test ./...`、`bun test`、`bun run typecheck`、`bun run build`；不使用真实 MaiziAI 或 OSS 凭据。
