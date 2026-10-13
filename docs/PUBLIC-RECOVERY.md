# 公网入口恢复手册（530 / 1033）

> 适用：`cloud.antifield.work` 经 Cloudflare Tunnel 访问工作台失败（HTTP 530 / error 1033）。  
> 关联：`docs/RESEARCH.md` §4、`scripts/probe-public.sh`、`scripts/cf-public-e2e.sh`、`scripts/wire-cloudflared.sh`。  
> 原则：**先分层定位，再动服务；SSH/局域网始终是保底通道。**

---

## 0. 症状与已知根因

| 症状 | 含义 |
|---|---|
| 浏览器 530 / 1033 | Cloudflare 边缘无法回源到 tunnel |
| `cloudflared` precheck `hard_fail=true` | tunnel 与边缘的出站（7844）或凭据异常 |
| 本地 `http://127.0.0.1:8787` 正常 | 仅公网入口故障，网关本体健康 |

**已记录根因（2026-10-12）**：上游网络阻断到 Cloudflare 边缘的 **7844 出站**；重启 `cloudflared` 无效；SSH 与局域网正常。该类问题不在本仓库修复范围，本手册用于恢复后验证与误判排除。

---

## 1. 分层检查（由内到外）

```bash
# 1) 网关本体
curl -fsS http://127.0.0.1:8787/api/v1/health
ss -lnt | grep -E ':(8787|4096)\b'

# 2) cloudflared 进程与日志
systemctl is-active cloudflared
journalctl -u cloudflared -n 50 --no-pager

# 3) tunnel 是否连上边缘（日志出现 connection registered / quic）
# 4) 公网
curl -sS -o /dev/null -w '%{http_code}\n' https://cloud.antifield.work/
# 或
bash /opt/piforge/scripts/cf-public-e2e.sh
```

判定：

| 结果 | 动作 |
|---|---|
| 1 失败 | 先修网关（`systemctl restart wb-gateway`，查 journal），与公网无关 |
| 1 通、2 inactive | `sudo systemctl start cloudflared`，再看步骤 3 |
| 2 active、日志反复 TLS/7844 超时 | **上游出站阻断** → 等网络恢复或换出口；勿反复重启 |
| 本地通、公网 530 | 同上，或检查 Cloudflare 侧 tunnel 状态/DNS CNAME |

---

## 2. 允许的动作（按顺序，每步后复测）

1. `sudo systemctl restart cloudflared`（**只做一次**；无效应停手并记日志）
2. 确认 `/etc/cloudflared/config.yml` ingress 仍指向 `http://127.0.0.1:8787`
3. 确认 DNS CNAME `cloud.antifield.work` → tunnel 域名未改
4. Cloudflare Zero Trust 控制台查看 tunnel 是否 “HEALTHY”
5. 网络恢复后执行 `cf-public-e2e.sh` + 登录工作台 + `/api/v1/console/system`

**禁止**：为修公网而开放 Pi 入站端口；把 OpenCode 4096 暴露出去；改 `wb-gateway` 监听地址到 `0.0.0.0`（违反红线 1）。

---

## 3. 恢复后验收

- [ ] `https://cloud.antifield.work/` 返回登录页（200）
- [ ] 密码登录进入工作台
- [ ] `GET /api/v1/console/system` 200
- [ ] `release-check` 红线（含安全头探测）通过
- [ ] HSTS：公网响应头含 `strict-transport-security`（Cloudflare 下发；缺失则在 CF SSL/TLS 开启 “Always Use HTTPS”）
- [ ] TASK-INDEX 备注更新：入口恢复时间与手段

---

## 4. 误判排除

- 530 ≠ 网关挂了：先看 `127.0.0.1:8787/health`
- 1033 ≠ DNS 必然错：tunnel 断线时也会报
- 重启 cloudflared **不能** 解决出站 7844 被墙
