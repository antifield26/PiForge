# P2.6 性能与内存报告

> 2026-10-11 实机 RPI5 · 对照 RESEARCH §8 预算

| 指标 | 实测 | 预算 | 状态 |
|---|---|---|---|
| wb-gateway RSS | **99 MB** | ≤300 MB | 达标 |
| wb-gateway heap | 13 MB | — | 正常 |
| opencode serve RSS | **140 MB** | ≤1000 MB | 达标 |
| 系统内存占用 | 3276 / 8058 MB | — | 余量约 4.7 GB |
| CPU 温度 | 46.6 °C | — | 正常 |
| 负载 1m | 0.01 | — | 空闲 |
| SD 型号 | SR64G | — | — |
| SD 累计写入 | 3.34 GB | — | — |

## 结论

1. 工作台 + OpenCode 合计 RSS 约 **240 MB**，远低于 8GB 内存预算。
2. 与 Minecraft（约 2.3 GB）共存仍有充足余量。
3. 实时数据接口：`GET /api/v1/console/perf`。

## 查看方式

登录后请求 `/api/v1/console/perf`，或后续接入 OpsPanel 展示。
