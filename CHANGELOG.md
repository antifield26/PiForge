# CHANGELOG

本项目所有变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)；版本号在 P0 首个可部署构建后启用。

## [Unreleased]

### Added

- 2026-10-11 · P2.3/P2.5/P2.6：云盘同名覆盖多版本；PWA manifest + icon；`/console/perf` 与 docs/PERF.md（gateway 99MB / opencode 140MB）。P2.4 只读 PTY 暂不启用。
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

### Notes

- 业务代码尚未开始；遵循「文档先行」约束。
