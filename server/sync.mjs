// server/sync.mjs — T3 转录会话注册表 + T7 对账/收敛逻辑
//
// 核心原理：从 Claude Code 转录文件增量读取，解析出权威的子 Agent 启动/完成状态，
// 与看板 events.jsonl 状态机（agents Map）diff 收敛：
//   - 回填      : 转录有 Agent tool_use、看板无该 agent → 补建（queued）；已出现终止证据的不再回填
//   - 僵尸修复  : 转录有 <task-notification> 完成通知、看板仍 running → 立即置 done/failed
//   - 过期删除  : 看板有、转录无记录（或已出现终止证据），且「至少读过一次 + scope 内会话全部可读 +
//                lastSeen 超时」→ 删除；有启动但无终止证据且看板非存活态 → 超时兜底置 failed/删除（main 豁免）
//
// T3 注册表：内存 Map<sessionId, { path, lastSeenTs }>，登记事件携带的 transcriptPath
//   - 来源一：增量读 events.jsonl 时 registerEvent()
//   - 来源二：服务启动 rebuildRegistryFromEvents() 扫事件文件尾部重建
//   - TTL 过期清理并入 cleanupInactiveAgents 定时循环（pruneTranscriptRegistry）

import path from "node:path";
import { open as openFile } from "node:fs/promises";
import { SYNC_STALE_REMOVE_MS, TRANSCRIPT_REGISTRY_TTL_MS } from "../config.mjs";
import { listActiveSessions } from "./claude-sessions.mjs";
import {
  createTranscriptParser,
  readSessionTranscript,
  resolveSessionPath,
  resetWatermark,
} from "./transcript.mjs";

// ---------------------------------------------------------------------------
// T3 转录会话注册表
// ---------------------------------------------------------------------------
const transcriptPaths = new Map(); // sessionId -> { path, lastSeenTs }

// 注册表重建时扫事件文件尾部的字节数上限（1MB，足够覆盖近期事件；避免整读超大文件）
const REGISTRY_REBUILD_TAIL_BYTES = 1 * 1024 * 1024;

// 从事件行提取 transcriptPath：优先顶层 transcriptPath（T2 新增字段），
// 其次 detail.transcript_path（兼容 T2 上线前的历史事件，供启动重建注册表用）。
function extractTranscriptPath(e) {
  if (e && typeof e.transcriptPath === "string" && e.transcriptPath) return e.transcriptPath;
  if (e && typeof e.detail === "string") {
    try {
      const d = JSON.parse(e.detail);
      if (d && typeof d.transcript_path === "string" && d.transcript_path) return d.transcript_path;
    } catch { /* detail 不是合法 JSON，忽略 */ }
  }
  return null;
}

// 由 transcriptPath 提取 sessionId：basename 去掉 .jsonl 后缀
function sessionIdFromPath(p) {
  const base = path.basename(String(p)).replace(/\.jsonl$/i, "");
  return base || null;
}

/**
 * 登记一条事件携带的转录会话（来源一：增量读 events.jsonl 时逐条调用）。
 * @returns {boolean} 是否实际登记/刷新了一个会话
 */
export function registerEvent(e) {
  const tp = extractTranscriptPath(e);
  if (!tp) return false;
  const sessionId = sessionIdFromPath(tp);
  if (!sessionId) return false;
  transcriptPaths.set(sessionId, { path: tp, lastSeenTs: Date.now() });
  return true;
}

// 注册表 TTL 清理（并入 cleanupInactiveAgents 定时循环）：超时未刷新 → 删除并复位该会话水位
export function pruneTranscriptRegistry() {
  const now = Date.now();
  for (const [sessionId, entry] of transcriptPaths) {
    if (now - entry.lastSeenTs > TRANSCRIPT_REGISTRY_TTL_MS) {
      transcriptPaths.delete(sessionId);
      resetWatermark(sessionId);
    }
  }
}

async function closeHandle(fh) {
  try { await fh.close(); } catch { /* 忽略 */ }
}

/**
 * 服务启动扫 events.jsonl 尾部既有事件重建注册表（来源二）。
 * @returns {Promise<number>} 实际登记/刷新的会话数
 */
export async function rebuildRegistryFromEvents(eventsFile) {
  let fh;
  try {
    fh = await openFile(eventsFile, "r");
  } catch {
    return 0; // 事件文件不存在，无需重建
  }
  try {
    const size = (await fh.stat()).size;
    const tail = Math.min(size, REGISTRY_REBUILD_TAIL_BYTES);
    const buf = Buffer.alloc(tail);
    const { bytesRead } = await fh.read(buf, 0, tail, Math.max(0, size - tail));
    const text = buf.subarray(0, bytesRead).toString("utf8");
    let registered = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try { if (registerEvent(JSON.parse(line))) registered++; } catch { /* 残缺行跳过 */ }
    }
    return registered;
  } finally {
    await closeHandle(fh);
  }
}

// ---------------------------------------------------------------------------
// T7 对账/收敛
// ---------------------------------------------------------------------------
// 存活态集合：对账只"僵尸修复"这些状态（queued/thinking/tool/asking）
const ACTIVE_STATUSES = new Set(["queued", "thinking", "tool", "asking"]);

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(String(status || ""));
}

// 权威转录解析器（模块级累积）：跨多次 reconcile 保留完整 started/completed/keyMap。
// 首读某会话时水位为 0 → 全量读（对账需要完整 started 集）；之后仅增量补充新行。
const parser = createTranscriptParser();

/**
 * 执行一次对账（T7）：遍历 agents Map 与转录权威集 diff 收敛。
 * 直接改内存 agents Map（不走 applyEvent，避免与事件状态机互踩），不写 events.jsonl。
 * @param {{ agents:Map, agentNames:Map, newAgent:Function, pushHistory:Function }} deps
 *   server.mjs 传入其持有的共享状态与工具函数。
 * @returns {Promise<{ok:boolean, degraded:boolean, scannedSessions:number, transcriptRead:number,
 *                     backfilled:number, fixedZombies:number, removed:number}>}
 */
export async function reconcile(deps) {
  const { agents, agentNames, newAgent, pushHistory } = deps;
  const now = new Date().toISOString();
  const nowTs = Date.now();
  const stats = { scannedSessions: 0, transcriptRead: 0, backfilled: 0, fixedZombies: 0, removed: 0 };

  // 1) 枚举活跃顶层会话（claude 不可用 → 降级为注册表模式）
  const sessionsRes = await listActiveSessions();
  const degraded = !sessionsRes.ok;
  const sessionsById = new Map();
  if (sessionsRes.ok) {
    for (const s of sessionsRes.sessions) sessionsById.set(s.sessionId, s);
  }

  // 2) 会话集 = 活跃会话 ∪ 注册表会话
  const sessionIds = new Set([...sessionsById.keys(), ...transcriptPaths.keys()]);

  // 3) 增量读各会话转录，累积权威映射
  let anyRead = false;    // 是否至少成功读过一次转录（无 → 不做删除，因缺少权威依据）
  let allReadable = true; // 看板 scope 内所有尝试会话都可读（scope 内任一会话不可读 → 保守跳过删除）
  for (const sessionId of sessionIds) {
    stats.scannedSessions++;
    const reg = transcriptPaths.get(sessionId);
    const active = sessionsById.get(sessionId);
    // 缺陷1：kind=background 的后台子 Agent 会话不在看板 scope。其转录缺失/无法定位时直接剔除出
    // 扫描集，不再置 allReadable=false，避免一个孤儿后台会话（如 VideoModel 遗留 background 会话）
    // 一票否决全部删除；仅在 scope 内（main 交互会话/注册表会话）的不可读才保守阻塞删除。
    const inScope = !active || active.kind !== "background";
    const filePath = resolveSessionPath(sessionId, active?.cwd ?? null, reg?.path ?? null);
    if (!filePath) {
      if (!inScope) continue; // 后台会话无法定位 → 剔除出扫描集，不阻塞删除
      allReadable = false;
      continue;
    }
    const r = await readSessionTranscript(sessionId, filePath);
    if (!r.readable) {
      if (!inScope) continue; // 后台会话转录缺失 → 剔除出扫描集，不阻塞删除
      allReadable = false;
      continue;
    }
    anyRead = true;
    stats.transcriptRead++;
    for (const line of r.lines) parser.ingestLine(line);
  }
  parser.buildKeyMap();

  // 4) 权威集：started（key = 桥出的 agentId，桥不出 → 合成 sync:<callId>）
  const authoritative = new Map();
  for (const [callId, info] of parser.started) {
    const agentId = parser.keyMap.get(callId);
    const key = agentId || `sync:${callId}`;
    const rec = authoritative.get(key) ?? {
      callId,
      agentId,
      description: info.description,
      ts: info.ts || null, // 转录真实启动时间（transcript.mjs started 记录附带 ts 字段透传，回填用）
      status: "running",
    };
    if (parser.completed.has(callId)) rec.status = parser.completed.get(callId);
    authoritative.set(key, rec);
  }

  // 5) 回填：started 有、看板无 → 补建
  for (const [key, rec] of authoritative) {
    if (agents.has(key)) continue;
    // 缺陷2配套：已出现终止证据（done/failed）的 Agent 不再回填 —— 否则删除后会被回填再次拉起，
    // 形成「删除 → 回填 → 僵尸修复」的循环，过期删除永远不生效。
    if (rec.status !== "running") continue;
    const a = newAgent(key, "agent");
    a.name = rec.description || null;
    a.status = "queued";
    // 缺陷3：优先用转录真实启动时间（assistant tool_use 行 timestamp，由 transcript.mjs started
    // 记录透传为 ts），取不到再用当前时间兜底，不再伪造统一的 now 时间戳。
    a.startTime = rec.ts || now;
    a.lastSeen = now;
    agents.set(key, a);
    stats.backfilled++;
  }

  // 6) 僵尸修复：completed 有完成证据（done/failed）且看板 agent 在存活态 → 立即置 done/failed（killed→failed 已在 normalizeStatus 归一）
  //    缺陷2：completed 的 key 有两类——agentId（<task-id> 通知，与看板 key 同名）或 callId
  //    （tool_result / 历史 <tool-use-id>，经 keyMap 桥成 agentId）。started 里的 key 都是 callId，
  //    可据此判别：callId 键走 keyMap 桥接 / sync:<callId> 兜底；agentId 键直接 agents.get(key)
  //    （此前对 agentId 键用 keyMap.get(agentId) → undefined → 合成 sync:<agentId> 永远匹配不到
  //    看板 agent，僵尸修复实际只走 callId 路径，计数低估）。
  for (const [key, status] of parser.completed) {
    if (status !== "done" && status !== "failed") continue; // running 等未终态不触发
    let a;
    if (parser.started.has(key)) {
      // callId 键：桥成 agentId，桥不出用 sync:<callId> 兜底
      const bridged = parser.keyMap.get(key);
      a = (bridged && agents.get(bridged)) || agents.get(`sync:${key}`);
    } else {
      // agentId 键：与看板 key 同名，直接查（缺陷2）
      a = agents.get(key);
    }
    if (!a || !isActiveStatus(a.status)) continue;
    a.status = status;
    a.endTime = now;
    a.lastSeen = now;
    pushHistory(a, status === "done" ? "done" : "error");
    stats.fixedZombies++;
  }

  // 7) 过期删除：看板有、转录无记录（或已出现终止证据 / 无终止证据但看板非存活态），
  //    且「至少读过一次 + scope 内会话全部可读 + lastSeen 超 SYNC_STALE_REMOVE_MS」→ 删除。
  //    缺陷2语义修正：转录有记录 ≠ 永远豁免 ——
  //      ① 有启动且已出现终止证据（completed 通知/tool_result/批量停止）→ 不再豁免删除；
  //      ② 有启动但无终止证据、且看板不在存活态 → 按 lastSeen 超时兜底「置 failed 后删除」；
  //      ③ 有启动、无终止证据、看板仍在存活态 → 视为正在运行，保留（唯一豁免）。
  //    main 硬性豁免。对账删除与 60s 定时回收（cleanupInactiveAgents）同改 agents Map，
  //    Node 单线程下无竞态；两者都用 [...map] 快照遍历，删除安全。
  const canRemove = anyRead && allReadable;
  if (canRemove) {
    for (const [key, a] of [...agents]) {
      if (key === "main") continue; // main 硬性豁免，绝不删除
      const rec = authoritative.get(key);
      // 有启动、无终止证据、看板仍在存活态 → 正在运行，保留
      if (rec && rec.status === "running" && isActiveStatus(a.status)) continue;
      const parsed = a.lastSeen ? Date.parse(a.lastSeen) : NaN;
      if (!Number.isFinite(parsed)) continue; // lastSeen 缺失 → 不删除（保守）
      if (nowTs - parsed > SYNC_STALE_REMOVE_MS) {
        // 兜底：有启动但无任何终止证据、且看板不在存活态 → 先置 failed 再删除
        if (rec && rec.status === "running") {
          a.status = "failed";
          a.endTime = now;
          a.lastSeen = now;
          pushHistory(a, "error");
        }
        agents.delete(key);
        agentNames.delete(key);
        stats.removed++;
      }
    }
  }

  return {
    ok: !degraded,
    degraded,
    scannedSessions: stats.scannedSessions,
    transcriptRead: stats.transcriptRead,
    backfilled: stats.backfilled,
    fixedZombies: stats.fixedZombies,
    removed: stats.removed,
  };
}
