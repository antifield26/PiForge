# AGENTS.md — Agent 工作守则

本项目部署在 Raspberry Pi 5（8GB）/ Debian 13 上，开发于本地仓库，部署经 SSH `antifield@169.254.77.10`。  
**目标**：个人工作台 + 树莓派控制台 + Agent 平台（集成 OpenCode v2）。

---

## 1. 文档维护规则

| 变更类型 | 必须更新 |
|---|---|
| 实测数据/兼容性/风险变化 | `docs/RESEARCH.md` |
| 组件、接口、schema、安全、目录结构 | `docs/ARCHITECTURE.md` |
| 里程碑、出口标准、预估 | `docs/ROADMAP.md` |
| 任务增删改、状态流转 | `docs/TASK-INDEX.md`（唯一任务事实源） |
| 任意交付变更 | `CHANGELOG.md` 一条 |
| 对外指引 | `README.md` |

**顺序**：调研与文档链完成前不写业务代码。文档与实现不一致时，以实机为准并回写文档。

---

## 2. 任务状态流转

1. 开始前：`docs/TASK-INDEX.md` 对应行改为 `in-progress`。
2. 完成后：实机验证通过 → `done`，并更新 CHANGELOG。
3. 受阻：`blocked` + 备注原因；不要留 `in-progress` 过夜。
4. 不删除任务行；范围外用 `abandoned`。
5. 一次会话只推进一个 `in-progress` 任务（子任务可并行探索）。

---

## 3. 代码与提交规范

- **技术栈**：Node 26 LTS + TypeScript + Fastify + SolidJS + Tailwind + SQLite。
- **布局**：`packages/gateway`（后端）、`apps/web`（前端）、`packages/shared`（类型）。
- **风格**：TypeScript strict；优先编辑现有文件；不写无意义注释；不提前抽象。
- **安全**：禁止在代码/日志/文档提交 API Key、密码、token 明文；示例用占位符。
- **OpenCode**：一切对 OpenCode 的调用 **必须** 经 `OpenCodeAdapter`；禁止业务代码直接 HTTP 到 OpenCode。
- **Git**：提交信息用祈使句说明「为什么」；用户明确要求才 commit/push。
- **验证**：完成任务必须含实机验证步骤；「本地跑通」不算完成。

---

## 4. 安全红线（违反即停止并记录）

1. **不开放任何入站端口**；公网仅 Cloudflare Tunnel。
2. **不将 systemd 白名单外的服务纳入控制**。
3. **不在代码/日志/文档写入 API Key**（含 OpenCode provider key）。
4. **改动存储配置前先确认备份链路可用**（备份成功 + 可恢复）。
5. **OpenCode server 只绑 localhost**，由网关代理，绝不直接暴露。
6. **OpenCode permission 默认 ask/deny**；工作区隔离。

发现红线被破坏：立即停止相关变更，在 TASK-INDEX 备注 + CHANGELOG 记录，并修复或回滚。

---

## 5. 构建 / 部署 / 回滚速查

### 本地构建与验证

`powershell
# 一键门禁（本地 verify + 同步部署 + 实机 e2e + 红线检查）
powershell -File scripts/release-check.ps1
`

```powershell
npm install

# 类型检查 / 构建（shared → gateway → web）
npm run build

# 全量验证：typecheck + node:test（28 项，含上传/版本/限速/白名单/metrics 写入纪律）
npm run verify
```

### 实机部署（SSH）

运行时安装在 **`/opt/piforge`**（root:root，服务用户只读）；`/home/antifield/piforge` 仅作为构建与同步源。

```powershell
# 1) 同步检出到 Pi（保留 Pi 上的 node_modules 与 data/）
rsync -az --delete --exclude node_modules --exclude .git --exclude opencode --exclude data `
  ./ antifield@169.254.77.10:/home/antifield/piforge/

# 2) 部署/迁移（幂等：建 piforge-gw / piforge-oc 用户、迁移 wb.db 与 OpenCode home、
#    安装 unit 与由 allowlist 生成的 sudoers、启用夜间备份、启动并自检）
ssh antifield@169.254.77.10 'bash ~/piforge/scripts/deploy-pi.sh'

# 3) 端到端实机验证（以 root 读取 /etc/piforge/gateway.env 登录；不打印任何密钥）
ssh antifield@169.254.77.10 'sudo node /opt/piforge/scripts/verify-e2e.mjs'

# 4) 状态
ssh antifield@169.254.77.10 'systemctl --no-pager status wb-gateway opencode-serve piforge-backup.timer'
```

### 备份与恢复

```powershell
# 手动完整备份（需 root：含 /etc/piforge 的密钥与 OpenCode 元数据）
ssh antifield@169.254.77.10 'sudo /opt/piforge/scripts/backup.sh'

# 夜间自动备份：piforge-backup.timer（每天 03:15，Persistent=true）
ssh antifield@169.254.77.10 'systemctl list-timers piforge-backup.timer; sudo ls -lat /var/lib/piforge/backups/piforge | head'

# 恢复演练（校验 SHA256SUMS + PRAGMA integrity_check + 核心表；任一失败即非零退出）
ssh antifield@169.254.77.10 'sudo /opt/piforge/scripts/restore-drill.sh'

# 拉取到 Windows D:\PiBackUp（Pi 侧先 sha256sum -c 校验，再逐个复核）
powershell -File scripts\backup-pull.ps1
```

备份位于 `/var/lib/piforge/backups/piforge`（0750，密钥 0600），默认保留 14 份（`KEEP` 可调）。控制台「手动备份」按钮以网关用户运行，读不到 OpenCode 密钥/元数据时该次运行会记为 `partial`（不完整），夜间 root 备份才是完整基线。

### 修改管理员 / OpenCode 密码

```powershell
# 改 ADMIN_PASSWORD（脚本不再接受命令行明文参数：会提示输入，或读取 PIFORGE_ADMIN_PASSWORD 环境变量）
ssh -t antifield@169.254.77.10 'bash /opt/piforge/scripts/set-admin-password.sh'

# 改了 /etc/piforge/opencode.env 里的 OPENCODE_PASSWORD 后
ssh antifield@169.254.77.10 'bash /opt/piforge/scripts/reload-secrets.sh'
```

**要点**：systemd 的 `EnvironmentFile=` 只在服务**启动**时读取。改完必须 `systemctl restart wb-gateway`（脚本会做）；密钥只存 `/etc/piforge/*.env`（0640），**不得**写进 `Environment=`（`systemctl show -p Environment` 对任何本地用户可见）、git、日志或命令行。

### 回滚

```powershell
# 恢复最近一次 unit 备份并重启（数据不会自动搬回：脚本会打印手动步骤）
ssh antifield@169.254.77.10 'bash /opt/piforge/scripts/rollback-pi.sh'
```

若需回到旧布局：按 `rollback-pi.sh` 打印的顺序执行，并在验证登录与 `/api/v1/console/system` 之后才删除 `$CONF` 与 `/var/lib/piforge`。schema 迁移失败时，从最近备份恢复 `wb.db` 再起服务。

---

## 6. 研究与 OpenCode 源码

- OpenCode 源码位于 `opencode/`（**不入 git**），用于调研与契约核对。
- 升级 OpenCode 二进制前：对照 `opencode/V2_HTTP_API_AUDIT.md` 稳定端点，跑适配器契约测试。

---

## 7. 实机验证清单（通用）

- [ ] SSH 可达；`systemctl is-active wb-gateway opencode-serve piforge-backup.timer` 全为 `active`
- [ ] `sudo node /opt/piforge/scripts/verify-e2e.mjs` 全绿（登录、控制台、3MB 上传与版本回滚、白名单 403、确认令牌、metrics 零写、SSE 心跳、工作区隔离）
- [ ] `sudo /opt/piforge/scripts/restore-drill.sh` 输出 PASS
- [ ] 外网经 Cloudflare + 密码登录成功
- [ ] `ss -lntp` 无新增入站端口（网关 8787 与 OpenCode 4096 仅绑 127.0.0.1）
- [ ] `systemctl show -p Environment wb-gateway opencode-serve` **不含任何密钥**；日志无 API Key 明文（`journalctl -u wb-gateway -u opencode-serve | grep -ciE 'sk-[A-Za-z0-9]|api[_-]?key'` 应为 0）
- [ ] `sudo -n -l -U piforge-oc` 无输出（Agent 用户无 sudo）；`sudo -n -l -U piforge-gw` 仅含白名单 systemctl 条目
- [ ] 相关任务在 TASK-INDEX 已更新
