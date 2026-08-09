// tests/cases/15-stop-agent.mjs — 用例 15：子 Agent 停止功能（服务端 stop-signals + 前端按钮）
//
// 断言目标（对本任务计划的验收，DOM/接口契约已由 web/app.js updateStopZone 与
// server/server.mjs handleAgentStop / stop-signals.jsonl 落地）：
//   1. 存活中的子 Agent（queued/thinking/tool/asking、非 main、非 done/failed/离场）
//      卡片可点按钮「⏹ 停止」（.stop-zone .stop-agent-btn）；main 卡与 done/离场/failed
//      子卡不渲染可见停止按钮。
//   2. 点击按钮 → POST /api/agents/:id/stop（成功 2xx）→ 按钮 disabled + 文案「⏹ 已停止」、
//      卡片挂 .status-stopped 灰化；服务端在 data/stop-signals.jsonl 追加
//      { ts, agent, status: "requested" }，且 /api/state 的该 agent 返回 stopRequested: true。
//   3. 测试结束清理：删除 stop-signals.jsonl 中 e2e- 测试 agent 记录，并还原
//      events.jsonl 中本用例注入的事件行（含构造 main 用的带标记行，防止全局清理遗漏）。
//
// 方法：注入事件驱动真实状态（600ms 轮询）→ 真实 DOM 断言 + 真实网络（POST）+ 服务端
// 状态/信号文件断言。page.$eval / page.click 仅在本项目自己的本地看板页面执行，不执行
// 外部不可信代码。

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventLine, injectEvents, STOP_SIGNALS_FILE, EVENTS_FILE } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, stopButtonSnapshot } from "../helpers/board.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_URL = "http://localhost:8617/api/state";

// 服务端状态速查（Node 侧直连 /api/state，用于断言 stopRequested / main 存在性）
const stateFetch = () =>
  fetch(STATE_URL, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);

export default {
  name: "15-子Agent停止",
  spec: "存活子卡渲染「⏹ 停止」→ 点击 POST /stop(2xx) → disabled+已停止、stop-signals.jsonl 落记录、/api/state.stopRequested=true；done/失败/离场子卡与 main 卡无可见停止按钮",
  run: async (ctx) => {
    const { page, makeId, check } = ctx;
    const results = [];
    const aliveId = makeId("stop-alive"); // 存活卡（主要流程：点击停止）
    const doneId = makeId("stop-done");   // 完成后离场卡（无按钮）
    const failId = makeId("stop-fail");   // 失败后离场卡（无按钮）
    const marker = makeId("stop-main");   // 环境无 main 时构造 main 用的标记（供清理识别）

    /* ---------- 服务端信号文件读取/清理工具 ---------- */
    const readStopSignals = async () => {
      let raw;
      try { raw = await readFile(STOP_SIGNALS_FILE, "utf8"); } catch { return []; }
      return raw.split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && typeof e.agent === "string");
    };
    const cleanupStopSignals = async () => {
      let raw;
      try { raw = await readFile(STOP_SIGNALS_FILE, "utf8"); } catch { return; }
      const kept = []; let removed = 0;
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        let drop = false;
        try { const e = JSON.parse(line); drop = typeof e.agent === "string" && e.agent.startsWith("e2e-"); } catch { /* 损坏行保留 */ }
        if (drop) removed++; else kept.push(line);
      }
      if (!removed) return;
      const tmp = STOP_SIGNALS_FILE + ".cln.tmp";
      await writeFile(tmp, kept.join("\n") + "\n", "utf8");
      await rename(tmp, STOP_SIGNALS_FILE);
    };
    const cleanupEvents = async () => {
      let raw;
      try { raw = await readFile(EVENTS_FILE, "utf8"); } catch { return; }
      const kept = []; let removed = 0;
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        let drop = false;
        try {
          const e = JSON.parse(line);
          drop = (typeof e.agent === "string" && e.agent.startsWith("e2e-"))
              || (typeof e.detail === "string" && e.detail.includes(marker));
        } catch { /* 损坏行保留 */ }
        if (drop) removed++; else kept.push(line);
      }
      if (!removed) return;
      const tmp = EVENTS_FILE + ".cln.tmp";
      await writeFile(tmp, kept.join("\n") + "\n", "utf8");
      await rename(tmp, EVENTS_FILE);
    };

    /* 等待"卡片不再存在 / 停止按钮不再可见"（done/failed/main 的负向断言）。
     * 注意：done/failed 子卡庆祝（celebrating）期间按钮仍可见（旧渲染残留），
     * 离场（is-leaving/removing）时 CSS display:none，故按可见性而非 DOM 判。 */
    const noButtonVisible = async (id) => {
      const s = await stopButtonSnapshot(page, id);
      if (!s) return { gone: true };
      return s.exists && s.vis ? null : { gone: false, statusStopped: s.statusStopped };
    };

    try {
      // 1) 确保 main 存在：真实 main 已出现则复用，否则注入一条带标记的事件构造。
      let mainPresent = false;
      try {
        const st = await stateFetch();
        if (st && Array.isArray(st.agents)) mainPresent = st.agents.some((a) => a.id === "main");
      } catch { /* 服务异常交由后续断言暴露 */ }

      // 2) 注入事件：main（如需）+ 3 张子卡（存活 / 待完成 / 待失败）
      const injects = [];
      if (!mainPresent) {
        injects.push(eventLine({ hook: "pre_tool_use", agent: null, tool: "Bash",
          detail: { __e2e_marker: marker } }));
      }
      injects.push(eventLine({ hook: "subagent_start", agent: aliveId, type: "general-purpose" }));
      injects.push(eventLine({ hook: "subagent_start", agent: doneId, type: "general-purpose" }));
      injects.push(eventLine({ hook: "subagent_start", agent: failId, type: "general-purpose" }));
      await injectEvents(injects);

      // 3) 主卡与 3 张子卡全部出现（done/failed 卡先以存活态挂出，随后才注入 stop 事件，
      //    保证 D1/F1 验证"按钮随 done/failed 消失"而不是卡片从头未渲染的假通过）
      const appearAlive = await waitForCard(page, aliveId, 8000);
      const appearDone = await waitForCard(page, doneId, 8000);
      const appearFail = await waitForCard(page, failId, 8000);
      results.push(check("C0 存活子卡出现", !!appearAlive, "出现", appearAlive ? "存在" : "未出现"));
      results.push(check("C0d 待停止(done)子卡出现", !!appearDone, "出现", appearDone ? "存在" : "未出现"));
      results.push(check("C0f 待停止(failed)子卡出现", !!appearFail, "出现", appearFail ? "存在" : "未出现"));
      const mainCard = await waitForCard(page, "main", 8000);
      results.push(check("C0m main 卡出现", !!mainCard, "出现", mainCard ? "存在" : "未出现",
        "环境无 main 时由带标记事件构造（main 常驻，测试后文件行已清理）"));

      // 4) 存活卡：渲染「⏹ 停止」按钮（enabled + 文案含 停止 且 非已停止）
      let btn = null;
      if (appearAlive) {
        btn = await waitUntil(async () => {
          const s = await stopButtonSnapshot(page, aliveId);
          return s && s.exists && s.vis && s.disabled !== true &&
                 s.text && s.text.includes("停止") && !s.text.includes("已停止") ? s : null;
        }, 6000, 100, "停止按钮出现");
        results.push(check("S1 存活子卡渲染「⏹ 停止」（enabled）", !!btn,
          "存在且可用", btn ? `text=${btn.text}` : "缺失",
          "契约：queued/thinking/tool/asking 子卡渲染 .stop-agent-btn"));
      } else {
        results.push(check("S1 存活子卡渲染「⏹ 停止」（enabled）", false, "先出现卡", "未出现卡"));
      }

      // 5) 点击 → POST /api/agents/:id/stop（成功 2xx）→ 按钮「已停止」+ disabled + 灰化
      let clicked = false;
      if (btn) {
        const postPromise = page.waitForResponse(
          (r) => r.request().method() === "POST" &&
                r.url().includes("/api/agents/") && r.url().includes("/stop"),
          { timeout: 6000 }).then((r) => r).catch(() => null);
        try {
          await page.click(`.agent-card[data-id="${aliveId}"] .stop-agent-btn`, { timeout: 3000 });
          clicked = true;
        } catch (e) { clicked = false; }
        results.push(check("S2 点击触发 POST /api/agents/:id/stop", clicked, "可点击", clicked ? "已点击" : "不可点"));
        if (clicked) {
          const resp = await postPromise;
          const code = resp ? resp.status() : null;
          results.push(check("S2s POST 返回 2xx（成功）", code !== null && code >= 200 && code < 300,
            "2xx", code === null ? "未捕获响应" : String(code),
            "实现方当前返回 200（任务描述曾写 202），按 2xx 归属断言"));
        }
      }

      let stopped = null;
      if (clicked) {
        stopped = await waitUntil(async () => {
          const s = await stopButtonSnapshot(page, aliveId);
          return s && s.disabled === true && s.text && s.text.includes("已停止") ? s : null;
        }, 5000, 100, "按钮→已停止");
        results.push(check("S3 按钮变为「已停止」且 disabled", !!stopped,
          "disabled+已停止", stopped ? `text=${stopped.text} disabled=${stopped.disabled}` : "未变化",
          "契约：POST 成功 / stopRequested=true → 按钮已停止"));
        results.push(check("S3b 卡片挂 .status-stopped 灰化", !!stopped && stopped.statusStopped,
          "status-stopped", stopped && stopped.statusStopped ? "已挂" : "未挂",
          "契约：已停止卡片降饱和/灰化"));

        // 5b) 服务端闭环：/api/state.stopRequested=true + stop-signals.jsonl 落记录
        const gotReq = await waitUntil(async () => {
          const st = await stateFetch();
          const a = st && Array.isArray(st.agents) ? st.agents.find((x) => x.id === aliveId) : null;
          return a && a.stopRequested === true ? true : null;
        }, 5000, 200, "stopRequested=true");
        results.push(check("S4 /api/state.stopRequested=true", gotReq === true,
          "true", gotReq === null ? "未出现" : String(gotReq),
          "契约：/api/state 的该 agent 带 stopRequested:true"));

        const sig = await waitUntil(async () => {
          const lines = await readStopSignals();
          return (lines.find((e) => e.agent === aliveId && e.status === "requested")) || null;
        }, 5000, 200, "stop-signals 落记录");
        results.push(check("S5 stop-signals.jsonl 含 {agent,status:'requested'}", !!sig,
          `agent=${aliveId} status=requested`, sig ? JSON.stringify(sig) : "未记录",
          "契约：POST /stop 追加一行 {agent,status:'requested'}"));
      }

      // 6) done/failed 离场子卡无可见停止按钮（完成后由 is-leaving/removing 的 CSS display:none 隐藏）
      await injectEvents([
        eventLine({ hook: "subagent_stop", agent: doneId, status: "success", detail: { result: { status: "success" } } }),
        eventLine({ hook: "subagent_stop", agent: failId, status: "failed", detail: { error: "e2e 停止失败" } }),
      ]);
      const doneRes = await waitUntil(() => noButtonVisible(doneId), 12000, 200, "done 无停止按钮");
      const failRes = await waitUntil(() => noButtonVisible(failId), 12000, 200, "failed 无停止按钮");
      results.push(check("D1 done/离场子卡无停止按钮", !!doneRes,
        "不可见/已移除", doneRes ? (doneRes.gone ? "卡片已移除" : "按钮隐藏") : "仍可见",
        "完成/离场子卡（注入 subagent_stop 的卡）不渲染可见停止按钮"));
      results.push(check("F1 failed子卡无停止按钮", !!failRes,
        "不可见/已移除", failRes ? (failRes.gone ? "卡片已移除" : "按钮隐藏") : "仍可见",
        "失败/离场子卡不渲染可见停止按钮"));

      // 7) main 卡：无可见停止按钮（服务端对 main 停止返回 409）
      if (mainCard) {
        const m = await stopButtonSnapshot(page, "main");
        results.push(check("M1 main 卡无停止按钮", !!m && !(m.exists && m.vis),
          "无可见按钮", m ? `exists=${m.exists} vis=${m.vis}` : "卡片读取失败",
          "契约：main 卡不渲染停止按钮（服务端返回 409）"));
      }
    } finally {
      // 测试后清理：stop-signals 中 e2e- 测试条 + events.jsonl 本用例注入行（含 main 标记行）
      await cleanupStopSignals().catch(() => {});
      await cleanupEvents(marker).catch(() => {});
    }

    return results;
  },
};