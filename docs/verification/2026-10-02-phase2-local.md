# Infinite Canvas 第二阶段本地验收（未发布）

执行仓库：`/tmp/infinite-canvas-phase2-work`，分支 `codex/infinite-canvas-phase2`。
原工作仓库 main `543919f4667204dd8d400151cfc0524cfe16a4ba` 及用户未跟踪的 `CLAUDE.md` 完整保留。

## 生产基线与发布范围

只读核实的生产/远端 SHA：`731a00ad08b90a10403df974d78c433e3e6db887`。
现有 Actions `36235675235` 成功，生产容器健康，Node 22.23.3、uid/gid 0，未设置 init/停止宽限。
当前最后健康版本为 731a00a，上一健康版本为 `2e5a985882756f5a67b654c9b9b63ecaf4d50152`；版本 2 发布状态已存在。
本轮没有生产写入、停止、部署或推送，也没有修改宿主权限、网络或凭据。

原分支在生产之后有 6 个未发布提交。当前隔离分支仅带入以下已有前置提交，尚须父任务确认其发布范围：

| 原 SHA | 隔离分支 SHA | 范围 |
| --- | --- | --- |
| d621203 | af2f6be | 强制 Portal 签名、健康、角色/管理员行为及前端管理入口，共 43 文件 |
| 866451f | d13e640 | 独立迁移、严格网关健康、精确版本发布与测试，共 28 文件 |
| 543919f | e6e8bc7 | 身份诊断 JSON 行格式，共 2 文件 |

明确排除 `89aac89`、`b11928a` 的公开图片业务复制，以及 `aa0f2a7` 的历史公开图片引用数据迁移。第二阶段自身没有更改路由、签名协议、业务模型、SQL 或迁移命令。前置提交相较当前生产仍包含鉴权/角色和迁移运行方式改变；不能仅凭第二阶段授权自动发布它们。部署文档还要求在改变数据库运行或迁移逻辑前由生产数据库操作人员完成专属 schema 的一致性备份和隔离恢复验证，本轮未执行或声称完成这项生产数据验证。

## 实现

- Go 原生 net/http Shutdown，跟踪实际处理函数（断连后仍等待），关闭期间响应 Connection: close。
- 全部后台循环停止领取新任务，当前执行完成后退出；图片租约心跳继续，视频当前步骤完成；定时清理器可重复停止且等待结束。
- 两阶段容器停机：SIGUSR1 停止 Go 后台领取，Next 原生排空，再 SIGTERM 排空 Go；最后关闭数据库池。
- 全过程 25 秒非零超时兜底，Go 自身 24 秒；重复 TERM/INT 不强制提前中止。Next 原生成功退出 143 只在预期停机时被接受。
- Node 24 bookworm-slim，保留 Go 1.25、Bun 1.4.0、Next 16.2.3 和原锁文件；USER node（1000:1000），compose init=true/30s；直接 Node 入口保留。
- CI 在现有镜像推送和精确 SHA 部署前加入实际镜像验证，无新增触发器、权限或凭据。

## 实际媒体挂载

生产只读配置检查确认 MEDIA_STORAGE=oss，两个 OSS endpoint 已配置。RW 挂载为 `/program/data/infinite-canvas/media` → `/app/data/media`，恰好一个空目录、0 文件/子目录/符号链接，uid/gid 0:0、0755。源码没有 OSS → local 回退。实际镜像用 root-owned 0755 的不可写模拟媒体卷验证：uid 1000 下 OSS 上传 intent 返回 direct，卷仍为空。因此此部署无需宿主 chown/chmod。若改用 local，须另行明确授权可写目录权限安排，不能直接采用此结论。

## 验证通过

- 完整 `scripts/test-backend-postgres.sh`：所有 Go 包通过；新增 worker 测试在真实 10 秒心跳期间保持租约并完整结束当前供应商调用。
- `scripts/test-backend-postgres.sh -race ./service`：通过。
- `go test -race ./internal/lifecycle`：4 项 HTTP 测试通过（在途响应、断连工作、超时、流式传输）。
- `go vet ./...`：通过。
- Node 发布/健康/监督进程测试：25/25，通过；其中 10 项真实子进程信号测试。
- 前端基线：789/789 Bun 测试，TypeScript 检查通过；前端业务源码和依赖未改。
- 实际 linux/amd64 Docker 镜像：Node24 下 Next webpack 生产构建及 TypeScript 检查、Go1.25编译、ffmpeg 均通过。
- 实际镜像隔离测试：1/1，通过（约45.6秒，包含25秒硬超时）。验证 uid/gid1000/init30、签名校验、OSS direct 意图/不可写卷、被数据库锁阻塞的在途画板 PUT 成功且 revision2 持久化、断连后仍等待查询、拒新连接、数据库会话归零、重复信号、超时退出1、空闲退出0且<3秒。
- Shell 语法、Compose 配置、workflow YAML、git diff whitespace：通过（在本地提交前核对）。

本地镜像 `infinite-canvas:phase2-local`，测试镜像 manifest 为 `sha256:9b86d9c07a273ad07b4cf0670cc49de9793b42fb312d54efd42e5d34d456586a`。它是本地运行代码验证镜像，未声明对应新的正式发布 SHA；发布必须由 CI 对批准的完整提交重建、测试、推送。
