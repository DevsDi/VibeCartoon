// tests/cases/16-asking.mjs — 用例 16：子 Agent 进入 asking（等待输入）过渡态
//
// 断言目标（契约来自 server.mjs applyEvent 的 notification 分支 + web/app.js buildStatusArea）：
//   服务端：无 agent 归属的 notification 挂到最近活跃 key（lastActiveKey），
//           detail 含 "agent_needs_input" → 该 agent.status = "asking"。
//   前端：  asking 卡片挂 .status-asking（黄色主色 + .card-wrap askPulse 呼吸）、
//           状态区 .ask-ring 请求环、💬/「等待输入」标签、右手 .office-arm-r 播放 raiseHand 举手动画。
// 方法（与 02/15 一致）：先注入 subagent_start 使该子 Agent 成为最近活跃 key，
//   再注入 notification(agent_needs_input) 事件，等待 600ms 轮询把状态推到 asking。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot } from "../helpers/board.mjs";

export default {
  name: "16-asking过渡",
  spec: "notification(agent_needs_input) → 子卡 status-asking + .ask-ring + 💬等待输入 + raiseHand 举手动画",
  run: async (ctx) => {
    const { page, makeId, check } = ctx;
    const id = makeId("asking");
    const results = [];
    const sel = (s) => `.agent-card[data-id="${id}"] ${s}`;

    // 1) 先出现存活子卡（成为 lastActiveKey，后续 notification 挂到它）
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id, 8000);
    if (!appear) return [check("K1 子卡出现", false, "出现", "未出现")];
    results.push(check("K1 子卡出现", true, "出现", "存在"));

    // 2) 注入 notification(agent_needs_input)：挂到最近活跃 Agent，推动 status → asking
    await injectEvents([eventLine({
      hook: "notification",
      detail: { message: "agent_needs_input: 等待用户输入", __e2e_ask: id },
    })]);

    const ask = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("status-asking") ? s : null;
    }, 6000, 150, "asking 状态");
    results.push(check("K2 卡片进入 asking 状态", !!ask,
      "status-asking", ask ? ask.classes.join(",") : "未出现",
      "notification(agent_needs_input) → 子 Agent status=asking"));

    if (ask) {
      results.push(check("K3 状态区显示 💬/等待输入",
        ask.statusEmoji === "💬" && ask.statusLabel === "等待输入",
        "💬/等待输入", `${ask.statusEmoji}/${ask.statusLabel}`));
    }

    // 3) 视觉元素：状态区 .ask-ring 请求环（黄色脉冲气环）
    const ring = await waitUntil(async () => {
      const el = await page.$(sel(".ask-ring"));
      return el ? true : null;
    }, 3000, 150, "ask-ring");
    results.push(check("K4 卡片含 .ask-ring 请求环", ring === true,
      "存在", ring ? "存在" : "缺失",
      "asking 状态区渲染 .ask-ring 气环"));

    // 4) 举手示意：asking 卡片 .office-arm-r 播放 raiseHand 动画（CSS 断言）
    const armName = await page.$eval(sel(".office-arm-r"),
      (el) => getComputedStyle(el).animationName).catch(() => "element-missing");
    results.push(check("K5 右手 raiseHand 举手动画",
      armName === "raiseHand", "raiseHand", armName,
      "asking 卡片右手臂应反复抬起等待输入"));

    return results;
  },
};