# P0.9 写入减负核验报告

> 时间：2026-10-11T21:43+08:00 · 实机：RPI5 · 与 docs/RESEARCH.md §3 对照

## 1. 配置项核对

| 机制 | 状态 | 证据 |
|---|---|---|
| log2ram | **active** | `log2ram on /var/log type tmpfs` size=128M |
| journald volatile | **已配置** | `10-workbench-volatile.conf`：`Storage=volatile`，`RuntimeMaxUse=64M` |
| `/var/log/journal` | **空** | 无持久 journal 文件 |
| /tmp tmpfs | **4.0G** | `tmpfs on /tmp` |
| zram swap | 2G（先前实测） | `zram0 [SWAP]` |
| SQLite WAL | **wal** | `PRAGMA journal_mode=wal` |
| SQLite synchronous | **NORMAL（连接级）** | 网关打开时 `synchronous=NORMAL`；裸新连接默认 2(FULL) 无影响 |
| 监控批量落盘 | **已实现** | 5s 采样入内存，5min 批量写 `metrics_points`（2026-10-12 起 `/system` 只读、不再即时落一条） |
| 监控保留策略 | **已实现** | `metrics_points` 默认保留 30 天（`METRICS_RETENTION_DAYS`），每次 flush 清理；`sd_health` 每小时一行 |
| 备份 | **已演练** | `D:\PiBackUp` + SHA256SUMS + restore-drill 通过（2026-10-12 起校验更严格：integrity_check + 核心表，失败即非零退出） |

## 2. 写入量实测（60s 窗口）

```
delta_bytes = 950,272
dt = 60s
rate ≈ 15.8 KB/s
外推 ≈ 1.3 GB/天（含 Minecraft 双服务）
自启动累计 ≈ 3.28 GB / 12.8 h
```

- 与调研基线（~15 KB/s）一致。
- 工作台自身写入增量主要来自 `metrics_points`（当前 724 行，体积可忽略）与 `wb.db` WAL。
- **目标**：工作台日写入 ≤500MB；当前压力主要来自既有 Minecraft，非工作台。

## 3. 审计与指标表

| 表 | 行数 |
|---|---|
| metrics_points | 724 |
| service_audit | 1 |

## 4. 结论

1. 写入减负基础链路（log2ram / journald volatile / tmpfs / WAL / 批量落盘）**已就位**。
2. 当前典型写入 ~15 KB/s，可控；持续监控见控制台 `/metrics?kind=disk_write`。
3. 重启后 journald 不落盘以 `Storage=volatile` + 空 `/var/log/journal` 为准（配置层已核验）。
4. 恢复链路：`D:\PiBackUp` 已有校验备份；restore-drill 通过。

## 5. P0 出口对照

- [x] 外网设备经密码登录工作台（Cloudflare HTTPS 200 + login）
- [x] 向 OpenCode Agent 下发真实编码任务并看到流式进度
- [x] 控制台实时显示温度/负载/SD 写入统计
- [x] 白名单外服务启停被拒（403 + audit）
- [x] 备份成功且完成一次恢复演练（D:\PiBackUp）
