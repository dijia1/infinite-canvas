# Portal 生产部署

无限画板以私有 GHCR 镜像部署到 Portal Gateway 后方。浏览器访问入口是：

```text
https://www.semetaloa.com/apps/infinite-canvas/canvas
```

应用容器不公开宿主机端口；Portal Gateway 负责登录、应用访问权限和身份头注入。

## 启动与恢复

应用启动先等待数据库连接，最长 60 秒，每次连接尝试最多 2 秒；连接失败不会提前触发数据库迁移或任务 Worker。连接恢复后才按原有顺序初始化，密码或数据库名错误会直接失败。

容器等待 Go API 的 `/api/healthz` 就绪后才启动前端，整体就绪等待最多 120 秒。任一子进程退出会停止另一个进程并以失败状态退出容器，由现有 `restart: unless-stopped` 策略重启。正常停止会向两个进程发送 SIGTERM，8 秒后仍未退出的进程会被终止。该机制不重新提交任务，任务恢复仍使用现有状态与上游任务 ID。

本地更新应用（保留现有数据库和数据目录）：

```bash
cd /Users/Admin/codexprogram/infinite-canvas
docker compose -f docker-compose.local.yml up -d --build --no-deps app
docker compose -f docker-compose.local.yml ps app
docker compose -f docker-compose.local.yml logs --tail=100 app
```

若只是旧版本在 Docker 同时启动时后端退出，数据库恢复健康后可用 `docker compose -f docker-compose.local.yml restart app` 临时恢复。新版镜像会管理前后端退出联动；健康检查失败本身不会触发 Docker 重启，不能把 healthcheck 当作进程监护。

## 一次性生产初始化

1. 启动 Portal，并确认外部 Docker 网络 `portal_gateway`、`internal_tools_database` 与 `portal_directory` 已存在。
2. 创建应用目录和持久化数据目录：

   ```bash
   mkdir -p /program/apps/infinite-canvas /program/data/infinite-canvas/media
   ```

3. 在 `/program/apps/infinite-canvas/.env` 写入生产配置。文件不得提交到 Git，`DATABASE_DSN` 为必填项，必须连接到专属 PostgreSQL schema；应用没有数据库类型选择项，也不会创建本地数据库文件。该文件至少还包含 OSS 配置、`PORTAL_DIRECTORY_SECRET`、`APP_RBAC_INITIAL_ADMIN_UIDS` 和 AI 供应商配置所需的运行变量。
4. 在 Portal 后台登记应用：
   - 应用键：`infinite-canvas`
   - 上游端口：`3000`
   - 启用应用，并向需要使用的角色授予 `app:infinite-canvas:access`。
5. 按以下顺序完成应用内 RBAC 首次发布（新建数据库和升级部署均适用）：
   1. 在 Portal 中确认目标初始管理员已启用且具有 `app:infinite-canvas:access`；`APP_RBAC_INITIAL_ADMIN_UIDS` 必须只包含这些准确的 Portal UID（多个 UID 用逗号分隔）。
   2. 设置 `APP_RBAC_INITIAL_ADMIN_UIDS` 并部署。首次成功启动会在引导前同步 Portal 目录，确认这些 UID 已同步且启用后，一次性引导为 Infinite Canvas 本地管理员。目录同步或校验失败会使启动失败，不会写入完成标记。
   3. 验证其中一位用户能够进入 `/admin/members`。
   4. 在变更初始管理员前，先在“成员管理”中至少再授予一位用户本地管理员角色。
   5. 引导完成标记已写入后，从部署环境移除 `APP_RBAC_INITIAL_ADMIN_UIDS`。
   6. 此后所有 Infinite Canvas 角色都在“成员管理”中维护；不要为本应用分配 Portal 管理员或公共素材管理角色，也不要自动导入既有 Portal 公共素材管理员成员。

完成标记存在后，后续启动不会再自动同步 Portal 目录；管理员可在成员管理中按需发起同步。Portal 仍负责可信身份和 `app:infinite-canvas:access` 应用入口。Gateway 注入的 Portal 角色只保留为展示和审计元数据，绝不参与 Infinite Canvas 授权。
6. 在 GitHub 仓库的 `production` Environment 配置 Secrets：
   - `DEPLOY_HOST`
   - `DEPLOY_USER`
   - `DEPLOY_SSH_PRIVATE_KEY`
   - `DEPLOY_KNOWN_HOSTS`
   - `GHCR_READ_TOKEN`：可读取私有 `ghcr.io/dijia1/infinite-canvas` 包的最小权限 Token。

## 首次发布基线

首次 GitHub Actions 会将当前 release 配置上传到
`/program/apps/infinite-canvas/releases/<SHA>/`，但在没有健康基线时停止，不覆盖正在运行的服务。

在服务器完成一次受控启动后建立基线：

```bash
export DEPLOY_SHA=<40 位 Git SHA>
export INFINITE_CANVAS_IMAGE=ghcr.io/dijia1/infinite-canvas:sha-$DEPLOY_SHA
export RELEASE_DIR=/program/apps/infinite-canvas/releases/$DEPLOY_SHA

docker login ghcr.io
docker pull "$INFINITE_CANVAS_IMAGE"
INFINITE_CANVAS_ENV_FILE=/program/apps/infinite-canvas/.env \
INFINITE_CANVAS_MEDIA_DIR=/program/data/infinite-canvas/media \
docker compose --project-name infinite-canvas \
  --env-file /program/apps/infinite-canvas/.env \
  -f "$RELEASE_DIR/docker-compose.yml" up -d --no-build --force-recreate app
"$RELEASE_DIR/scripts/initialize-release-state.sh" "$DEPLOY_SHA" "$INFINITE_CANVAS_IMAGE" "$RELEASE_DIR"
docker logout ghcr.io
```

初始化脚本只会在 Compose 配置有效、容器实际镜像引用及镜像 ID 均匹配、healthcheck 通过后记录首个健康版本；不会虚构上一版本。

## 常规发布与回滚

推送到 `main` 后，GitHub Actions 会先运行 Go 与前端测试、构建 `linux/amd64` 镜像并发布：

```text
ghcr.io/dijia1/infinite-canvas:sha-<GITHUB_SHA>
```

随后部署 Job 通过严格 known-host 校验连接服务器，上传该 SHA 对应的 Compose 与部署脚本，临时登录 GHCR、拉取指定镜像并重建唯一的 `app` 服务。

手动触发的工作流也只有 `main` 分支可以执行生产部署。发布前检查当前记录的 Compose、容器镜像引用、镜像 ID 和健康状态，任何不一致都会停止发布。目标镜像标签中的 SHA 必须与发布 SHA 完全一致。

部署后最多检查 90 次健康状态，间隔 2 秒（等待窗口约 180 秒，Docker 命令自身耗时另计）。失败时使用**此次发布开始前的当前健康版本**的 Compose 和镜像恢复，任务仍返回失败；不会跳过当前版本而回退到更早的 previous。数据库仍沿用应用启动时的 GORM 自动迁移；应用镜像回滚不会回退数据库 schema 或数据。

## 版本记录与历史镜像清理

状态文件仍为 `/program/data/infinite-canvas/infinite-canvas-release.last-known-good`。版本 2 同时记录 current 与 previous 的 SHA、镜像引用和 release 目录。只在目标容器镜像及健康检查通过后，以权限 `0600` 的临时文件原子替换状态。不同 SHA 发布成功时，原 current 成为 previous；同 SHA 重发保留原 previous。

旧的三行状态文件仍可读取，但必须通过实际容器校验，才允许后续发布并转换为版本 2。首次初始化或仅有一个健康版本时，自动清理跳过；第二个不同版本发布成功后才具备清理条件。状态损坏、镜像缺失、保护信息无法读取时，不执行清理。

每次发布成功并提交状态后，脚本在同一发布锁内自动清理本机历史镜像：

- 只处理 `ghcr.io/dijia1/infinite-canvas:sha-<40 位 SHA>`，按完整引用逐个删除，不使用强制删除或全局 prune。
- 保护 current、previous、此次发布目标，以及所有运行或停止容器引用的镜像 ID。多个标签指向同一个受保护 ID 时，一并保留。
- 删除前再次检查标签 ID 和容器引用；清理失败输出警告，不回滚已经健康的服务。
- 不清理 GHCR 远端镜像、release 目录、数据卷、构建缓存、无标签镜像或其他应用镜像。

上线前先核对生产状态、容器镜像和健康检查，再在已上传的新 release 目录运行预览：

```bash
bash "$RELEASE_DIR/scripts/cleanup-release-images.sh" --dry-run
```

确认输出范围后，可在受控维护中执行 `--apply`。独立执行同样获取发布锁，避免与发布同时运行。脚本依赖生产 Linux 上现有的 Bash、flock 和 Docker Compose；预览和应用均不访问视频或图片数据。

CI 在镜像构建前执行 Shell 语法、Compose 配置检查及 Go 中的模拟 Docker 行为测试。模拟测试不操作本机 Docker 镜像，不能替代首次上线时对真实服务器状态的核对。

## PostgreSQL 变更前的备份与恢复验证

在发布会改变数据库运行方式、模型或迁移逻辑的版本前，先由生产数据库操作人员完成以下验证，再允许部署：

1. 在不停写的生产库上创建 Infinite Canvas 专属 schema 的一致性备份；不要导出或修改其他应用的 schema。
2. 将备份恢复到隔离的 PostgreSQL 实例或数据库中，绝不覆盖生产库。
3. 对比恢复前后的各表行数，并用当前或待发布镜像连接隔离库，验证能够读取画布、媒体、图片任务、Portal 成员和应用内角色。
4. 记录备份位置、恢复结果和验证时间；失败时停止发布，先解决恢复问题。

该验证只证明备份可恢复，不会替代常规数据库备份策略，也不应通过回滚应用镜像来尝试回退已执行的数据库迁移。

Portal 验收应分别验证：未登录用户跳转登录页、无权限用户显示禁止页，以及被授权用户可进入 `/apps/infinite-canvas/canvas`。目录同步回调通过 `portal_directory` 网络访问 `infinite-canvas-directory:3000`。
