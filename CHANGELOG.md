# CHANGELOG

本项目所有变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)；版本号在 P0 首个可部署构建后启用。

## [Unreleased]


### Security

- 2026-10-13 路 **审计修复（Critical/High）**：`deploy-pi.sh` 同步 OpenCode 密码改为 0600 临时文件传递，不再经 `env KEY=value` 进 argv（此前 `/proc/*/cmdline` 与 `ps` 可见）；`backup-pull.ps1` 的含密钥 tar 从 `chmod 0644` 改为 `chown` 给 SSH 用户 + `0600`；`.gitignore` 补 `*.env` / `service.json` / `credentials.json` / `data/`。
- 2026-10-13 路 **红线 4 门禁**：`deploy-pi.sh` 迁移 `wb.db`/`cloud` 前强制生成 safety backup（sha256 + `PRAGMA integrity_check`），任一失败即拒绝迁移；sudoers 生成失败改为 die（不再回退可能过期的静态模板）；健康检查通过后自动 shred 检出目录遗留的 `gateway.env`。
- 2026-10-13 路 confirm 令牌改为一次性（jti 消费，防 60s 内重放）；服务控制失败返回 502 `SERVICE_CONTROL_FAILED`（不再假 200）；登录/confirmToken 非字符串输入归一为 400；OpenCode/日志上游错误详情只记服务端日志，客户端收稳定文案。
- 2026-10-13 路 重资源端点（journalctl/apt/backup run/agent prompt）加认证后按用户限速；LIKE 搜索转义 `%`/`_`；云文件覆盖写改为 tmp+rename 原子写；SSE 响应补安全头；`/` 不再回显 `webDist` 绝对路径；metrics 导出上限 20 万 → 10 万。

### Fixed

- 2026-10-13 路 单测不再真实执行 `sudo systemctl`（`setServiceExec` 注入）；新增 CSRF Origin、类型混淆、confirm 重放、服务失败 502 等 6 项测试（`npm test` 34/34）。
- 2026-10-13 路 `shared` 类型与 gateway 对齐（`AuditEntry`/`BackupRun`/`CloudFile`/`MAX_UPLOAD_BYTES`）；登录框默认用户名清空；SSE `onerror` 不再把 ErrorEvent 当 MessageEvent。
- 2026-10-13 路 `deploy-pi.sh` 改密指引改为交互/环境变量（不再提示 argv）；`gen-sudoers.mjs` 错误文案与 unit 字符集一致；`legacy/cf-dns-retry.sh` 不再打印 cert.pem 片段；`wire-cloudflared.sh` 标注 Minecraft 公网入口为有意暴露。

### Changed

- 2026-10-13 路 文档回写：README 备份目标/部署命令/文档索引；RESEARCH 服务用户、TS 版本、WAL/批量落盘状态、NAS 表述与遗留缺口。


### Added

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

- 2026-10-12 · `config/gateway.example.toml`（配置只读 env，文件为死配置）。
- 2026-10-12 · `agent_tasks` 表（建表后从未读写；启动时若为空自动删除）、`walCheckpoint` 死代码。
- 2026-10-12 · 6 个重复的 Cloudflare/DNS 一次性脚本迁入 `scripts/legacy/`（含 README 说明），canonical 路径为 `cf-api-dns.sh` + `cf-api-dns.mjs`。

### Notes

- 2026-10-12 · 本日为评估后的一次性全量修复：本地 `npm run verify`（typecheck + 28 项测试）全绿；实机 `scripts/verify-e2e.mjs` 39/39 全绿；迁移后备份 OK 且恢复演练 PASS；服务控制经生成 sudoers 实测可重启白名单单元。按用户要求，评估报告未落地为独立文档，仅记入本 CHANGELOG。
- 2026-10-11 · 业务代码自本日起开始（P0.1 起每个任务均有对应提交）。
