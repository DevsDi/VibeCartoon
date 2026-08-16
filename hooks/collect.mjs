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
// （api_key/token/secret/password/authorization/credential/证书块等，另含
//   private_key / access_key / aws_session_token，均为常见密钥字段名）
const REDACT_KEY =
  /api[_-]?key|token|secret|password|authorization|credential|BEGIN[\s\S]*KEY|private_key|access_key|aws_session_token/i;

// 值级敏感字段：字符串值命中常见密钥样式即替换为 [REDACTED]（大小写敏感）
//   sk-*              -> Anthropic 密钥
//   Bearer            -> 认证头令牌
//   ghp_ / gho_ / ghr_ / ghu_ / github_pat_ -> GitHub Personal / OAuth / Refresh / Server-to-server / Fine-grained PAT
//   xoxb/a/p/r/s-     -> Slack token
//   AKIA              -> AWS Access Key ID（AKIA + 16 位大写字母/数字）
//   eyJ...            -> JWT（Base64url 头），独立于 Bearer 前缀的裸 JWT 也能命中
//     注：eyJ 前缀也可能出现在非 JWT 的 Base64 字符串中（如含 JSON 的 Base64 编码），
//     但采用"宁严勿漏"策略——误伤仅导致多脱敏一小段文本（false positive 可接受，不丢数据），
//     而漏过 JWT 则会泄露认证凭证（false negative 不可接受）。
//   aws_session_token -> AWS 会话令牌（值紧跟键名，如 "aws_session_token=+F...=="）
const REDACT_VALUE =
  /sk-[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9._\-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9_]{8,}|ghu_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}|aws_session_token[A-Za-z0-9/+_=\-]{10,}/g;

// 读入 stdin 的总字节上限：8MB，超出直接丢弃本条事件（不崩，恒 exit 0）
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
// 参与解析/拷贝的原始 JSON 字节上限：1MB，先按字节截断再解析，避免超大对象拷贝撑爆内存
const MAX_INPUT_BYTES = 1 << 20;

// 普通字符串截断阈值（按码点截断，避免切出孤立代理对）
const MAX_STR = 250;
// 序列化后的 detail 总长度上限（按码点截断）
const DETAIL_CAP = 2000;

// ---------------------------------------------------------------------------
// 读 stdin
// ---------------------------------------------------------------------------
async function readStdin() {
  // 终端直接运行且无管道输入时避免挂死（空 Buffer，走正常空 JSON 路径）
  if (process.stdin.isTTY) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    // 累计超过读入上限：整条丢弃，返回 null，由 main 处理为退出 0
    if (total > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  // 返回 Buffer 而非字符串，便于后续按字节 subarray 截断（视图拷贝，不再二次整串拷贝）
  return Buffer.concat(chunks);
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
// 值级敏感替换：字符串中的常见密钥样式（sk-/Bearer/ghp_/gho_/github_pat_/Slack xox*）替换为 [REDACTED]
// 整串命中 → 整体变 [REDACTED]；局部藏在长文本里 → 仅命中片段被替换，其余保留
function redactText(text) {
  return typeof text === "string" ? text.replace(REDACT_VALUE, "[REDACTED]") : text;
}

// 按 Unicode 码点（code point）截断：String.prototype.slice 按 UTF-16 码元切，会把一个由
// 高低代理位组成的增补平面字符（emoji 等）切成孤立代理对（损坏数据）。这里用 for...of 按码点
// 遍历取前 max 个码点，保证不切出孤立代理对，且零依赖（无需 Intl.Segmenter）。MAX_STR/DETAIL_CAP
// 因此语义为"码点点数"而非 UTF-16 码元数。
function truncateCodePoints(s, max) {
  if (s.length <= max) return s; // 码元长度已在预算内：码点数必然 ≤ max，直接原样返回
  let out = "";
  let n = 0; // 已取码点数
  for (const ch of s) {
    if (n >= max) break;
    out += ch;
    n++;
  }
  return out;
}

function sanitizeString(val) {
  // 私钥/密钥文本块整体替换
  if (/BEGIN[\s\S]*KEY/.test(val) || /^-----BEGIN/.test(val)) return "[REDACTED]";
  // 值级敏感匹配（脱敏后再截断，避免截断后的残留密钥片段漏出去）
  val = redactText(val);
  if (val.length > MAX_STR) return truncateCodePoints(val, MAX_STR) + "…[truncated]";
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
    // 自动同步（T2）：transcript_path / tool_use_id 独立抽取为首层字段，供
    // 服务端登记转录会话注册表（T3）与增量读转录（T5）；不进 detail 避免二次冗余。
    "transcript_path", "tool_use_id",
  ]);

  const agent = payload.agent_id ?? payload.subagent_id ?? payload.agent ?? null;
  const agentType =
    payload.agent_type ??
    payload.subagent_type ??
    payload.subagent?.agent_type ??
    payload.agent?.agent_type ??
    null;

  // tool 相关 hook 才有 tool 名。取数来源：tool_name → tool → tool_use.name；
  // 此前的"tool 为空时对 pre/post_tool_use 再查一次 tool_use.name"是死兜底——
  // 第一条 ?? 链已覆盖该来源（三次取值任一命中即非空），删除冗余分支。
  let tool = payload.tool_name ?? payload.tool ?? payload.tool_use?.name ?? null;

  let status = payload.status ?? payload.result?.status ?? payload.subagent_stop?.status ?? null;
  // 子 agent stop 失败信号：status 为 null 时，仅凭结构化失败信号判定（顶层/嵌套 error 字段存在、success === false）。
  // 禁止 message 文本匹配——成功结果的文本里出现 "error" 字样（如 "fixed the error"）会被误判为失败。
  if (status == null && (payload.error || payload.result?.error || payload.subagent_stop?.error ||
      payload.success === false)) {
    status = "error";
  }

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
  if (detail) {
    // 序列化后的整段文本再过一遍值脱敏，兜底嵌套拼接/转义等未覆盖的密钥样式残留，之后才做既有截断
    detail = redactText(detail);
    if (detail.length > DETAIL_CAP) detail = truncateCodePoints(detail, DETAIL_CAP) + "…[truncated]";
  }

  // 自动同步（T2）：transcript_path（hook payload 顶层，SubagentStart/SubagentStop 携带）→
  // 首层字段 transcriptPath；tool_use_id（pre/post_tool_use payload 顶层）→ 首层字段 toolUseId。
  // 服务端据此登记转录会话注册表、增量读转录文件，与看板状态机对账收敛。
  const transcriptPath = payload.transcript_path ?? null;
  const toolUseId = payload.tool_use_id ?? null;

  return {
    ts: new Date().toISOString(),
    hook,
    agent: typeof agent === "object" ? null : (agent ?? null),
    type: agentType ? String(agentType) : null,
    tool: tool ? String(tool) : null,
    status: status != null ? String(status) : null,
    detail,
    tok,
    transcriptPath: transcriptPath ? String(transcriptPath) : null,
    toolUseId: toolUseId ? String(toolUseId) : null,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  const raw = await readStdin().catch(async (e) => {
    await logError(`读取 stdin 失败: ${e.stack ?? e.message}`);
    return Buffer.alloc(0);
  });

  // 读入超限（> 8MB）：直接丢弃本条事件，不解析不写文件，保持恒 exit 0
  if (raw == null) {
    await logError(`stdin 超过 ${MAX_STDIN_BYTES} 字节上限，本条事件被丢弃`);
    if (DRY) console.error(`[collect] stdin 超过 ${MAX_STDIN_BYTES} 字节上限，本条事件被丢弃`);
    return 0;
  }

  // 超大输入先按字节截断（Buffer.subarray 为无拷贝视图）：截断后的 JSON 通常解析失败 → 走日志路径 exit 0，
  // 避免全量 JSON.parse + 深拷贝把内存撑爆。单条 detail 长度另由 DETAIL_CAP 限制。
  const input = (raw.length > MAX_INPUT_BYTES ? raw.subarray(0, MAX_INPUT_BYTES) : raw).toString("utf8");

  let payload;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    const snippet = String(input).slice(0, 200);
    const safeSnippet = redactText(snippet);
    await logError(`JSON 解析失败: ${err.message} | 原始输入片段: ${safeSnippet}`);
    if (DRY) console.error(`[collect] JSON 解析失败: ${err.message}\n[collect] 输入片段: ${safeSnippet}`);
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