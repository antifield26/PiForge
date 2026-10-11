# RESEARCH — 实机调研报告

> 调研日期：2026-10-11 · 实机：Raspberry Pi 5 (8GB) / Debian 13 (trixie) · 访问：`antifield@169.254.77.10`
> 本文所有数据均为 SSH 实机实测或源码/官方文档查阅所得，未经验证的假设已标注为「待验证」。

---

## 1. 环境清单

| 项目 | 实测值 | 备注 |
|---|---|---|
| 主机名 | RPI5 | |
| 内核 | `6.18.50+rpt-rpi-2712` (aarch64) | Debian 内核 1:6.18.50-1+rpt1 |
| 发行版 | Debian GNU/Linux 13 (trixie) | `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"` |
| CPU | 4 核，Revision `d04170` | Pi 5 8GB；当前频率 2.4 GHz |
| 内存 | 总 7.9 GiB，可用约 4.8 GiB | 含 zram 2 GiB swap |
| 系统盘 | `/dev/mmcblk0p2` 59G ext4，已用 27G (48%) | 另有 `/boot/firmware` 512M vfat |
| 用户 | `antifield` (uid=1000)，组含 sudo/gpio/i2c/spi | `sudo` 为 **NOPASSWD: ALL** |
| 温度（空载） | 50.5 °C，`throttled=0x0` | 无过热降频 |
| 负载（空载） | load average 0.00 / 0.00 / 0.06 | 11h uptime |

### 1.1 运行中的关键服务

| 服务 | 状态 | 资源占用（RSS） | 说明 |
|---|---|---|---|
| `mc-server.service` | running | ~85 MB | Rust Minecraft 26.1.2 |
| `minecraft.service` | running | ~2.3 GB | PaperMC（`-Xms2G -Xmx4G`） |
| `frpc-minecraft.service` | running | ~23 MB | Sakura FRP 隧道 |
| `cloudflared.service` | running | ~39 MB | Cloudflare Tunnel |
| `nginx.service` | running | — | 1.26.3（`/usr/sbin/nginx`） |
| `ssh.service` | running | — | |
| 桌面环境 | labwc (Wayland) + pcmanfm | ~130 + 90 MB | Raspberry Pi 桌面 |
| `lightdm` / `wayvnc` / `fcitx5` 等 | running | 合计 ~200 MB | 显示与输入 |

> **内存现状**：Minecraft 常驻约 2.3–2.8 GB，桌面约 500 MB，系统缓存约 4 GB。留给工作台 + OpenCode 的可用内存约 **2–3 GB**（不含 cache 回收）。内存预算需按「与 Minecraft 共存」校准，而非空载 8 GB。

---

## 2. OpenCode v2 源码调研

源码已拉取至项目根目录 `opencode/`（`.gitignore` 不跟踪）。版本：**2.0.26**，仓库 `anomalyco/opencode`（原 `sst/opencode`）。

### 2.1 安装与 ARM64 可用性

| 安装方式 | 命令 | ARM64/Debian 13 可用性 |
|---|---|---|
| 官方脚本 | `curl -fsSL https://opencode.ai/v2/install \| bash` | ✅ 脚本支持 Linux arm64；安装到 `~/.opencode/bin` |
| npm | `npm install -g @opencode/cli` | ✅ postinstall 按平台选择原生二进制 |
| 独立二进制 | `opencode-linux-arm64.tar.gz` (v2.0.6+) | ✅ 官方提供 glibc ARM64 构建 |
| Desktop (.deb) | `opencode-desktop-linux-arm64.deb` | ✅ 官方提供，Electron 应用 |
| bun | `bun install -g --trust @opencode/cli` | ✅（Pi 上未装 bun，走 npm/二进制即可） |

**结论**：OpenCode v2 **无需源码编译**即可在 ARM64 Debian 13 上运行；提供 CLI + 可选 Desktop GUI。

### 2.2 运行时与 Node 兼容性

| 项 | 实测/源码值 | 影响 |
|---|---|---|
| 官方包管理器 | `packageManager: bun@1.4.2` | 开发构建用 Bun；**发布产物为原生二进制**，不依赖 Node 版本 |
| npm 包 | `@opencode/cli`，postinstall 下载平台二进制 | 仅需 Node 能跑 npm；实测 Pi 上 Node **v26.11.1** 可用 |
| TypeScript | 5.8.2 + `@typescript/native-preview` 7.0.0-dev | 仅构建期 |
| 工作台技术栈 | Node 26 LTS + TypeScript 7 | 与 OpenCode **无运行时耦合**（OpenCode 以独立进程 + HTTP API 接入） |

**结论**：**不需要双轨 Node 版本管理器**。OpenCode v2 发布形态是原生二进制（内部基于 Bun），工作台用系统 Node 26 即可，二者进程隔离、互不干扰。若后续要从源码构建 OpenCode，再引入 bun/版本管理器。

### 2.3 架构概览（源码）

```
opencode/
├── packages/
│   ├── server/      # Hono HTTP API（139 端点），auth/pairing/SSE/PTY
│   ├── core/        # 会话执行、工具、持久化（SQLite）
│   ├── protocol/    # OpenAPI / HttpApi 端点定义，生成客户端
│   ├── schema/      # 公共领域类型与事件负载
│   ├── sdk/         # JS/TS SDK（Promise + Effect 双风格）
│   ├── cli/         # 命令入口：serve / pair / run / session / models ...
│   ├── app/         # SolidJS Web/Desktop 共用界面
│   ├── desktop/     # Electron 壳（包 app）
│   ├── tui/         # 终端 UI
│   └── ui/          # 设计 token 与组件库
└── specs/v2/        # 行为规格（session/tools/event-stream/provider-policy）
```

- **权威边界**（`specs/v2/README.md`）：HTTP 合约 → `packages/protocol`；领域类型与事件 → `packages/schema`；运行时与持久化 → `packages/core`。
- **服务器启动**：`opencode serve`（可 `--hostname`/`--port`/`--service`/`--stdio`）；Web 访问用 `opencode pair`（生成临时 URL + 用户名/密码）。
- **认证模型**（`packages/server/src/auth.ts`）：
  - 用户名固定 `opencode`，密码可选（未设则无鉴权）；
  - 会话令牌 = `expires.HMAC(password)`，TTL 30 天，改密即吊销全部会话；
  - 配对码（pairing code）5 分钟 TTL，一次性消费，可换取会话；
  - Cookie 名带端口（`opencode_session_<port>`），避免本机多实例串扰。
- **事件流**（`specs/v2/event-stream-architecture.md`）：`GET /api/event` 单一 SSE 源，每连接独立 4096 帧有界队列，慢消费者只断开自己。

### 2.4 V2 HTTP API（适配器对接面）

源码 `V2_HTTP_API_AUDIT.md` 审计了 **139 个端点**（生成自 `packages/protocol/openapi.json`）。与本项目强相关的分组：

| 分组 | 代表端点 | 用途 |
|---|---|---|
| Foundation | `GET /api/info`, `/api/location`, `/api/project` | 服务状态、工作区定位 |
| Catalog | `GET /api/agent`, `/api/model`, `/api/provider`, `/api/config` | Agent/模型/配置浏览 |
| Session lifecycle | `POST /api/session`, `GET/DELETE /api/session/{id}`, `fork/switchAgent/switchModel` | 会话管理 |
| Execution | `POST /api/session/{id}/prompt`（流式）、`/interrupt`, `/compact`, `/diff`, `/context` | 下发任务与流式进度 |
| Permissions | `GET /api/permission/request`, `POST .../reply`, `session.permission.*` | 工具权限 ask/allow/deny |
| Filesystem | `GET /api/fs/read/*`, `/fs/list`, `/fs/find`, `/api/vcs/*` | 项目浏览、diff |
| Events | `GET /api/event` (SSE) | 实时进度 |
| PTY/Shell | `POST /api/pty`, `/api/shell` | 终端（P2 可选） |

**稳定性**：`/api/experimental/*` 为实验接口，适配器 **默认不依赖**；稳定接口以审计表 `Keep/Change` 结论为准。适配器只绑定稳定子集，隔离 v2 API 变动。

### 2.5 权限模型（与安全红线对齐）

- OpenCode 内建 permission 系统（`/api/permission/*` + session rules），支持 `ask` / `allow` / `deny`。
- Provider policy（`specs/v2/provider-policy.md`）：允许/拒绝模型提供商，Console 托管声明有最终权威。
- **本项目要求**：OpenCode permission 默认 `ask`/`deny`；工作区隔离；API Key 只存 OpenCode 本地配置，不经前端/网关日志。

### 2.6 视觉/用户交互（Desktop GUI 风格）

设计 token 见 `packages/ui/src/styles/tokens/`：

| 维度 | 规格 |
|---|---|
| 字体 | UI：Inter；代码：JetBrainsMono Nerd Font Mono / IBM Plex Mono |
| 色板 | Grey 50–1200 + Red/Orange/Yellow/Green/Cyan/Blue/Purple 色阶 |
| 强调色 | `--v2-blue-600` = `#3b5cf6` |
| 背景 | light：`bg-base=#fff`，`bg-deep=#fafafa`；dark 对称（grey-1200 基底） |
| 状态色 | success=green-800，warning=yellow-800，danger=red-800，info=blue-800 |
| Agent 色 | plan=粉、build=蓝、explore=黄、review=绿、writer=紫 |
| 层次 | elevation raised/floating/overlay + 细描边（alpha-dark 8–20） |
| 布局 | 面板式：侧栏 + 时间线 + 侧栏 presence/终端；圆角、轻阴影、紧凑密度 |

**本项目视觉约定**：Agent 平台模块封装 OpenCode Desktop GUI；个人工作台与树莓派控制台沿用同一 token 体系（蓝强调、灰阶层级、状态色、Inter+等宽代码字），保证三模块一体感。

---

## 3. SD 卡与写入减负

### 3.1 SD 卡基线

| 项 | 值 |
|---|---|
| 型号名 | `SR64G`（`/sys/block/mmcblk0/device/name`） |
| 厂商 ID | `manfid=0x000003` |
| 序列号 | `0x97ec95ac` |
| 容量 | 59.5G（mmcblk0） |
| 分区 | p1 512M `/boot/firmware`，p2 59G `/` ext4 `noatime` |

> 未读到 SMART/寿命计数（消费级 SD 无标准健康接口）。寿命监控方案：跟踪累计写入量 + 写入速率 + （可选）厂商工具；详见架构文档。

### 3.2 写入减负现状（已配置）

| 机制 | 状态 | 配置 |
|---|---|---|
| log2ram | **已启用** | `SIZE=128M`，`JOURNALD_AWARE=true`，`COMP_ALG=lz4`，`LOG_DISK_SIZE=256M` |
| journald | **volatile 已配置** | `/etc/systemd/journald.conf.d/10-workbench-volatile.conf`：`Storage=volatile`，`RuntimeMaxUse=64M` |
| /tmp | **tmpfs 4G** | `tmpfs on /tmp` |
| zram swap | **2G** | `zram0 [SWAP]` |
| SQLite 建议 | 待实施 | WAL + `synchronous=NORMAL`（工作台库） |
| 监控时序 | 待实施 | 内存聚合，5–10 分钟批量落盘 |

> 注：journald drop-in 文件头注释写有「生效：cp 到 /etc/systemd/journald.conf.d/」，但该目录下文件已存在；`journalctl --disk-usage` 显示 27.4M（含归档残留）。P0 需验证 `Storage=volatile` 确已生效（重启后日志不落盘）。

### 3.3 写入量实测（90 秒采样）

```
T0 mmcblk0p2 sectors_written = 6160168   (2026-10-11 20:14:25)
T1 mmcblk0p2 sectors_written = 6162800   (2026-10-11 20:15:55)
Δ = 2632 sectors = 1,347,584 B ≈ 1.28 MB / 90 s ≈ 15 KB/s
```

- **当前（含 Minecraft 双服务）典型负载写入 ≈ 15 KB/s ≈ 1.2 GB/天**。
- 空载（停 Minecraft）待补测；工作台自身写入预算目标：**≤ 500 MB/天**（监控批量落盘 + WAL）。
- uptime 11h 累计 p2 写入约 2.9 GB（`6160168` sectors），与上述速率一致。

---

## 4. 网络与访问

### 4.1 cloudflared

| 项 | 值 |
|---|---|
| 版本 | `cloudflared version 2026.8.1` |
| 配置 | `/etc/cloudflared/config.yml`，`tunnel run` |
| 服务 | `cloudflared.service` enabled + active（systemd） |
| 连接 | 多连接（http2），日志偶发 `TLS handshake ... i/o timeout` 后自动重试 |

**结论**：Cloudflare Tunnel 已就绪、systemd 托管稳定；公网入口唯一路径。**不开放 Pi 任何入站端口**。

### 4.2 本地网络

- `eth0` 链路本地邻居：`169.254.77.203`（另有本机 `169.254.77.10` 为 SSH 目标）。
- `wlan0` 网关：`172.23.88.1`。
- 双网卡在线；备份走 NAS 时需确认 NAS 在哪一侧可达（见 §5）。

### 4.3 工作台公网暴露模型（设计约束）

- 仅 Cloudflare Tunnel → 网关（Fastify）→ 内置密码登录；
- OpenCode server **只绑 localhost**，网关反代 `/api/opencode/*`；
- 零入站端口；systemd 白名单外服务不可控。

---

## 5. NAS 备份

| 项 | 状态 |
|---|---|
| `rsync` | 已安装 `/usr/bin/rsync` |
| `cifs-utils` | 已安装（SMB 客户端） |
| `nfs-common` | 已安装（NFS 客户端） |
| 当前挂载 | **无** NAS 挂载（`/etc/fstab` 仅有系统分区） |
| 邻居中的 NAS | **未发现明确 NAS 地址**（仅网关与链路本地邻居） |

**结论**：客户端能力齐备，但 **NAS 地址/协议/凭证待用户提供或发现**。备份链路（协议选择、挂载方式、晚间窗口、校验与恢复演练）在 P0 备份任务中实施；**在备份链路验证通过前，不动存储配置**（安全红线）。

**风险**：NAS 不可达或凭证缺失会阻塞「每晚备份」出口标准。缓解：P0 先做本地备份 + 校验脚本，NAS 接入作为独立任务；失败告警走工作台通知 + 日志。

---

## 6. systemd 控制面

| 机制 | 实测 |
|---|---|
| D-Bus | `busctl` 可用，`org.freedesktop.systemd1` 正常响应 `ListUnits` |
| polkit | `org.freedesktop.systemd1.manage-units` 默认 `auth_admin` / `auth_admin_keep` |
| sudo | `antifield` 具有 `(ALL) NOPASSWD: ALL` |
| polkit rules.d | 空（无自定义规则） |

**方案评估**：

1. **sudo + 白名单脚本（推荐 P0）**：网关以专用系统用户运行，仅允许 `systemctl start/stop/restart <白名单单元>`；用 sudoers 精确匹配命令（而非 NOPASSWD ALL——现有账户权限过宽，网关不应以 antifield 全权限运行）。
2. **polkit 自定义规则**：允许特定 user/group 对指定 unit 调 `manage-units`，无需 sudo；更细粒度，配置稍复杂。
3. **两者皆审计**：操作写入工作台库 `audit_log`（journald 为 volatile，持久审计不依赖 journald）。

**注意**：当前 `antifield` 是 NOPASSWD ALL，属于高权限桌面账户。P0 应创建 **专用服务用户**（如 `piwork`）运行网关与 OpenCode，避免整机沦陷面扩大。

---

## 7. 控制台数据源

| 指标 | 来源 | 实测 |
|---|---|---|
| CPU 负载 | `/proc/loadavg`、`/proc/stat` | 可用 |
| 内存 | `/proc/meminfo` | 可用 |
| 温度 | `vcgencmd measure_temp` | `50.5'C` |
| 频率 | `vcgencmd measure_clock arm/core` | arm 2.4GHz / core 910MHz（空载） |
| 降频 | `vcgencmd get_throttled` | `0x0`（正常） |
| 磁盘 IO | `/proc/diskstats`（mmcblk0） | 可用，字段含累计写扇区 |
| SD 型号 | `/sys/block/mmcblk0/device/*` | name/manfid/serial 可用 |
| systemd | D-Bus `ListUnits` / `systemctl` | 可用 |
| journald | `journalctl -u <unit>` | 可用（volatile，重启丢失） |

**结论**：控制台所需数据源全部可用，无需额外内核模块。温度/频率/降频走 `vcgencmd`；其余走 `/proc` 与 D-Bus。

---

## 8. 系统资源与内存预算校准

| 预算项 | 设计值 | 实测校准 |
|---|---|---|
| OpenCode 后端 | 0.5–1 GB | 待 P0 实测 `opencode serve` RSS（预计 <500MB 空载） |
| 工作台网关+前端 | ~300 MB | Fastify + Solid SSR/静态，目标 ≤300MB |
| LSP | 0.5–1 GB 按需 | 仅编码会话拉起 |
| tmpfs | ~500 MB | /tmp 已 4G 上限，需限制工作台子目录 |
| Minecraft | 2.3–2.8 GB（既有） | 不在本项目预算内，但挤占可用内存 |
| 系统+桌面 | ~0.5–1 GB | |
| **剩余可用** | | **约 2–3 GB**（Minecraft 运行时） |

**结论**：8GB 在共存 Minecraft 时偏紧。缓解：OpenCode 会话按需启停、LSP 空闲回收、监控数据内存聚合、工作台 SQLite 小而精。

---

## 9. 兼容性问题与对策

| # | 问题 | 对策 |
|---|---|---|
| 1 | OpenCode 源码构建依赖 Bun；Pi 未装 bun | 使用官方 ARM64 二进制 / npm `@opencode/cli`，不源码构建 |
| 2 | TS 7 / Node 26 仅约束工作台 | 工作台独立 Node 26；OpenCode 独立进程，无版本耦合 |
| 3 | Desktop Electron 包较大，ARM64 内存敏感 | Agent 模块通过 **网关代理 OpenCode Web/HTTP**，不必在 Pi 上跑 Electron；视觉沿用其 token |
| 4 | journald volatile 后审计易失 | 持久审计写工作台 SQLite + 每晚备份；不依赖 journald |
| 5 | SD 无健康接口 | 写入量+速率+日历寿命估算；告警阈值可配 |
| 6 | NAS 未就绪 | 先本地备份+校验；NAS 独立任务；失败告警 |
| 7 | cloudflared 偶发 TLS 超时 | 已自动重试；网关侧做健康检查与状态展示 |
| 8 | `antifield` NOPASSWD ALL | 网关/OpenCode 改用专用低权限用户；白名单 sudo/polkit |
| 9 | Minecraft 抢内存/IO | 内存预算按共存校准；监控写入与 OpenCode 会话限额 |

---

## 10. 风险清单（含缓解）

| 风险 | 等级 | 缓解 |
|---|---|---|
| SD 卡写入磨损导致数据丢失 | 高 | log2ram/journald volatile/WAL/批量落盘/tmpfs；每晚 NAS 备份+校验+恢复演练；写入监控告警 |
| 公网暴露面扩大 | 高 | 仅 Cloudflare Tunnel；零入站端口；密码登录+会话 TTL；OpenCode 只绑 localhost |
| OpenCode v2 API 变动破坏适配器 | 中 | 薄适配器唯一边界；只依赖稳定端点子集；版本锁定 + 契约测试 |
| 权限提升（白名单外服务） | 高 | 白名单制+审计；专用服务用户；默认拒绝 |
| 备份失败无感知 | 中 | 失败告警（工作台通知+日志）；恢复演练纳入 P0 出口 |
| 内存不足被 OOM | 中 | 预算监控；OpenCode 空闲回收；Minecraft 上限外不叠加重型服务 |
| API Key 泄露 | 高 | Key 仅存 OpenCode 本地配置；代码/日志/文档禁止出现；扫描钩子 |
| 双网卡 NAS 不可达 | 低 | 备份前探测；多协议回退（rsync/SSH → SMB） |

---

## 11. 待验证项（P0 内闭环）

1. `opencode serve` 在 ARM64 实机的 RSS 与 SSE 连通性（安装官方二进制后实测）。
2. journald `Storage=volatile` 重启后是否确实不落盘。
3. 空载（停 Minecraft）24h 写入量。
4. NAS 地址/协议/凭证（需用户或网络发现）。
5. OpenCode permission 在嵌入 Web 场景下 ask 流的交互路径。

---

## 12. 调研结论（可进入架构设计）

1. **OpenCode v2 可落地**：ARM64 二进制 + localhost HTTP/SSE API + 稳定端点子集，适配器模式成立。
2. **Node 双轨不必要**：OpenCode 与工作台进程/运行时隔离。
3. **写入减负基础已就位**：log2ram、journald volatile、tmpfs、zram；补 WAL+批量落盘+备份即可达标。
4. **公网安全路径清晰**：Cloudflare Tunnel + 密码登录 + localhost 暴露 OpenCode。
5. **主要缺口**：NAS 备份对接、专用服务用户、OpenCode 实机 RSS/SSE 实测、SD 空载写入基线。
6. **视觉**：完整 v2 token 可复用，三模块风格统一无障碍。
