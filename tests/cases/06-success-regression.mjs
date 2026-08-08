// tests/cases/06-success-regression.mjs — 用例 6：成功流程回归（方案 A-F 总回归）
//
// 断言目标：完整成功流程各表情按预期切换
//   派发(火柴人😎→子卡) → queued → tool(🛠️+spinner) → thinking(🔍)
//   → done(✅+庆祝😄) → 交回(火柴人 flip😄+绿勾) → main 接收(😄) → 拜拜消失。
// 同时回归检查：成功流程全程不出现双层表情（关联方案 B）。
// 时间线（当前实现）：done → celebrating/持文件 6.8s → is-leaving(4s)+淡出(3s) → 约 done+14s 移除。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot, stickmanSnapshot, waitForCardGone } from "../helpers/board.mjs";

export default {
  name: "06-成功回归(完整流程)",
  spec: "派发→工作→完成😄→交回→main接收😄→拜拜消失，各表情按预期切换且不重叠",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("ok");
    const results = [];
    const now = () => new Date().toISOString();

    // 派发
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose", ts: now() })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("S1 子卡出现", false, "出现", "未出现")];

    // S1：派发火柴人（toSub，非 flip，😎）
    const runStick = await waitUntil(async () => {
      const list = await stickmanSnapshot(page);
      return list.find((s) => !s.flip) || null;
    }, 3000, 150, "派发火柴人");
    results.push(check("S2 派发火柴人出现(toSub)", !!runStick, "toSub 火柴人", runStick ? "在" : "无", "任务派发动画"));

    // 工作：tool
    await sleep(800);
    await injectEvents([eventLine({ hook: "pre_tool_use", agent: id, tool: "Agent", detail: { tool_input: { description: "e2e 回归任务" } }, ts: now() })]);
    const tool = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("status-tool") ? s : null;
    }, 5000, 150, "tool 状态");
    results.push(check("S3 工作状态(调用工具中+spinner)", !!tool && tool.spinner && tool.statusLabel === "调用工具中", "tool+spinner", tool ? `${tool.statusLabel}` : "无"));

    // 思考：thinking
    await sleep(800);
    await injectEvents([eventLine({ hook: "post_tool_use", agent: id, tool: "Agent", detail: { tool_response: { type: "text" } }, ts: now() })]);
    const think = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("status-thinking") ? s : null;
    }, 5000, 150, "thinking 状态");
    results.push(check("S4 思考状态(🔍)", !!think && think.statusLabel === "思考中", "thinking", think ? think.statusLabel : "无"));

    // 完成：done（子卡被移出活动列表后不再被 updateCard 刷新，以 leaving-done 类为完成信号）
    await sleep(800);
    await injectEvents([eventLine({ hook: "subagent_stop", agent: id, status: "success", detail: { result: { status: "success" } }, ts: now() })]);
    const done = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("leaving-done") ? s : null;
    }, 5000, 150, "done 状态");
    if (!done) return [check("S5 完成状态", false, "leaving-done", "未完成")];
    results.push(check("S5 完成进入离场(leaving-done+celebrating)", done.classes.includes("celebrating") && done.classes.includes("leaving-done"), "celebrating+leaving-done", done.classes.filter((c) => c === "celebrating" || c === "leaving-done").join(","), "done 离场时序"));
    results.push(check("S6 庆祝阶段显示 😄", done.emoji.includes("😄"), "含😄", JSON.stringify(done.emoji), "celebrating 表情"));

    // 交回火柴人（flip + 😄 + 绿勾）
    const back = await waitUntil(async () => {
      const list = await stickmanSnapshot(page);
      return list.find((s) => s.flip) || null;
    }, 3000, 150, "交回火柴人");
    results.push(check("S7 交回火柴人出现(flip)", !!back, "flip 火柴人", back ? "在" : "无", "完成交回动画"));
    if (back) {
      results.push(check("S7b 交回火柴人 😄+绿勾", JSON.stringify(back.headVisible) === JSON.stringify(["😄"]) && back.reportMarkOpacity === "1", "😄 + opacity1", `${back.headVisible.join("")}/${back.reportMarkOpacity}`, "done 交回带绿勾"));
    }

    // 全程无重叠 + main 接收 😄（并行采样，避免 S8 阻塞导致 S9 错过 done+5s 窗口）
    const tDone = Date.now();
    let max = 0;
    let mainSeen = false, mainHappySeen = false, mainEmoji = "";
    let doneGone = false;
    while (Date.now() - tDone < 17000) {
      const s = await cardSnapshot(page, id);
      if (!s) { doneGone = true; break; }
      max = Math.max(max, s.emoji.length);
      // 并行检查 main 接收 😄（done+4s 起）
      if (Date.now() - tDone >= 4000) {
        const mainSnap = await cardSnapshot(page, "main");
        if (mainSnap) {
          mainSeen = true;
          if (mainSnap.emoji.includes("😄")) { mainHappySeen = true; mainEmoji = mainSnap.emoji.join(""); }
        }
      }
      await sleep(150);
    }
    results.push(check("S8 成功流程全程无双层表情", max <= 1, "任意时刻 ≤1 个", `最大重叠 ${max}`, "celebrating/leaving-done 隐藏 sad 层"));
    if (!mainSeen) {
      results.push(check("S9 main 接收显示 😄", false, "存在 main 卡", "无 main 卡", "环境无 main agent，本断言 SKIP"));
    } else {
      results.push(check("S9 main 接收显示 😄", mainHappySeen, "main-receiving 期间显示😄", mainHappySeen ? mainEmoji : "未出现😄", "main-receiving 表情"));
    }

    // 卡片消失
    const gone = await waitForCardGone(page, id, 18000);
    results.push(check("S10 完成卡拜拜消失", gone === true, "DOM 移除", gone, "离场完整流程"));

    return results;
  },
};
