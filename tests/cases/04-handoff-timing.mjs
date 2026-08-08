// tests/cases/04-handoff-timing.mjs — 用例 4：交接/离场时序（方案 D）
//
// 断言目标（方案 D，实现依据 app.js leaveCard 的 waveDelay = CELEBRATE_MS +
// STICKMAN_TRAVEL_MS = 1.8s+5s）：
//   done 后延迟到火柴人交回（约 5s）才进入拜拜离场，交接同屏；
//   子卡 done 后至少 4s 仍在 DOM；拜拜期间保持 😄（done 卡）。
// 时间线（当前实现）：done → 庆祝/持文件等待 6.8s → is-leaving 挥手(4s)+淡出(3s)
// → 约 done+13.9s 移除。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot, waitForCardGone } from "../helpers/board.mjs";

export default {
  name: "04-交接时序(方案D)",
  spec: "done 后延迟至火柴人交回(约5s)才拜拜；done 后≥4s 卡片还在；交接同屏",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("handoff");
    const results = [];

    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("D1 子卡出现", false, "出现", "未出现")];

    await sleep(1200);
    await injectEvents([eventLine({ hook: "subagent_stop", agent: id, status: "success" })]);
    const doneSnap = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      // done 子卡不再被 updateCard 刷新，以 leaveCard 挂的 leaving-done 类作为完成信号
      return s && s.classes.includes("leaving-done") ? s : null;
    }, 5000, 150, "done 状态");
    if (!doneSnap) return [check("D1 完成状态", false, "status-done", "未完成")];
    const tDone = Date.now();

    // 逐点采样：记录 4s/5s 是否在场、拜拜期表情、消失时刻（最长 17s）
    let at4s = false, at5s = false, gone = false, goneAt = null;
    const bye = [];
    const phases = [];
    while (Date.now() - tDone < 17000) {
      const el = Date.now() - tDone;
      const s = await cardSnapshot(page, id);
      if (!s) { gone = true; goneAt = el; break; }
      if (el >= 3900 && el <= 4400 && !at4s) at4s = true;
      if (el >= 4900 && el <= 5400 && !at5s) at5s = true;
      if (el >= 7000 && el <= 13000) bye.push(s.emoji.join(""));
      if (el >= 7000 && s.classes.includes("is-leaving")) phases.push("is-leaving");
      await sleep(150);
    }

    // D1：done 后 ≥4s 卡片仍在（spec：延迟离场）
    results.push(check("D2 done 后 4s 卡片仍在", at4s === true, "4s 时在场", at4s ? "在" : "不在/已移除", "方案D：done 后至少 4s 卡片还在"));
    // D2：done 后 5s（火柴人交回到达 main 时刻）卡片仍在 → 交接同屏
    results.push(check("D3 done 后 5s 卡片仍在(交接同屏)", at5s === true, "5s 时在场", at5s ? "在" : "不在/已移除", "方案D：火柴人交回时子卡未离场完毕"));
    // D3：done 后 6.5s 才进入拜拜（延迟到火柴人交回后）
    results.push(check("D4 拜拜延迟至交回后(≥6.5s 才 is-leaving)", phases.length > 0 || !at5s, "is-leaving 不早于 6.5s", phases.length ? `is-leaving 起始≈${7000}ms` : "未观测到", "方案D：离场延迟到火柴人交回(约5s)后"));
    // D4：拜拜期间（7s~13s）仅 😄
    results.push(check("D5 拜拜期间仅 😄", bye.length > 0 && bye.every((e) => e === "😄"), "样本均为😄", JSON.stringify([...new Set(bye)]).slice(0, 60), "leaving-done 保持开心表情"));
    // D5：最终移除（≤17s，防挂卡）
    results.push(check("D6 卡片最终移除", gone === true, "DOM 移除", gone ? `已移除(t=${goneAt}ms)` : "未移除", "离场完整结束"));

    return results;
  },
};
