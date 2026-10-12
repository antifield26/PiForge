# TASK-INDEX — 任务索引（唯一任务事实源）

> 规则：任务状态仅在本文件维护；完成任务后立即更新。状态：`pending` | `in-progress` | `done` | `blocked`。  
> 每个任务可在一次工作会话内完成，且验收标准含**实机验证**。

**状态汇总**（最后更新：2026-10-12）：P0、P1 完成；P2.1–P2.3、P2.5–P2.6 done；P2.4 PTY 默认关闭/暂缓。
2026-10-12 完成一轮全量缺陷修复（FIX-1）；2026-10-13 完成审计问题全量修复（FIX-2）；P3 系列（告警闭环与控制面收口）已立项，部署布局迁移至 `/opt/piforge` + 双无 sudo 用户，全部实机验证通过。

---

## 维护阶段

| 编号 | 标题 | 里程碑 | 状态 | 验收标准（含实机验证） | 关联 |
|---|---|---|---|---|---|
| FIX-1 | 评估缺陷全量修复 | 维护 | done | 本地 `npm run verify` 28/28；实机 `verify-e2e.mjs` 39/39（含 3MB 上传、版本回滚、白名单 403、确认令牌、metrics 零写、SSE 心跳、工作区隔离）；迁移后备份 OK + 演练 PASS；`piforge-oc` 无 sudo、`systemctl show` 无密钥、4096/8787 仅回环 | CHANGELOG 2026-10-12 |
| FIX-2 | 审计问题全量修复 | 维护 | done | 本地 `npm run verify` 34/34；C1 密钥不进 argv；H1 备份 tar 0600；H2 迁移 safety backup 门禁；H3 gitignore 补齐；confirm 一次性；服务失败 502；CSRF/类型混淆测试 | CHANGELOG 2026-10-13 |

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
| P2.1 | 权限细化 | P2 | done | 危险操作 confirm token 二次确认；实机 nginx restart ok | ARCHITECTURE §6.3 |
| P2.2 | 监控历史导出 | P2 | done | summary + CSV 导出；实机 599 点 | ARCHITECTURE §4.3 |
| P2.3 | 云盘增强 | P2 | done | 同名覆盖保留历史版本；`/files/:id/versions` | ARCHITECTURE §5 |
| P2.4 | 只读 PTY | P2 | abandoned | 安全面大，默认不启用（用户可后续再开） | ARCHITECTURE §3.2 |
| P2.5 | 移动端适配 | P2 | done | viewport-fit + PWA manifest + icon；面板自适应 | — |
| P2.6 | 性能与内存报告 | P2 | done | gateway 99MB / opencode 140MB；docs/PERF.md | RESEARCH §8 |

---


## P3 — 告警闭环与控制面收口

| 编号 | 标题 | 里程碑 | 状态 | 验收标准 | 关联 |
|---|---|---|---|---|---|
| P3.1.1 | alerts 表 + 通知存储 | P3.1 | done | schema 迁移；空库可起 | ARCHITECTURE §5 |
| P3.1.2 | 规则检测器：备份/进程掉线 | P3.1 | done | 单测注入假事件生成通知 | — |
| P3.1.3 | 规则检测器：SD 写入/内存阈值 | P3.1 | done | 越界生成通知，可 resolve | — |
| P3.1.4 | 投递：工作台通知 + 可选 webhook | P3.1 | done | 失败重试一次并记日志 | — |
| P3.1.5 | 去重冷却 + 实机验证 | P3.1 | in-progress | 同 key N 分钟不重复；实机断 opencode 见通知 | — |
| P3.2.1 | 阈值写入 settings + 校验 | P3.2 | done | API 可读写；非法值拒绝 | — |
| P3.2.2 | alerts REST API | P3.2 | done | GET/POST/read；401；分页未读数 | ARCHITECTURE §9 |
| P3.2.3 | 前端通知铃铛 + 阈值编辑 | P3.2 | done | 未读角标；保存生效 | — |
| P3.2.4 | 测试 + 实机阈值触发 | P3.2 | in-progress | npm test 全绿 + 实机一条真实通知 | — |
| P3.3.1 | GET /auth/sessions | P3.3 | done | 仅自身会话；不回 token | — |
| P3.3.2 | 吊销单会话 + 全部登出 | P3.3 | done | 吊销后 cookie 失效；禁跨用户 | — |
| P3.3.3 | 会话列表 UI | P3.3 | done | 可见/可踢；当前会话标记 | — |
| P3.3.4 | 异常登录提示 + 测试 | P3.3 | done | 新 UA/IP 标志；越权测试过 | — |
| P3.4.1 | 审计查询 API（过滤/分页） | P3.4 | pending | 上限保护；参数校验 | — |
| P3.4.2 | login_audit 记录 | P3.4 | pending | 成功/失败 + IP + UA 摘要 | — |
| P3.4.3 | 审计页签 + CSV 导出 | P3.4 | pending | 导出限流；无越权 | — |
| P3.4.4 | 审计测试 | P3.4 | pending | 401/403/过滤/导出测试全绿 | — |
| P3.5.1 | docs/OPENCODE-UPGRADE.md | P3.5 | pending | 备份→升级→契约→回滚；版本对照模板 | AGENTS §6 |
| P3.5.2 | oc-contract 参数化 | P3.5 | pending | 一键可跑；失败非零 | — |
| P3.5.3 | 升级前快照脚本 | P3.5 | pending | 幂等；校验通过 | — |
| P3.5.4 | 升级演练记录 | P3.5 | pending | 桌面推演一次并记录差异 | — |
| P3.6.1 | release-check 脚本 | P3.6 | pending | 本地 verify + 干跑清单 | — |
| P3.6.2 | 远端门禁：deploy 后强制 e2e | P3.6 | pending | 失败非零退出 | — |
| P3.6.3 | AGENTS/README 命令序对齐 | P3.6 | pending | 可照抄执行 | AGENTS §5 |
| P3.7.1 | 备份 API：drill/连续失败 | P3.7 | pending | 与 backup_runs 对齐 | — |
| P3.7.2 | 备份卡片趋势 + drill 状态 | P3.7 | pending | 状态一眼可读 | — |
| P3.7.3 | 实机联动告警验证 | P3.7 | pending | 模拟失败进告警 | P3.1 |
| P3.A | P3 综合出口验收 | P3 | pending | 告警/会话/审计/Playbook/门禁/e2e 全绿 | 本系列 |

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
| P0.3 | OpenCode 二进制安装于 `/var/lib/piforge-oc/.opencode/bin/opencode`（实机 2.0.26） |
| P0.7 | 备份目标：Pi 本地 `/var/lib/piforge/backups/piforge`（每晚 03:15 定时）→ Windows `D:\PiBackUp`；NAS 仍未提供 |
| P0.9 | 依赖 P0.5 的 metrics 缓冲实现；2026-10-12 起保留期 30 天、`/system` 只读 |
| P0.4 | 权限审批 UI 于 2026-10-12 补齐（面板内允许/拒绝/始终允许） |
| P0.2 | 会话表每小时清理过期行；登录限速 IP+用户名 |
| FIX-1 | 未落地独立评估文档（按用户要求只记 CHANGELOG）；遗留：`antifield` 自身仍保留 NOPASSWD sudo（既有 SSH 即 root 的权衡，未改动） |
