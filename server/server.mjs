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
import { stat, open as openFile, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { PORT, MAX_BYTES, EVENTS_FILE, WEB_DIR, STALE_MS, ALLOWED_ORIGIN } from "../config.mjs";

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
// 文件不存在或 offset 超出范围时返回空数组；文件被截断时自动回退到 0
// ---------------------------------------------------------------------------
async function readFileRange(filePath, offset, maxSize = Infinity) {
  let size;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return { lines: [], size: 0, truncated: true };
  }
  if (size < offset) {
    // 文件被截断或轮转，重置 offset 从头读
    return { lines: [], size, truncated: true };
  }
  if (size === offset) return { lines: [], size, truncated: false };

  const readLen = Math.min(size - offset, maxSize);
  const fh = await openForRead(filePath);
  const buf = Buffer.alloc(readLen);
  try {
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return { lines: text.split(/\r?\n/).filter(Boolean), size, truncated: false };
  } finally {
    await closeHandle(fh);
  }
}

// ---------------------------------------------------------------------------
// 事件文件增量读：记录已读字节 offset，文件被截断/轮转时回到 0
// ---------------------------------------------------------------------------
let readOffset = 0;

async function readNewLines() {
  const result = await readFileRange(EVENTS_FILE, readOffset);
  if (result.truncated) readOffset = 0;
  readOffset = result.size;
  return result.lines;
}

async function openForRead(p) {
  return await openFile(p, "r");
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
function cleanupInactiveAgents() {
  const now = Date.now();
  for (const [key, a] of [...agents]) {
    // 主 Agent（main）绑定用户会话上下文，其生命周期应与看板前端一致而非跟随单次任务结束。
    // 回收 main 会导致看板主卡消失、后续事件无法挂载到主入口，因此对 main 豁免超时回收。
    if (key === "main") continue;
    const lastSeen = a.lastSeen ? Date.parse(a.lastSeen) : 0;
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
// 文件轮转：events.jsonl 超过 MAX_BYTES → 改名为 .1 并新建
// ---------------------------------------------------------------------------
async function maybeRotate() {
  try {
    const st = await stat(EVENTS_FILE);
    if (st.size >= MAX_BYTES) {
      // 保留 2 个历史文件：先删除最旧的 .2，再将 .1 移为 .2，最后将当前文件移为 .1
      await rm(EVENTS_FILE + ".2", { force: true });
      await rename(EVENTS_FILE + ".1", EVENTS_FILE + ".2");
      await rename(EVENTS_FILE, EVENTS_FILE + ".1");
      await writeFile(EVENTS_FILE, "", "utf8");
      readOffset = 0;
    }
  } catch {
    // 文件不存在等，忽略
  }
}

// ---------------------------------------------------------------------------
// 响应工具
// ---------------------------------------------------------------------------
const CORS = { "Access-Control-Allow-Origin": ALLOWED_ORIGIN };

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...CORS,
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
      return void res.end("405 Method Not Allowed");
    }

    if (pathname === "/api/health") {
      let fileBytes = 0;
      try { fileBytes = (await stat(EVENTS_FILE)).size; } catch { fileBytes = 0; }
      return sendJson(res, 200, { ok: true, fileBytes });
    }

    if (pathname === "/api/state") {
      const lines = await readNewLines();
      processLines(lines);
      await maybeRotate();

      const updatedAt = new Date().toISOString();

      // 直接取全部 agent；超时回收已由 cleanupInactiveAgents 定时处理
      const all = [...agents.values()];
      all.sort((x, y) => (x.startTime ?? "").localeCompare(y.startTime ?? ""));
      return sendJson(res, 200, {
        updatedAt,
        agents: all.map(toAgentView),
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
      return sendJson(res, 200, { events, nextOffset: result.size });
    }

    // 静态资源
    return serveStatic(pathname, res);
  } catch (err) {
    try {
      sendJson(res, 500, { error: "internal error", message: String(err.message || err) });
    } catch { /* 响应已发送 */ }
  }
});

function toAgentView(a) {
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

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  // 防目录穿越
  const safeRel = path.normalize(rel).replace(/^(\.\.[\\/])+/, "").replace(/^([\\/])+/, "");
  const filePath = path.join(WEB_DIR, safeRel);
  const webRoot = path.resolve(WEB_DIR);
  if (!filePath.startsWith(webRoot + path.sep) && filePath !== path.join(webRoot, "index.html")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
    return void res.end("404 Not Found");
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...CORS });
    return void res.end("404 Not Found");
  }
  const mime = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, ...CORS });
  res.end(data);
}

// 启动定时清理
const cleanupTimer = setInterval(cleanupInactiveAgents, CLEANUP_INTERVAL);

// 启动时序：先定位事件文件末尾（不重放历史），再监听端口
await initReadOffset();
server.listen(PORT, () => {
  console.log(`[vc-dashboard] server running at http://localhost:${PORT}`);
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