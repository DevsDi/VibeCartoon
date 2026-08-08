// tests/cases/09-resurrect.mjs — 用例 9：同 id 复活不误删（方案 F）
//
// 断言目标（方案 F，实现依据 app.js upsertCard 的 leavingTimer 守卫）：
//   子 Agent 完成离场期间（leavingTimer 未清）同 id 新任务复活时，
//   应丢弃旧缓存 rec、新建替换；旧卡的离场定时器到期不得误删新卡。
// 方法：start → done（旧卡进入离场）→ 同 id 再次 start（复活）→
// 断言新卡正常渲染并存活过旧卡移除时刻 → 新卡完成离场。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot, waitForCardGone } from "../helpers/board.mjs";

export default {
  name: "09-同id复活不误删(方案F)",
  spec: "离场中的同 id 复活：新卡不被旧离场定时器误删，功能正常",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("revive");
    const results = [];
    const now = () => new Date().toISOString();

    // 第一轮：start → done → 进入离场（celebrating，leavingTimer 已挂）
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose", ts: now() })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("F1 首轮子卡出现", false, "出现", "未出现")];
    await sleep(800);
    await injectEvents([eventLine({ hook: "subagent_stop", agent: id, status: "success", ts: now() })]);
    const oldDone = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("celebrating") ? s : null;
    }, 5000, 150, "旧卡进入离场(celebrating)");
    if (!oldDone) return [check("F1 旧卡进入离场", false, "celebrating", "未出现")];
    const tFirstDone = Date.now();

    // 第二轮：同 id 复活（离场窗口内）
    await sleep(500);
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose", ts: now() })]);
    const revived = await waitUntil(async () => {
      const s = await cardSnapshot(page, id, { lastMatch: true });
      return s && s.classes.includes("status-queued") ? s : null;
    }, 5000, 150, "新卡复活(queued)");
    results.push(check("F2 同id复活：新卡渲染为 queued", !!revived, "新卡 status-queued", revived ? revived.classes.join(",") : "未出现", "方案F：离场中同id复活新建卡片"));

    if (revived) {
      // 新卡存活过旧卡移除时刻（旧卡 done+13.9s 移除定时器到期）
      const tDeadline = tFirstDone + 14500;
      const waitMs = tDeadline - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      const afterDeadline = await cardSnapshot(page, id, { lastMatch: true });
      results.push(check("F3 新卡未被旧定时器误删", !!afterDeadline, "旧卡移除时刻后新卡仍在", afterDeadline ? "在" : "已被移除", "方案F：旧离场定时器只删旧 DOM，不误删新卡"));

      // 新卡完成整个流程（done 卡以 leaving-done 为完成信号）
      await sleep(300);
      await injectEvents([eventLine({ hook: "subagent_stop", agent: id, status: "success", ts: now() })]);
      const newDone = await waitUntil(async () => {
        const s = await cardSnapshot(page, id, { lastMatch: true });
        return s && s.classes.includes("leaving-done") ? s : null;
      }, 5000, 150, "新卡完成");
      results.push(check("F4 新卡功能正常：完成离场", !!newDone, "leaving-done", newDone ? newDone.classes.join(",") : "未完成", "复活卡走完整成功流程"));
      const gone = await waitForCardGone(page, id, 20000);
      results.push(check("F5 复活卡最终离场消失", gone === true, "DOM 移除", gone, "复活卡拜拜→淡出→移除"));
    }

    return results;
  },
};
