// tests/clear-e2e.mjs — POST /api/agents/clear 接口端到端手动测试（T4）
//
// 前置：本机看板服务已启动（npm start，默认 http://localhost:8617）。
// 注入/清理约定与 tests/cleanup.mjs 一致：测试事件 agent id 使用 e2e- 前缀，
// 由 hooks/collect.mjs 写入 data/events.jsonl，结束后由 cleanupInjectedEvents() 移除。
//
// 流程：
//   1. 通过 hooks/collect.mjs 注入 2 个 e2e- 前缀假子 Agent 事件（e2e-clear-a / e2e-clear-b）
//   2. 确保 main 存在（/api/state 无 main 时注入一条 SubagentStart 空 agent_id 的 main 事件；正常情况下看板内存中已有 main）
//   3. POST /api/agents/clear → 期望 { ok: true, cleared: 2 }
//   4. GET /api/state → 期望仅剩 main
//   5. 再次 POST /api/agents/clear → 期望 { ok: true, cleared: 0 }（幂等）
//   6. cleanupInjectedEvents() 移除 e2e- 测试事件行，并轮询 /api/state 让服务端
//      检测文件缩小后回退重放真实事件（状态确定性重建，与测试前一致）
//
// 注意：
//   - 本脚本假定测试时看板内存仅含 main 与本次注入的 2 个 e2e- 子 Agent。
//     若看板内存中还残留其它真实子 Agent（如正在运行的主会话子任务），cleared 计数会
//     大于 2、且"仅剩 main"断言失败。建议在干净/空闲环境下运行，或运行前先手动清场。
//   - 若步骤 2 需要注入 main 事件，该行 agent id 为空（非 e2e- 前缀），cleanupInjectedEvents
//     不会移除它；main 事件行与真实会话持续写入的 main 行同类，属可接受残留。
//
// 用法：node tests/clear-e2e.mjs
//       VC_BASE_URL=http://localhost:8617 node tests/clear-e2e.mjs  # 覆盖服务地址

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupInjectedEvents } from "./cleanup.mjs";

// 项目根目录（本文件位于 <root>/tests/）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.VC_BASE_URL || `http://localhost:${8617}`).replace(/\/$/, "");
const COLLECT = path.join(ROOT, "hooks", "collect.mjs");
const E2E_IDS = ["e2e-clear-a", "e2e-clear-b"];

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`[clear-e2e] ✓ ${name}`);
  } else {
    failures++;
    console.error(`[clear-e2e] ✗ ${name}${extra ? ` | ${extra}` : ""}`);
  }
}

/** 通过 hooks/collect.mjs 追加一条事件到 events.jsonl（与真实采集同一写入路径）。 */
function inject(payload) {
  execFileSync(process.execPath, [COLLECT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: "pipe",
  });
}

/** 调用 API，返回 { status, ct, json, text }（ct 为 Content-Type 响应头）。 */
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, ct: res.headers.get("content-type") || "", json, text };
}

/** 拉取 /api/state，返回 { ids, byId, ct }（聚合后内存 agent 快照 + 响应 Content-Type）。 */
async function getState() {
  const r = await api("GET", "/api/state");
  const agents = (r.json && Array.isArray(r.json.agents)) ? r.json.agents : [];
  return { ids: agents.map((a) => a.id), byId: new Map(agents.map((a) => [a.id, a])), ct: r.ct };
}

async function main() {
  // 服务可达性前置检查
  try {
    await api("GET", "/api/health");
  } catch {
    console.error("[clear-e2e] ✗ 看板服务不可达，请先启动服务（npm start）");
    process.exitCode = 1;
    return;
  }

  // 步骤 1：注入 2 个 e2e- 前缀假子 Agent 事件
  for (const id of E2E_IDS) {
    inject({ hook: "SubagentStart", agent_id: id, agent_type: "general-purpose" });
  }

  // 步骤 2：确保 main 存在（先轮询让服务端增量读注入事件，再判定是否需补 main）
  //
  // 注入方式说明：main 是主会话——无 agent_id 的 hook 事件会被服务端聚合到 key="main"
  // （见 server.mjs applyEvent 的 key 计算：非空 agent → 自身，否则合成 main）。这里刻意注入
  // SubagentStart + agent_id 空字符串：collect.mjs 把空串原样归一化为 agent=""（`agent_id ?? …`
  // 不把 "" 当 null），服务端再把空 agent 映射到 "main"，从而以 subagent_start 语义建立 main
  // 记录。刻意不用 PreToolUse：工具调用路径会把 main 记成 tool 状态并累积 toolCount，与真实
  // 主会话"会话开始"语义不一致，也避免聚合出的 main 干扰后续 cleared 等计数类断言的直观性。
  // 该行 agent 为空（非 e2e- 前缀），cleanupInjectedEvents 不会移除它，与真实 main 行同类，
  // 属可接受残留（见文件头注释）。
  await api("GET", "/api/state");
  let s = await getState();
  if (s && !s.ids.includes("main")) {
    inject({ hook: "SubagentStart", agent_id: "" });
    await api("GET", "/api/state");
    s = await getState();
  }
  check("main 存在", !!(s && s.ids.includes("main")));
  check("state 返回 Content-Type: application/json", /^application\/json/.test(s?.ct ?? ""), s?.ct || "(空)");
  check("e2e-clear-a 已被聚合", !!(s && s.ids.includes("e2e-clear-a")), `实际 agents: ${s?.ids?.join(",")}`);
  check("e2e-clear-b 已被聚合", !!(s && s.ids.includes("e2e-clear-b")), `实际 agents: ${s?.ids?.join(",")}`);

  // 记录清除前非 main 子 Agent 数量，作为 cleared 断言的动态基准（不硬编码 2：
  // 若看板内存还残留其它真实子 Agent，cleared 会更大，动态计算才能正确断言）
  const preClearCount = s.ids.filter((id) => id !== "main").length;
  check("清除前非 main 子 Agent 数量 >= 2（含注入的 2 个）", preClearCount >= 2, `实际 ${preClearCount}`);

  // 步骤 3：POST /api/agents/clear → 期望 { ok: true, cleared: 清除前子 Agent 数量 }
  const c1 = await api("POST", "/api/agents/clear");
  check("clear 返回 HTTP 200", c1.status === 200, `实际 ${c1.status}`);
  check("clear 返回 Content-Type: application/json", /^application\/json/.test(c1.ct), c1.ct);
  check("clear 返回 ok:true", !!(c1.json && c1.json.ok === true), c1.text);
  check("clear 返回 cleared 与清除前一致", !!(c1.json && c1.json.cleared === preClearCount),
    `期望 cleared=${preClearCount}，实际 cleared=${c1.json?.cleared}`);

  // 步骤 4：GET /api/state 中仅剩 main
  s = await getState();
  check("清除后仅剩 main", !!(s && s.ids.length === 1 && s.ids[0] === "main"), `实际 agents: ${s?.ids?.join(",")}`);

  // 步骤 5：连续调用第二次验证幂等（cleared: 0）
  const c2 = await api("POST", "/api/agents/clear");
  check("二次 clear 返回 Content-Type: application/json", /^application\/json/.test(c2.ct), c2.ct);
  check("二次 clear 返回 ok:true", !!(c2.json && c2.json.ok === true), c2.text);
  check("二次 clear 返回 cleared:0", !!(c2.json && c2.json.cleared === 0), `实际 cleared=${c2.json?.cleared}`);

  // 步骤 6：清理 e2e- 测试事件行，并轮询让服务端回退重放真实事件（状态重建）
  const clean = await cleanupInjectedEvents();
  check("已移除 e2e- 测试事件", clean.removed >= 2, `移除 ${clean.removed} 行`);
  await api("GET", "/api/state");

  if (failures === 0) {
    console.log("\n[clear-e2e] ✅ 全部通过");
  } else {
    console.error(`\n[clear-e2e] ❌ ${failures} 项未通过`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[clear-e2e] 执行异常:", err?.stack ?? err);
  process.exitCode = 1;
});
