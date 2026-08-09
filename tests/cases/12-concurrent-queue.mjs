// tests/cases/12-concurrent-queue.mjs — 用例 12：toSub 火柴人并发排队（动画完善-方向A）
//
// 断言目标（方向 A，实现依据 web/app.js 的 FIFO 队列驱动 toSub）：
//   1. 批量注入多个 subagent_start（不同 e2e- id、同一轮轮询同时出现）时，
//      #anim-layer 内 .stickman-runner 数量在任意时刻 ≤ 1（排队，不重叠）；
//   2. 每个子 Agent 的派发火柴人都依次出现（前一个移除后下一个才出现，FIFO），
//      全部跑完并从动画层移除。
//
// 方法：页面运行中（首帧 stickmanSeeded 基准已建立后）在 #anim-layer 上安装
// MutationObserver 统计 .stickman-runner 的并发峰值 / 出现次数 / 移除次数，
// 再批量注入事件驱动真实状态（600ms 轮询），读取统计断言。
// 注意：刷新后首帧不触发动画，故必须先等页面跑起来再实时注入。
//
// 说明：page.evaluate 仅在本项目自己的本地页面安装只读统计器，不执行外部不可信代码。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil } from "../helpers/board.mjs";

const QUEUE_N = 3;              // 同一轮同时出现的子 Agent 数
const QUEUE_WAIT_MS = 26000;    // 3 个 5s 火柴人依次跑完的最长等待（实现若调慢仍有余量）

export default {
  name: "12-并发排队(方向A)",
  spec: "多个子 Agent 同时出现时 toSub 火柴人依次出现（FIFO 队列），同一时刻至多 1 个 .stickman-runner",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    // 注意：makeId 复用同一全局 seq，相同前缀会得到相同 id（见 run.mjs 的 makeId 实现），
    // 故每次须用不同前缀生成互异的 agent id，否则 3 条注入事件只创建 1 个 agent、只派 1 个火柴人。
    const ids = [];
    for (let i = 0; i < QUEUE_N; i++) ids.push(makeId("cq" + (i + 1)));
    const results = [];

    // 首帧基准建立后再注入：刷新后首帧 stickmanSeeded 不触发动画，需在页面运行中实时注入。
    // 等 ≥1 个轮询周期（600ms）+ 首帧已有任意卡片挂载（animateAgentChanges 已建基准），
    // 保证随后注入的 e2e 子 Agent 被判定为"新出现"而非首帧基准的一部分。
    await sleep(700);
    const baselined = await waitUntil(() => page.$(".agent-card").then((el) => (el ? true : null)), 5000, 150, "首帧基准");
    if (!baselined) {
      return [check("Q0 首帧基准建立", false, "任意卡片挂载（首次渲染含 agent）", "空状态", "首帧无 agent 时 stickmanSeeded 不会置位，队列测试需非空基准")];
    }

    // 安装只读统计器：记录 #anim-layer 内 .stickman-runner 的并发峰值/出现/移除。
    // 尘土粒子（.stick-dust）不算；目标卡片中途被移除导致的取消移除也不计入。
    const obs = await page.evaluate(() => {
      const layer = document.getElementById("anim-layer");
      if (!layer) return null;
      const stats = { max: 0, starts: 0, ends: 0, count: 0, startsAt: [], endsAt: [] };
      const t0 = performance.now();
      const upd = () => {
        stats.count = layer.querySelectorAll(".stickman-runner").length;
        if (stats.count > stats.max) stats.max = stats.count;
      };
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.classList.contains("stickman-runner")) {
              stats.starts++;
              stats.startsAt.push(Math.round(performance.now() - t0));
            }
          }
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && n.classList.contains("stickman-runner")) {
              stats.ends++;
              stats.endsAt.push(Math.round(performance.now() - t0));
            }
          }
        }
        upd();
      }).observe(layer, { childList: true });
      window.__queueStats = stats;
      return true;
    });
    if (!obs) return [check("Q0 动画层存在", false, "#anim-layer", "缺失")];

    // 批量注入 QUEUE_N 个 subagent_start（同一轮轮询同时出现）
    await injectEvents(ids.map((id) => eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })));

    // 全部卡片出现
    let allShown = true;
    for (const id of ids) {
      if (!(await waitForCard(page, id, 8000))) allShown = false;
    }
    results.push(check("Q1 全部子卡出现", allShown, `${QUEUE_N} 张`, allShown ? `${QUEUE_N} 张` : "有未出现", "批量注入后各 e2e 卡应挂载"));

    // 等待全部火柴人依次跑完（FIFO：每个 5s 跑动 + 移除），最长 QUEUE_WAIT_MS
    const terminal = await waitUntil(async () => {
      const s = await page.evaluate(() => window.__queueStats);
      return s && s.ends >= QUEUE_N && s.count === 0 ? s : null;
    }, QUEUE_WAIT_MS, 200, "队列跑完");

    const stats = await page.evaluate(() => window.__queueStats);

    // Q2：同一时刻至多 1 个 .stickman-runner（排队，不重叠）
    results.push(check("Q2 同时至多 1 个火柴人", !!stats && stats.max <= 1, "≤1", stats ? `${stats.max}` : "无统计", "方向A：FIFO 队列排队，同一时刻至多 1 个"));

    // Q3：每个子 Agent 的派发火柴人都依次出现（共 QUEUE_N 次独立出现）
    results.push(check("Q3 依次出现 N 次", !!stats && stats.starts >= QUEUE_N, `≥${QUEUE_N} 次`, stats ? `${stats.starts}` : "0", "方向A：前一个移除后下一个才出现（FIFO）"));

    // Q4：全部移除，队列清空
    results.push(check("Q4 全部跑完并移除", !!stats && stats.ends >= QUEUE_N && stats.count === 0,
      `ends≥${QUEUE_N} 且 count=0`, stats ? `ends=${stats.ends} count=${stats.count}` : "无统计", "方向A：排队动画闭环"));

    // Q5：整体时序是否在窗口内完成（实现未到位 / 队列卡住时为 FAIL，可据此判断进展）
    results.push(check("Q5 窗口内全部完成", !!terminal, `≤${QUEUE_WAIT_MS}ms 跑完`, terminal
      ? `starts=${terminal.starts} ends=${terminal.ends} max=${terminal.max}`
      : `超时：starts=${stats ? stats.starts : "?"} ends=${stats ? stats.ends : "?"} max=${stats ? stats.max : "?"}`,
      "方向A：3 个 5s 火柴人依次跑完约需 15s"));

    return results;
  },
};
