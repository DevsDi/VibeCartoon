// tests/collect-unit.mjs — hooks/collect.mjs 单元测试（纯 Node，零依赖）
//
// 直接通过 child_process 以 --dry 模式调用采集器（不写 events.jsonl）：
//   node hooks/collect.mjs --dry < stdin
// 断言采集器自身的核心契约：
//   1. 值级脱敏：sk-*/Bearer/AKIA/eyJ(JWT 头)/Slack xox*/ghr_/ghu_ 等密钥样式 → [REDACTED]
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
// 3.1) 自动同步新增字段抽取：transcriptPath / toolUseId 首层提取且不进 detail
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

// ---------------------------------------------------------------------------
// 4) 字段名黑名单脱敏
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

// ---------------------------------------------------------------------------
// 5) PEM 整串脱敏
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
// 6) MAX_STR / DETAIL_CAP 截断（码点安全，不切出孤立代理对）
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
// 7) JSON 解析失败分支
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
// 8) AKIA 值级脱敏（AWS Access Key ID）
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
// 9) JWT 值级脱敏
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
// 10) GitHub Refresh Token（ghr_）值级脱敏
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
// 11) GitHub Server-to-Server Token（ghu_）值级脱敏
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
// 结果汇总
// ---------------------------------------------------------------------------
console.log("================ vc-dashboard collect 单元测试 ================");
let pass = 0, fail = 0;
for (const { name, fn } of suites) {
  try {
    fn();
    pass++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    fail++;
    console.log(`  [FAIL] ${name}`);
    console.log(`        说明: ${err.message}`);
  }
}
console.log(`断言用例通过: ${pass} | 失败: ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
