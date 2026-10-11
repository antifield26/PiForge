# TASK-INDEX — 任务索引（唯一任务事实源）

> 规则：任务状态仅在本文件维护；完成任务后立即更新。状态：`pending` | `in-progress` | `done` | `blocked`。  
> 每个任务可在一次工作会话内完成，且验收标准含**实机验证**。

**状态汇总**（最后更新：2026-10-11）：P0 完成；**P1.1–P1.6 done**；P2 pending。

---

## 文档阶段（已完成）

| 编号 | 标题 | 里程碑 | 状态 | 验收标准 | 关联 |
|---|---|---|---|---|---|
| DOC-1 | 实机+源码调研 | Phase-1 | done | RESEARCH.md 数据均为实测/源码依据 | docs/RESEARCH.md |
| DOC-2 | 架构设计 | Phase-1 | done | 组件/接口/schema/安全/目录完整 | docs/ARCHITECTURE.md |
| DOC-3 | 里程碑规划 | Phase-1 | done | P0/P1/P2 含依赖与出口 | docs/ROADMAP.md |
| DOC-4 | 任务索引 | Phase-1 | done | 全量任务表可追踪 | 本文件 |
| DOC-5 | Agent 守则 | Phase-1 | done | 文档/任务/安全/命令速查 | AGENTS.md |
| DOC-6 | CHANGELOG | Phase-1 | done | 记录格式就绪 | CHANGELOG.md |
| DOC-7 | README | Phase-1 | done | 简介/架构/快速开始/索引 | README.md |

---

## P0 — 地基

| 编号 | 标题 | 里程碑 | 状态 | 验收标准（含实机验证） | 关联 |
|---|---|---|---|---|---|
| P0.1 | 项目骨架与配置 | P0 | done | `apps/web`、`packages/gateway`、`packages/shared` 可构建；`config/` 示例就位；systemd unit 草稿存在 | ARCHITECTURE §7-10 |
| P0.2 | SQLite wb.db + 认证 | P0 | done | 实机：登录/登出/会话 TTL；`PRAGMA journal_mode=WAL` 与 `synchronous=NORMAL` 生效；密码哈希非明文；无 Key 入库 | ARCHITECTURE §5-6 |
| P0.3 | OpenCode serve + 适配器 | P0 | done | 实机：`opencode serve --hostname 127.0.0.1` 运行；`GET /api/info` 通；SSE `/api/event` 可订阅；契约测试通过；RSS 写入 RESEARCH | RESEARCH §2；ARCHITECTURE §3.2 |
| P0.4 | Agent 任务流式进度 | P0 | done | 经网关下发真实编码任务并取回流式结果；时间线 UI；权限回复端点就位（ask 流待联调） | ARCHITECTURE §4.2 |
| P0.5 | 控制台只读监控 | P0 | done | 实机指标采集（temp/load/mem/sd）+ 5s 采样 / 5min 批量落盘 + ConsolePanel | RESEARCH §7；ARCHITECTURE §4.3 |
| P0.6 | systemd 白名单+审计 | P0 | done | 白名单外 403+审计；动作越权 403+审计；白名单内 status/restart 实机可执行 | RESEARCH §6；ARCHITECTURE §3.3 |
| P0.7 | 备份+恢复演练 | P0 | done | 本地备份+checksum+恢复演练通过；目标 `D:\PiBackUp`（backup-pull.ps1） | RESEARCH §5；ARCHITECTURE §4.4 |
| P0.8 | Cloudflare 入口+登录联调 | P0 | done | 实机部署 + cloudflared→8787；DNS CNAME 已建；外网 HTTPS login/console 200 | RESEARCH §4 |
| P0.9 | 写入减负核验 | P0 | done | WAL/批量/journald volatile/log2ram 核验；60s 写入 ~15KB/s；见 docs/WRITE-RELIEF.md | RESEARCH §3 |

**P0 出口综合验收**（全勾选才可宣布 P0 完成）：

- [x] 外网设备经密码登录工作台
- [x] 向 OpenCode Agent 下发真实编码任务并看到流式进度
- [x] 控制台实时显示温度/负载/SD 写入统计
- [x] 白名单外服务启停被拒
- [x] 备份成功且完成一次恢复演练

---

## P1 — 核心模块

| 编号 | 标题 | 里程碑 | 状态 | 验收标准 | 关联 |
|---|---|---|---|---|---|
| P1.1 | 待办+笔记 | P1 | done | CRUD/搜索/标签过滤；本地+实机 API 测试 8/8；WorkbenchPanel | ARCHITECTURE §3.1 |
| P1.2 | 书签+云盘 | P1 | done | 书签夹管理；文件上传/列表/下载（本地盘）；本地+实机 8/8 | ARCHITECTURE §5 |
| P1.3 | journald 日志+apt 提醒 | P1 | done | 白名单服务日志；越权 403；apt 可更新列表 | RESEARCH §7 |
| P1.4 | SD 寿命监控 | P1 | done | SD 型号/累计写入/日写入估算/寿命天数；OpsPanel | RESEARCH §3.1 |
| P1.5 | Agent 项目/会话浏览 | P1 | done | 会话列表（title/时间）；消息浏览已有 | ARCHITECTURE §3.2 |
| P1.6 | 备份告警 UI | P1 | done | 备份历史、手动触发、状态记录 | ARCHITECTURE §4.4 |

---

## P2 — 功能深化

| 编号 | 标题 | 里程碑 | 状态 | 验收标准 | 关联 |
|---|---|---|---|---|---|
| P2.1 | 权限细化 | P2 | pending | 按用户/单元策略；危险操作二次确认 | ARCHITECTURE §6.3 |
| P2.2 | 监控历史导出 | P2 | pending | 周/月聚合、CSV 导出、告警通道 | ARCHITECTURE §4.3 |
| P2.3 | 云盘增强 | P2 | pending | 缩略图、多版本、NAS 直存可选 | ARCHITECTURE §5 |
| P2.4 | 只读 PTY | P2 | pending | 可选终端只读；审计完整；默认关闭 | ARCHITECTURE §3.2 |
| P2.5 | 移动端适配 | P2 | pending | 触控布局可用；PWA manifest | — |
| P2.6 | 性能与内存报告 | P2 | pending | 空载 RSS/写入达标；报告入 docs | RESEARCH §8 |

---

## 状态流转规则（摘要）

1. `pending` → 开始工作 → `in-progress`（同会话内唯一）。
2. 完成并通过实机验收 → `done`，更新「最后更新」日期。
3. 受阻于外部（NAS、API 变更）→ `blocked`，在备注列写明原因；解除后回到 `pending`。
4. 范围外 → `abandoned`（备注写原因），不删除行。
5. 每次状态变更同步 CHANGELOG 一条简记。

---

## 备注列（动态）

| 编号 | 备注 |
|---|---|
| P0.3 | OpenCode 二进制路径待 install 后写入 deploy 文档 |
| P0.7 | NAS 地址/协议待用户提供；先本地演练 |
| P0.9 | 依赖 P0.5 的 metrics 缓冲实现 |
