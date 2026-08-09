# vc-dashboard collect 单元测试

> Playwright E2E 测试框架已于 2026-08 移除（含 17 个用例、浏览器内核安装、测试报告）。当前仅保留 collect 采集器单元测试。

## 运行说明

### 环境要求
| 项 | 要求 |
|---|---|
| Node.js | >= 18（本项目 v24 验证通过） |
| 服务/浏览器 | 无需（纯 Node，零依赖） |

### 运行命令
```bash
npm run test:unit             # collect 单元测试（无需启动服务/浏览器）
node tests/cleanup.mjs        # 手动清理 events.jsonl 中残留的 e2e- 测试事件行
```

`.github/workflows/ci.yml`：Node 20/22 矩阵 → `npm install` → `npm run test:unit`（无其它步骤）。

### 工作原理
- 通过 `child_process` 以 `--dry` 模式直接调用 `hooks/collect.mjs`（`node hooks/collect.mjs --dry < stdin`），不写 `events.jsonl`，无需启动看板服务。
- 断言采集器三个核心契约：

| 契约 | 说明 |
|---|---|
| 值级脱敏 | `detail` 中 `sk-*` / `Bearer` / `ghp_` / `gho_` / `xox*` 等密钥样式 → `[REDACTED]` |
| 输入限长 | stdin 超 8MB 直接丢弃本条事件，且恒 exit 0 |
| 原样透传 | 正常事件 hook 归一化后字段不被误删/误脱敏 |

## 遗留说明
- `tests/cleanup.mjs` 保留用于清理历史 E2E 注入到 `data/events.jsonl` 的 `e2e-` 前缀行（原子替换，手动执行）。
- 历史 E2E 产物（`tests/reports/`）已随框架移除。
