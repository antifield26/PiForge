# CHANGELOG

本项目所有变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)；版本号在 P0 首个可部署构建后启用。

## [Unreleased]

### Added

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
