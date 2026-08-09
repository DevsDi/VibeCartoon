// server/server.mjs — T2 本地服务与状态聚合
//
// Node 无依赖 ESM http server：
//   - 静态托管 web/（index.html、style.css、app.js 等）
//   - GET /api/health  → 健康检查 + 事件文件字节数
//   - GET /api/state   → 聚合看板数据（增量读事件文件 + 状态机）
//   - GET /api/events  → 原始事件增量调试
//
// 启动：npm start（即 node server/server.mjs）

import { createServer } from "node:http";
import { stat, open as openFile, readFile, rename, rm } from "node:fs/promises";
import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { PORT, HOST, MAX_BYTES, EVENTS_FILE, WEB_DIR, STALE_MS, ALLOWED_ORIGINS, STOP_SIGNALS_FILE, STOP_REQUEST_TTL_MS } from "../config.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// ---------------------------------------------------------------------------
// 事件文件通用区间读取：从 offset 开始读取到文件末尾，返回行数组
// 文件不存在或 offset 超出范围时返回空数组；文件被截断时自动回退到 0。
// 实现要点（轮转竞态安全）：打开句柄后用 fh.stat() 取文件尺寸，而非"先 stat 路径再 open"——
// 避免 stat 与 open 之间目标文件被轮转改名（旧路径已消失/新文件尺寸不同）导致的尺寸错配。
// 此时打开的是旧 inode（已改名为 .1 的原文件），读到的是该文件真实内容，不丢行。
// ---------------------------------------------------------------------------
async function readFileRange(filePath, offset, maxSize = Infinity) {
  let fh;
  try {
    fh = await openFile(filePath, "r");
  } catch {
    // 文件瞬时缺失（可能正处于轮转改名窗口或尚未创建）：视为截断/缺失，由调用方复位重试
    return { lines: [], size: 0, truncated: true };
  }
  try {
    const size = (await fh.stat()).size;
    // 文件被截断/轮转后变小（size < offset，游标已越过新文件末尾）：
    // 0..size 段仍是存活的既有事件，本轮直接从 0 重读并把它们返回（正确聚合已有行），
    // 不再整段跳过只把 offset 复位（旧实现会丢弃这 0..size 段的数据）。
    // 返回值 truncated=true 通告调用方本轮发生过截断/轮转，需把 offset/cursor 对齐到 size。
    // rotate 场景保留：轮转期间 rotateBusy 忙标志已让读方等待完成后才 open，
    // 因此这里打开的是稳定文件；即便撞上改名中的旧 inode，读到的也是其既有内容，不丢行。
    const start = size < offset ? 0 : offset;
    if (size === start) return { lines: [], size, truncated: size < offset };

    const readLen = Math.min(size - start, maxSize);
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return { lines: text.split(/\r?\n/).filter(Boolean), size, truncated: size < offset };
  } finally {
    await closeHandle(fh);
  }
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 事件文件增量读：记录已读字节 offset，文件被截断/轮转时回到 0。
// rotateBusy 忙标志（maybeRotate 置位）：轮转期间本函数等待其完成再读，
// 避免读到"改名后瞬时缺失"或撞上旧文件造成 ENOENT / 期间写入行丢失。
// ---------------------------------------------------------------------------
let readOffset = 0;
let rotateBusy = false; // 文件轮转忙标志

async function readNewLines() {
  // 正在轮转时最多等待 500ms（每 10ms 探测一次），保证读到的是稳定文件
  for (let i = 0; i < 50 && rotateBusy; i++) await delayMs(10);
  const result = await readFileRange(EVENTS_FILE, readOffset);
  // 文件被截断/轮转时，readFileRange 本轮已从 0 重读 0..size 的既有行（不丢行、正确聚合）；
  // 这里统一把 offset 对齐到当前文件大小，无需再针对 truncated 单独归零。
  readOffset = result.size;
  return result.lines;
}

async function closeHandle(fh) {
  try { await fh.close(); } catch { /* 忽略 */ }
}

// 启动时定位到事件文件末尾：服务重启视为新会话，不重放历史事件
async function initReadOffset() {
  try {
    const st = await stat(EVENTS_FILE);
    readOffset = st.size;
  } catch {
    readOffset = 0; // 文件不存在：从头开始（文件创建后会增量读）
  }
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------
// agents: Map<id, agentInfo>
// agentInfo: {
//   id, type, status, currentTool, toolCount,
//   startTime, endTime, lastSeen, history: [最多 MAX_HISTORY 条状态简记]
// }
const agents = new Map();
let lastActiveKey = null; // 供无 agent 归属的 Notification 使用
// 待消费的子 Agent 名称登记表（agentId → { name, ts }）：
// post_tool_use 通过 tool_response.agentId 精确登记，subagent_start 按 key 消费，
// 并行/异步子 Agent 也不会错配（问题2 H1）。
const agentNames = new Map();
// 待消费的子 Agent 派发描述队列（LIFO）：pre_tool_use 主 Agent 调 Agent 工具时登记，
// subagent_start 无精确配对（agentNames 命中）时按"最近一次派发"消费。针对 hooks 事件
// 未带 prompt/agentId 时子 Agent 拿不到任务描述的场景（显示 type 而非描述）。
const pendingDispatch = []; // [{ name, ts }]

const CLEANUP_INTERVAL = 60 * 1000; // 清理间隔 1 分钟（STALE_MS 统一在 config.mjs）
const NAME_STALE_MS = 60 * 1000;    // agentNames 未消费条目的过期时限
const MAX_HISTORY = 6;               // 每个 Agent 的 history 数组最大条目数

function newAgent(id, type) {
  return {
    id,
    type: type || "agent",
    name: null,
    status: null,
    currentTool: null,
    toolCount: 0,
    startTime: null,
    endTime: null,
    lastSeen: null,
    history: [],
  };
}

// 向 history 追加状态简记，连续重复合并，最多留最近 MAX_HISTORY 条
function pushHistory(a, note) {
  const h = a.history;
  if (h.length > 0 && h[h.length - 1] === note) return;
  h.push(note);
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

// 定时回收超时无事件的 Agent：任何状态（queued/thinking/tool/asking/done/failed），
// lastSeen 超过 STALE_MS 无更新即回收。主会话 main 与回收豁免（问题5 M3）。
// 整体 try/catch：保证定时任务绝不向外抛异常（避免 uncaughtException 导致进程崩溃）。
function cleanupInactiveAgents() {
  try {
    const now = Date.now();
    // 顺带清理已失效的停止请求信号（见下方 pruneStopSignals，保持文件小）
    // 必须在 agent 回收循环之前调用：此时 agents Map 仍包含终态（done/failed）agent 的 id，
    // pruneStopSignals 内的 agents.get(id) 能正确判定 "agent 已知但终态" 并清除其信号；
    // 若放在回收之后，终态 id 已被 delete，get 返回 undefined，信号残留至 24h TTL。
    pruneStopSignals();
    for (const [key, a] of [...agents]) {
      // 主 Agent（main）绑定用户会话上下文，其生命周期应与看板前端一致而非跟随单次任务结束。
      // 回收 main 会导致看板主卡消失、后续事件无法挂载到主入口，因此对 main 豁免超时回收。
      if (key === "main") continue;
      // lastSeen 缺失或 Date.parse 得 NaN 时按 Date.now() 兜底，
      // 避免 NaN 运算（NaN > STALE_MS 恒为 false）导致该 Agent 永不参与回收判定。
      const parsed = a.lastSeen ? Date.parse(a.lastSeen) : NaN;
      const lastSeen = Number.isFinite(parsed) ? parsed : Date.now();
      if (now - lastSeen > STALE_MS) {
        agents.delete(key);
      }
    }
    // 清理 agentNames 中超过 NAME_STALE_MS 仍未消费的登记，避免 agentId 复用导致误配（问题2 第4点）
    for (const [id, entry] of agentNames) {
      if (now - entry.ts > NAME_STALE_MS) agentNames.delete(id);
    }
    // 清理 pendingDispatch 中超过 NAME_STALE_MS 仍未被消费的派发描述，避免长时间运行无界增长
    while (pendingDispatch.length && now - pendingDispatch[0].ts > NAME_STALE_MS) {
      pendingDispatch.shift();
    }
  } catch (err) {
    // 定时清理任何一步异常都不允许向上抛出，记录后继续
    console.error("[server] 定时清理异常:", err?.message ?? err);
  }
}

// ---------------------------------------------------------------------------
// 停止请求信号（data/stop-signals.jsonl）：看板记录的"停止子 Agent"意图，
// 由外部主会话消费该文件执行真实中断。本服务只追加/清理该文件，禁止写 events.jsonl
// （避免与 hooks 采集器并发冲突）。记录格式：一行一个 JSON { ts, agent, status: "requested" }
// ---------------------------------------------------------------------------
const stopSignals = new Map(); // agentId -> { ts, agent, status }（同 id 保留 ts 最新一条）

// 读取 stop-signals.jsonl 为内存快照 Map：同 id 保留 ts 最新一条（ISO 字符串可直接按字典序比较）。
// 以文件为准（独立于内存滞后），供 /api/state 判定 stopRequested，也可复用给 prune/内存同步。
function readStopSignals() {
  const map = new Map();
  let text;
  try { text = readFileSync(STOP_SIGNALS_FILE, "utf8"); } catch { return map; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec.agent === "string" && rec.agent) {
        const prev = map.get(rec.agent);
        if (!prev || String(rec.ts) >= String(prev.ts)) map.set(rec.agent, rec);
      }
    } catch { /* 残缺行忽略 */ }
  }
  return map;
}

// 以独立文件为准，返回"存在 requested 行"的 agent 集合（每次 /api/state 响应前调用；
// 读取失败 → 空集合，即所有 agent 的 stopRequested 均为 false）。
function readStopRequestedIds() {
  const ids = new Set();
  let text;
  try { text = readFileSync(STOP_SIGNALS_FILE, "utf8"); } catch { return ids; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec.agent === "string" && rec.agent && rec.status === "requested") {
        ids.add(rec.agent);
      }
    } catch { /* 残缺行忽略 */ }
  }
  return ids;
}

// 启动时把既有停止信号读入内存（服务重启后历史信号仍可被外部主会话消费）
function loadStopSignals() {
  stopSignals.clear();
  for (const [id, rec] of readStopSignals()) stopSignals.set(id, rec);
}

// 追加一条停止信号：fs.appendFileSync + try/catch（写失败不抛给路由层可继续其他工作）
function appendStopSignal(rec) {
  try {
    appendFileSync(STOP_SIGNALS_FILE, JSON.stringify(rec) + "\n", "utf8");
    stopSignals.set(rec.agent, rec);
    return true;
  } catch (err) {
    console.error("[server] 追加 stop-signal 失败:", err.message);
    return false;
  }
}

// 清理停止信号：删除"在本轮聚合中出现且已结束(done/failed) / 超过 TTL"的条目。
// 特别注意：不删除"本服务本轮未聚合过（未 appeared）"的停止信号——服务重启后 agents 里只有
// 本轮新会话聚合到的 agent id，上一会话遗留的停止信号必须保留，供外部主会话继续消费；
// 因此不再用旧逻辑 `agents.size > 0 && (!a || terminal)`（那会在重启后误清历史信号）。
// TTL 过期条目无论何时都会清掉，保证文件长期有界。重写用临时文件 + rename 原子替换，
// 避免外部消费者读到半截文件。
function pruneStopSignals() {
  // 先以文件为准刷新内存视图（外部主会话可能已直接增删文件），再基于 agents 状态清理
  const fresh = readStopSignals();
  stopSignals.clear();
  let changed = false;
  const now = Date.now();
  for (const [id, rec] of fresh) {
    const expired = typeof rec.ts === "string" && (now - Date.parse(rec.ts)) > STOP_REQUEST_TTL_MS;
    // appeared 语义：仅当该 id 在本轮聚合中真实存在（agents 命中）且到达终态才清除。
    // 未聚合过的 id（本进程从未收到其事件）一律保留，避免重启后误删外部尚未消费的历史信号。
    const a = agents.get(id);
    const gone = !!a && isTerminalStatus(a.status);
    if (expired || gone) {
      changed = true;
    } else {
      stopSignals.set(id, rec);
    }
  }
  if (changed) flushStopSignals();
}

function flushStopSignals() {
  try {
    const body = stopSignals.size > 0
      ? [...stopSignals.values()].map((r) => JSON.stringify(r)).join("\n") + "\n"
      : "";
    const tmp = STOP_SIGNALS_FILE + ".tmp";
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, STOP_SIGNALS_FILE);
  } catch (err) {
    console.error("[server] 重写 stop-signals.jsonl 失败:", err.message);
  }
}

// 是否终态（done/failed）：终态 Agent 已不可停止，对应停止信号可清理
function isTerminalStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "done" || s === "failed";
}

function applyEvent(e) {
  const hook = e.hook;
  if (!hook || typeof hook !== "string") return;

  const isNotification = hook === "notification";
  const key = isNotification
    ? lastActiveKey // 通知无 agent 归属，挂到最近活跃的 agent 上
    : e.agent != null && String(e.agent) !== ""
      ? String(e.agent)
      : "main"; // 主会话工具调用没有 agent_id，合成 main 入口

  const rawTs = typeof e.ts === "string" ? e.ts : new Date().toISOString();

  switch (hook) {
    case "subagent_start": {
      let a = agents.get(key);
      if (!a) { a = newAgent(key, e.type || "agent"); agents.set(key, a); }
      if (!a.startTime) a.startTime = rawTs;
      a.type = e.type || a.type || "agent";
      a.status = "queued";
      a.lastSeen = rawTs;
      pushHistory(a, "start");
      // 消费 post_tool_use 按 agentId 精确登记的名称（并行子 Agent 不会错配，问题2 H1）
      const entry = agentNames.get(key);
      // 名称来源优先级（均仅当尚无 name 时写入，避免覆盖已登记/已提取的名称）：
      //   ① agentNames —— post_tool_use 的 agentId 精确配对（最可靠）
      //   ② pendingDispatch —— pre_tool_use 主 Agent 派发 Agent 工具时登记的最近一次任务描述
      //   ③ 事件自带 detail.prompt（SubagentStart hook 的 prompt 字段，collect.mjs 保留）
      if (!a.name) {
        if (entry) { a.name = entry.name; agentNames.delete(key); }
        else if (pendingDispatch.length) {
          const pend = pendingDispatch.pop();
          if (pend && pend.name) a.name = pend.name;
        }
        else if (e.detail) {
          try {
            const detail = typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
            const desc = detail?.prompt ?? detail?.description ?? detail?.prompt_text;
            if (typeof desc === "string" && desc) a.name = desc;
          } catch { /* detail 不是 JSON 或结构不符，忽略 */ }
        }
      }
      break;
    }
    case "pre_tool_use": {
      let a = agents.get(key);
      if (!a) {
        // 缺 start（只有 tool 事件）→ 合成入口，type=agent，startTime=首次事件时间
        a = newAgent(key, e.type || "agent");
        a.startTime = rawTs;
        agents.set(key, a);
      }
      a.status = "tool";
      if (e.tool != null) {
        a.currentTool = String(e.tool);
        a.toolCount = (a.toolCount || 0) + 1;
        pushHistory(a, `tool:${a.currentTool}`);
      } else {
        pushHistory(a, "tool");
      }
      // Agent 派发类工具（tool='Agent'，主 Agent 派发子 Agent）：把任务描述登记到待消费队列，
      // 供即将出现的 subagent_start 提取。不再写给当前 agent —— 否则主 Agent 用 Bash/Grep 等
      // 普通工具时 description 会污染 main 的名字，且子 Agent 永远拿不到派发描述。
      // 队列 LIFO：最近一次派发优先；post_tool_use 的 agentId 精确配对优先级更高（见 subagent_start）。
      if (e.tool === "Agent" && e.detail) {
        try {
          const detail = typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
          const desc = detail?.tool_input?.description;
          if (typeof desc === "string" && desc) {
            pendingDispatch.push({ name: desc, ts: Date.now() });
          }
        } catch { /* detail 不合法或结构不符，忽略 */ }
      }
      a.lastSeen = rawTs;
      break;
    }
    case "post_tool_use": {
      let a = agents.get(key);
      if (!a) {
        a = newAgent(key, e.type || "agent");
        a.startTime = rawTs;
        agents.set(key, a);
      }
      a.status = "thinking"; // 思考间隙；当前工具保留显示
      a.lastSeen = rawTs;
      pushHistory(a, "thinking");
      // Agent 工具调用结束后：从 tool_response 取 agentId + description 精确配对。
      // subagent_start 已先行 → 直接回填名称；post 先行 → 登记供后续 subagent_start 消费（问题2 H1）。
      if (e.tool === "Agent" && e.detail) {
        try {
          const detail = typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
          const agentId = detail.tool_response?.agentId;
          const desc = detail.tool_response?.description ?? detail.tool_input?.description;
          if (agentId && desc) {
            const sub = agents.get(String(agentId));
            if (sub) sub.name = desc;                        // subagent_start 已先行 → 直接回填
            agentNames.set(String(agentId), { name: desc, ts: Date.now() }); // post 先行 → 供后续消费
          }
        } catch { /* detail 不合法或结构不符，忽略 */ }
      }
      break;
    }
    case "notification": {
      if (String(e.detail ?? e.message ?? "").includes("agent_needs_input")) {
        const a = agents.get(key);
        if (a) {
          a.status = "asking";
          a.lastSeen = rawTs;
          pushHistory(a, "asking");
        }
      }
      break;
    }
    case "subagent_stop": {
      // 防御性：主会话（main）正常不产生 stop 事件；万一出现，跳过 done/failed 标记，避免把主卡永久标记为 ✅/❌
      if (key === "main") break;
      let a = agents.get(key);
      if (!a) { a = newAgent(key, e.type || "agent"); agents.set(key, a); }
      // 失败判定：只信任结构化字段（status / detail.error / result.status / success）。
      // 不做 message 文本匹配——成功结果的文本里也可能出现 "error" 字样
      // （如 "fixed the error"、"no errors found"），文本匹配会误判（问题4 M2 回退）。
      let failed = e.status === "error" || e.status === "failed";
      if (!failed && e.detail) {
        try {
          const d = typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
          if (d && (d.error || d.result?.status === "error" || d.status === "error" || d.success === false)) {
            failed = true;
          }
        } catch { /* detail 不合法，忽略 */ }
      }
      a.status = failed ? "failed" : "done";
      a.endTime = rawTs;
      a.lastSeen = rawTs;
      pushHistory(a, failed ? "error" : "done");
      // 不再 5 秒后立即删除（问题3 M1）：done/failed 结果保留至 cleanupInactiveAgents
      // 按 STALE_MS（10 分钟）统一回收；
      // 同时"删除定时器误删同 key 新 agent"的隐患也随之消除（问题1 H2）。
      break;
    }
    default:
      // 未知 hook 忽略
      return;
  }

  if (!isNotification) lastActiveKey = key;
}

function processLines(lines) {
  let skipped = 0;
  for (const line of lines) {
    try {
      applyEvent(JSON.parse(line));
    } catch (err) {
      // 残缺行（写盘竞态）跳过，记录调试日志便于排查
      skipped++;
      console.debug('[server] 跳过无效事件行:', err.message);
    }
  }
  if (skipped > 0) {
    console.debug(`[server] processLines 共跳过 ${skipped} 行无效事件`);
  }
}

// ---------------------------------------------------------------------------
// 文件轮转：events.jsonl 超过 MAX_BYTES → 改名为 .1 并新建。
// rotateBusy 忙标志 + readNewLines/SSE 的轮转等待：避免轮转窗口内增量读读到
// "改名后瞬时缺失"或 offset 撞上旧文件，防止 ENOENT 与期间写入行丢失。
// 新建文件用 append 模式打开：若轮转窗口内采集器已抢先创建新文件（含写入的行），
// 保留其内容，避免 writeFile("") 覆盖清空造成数据丢失。
// ---------------------------------------------------------------------------
async function maybeRotate() {
  if (rotateBusy) return; // 并发保护：已有一个轮转在跑，本次直接跳过
  rotateBusy = true;
  try {
    let st;
    try { st = await stat(EVENTS_FILE); } catch {
      return; // 文件暂不存在，无需轮转（rotateBusy 由 finally 复位）
    }
    if (st.size < MAX_BYTES) return;

    // 保留 2 个历史文件：先删除最旧的 .2，再将 .1 移为 .2，最后将当前文件移为 .1
    await rm(EVENTS_FILE + ".2", { force: true });
    try { await rename(EVENTS_FILE + ".1", EVENTS_FILE + ".2"); } catch {
      /* .1 不存在则跳过 */
    }
    await rename(EVENTS_FILE, EVENTS_FILE + ".1");
    // 以"追加"模式创建空新文件：不截断任何已被采集器抢先写入的内容
    let fh2;
    try { fh2 = await openFile(EVENTS_FILE, "a"); } finally { await closeHandle(fh2); }
    readOffset = 0; // 新文件从头增量读（保留既有 offset 归零重读逻辑）
  } catch (err) {
    // 轮转失败不向外抛（避免 uncaughtException），记录后等下一轮再试
    console.error("[server] 事件文件轮转失败:", err?.message ?? err);
  } finally {
    rotateBusy = false;
  }
}

// ---------------------------------------------------------------------------
// 响应工具
// ---------------------------------------------------------------------------
// 允许来源集合（由 ALLOWED_ORIGINS 初始化）：逐请求校验 Origin 是否放行
const allowedOrigins = new Set(ALLOWED_ORIGINS);

// 允许的 HTTP 方法白名单（与路由实际开放方法严格一致：GET 查询 + POST 停止 + OPTIONS 预检），
// 供 OPTIONS 预检与停止接口回显 Access-Control-Allow-Methods 使用
const ALLOWED_METHODS = "GET, POST, OPTIONS";

// 按请求 Origin 计算 CORS 头：无 Origin（同源/curl 等）或不在白名单 → 不附加
function corsHeadersFor(req) {
  const origin = req && req.headers.origin;
  return origin && allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {};
}

// 停止接口额外允许方法：同源无需 CORS；本地跨端口访问时补 Access-Control-Allow-Methods 亦可
const STOP_EXTRA_HEADERS = { "Access-Control-Allow-Methods": ALLOWED_METHODS };

function sendJson(req, res, status, body, extra) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...corsHeadersFor(req),
    ...(extra || {}),
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// GET /api/stream：手写 Server-Sent Events（零依赖）。
//   每 SSE_INTERVAL_MS 检查事件文件尾部增量，有新行 → 推送 {type:'event', ev:{...}}；
//   同时每周期推送 {type:'ping'} 保活。客户端断开即清理定时器。
//   连接数上限 SSE_MAX_CLIENTS，超限直接 503 关闭，不影响既有轮询接口。
// ---------------------------------------------------------------------------
const SSE_INTERVAL_MS = 2000; // 推送/检查周期
const SSE_MAX_CLIENTS = 5;    // 最大同时保持的 SSE 连接数
let sseActive = 0;            // 当前活跃 SSE 连接数

function sseSend(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch { /* 连接已断，忽略 */ }
}

async function handleStream(req, res) {
  // 先占位再判读：sseActive++ 与上限判断之间没有任何 await。若先判读、等首个 await（stat）后再
  // 自增，两条同时到达的连接都会在 await 期间看到未自增的计数，从而双双越过上限（条件竞态）。
  // 超限后回退计数并 503，计数不会泄漏给后续请求。
  sseActive++;
  if (sseActive > SSE_MAX_CLIENTS) {
    sseActive--;
    // 并发连接超限：直接 503 关闭（纯文本），避免持续占用连接资源
    try {
      res.writeHead(503, {
        "Content-Type": "text/plain; charset=utf-8",
        ...corsHeadersFor(req),
      });
      res.end("503 Service Unavailable: too many SSE connections");
    } catch { /* 连接已关闭 */ }
    return;
  }

  // 游标定位到"当前文件末尾"：只放送连入后的新事件（不重放历史，等价 /api/state 的不重放）
  let cursor = 0;
  try { cursor = (await stat(EVENTS_FILE)).size; } catch { cursor = 0; }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...corsHeadersFor(req),
  });
  res.write("retry: 2000\n\n");
  res.flushHeaders();

  let timer = null;
  const cleanup = () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (sseActive > 0) sseActive--;
    try { res.end(); } catch { /* 已结束 */ }
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("error", cleanup);

  timer = setInterval(async () => {
    try {
      // 事件文件尾增量读：与 /api/state 共用同一套 fh.stat / 截断重读逻辑，轮转安全。
      // 文件被截断/轮转变小后 readFileRange 本轮会从 0 重读 0..size 的内容（不整段跳过），
      // 这里只需把 cursor 对齐到新文件大小即可，无需再手动归零。
      const r = await readFileRange(EVENTS_FILE, cursor);
      cursor = r.size;
      for (const line of r.lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; } // 残缺行跳过
        sseSend(res, { type: "event", ev: e });
      }
      // 保活心跳（同一 2s 周期），也让客户端感知连接活性
      sseSend(res, { type: "ping" });
    } catch (err) {
      // 单次推送异常不中断整条流，记日志后继续
      console.error("[server] SSE 推送异常:", err?.message ?? err);
    }
  }, SSE_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// POST /api/agents/:id/stop：登记"停止子 Agent"请求（追加到 stop-signals.jsonl）。
// 校验：agent 必须存在且处于存活态（非 done/failed / 已离场），否则 404 / 409。
// 真实中断由外部（主会话）消费信号文件执行，本接口只做"请求 + 状态标记"闭环。
// ---------------------------------------------------------------------------
function handleAgentStop(req, res, agentId) {
  if (agentId === "main") {
    return sendJson(req, res, 409, { ok: false, error: "主 Agent 不允许停止" }, STOP_EXTRA_HEADERS);
  }
  const a = agents.get(agentId);
  if (!a) {
    // 已离场/不存在 → 404
    return sendJson(req, res, 404, { ok: false, error: "agent 不存在或已离场" }, STOP_EXTRA_HEADERS);
  }
  if (isTerminalStatus(a.status)) {
    // 已 done/failed → 409（与当前终态冲突）
    return sendJson(req, res, 409, { ok: false, error: "agent 已结束，无法停止" }, STOP_EXTRA_HEADERS);
  }
  const ok = appendStopSignal({ ts: new Date().toISOString(), agent: agentId, status: "requested" });
  if (!ok) {
    return sendJson(req, res, 500, { ok: false, error: "写入停止信号失败" }, STOP_EXTRA_HEADERS);
  }
  return sendJson(req, res, 200, { ok: true, agent: agentId }, STOP_EXTRA_HEADERS);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // 逐请求 CORS 校验（安全加固）：带 Origin 且不在允许来源列表 → 403 纯文本拒绝，不进入任何路由；
  // 放行后由 corsHeadersFor(req) 回显该请求域作为 Access-Control-Allow-Origin。
  const origin = String(req.headers.origin || "");
  if (origin && !allowedOrigins.has(origin)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return void res.end("403 Forbidden");
  }
  const corsHeaders = corsHeadersFor(req);

  try {
    // OPTIONS 预检：浏览器跨端口 POST（/api/agents/:id/stop）前会先发预检请求探测可用方法，
    // 这里统一回 204 并声明允许方法/请求头，避免预检被下方的 405 拦截导致浏览器 POST 失败。
    // 无 Origin（同源/curl 等）也照常放行（204）；跨域合法性仍由请求头里的 Origin 校验负责。
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Content-Length": 0,
        "Access-Control-Allow-Methods": ALLOWED_METHODS,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        ...corsHeaders,
      });
      return void res.end();
    }

    // 仅放开 POST /api/agents/:id/stop（停止子 Agent 的信号入口），其余非 GET 一律 405
    if (req.method !== "GET") {
      if (req.method === "POST") {
        const m = pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
        if (m) {
          let agentId;
          try { agentId = decodeURIComponent(m[1]); } catch { agentId = m[1]; }
          return handleAgentStop(req, res, agentId);
        }
      }
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders });
      return void res.end("405 Method Not Allowed");
    }

    if (pathname === "/api/health") {
      let fileBytes = 0;
      try { fileBytes = (await stat(EVENTS_FILE)).size; } catch { fileBytes = 0; }
      return sendJson(req, res, 200, { ok: true, fileBytes });
    }

    if (pathname === "/api/state") {
      const lines = await readNewLines();
      processLines(lines);
      // stopRequested 以独立文件为准：每次响应前重读，避免仅依赖内存 Map 的滞后（读取失败→空）
      const stopRequestedIds = readStopRequestedIds();
      await maybeRotate();

      const updatedAt = new Date().toISOString();

      // 直接取全部 agent；超时回收已由 cleanupInactiveAgents 定时处理
      const all = [...agents.values()];
      all.sort((x, y) => (x.startTime ?? "").localeCompare(y.startTime ?? ""));
      return sendJson(req, res, 200, {
        updatedAt,
        agents: all.map((a) => toAgentView(a, stopRequestedIds)),
        summary: buildSummary(all),
      });
    }

    if (pathname === "/api/events") {
      // 调试：?since=<offset> 从指定偏移读原始事件，不推进 /api/state 的聚合 offset
      const sinceParam = url.searchParams.get("since");
      let offset = sinceParam == null || sinceParam === "" ? 0 : Number(sinceParam);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;

      const result = await readFileRange(EVENTS_FILE, offset);
      let events = result.lines.map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter((e) => e !== null);
      return sendJson(req, res, 200, { events, nextOffset: result.size });
    }

    if (pathname === "/api/stream") {
      // Server-Sent Events 长连接（Content-Type: text/event-stream），断开即清理
      return handleStream(req, res);
    }

    // 静态资源
    return serveStatic(pathname, res, corsHeaders);
  } catch (err) {
    try {
      sendJson(req, res, 500, { error: "internal error", message: String(err.message || err) });
    } catch { /* 响应已发送 */ }
  }
});

function toAgentView(a, stopRequestedIds) {
  return {
    id: a.id,
    type: a.type ?? null,
    name: a.name ?? null,
    status: a.status,
    currentTool: a.currentTool,
    toolCount: a.toolCount ?? 0,
    startTime: a.startTime,
    endTime: a.endTime,
    lastSeen: a.lastSeen,
    history: a.history,
    // 该 agent 是否有停止请求：以 stop-signals.jsonl 文件为准（存在该 agent 的 "requested" 行 → true）
    stopRequested: stopRequestedIds ? stopRequestedIds.has(a.id) : false,
  };
}

function buildSummary(all) {
  const s = { total: 0, active: 0, done: 0, queued: 0, thinking: 0, tool: 0, failed: 0, asking: 0 };
  for (const a of all) {
    s.total++;
    switch (a.status) {
      case "queued": s.queued++; s.active++; break;
      case "tool": s.tool++; s.active++; break;
      case "thinking": s.thinking++; s.active++; break;
      case "asking": s.asking++; s.active++; break;
      case "done": s.done++; break;
      case "failed": s.failed++; break;
      default: /* 未知状态不计数 */ break;
    }
  }
  return s;
}

async function serveStatic(pathname, res, corsHeaders) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  // 防目录穿越
  const safeRel = path.normalize(rel).replace(/^(\.\.[\\/])+/, "").replace(/^([\\/])+/, "");
  const filePath = path.join(WEB_DIR, safeRel);
  const webRoot = path.resolve(WEB_DIR);
  if (!filePath.startsWith(webRoot + path.sep) && filePath !== path.join(webRoot, "index.html")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders });
    return void res.end("404 Not Found");
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders });
    return void res.end("404 Not Found");
  }
  const mime = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, ...corsHeaders });
  res.end(data);
}

// 启动定时清理
const cleanupTimer = setInterval(cleanupInactiveAgents, CLEANUP_INTERVAL);

// 启动时序：先载入既有停止信号、定位事件文件末尾（不重放历史），再监听端口
loadStopSignals();
await initReadOffset();
server.listen(PORT, HOST, () => {
  // 启动日志打印实际监听地址（HOST=0.0.0.0 表示已监听所有网卡）
  if (HOST === "0.0.0.0") {
    console.log(`[vc-dashboard] server listening on http://0.0.0.0:${PORT}（已监听所有网卡，访问入口 http://localhost:${PORT}）`);
  } else {
    console.log(`[vc-dashboard] server running at http://${HOST}:${PORT}`);
  }
});

// Graceful shutdown：收到终止信号时清理定时器并关闭 HTTP server
function gracefulShutdown(signal) {
  console.log(`[server] 收到 ${signal}，正在关闭...`);
  clearInterval(cleanupTimer);
  server.close(() => {
    console.log('[server] HTTP server 已关闭');
    process.exit(0);
  });
  // 防止 server.close 卡住，5 秒后强制退出
  setTimeout(() => {
    console.warn('[server] 关闭超时，强制退出');
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));