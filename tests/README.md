# vc-dashboard collect 单元测试

> Playwright E2E 测试框架已于 2026-08 移除（含 17 个用例、浏览器内核安装、测试报告）。当前仅保留 collect 采集器单元测试（12 个用例）。

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
- 共 **12 个用例**，覆盖以下核心契约：

| 编号 | 用例 | 说明 |
|---|---|---|
| 1 | 值级脱敏：sk / Bearer / ghp_ / gho_ / xox* | 密钥样式 → `[REDACTED]` |
| 2 | 输入限长（>8MB 丢弃） | stdin 超 8MB 直接丢弃，恒 exit 0 |
| 3 | 正常事件原样透传 | hook 归一化，字段不被误删/误脱敏 |
| 4 | 字段名黑名单脱敏 | `api_key` / `private_key` / `access_key` / `aws_session_token` → `[REDACTED]` |
| 5 | PEM 整串脱敏 | 公私钥整块替换，不残留证书头/内容 |
| 6 | 截断：MAX_STR（码点安全） | 超长字符串按 250 字符截断，不切出孤立代理对 |
| 7 | 截断：DETAIL_CAP | 序列化 detail 超 2000 字符 → 追加截断标记 |
| 8 | 非法 JSON | 畸形输入恒 exit 0，stderr 记录解析失败 |
| 9 | 值级脱敏：AKIA | AWS Access Key ID → `[REDACTED]` |
| 10 | 值级脱敏：eyJ（JWT） | 裸 JWT（Base64url 头） → `[REDACTED]` |
| 11 | 值级脱敏：ghr_ | GitHub Refresh Token → `[REDACTED]` |
| 12 | 值级脱敏：ghu_ | GitHub Server-to-Server Token → `[REDACTED]` |

## 遗留说明
- `tests/cleanup.mjs` 保留用于清理历史 E2E 注入到 `data/events.jsonl` 的 `e2e-` 前缀行（原子替换，手动执行）。
- 历史 E2E 产物（`tests/reports/`）已随框架移除。
