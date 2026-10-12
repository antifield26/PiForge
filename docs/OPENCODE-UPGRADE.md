# OpenCode 升级 Playbook

> 适用：升级 `/var/lib/piforge-oc/.opencode/bin/opencode`（v2 原生二进制）。  
> 关联：AGENTS.md §6、`scripts/oc-contract.mjs`、`docs/RESEARCH.md` §2。  
> 原则：**先快照、再契约、后切换；失败可回滚。**

---

## 0. 何时必须走本流程

- 官方发布新的 OpenCode v2 版本，或当前 2.0.26 出现安全/兼容问题
- 计划改动 `packages/gateway/src/modules/agent/http-adapter.ts` 对接的端点
- 契约测试失败后的排查与再升级

**不要**在未跑契约测试的情况下把新版二进制直接推到 `opencode-serve.service`。

---

## 1. 升级前检查

```bash
# 1) 当前版本与状态
ssh antifield@169.254.77.10
systemctl is-active opencode-serve
# 口令不进 argv：`curl -u opencode:…` 对 ps 与 /proc/*/cmdline 可见。让 curl 从 stdin 读
# --config，口令只经过管道，源文件仍是 root-only 的 /etc/piforge/opencode.env。
sudo awk '/^OPENCODE_PASSWORD=/{sub(/^OPENCODE_PASSWORD=/,""); print "user = \"opencode:" $0 "\""}' \
  /etc/piforge/opencode.env | curl -sS --config - http://127.0.0.1:4096/api/info

# 2) 跑当前契约（必须先绿，否则先修再升）
sudo node /opt/piforge/scripts/oc-contract.mjs

# 3) 备份 OpenCode 元数据（幂等）
sudo bash /opt/piforge/scripts/backup.sh
sudo bash /opt/piforge/scripts/restore-drill.sh
```

退出标准：契约全绿 + restore-drill PASS（默认只验最新一份，`--all` 逐份验全部）。

---

## 2. 快照 OpenCode 状态

```bash
sudo bash /opt/piforge/scripts/oc-snapshot.sh
# 默认输出：/var/lib/piforge/backups/piforge/opencode-snap-<stamp>/
# 含：二进制版本字符串、~/.config/opencode、~/.local/share/opencode 元数据（不含模型缓存）
```

记录到本文件附录 A：旧版本号、时间、操作者、快照路径。

---

## 3. 安装新版本

二选一（ARM64 Debian 13 均支持，见 RESEARCH §2.1）：

```bash
# A. 官方脚本（装到当前用户 ~/.opencode/bin —— 对 piforge-oc 要求先切到该用户家目录）
#    ⚠️ `curl -fsSL <url> | bash` 没有任何校验：下载内容被篡改（CDN/中间人/上游被投毒）即等于
#    以 piforge-oc 身份直接执行任意代码。要用官方便捷脚本，至少先落盘、与官方公布的 SHA256
#    逐字节比对后再执行：
curl -fsSLo /tmp/opencode-install.sh https://opencode.ai/v2/install
sha256sum /tmp/opencode-install.sh        # 与官网发布页公布的校验值比对，不一致就停手
sudo -u piforge-oc -H bash /tmp/opencode-install.sh
rm -f /tmp/opencode-install.sh

# B. 发布包（推荐可控：版本可锁、内容可校验）
#   下载 opencode-linux-arm64.tar.gz 与官方 SHA256SUMS → `sha256sum -c` 通过 → 解压到
#   /var/lib/piforge-oc/.opencode/bin/（旧二进制先由 oc-snapshot.sh 留档，见 §5 回滚）
sudo systemctl stop opencode-serve
# …校验并替换二进制后
sudo chown -R piforge-oc:piforge-oc /var/lib/piforge-oc
sudo systemctl start opencode-serve
```

注意：`opencode-serve.service` 的 `ExecStart` 指向
`/var/lib/piforge-oc/.opencode/bin/opencode`，换路径必须同步改 unit。

---

## 4. 升级后契约测试（强制）

```bash
sudo systemctl is-active opencode-serve
sudo node /opt/piforge/scripts/oc-contract.mjs
# 预期：全部 ok，退出码 0
```

契约覆盖（`oc-contract.mjs`）：
- `GET /api/info` 版本与 capabilities
- `GET /api/location` 工作区仍在 `/var/lib/piforge-oc/workspace`
- 会话创建/列表/删除
- 未带凭据 401

额外人工确认：
1. 经工作台下发一条真实 prompt，SSE 时间线有输出
2. permission 弹窗（ask）仍出现且可批准/拒绝
3. `curl -s http://127.0.0.1:8787/api/v1/health` 与 `/api/v1/agent/info` 200

---

## 5. 失败回滚

```bash
sudo systemctl stop opencode-serve
# 从快照恢复二进制与配置
sudo cp -a /var/lib/piforge/backups/piforge/opencode-snap-<stamp>/bin/opencode \
  /var/lib/piforge-oc/.opencode/bin/opencode
sudo cp -a /var/lib/piforge/backups/piforge/opencode-snap-<stamp>/config/. \
  /var/lib/piforge-oc/.config/opencode/
sudo chown -R piforge-oc:piforge-oc /var/lib/piforge-oc
sudo systemctl start opencode-serve
sudo node /opt/piforge/scripts/oc-contract.mjs   # 必须再次全绿
```

工作台侧无需回滚：适配器只依赖稳定 HTTP 子集；若适配器也改过，一并
`git revert` 并重新 `deploy-pi.sh`。

---

## 6. 版本对照表（升级时填写）

| 日期 | 旧版本 | 新版本 | 契约 | prompt 实测 | permission | 快照路径 | 备注 |
|---|---|---|---|---|---|---|---|
| 2026-10-12 | 2.0.26 | 2.0.26 | — | — | — | — | 基线（P0.3/FIX-1） |
|  |  |  |  |  |  |  |  |

---

## 7. 相关文件

| 路径 | 用途 |
|---|---|
| `scripts/oc-contract.mjs` | 稳定端点契约测试 |
| `scripts/oc-snapshot.sh` | 升级前元数据/二进制快照 |
| `deploy/opencode-serve.service` | 服务单元（WorkingDirectory=workspace） |
| `deploy/opencode-config.json` | permission=ask 策略 |
| `opencode/V2_HTTP_API_AUDIT.md` | 端点 Keep/Change 审计（不入 git） |
