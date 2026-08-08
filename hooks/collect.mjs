// hooks/collect.mjs — T1 事件采集器
//
// 单点职责：读取 stdin 的一条 Claude Code hook JSON payload
//  → 归一化 hook 类型 → 抽取字段 → 脱敏/截断 → 追加一行到 events.jsonl
//
// 约束：永不抛错、恒 exit 0。任何异常只追加到 data/collect.log，
// 避免因采集器自身故障阻塞 Claude 主流程。
//
// 用法：
//   echo '{"hook":"SubagentStart",...}' | node hooks/collect.mjs          # 写文件
//   echo '{"hook":"SubagentStart",...}' | node hooks/collect.mjs --dry    # 只打印，不写文件

import { appendFile } from "node:fs/promises";
import { EVENTS_FILE, COLLECT_LOG } from "../config.mjs";

const DRY = process.argv.includes("--dry");

// ---------------------------------------------------------------------------
// hook 名称归一化映射
// ---------------------------------------------------------------------------
const HOOK_MAP = {
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  Notification: "notification",
  // 兼容半成品/小写写法，保持幂等
  subagent_start: "subagent_start",
  subagent_stop: "subagent_stop",
  pre_tool_use: "pre_tool_use",
  post_tool_use: "post_tool_use",
  notification: "notification",
};

// 脱敏黑名单：字段名匹配即整体替换为 [REDACTED]
const REDACT_KEY = /api[_-]?key|token|secret|password|authorization|credential|BEGIN[\s\S]*KEY/i;
// 普通字符串截断阈值
const MAX_STR = 250;
// 序列化后的 detail 总长度上限
const DETAIL_CAP = 2000;

// ---------------------------------------------------------------------------
// 读 stdin
// ---------------------------------------------------------------------------
async function readStdin() {
  // 终端直接运行且无管道输入时避免挂死
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// 日志（异常时只追加 collect.log，绝不抛出）
// ---------------------------------------------------------------------------
async function logError(msg) {
  const t = new Date().toISOString();
  try {
    await appendFile(COLLECT_LOG, `[${t}] ${msg}\n`, { flag: "a", encoding: "utf8" });
  } catch {
    // 连日志都写不了时静默放弃，保证恒 exit 0
  }
}

// ---------------------------------------------------------------------------
// 脱敏与截断
// ---------------------------------------------------------------------------
function sanitizeString(val) {
  // 私钥/密钥文本块整体替换
  if (/BEGIN[\s\S]*KEY/.test(val) || /^-----BEGIN/.test(val)) return "[REDACTED]";
  if (val.length > MAX_STR) return val.slice(0, MAX_STR) + "…[truncated]";
  return val;
}

function sanitizeValue(key, val) {
  // 命中黑名单字段名（含数组元素再走一次 key 判断）——数组下标不是敏感名，故递归时传空 key
  if (REDACT_KEY.test(String(key))) return "[REDACTED]";
  if (Array.isArray(val)) return val.map((v) => sanitizeValue("", v));
  if (val && typeof val === "object") return sanitizeObject(val);
  if (typeof val === "string") return sanitizeString(val);
  return val;
}

function sanitizeObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEY.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = sanitizeValue(k, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 归一化 + 字段抽取
// ---------------------------------------------------------------------------
function buildLine(payload) {
  // 兼容三种来源：hook / hook_event_name（Claude Code hooks）/ type（Claude 事件流）
  const rawHook = payload.hook ?? payload.hook_event_name ?? payload.type;
  const hook = rawHook != null ? (HOOK_MAP[String(rawHook)] ?? String(rawHook)) : "unknown";

  // 已抽取为独立字段的键，不再进入 detail
  const EXCLUDED = new Set([
    "hook", "hook_event_name", "type", "ts",
    "agent_id", "subagent_id", "agent", "subagent",
    "agent_type", "subagent_type",
    "tool_name", "tool", "tool_use",
    "status", "tok", "total_tokens", "usage",
  ]);

  const agent = payload.agent_id ?? payload.subagent_id ?? payload.agent ?? null;
  const agentType =
    payload.agent_type ??
    payload.subagent_type ??
    payload.subagent?.agent_type ??
    payload.agent?.agent_type ??
    null;

  // tool 相关 hook 才有 tool 名
  let tool = payload.tool_name ?? payload.tool ?? payload.tool_use?.name ?? null;
  if (tool == null && (hook === "pre_tool_use" || hook === "post_tool_use")) tool = payload.tool_use?.name ?? null;

  let status = payload.status ?? payload.result?.status ?? payload.subagent_stop?.status ?? null;
  // Claude 事件流里 subagent_stop 的成败用 error/status 表达
  if (status == null && payload.error) status = "error";

  let tok = payload.tok;
  if (tok == null && payload.total_tokens != null) tok = payload.total_tokens;
  if (tok == null && payload.usage) {
    tok = payload.usage.total_tokens ?? payload.usage.output_tokens ?? payload.usage.input_tokens;
  }
  tok = tok == null ? null : Number(tok);

  // detail：剩余字段整体脱敏截断（notification 的 message 保留，便于告诉看板 asking 状态）
  const detailObj = sanitizeObject(payload);
  for (const k of [...EXCLUDED]) delete detailObj[k];
  let detail = Object.keys(detailObj).length > 0 ? JSON.stringify(detailObj) : null;
  if (detail && detail.length > DETAIL_CAP) detail = detail.slice(0, DETAIL_CAP) + "…[truncated]";

  return {
    ts: new Date().toISOString(),
    hook,
    agent: typeof agent === "object" ? null : (agent ?? null),
    type: agentType ? String(agentType) : null,
    tool: tool ? String(tool) : null,
    status: status != null ? String(status) : null,
    detail,
    tok,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  const input = await readStdin().catch(async (e) => {
    await logError(`读取 stdin 失败: ${e.stack ?? e.message}`);
    return "";
  });

  let payload;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    const snippet = String(input).slice(0, 200);
    await logError(`JSON 解析失败: ${err.message} | 原始输入片段: ${snippet}`);
    if (DRY) console.error(`[collect] JSON 解析失败: ${err.message}\n[collect] 输入片段: ${snippet}`);
    return 0;
  }

  let line;
  try {
    line = buildLine(payload);
  } catch (err) {
    await logError(`构建事件失败: ${err.stack ?? err.message}`);
    if (DRY) console.error(`[collect] 构建事件失败: ${err.message}`);
    return 0;
  }

  if (DRY) {
    console.log(JSON.stringify(line, null, 2));
    return 0;
  }

  try {
    await appendFile(EVENTS_FILE, JSON.stringify(line) + "\n", { flag: "a", encoding: "utf8" });
  } catch (err) {
    await logError(`追加事件文件失败 (${EVENTS_FILE}): ${err.stack ?? err.message}`);
  }
  return 0;
}

// 恒 exit 0：即使上面漏网异步异常也不抛到顶层
main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 0; });