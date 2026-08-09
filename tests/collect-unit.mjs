// tests/collect-unit.mjs — hooks/collect.mjs 单元测试（纯 Node，零依赖）
//
// 直接通过 child_process 以 --dry 模式调用采集器（不写 events.jsonl）：
//   node hooks/collect.mjs --dry < stdin
// 断言采集器自身的三个核心契约：
//   1. 值级脱敏：detail 中 sk-*/Bearer/ghp_/gho_/Slack xox* 等密钥样式 → [REDACTED]
//   2. 输入限长：stdin 超过 8MB 直接丢弃本条事件，且恒 exit 0
//   3. 正常事件原样透传（hook 归一化，字段不被误删/误脱敏）
//
// 运行：npm run test:unit    （要求 Node >= 18，无需浏览器/服务）

import { spawnSync } from "node:child_process";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECT = path.join("hooks", "collect.mjs");
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

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

const suites = [];
const suite = (name, fn) => suites.push({ name, fn });

// ---------------------------------------------------------------------------
// 1) 值级脱敏
// ---------------------------------------------------------------------------
suite("值级脱敏：sk- / Bearer / ghp_ / gho_ / xox* 密钥样式 → [REDACTED]", () => {
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
