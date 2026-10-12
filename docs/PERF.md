# P2.6 性能与内存报告

> 2026-10-12 实机 RPI5 重新测量 · 对照 RESEARCH §8 预算
> 注（2026-10-12）：下表已按 FIX-3 部署后的实机重新测量。同日的审计快照为 gateway 169 MB /
> opencode 253 MB（gateway 进程已连续运行 3 小时以上），下表为网关重启后稳定态。
> 「SD 累计写入」用跨重启持久化统计（`settings.sd_write_accum` + `/proc/diskstats`），不再随重启归零；
> 该值自本次修正起从已知零点开始累积，因此只是**本基线之后**的写入量，不是 SD 卡出厂以来的总量。

| 指标 | 实测 | 预算 | 状态 |
|---|---|---|---|
| wb-gateway RSS（重启后稳定态） | **78 MB** | ≤300 MB | 达标 |
| wb-gateway RSS（连续运行 3h+ 后） | 169 MB | ≤300 MB | 达标（有缓慢增长） |
| wb-gateway heap | — | — | 由 `/console/perf` 实时给出 |
| opencode serve RSS | **254 MB** | ≤1000 MB | 达标 |
| 系统内存占用 | 约 3.2 / 8.0 GB | — | 余量约 4.8 GB |
| CPU 温度 | 47.2 °C | — | 正常 |
| 负载 1m | 0.03 | — | 空闲 |
| SD 型号 | SR64G（date=04/2024，`life_time` 不可读） | — | 寿命不可观测 |
| SD 日写入 | 约 **2.9–3.2 GB/日**（设备级，含 Minecraft/nginx） | ≤1.5 GB/日 | **超预算**，见下 |
| 运行时长 | 11h 42m（本次开机） | — | — |

## 结论

1. 工作台 + OpenCode 合计 RSS 约 **332 MB**（重启后）/ 422 MB（长跑后），远低于 8GB 内存预算；与 Minecraft（约 2.3 GB）共存仍有充足余量。
2. **SD 日写入超预算约 2 倍**：该计数是设备级的（含 Minecraft、nginx、日志），不能全部归因 PiForge；若要定位归属需按进程分别采样。
3. 实时数据接口：`GET /api/v1/console/perf`（同时返回 `gatewayRssMb`、`openCodeRssMb`、温度、负载与目标值）。

## 查看方式

登录后请求 `/api/v1/console/perf`。
