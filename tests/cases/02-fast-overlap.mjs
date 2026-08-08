// tests/cases/02-fast-overlap.mjs — 用例 2：快速任务表情重叠（方案 B）
//
// 断言目标（方案 B）：
//   快速任务（<7s 完成）不会出现 😟😄 双层 emoji 重叠；
//   celebrating / leaving-done 规则要隐藏 sad/idle 层（style.css 已补齐）。
// 方法：从 done 起持续采样卡片可见表情，直到卡片消失（方案D 离场约 done+14s）。
// 风险点：done 前 task-assigned(😟) 可能仍在卡片上（3.5s 生命周期），
// done 后 celebrating(6.8s) / is-leaving 期间必须压过它只显示 😄。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot } from "../helpers/board.mjs";

export default {
  name: "02-快速任务重叠(方案B)",
  spec: "快速任务(<7s完成)不出现😟😄双层重叠；celebrating/leaving-done 隐藏 sad 层",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("fast");
    const results = [];

    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("B1 子卡出现", false, "出现", "未出现")];

    // 快速任务：出现后 ~0.7s 即完成（远小于 7s；此时 task-assigned😟 尚在 3.5s 生命周期内）
    await sleep(700);
    await injectEvents([eventLine({ hook: "subagent_stop", agent: id, status: "success", detail: { result: { status: "success" } } })]);
    const doneSnap = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      // done 子卡被移出活动列表后不再被 updateCard 刷新，状态类停留在完成前一刻，
      // 因此以 leaveCard 挂的 leaving-done 类作为"进入完成离场"信号
      return s && s.classes.includes("leaving-done") ? s : null;
    }, 5000, 150, "done 状态");
    if (!doneSnap) return [check("B1 快速完成(done)", false, "status-done", "未完成")];
    const tDone = Date.now();

    // 采样窗口：done → 卡片消失（方案D：celebrating 1.8s+火柴人5s 后进入拜拜，移除约 done+14s）
    const samples = [];
    let gone = false, goneAt = null;
    while (Date.now() - tDone < 17000) {
      const s = await cardSnapshot(page, id);
      if (!s) { gone = true; goneAt = Date.now() - tDone; break; }
      samples.push({
        t: Date.now() - tDone,
        emoji: s.emoji,
        phase: s.classes.filter((c) => c === "celebrating" || c === "is-leaving" || c === "task-assigned" || c.includes("status-")).join(","),
      });
      await sleep(150);
    }

    // B1：全程任意时刻可见表情 ≤1（无双重层）
    const maxOverlap = samples.reduce((m, s) => Math.max(m, s.emoji.length), 0);
    const overlapSamples = samples.filter((s) => s.emoji.length > 1).map((s) => `t=${s.t}ms[${s.emoji.join("")}]`);
    results.push(check("B2 全程无双重层表情", maxOverlap <= 1, "任意时刻 ≤1 个", maxOverlap <= 1 ? `最大重叠 ${maxOverlap}` : `最大重叠 ${maxOverlap}: ${overlapSamples.slice(0, 3).join(";")}`, "方案B：快速任务不出现😟😄双层"));

    // B2：庆祝阶段（done 后 ~6.8s 内，celebrating 持文件等待火柴人到达）仅 😄
    const cele = samples.filter((s) => s.t >= 200 && s.t <= 6000).map((s) => s.emoji.join(""));
    results.push(check("B3 庆祝/等待阶段仅 😄", cele.length > 0 && cele.every((e) => e === "😄"), "样本均为😄", JSON.stringify([...new Set(cele)]).slice(0, 60), "celebrating 期间只显示😄"));

    // B3：拜拜阶段（is-leaving 起，done 后 ~7s 至消失）仅 😄
    const leaving = samples.filter((s) => s.t >= 7000).map((s) => s.emoji.join(""));
    results.push(check("B4 拜拜阶段仅 😄", leaving.length > 0 && leaving.every((e) => e === "😄"), "样本均为😄", JSON.stringify([...new Set(leaving)]).slice(0, 60), "leaving-done 期间只显示😄"));

    // B4：卡片最终消失（方案D 窗口内）
    results.push(check("B5 快速任务卡最终消失", gone === true, `DOM 移除(≤17s)`, gone ? `已移除(t=${goneAt}ms)` : "未移除", "离场完整结束"));

    return results;
  },
};
