// tests/cases/07-reduced-motion.mjs — 用例 7：reduced-motion 降级
//
// 断言目标：prefers-reduced-motion: reduce 下
//   1. 不创建火柴人（JS 侧 runStickman 直接 return）
//   2. 不播放庆祝粒子（celebrateCard 被跳过）
//   3. 功能正常：卡片出现 → 完成 → 离场消失，表情不重叠
// 本用例需要独立的 reduced-motion 浏览器上下文（ctx.newPage({reducedMotion:true})）。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot, stickmanSnapshot, waitForCardGone } from "../helpers/board.mjs";

export default {
  name: "07-reduced-motion(降级)",
  spec: "reduced-motion 下无火柴人/无庆祝粒子，功能(出现/完成/离场)正常",
  run: async (ctx) => {
    const { makeId, check, sleep } = ctx;
    const id = makeId("rm");
    const results = [];

    const { page, context } = await ctx.newPage({ reducedMotion: true });
    try {
      await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
      const appear = await waitForCard(page, id);
      if (!appear) return [check("R1 子卡出现", false, "出现", "未出现", "reduced-motion 下子卡未渲染")];

      await sleep(800);
      await injectEvents([eventLine({ hook: "subagent_stop", agent: id, status: "success" })]);
      const doneSnap = await waitUntil(async () => {
        const s = await cardSnapshot(page, id);
        return s && s.classes.includes("leaving-done") ? s : null;
      }, 5000, 150, "done 状态");

      // R1：全程（done 起 8s 窗口）anim-layer 无火柴人
      // R2：全程无庆祝粒子
      let maxStick = 0, maxParticles = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const list = await stickmanSnapshot(page);
        maxStick = Math.max(maxStick, list.length);
        const particles = await page.$$eval(`.agent-card[data-id="${id}"] .celebrate-particle`, (els) => els.length).catch(() => 0);
        maxParticles = Math.max(maxParticles, particles);
        await sleep(300);
      }
      results.push(check("R2 无火柴人动画", maxStick === 0, 0, maxStick, "reduced-motion 不创建火柴人"));
      results.push(check("R3 无庆祝粒子", maxParticles === 0, 0, maxParticles, "reduced-motion 跳过庆祝"));

      // R3：功能正常（完成离场）
      results.push(check("R4 功能正常：完成离场", !!doneSnap && doneSnap.classes.includes("leaving-done"), "leaving-done", doneSnap ? doneSnap.classes.join(",") : "未完成"));

      // R4：离场期间表情不重叠（reduced-motion 下 task-assigned 不会追加，无双层）
      const leavingSnap = await cardSnapshot(page, id);
      results.push(check("R5 离场期间表情 ≤1 个", leavingSnap ? leavingSnap.emoji.length <= 1 : true, "≤1", leavingSnap ? JSON.stringify(leavingSnap.emoji) : "已消失", "reduced-motion 下不追加 task-assigned，无😟😄重叠"));

      // R5：离场消失
      const gone = await waitForCardGone(page, id, 12000);
      results.push(check("R6 离场消失", gone === true, "DOM 移除", gone, "拜拜→淡出→移除完整"));

      return results;
    } finally {
      await context.close().catch(() => {});
    }
  },
};
