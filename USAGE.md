# Vibe Agent Dashboard 使用文档

本文档面向看板的使用者，介绍看板界面、状态与动画的含义，以及常见问题与调试方法。以「看板长什么样、每个元素在说什么」为线索，帮助你看懂 Claude Code 各 Agent 正在做什么。

前置：服务已启动（`npm start`），浏览器访问 `http://localhost:8617`。

## 一、看板界面说明

看板从上到下依次为：

1. **顶部标题条**：左侧是品牌名「Vibe Agent Dashboard」与副标题「Claude Code 各 Agent 工作进度」，右侧是「更新时间」（取最近一次 `/api/state` 的返回时间）。
2. **断连横幅**：前端每 600ms 轮询一次 `/api/state`。轮询失败时顶部出现红色横幅「连接断开，正在自动重连…」，恢复后自动隐藏。
3. **空状态占位**：当没有任何 Agent 事件时（例如服务刚启动、尚未接入 hooks），页面中央显示「暂无 Agent 活动」。
4. **看板主区**（核心）：
   - **左栏「主 Agent」**：展示主会话卡片，固定显示「主 Agent」，常驻不消失。
   - **右栏「子 Agent」**：一列多行，展示所有进行中的子 Agent 卡片；没有进行中的子 Agent 时显示「当前没有进行中的子 Agent」提示。
   - 两栏之间是「跑道」——火柴人往返跑动的空间。整体水平居中，窄屏时自动收窄。

### 单张 Agent 卡片包含

| 区域 | 内容 |
|---|---|
| 卡片头部 | 名称（子 Agent 显示任务描述，没有则回退到类型）+ 类型徽章（主 Agent 为「主」，子 Agent 为类型名）+「新任务」闪烁标记（新出现时） |
| 状态区 | 状态 emoji + 状态文案 + 该状态的专属动画元素（见下节） |
| 办公场景 | 卡片中央的坐姿小人 + 电脑 + 桌子（小人的表情和动作随状态变化） |
| 元信息行 | ⏱ 已用时长、🧰 工具调用次数 |
| 最近工具 | 最近调用的工具名胶囊（最多显示 3 条，超出内部滚动） |

## 二、状态与动画解读

### 2.1 状态一览

每个 Agent 在同一时刻只有一个状态。各状态在卡片上的表现：

| 状态 | emoji + 文案 | 卡片表现 |
|---|---|---|
| `queued` 排队中 | ⏳ 排队中 | 橙色呼吸脉动外发光；办公小人左右张望，场景整体变暗 |
| `thinking` 思考中 | 🔍 思考中 | 三点弹跳动画；小人偶尔歪头思考，电脑屏幕缓慢呼吸闪光 |
| `tool` 调用工具中 | 🛠️ 调用工具中 | 工具名胶囊 + 环形 spinner + 全宽进度条流光；小人双手快速敲键盘，屏幕快速闪烁 |
| `asking` 等待输入 | 💬 等待输入 | 黄色脉冲 + 请求气环；小人右手反复举起（示意要输入） |
| `done` 已完成 | ✅ 已完成 | 绿色勾号动画；小人变绿、举起右手庆祝、身体轻微上下浮动 |
| `failed` 失败 | ❌ 失败 | 红色 ✕ + 卡片抖动一次；小人变红、头低垂 |
| `idle` 待机中（仅主 Agent） | 😴 待机中 | 灰蓝色调、轻缓呼吸；小人打盹表情 |

> `idle` 是**前端为主 Agent 派生**的展示状态：主 Agent 最近 60 秒没有新事件、且当前不在「等待子 Agent 交回结果」时显示「待机中」。它只影响显示，不改服务端数据。

状态切换时卡片边框会脉冲闪一次，提示状态发生了变化。

### 2.2 火柴人动画

火柴人往返于主 Agent 卡片与子 Agent 卡片之间，表示「任务派发」与「任务交回」。首次打开页面不会播放（`stickmanSeeded` 首帧守卫），只在**之后**发生的新变化时播放。

**派发（toSub）**——主 Agent 派人送文件：

- 触发时机：新子 Agent 出现，或主 Agent 的 history 里新增 `Agent` / `SendMessage` 工具调用（补充派发任务）。
- 过程：戴墨镜的 😎 火柴人手持文件从主 Agent 卡片跑向子 Agent 卡片；到达时子 Agent 办公小人伸手接住文件、卡片闪黄光、右上角落下 📄 图标。
- 子 Agent 接到任务的瞬间就会「翻脸」成 😟（约 3.5 秒后恢复默认表情）。

**汇报（backToMain）**——子 Agent 跑回主 Agent 交结果：

- 触发时机：子 Agent 完成（`done`）或失败（`failed`）。
- 过程：子 Agent 办公小人拿起文件，火柴人（镜像翻转面向左）跑回主 Agent 卡片。
  - **完成**：火柴人 😄 + 带回绿色勾标，主 Agent 卡片亮绿色「收到」闪光，子卡先播庆祝粒子再挥手拜拜、淡出消失。
  - **失败**：火柴人 😢 不带绿勾，主 Agent 卡片亮红色「驳回」闪光，子卡红色失败视觉 + 抖动后挥手拜拜、淡出消失。

### 2.3 子 Agent 完成/失败后的离场

完成或失败的子 Agent 会从活动区「离场」：先挥手拜拜约 4 秒，再整体淡出约 3 秒，最后从页面移除。完成的子 Agent 挥手期间保持 😄 表情；失败的不庆祝、直接走失败视觉离场。

## 三、常见问题

**Q1：子 Agent 卡片为什么消失了？**
两种可能：(1) 该子 Agent 完成/失败，播放完「挥手拜拜 → 淡出」离场动画后从页面移除；(2) 该子 Agent 超过 10 分钟没有任何事件，被服务端按 `STALE_MS` 回收，前端随后播放离场动画将其移除。主 Agent 卡片常驻，不受超时回收影响。

**Q2：为什么主 Agent 恒显示「主 Agent」？**
这是前端的固定规则：主 Agent 卡片名称写死为「主 Agent」，不采用服务端可能误写的任务描述；子 Agent 名称才按「精确配对 → 最近派发描述 → 事件自带 prompt」的优先级解析。

**Q3：开启「减弱动态效果」会怎样？**
系统开启 `prefers-reduced-motion` 后：所有 CSS 动画（呼吸脉动、spinner、粒子、挥手等）被大幅缩短/禁用；火柴人动画不创建。功能（状态展示、卡片更新）不受影响。

**Q4：服务重启后看板为什么是空的？**
服务启动时会定位到事件文件末尾、不重放历史事件，看板回到空状态；新 hook 事件到达后自动开始展示。

## 四、调试

### 4.1 查看原始事件

接口 `GET /api/events` 返回事件文件的原始事件（已解析的 JSON），支持 `?since=<offset>` 从指定字节偏移读取：

```bash
curl "http://localhost:8617/api/events"                 # 从 0 读取全部
curl "http://localhost:8617/api/events?since=123456"    # 从偏移 123456 字节读取
```

事件文件 `data/events.jsonl` 每行一条归一化事件，字段为 `ts / hook / agent / type / tool / status / detail / tok`。

### 4.2 注入测试事件

手工验证时可把构造的 hook 事件通过管道交给 `hooks/collect.mjs`，它会按归一化格式追加到 `data/events.jsonl`（前端 600ms 轮询，追加后约 0.7 秒内可见）：

```bash
echo '{"hook":"SubagentStart","agent_id":"demo-1","agent_type":"general"}' | node hooks/collect.mjs
echo '{"hook":"PreToolUse","agent_id":"demo-1","tool":"Bash"}' | node hooks/collect.mjs
echo '{"hook":"SubagentStop","agent_id":"demo-1","status":"success"}' | node hooks/collect.mjs
```

> 测试事件请使用 `e2e-` 前缀的 agent id，便于 `tests/cleanup.mjs` 清理；服务端内存中的测试 Agent 只能等 `STALE_MS` 超时自动回收，删文件不会清除内存状态。

### 4.3 清理测试事件

`tests/cleanup.mjs` 会把 `data/events.jsonl` 中 `e2e-` 前缀的事件行过滤掉（原子替换）：

```bash
node tests/cleanup.mjs
```

> 重写文件后服务端检测到文件变小会自动归零偏移并重放剩余真实事件，状态可确定性重建。

### 4.4 采集器异常排查

`hooks/collect.mjs` 永不抛错、恒退出码 0；异常（JSON 解析失败、写文件失败等）会追加到 `data/collect.log`。若看板没有数据，可先查看该日志，并用 `--dry` 模式验证采集器输出是否符合预期：

```bash
echo '{"hook":"SubagentStart","subagent_id":"demo-1"}' | node hooks/collect.mjs --dry
```

### 4.5 状态机实现参考

服务端状态聚合位于 `server/server.mjs`：

- 事件类型与状态转换：`subagent_start` → `queued`；`pre_tool_use` → `tool`；`post_tool_use` → `thinking`；`notification`（含 `agent_needs_input`）→ `asking`；`subagent_stop` → `done` / `failed`（主会话 `main` 跳过，避免主卡被永久标为 ✅/❌）。
- 名称解析优先级：`post_tool_use` 按 `tool_response.agentId` 精确配对（最可靠）→ `pendingDispatch` 最近一次派发描述（LIFO）→ 事件自带 `detail.prompt`。
- 事件文件超过 10MB 自动轮转为 `.1` 并新建。
