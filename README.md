# Vibe Agent Dashboard

Claude Code Agent 活动可视化看板。通过 Claude Code hooks 采集 Agent 事件，实时展示主会话与各子 Agent 的工作进度、状态变化与任务交接过程（含火柴人动画），纯本地运行，无外部依赖。

## 功能特性

- **两栏看板布局**：左侧为「主 Agent」区，右侧为「子 Agent」区。底层是 3 列 CSS Grid（主栏 `380px` + 中间火柴人跑道 + 子栏 `380px`），整体水平居中（容器上限 1440px），随窗口宽度响应式收窄。
- **完整状态体系**：`queued`（排队中）/ `thinking`（思考中）/ `tool`（调用工具中）/ `asking`（等待输入）/ `done`（已完成）/ `failed`（失败），主 Agent（`main`）常驻左栏且不参与超时回收；任何 Agent 超过 `STALE_MS`（10 分钟）无事件即被服务端回收。
- **火柴人任务动画**：新子 Agent 出现或主 Agent 补充派发任务时，火柴人手持文件从主 Agent 卡片跑向子 Agent 卡片（toSub，😎）；子 Agent 完成/失败后火柴人跑回主 Agent 汇报（backToMain，done → 😄 带绿勾，failed → 😢 不带勾），并触发「收到 / 驳回」闪光与子卡挥手拜拜离场。首次渲染有 `stickmanSeeded` 守卫，页面刷新不会涌出一堆火柴人。
- **任务名称解析**：`post_tool_use` 按 `tool_response.agentId` 精确配对子 Agent 名称；`pre_tool_use` 中主 Agent 调用 Agent 工具时登记 `pendingDispatch`（LIFO）作为待消费的任务描述；`subagent_start` 按「精确配对 → LIFO 派发描述 → 事件自带 prompt」三级优先级消费。主 Agent 恒显示「主 Agent」。
- **子 Agent 停止请求**：存活中的子 Agent（`queued`/`thinking`/`tool`/`asking`）卡片提供「⏹ 停止」按钮，点击向后端发出 `POST /api/agents/:id/stop`，按钮随即变为「⏹ 已停止」并灰化、卡片降饱和；服务端把请求原子追加到独立文件 `data/stop-signals.jsonl`，由外部（主会话）消费该文件执行真实中断。本仓库负责看板侧的「停止请求 + 状态标记」闭环；已 `done`/`failed` 或已离场的 Agent 不提供按钮，主 Agent（`main`）不支持停止。
- **完成提示音与无障碍播报**：子 Agent 完成/失败时播放短促提示音（完成→上升双音、失败→低沉单音），并写入 aria-live 播报区供屏幕阅读器感知。提示音受浏览器自动播放策略限制，需先点击页面任意位置一次即可启用（首次访问时页面顶部会显示「点击页面启用完成音效」轻提示，点击后自动消失）。
- **事件采集**：`hooks/collect.mjs` 从 stdin 接收 Claude Code hook JSON，归一化、脱敏、截断后追加到 `data/events.jsonl`，永不抛错、恒退出码 0。
- **零运行时依赖**：服务端为纯 Node ESM http server，前端为原生 JS + CSS，无框架、不连外网。

## 快速开始

### 环境要求

- **Node.js** >= 18（项目在 v24 上验证通过；服务端用到 ESM + 顶层 await）
- 浏览器（Chrome / Edge / Firefox 均可，仅访问看板用）

### 安装与启动

```bash
# 1. 安装依赖（当前无第三方依赖；playwright 已随 E2E 测试一并移除）
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

### Claude Code hooks 接线（settings.json 示例）

在 Claude Code 侧把采集事件接到采集器。`hooks/collect.mjs` 支持的全部 5 个 hook 事件（`SubagentStart` / `SubagentStop` / `PreToolUse` / `PostToolUse` / `Notification`）统一走 `command` 类型命令——事件 JSON 由 Claude Code 通过 stdin 管道交给采集器。把下面这段 JSON 放进 `hooks` 键即可（`.claude/settings.json` 为项目级，`~/.claude/settings.json` 为用户级）：

```json
{
  "hooks": {
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node \"D:\\workspace\\Vibe Cartoon\\vc-dashboard\\hooks\\collect.mjs\"" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node \"D:\\workspace\\Vibe Cartoon\\vc-dashboard\\hooks\\collect.mjs\"" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"D:\\workspace\\Vibe Cartoon\\vc-dashboard\\hooks\\collect.mjs\"" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"D:\\workspace\\Vibe Cartoon\\vc-dashboard\\hooks\\collect.mjs\"" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node \"D:\\workspace\\Vibe Cartoon\\vc-dashboard\\hooks\\collect.mjs\"" }] }
    ]
  }
}
```

> **command 路径写法**：
> - **推荐写绝对路径**（如示例）：把 `D:\workspace\Vibe Cartoon\vc-dashboard` 换成你仓库的实际路径。路径含空格（如 `Vibe Cartoon`）时 `"` 双引号必须保留（它是 `node` 的一个参数）；JSON 字符串里的 `\` 须写成 `\\`。
> - **或借用 `%cd%`（仅 Windows）**：`node "%cd%\hooks\collect.mjs"`。`%cd%` 由 shell 展开为当前工作目录——仅当 `.claude\settings.json` 位于仓库根目录、且你总在该目录启动 Claude Code 时有效；换目录启动时会写到别处。新手建议直接用绝对路径。
> - 五个事件可共用同一条 `command`：采集器按 `hook_event_name` 归一化（如 `SubagentStart` → `subagent_start`），无需为每个事件分别写命令。

### 接好后的冒烟验证

配置保存、服务重启后，先别急着跑真实任务——在仓库根目录手工注入一条事件，验证「采集 → 落盘 → 展示」链路已通（首次装机最常见的坑就是配置没生效或路径不对，导致看板永远空白）：

```bash
echo '{"hook":"SubagentStart","subagent_id":"demo","agent_type":"general"}' | node hooks/collect.mjs   # 追加一条事件
```

刷新 `http://localhost:8617`：约 0.6 秒后（前端 600ms 轮询）右栏应出现一张名为 `demo` 的子任务卡片（状态「⏳ 排队中」，并伴随火柴人跑向子 Agent 的派发动画）。这张 `demo` 卡片由 `STALE_MS`（10 分钟）超时自动回收，验证完无需手动清理。

### 手工验证采集器（不依赖配置）

不想动 Claude Code 配置时，也可用管道手工验证采集器：

```bash
echo '{"hook":"SubagentStart","subagent_id":"demo-1","agent_type":"general"}' | node hooks/collect.mjs            # 写入事件文件
echo '{"hook":"SubagentStart","subagent_id":"demo-1","agent_type":"general"}' | node hooks/collect.mjs --dry   # 只打印，不写文件
```

> 说明：本仓库只包含「采集器」与「看板」，真正的接线需在 Claude Code 侧配置 `hooks` 规则（见上方 settings.json 示例）——把上述事件通过管道交给 `node hooks/collect.mjs`，使事件落盘到 `data/events.jsonl`，看板即可实时展示。

## 配置说明

所有配置集中在 `config.mjs`：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8617` | 看板服务监听端口 |
| `HOST` | `127.0.0.1` | 服务监听地址（默认仅本机可访问）；需局域网/其它主机访问时用环境变量 `HOST` 覆盖（如 `HOST=0.0.0.0`） |
| `STALE_MS` | `10 * 60 * 1000`（10 分钟） | Agent 超过该时长无任何事件 → 被回收（主 Agent `main` 豁免） |
| `MAX_BYTES` | `10 * 1024 * 1024`（10MB） | `events.jsonl` 超过该体积 → 轮转为 `.1` 并新建 |
| `ALLOWED_ORIGIN` | `http://localhost:<PORT>` | CORS 允许来源，可通过同名环境变量覆盖 |
| `EVENTS_FILE` | `<root>/data/events.jsonl` | 事件文件路径 |
| `COLLECT_LOG` | `<root>/data/collect.log` | 采集器异常日志路径 |
| `WEB_DIR` | `<root>/web` | 前端静态资源目录 |
| `STOP_SIGNALS_FILE` | `<root>/data/stop-signals.jsonl` | 停止请求信号文件路径，可通过环境变量 `STOP_SIGNALS_FILE` 覆盖 |
| `STOP_REQUEST_TTL_MS` | `24 * 60 * 60 * 1000`（24 小时） | 停止信号条目保留时长，清理时移除超时未消费/未匹配的条目 |

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
│   ├── app.js              # 前端逻辑（600ms 轮询 / 卡片渲染 / 火柴人动画）
│   └── style.css           # 深色主题样式与全部 CSS 动画
├── data/                   # 运行期生成（.gitignore）
│   ├── events.jsonl        # 事件文件（超过 10MB 自动轮转）
│   ├── stop-signals.jsonl  # 停止请求信号（POST /api/agents/:id/stop 追加，外部主会话消费）
│   └── collect.log         # 采集器异常日志
└── tests/                  # collect 单元测试（详见 tests/README.md）
    ├── collect-unit.mjs    # 采集器单元测试（纯 Node 零依赖，npm run test:unit）
    └── cleanup.mjs         # 清理 events.jsonl 中残留的 e2e- 测试事件行
```

## API 说明

服务端提供只读 GET 接口（含 SSE 实时流 `GET /api/stream` 等），另开放 `POST /api/agents/:id/stop` 用于登记「停止子 Agent」请求；除该 POST 外的其他非 GET 方法仍返回 `405`。

| 接口 | 用途 | 返回概要 |
|---|---|---|
| `GET /api/health` | 健康检查 | `{ ok: true, fileBytes }`（事件文件当前字节数） |
| `GET /api/state` | 看板聚合数据 | `{ updatedAt, agents: [...], summary: {...} }` |
| `GET /api/stream` | SSE 实时事件流 | `text/event-stream`，持续推送新采集到的事件 |
| `GET /api/events` | 原始事件调试 | `{ events: [...], nextOffset }` |
| `POST /api/agents/:id/stop` | 登记停止子 Agent 请求 | `200 { ok: true, agent }` / `404`（不存在或已离场）/ `409`（已 `done`/`failed` 或主 Agent） |

- `/api/state`：采用「增量读」事件文件 + 状态机聚合。`agents` 为按开始时间升序的全部 Agent，每个 Agent 含 `id / type / name / status / currentTool / toolCount / startTime / endTime / lastSeen / history / stopRequested`（`history` 最多保留最近 6 条状态简记；`stopRequested` 为布尔，表示该 Agent 是否有未失效的停止请求信号）；`summary` 统计 `total / active / done / queued / thinking / tool / failed / asking` 各档数量。文件被截断或轮转时偏移自动归零重读。
- `/api/events`：调试用，支持 `?since=<offset>` 从指定字节偏移读取原始事件，不推进 `/api/state` 的聚合偏移。
- `/api/stream`：SSE 实时流（`text/event-stream`），服务端持续向订阅端推送新采集的事件，前端可据此即时刷新，弥补 600ms 轮询的延迟。
- `POST /api/agents/:id/stop`：校验 Agent 存在且处于存活态（非 `done`/`failed`/已离场），通过后原子追加一行 JSON 到独立文件 `data/stop-signals.jsonl`（**禁止写 `events.jsonl`**，避免与采集器并发冲突）。信号文件每行格式：`{"ts":"<ISO 时间>","agent":"<子 Agent id>","status":"requested"}`。真实中断由外部（主会话）消费该文件执行；服务端会周期清理「已不在 agents 中 / 已 `done`/`failed` / 超过 `STOP_REQUEST_TTL_MS`」的条目以保持文件小。

## 测试

当前仅保留 **collect 采集器单元测试**（纯 Node 零依赖，无需启动服务/浏览器）。Playwright E2E 测试框架（17 个用例）已移除。

```bash
# 运行 collect 单元测试（无需启动服务）
npm run test:unit

# 清理 events.jsonl 中残留的 e2e- 测试事件行（历史 E2E 遗留，需时手动执行）
node tests/cleanup.mjs
```

- **测试范围**：`tests/collect-unit.mjs` 直接以 `--dry` 模式通过 `child_process` 调用 `hooks/collect.mjs`（不写事件文件），断言三个契约：
  1. 值级脱敏（sk- / Bearer / ghp_ / gho_ / xox* 等密钥样式 → `[REDACTED]`）；
  2. 输入限长（stdin 超 8MB 直接丢弃且恒 exit 0）；
  3. 正常事件原样透传（hook 归一化，字段不误删/误脱敏）。

更完整的测试说明见 `tests/README.md`。
