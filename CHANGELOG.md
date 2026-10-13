# CHANGELOG

本项目所有变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)；版本号在 P0 首个可部署构建后启用。

## [Unreleased]

### Added

- 2026-10-13 路 **FIX-4 本地收尾（4.1–4.8）**：ARCHITECTURE 测试数 28→64；默认 `backupScript` 指向 `/opt/piforge/scripts/backup.sh`；`opencode-serve.service` / `gen-sudoers.mjs` 注释路径对齐 `/opt`；Agent `createSession`/`interrupt`/`permission reply` 写入 writeHeavy 20/min 限速；登录限速 username key 大小写归一；`notFound` 与 CSRF 同口径解码判定（`/%61pi/...` → JSON 404）；`publicMessage` 仅对 `BAD_REQUEST` 回显业务文案；`release-check.ps1` 增加 `npm audit` 门禁（`ALLOW_NPM_AUDIT=1` 可跳过）与仓库密钥模式扫描。回归 **68/68**，红线 **13/13**，密钥扫描 0 命中。
- 2026-10-13 路 **FIX-4.9 双账号脚手架**：`deploy/sudoers.d-piforge`（`PIFORGE_OPS` 受限 Cmnd_Alias，拒绝 NOPASSWD: ALL）+ `scripts/setup-ops-account.sh`（创建 `piforge`、staged visudo 安装、`--demote-antifield` 门禁与自救清单）。实机切换待 SSH 恢复后执行。
- 2026-10-13 路 **规划落地（文档）**：FIX-4 与 P4 立项（原 P4.1 权限收敛并入 FIX-4.9 双账号 `piforge`）；ARCHITECTURE ADR-9 与 §6.2 目标态；RESEARCH 撤销「接受 antifield NOPASSWD」终态表述。

### Security

- 2026-10-13 路 **FIX-4.4/4.5/4.7**：Agent 写操作限速防被盗会话刷上游；登录限速键折叠大小写；非业务错误不再回显 `err.message`。
- 2026-10-12 路 **FIX-3 审计发现全量修复**：① **CSRF 防线修复**——`app.ts` 的 Origin 校验原本用原始 `req.url.startsWith("/api/")` 判定，而路由按**解码后**路径匹配，`/%61pi/v1/todos`（含跨站 Origin）曾返回 201 并真实写入；现改为判定解码后的 pathname，解析失败按 API 处理。② **登录限速原子化**——`check → await verifyPassword → record` 之间可被并发插入，实测 40 个并发错误口令全部通过；现改为 `await` 之前 `consume()` 原子扣减，成功登录时归还用户名预算（IP 预算保留），并把限速表改为 LRU 淘汰，防止新键洪水重置被限速的桶。③ **并发同名上传**：`cloud_files` 增加 `UNIQUE(user_id, path)` 与 upsert 语义，8 个并发同名上传从 8 行降为 1 行（实机 6/6 → 1 行）。④ **版本裁剪顺序**：`ORDER BY created_at DESC` 在同毫秒并列时删掉的是**最新**版本，补 `rowid DESC` 作为确定序。⑤ **schema 版本化**：新增 `PRAGMA user_version` 与顺序迁移（v1 = 去重 + 唯一索引），`busy_timeout` 提到 `journal_mode` 之前，`dropUnusedTables` 改为 sqlite_master 判定 + 事务，消除 TOCTOU；迁移已在线上库副本上演练（行数不变、`integrity_check` ok）。⑥ **资源上限**：SSE 长连接加每用户 4 条/全局 64 条上限并补齐 hijack 响应的安全头；上传按用户限速且**先按 base64 长度**拒绝超限请求（此前解码后才校验）。⑦ **保留策略**：`login_audit`/`service_audit`/`alerts`/`backup_runs` 增加 180 天清理（`AUDIT_RETENTION_DAYS`），告警导出 CSV 增加公式注入转义。⑧ **单实例保护**：新增 `gateway.lock` pidfile，第二个实例拒绝启动——实机上曾有一个 `systemd-run` 遗留实例与主实例共用 wb.db 达 7 小时，使监控采样与 SD 写入翻倍，该实例已清除。⑨ **只读语义**：`/console/sd`、`/console/perf` 不再每 10 分钟写 `settings`，日写入速率改由 5 分钟 flush 计算并缓存在内存。
- 2026-10-12 路 **FIX-3 运维与供应链修复**：`release-check.ps1` 的红线检查原为 `A && B || echo 0`，退出码恒 0（端口新增/Environment 泄漏都被报 OK），现改为显式判定，并新增 `scripts/tests/release-check-redlines.ps1`（13/13）锁定四个失败分支；`deploy-pi.sh` 的 rsync 排除 `*.env` 并在 `chmod -R a+rX` 前断言运行时树内无 `.env`（此前首次迁移会把明文密钥留成 world-readable）；`backup-pull.ps1` 改用远端 `mktemp` 随机路径 + `umask 077` + `tar --no-dereference`，消除可预测路径与符号链接竞态；`backup.sh` 为每个归档写 `STATUS` 并纳入 SHA256SUMS，保留策略只淘汰**校验通过的 ok** 归档，`ALLOW_MISSING_DB=1` 不再记 `ok`；`restore-drill.sh` 支持 `--all`、默认拒收 PARTIAL、解包前强制 `sha256sum -c`；`gen-sudoers.mjs` 修复无 `--out` 时静默丢弃位置参数（导致"重生成再 diff"得到假一致）；`oc-snapshot.sh` 的 SHA256SUMS 不再自引用；`set-admin-password.sh` 不再调用已删除的 `reset-admin-pw.mjs`，旧密钥副本改 0600 且只留 2 份；`cf-public-e2e.sh`/`verify-deploy.sh` 增加显式 HTTP 状态断言；`docs/OPENCODE-UPGRADE.md` 移除把口令放进 `curl` argv 的示例并标注 `curl|bash` 风险；`rollback-pi.sh` 补齐 `.local/state/opencode` 与 `gateway.env` chown 指引；`deploy-pi.sh` 对遗留 `workbench` sudoers 旁路给出告警（`--prune-legacy` 显式启用）。
- 2026-10-12 路 **FIX-3 前端与文档回写**：告警面板的 60s 轮询定时器改在 `onCleanup` 中清理（Solid 会丢弃 `onMount` 的返回值，此前登出后仍在轮询）；登出与 401 时清除 `localStorage` 里记住的 Agent 会话；上传增加超时/取消并避免请求悬挂时永久禁用输入；Agent 会话切换的响应竞态与过期会话的 3s 重连风暴已处理；审计 CSV 导出改为挂载 anchor 并延迟回收 blob URL；标签过滤改为 SQL 侧（此前在 `LIMIT 200` 之后再过滤会漏掉旧笔记）；`README`/`AGENTS`/`PERF` 回写与实机不符的数字（测试 28/34 → 64 项、内存 99/140 MB → 实测值、删除不存在的 NAS 表述、快速开始重复编号）。
- 2026-10-12 路 **遗留实机事件（非仓库缺陷）**：公网入口 `cloud.antifield.work` 仍返回 530/1033，cloudflared precheck `hard_fail=true`。经用户授权 `systemctl restart cloudflared` **未恢复**——根因是上游网络阻断到 Cloudflare 边缘的 7844 出站，SSH 与局域网访问正常。`MemoryMax=1500M` 因内核 `cgroup_disable=memory` 在实机上不可执行，属平台限制（本次仅记录，未改内核参数）。

- 2026-10-13 路 **审计修复（Critical/High）**：`deploy-pi.sh` 同步 OpenCode 密码改为 0600 临时文件传递，不再经 `env KEY=value` 进 argv（此前 `/proc/*/cmdline` 与 `ps` 可见）；`backup-pull.ps1` 的含密钥 tar 从 `chmod 0644` 改为 `chown` 给 SSH 用户 + `0600`；`.gitignore` 补 `*.env` / `service.json` / `credentials.json` / `data/`。
- 2026-10-13 路 **红线 4 门禁**：`deploy-pi.sh` 迁移 `wb.db`/`cloud` 前强制生成 safety backup（sha256 + `PRAGMA integrity_check`），任一失败即拒绝迁移；sudoers 生成失败改为 die（不再回退可能过期的静态模板）；健康检查通过后自动 shred 检出目录遗留的 `gateway.env`。
- 2026-10-13 路 confirm 令牌改为一次性（jti 消费，防 60s 内重放）；服务控制失败返回 502 `SERVICE_CONTROL_FAILED`（不再假 200）；登录/confirmToken 非字符串输入归一为 400；OpenCode/日志上游错误详情只记服务端日志，客户端收稳定文案。
- 2026-10-13 路 重资源端点（journalctl/apt/backup run/agent prompt）加认证后按用户限速；LIKE 搜索转义 `%`/`_`；云文件覆盖写改为 tmp+rename 原子写；SSE 响应补安全头；`/` 不再回显 `webDist` 绝对路径；metrics 导出上限 20 万 → 10 万。

### Fixed

- 2026-10-12 路 **FIX-3 回归测试补强**：`npm test` 从 44 项增至 **64 项**。新增 `packages/gateway/test/regression.test.mjs`，专门覆盖此前"有代码、无断言"的语义——确认令牌 HMAC 签名与 unit/action/user 绑定（原 `unit.test.mjs:61-63` 在消费 jti 之后断言，无论绑定是否存在都返回 false，等于签名校验零覆盖）、登录限速的**并发**原子性与 IP/用户名双预算、限速表 LRU 淘汰、跨用户数据隔离（todos/notes/bookmarks/云盘四类资源的读取/修改/删除）、编码路径的 CSRF 拒绝、动作级白名单、并发同名上传单行化、版本裁剪保新弃旧、超限上传先拒后解码、metric 与审计表保留策略、只读端点不写 settings、SSE 每用户上限、单实例锁。新增 `scripts/tests/ops-semantics.sh`（22 项）、`scripts/tests/http-expect.sh`（8 项）与 `scripts/verify-fixes.mjs`（实机 14 项，纳入 AGENTS §7 清单）。
- 2026-10-13 路 单测不再真实执行 `sudo systemctl`（`setServiceExec` 注入）；新增 CSRF Origin、类型混淆、confirm 重放、服务失败 502 等 6 项测试（`npm test` 34/34）。
- 2026-10-13 路 `shared` 类型与 gateway 对齐（`AuditEntry`/`BackupRun`/`CloudFile`/`MAX_UPLOAD_BYTES`）；登录框默认用户名清空；SSE `onerror` 不再把 ErrorEvent 当 MessageEvent。
- 2026-10-13 路 `deploy-pi.sh` 改密指引改为交互/环境变量（不再提示 argv）；`gen-sudoers.mjs` 错误文案与 unit 字符集一致；`legacy/cf-dns-retry.sh` 不再打印 cert.pem 片段；`wire-cloudflared.sh` 标注 Minecraft 公网入口为有意暴露。

### Changed

- 2026-10-13 路 文档回写：README 备份目标/部署命令/文档索引；RESEARCH 服务用户、TS 版本、WAL/批量落盘状态、NAS 表述与遗留缺口。


### Added
- 2026-10-13 路 **P3.5–P3.7 落地**：docs/OPENCODE-UPGRADE.md 升级 Playbook + scripts/oc-snapshot.sh（实机快照 v2.0.26 成功）；scripts/release-check.ps1 发布门禁；restore-drill 写回 
estore_drill_* settings，备份 API/面板显示 lastStatus/连续失败/演练结果（实机 drill PASS 后 lastRestoreDrill.ok=true）。回归 erify-e2e 39/39，本地 44/44。
- 2026-10-13 路 **P3.4 审计检索**：service_audit 过滤（unit/action/allowed/时间）+ login_audit 列表；CSV 导出（引号转义、limit 5000）；前端审计页签（服务控制/登录）。实机 erify-p3-audit.mjs 6/6，回归 erify-e2e 39/39。
- 2026-10-13 路 **P3.1–P3.3 实机验收通过**：部署至 RPI5 后 erify-e2e 39/39；新增 scripts/verify-p3.mjs（阈值读写、三类告警触发与冷却、全部已读、会话吊销/登出其他）12/12；红线复查（4096/8787 仅 localhost、Environment 无密钥）通过。
- 2026-10-13 路 **P3.1–P3.3 开工落地**：lerts/login_audit 表；告警规则（备份失败/partial、服务掉线、SD 日写入、内存不足）+ 去重冷却 + 可选 webhook（ALERT_WEBHOOK_URL）；/console/alerts* API 与阈值配置；前端通知面板；会话列表/吊销/登出其他 + login_audit 记录。本地 
pm run verify 41/41。实机验证（P3.1.5/P3.2.4）待部署后 erify-e2e。

- 2026-10-12 · **测试与验证**：新增 `npm test`（`node:test`，28 项：认证/限速/错误契约/上传与版本/白名单与确认令牌/metrics 写入纪律/SD 计数折叠/SSE 帧映射/客户端 IP 信任）与 `npm run verify`（typecheck+test）；新增 `scripts/verify-e2e.mjs`（实机端到端验证：登录、控制台、上传 3MB、版本回滚、白名单 403、确认令牌、metrics 零写、SSE 心跳、工作区隔离）。
- 2026-10-12 · **夜间备份**：`deploy/piforge-backup.{service,timer}`（03:15，`Persistent=true`，root 执行，可读 `/etc/piforge` 与两个 `/var/lib` 状态目录）；`scripts/backup-record.mjs` 记录 `backup_runs`；`scripts/deploy-pi.sh` + `scripts/rollback-pi.sh`（幂等迁移与单元回滚）；`scripts/gen-sudoers.mjs` 由 allowlist 生成 sudoers；`scripts/lib/env.sh` 统一凭据读取（不 `source` dotenv、凭据不进 argv、临时文件 0600 且退出即清）。
- 2026-10-12 · **权限模型**：新增两个无 sudo 系统用户 `piforge-gw`（网关）与 `piforge-oc`（OpenCode/Agent）；网关运行于 `/opt/piforge`（root:root，服务用户只读，因 `/home/antifield` 为 0700）；`/etc/sudoers.d/piforge-gw` 由 `config/services.allowlist.json` 生成、`visudo -c` 校验后安装，仅含白名单单元的 start/stop/restart；`opencode-serve.service` 增加 `WorkingDirectory=/var/lib/piforge-oc/workspace`（此前为空 → 项目目录为 `/`）与显式 `permission: ask`（`deploy/opencode-config.json`）。
- 2026-10-12 · 2026-10-11 · P2.3/P2.5/P2.6：云盘同名覆盖多版本；PWA manifest + icon；`/console/perf` 与 docs/PERF.md（gateway 99MB / opencode 140MB）。P2.4 只读 PTY 暂不启用。
- 2026-10-11 · P2.1–P2.2：服务危险操作 confirm token 二次确认（ServicesPanel）；监控 summary/CSV 导出；sudo systemctl（移除 NoNewPrivileges）。
- 2026-10-11 · P1.3–P1.6：日志（白名单 unit + 越权 403）与 apt 更新提醒；SD 寿命估算；Agent 会话列表；备份历史/手动触发；LogsPanel + OpsPanel。
- 2026-10-11 · P1.2 书签+云盘：bookmarks 夹管理；cloud_files 本地存储（≤20MB base64 上传/下载/删除）；CloudPanel；本地+实机 8/8。
- 2026-10-11 · P1.1 待办+笔记：todos/notes CRUD、搜索、标签过滤、WorkbenchPanel；本地与实机 API 测试各 8/8。
- 2026-10-11 · **P0 完成**。P0.9 写入减负核验（docs/WRITE-RELIEF.md）：log2ram/journald volatile/WAL/批量落盘就位，60s 写入 ~15KB/s；DNS CNAME `cloud.antifield.work` 已建并外网 HTTPS 登录/console 200；备份 `D:\PiBackUp`。
- 2026-10-11 · P0.8 部署：`deploy-pi.sh` + systemd（User=antifield）；`opencode-serve` + `wb-gateway` 实机 active；console 实测 49.4°C；allowlist 403 审计；cloudflared ingress → `127.0.0.1:8787`。备份目标 `D:\PiBackUp`（`backup-pull.ps1`）已拉取一份并含 SHA256SUMS。
- 2026-10-11 · P0.7 备份与恢复演练：`scripts/backup.sh`（WAL-safe 快照 + config + OpenCode 元数据 + SHA256SUMS）；`restore-drill.sh` 校验并打开 wb.db；实机演练通过（users/sessions/audit 完整）。NAS 目标待用户提供。
- 2026-10-11 · P0.6 systemd 白名单+审计：`controlService` 校验 unit/action，越权 403；`service_audit` 全量记录；实机 `systemctl restart nginx` 成功；本地验证非白名单/越权拒绝。
- 2026-10-11 · P0.5 控制台只读监控：`/proc`+`vcgencmd` 采集（温度/负载/内存/SD 写入）；5s 采样、5min 批量写 `metrics_points`；`/system`/`/metrics`/`/sd`/`/services`；前端 ConsolePanel；Pi 实测 temp 47.7°C、write 68KB/s。
- 2026-10-11 · P0.4 Agent 任务流式：prompt 切换模型（`Model.Ref`）+ `{text}` 载荷；消息 content 解包；SSE 事件映射；前端 Agent 时间线面板；经网关下发编码任务并取回 `date +%F` 回复。
- 2026-10-11 · P0.3 OpenCode v2.0.26 实机安装与适配器：`opencode serve` 绑 127.0.0.1:4096；HTTP 适配器（info/session/prompt/messages/permissions/SSE）；契约测试 9/9；RSS 175–261MB 记入 RESEARCH。
- 2026-10-11 · P0.2 认证与 wb.db：`node:sqlite` 打开即 `WAL`+`synchronous=NORMAL`；scrypt 密码哈希（无明文）；登录/登出/`me` 与 httpOnly 会话 cookie（TTL 7 天）；实机（Pi）验证 journal_mode=wal、synchronous=1、哈希前缀 `scrypt$`、会话表可写。
- 2026-10-11 · P0.1 项目骨架：npm workspaces（`@piforge/shared` / `gateway` / `web`）、TypeScript、Fastify 网关占位路由、SolidJS+Tailwind 壳、`config/` 示例、`deploy/*.service` systemd 草稿；本地 `npm run build` 与 `/api/v1/health` 冒烟通过。
- 2026-10-11 · 完成第一阶段调研文档链：
  - `docs/RESEARCH.md` — 实机与 OpenCode v2 源码调研（Pi 5 实测、写入基线、API/权限/视觉 token、风险）
  - `docs/ARCHITECTURE.md` — 组件图、OpenCode 适配器 API、wb.db schema、安全模型、目录与 ADR
  - `docs/ROADMAP.md` — P0/P1/P2 里程碑、依赖顺序、出口标准与预估
  - `docs/TASK-INDEX.md` — 全量任务表（唯一任务事实源）
  - `AGENTS.md` — 文档维护、任务流转、安全红线、构建/部署/回滚速查
  - `README.md` — 项目简介、架构图、快速开始、文档索引
  - `CHANGELOG.md` — 本文件
- 2026-10-11 · OpenCode v2 源码拉取至 `opencode/`（不跟踪），版本 2.0.26
- 2026-10-11 · 实机基线记录：log2ram、journald volatile、tmpfs、Node 26.11.1、cloudflared 2026.8.1、SD 写入 ~15 KB/s（含 Minecraft）

### Fixed

- 2026-10-12 · 云盘上传：`POST /api/v1/files` 独立 `bodyLimit`（32MB，二进制 ≤20MB），前端改 8KB 分块 base64。此前 >~122KB 前端 `RangeError`、>~750KB 服务端 413，且失败无任何提示（实测 3MB 上传成功）。
- 2026-10-12 · 云盘多版本：覆盖前先把**旧内容**写入独立版本文件并记录其 `storage_key`，新增 `GET /files/:id/versions/:vid` 下载，删除文件级联清理版本与磁盘文件，单文件保留 10 份。此前版本文件写的是新内容、旧数据直接丢失（"保留历史版本"名不副实）。
- 2026-10-12 · 备份链：DB 缺失 → exit 2（不再静默成功）；WAL 安全快照（`sqlite3 .backup`，无 sqlite3 时 `node:sqlite VACUUM INTO`），不再复制活动 db/wal/shm；纳入 `/etc/piforge` 密钥与 OpenCode 元数据，权限 0750/0600，保留 14 份；读不到的部位标记 `partial` 并在控制台显示。
- 2026-10-12 · 恢复演练：校验 SHA256SUMS + `PRAGMA integrity_check` + 核心表，任一失败非零退出（此前只打印 OK）。
- 2026-10-12 · 登录限速（IP+用户名滑动窗口，429 + Retry-After）；会话每小时清理过期行；畸形 JSON 由 500 改 400；413/415/5xx 统一为 `{error:{code,message}}` 信封；生产缺密钥启动即失败；确认令牌绑定用户。
- 2026-10-12 · metrics：`GET /console/system` 不再写库（此前每次请求写 4 行，实测 3 次请求 0→12 行）；保留期 30 天自动清理；`sd_health` 每小时落一行；前端轮询在页面隐藏时暂停。
- 2026-10-12 · SD 累计写入：`/proc/diskstats` 计数器是「本次开机以来」，现持久化跨重启累计（实测 lifetime 507,900,928 B ≥ boot），寿命估算不再每次重启归零。
- 2026-10-12 · Agent SSE：`reply.hijack()` + 15s 心跳 + 无名 data 帧（前端 onmessage 可收）+ 单上游连接复用；补 `GET /agent/sessions/:id/permissions`、`POST .../interrupt`、`GET /agent/diff`、`/agent/projects`、`/agent/agents`。
- 2026-10-12 · 前端：权限审批按钮与会话选择器（刷新后可恢复待批准请求）；全局 401 回登录页 + 退出登录；统一 `api()` 与全量 try/catch；修复日志页不可见（`--pf-grey-200` 未定义）；`crypto.randomUUID` 降级；书签仅允许 http(s)；删除/手动备份加二次确认；`Promise.allSettled`；a11y 与溢出修复。
- 2026-10-12 · 校验与边界：todos.status 枚举、tags/长度/URL 校验；日志 `since`/`lines` 校验；CSV/JSON 导出限量；`bookmarks` 拒绝 `javascript:`。
- 2026-10-12 · `backup.sh` 旧布局 OpenCode 路径修正（`/home/antifield` 而非 `~/.opencode`，此前会误报 PARTIAL）；`deploy-pi.sh` bash `local a=1 b=$a` 展开陷阱修正（曾导致部署中断）；`gen-sudoers.mjs` 的 `Cmnd_Alias` 改为先定义后引用（sudoers 自上而下解析）。

### Changed

- 2026-10-12 · **部署布局**：运行时 `/opt/piforge`（root:root，服务用户只读，因 `/home/antifield` 为 0700）；状态 `/var/lib/piforge`（wb.db/cloud/backups）；配置密钥 `/etc/piforge`（0640）；Agent 家目录 `/var/lib/piforge-oc` + 工作区 `workspace/`。
- 2026-10-12 · `wb-gateway.service` 不再使用 `ConfigurationDirectory`（systemd 会递归 chown `/etc/piforge` 给服务用户），改为部署脚本创建 root:root 0755；新增 `UMask=0077`、`StateDirectoryMode=0750` 与 `ProtectSystem/ProtectHome/ProtectKernel*` 等加固。
- 2026-10-12 · OpenCode 密码从 systemd `Environment=` 迁移到 `EnvironmentFile`（此前 `systemctl show -p Environment` 任何本地用户可读）；`service.json` 与会话密码同步。
- 2026-10-12 · 文档回写：ARCHITECTURE（权限模型/schema/接口/unit）、README（备份与快速开始）、AGENTS §5/§7（部署与验证命令、密钥纪律）、TASK-INDEX（新增 FIX-1 与备注）、PERF/WRITE-RELIEF（标注历史数据与新语义）。

### Security

- 2026-10-12 · 网关与 Agent 拆分到两个**无 sudo** 系统用户；`/etc/sudoers.d/piforge-gw` 由 allowlist 生成并经 `visudo -f` 校验，只含白名单单元的 start/stop/restart。
- 2026-10-12 · Agent 工作区隔离：`WorkingDirectory=/var/lib/piforge-oc/workspace`（此前为空 → 项目目录为 `/`，即整机可读写）；`opencode.json` 显式 `permission: ask`。
- 2026-10-12 · 经 Cloudflare 的真实客户端 IP 仅在直连为回环时采信 `CF-Connecting-IP`，用于限速与审计（此前审计里全是 127.0.0.1）。
- 2026-10-12 · 凭据纪律：脚本不再 `source` dotenv、不再把密码放命令行、不再写 `/tmp` 明文；`set-admin-password.sh` 拒绝 argv 密码；`oc-probe.sh` 不再落盘 OpenCode 密码。
- 2026-10-12 · 修复 `/etc/sudoers.d/010_antifield-nopasswd` 权限 0644 → 0440（此前 `visudo -c` 全量校验失败）。
- 2026-10-12 · 遗留未改：`antifield` 仍保留 `NOPASSWD: ALL`（人类/运维登录，SSH 密钥即 root 的既有权衡）；运行时进程已不再以该用户执行。

### Removed

### Removed

- 2026-10-13 路 工作区整理：删除根目录遗留日志（err.log/out.log）与本地测试库 data/wb.db*；移除 25 个已被 
pm test / erify-e2e.mjs 覆盖或一次性调试脚本（test-*、debug-*、oc-probe 系列、reset-admin-pw 等）。保留部署/备份/回滚/密钥/契约测试与公网探测脚本共 20 个 + lib/。


- 2026-10-12 · `config/gateway.example.toml`（配置只读 env，文件为死配置）。
- 2026-10-12 · `agent_tasks` 表（建表后从未读写；启动时若为空自动删除）、`walCheckpoint` 死代码。
- 2026-10-12 · 6 个重复的 Cloudflare/DNS 一次性脚本迁入 `scripts/legacy/`（含 README 说明），canonical 路径为 `cf-api-dns.sh` + `cf-api-dns.mjs`。

### Notes


- 2026-10-13 路 **P3 立项**：新系列「告警闭环与控制面收口」写入 ROADMAP/TASK-INDEX（约 32 个 0.25d 子任务）。范围：告警采集与阈值面板、会话管理、审计检索、OpenCode 升级 Playbook、发布纪律、备份状态面板。明确不含 `antifield` NOPASSWD 收敛与只读 PTY（维持 abandoned）。

- 2026-10-12 · 本日为评估后的一次性全量修复：本地 `npm run verify`（typecheck + 28 项测试）全绿；实机 `scripts/verify-e2e.mjs` 39/39 全绿；迁移后备份 OK 且恢复演练 PASS；服务控制经生成 sudoers 实测可重启白名单单元。按用户要求，评估报告未落地为独立文档，仅记入本 CHANGELOG。
- 2026-10-11 · 业务代码自本日起开始（P0.1 起每个任务均有对应提交）。
