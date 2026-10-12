# PiForge — Pi 5 个人工作台 + 树莓派控制台

在 Raspberry Pi 5（8GB）/ Debian 13 上运行的 Web 工作台：个人效率工具、主机运维控制台，以及集成 **OpenCode v2** 的 Agent 平台。公网访问仅经 Cloudflare Tunnel + 密码登录。

## 功能

| 模块 | 能力 |
|---|---|
| **个人工作台** | 待办、笔记、书签、云盘 |
| **树莓派控制台** | CPU/内存/温度监控、systemd 白名单启停、journald 日志、apt 更新提醒、SD 卡寿命 |
| **Agent 平台** | OpenCode 会话/任务/项目浏览，流式编码进度与权限审批 |

## 架构

```mermaid
flowchart LR
  U[浏览器] --> CF[Cloudflare Tunnel]
  CF --> GW[工作台网关 Fastify]
  GW --> ADPT[OpenCode 适配器]
  ADPT --> OC[opencode serve\n127.0.0.1]
  GW --> DB[(wb.db SQLite WAL)]
  GW --> HOST[vcgencmd / proc / systemd]
  GW --> BK[夜间备份 03:15]
```

- **工作台为主体，OpenCode 为子系统**：所有 OpenCode 调用经薄适配器，隔离 v2 API 变动。
- **零入站端口**；OpenCode 只绑 localhost，工作区隔离在自己的目录。
- **最小权限**：网关与 Agent 各跑在无 sudo 的系统用户下（`piforge-gw` / `piforge-oc`），systemd 控制由 allowlist 生成的 sudoers 规则限定。
- **SD 写入减负**：WAL、内存聚合批量落盘（30 天保留）、log2ram、journald volatile、tmpfs。

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 技术栈

Node.js 26 LTS · TypeScript · Fastify · SolidJS · Tailwind · SQLite · OpenCode v2（原生二进制）· systemd · Cloudflare Tunnel

## 快速开始

```powershell
# 1. 安装依赖并构建
npm install
npm run build

# 2. 同步到实机并部署（详见 AGENTS.md §5）
rsync -az --delete --exclude node_modules --exclude .git --exclude opencode --exclude data \
  ./ antifield@169.254.77.10:/home/antifield/piforge/
ssh antifield@169.254.77.10 'bash /home/antifield/piforge/scripts/deploy-pi.sh'

# 3. 实机端到端验证（另含 verify-fixes.mjs 覆盖 FIX-3 的修复项）
ssh antifield@169.254.77.10 'sudo node /opt/piforge/scripts/verify-e2e.mjs'
ssh antifield@169.254.77.10 'sudo node /opt/piforge/scripts/verify-fixes.mjs'

# 4. 访问
# 本地：http://127.0.0.1:8787
# 公网：经 Cloudflare Tunnel 映射的域名（当前入口不可用，见下）
```

备份：Pi 本地 `/var/lib/piforge/backups/piforge`（每晚 03:15）→ Windows `D:\PiBackUp`（`scripts/backup-pull.ps1`）。NAS 目标仍未提供，备份全部落在 Pi 本地盘。

阅读入口：`docs/RESEARCH.md`（实测调研）与 `docs/TASK-INDEX.md`（任务事实源）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/RESEARCH.md](docs/RESEARCH.md) | 实机与 OpenCode 调研报告 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、接口、schema、安全 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 里程碑 P0/P1/P2 |
| [docs/TASK-INDEX.md](docs/TASK-INDEX.md) | 任务索引（唯一事实源） |
| [AGENTS.md](AGENTS.md) | 开发/部署/安全守则 |
| [docs/PERF.md](docs/PERF.md) | P2.6 性能与内存报告 |
| [docs/WRITE-RELIEF.md](docs/WRITE-RELIEF.md) | P0.9 写入减负核验 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |

## 安全

- 公网仅 Cloudflare Tunnel + 内置密码登录
- systemd 白名单控制，操作全审计
- API Key 只存 OpenCode 本地配置，不经前端
- 备份至 Pi 本地盘并拉取到 Windows `D:\PiBackUp`，含 SHA256 校验与恢复演练（NAS 目标尚未提供）

## 许可

内部个人项目。
