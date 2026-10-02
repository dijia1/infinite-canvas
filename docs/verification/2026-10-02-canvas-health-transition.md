# Canvas 两阶段健康过渡与回滚

只适用于旧版本 `731a00ad08b90a10403df974d78c433e3e6db887` 到鉴权/JSON 健康前置版本 `af2f6be3d2c6d2f00565a9711b6e2543ea14ec99` 的一次受控过渡。控制脚本不接入正常 CI，不创建密钥、授予角色、设置网络或修改宿主挂载权限。显式 `--apply` 是操作模式，不能代替用户授权。

用户已明确接受 Portal 全局管理员、最后本地管理员撤销及停用同步规则，以及 Canvas 专属 schema 备份恢复和两阶段上线。其他应用及公开图片业务/历史数据迁移不在范围内。

## 阶段一：真实健康/鉴权前置

1. 在批准的私有备份目录保存 `internal_tools.infinite_canvas` 的一致性 custom 备份及同快照21表计数/结构。只恢复到隔离 PostgreSQL16，阻断生产DB、Portal、OSS和供应商出站。
2. 旧镜像仍会在启动时自动迁移，不能用只读DSN启动它：使用独立恢复副本允许本地迁移，阻断全部出站，记录隔离副本的变化。候选已分离迁移的镜像可先验证 `/app/migrate`，再用只读DSN做API读验证。两个版本各用独立恢复副本；源备份不变。
3. 保存真实备份/恢复回执，绑定备份文件SHA256、PG16/schema、真实一致性快照、21表计数、恢复/结构/迁移/网络隔离验证及两个已验证源码版本（前置af2f6be、运行改动基线66495c5）。控制脚本只核验证据，不生成备份、不恢复数据库，不把模拟测试回执当真实验证。
4. 使用现有 workflow_dispatch 在非main分支构建前置SHA；该版本的部署job仅对main运行，故不自动切生产。不要先push main触发旧过渡流程。
5. 用真实Git bundle/detached checkout准备current/previous及目标release元数据，逐文件核对原已部署配置。旧tar目录不可冒充Git checkout；也不能手写SHA/健康状态。准备工作不得覆盖已部署配置或未知用户文件。
6. 默认 `bash scripts/transition-canvas-health.sh --plan` 只说明计划。`--check <receipt>`不创建锁、不pull/up/迁移或写状态。`--apply <receipt>`取得应用发布锁后重新检查：正确的固定旧SHA/镜像ID/revision，真实旧数据库Ping健康响应 `200 text/plain` body `ok`，准确Git元数据以及私有备份恢复证据。
7. 前置目标up后只接受实际 `200 application/json {"ok":true}`。未通过不写新状态；失败恢复准确731镜像/配置，并按其真实旧契约验证，明确报告它尚不是JSON基线。原状态文件保持不变，回滚失败明确报错，不伪造恢复成功。
8. JSON验证成功后原子记录current=前置SHA、previous=731；状态文件沿用私有0600，保留历史镜像。只在微小原子提交段及回滚过程中忽略重复中断信号，避免状态和容器错配。

首次过渡仍运行旧版本的停机实现，不能假定它已有新版本的原生排空能力；按批准的维护安排检查在途任务，避免用暂停应用、修改权限或真实数据状态来制造空闲。

## 阶段二：普通严格发布

前置版本稳定并成为真实JSON健康基线后，使用普通 `scripts/deploy-production.sh`：检查真实Git/current/previous和严格JSON基线，独立迁移，切换停机/Node24镜像，验证后原子记录state。失败恢复前置版本，其JSON健康可按相同标准验证。普通健康检查、发布和状态脚本没有旧text-ok回退。

新增控制文件不会改变66495c5的运行/迁移代码；最终发布提交须重新由CI按其实际完整SHA构建、测试和推送。回执中的66495c5用于绑定已验证的运行改动基线，发布前须再次确认相关运行/模型/迁移源码与该基线一致。

## 备份恢复回执

使用 `scripts/check-canvas-backup-receipt.py`（生产宿主已具备Python3）核验：私有普通文件、应用专属backups目录内的私有备份、实际SHA256、24小时内的验证时间、完整21表计数及验证结果。回执包含 `version/application/database/schema/postgres_major/baseline_sha/health_sha/lifecycle_sha/verified_at/snapshot_id/snapshot_row_counts/backup_path/backup_sha256/restore_verified/structure_verified/migration_verified/external_access_blocked`。只有真实验证完成后才能记录成功；不提供可直接拿来上线的虚假回执。

本地mock使用明确标记的合成文件，不含业务数据/真实凭证，不连接Docker服务或生产。40项测试覆盖固定旧契约、拒绝SPA/错格式/错SHA、缺失或脏Git元数据、备份证据失败、锁冲突、pull/up/revision/健康失败、信号中断、状态写失败、状态漂移、回滚失败、过渡重放、第二阶段成功和迁移失败回滚。完整脚本回归65项通过；实际镜像测试按TEST_IMAGE单独运行。
