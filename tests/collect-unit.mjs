// tests/collect-unit.mjs — hooks/collect.mjs 单元测试（纯 Node，零依赖）
//
// 直接通过 child_process 以 --dry 模式调用采集器（不写 events.jsonl）：
//   node hooks/collect.mjs --dry < stdin
// 断言采集器自身的核心契约：
//   1. 值级脱敏：sk-*/Bearer/AKIA/eyJ(JWT 头)/Slack xox*/ghr_/ghu_/github_pat_ 等密钥样式 → [REDACTED]
//   2. 字段名黑名单脱敏：private_key / access_key / aws_session_token 等 → [REDACTED]
//   3. PEM 公私钥整串 → [REDACTED]
//   4. 截断：超长字符串按 MAX_STR、序列化 detail 按 DETAIL_CAP 截断，均不切出孤立代理对
//   5. 输入限长：stdin 超过 8MB 直接丢弃，且恒 exit 0
//   6. 非法 JSON：恒 exit 0，并在 stderr 记录解析失败
//   7. 正常事件原样透传（hook 归一化，字段不被误删/误脱敏）
//
// 运行：npm run test:unit    （要求 Node >= 18，无需浏览器/服务）

import { spawnSync } from "node:child_process";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECT = path.join("hooks", "collect.mjs");
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
// 与 hooks/collect.mjs 中的截断阈值保持一致（测试只做断言依据，不参与采集逻辑）
const MAX_STR = 250;
const DETAIL_CAP = 2000;

/** 以指定 stdin 执行 `node hooks/collect.mjs --dry`。
 * @param {string} input stdin 内容
 * @returns {{ code:number, stdout:string, stderr:string, line:object|null }}
 *   line 为 stdout 解析出的归一化事件对象（--dry 打印的是合法 JSON）。
 */
function runCollect(input) {
  const res = spawnSync(process.execPath, [COLLECT, "--dry"], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  let line = null;
  try { line = JSON.parse((res.stdout || "").trim()); } catch { line = null; }
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "", line };
}

/** 检测字符串是否含孤立（不成对）的 UTF-16 代理位——增补平面字符（emoji 等）被按 UTF-16
 * 半字切开时会出现损坏的孤立代理对。用于断言截断是码点安全的。
 * @param {string} s
 * @returns {boolean} true 表示含孤立代理位（截断不安全）
 */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { // 高代理位：后必须跟低代理位才算成对
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true; // 后无低代理位 → 孤立
      i++; // 跳过已配对的低代理位
    } else if (c >= 0xdc00 && c <= 0xdfff) { // 孤立低代理位
      return true;
    }
  }
  return false;
}

const suites = [];
const suite = (name, fn) => suites.push({ name, fn });

// ---------------------------------------------------------------------------
// 1) 值级脱敏
// ---------------------------------------------------------------------------
suite("值级脱敏：sk- / Bearer / ghp_ / gho_ / ghr_ / ghu_ / xox* 密钥样式 → [REDACTED]", () => {
  const SEC_SK     = "sk-ant-e2e-9876543210";
  const SEC_BEARER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0";
  const SEC_GHP    = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX";
  const SEC_GOH    = "gho_ABCDEFGHIJKLMNOPQRSTUVWX";
  const SEC_SLACK  = "xoxb-1234567890-abcdefghij";

  const payload = {
    hook: "subagent_stop",
    agent_id: "agent-e2e-secret",
    agent_type: "general-purpose",
    status: "success",
    detail: {
      result: {
        output: [
          `sk=${SEC_SK}`,
          `Authorization: Bearer ${SEC_BEARER}`,
          `github_pat=${SEC_GHP}`,
          `oauth=${SEC_GOH}`,
          `slack=${SEC_SLACK}`,
          "普通文本保持原样",
        ],
      },
    },
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");

  for (const secret of [SEC_SK, SEC_BEARER, SEC_GHP, SEC_GOH, SEC_SLACK]) {
    assert.ok(!r.stdout.includes(secret), `stdout 不应残留密钥片段: ${secret.slice(0, 12)}…`);
  }
  assert.ok(r.stdout.includes("[REDACTED]"), "stdout 应包含 [REDACTED] 替换标记");
  assert.ok(r.stdout.includes("普通文本保持原样"), "非敏感文本应原样保留");
  assert.strictEqual(r.line.status, "success", "脱敏不应影响 status 字段");
});

// ---------------------------------------------------------------------------
// 2) 输入限长：>8MB 丢弃且恒 exit 0
// ---------------------------------------------------------------------------
suite("超大输入（>8MB）被丢弃，且恒 exit 0", () => {
  const blob = "x".repeat(MAX_STDIN_BYTES + 1024); // 8MB + 1KB
  const r = runCollect(blob);

  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.strictEqual(r.stdout.trim(), "", "--dry 对丢弃事件不应输出事件行");
  assert.ok(
    r.stderr.includes("丢弃") || r.stderr.includes("上限"),
    `stderr 应记录丢弃原因（实际: ${r.stderr.slice(0, 120) || "(空)"}）`
  );
});

// ---------------------------------------------------------------------------
// 3) 正常事件原样透传
// ---------------------------------------------------------------------------
suite("正常事件原样透传（hook 归一化，字段不被误删/误脱敏）", () => {
  // 真实 subagent_start 里 prompt 是顶层字段，collect 把"剩余字段"整体变为输出 detail（见 sample-payloads.json）
  const payload = {
    hook: "SubagentStart",          // 大写 hook 应归一化为小写
    agent_id: "e2e-normal",         // 真实 hook 用 agent_id/agent_type
    agent_type: "general-purpose",
    prompt: "统计代码文件数",
    depth: 3,
    ok: true,
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  const l = r.line;
  assert.ok(l, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(l.hook, "subagent_start", "hook 应归一化为小写 subagent_start");
  assert.strictEqual(l.agent, "e2e-normal", "agent_id 映射到 agent 字段");
  assert.strictEqual(l.type, "general-purpose", "agent_type 映射到 type 字段");
  assert.strictEqual(l.status, null, "无 status 不应填充");
  assert.strictEqual(l.tool, null, "无 tool 不应填充");
  assert.deepStrictEqual(JSON.parse(l.detail), { prompt: "统计代码文件数", depth: 3, ok: true },
    "detail 内容应原样保留（不脱敏、不截断）");
  assert.ok(!r.stdout.includes("[REDACTED]"), "正常事件不应被误脱敏");
});

// ---------------------------------------------------------------------------
// 4) T2 自动同步新增字段：transcriptPath / toolUseId 首层提取且不进 detail
// ---------------------------------------------------------------------------
suite("新增字段抽取：transcriptPath / toolUseId 独立首层字段且不进 detail", () => {
  const TP = "C:\\Users\\1\\.claude\\projects\\D--workspace-Vibe-Cartoon-vc-dashboard\\session-e2e.jsonl";
  const payload = {
    hook: "SubagentStart",
    agent_id: "e2e-transcript",
    agent_type: "Task",
    transcript_path: TP,
    tool_use_id: "call_00_e2e_tool_12345",
    prompt: "测试转录字段抽取",
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.transcriptPath, TP, "transcript_path 应映射到 transcriptPath 首层字段");
  assert.strictEqual(r.line.toolUseId, "call_00_e2e_tool_12345", "tool_use_id 应映射到 toolUseId 首层字段");
  const d = JSON.parse(r.line.detail);
  assert.ok(!("transcript_path" in d), "transcript_path 不应重复出现在 detail");
  assert.ok(!("tool_use_id" in d), "tool_use_id 不应重复出现在 detail");
  assert.strictEqual(d.prompt, "测试转录字段抽取", "其余字段仍保留在 detail");
});

suite("新增字段空值：无 transcript_path / tool_use_id 不应填充", () => {
  const r = runCollect(JSON.stringify({ hook: "PreToolUse", agent_id: "e2e-x", tool_name: "Read" }));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.transcriptPath, null, "无 transcript_path 应为 null");
  assert.strictEqual(r.line.toolUseId, null, "无 tool_use_id 应为 null");
});

suite("T2 透传：transcriptPath 含空格/中文/emoji 应原样透传、不报错", () => {
  // 覆盖特殊字符路径（空格、中文、emoji）；Windows 反斜杠路径已由上方"新增字段抽取"用例覆盖，此处用正斜杠避免转义歧义
  const TP = "/data/我的 项目/会话 🎉 e2e.jsonl";
  const r = runCollect(JSON.stringify({
    hook: "SubagentStart",
    agent_id: "e2e-special-char",
    transcript_path: TP,
    prompt: "透传测试",
  }));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.transcriptPath, TP, "含特殊字符的 transcript_path 应原样透传");
  assert.ok(!hasLoneSurrogate(r.line.transcriptPath), "透传结果不应含孤立代理位");
  const d = JSON.parse(r.line.detail);
  assert.ok(!("transcript_path" in d), "transcript_path 不应重复进入 detail");
});

suite("T2 空值边界：tool_use_id 为空字符串 \"\"（非 null 但 falsy）→ 归一化为 null", () => {
  const r = runCollect(JSON.stringify({
    hook: "PreToolUse",
    agent_id: "e2e-empty-tui",
    tool_name: "Read",
    tool_use_id: "",                        // 非 null，但为 falsy
    tool_input: { file_path: "/tmp/a.txt" },
  }));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.toolUseId, null, "空字符串 tool_use_id 应归一化为 null");
  const d = JSON.parse(r.line.detail);
  assert.ok(!("tool_use_id" in d), "tool_use_id 不应重复进入 detail");
});

suite("T2 EXCLUDED：transcript_path 同时存在于顶层与 payload.detail 容器 → 顶层抽取、detail 不重复", () => {
  const TOP = "/tmp/top-level-e2e.jsonl";
  const NESTED = "/tmp/nested-e2e.jsonl";
  const payload = {
    hook: "SubagentStart",
    agent_id: "e2e-excluded",
    transcript_path: TOP,                   // 顶层 → 抽取为 transcriptPath
    tool_use_id: "call_00_excluded_1",      // 顶层 → 抽取为 toolUseId
    detail: { transcript_path: NESTED, note: "容器内容原样保留" }, // payload 自带 detail 容器，内含同名键
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.transcriptPath, TOP, "顶层 transcript_path 应抽取为 transcriptPath");
  assert.strictEqual(r.line.toolUseId, "call_00_excluded_1", "顶层 tool_use_id 应抽取为 toolUseId");

  // EXCLUDED 生效：顶层已抽取字段不再进入输出 detail（顶层值不重复）
  assert.ok(!r.line.detail.includes(TOP), "顶层 transcript_path 值不应出现在输出 detail");
  const d = JSON.parse(r.line.detail);
  assert.ok(!("transcript_path" in d), "输出 detail 顶层不应含 transcript_path 键");
  assert.ok(!("tool_use_id" in d), "输出 detail 顶层不应含 tool_use_id 键");
  assert.strictEqual(d.detail.note, "容器内容原样保留", "payload 自带 detail 容器内容应原样透传");
});

suite("T2 组合场景：payload 同时含 transcript_path 与 tool_use_id → 两字段都正确抽取", () => {
  const TP = "/data/e2e-combined.jsonl";
  const payload = {
    hook: "SubagentStart",
    agent_id: "e2e-combined",
    agent_type: "Task",
    transcript_path: TP,
    tool_use_id: "call_00_combined_777",
    tool_name: "Read",
    prompt: "组合场景",
    status: "success",
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.transcriptPath, TP, "transcript_path 应抽取为 transcriptPath");
  assert.strictEqual(r.line.toolUseId, "call_00_combined_777", "tool_use_id 应抽取为 toolUseId");
  assert.strictEqual(r.line.status, "success", "status 应同时被抽取为首层字段");
  const d = JSON.parse(r.line.detail);
  assert.ok(!("transcript_path" in d), "transcript_path 不应重复进入 detail");
  assert.ok(!("tool_use_id" in d), "tool_use_id 不应重复进入 detail");
  assert.ok(!("status" in d), "status 已被抽取，不应重复进入 detail");
  assert.strictEqual(d.prompt, "组合场景", "其余字段仍保留在 detail");
});

// ---------------------------------------------------------------------------
// 5) 字段名黑名单脱敏
// ---------------------------------------------------------------------------
suite("字段名黑名单脱敏：api_key / private_key / access_key / aws_session_token → [REDACTED]", () => {
  const payload = {
    hook: "notification",
    params: {
      api_key: "opk-eynecxi-0a9",          // 值本身不是密钥样式，仅靠字段名触发整体脱敏
      private_key: "privk-4c2f-9a1b",
      access_key: "acck-7d3e-x8",
      aws_session_token: "sven-1f2c-3d4e",
      note: "非敏感字段保持原样",
    },
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  const d = JSON.parse(r.line.detail);
  assert.strictEqual(d.params.api_key, "[REDACTED]", "api_key 字段名命中应整体脱敏");
  assert.strictEqual(d.params.private_key, "[REDACTED]", "private_key 字段名命中应整体脱敏");
  assert.strictEqual(d.params.access_key, "[REDACTED]", "access_key 字段名命中应整体脱敏");
  assert.strictEqual(d.params.aws_session_token, "[REDACTED]", "aws_session_token 字段名命中应整体脱敏");
  assert.strictEqual(d.params.note, "非敏感字段保持原样", "非敏感字段不受影响");
  for (const v of ["opk-eynecxi-0a9", "privk-4c2f-9a1b", "acck-7d3e-x8", "sven-1f2c-3d4e"]) {
    assert.ok(!r.stdout.includes(v), `stdout 不应残留敏感值: ${v.slice(0, 8)}…`);
  }
});

suite("字段名黑名单脱敏：authorization / credential / token / secret / password → [REDACTED]", () => {
  // 补齐 REDACT_KEY 正则中尚无用例覆盖的字段名分支（值本身非密钥样式，仅靠字段名命中触发整体脱敏）
  const payload = {
    hook: "notification",
    params: {
      authorization: "auth-0a1b-2c3d",
      credential: "cred-4e5f-6a7b",
      api_token: "tok-8c9d-0e1f",
      client_secret: "sec-2a3b-4c5d",
      user_password: "pwd-6e7f-8a9b",
      note: "非敏感字段保持原样",
    },
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  const d = JSON.parse(r.line.detail);
  assert.strictEqual(d.params.authorization, "[REDACTED]", "authorization 字段名命中应整体脱敏");
  assert.strictEqual(d.params.credential, "[REDACTED]", "credential 字段名命中应整体脱敏");
  assert.strictEqual(d.params.api_token, "[REDACTED]", "api_token（含 token）字段名命中应整体脱敏");
  assert.strictEqual(d.params.client_secret, "[REDACTED]", "client_secret（含 secret）字段名命中应整体脱敏");
  assert.strictEqual(d.params.user_password, "[REDACTED]", "user_password（含 password）字段名命中应整体脱敏");
  assert.strictEqual(d.params.note, "非敏感字段保持原样", "非敏感字段不受影响");
  for (const v of ["auth-0a1b-2c3d", "cred-4e5f-6a7b", "tok-8c9d-0e1f", "sec-2a3b-4c5d", "pwd-6e7f-8a9b"]) {
    assert.ok(!r.stdout.includes(v), `stdout 不应残留敏感值: ${v.slice(0, 8)}…`);
  }
});

// ---------------------------------------------------------------------------
// 6) PEM 整串脱敏
// ---------------------------------------------------------------------------
suite("PEM 公私钥整串 → [REDACTED]（不残留证书头/内容）", () => {
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "9uBCVRnZ0U8kP1yHZ2iSjOQbt4Nq6wL5",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  const r = runCollect(JSON.stringify({ hook: "notification", file: pem }));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  const d = JSON.parse(r.line.detail);
  assert.strictEqual(d.file, "[REDACTED]", "PEM 整块应整体替换为 [REDACTED]");
  assert.ok(!r.stdout.includes("BEGIN PRIVATE KEY"), "stdout 不应残留 PEM 头");
  assert.ok(!r.stdout.includes("MIIEvQ"), "stdout 不应残留 PEM 内容片段");
});

// ---------------------------------------------------------------------------
// 7) MAX_STR / DETAIL_CAP 截断（码点安全，不切出孤立代理对）
// ---------------------------------------------------------------------------
suite("截断：超长字符串按 MAX_STR 截断且不切出孤立代理对", () => {
  // ASCII 长文本
  const long = "a".repeat(480);
  const r = runCollect(JSON.stringify({ hook: "notification", note: long }));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  const d = JSON.parse(r.line.detail);
  assert.ok(d.note.endsWith("…[truncated]"), "超出 MAX_STR 应带截断标记");
  assert.ok([...d.note].length <= MAX_STR + 12, "截断后的码点数不应超过 MAX_STR + 截断标记");
  assert.ok(!hasLoneSurrogate(d.note), "ASCII 截断结果不应含孤立代理位");

  // 增补平面（emoji）：必然是代理对，截断时不允许切成孤立半字
  const emojis = "😀".repeat(300); // 300 个 emoji = 600 个 UTF-16 码元，远超 MAX_STR=250
  const r2 = runCollect(JSON.stringify({ hook: "notification", note: emojis }));
  assert.strictEqual(r2.code, 0, `exit 应为 0，实为 ${r2.code}`);
  const d2 = JSON.parse(r2.line.detail);
  assert.ok(d2.note.endsWith("…[truncated]"), "emoji 超长也应截断");
  assert.ok(!hasLoneSurrogate(d2.note), "对 emoji 截断不应切出孤立代理位");
  assert.ok([...d2.note].length <= MAX_STR + 12, "emoji 截断后的码点数应在 MAX_STR + 标记内");
});

suite("截断边界：恰好 MAX_STR 不截断，MAX_STR+1 才截断", () => {
  // 恰好 250 码点：未超限，应原样保留、不带截断标记
  const exact = "a".repeat(250);
  const r1 = runCollect(JSON.stringify({ hook: "notification", note: exact }));
  assert.strictEqual(r1.code, 0, `exit 应为 0，实为 ${r1.code}`);
  const d1 = JSON.parse(r1.line.detail);
  assert.strictEqual(d1.note, exact, "恰好 MAX_STR 码点应原样保留");
  assert.ok(!d1.note.includes("…[truncated]"), "未超限不应带截断标记");

  // 251 码点：超 1 码点即截断为 MAX_STR 码点 + 截断标记
  const over = "b".repeat(251);
  const r2 = runCollect(JSON.stringify({ hook: "notification", note: over }));
  assert.strictEqual(r2.code, 0, `exit 应为 0，实为 ${r2.code}`);
  const d2 = JSON.parse(r2.line.detail);
  assert.strictEqual([...d2.note].length, MAX_STR + 12, "MAX_STR+1 应截断为 MAX_STR 码点 + 截断标记长度");
  assert.strictEqual(d2.note.slice(0, 1), "b", "截断结果应为原文本前缀");
  assert.ok(d2.note.endsWith("…[truncated]"), "超出 MAX_STR 应带截断标记");
  assert.ok(!hasLoneSurrogate(d2.note), "边界截断不应含孤立代理位");
});

suite("截断：序列化 detail 超过 DETAIL_CAP → 追加截断标记", () => {
  // 10 个恰好 250 字符的字段：每个都不触发 MAX_STR（字段级）截断，但 JSON 序列化后
  // 约 2.6k 字符，必然超过 DETAIL_CAP=2000，从而验证 detail 级整段截断。
  const many = {};
  for (let i = 0; i < 10; i++) many["f" + i] = "x".repeat(250);
  const r = runCollect(JSON.stringify({ hook: "notification", ...many }));

  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.ok(r.line.detail.endsWith("…[truncated]"), "超出 DETAIL_CAP 应带截断标记");
  assert.ok(r.line.detail.length <= DETAIL_CAP + 12, "detail 长度不应超过 DETAIL_CAP + 截断标记");
  assert.ok(!hasLoneSurrogate(r.line.detail), "detail 截断不应含孤立代理位");
});

// ---------------------------------------------------------------------------
// 8) JSON 解析失败分支
// ---------------------------------------------------------------------------
suite("非法 JSON：畸形输入恒 exit 0，且 stderr 记录解析失败", () => {
  const r = runCollect('{ "hook": "SubagentStart", "broken": "');

  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.strictEqual(r.stdout.trim(), "", "解析失败不应输出事件行");
  assert.ok(
    r.stderr.includes("JSON 解析失败"),
    `stderr 应记录解析失败（实际: ${r.stderr.slice(0, 120) || "(空)"}）`
  );
});

// ---------------------------------------------------------------------------
// 9) AKIA 值级脱敏（AWS Access Key ID）
// ---------------------------------------------------------------------------
suite("值级脱敏：AKIA 开头的 AWS Access Key ID → [REDACTED]", () => {
  const payload = {
    hook: "notification",
    sk_test_key: "AKIA0123456789ABCDEF",
    note: "AKIA 密钥应被脱敏",
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.ok(r.stdout.includes("[REDACTED]"), "stdout 应包含 [REDACTED] 替换标记");
  assert.ok(!r.stdout.includes("AKIA0123456789ABCDEF"), "stdout 不应残留 AKIA 密钥");
  assert.ok(r.stdout.includes("AKIA 密钥应被脱敏"), "非敏感文本应原样保留");
});

// ---------------------------------------------------------------------------
// 10) JWT 值级脱敏
// ---------------------------------------------------------------------------
suite("值级脱敏：eyJ 开头的裸 JWT → [REDACTED]", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const payload = {
    hook: "notification",
    token: JWT,
    note: "JWT 应被脱敏",
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.ok(r.stdout.includes("[REDACTED]"), "stdout 应包含 [REDACTED] 替换标记");
  assert.ok(!r.stdout.includes("eyJhbGciOiJIUzI1NiJ9"), "stdout 不应残留 JWT 头");
  assert.ok(r.stdout.includes("JWT 应被脱敏"), "非敏感文本应原样保留");
});

// ---------------------------------------------------------------------------
// 11) GitHub Refresh Token（ghr_）值级脱敏
// ---------------------------------------------------------------------------
suite("值级脱敏：ghr_ 开头的 GitHub Refresh Token → [REDACTED]", () => {
  const GHR = "ghr_1ABCDefghijklmnop2345";
  const payload = {
    hook: "notification",
    refresh_token: GHR,
    note: "ghr_ token 应被脱敏",
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.ok(r.stdout.includes("[REDACTED]"), "stdout 应包含 [REDACTED] 替换标记");
  assert.ok(!r.stdout.includes(GHR), `stdout 不应残留 ghr_ token: ${GHR}`);
  assert.ok(r.stdout.includes("ghr_ token 应被脱敏"), "非敏感文本应原样保留");
});

// ---------------------------------------------------------------------------
// 12) GitHub Server-to-Server Token（ghu_）值级脱敏
// ---------------------------------------------------------------------------
suite("值级脱敏：ghu_ 开头的 GitHub Server-to-Server Token → [REDACTED]", () => {
  const GHU = "ghu_1ABCDefghijklmnop2345";
  const payload = {
    hook: "notification",
    server_token: GHU,
    note: "ghu_ token 应被脱敏",
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.ok(r.stdout.includes("[REDACTED]"), "stdout 应包含 [REDACTED] 替换标记");
  assert.ok(!r.stdout.includes(GHU), `stdout 不应残留 ghu_ token: ${GHU}`);
  assert.ok(r.stdout.includes("ghu_ token 应被脱敏"), "非敏感文本应原样保留");
});

// ---------------------------------------------------------------------------
// 13) GitHub Fine-grained PAT（github_pat_）值级脱敏
// ---------------------------------------------------------------------------
suite("值级脱敏：github_pat_ 开头的 GitHub Fine-grained PAT → [REDACTED]", () => {
  const PAT = "github_pat_11AAAA22BBBB33CCCCDDDDEEEEFFFF";
  const payload = {
    hook: "notification",
    fine_pat: PAT,
    note: "github_pat_ token 应被脱敏",
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.ok(r.stdout.includes("[REDACTED]"), "stdout 应包含 [REDACTED] 替换标记");
  assert.ok(!r.stdout.includes(PAT), `stdout 不应残留 github_pat_ token: ${PAT.slice(0, 12)}…`);
  assert.ok(r.stdout.includes("github_pat_ token 应被脱敏"), "非敏感文本应原样保留");
});

// ---------------------------------------------------------------------------
// 14) Slack 非 xoxb 变体（xoxa/xoxp/xoxr/xoxs）值级脱敏
// ---------------------------------------------------------------------------
suite("值级脱敏：Slack xoxa / xoxp / xoxr / xoxs 前缀 token → [REDACTED]", () => {
  const SLACK_A = "xoxa-2-1234567890-abcdefghij";
  const SLACK_P = "xoxp-1234567890-1234567890-1234567890-abcdefghij";
  const SLACK_R = "xoxr-1234567890-abcdefghij-1234567890-abcdefghij";
  const SLACK_S = "xoxs-1234567890-1234567890-1234567890-abcdefghij";
  const secrets = [SLACK_A, SLACK_P, SLACK_R, SLACK_S];

  const payload = {
    hook: "notification",
    detail: {
      result: {
        output: [
          `slack=${SLACK_A}`,
          `slack=${SLACK_P}`,
          `slack=${SLACK_R}`,
          `slack=${SLACK_S}`,
          "Slack xox 各前缀变体都应被脱敏",
        ],
      },
    },
  };

  const r = runCollect(JSON.stringify(payload));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.ok(r.stdout.includes("[REDACTED]"), "stdout 应包含 [REDACTED] 替换标记");
  for (const s of secrets) {
    assert.ok(!r.stdout.includes(s), `stdout 不应残留 Slack token: ${s.slice(0, 12)}…`);
  }
  assert.ok(r.stdout.includes("Slack xox 各前缀变体都应被脱敏"), "非敏感文本应原样保留");
});

// ---------------------------------------------------------------------------
// 15) tok 字段：直接取值 / total_tokens / usage 子对象三条路径 + 优先级
//    （对应 collect.mjs buildLine 中 tok 的三级取值，此前 22 个用例零覆盖）
// ---------------------------------------------------------------------------
suite("tok 直接取值：payload.tok 优先于 total_tokens 与 usage", () => {
  const r = runCollect(JSON.stringify({
    hook: "SubagentStop",
    agent_id: "e2e-tok-direct",
    status: "success",
    tok: 111,
    total_tokens: 222,
    usage: { total_tokens: 333 },
    prompt: "tok 直接取值测试", // 非抽取字段，保证 detail 非空便于断言
  }));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.tok, 111, "payload.tok 应直接作为 tok，且优先于 total_tokens/usage");
  const d = JSON.parse(r.line.detail);
  assert.ok(!("tok" in d), "tok 已被抽取，不应重复进入 detail");
  assert.ok(!("total_tokens" in d), "total_tokens 已被抽取，不应重复进入 detail");
  assert.ok(!("usage" in d), "usage 已被抽取，不应重复进入 detail");
});

suite("tok 兜底：payload.total_tokens 路径（字符串值转 Number）", () => {
  const r = runCollect(JSON.stringify({
    hook: "SubagentStop",
    agent_id: "e2e-tok-total",
    total_tokens: "456",            // 字符串值，最终应 Number 转换为 456
    usage: { total_tokens: 789 },   // 有 usage 也不应覆盖 total_tokens（优先级更低）
  }));
  assert.strictEqual(r.code, 0, `exit 应为 0，实为 ${r.code}`);
  assert.ok(r.line, "stdout 应能解析为事件行 JSON");
  assert.strictEqual(r.line.tok, 456, "total_tokens 应作为 tok 且 Number 转换为数字 456");
});

suite("tok 兜底：usage 子对象路径（total → output → input 依次回退）", () => {
  // usage.total_tokens 命中
  const r1 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-tok-u-t", usage: { total_tokens: 789 } }));
  assert.strictEqual(r1.code, 0, `exit 应为 0，实为 ${r1.code}`);
  assert.strictEqual(r1.line.tok, 789, "usage.total_tokens 应作为 tok");

  // usage 无 total_tokens → 回退 output_tokens
  const r2 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-tok-u-o", usage: { output_tokens: 555 } }));
  assert.strictEqual(r2.code, 0, `exit 应为 0，实为 ${r2.code}`);
  assert.strictEqual(r2.line.tok, 555, "无 total_tokens 时应回退 usage.output_tokens");

  // usage 仅 input_tokens → 回退 input_tokens
  const r3 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-tok-u-i", usage: { input_tokens: 666 } }));
  assert.strictEqual(r3.code, 0, `exit 应为 0，实为 ${r3.code}`);
  assert.strictEqual(r3.line.tok, 666, "无 total/output_tokens 时应回退 usage.input_tokens");

  // 三条路径均缺失 → tok 为 null
  const r4 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-tok-none" }));
  assert.strictEqual(r4.code, 0, `exit 应为 0，实为 ${r4.code}`);
  assert.strictEqual(r4.line.tok, null, "tok / total_tokens / usage 均缺失时应为 null");
});

// ---------------------------------------------------------------------------
// 16) 错误状态推断：status 为 null 时的四种结构化失败信号
//    （对应 collect.mjs buildLine 中 status == null 时的 error 推断分支）
// ---------------------------------------------------------------------------
suite("错误状态推断：status 为 null 时按结构化失败信号推断为 error", () => {
  // success === false
  const r1 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-err-false", success: false }));
  assert.strictEqual(r1.code, 0, `exit 应为 0，实为 ${r1.code}`);
  assert.strictEqual(r1.line.status, "error", "success === false 且无显式 status 应推断为 error");

  // 顶层 error 字段
  const r2 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-err-top", error: "调用超时" }));
  assert.strictEqual(r2.code, 0, `exit 应为 0，实为 ${r2.code}`);
  assert.strictEqual(r2.line.status, "error", "存在顶层 error 字段应推断为 error");

  // result.error 嵌套
  const r3 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-err-result", result: { error: "内部错误" } }));
  assert.strictEqual(r3.code, 0, `exit 应为 0，实为 ${r3.code}`);
  assert.strictEqual(r3.line.status, "error", "result.error 存在应推断为 error");

  // subagent_stop.error 嵌套
  const r4 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-err-sub", subagent_stop: { error: "失败" } }));
  assert.strictEqual(r4.code, 0, `exit 应为 0，实为 ${r4.code}`);
  assert.strictEqual(r4.line.status, "error", "subagent_stop.error 存在应推断为 error");

  // 误判防护：success === true 且无失败信号 → 不得推断为 error
  const r5 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-err-ok", success: true }));
  assert.strictEqual(r5.code, 0, `exit 应为 0，实为 ${r5.code}`);
  assert.strictEqual(r5.line.status, null, "success === true 且无失败信号不应推断为 error");

  // 显式 status 优先：即使带 error 字段，显式 status 不被覆盖
  const r6 = runCollect(JSON.stringify({ hook: "SubagentStop", agent_id: "e2e-err-explicit", status: "success", error: "不应覆盖" }));
  assert.strictEqual(r6.code, 0, `exit 应为 0，实为 ${r6.code}`);
  assert.strictEqual(r6.line.status, "success", "显式 status 存在时不被 error 字段覆盖");
});

// ---------------------------------------------------------------------------
// 结果汇总
// ---------------------------------------------------------------------------
console.log("================ vc-dashboard collect 单元测试 ================");
// 编号由 suites 数组下标自动生成（从 1 开始、连续唯一），杜绝手工编号错位/重复
let pass = 0, fail = 0;
for (const [i, { name, fn }] of suites.entries()) {
  const no = i + 1;
  try {
    fn();
    pass++;
    console.log(`  [PASS] ${no}. ${name}`);
  } catch (err) {
    fail++;
    console.log(`  [FAIL] ${no}. ${name}`);
    console.log(`        说明: ${err.message}`);
  }
}
console.log(`断言用例通过: ${pass} | 失败: ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
