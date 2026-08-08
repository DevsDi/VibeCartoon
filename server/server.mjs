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
import { PORT, MAX_BYTES, EVENTS_FILE, WEB_DIR, STALE_MS } from "../config.mjs";

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
// 事件文件增量读：记录已读字节 offset，文件被截断/轮转时回到 0
// ---------------------------------------------------------------------------
let readOffset = 0;

async function readNewLines() {
  let size;
  try {
    size = (await stat(EVENTS_FILE)).size;
  } catch {
    // 文件不存在：从头开始
    readOffset = 0;
    return [];
  }

  if (size < readOffset) {
    // 文件被截断或轮转，重置 offset 从头读
    readOffset = 0;
  }
  if (size === readOffset) return [];

  const fh = await openForRead(EVENTS_FILE);
  const buf = Buffer.alloc(size - readOffset);
  try {
    const { bytesRead } = await fh.read(buf, 0, buf.length, readOffset);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    readOffset = size;
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    await closeHandle(fh);
  }
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
//   startTime, endTime, lastSeen, history: [最多6条状态简记]
// }
const agents = new Map();
let lastActiveKey = null; // 供无 agent 归属的 Notification 使用

const CLEANUP_INTERVAL = 60 * 1000; // 清理间隔 1 分钟（STALE_MS 统一在 config.mjs）

function newAgent(id, type) {
  return {
    id,
    type: type || "agent",
    status: null,
    currentTool: null,
    toolCount: 0,
    startTime: null,
    endTime: null,
    lastSeen: null,
    history: [],
  };
}

// 向 history 追加状态简记，连续重复合并，最多留最近 6 条
function pushHistory(a, note) {
  const h = a.history;
  if (h.length > 0 && h[h.length - 1] === note) return;
  h.push(note);
  if (h.length > 6) h.splice(0, h.length - 6);
}

// 定时回收超时无事件的 Agent：任何状态（queued/thinking/tool/asking/done/failed），
// lastSeen 超过 STALE_MS 无更新即回收
function cleanupInactiveAgents() {
  const now = Date.now();
  for (const [key, a] of [...agents]) {
    const lastSeen = a.lastSeen ? Date.parse(a.lastSeen) : 0;
    if (now - lastSeen > STALE_MS) {
      agents.delete(key);
    }
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
      let a = agents.get(key);
      if (!a) { a = newAgent(key, e.type || "agent"); agents.set(key, a); }
      const failed = e.status === "error" || e.status === "failed";
      a.status = failed ? "failed" : "done";
      a.endTime = rawTs;
      a.lastSeen = rawTs;
      pushHistory(a, failed ? "error" : "done");
      // 延迟 5 秒后从 agents Map 中移除，让前端有时间显示完成状态
      setTimeout(() => { agents.delete(key); }, 5000);
      break;
    }
    default:
      // 未知 hook 忽略
      return;
  }

  if (!isNotification) lastActiveKey = key;
}

function processLines(lines) {
  for (const line of lines) {
    try {
      applyEvent(JSON.parse(line));
    } catch {
      // 残缺行（写盘竞态）跳过
    }
  }
}

// ---------------------------------------------------------------------------
// 文件轮转：events.jsonl 超过 MAX_BYTES → 改名为 .1 并新建
// ---------------------------------------------------------------------------
async function maybeRotate() {
  try {
    const st = await stat(EVENTS_FILE);
    if (st.size >= MAX_BYTES) {
      await rm(EVENTS_FILE + ".1", { force: true });
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
const CORS = { "Access-Control-Allow-Origin": "*" };

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

      let size;
      try { size = (await stat(EVENTS_FILE)).size; }
      catch { size = 0; }

      if (size < offset) offset = 0;
      let events = [];
      if (size > offset) {
        const fh = await openForRead(EVENTS_FILE);
        const buf = Buffer.alloc(size - offset);
        try {
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          const text = buf.subarray(0, bytesRead).toString("utf8");
          events = text.split(/\r?\n/).filter(Boolean);
        } finally {
          await closeHandle(fh);
        }
        events = events.map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter((e) => e !== null);
        return sendJson(res, 200, { events, nextOffset: size });
      }
      return sendJson(res, 200, { events, nextOffset: size });
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
setInterval(cleanupInactiveAgents, CLEANUP_INTERVAL);

// 启动时序：先定位事件文件末尾（不重放历史），再监听端口
await initReadOffset();
server.listen(PORT, () => {
  console.log(`[vc-dashboard] server running at http://localhost:${PORT}`);
});