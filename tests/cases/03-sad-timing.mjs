// tests/cases/03-sad-timing.mjs — 用例 3：😟 出现时序（方案 C）
//
// 断言目标（方案 C）：
//   task-assigned（😟）应在子卡出现时即显示（先不开心再干活），
//   不必等火柴人到达（5s）才显示；随后约 3.5s 恢复默认表情。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot } from "../helpers/board.mjs";

export default {
  name: "03-😟时序(方案C)",
  spec: "task-assigned(😟) 在子卡出现时即显示，不等火柴人到达(5s)",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("sad");
    const results = [];

    const tInject = Date.now();
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("C1 子卡出现", false, "出现", "未出现")];
    const tAppear = Date.now();
    if (tAppear - tInject > 2500) {
      return [check("C1 子卡出现及时", false, "注入后≤2.5s", `${tAppear - tInject}ms`, "轮询延迟异常")];
    }

    // C1：出现后 2.5s 内应显示 😟（spec 说"即显示"；给 2.5s 宽限，远小于火柴人到达的 5s）
    const early = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("task-assigned") && s.emoji.includes("😟") ? s : null;
    }, 2500, 100, "2.5s 内显示😟");
    const latency = early ? Date.now() - tAppear : null;
    results.push(check("C2 卡片出现后 2.5s 内显示 😟", !!early, "≤2.5s 内 task-assigned+😟", early ? `实际 ${latency}ms` : "未出现", "方案C：😟在子卡出现时即显示。当前实现挂在火柴人到达(totalMs≈5s)后才添加"));

    if (early) {
      // C2：😟 约 3.5s 后恢复默认表情（task-assigned 生命周期）
      const tSad = Date.now();
      const recovered = await waitUntil(async () => {
        const s = await cardSnapshot(page, id);
        return s && !s.classes.includes("task-assigned") ? s : null;
      }, 6000, 100, "😟恢复");
      const holdMs = recovered ? Date.now() - tSad : null;
      results.push(check("C3 😟 约3.5s后恢复", !!recovered && holdMs >= 3000, "持续≥3s后移除", recovered ? `持续 ${holdMs}ms` : "未恢复", "task-assigned 3.5s 生命周期"));
    } else {
      results.push(check("C3 😟 生命周期（依赖C2）", false, "—", "SKIP", "C2 失败，跳过"));
    }

    return results;
  },
};
