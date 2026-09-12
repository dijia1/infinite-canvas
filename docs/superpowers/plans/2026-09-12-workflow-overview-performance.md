# Workflow Overview Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Workflow 补齐视口裁剪、30% 以下轻量节点和广角 SVG 合并，同时保持 Graph、Frame、运行状态、媒体和保存语义不变。

**Architecture:** 完整 Graph 和视觉数组继续服务交互与持久化，新增纯函数构造只读的 viewport scene 供渲染层使用。节点 detail 复用普通 Canvas 的阈值和共享概览组件；连线路径在几何变化时缓存，在 overview 下按样式合并。

**Tech Stack:** React 19、TypeScript strict、Next.js 16、Bun、SVG、现有 Canvas 视口与媒体资源模块。

**Spec:** `docs/workflow-overview-performance-design.md`

## Global Constraints

- 不修改 Workflow Definition、数据库、API、运行调度、Frame 归属或保存协议。
- 不修改普通 Canvas 的 30% detail 阈值、192/256px 图片 LOD 阈值和图片并发上限 4。
- 完整视觉数组继续提供给拖拽、框选、复制、删除和 Frame 几何；visible 数组只用于 JSX 渲染。
- 每项先写能证明行为的失败测试，再实现最小修改。
- 不引入 WebGL、OffscreenCanvas、新状态库或新运行时依赖。
- 不自动提交、推送、部署或重建 Docker；提交步骤只在用户另行授权后执行。

---

### Task 1: 建立 Workflow viewport scene 和纯裁剪函数

**Files:**
- Create: `web/src/features/workflows/workflow-viewport-rendering.ts`
- Create: `web/src/features/workflows/workflow-viewport-rendering.test.ts`
- Read: `web/src/app/(user)/canvas/utils/canvas-node-visibility.ts`
- Read: `web/src/app/(user)/canvas/utils/canvas-connection-visibility.ts`
- Read: `web/src/features/workflows/workflow-canvas-adapter.ts`

**Interfaces:**
- Consumes: `CanvasNodeData[]`、`CanvasConnection[]`、`WorkflowGraph`、`ViewportTransform` 和现有可见性函数。
- Produces: `workflowOutputLinks(graph)`、`selectWorkflowViewportScene(input)`、`WorkflowViewportScene`。

- [ ] **Step 1: 写输出辅助线和视口裁剪失败测试**

测试构造一个视口内主节点、一个视口内输出、一个离屏节点、两条业务线和一条配置输出线，断言：

```ts
const scene = selectWorkflowViewportScene({
    nodes,
    connections,
    outputLinks: workflowOutputLinks(graph),
    viewport: { x: 0, y: 0, k: 1 },
    viewportSize: { width: 1280, height: 720 },
    retainedNodeIds: new Set(),
    interactiveConnectionIds: new Set(),
});

assert.deepEqual([...scene.visibleNodeIds], [insideMainId, insideOutputId]);
assert.deepEqual(scene.visibleConnections.map((item) => item.id), [insideConnectionId]);
assert.equal(scene.visibleOutputLinks.length, 1);
```

再覆盖零尺寸视口、64px 屏幕 padding、被 retain 的离屏节点、交互连线端点和输出视觉 ID 中包含分隔符的情况。

- [ ] **Step 2: 运行测试并确认缺少模块而失败**

```sh
cd /Users/Admin/codexprogram/infinite-canvas
bun test web/src/features/workflows/workflow-viewport-rendering.test.ts
```

预期：测试因 `workflow-viewport-rendering.ts` 或导出函数不存在而失败。

- [ ] **Step 3: 实现最小纯函数**

```ts
export type WorkflowViewportScene = {
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    visibleNodeIds: ReadonlySet<string>;
    visibleConnections: readonly CanvasConnection[];
    visibleOutputLinks: readonly CanvasConnection[];
};

export function workflowOutputLinks(graph: WorkflowGraph): CanvasConnection[] {
    return graph.nodes.flatMap((node) =>
        (node.outputs || []).map((slot) => ({
            id: `workflow-output:${workflowVisualOutputId(node.id, slot.id)}`,
            fromNodeId: workflowVisualNodeId(node.id),
            toNodeId: workflowVisualOutputId(node.id, slot.id),
        })),
    );
}
```

`selectWorkflowViewportScene()` 使用一个 `Map` 做端点查询，先由 `isCanvasNodeNearViewport()` 加上 retained 集合确定节点，再用 `shouldRenderCanvasConnection()` 和 `isCanvasConnectionNearViewport()`过滤两类连接。函数不得修改输入数组、Graph 或节点对象。

- [ ] **Step 4: 运行定向测试**

```sh
bun test web/src/features/workflows/workflow-viewport-rendering.test.ts web/src/app/'(user)'/canvas/utils/canvas-node-visibility.test.ts web/src/app/'(user)'/canvas/utils/canvas-connection-visibility.test.ts
```

预期：全部通过。

- [ ] **Step 5: 检查差异**

```sh
git diff --check
git diff -- web/src/features/workflows/workflow-viewport-rendering.ts web/src/features/workflows/workflow-viewport-rendering.test.ts
```

预期：无尾随空格、冲突标记和无关文件修改。

### Task 2: 将视口裁剪接入 Workflow 编辑器

**Files:**
- Modify: `web/src/features/workflows/workflow-editor.tsx`
- Modify: `web/src/features/workflows/workflow-editor-index.test.ts`
- Test: `web/src/features/workflows/workflow-viewport-rendering.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `workflowOutputLinks()` 和 `selectWorkflowViewportScene()`。
- Produces: 编辑器内 `viewportScene`、`renderedWorkflowNodes`、`renderedWorkflowOutputs` 和稳定的 `visualNodeById`。

- [ ] **Step 1: 写编辑器接线失败测试**

通过现有 `sourceBehavior`/hook harness 证明以下约束：

```ts
assert.equal(canvas.nodes.length, totalVisualNodeCount, "interaction arrays stay complete");
assert.equal(viewportScene.visibleNodeIds.has(offscreenVisualId), false);
assert.equal(viewportScene.visibleNodeIds.has(draggedVisualId), true);
```

同时断言选中连线、切线连线及连接中的端点加入 retain/interactive 集合；视角变化不调用 `toWorkflowCanvasNodes()` 重新构建完整数组。

- [ ] **Step 2: 运行测试并确认编辑器仍遍历完整 Graph 而失败**

```sh
bun test web/src/features/workflows/workflow-editor-index.test.ts web/src/features/workflows/workflow-viewport-rendering.test.ts
```

预期：新增的 rendered scene 断言失败，既有测试保持通过。

- [ ] **Step 3: 在编辑器构造 retained 和 interactive 集合**

```ts
const retainedVisualNodeIds = useMemo(() => {
    const ids = new Set(canvas.selectedNodeIds);
    if (interactions.connectingParams?.nodeId) ids.add(interactions.connectingParams.nodeId);
    for (const id of interactiveConnectionEndpointIds) ids.add(id);
    return ids;
}, [canvas.selectedNodeIds, interactions.connectingParams?.nodeId, interactiveConnectionEndpointIds]);
```

调整大小开始时已经把目标设为唯一选择；拖动使用当前选择，因此无需新增第二套持久化状态。连接端点从完整 `canvas.connections` 和选中/切线 ID 推导。

- [ ] **Step 4: 只在 JSX 层使用 viewport scene**

保留：

```ts
const canvas = useWorkflowInteractions({ graph, ... });
```

新增：

```ts
const outputLinks = useMemo(() => workflowOutputLinks(graph), [graph]);
const viewportScene = useMemo(
    () => selectWorkflowViewportScene({
        nodes: canvas.nodes,
        connections: canvas.connections,
        outputLinks,
        viewport,
        viewportSize,
        retainedNodeIds: retainedVisualNodeIds,
        interactiveConnectionIds,
    }),
    [canvas.nodes, canvas.connections, outputLinks, viewport, viewportSize, retainedVisualNodeIds, interactiveConnectionIds],
);
```

节点和输出 JSX 根据 `viewportScene.visibleNodeIds` 过滤；连线使用 scene 的两个可见列表。删除 `.find()` 端点查找，统一使用 `viewportScene.nodeById.get(id)`。Frame、Run 索引、imageTargets、autosave 和 interactions 继续读取完整 Graph/数组。

- [ ] **Step 5: 回归边界交互测试**

覆盖：拖动节点越过视口边界、调整大小、连接创建、切线、框选、Frame 移动和 Option 整组移出。测试必须证明裁剪没有改变 Graph 数量、Frame `nodeIds`、历史快照或保存 document。

- [ ] **Step 6: 运行 Workflow 定向测试**

```sh
bun test web/src/features/workflows/workflow-editor-index.test.ts web/src/features/workflows/workflow-canvas-adapter.test.ts web/src/features/workflows/workflow-frame-gestures.test.ts web/src/features/workflows/workflow-frames.test.ts web/src/features/workflows/workflow-viewport-rendering.test.ts
```

预期：全部通过。

- [ ] **Step 7: 形成第一个可回滚改动**

用户授权提交时仅加入 Task 1–2 文件：

```sh
git add web/src/features/workflows/workflow-viewport-rendering.ts web/src/features/workflows/workflow-viewport-rendering.test.ts web/src/features/workflows/workflow-editor.tsx web/src/features/workflows/workflow-editor-index.test.ts
git commit -m "perf: cull workflow viewport scene"
```

### Task 3: 提取共享概览节点并接入 Workflow

**Files:**
- Create: `web/src/components/canvas-overview-node.tsx`
- Create: `web/src/components/canvas-overview-node.test.tsx`
- Modify: `web/src/app/(user)/canvas/components/canvas-node.tsx`
- Modify: `web/src/features/workflows/workflow-node.tsx`
- Modify: `web/src/features/workflows/workflow-editor.tsx`
- Modify: `web/src/features/workflows/workflow-editor-index.test.ts`
- Test: `web/src/app/(user)/canvas/media/canvas-media-policy.test.ts`

**Interfaces:**
- Consumes: `CanvasRenderDetail`、现有主题 token、图片 URL 和视觉节点几何。
- Produces: `CanvasOverviewNode`、Workflow 两种卡片的 `renderDetail` 参数。

- [ ] **Step 1: 写共享概览组件失败测试**

测试组件在有图片时只渲染一个 `<img>`，无图片时渲染占位，不包含按钮、表单、连接端口和调整手柄；图片 load 回调携带当前 storage key。

```ts
assert.match(html, /data-canvas-overview-node/);
assert.doesNotMatch(html, /button|textarea|data-canvas-connection|data-canvas-resize/);
```

再为 `WorkflowNodeCard` 和 `WorkflowOutputCard` 增加 source/component 行为测试：overview 使用共享组件，full 保留当前面板和状态操作。

- [ ] **Step 2: 运行测试并确认组件不存在而失败**

```sh
bun test web/src/components/canvas-overview-node.test.tsx web/src/app/'(user)'/canvas/media/canvas-media-policy.test.ts web/src/features/workflows/workflow-editor-index.test.ts
```

预期：新增组件和 Workflow `renderDetail` 接口不存在。

- [ ] **Step 3: 提取普通 Canvas 现有 overview 展示**

`CanvasOverviewNode` 内保持当前 `rounded-3xl`、边框、选中颜色、`contain: layout paint style` 和异步图片 decoding。普通 `CanvasNode` 的 `renderDetail === "overview"` 分支改为调用该组件，事件和 context menu 仍由普通 Canvas 提供。

- [ ] **Step 4: 为 Workflow 卡片增加 detail 分支**

```ts
type WorkflowCardDetailProps = {
    renderDetail?: CanvasRenderDetail;
};

if (renderDetail === "overview") {
    return <CanvasOverviewNode ... />;
}
```

所有 hooks 保持无条件调用，overview 的返回发生在 hooks 之后，避免违反 React hooks 顺序。图片输出使用 `imageUrl`；失败、等待、视频、文本和配置使用类型/状态占位，不挂载完整控件。

- [ ] **Step 5: 复用普通 Canvas detail 阈值并保留交互对象**

在编辑器中计算：

```ts
const renderDetail = getCanvasRenderDetail(viewport.k);
const fullDetailIds = retainedVisualNodeIds;
const visualDetail = (id: string): CanvasRenderDetail =>
    renderDetail === "overview" && !fullDetailIds.has(id) ? "overview" : "full";
```

分别传给主节点和输出卡。30%/31% 阈值只控制显示，不写 Graph、历史或保存队列。

- [ ] **Step 6: 移除卡片的高频 viewport props**

给 `InfiniteCanvas` 根元素增加 `data-infinite-canvas`。`WorkflowNodeToolbar` 挂载时通过 anchor 找到该容器，并监听容器已有的 `canvasviewportchange` 事件；工具栏仍监听 window resize/scroll。删除 `WorkflowNodeCard`、`WorkflowOutputCard` 和 `WorkflowNodeToolbar` 的 `viewport` props，避免视角提交天然改变每张卡片的 props。

- [ ] **Step 7: 补齐选中图片固定原图**

在 Workflow imageTargets 中解析选择：图片输入使用 node ID，成功图片输出使用当前 run ID 生成的 resource ID。

```ts
const pinned = preview || selectedImageResourceIds.has(canvasNode.id);
return [{ node: canvasNode, visible, pinned, prefetch, preview }];
```

测试必须覆盖输入图片、生成图片输出、旧 run 结果切换和取消选择。共享资源控制器原有竞态测试继续覆盖旧 thumbnail 晚到不能覆盖 original。

- [ ] **Step 8: 运行节点与媒体测试**

```sh
bun test web/src/components/canvas-overview-node.test.tsx web/src/app/'(user)'/canvas/components/infinite-canvas.test.ts web/src/app/'(user)'/canvas/media/canvas-media-policy.test.ts web/src/app/'(user)'/canvas/media/canvas-image-resource-controller.test.ts web/src/app/'(user)'/canvas/media/use-canvas-image-resources.test.ts web/src/features/workflows/workflow-editor-index.test.ts
```

预期：全部通过；普通 Canvas 的 overview 结构和图片策略保持原行为。

- [ ] **Step 9: 形成第二个可回滚改动**

用户授权提交时：

```sh
git add web/src/components/canvas-overview-node.tsx web/src/components/canvas-overview-node.test.tsx web/src/app/'(user)'/canvas/components/canvas-node.tsx web/src/app/'(user)'/canvas/components/infinite-canvas.tsx web/src/features/workflows/workflow-node.tsx web/src/features/workflows/workflow-editor.tsx web/src/features/workflows/workflow-editor-index.test.ts
git commit -m "perf: add workflow overview nodes"
```

### Task 4: 缓存并合并 Workflow SVG 路径

**Files:**
- Modify: `web/src/features/workflows/workflow-viewport-rendering.ts`
- Modify: `web/src/features/workflows/workflow-viewport-rendering.test.ts`
- Modify: `web/src/features/workflows/workflow-editor.tsx`
- Modify: `web/src/features/workflows/workflow-editor-index.test.ts`
- Read: `web/src/app/(user)/canvas/utils/canvas-connection-geometry.ts`

**Interfaces:**
- Consumes: Task 1 的可见连接和 `nodeById`，以及共享 `buildConnectionPathData()`。
- Produces: `workflowConnectionPathCache()`、`workflowOutputPathCache()`、overview 的两个合并 path 字符串。

- [ ] **Step 1: 写路径缓存与合并失败测试**

测试两条业务线合并成一个 `d`，两条输出辅助线合并成另一个 `d`，并保持辅助线原有固定 48 单位控制点。

```ts
assert.equal(businessPath, `${firstBusinessD} ${secondBusinessD}`);
assert.equal(outputPath, `${firstOutputD} ${secondOutputD}`);
```

再断言视角只改变 visible 列表时复用相同 cache；节点几何变化后生成新的路径。

- [ ] **Step 2: 运行测试并确认路径 API 不存在而失败**

```sh
bun test web/src/features/workflows/workflow-viewport-rendering.test.ts web/src/app/'(user)'/canvas/utils/canvas-connection-geometry.test.ts
```

- [ ] **Step 3: 实现业务线和辅助线路径缓存**

业务线缓存调用 `getConnectionCurve(from, to).pathD`。辅助线保留：

```ts
const pathD = `M ${fromX} ${fromY} C ${fromX + 48} ${fromY}, ${toX - 48} ${toY}, ${toX} ${toY}`;
```

缓存只依赖完整视觉节点数组和对应连接几何，不依赖 viewport。

- [ ] **Step 4: 在 overview 下分层合并**

```tsx
{overviewBusinessPath ? <path data-workflow-overview-connections d={overviewBusinessPath} ... /> : null}
{overviewOutputPath ? <path data-workflow-overview-outputs d={overviewOutputPath} ... /> : null}
{interactiveConnections.map((connection) => <ConnectionPath ... />)}
```

31% 以上继续遍历当前可见连接。`ActiveConnectionPath` 和 cut polyline 始终单独渲染。非交互合并 path 设置 `pointerEvents: "none"`。

- [ ] **Step 5: 添加 DOM 数量行为测试**

在 overview 测试中构造 100 条业务线和 50 条输出线，断言非交互 path 只有两个；加入选中和切线后，只增加对应的独立 `ConnectionPath`。full 模式断言逐条可见连接仍可选择。

- [ ] **Step 6: 运行 SVG 和 Workflow 回归测试**

```sh
bun test web/src/features/workflows/workflow-viewport-rendering.test.ts web/src/features/workflows/workflow-editor-index.test.ts web/src/app/'(user)'/canvas/utils/canvas-connection-geometry.test.ts web/src/app/'(user)'/canvas/utils/canvas-connection-visibility.test.ts
```

预期：全部通过。

- [ ] **Step 7: 形成第三个可回滚改动**

用户授权提交时：

```sh
git add web/src/features/workflows/workflow-viewport-rendering.ts web/src/features/workflows/workflow-viewport-rendering.test.ts web/src/features/workflows/workflow-editor.tsx web/src/features/workflows/workflow-editor-index.test.ts
git commit -m "perf: batch workflow overview connections"
```

### Task 5: 浏览器 A/B、完整验证与结果记录

**Files:**
- Create: `docs/workflow-overview-performance-results.md`
- Create: `docs/workflow-overview-performance-results.json`
- Modify only if a verified defect is found: files from Tasks 1–4

**Interfaces:**
- Consumes: 三个独立前端改动和同一份 250 节点/30 Frame fixture。
- Produces: 可复现性能报告、原始指标和最终验收结论。

- [ ] **Step 1: 固定 A/B 环境和夹具**

记录机器、浏览器、视口、生产构建 hash、节点类型分布、连接数、Frame 数、图片缓存状态和随机种子。使用预置媒体或 mock API，不调用图片/视频供应商。

- [ ] **Step 2: 交错采集五轮基线与修改版**

在 5%、14%、30%、31% 和 100% 下分别执行真实滚轮缩放与空格拖动。每轮记录 DOM、Workflow 卡片、SVG path、rAF p50/p95/p99/max、React commit、Style/Layout/Paint/Composite、JS heap 和媒体请求。

- [ ] **Step 3: 检查功能验收矩阵**

逐项验证：深浅主题、选中恢复 full、图片 original 晋级、离屏再进入、连接创建/选择/切线、Frame 移动和扩大、Option 移出、只读、Undo/Redo、自动保存和刷新恢复。

- [ ] **Step 4: 执行前端完整检查**

```sh
cd /Users/Admin/codexprogram/infinite-canvas
bun test web/src
cd web
bun run typecheck -- --incremental false
bun run build
cd ..
git diff --check
```

预期：Bun 0 失败、TypeScript 0 错误、生产构建完成、diff check 无输出。

- [ ] **Step 5: 写入真实结果并执行停止条件**

报告必须区分基线、修改版和限制，不填写预计收益作为实测。如果 DOM 未下降 50%、overview 非交互 path 超过两个、媒体请求增加或 100% 五轮中位 p95 回退超过 10%，停止后续提交并附 Performance trace 证据。

- [ ] **Step 6: 最终差异审查**

确认没有后端、数据库、Workflow Definition、媒体生命周期和保存协议变化；确认所有新增派生数据没有进入 document、history 或 autosave。

## Self-Review

- [x] 三项能力分别对应 Task 1–2、Task 3、Task 4。
- [x] 完整 Graph 与渲染投影边界贯穿全部任务。
- [x] 图片选择、异步竞态、Run 来源、Frame 和拖拽边界均有测试入口。
- [x] 未使用空 document、Graph 过滤保存或新的后端字段规避性能问题。
- [x] 性能收益写为验收目标，未描述成已实现结果。
- [x] 提交、部署和 Docker 操作均保留用户授权边界。
