// tests/cases/05-main-idle.mjs — 用例 5：main 假待机（方案 E）
//
// 断言目标（方案 E，实现依据 app.js effectiveStatus + hasSubAgents）：
//   - main 正在思考/调用工具、且有存活子 Agent 时，不显示"待机中😴"，显示真实状态；
//   - 仅当 60s 无事件且非"阻塞等待子 Agent"时才待机。
// 实现：向 events.jsonl 注入"lastSeen 为 90s 前"的 main 事件（agent=null → key=main），
// 前端据此判定；测试结束注入新鲜事件把 main 唤醒。
//
// 环境注意：
//   - 真实环境常有存活的真实子 Agent，故"无子 Agent"条件无法严格构造；
//     本用例通过 main 状态（queued vs tool/thinking）区分"非等待"与"阻塞等待"两条路径。
//   - 若测试期间真实 Claude 活动事件到达，main lastSeen 会被刷新，可能干扰断言（概率低）。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitUntil, cardSnapshot } from "../helpers/board.mjs";

export default {
  name: "05-main假待机(方案E)",
  spec: "main 阻塞等待子Agent(thinking/tool)时不待机；其余超时才待机",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("idle");
    const results = [];

    const mainBase = await cardSnapshot(page, "main");
    if (!mainBase) {
      return [check("E1 环境：main 卡存在", false, "存在", "不存在", "服务端无 main agent，本用例无法执行")];
    }
    results.push(check("E1 环境：main 卡存在", true, "存在", `存在(注入前=${mainBase.statusLabel})`));

    const now = Date.now();
    const staleTs = new Date(now - 90000).toISOString();  // 90s 前：超过 60s IDLE_TIMEOUT
    const freshTs = new Date(now - 2000).toISOString();

    // ── 场景 B：main 非等待状态（queued）且 60s+ 无事件 → 应待机 ──
    // 注：subagent_start(agent=null) → key=main → status=queued
    await injectEvents([
      eventLine({ hook: "subagent_start", agent: null, type: "general-purpose", ts: staleTs }),
    ]);
    const idleSnap = await waitUntil(async () => {
      const s = await cardSnapshot(page, "main");
      return s && s.classes.includes("status-idle") ? s : null;
    }, 4000, 200, "main 待机");
    results.push(check("E2 非等待态+60s无事件 → 待机中😴", !!idleSnap && idleSnap.statusLabel === "待机中", "status-idle/待机中", idleSnap ? idleSnap.statusLabel : "未待机", "方案E：超时判定路径（当前行为基线）"));

    // 唤醒 main：注入新鲜事件（post_tool_use → thinking）
    await injectEvents([
      eventLine({ hook: "post_tool_use", agent: null, tool: "Read", detail: { tool_response: { type: "text" } }, ts: freshTs }),
    ]);
    const wake = await waitUntil(async () => {
      const s = await cardSnapshot(page, "main");
      return s && !s.classes.includes("status-idle") ? s : null;
    }, 4000, 200, "main 唤醒");
    results.push(check("E3 新事件自动唤醒", !!wake, "非 idle", wake ? wake.statusLabel : "仍 idle", "方案E：有新事件自动恢复真实状态"));

    // ── 场景 A：main 过期（tool），但存在存活子 Agent（tool）→ 按 spec 不应待机 ──
    await injectEvents([
      eventLine({ hook: "subagent_start", agent: id, type: "general-purpose", ts: freshTs }),
      eventLine({ hook: "pre_tool_use", agent: id, tool: "Bash", detail: { tool_input: { command: "sleep 60" } }, ts: freshTs }),
    ]);
    const subSnap = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("status-tool") ? s : null;
    }, 5000, 150, "子agent tool 状态");
    if (subSnap) {
      // main 进入 tool（阻塞等待子 Agent）且 lastSeen 过期
      await injectEvents([
        eventLine({ hook: "pre_tool_use", agent: null, tool: "Read", detail: { tool_input: { file_path: "/x" } }, ts: staleTs }),
      ]);
      await sleep(1000); // 等 1~2 轮轮询（600ms）
      const snap = await cardSnapshot(page, "main");
      results.push(check("E4 有存活子Agent时 main 不待机", !!snap && !snap.classes.includes("status-idle"),
        "非 status-idle（显示真实状态）",
        snap ? snap.classes.filter((c) => c.startsWith("status-")).join(",") : "main 无",
        "方案E：main 阻塞等待子Agent时不显示待机"));
    } else {
      results.push(check("E4 有存活子Agent时 main 不待机", false, "子卡到 tool 状态", "未出现", "无法构造场景，本断言 SKIP"));
    }

    // 收尾：唤醒 main，消除测试副作用
    await injectEvents([
      eventLine({ hook: "post_tool_use", agent: null, tool: "Read", detail: { tool_response: { type: "text" } }, ts: new Date().toISOString() }),
    ]);
    await sleep(1000);
    const restored = await cardSnapshot(page, "main");
    results.push(check("E5 收尾：main 恢复真实状态", !!restored && !restored.classes.includes("status-idle"),
      "非 idle", restored ? restored.statusLabel : "—", "清除测试副作用"));

    return results;
  },
};
