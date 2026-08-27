# 代码简化与生成配置收敛设计

## 目标

删除已经被持久化异步图片任务替代的同步图片生成路径，消除旧画布工具栏样式，并将前端生成配置与供应商请求工具收敛到单一职责模块。完成后，图片、编辑和视频请求仍走现有的供应商实例、异步任务、Portal 身份和 OSS 媒体流程。

## 范围

- 删除没有调用方的旧同步图片生成接口、供应商适配方法及专用测试。
- 删除没有 JSX 调用方的旧 CSS 规则。
- 将共享的供应商请求选项与脱敏摘要辅助函数移出 MaiziAI 实现文件。
- 使用一个前端纯函数生成节点配置；图片、图像编辑和视频就绪状态按能力检查。
- 移除前端已经废弃的模型字段，并在读取浏览器持久化状态时丢弃它们；历史画布节点中遗留的 `metadata.model` 保持可读取但不再参与请求。

## 不在范围内

- 不拆分画布主页面、媒体缓存、任务 Worker 或两个素材抽屉。
- 不修改后端 `ai.ImageRequest.Model`、供应商后台模型配置、任务数据库结构、OSS、Portal 接口或公开 HTTP 路由。
- 不迁移或删除浏览器中的画布、素材和 IndexedDB 数据。

## 设计

### 后端清理与共享工具

图片生成 HTTP 路由已创建 `ImageGenerationTask` 并由 Worker 执行，原 `service.GenerateImages`、`EditImages` 和 `ai.ImageGenerator`、`ImageEditor` 不再属于运行链路。删除它们和供应商中的同步包装方法；保留 `ImageResult`，因为 Worker 仍用它把上游 URL 保存为 Media。

共享的请求选项克隆、字符串读取、脱敏 JSON 序列化放入 `ai/providers/image_request_helpers.go`。函数以供应商无关的名称暴露给同包的 MaiziAI、豆包实现，不新增跨包抽象。

### 前端生成配置

`buildGenerationConfig` 成为生成设置的唯一解析器。节点本地供应商选择和其参数优先；没有本地快照时使用全局选择。此函数负责旧分辨率归一化、输出格式和背景默认值。两个面板直接调用它，不再各自维护 `buildNodeConfig`。

就绪检查只接受 `image`、`imageEdit` 或 `video`。图片流程在确认是否存在参考图后选择图片或编辑能力；视频流程只检查视频能力。文本生成已被移除，不再通过模型字段参与就绪判断。

### 历史配置兼容

Zustand 持久化存储使用新的版本和迁移函数，只保留当前 `AiConfig` 字段，补齐默认值并归一化分辨率。存储中的 `model`、`imageModel`、`videoModel`、`textModel`、`models` 与 `systemPrompt` 被忽略。画布 JSON 不进行主动写入迁移，运行时继续容忍额外的历史字段。

## 验证

- Go 测试覆盖异步任务路径；源码检查确认同步接口已删除。
- Bun 测试覆盖配置解析、能力就绪判断和持久化旧配置归一化。
- 运行 `go test ./...`、`bun test`、`bun run typecheck`、`bun run build` 以及 `git diff --check`。
