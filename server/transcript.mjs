// server/transcript.mjs — T5/T6 转录增量读取器 + 转录解析器
//
// 从 Claude Code 转录文件（~/.claude/projects/<项目slug>/<sessionId>.jsonl）增量读取，
// 解析出权威的子 Agent 启动（Agent tool_use）与完成（<task-notification>）状态，供对账使用。
//
// T5 读取器：
//   - 复用 server.mjs 的 readFileRange 逻辑（open 后 fh.stat 取尺寸，截断/轮转时回退到 0）。
//     注意：server.mjs 顶层 await server.listen 有副作用，不可 import，故在此复制同款逻辑。
//   - 每会话水位 transcriptWatermarks: Map<sessionId, number>（byte offset）。
//   - 文件缺失 → 返回 { readable:false } 并标记该会话不可读（对账据此跳过删除）。
//
// T6 解析器：
//   - started        : assistant 行 message.content[] 中 {type:"tool_use", name:"Agent", id, input.description, async}
//   - completed      : ① queue-operation 行 <task-notification> 中每个 <task-id>（缺陷1：批量通知一个
//                      <task-notification> 内有多个 <task-id> 共用一个 <status>，且无 <tool-use-id>；
//                      <task-id> 本身就是 agentId，与看板 key 同名），兼容历史单通知的 <tool-use-id>；
//                      任务通知是权威信号，会覆盖同 agent 先前由 tool_result 标记的 callId 级 done
//                      ② user 行 message.content[].tool_result 的「完成信号」（缺陷2，仅真实完成、非异步派发）
//                      故 key 可能是 agentId（<task-id>）或 callId（<tool-use-id>/tool_use_id）
//   - keyMap         : user 行 toolUseResult.agentId + sourceToolAssistantUUID 桥接 callId ↔ agentId

import path from "node:path";
import { createHash } from "node:crypto";
import { TRANSCRIPT_ROOT } from "../config.mjs";
// 事件文件通用区间读取（共享模块）
import { readFileRange, closeHandle } from "./file-utils.mjs";

// ---------------------------------------------------------------------------
// T5 会话水位
// ---------------------------------------------------------------------------
const watermarks = new Map(); // sessionId -> byte offset

export function getWatermark(sessionId) {
  return watermarks.get(sessionId) ?? 0;
}

export function resetWatermark(sessionId) {
  watermarks.delete(sessionId);
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------
// 由 cwd 推导项目 slug（与 Claude Code 约定一致）：把 :、\、/、空格 全部替换为 '-'。
// 例：D:\workspace\Vibe Cartoon → D--workspace-Vibe-Cartoon
// 注意：Windows 下 slug 大小写不稳定（cwd 传入时可能小写 d），但文件系统大小写不敏感，可正常命中。
// slug 长度上限（防御极端/恶意 cwd 产生超长路径，Windows MAX_PATH=260）。实际 Claude Code
// slug 远小于此（如 D--workspace-Vibe-Cartoon-vc-dashboard），仅对超长 cwd 防御性截断。
const SLUG_MAX_LEN = 100;
export function slugFromCwd(cwd) {
  const slug = String(cwd || "").replace(/[:/\\ ]/g, "-");
  if (slug.length <= SLUG_MAX_LEN) return slug;
  // 超长截断：保留前 SLUG_MAX_LEN-9 字符主体，追加 8 位 SHA-256 短哈希后缀，
  // 避免不同 cwd 截断到同一前缀时 slug 撞名（截断后总长恰为 SLUG_MAX_LEN）。
  const hash = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  return slug.slice(0, SLUG_MAX_LEN - 9) + "-" + hash;
}

/**
 * 解析会话转录文件路径。优先使用注册表捕获的 transcriptPath（权威，避免 slug 大小写推导差异）；
 * 该路径作为文件读取目标前须校验位于 TRANSCRIPT_ROOT（~/.claude/projects）之下，越界则拒绝
 * 并回退 cwd 推导（修复项 L1：防异常/恶意注册路径被当作任意文件读取）；
 * 否则由 cwd + sessionId 推导（claude agents --json 提供的活跃会话）。
 * @param {string} sessionId
 * @param {string|null} cwd
 * @param {string|null} registeredPath 注册表已捕获的 transcript_path
 * @returns {string|null} 解析不出（缺 cwd 或无 sessionId，或注册路径越界）时为 null
 */
export function resolveSessionPath(sessionId, cwd, registeredPath) {
  if (registeredPath) {
    // 合法性校验：path.resolve 统一分隔符并解析 .. 后，判断规范化路径是否落在 TRANSCRIPT_ROOT
    // 之下（前缀比较必须带 path.sep，避免 TRANSCRIPT_ROOT 的兄弟目录如 projects_evil 误判命中）。
    // Windows 文件系统大小写不敏感，比较前统一小写，避免合法路径因大小写差异被误拒（误拒只是
    // 回退 cwd 推导，无数据风险，但应尽量避免）。
    const root = path.resolve(TRANSCRIPT_ROOT);
    const resolved = path.resolve(registeredPath);
    const lower = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    if (lower(resolved).startsWith(lower(root) + path.sep)) return registeredPath;
    return null;
  }
  if (!sessionId || !cwd) return null;
  return path.join(TRANSCRIPT_ROOT, slugFromCwd(cwd), sessionId + ".jsonl");
}

// ---------------------------------------------------------------------------
// T5 会话转录增量读取
// ---------------------------------------------------------------------------
/**
 * 读取一个会话转录文件的增量（自该会话水位到当前文件末尾）。
 * 首读时水位为 0 → 全量读（对账需要完整 started 集，见 sync.mjs）。
 * @param {string} sessionId
 * @param {string} filePath 已解析出的转录文件绝对路径
 * @returns {Promise<{readable:boolean, caughtUp:boolean, lines:string[], size:number, truncated:boolean}>}
 *   readable=false  → 文件缺失/打不开（调用方标记该会话不可读，跳过删除判定）
 *   caughtUp        → 本轮已读到文件末尾（水位 == 文件尺寸；不可读时为 false）
 */
export async function readSessionTranscript(sessionId, filePath) {
  const offset = getWatermark(sessionId);
  const r = await readFileRange(filePath, offset);
  if (!r.exists) {
    return { readable: false, caughtUp: false, lines: [], size: 0, truncated: true };
  }
  watermarks.set(sessionId, r.size);
  // 截断/轮转时 readFileRange 已从 0 重读全量，水位对齐到当前尺寸即追平。
  return { readable: true, caughtUp: true, lines: r.lines, size: r.size, truncated: r.truncated };
}

// ---------------------------------------------------------------------------
// T6 转录解析器
// ---------------------------------------------------------------------------
// 提取 <tag>...</tag> 中的值。内容允许含其它标签/裸 <，但不允许内部再出现同名 <tag> 或 </tag>
//（负向前瞻保证匹配的是"最内层"同名标签对），防御转录中出现嵌套同名标签导致取值错误
//（实际 Claude Code 转录无此情况，属理论风险）。
function extractTag(content, tag) {
  const m = content.match(new RegExp(`<${tag}>((?:(?!<\\/?${tag}[\\s>])[\\s\\S])*?)</${tag}>`));
  return m ? m[1] : null;
}

// 提取 <tag>...</tag> 的所有值（缺陷1：批量通知内多个 <task-id> 共用一个 <status>）
// 与 extractTag 同款健壮正则 + 全局标志，逐段取出每个最内层同名标签对的值。
function extractAllTags(content, tag) {
  const re = new RegExp(`<${tag}>((?:(?!<\\/?${tag}[\\s>])[\\s\\S])*?)</${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(content))) out.push(m[1]);
  return out;
}

// 把转录通知状态归一化为看板状态：completed→done；failed/killed/stopped→failed；
// 其余（含 running，通知仅在停止时触发）→ running（视为未终态，不触发僵尸修复）
function normalizeStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "completed") return "done";
  if (s === "failed" || s === "killed" || s === "stopped") return "failed";
  return "running";
}

// 不完整桥接兜底清理阈值（reconcile 轮次）：某 uuid 桥接条目在 INCOMPLETE_BRIDGE_ROUNDS 轮
// reconcile 内既未出现终态（done/failed）、也未完成配对时，判定该桥接不会再收敛——转录文件在
// assistant 行后被截断/轮转、异步 agent 的 user 行始终未写入、或完成证据丢失——从映射中清理，
// 避免「永远等待」的 uuid 条目无界驻留。覆盖两类：
//   ① 未配对：assistant 行已读（uuidCall 有记录）、user 桥接行始终未出现；
//   ② 有配对但无终态：桥接已形成（uuidAgent 配对），但 agentId/callId 级终态信号均缺失
//      （如同步 Agent 的 tool_result 完成信号丢失，或异步 Agent 的任务通知未写入）。
// 宽限留量：正常 agent（含异步）在派发/完成后 1~2 轮 reconcile 内即出现配对或终态信号，
// N 轮足以覆盖写入时延，不误伤在途桥接。
const INCOMPLETE_BRIDGE_ROUNDS = 3;

/**
 * 创建一个转录解析器：跨多次增量读累积三份映射。
 * @returns {{ started:Map, completed:Map, keyMap:Map, ingestLine:Function, buildKeyMap:Function, pruneBridges:Function }}
 *   started   : Map<callId, { description, uuid, async, ts }>
 *   completed : Map<callId|agentId, "done"|"failed"|"running">（同 key 取最新，后写覆盖；
 *               task-id 通知以 agentId 为 key，tool_result/历史 tool-use-id 以 callId 为 key）
 *   keyMap    : Map<callId, agentId>（需调用 buildKeyMap() 构建）
 *   pruneBridges() : 清理已提交桥接且 agent 已达终态（agentId 级任务通知或 callId 级 tool_result，
 *                    同步 Agent 只产生后者）的 uuidCall/uuidAgent 条目；未达终态的条目（未配对、
 *                    或有配对但终态信号缺失）超过 INCOMPLETE_BRIDGE_ROUNDS 轮 reconcile 亦兜底
 *                    清理（有界化，见实现处注释）
 */
export function createTranscriptParser() {
  const started = new Map();   // callId -> { description, uuid, async, ts }
  const completed = new Map(); // callId|agentId -> done/failed/running（最新覆盖）
  const keyMap = new Map();    // callId -> agentId（桥接结果）
  const uuidCall = new Map();  // assistant uuid -> callId（内部桥接用）
  const uuidAgent = new Map(); // assistant uuid -> agentId（内部桥接用）
  const uuidSeen = new Map();  // uuid -> 首次进入任一桥接映射的 reconcile 轮次（不完整桥接兜底清理基准）
  let round = 0;               // reconcile 轮次（pruneBridges 每被调用一次 +1，对应一次对账）

  // 任务通知以 agentId（<task-id>）为权威：把该 agent 之前由 tool_result 标记的 callId 级 done
  // 同步为通知状态，保证「后到的通知为准」（批量 stopped 通知晚于其各子 Agent 的 tool_result）
  function reconcileCompleted(agentId, status) {
    for (const [uuid, aId] of uuidAgent) {
      if (aId !== agentId) continue;
      const callId = uuidCall.get(uuid);
      if (callId && completed.get(callId) !== status) completed.set(callId, status);
    }
  }

  function ingestLine(line) {
    // 残缺行（写盘竞态 / 半截 JSON）跳过
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || typeof e !== "object") return;

    // ① assistant 行：message.content[] 中 {type:"tool_use", name:"Agent", id, input.description}
    if (e.type === "assistant" && e.uuid && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c && c.type === "tool_use" && c.name === "Agent" && c.id) {
          const desc =
            c.input && typeof c.input.description === "string" ? c.input.description : null;
          started.set(c.id, { description: desc, uuid: e.uuid, async: !!(c.input && c.input.async), ts: e.timestamp || null });
          uuidCall.set(e.uuid, c.id);
          if (!uuidSeen.has(e.uuid)) uuidSeen.set(e.uuid, round); // 记录首见轮次（兜底清理基准）
        }
      }
      return;
    }

    // ② user 行：toolUseResult.agentId + sourceToolAssistantUUID 桥接 callId ↔ agentId，
    //    同时解析 message.content[].tool_result 的完成信号（缺陷1/缺陷3，仅真实完成、非异步派发）
    if (e.type === "user") {
      if (e.message && Array.isArray(e.message.content)) {
        for (const c of e.message.content) {
          if (c && c.type === "tool_result" && typeof c.tool_use_id === "string" && c.tool_use_id) {
            const callId = c.tool_use_id;
            // 本行常携带 toolUseResult.agentId，可据此判断该 agent 是否已被任务通知（agentId 级）标记
            const agentId =
              e.toolUseResult && typeof e.toolUseResult.agentId === "string" ? e.toolUseResult.agentId : null;
            const s = started.get(callId);
            // 异步派发判定（缺陷1）：旧版信号在 assistant 派发行的 input.async（started.async），
            // 当前 Claude Code 的 async 派发行 input 不含 async 字段，异步性只在 toolUseResult 里以
            // isAsync:true / status:"async_launched" 标识，任一命中即视为异步启动。
            // 异步启动的 tool_result（async_launched）不作为完成信号——否则仍在运行的 async Agent
            // 每次 sync 都会被误标 done（endTime 被写入）。
            const asyncLaunch =
              !!(e.toolUseResult &&
                (e.toolUseResult.isAsync === true ||
                 e.toolUseResult.status === "async_launched"));
            // 仅处理：已启动的 Agent 调用 + 非异步派发（含新版本 toolUseResult 异步信号）+
            // 尚未被任务通知/tool_result 标记。结果 is_error:true → failed（缺陷3，作为终止证据，
            // 失败的 Agent 派发不再永久回填为 queued）；正常 → done。
            if (s && !s.async && !asyncLaunch && !completed.has(callId) &&
                !(agentId && completed.has(agentId))) {
              completed.set(callId, c.is_error === true ? "failed" : "done");
            }
          }
        }
      }
      if (e.sourceToolAssistantUUID && e.toolUseResult &&
          typeof e.toolUseResult.agentId === "string" && e.toolUseResult.agentId) {
        uuidAgent.set(e.sourceToolAssistantUUID, e.toolUseResult.agentId);
        if (!uuidSeen.has(e.sourceToolAssistantUUID)) uuidSeen.set(e.sourceToolAssistantUUID, round);
      }
      return;
    }

    // ③ queue-operation 行：<task-notification> 的 <task-id> 列表 + <status>
    if (e.type === "queue-operation" && typeof e.content === "string" && e.content.includes("<task-notification>")) {
      const status = normalizeStatus(extractTag(e.content, "status"));
      if (status === "running") return; // 未终态通知（如 monitor 入队）不参与完成判定
      // 缺陷1：一个 <task-notification> 内可有多个 <task-id> 共用一个 <status>（批量通知，无 <tool-use-id>）。
      // <task-id> 本身就是 agentId，与看板 key 同名，故直接以 agentId 为 completed 的 key。
      const taskIds = extractAllTags(e.content, "task-id").filter(Boolean);
      for (const taskId of taskIds) {
        completed.set(taskId, status);
        reconcileCompleted(taskId, status);
      }
      // 兼容历史单通知的 <tool-use-id>（callId 级）
      const toolUseId = extractTag(e.content, "tool-use-id");
      if (toolUseId) completed.set(toolUseId, status);
      return;
    }
    // 其余行类型不参与解析
  }

  // 桥接：assistant uuid（sourceToolAssistantUUID）→ callId，user 行同 uuid → agentId
  function buildKeyMap() {
    for (const [uuid, callId] of uuidCall) {
      const agentId = uuidAgent.get(uuid);
      if (agentId) keyMap.set(callId, agentId);
    }
  }

  // 清理已消费的 uuid 桥接条目（修复项1：uuidCall/uuidAgent 跨会话无界增长）。
  // 清理时机（任一满足即删）：
  //   A. 终态：桥接已提交到 keyMap 且 agent 已达终态（done/failed）——此时该 uuid 映射
  //      已不再需要：
  //       ① 桥接结果已持久化在 keyMap（callId→agentId），后续查询/对账不依赖 uuid 映射；
  //       ② 终态后不会再收到新的完成通知；即便有（如批量 stopped 覆盖单个 completed），
  //          agentId 级 completed 仍是权威，僵尸修复直接按 agentId 键查对账，
  //          callId 级传播缺失可自愈（最多一次「回填→立即修复」抖动），不破坏最终收敛。
  //      终态检查须同时覆盖 agentId 级（<task-id> 任务通知）与 callId 级（tool_result 完成
  //      信号）——同步 Agent 只经 tool_result 产生 callId 级 done、从不收到 agentId 级
  //      任务通知，仅查 agentId 会让其桥接条目永不清理（修复项 L2）。
  //   B. 超时：未达终态的条目（未配对、或有配对但终态信号缺失），以其「首见 reconcile 轮次」
  //      为基准，超过 INCOMPLETE_BRIDGE_ROUNDS 轮仍未收敛即兜底清理（修复项 X / 修复项 M1）。
  //      宽限留量：正常 agent（含异步）在派发/完成后 1~2 轮 reconcile 内即出现配对或终态信号，
  //      N 轮宽限不误伤在途桥接；超宽限仍未收敛的条目保留无意义——keyMap 桥接已持久化，
  //      晚到的任务通知仍可由 agentId 级 completed 直查看板（僵尸修复），不破坏最终收敛。
  // 故两 Map 的量级始终受「宽限窗口内的在途桥接 + 近期终态桥接」限制，长期运行下有界。
  function pruneBridges() {
    round++; // 本轮 reconcile（调用方每次对账调用一次本函数）
    for (const [uuid, callId] of uuidCall) {
      const agentId = uuidAgent.get(uuid);
      if (agentId) {
        // 终态检查（修复项 L2）：agentId 级（<task-id> 任务通知）与 callId 级（tool_result，
        // 同步 Agent）任一命中即视为已消费。同步 Agent 只产生 callId 级 done、从不收到
        // agentId 级任务通知，仅查 agentId 会永不命中。
        const sAgent = completed.get(agentId);
        const sCall = completed.get(callId);
        if (sAgent === "done" || sAgent === "failed" ||
            sCall === "done" || sCall === "failed") {
          uuidCall.delete(uuid);
          uuidAgent.delete(uuid);
          uuidSeen.delete(uuid);
        } else if (round - (uuidSeen.get(uuid) ?? round) >= INCOMPLETE_BRIDGE_ROUNDS) {
          // 有配对但无任何终态（修复项 M1）：同步 Agent 的 tool_result 完成信号缺失、或
          // 异步 Agent 的任务通知始终未出现（转录截断/轮转）时，该桥接永不收敛 →
          // 与未配对条目同等超时兜底清理，防有配对条目无界驻留。
          uuidCall.delete(uuid);
          uuidAgent.delete(uuid);
          uuidSeen.delete(uuid);
        }
      } else if (round - (uuidSeen.get(uuid) ?? round) >= INCOMPLETE_BRIDGE_ROUNDS) {
        // 不完整桥接超时兜底：清掉永不配对的 uuidCall 条目（及首见轮次记录）
        uuidCall.delete(uuid);
        uuidSeen.delete(uuid);
      }
    }
    // 反向孤儿：uuidAgent 有、uuidCall 无（user 桥接行读到但 assistant 行缺失，如跨会话引用）
    // → 同样按轮次兜底清理，防 uuidAgent 侧无界驻留
    for (const [uuid, agentId] of uuidAgent) {
      if (uuidCall.has(uuid)) continue; // 有配对 → 交由上方逻辑按终态/超时处理
      if (round - (uuidSeen.get(uuid) ?? round) >= INCOMPLETE_BRIDGE_ROUNDS) {
        uuidAgent.delete(uuid);
        uuidSeen.delete(uuid);
      }
    }
  }

  return { started, completed, keyMap, ingestLine, buildKeyMap, pruneBridges };
}
