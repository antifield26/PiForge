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

### 本地构建

```powershell
# 安装依赖（示例，按实际 workspace 调整）
npm install

# 类型检查 / 构建
npm run -w @piforge/shared build
npm run -w @piforge/gateway build
npm run -w @piforge/web build
```

### 实机部署（SSH）

```powershell
ssh antifield@169.254.77.10
# 服务用户与目录（P0 后）
# sudo systemctl restart wb-gateway
# sudo systemctl restart opencode-serve
# systemctl --no-pager status wb-gateway opencode-serve
```

### 备份与恢复

```powershell
# 备份（P0.7 后）
ssh antifield@169.254.77.10 '~/piforge/scripts/backup.sh'

# 恢复演练
ssh antifield@169.254.77.10 '~/piforge/scripts/restore-drill.sh'
```

### 修改管理员 / OpenCode 密码

```powershell
# 改 ADMIN_PASSWORD 并重启、校验登录
ssh antifield@169.254.77.10 'bash /home/antifield/piforge/scripts/set-admin-password.sh "你的新密码"'

# 若改了 gateway.env 里的 OPENCODE_PASSWORD（或其它密钥）
ssh antifield@169.254.77.10 'bash /home/antifield/piforge/scripts/reload-secrets.sh'
```

**要点**：systemd 的 `EnvironmentFile=` 只在服务**启动**时读取。改完 `gateway.env` 必须 `systemctl restart wb-gateway`（脚本会做）；否则进程仍用旧密码。

### 回滚

1. `systemctl stop wb-gateway`
2. 切回上一版本目录/包（或 git 旧 tag 的构建产物）
3. `systemctl start wb-gateway`
4. 验证登录与 `/api/v1/console/system`
5. 若数据 schema 迁移：从最近备份恢复 wb.db 再起服务

---

## 6. 研究与 OpenCode 源码

- OpenCode 源码位于 `opencode/`（**不入 git**），用于调研与契约核对。
- 升级 OpenCode 二进制前：对照 `opencode/V2_HTTP_API_AUDIT.md` 稳定端点，跑适配器契约测试。

---

## 7. 实机验证清单（通用）

- [ ] SSH 可达，服务状态 `active`
- [ ] 外网经 Cloudflare + 密码登录成功
- [ ] 无新增入站监听端口（`ss -lntup` 核对）
- [ ] 日志无 API Key 明文
- [ ] 相关任务在 TASK-INDEX 已更新
