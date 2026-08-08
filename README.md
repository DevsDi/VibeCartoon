# Vibe Agent Dashboard

Claude Code Agent 活动可视化看板。通过 Claude Code hooks 采集 Agent 事件，实时展示主会话与各子 Agent 的工作进度、状态变化与任务交接过程（含火柴人动画与催办提醒），纯本地运行，无外部依赖。

## 功能特性

- **两栏看板布局**：左侧为「主 Agent」区，右侧为「子 Agent」区。底层是 3 列 CSS Grid（主栏 `380px` + 中间火柴人跑道 + 子栏 `380px`），整体水平居中（容器上限 1440px），随窗口宽度响应式收窄。
- **完整状态体系**：`queued`（排队中）/ `thinking`（思考中）/ `tool`（调用工具中）/ `asking`（等待输入）/ `done`（已完成）/ `failed`（失败），主 Agent（`main`）常驻左栏且不参与超时回收；任何 Agent 超过 `STALE_MS`（10 分钟）无事件即被服务端回收。
- **火柴人任务动画**：新子 Agent 出现或主 Agent 补充派发任务时，火柴人手持文件从主 Agent 卡片跑向子 Agent 卡片（toSub，😎）；子 Agent 完成/失败后火柴人跑回主 Agent 汇报（backToMain，done → 😄 带绿勾，failed → 😢 不带勾），并触发「收到 / 驳回」闪光与子卡挥手拜拜离场。首次渲染有 `stickmanSeeded` 守卫，页面刷新不会涌出一堆火柴人。
- **nudge 催办**：子 Agent 静默超过 5 分钟（`NUDGE_THRESHOLD_MS`）且仍在进行中时，一只红色 🤨 小人从卡片左侧跑过去，并在卡片右上角弹出「🤨 挑眉看你，快点！」气泡；同一子 Agent 催办冷却 5 分钟；`done` / `failed` / `asking` 状态不催办；`prefers-reduced-motion` 用户降级为只弹气泡。
- **任务名称解析**：`post_tool_use` 按 `tool_response.agentId` 精确配对子 Agent 名称；`pre_tool_use` 中主 Agent 调用 Agent 工具时登记 `pendingDispatch`（LIFO）作为待消费的任务描述；`subagent_start` 按「精确配对 → LIFO 派发描述 → 事件自带 prompt」三级优先级消费。主 Agent 恒显示「主 Agent」。
- **事件采集**：`hooks/collect.mjs` 从 stdin 接收 Claude Code hook JSON，归一化、脱敏、截断后追加到 `data/events.jsonl`，永不抛错、恒退出码 0。
- **零运行时依赖**：服务端为纯 Node ESM http server，前端为原生 JS + CSS，无框架、不连外网。

## 快速开始

### 环境要求

- **Node.js** >= 18（项目在 v24 上验证通过；服务端用到 ESM + 顶层 await）
- 浏览器（Chrome / Edge / Firefox 均可，仅访问看板用）

### 安装与启动

```bash
# 1. 安装依赖（当前仅 playwright 为 devDependency，用于 E2E 测试）
npm install

# 2. 启动看板服务
npm start
# 或：node server/server.mjs

# 3. 浏览器访问
http://localhost:8617
```

启动成功后服务端打印：`[vc-dashboard] server running at http://localhost:8617`。

服务启动时会定位事件文件末尾，**不重放历史事件**：重启后看板回到空状态，等新事件到达后重新开始展示。

## 如何接入 Claude Code hooks

看板的数据来源是 `data/events.jsonl`，由 `hooks/collect.mjs` 写入。采集器从 stdin 读取一条 hook 事件 JSON，将其归一化为一行事件记录追加到事件文件，支持以下 hook 类型：

| hook_event_name | 归一化类型 | 含义 |
|---|---|---|
| `SubagentStart` | `subagent_start` | 子 Agent 启动 |
| `SubagentStop` | `subagent_stop` | 子 Agent 结束（含成败） |
| `PreToolUse` | `pre_tool_use` | 调用工具前 |
| `PostToolUse` | `post_tool_use` | 调用工具后 |
| `Notification` | `notification` | 通知（如等待用户输入） |

每条事件保留字段：`ts`、`hook`、`agent`、`type`、`tool`、`status`、`detail`、`tok`。其中 `detail` 会做脱敏（字段名命中 `api_key`/`token`/`secret`/`password` 等黑名单整体替换为 `[REDACTED]`）与截断（普通字符串 250 字符、序列化后总长 2000 字符）。

可以直接用管道手工验证采集器：

```bash
echo '{"hook":"SubagentStart","subagent_id":"demo-1","agent_type":"general"}' | node hooks/collect.mjs            # 写入事件文件
echo '{"hook":"SubagentStart","subagent_id":"demo-1","agent_type":"general"}' | node hooks/collect.mjs --dry   # 只打印，不写文件
```

> 说明：本仓库只包含「采集器」与「看板」，不包含 Claude Code 侧的 hook 接线配置（如 `settings.json` 中的 hooks 规则）。接入方式为：在 Claude Code 侧配置 hooks，把上述事件通过管道交给 `node hooks/collect.mjs`，使事件落盘到 `data/events.jsonl`，看板即可实时展示。

## 配置说明

所有配置集中在 `config.mjs`：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8617` | 看板服务监听端口 |
| `STALE_MS` | `10 * 60 * 1000`（10 分钟） | Agent 超过该时长无任何事件 → 被回收（主 Agent `main` 豁免） |
| `MAX_BYTES` | `5 * 1024 * 1024`（5MB） | `events.jsonl` 超过该体积 → 轮转为 `.1` 并新建 |
| `EVENTS_FILE` | `<root>/data/events.jsonl` | 事件文件路径 |
| `COLLECT_LOG` | `<root>/data/collect.log` | 采集器异常日志路径 |
| `WEB_DIR` | `<root>/web` | 前端静态资源目录 |

## 目录结构

```
vc-dashboard/
├── config.mjs              # 配置：端口 / 超时 / 事件文件路径等
├── package.json
├── hooks/
│   └── collect.mjs         # 事件采集器：stdin 接收 hook → 脱敏/截断 → 追加到 events.jsonl
├── server/
│   └── server.mjs          # 无依赖 ESM http server：静态托管 + /api/* 接口 + 状态机聚合
├── web/
│   ├── index.html          # 看板页面结构（标题条 / 空状态 / 两栏看板）
│   ├── app.js              # 前端逻辑（600ms 轮询 / 卡片渲染 / 火柴人动画 / nudge 催办）
│   └── style.css           # 深色主题样式与全部 CSS 动画
├── data/                   # 运行期生成（.gitignore）
│   ├── events.jsonl        # 事件文件（超过 5MB 自动轮转）
│   └── collect.log         # 采集器异常日志
└── tests/                  # E2E 测试（详见 tests/README.md）
    ├── run.mjs             # 测试入口
    ├── cleanup.mjs         # 清理测试注入的 e2e- 事件行
    ├── helpers/
    │   ├── inject.mjs      # 事件注入助手（eventLine / injectEvents）
    │   └── board.mjs       # Playwright 看板封装与 DOM 断言
    └── cases/              # 各 E2E 用例
```

## API 说明

服务端仅接受 GET 请求，其他方法返回 `405`。

| 接口 | 用途 | 返回概要 |
|---|---|---|
| `GET /api/health` | 健康检查 | `{ ok: true, fileBytes }`（事件文件当前字节数） |
| `GET /api/state` | 看板聚合数据 | `{ updatedAt, agents: [...], summary: {...} }` |
| `GET /api/events` | 原始事件调试 | `{ events: [...], nextOffset }` |

- `/api/state`：采用「增量读」事件文件 + 状态机聚合。`agents` 为按开始时间升序的全部 Agent，每个 Agent 含 `id / type / name / status / currentTool / toolCount / startTime / endTime / lastSeen / history`（`history` 最多保留最近 6 条状态简记）；`summary` 统计 `total / active / done / queued / thinking / tool / failed / asking` 各档数量。文件被截断或轮转时偏移自动归零重读。
- `/api/events`：调试用，支持 `?since=<offset>` 从指定字节偏移读取原始事件，不推进 `/api/state` 的聚合偏移。

## 测试

E2E 测试通过向 `data/events.jsonl` 追加构造事件（格式与 `hooks/collect.mjs` 输出一致），驱动真实看板的前端渲染与动画，基于真实 DOM 断言。

```bash
# 先启动看板服务（测试前置条件）
npm start

# 运行全部用例（默认无头模式）
npm test

# 常用参数
npm test -- --headful           # 有头模式，可观察动画
npm test -- --only=01-失败       # 按用例名前缀过滤
npm test -- --keep-events       # 测试后不清理 events.jsonl 中的注入行
npm test -- --report=out.json   # 指定报告路径（默认 tests/reports/latest.json）
```

- **环境要求**：Node.js >= 18；浏览器优先使用系统 Edge / Chrome，也可设 `VC_TEST_BROWSER=chromium` 用 Playwright 自带内核（需先 `npx playwright install chromium`）。
- **测试工具**：
  - `tests/helpers/inject.mjs`：`eventLine()` 构造事件行、`injectEvents()` 按序追加到 `events.jsonl`；测试事件统一使用 `e2e-` 前缀的 agent id。
  - `tests/cleanup.mjs`：把 `events.jsonl` 中 `e2e-` 前缀的行过滤掉（原子替换），`npm test` 结束后默认自动执行；也可手动 `node tests/cleanup.mjs`。
- **注意事项**：测试运行期间看板会短暂出现 `e2e-` 卡片；服务端内存中的测试 Agent 无法通过删文件清除，由 `STALE_MS`（10 分钟）超时自动回收；请避免测试期间操作 Claude Code，以免真实事件干扰 main 相关断言。

更完整的测试说明见 `tests/README.md`。
