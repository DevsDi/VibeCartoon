// tests/cases/11-motion-addons.mjs — 用例 11：动画趣味化新增（方向 A/B/D）
//
// 断言目标：
//   方向A：火柴人跑动时脚底产生 .stick-dust 尘土粒子（#anim-layer 内，
//          ~120ms/个、~700ms 移除）；在途 >0、到达后归零。
//   方向B：子 Agent done 时卡片挂 .card-pop（一次性上弹 + 绿色余晖），
//          done 后 ≤1s 内出现、约 1s 后消失（计划 ~620ms 移除）。
//   方向D：body 下 .bg-symbols 背景代码符号层存在且 span 数 = 14；
//          空状态含 .empty-radar 雷达 与 .empty-stick 待机小人——
//          空状态展示（无 agents）时可见，随 #empty-state.hidden 一并隐藏。
//
// 说明：空状态可见性依赖环境（无 agents 时才展示），用"翻转 #empty-state.hidden
// 类 + 读父层 display"做确定性断言（读取后还原；后续注入事件也会重新 setEmptyVisible）；
// page.$eval 仅在本项目自己的本地页面执行只读 DOM 查询与临时 class 翻转，不执行外部不可信代码。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot, stickmanSnapshot, animDustCount } from "../helpers/board.mjs";

export default {
  name: "11-动画趣味化(方向A/B/D)",
  spec: "在途尘土>0/到达归零；done 卡 card-pop 短暂出现消失；.bg-symbols 14个span；空状态雷达/待机小人显隐",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("motion");
    const results = [];

    // ── D1/D2：背景代码符号层（静态 DOM，与事件无关） ──
    const bg = await page.$eval("body", (el) => {
      const layer = el.querySelector(".bg-symbols");
      return {
        exists: !!layer,
        spanCount: layer ? layer.querySelectorAll("span").length : 0,
      };
    }).catch(() => null);
    results.push(check("D1 .bg-symbols 存在", !!bg && bg.exists, "存在", bg ? `存在 span=${bg.spanCount}` : "缺失", "方向D：body 下背景代码符号层"));
    results.push(check("D2 .bg-symbols 含 14 个 span", !!bg && bg.spanCount === 14, 14, bg ? bg.spanCount : 0, "方向D：14 个代码符号 span"));

    // ── D3-D6：空状态雷达/待机小人：结构 + 显隐耦合（翻转 hidden 类，读取后还原） ──
    const empty = await page.$eval("#empty-state", (el) => {
      const radar = el.querySelector(".empty-radar");
      const stick = el.querySelector(".empty-stick");
      const vis = (n) => (n ? getComputedStyle(n).display !== "none" : false);
      const before = { r: vis(radar), s: vis(stick) };
      el.classList.remove("hidden"); // 模拟"无 agents → 空状态展示"
      const shown = { r: vis(radar), s: vis(stick) };
      el.classList.add("hidden");    // 还原
      const hiddenDisplay = getComputedStyle(el).display;
      return { hasRadar: !!radar, hasStick: !!stick, before, shown, hiddenDisplay };
    }).catch(() => null);
    if (!empty) {
      results.push(check("D3 空状态含雷达+待机小人", false, "元素存在", "#empty-state 缺失"));
    } else {
      results.push(check("D3 空状态含雷达+待机小人", empty.hasRadar && empty.hasStick, "两者都有", `radar=${empty.hasRadar} stick=${empty.hasStick}`, "方向D：空状态含 .empty-radar / .empty-stick"));
      results.push(check("D4 空状态展示时雷达可见", empty.shown.r === true, "display≠none", `shown.radar=${empty.shown.r}`, "方向D：无 agents 时 .empty-radar 可见"));
      results.push(check("D5 空状态展示时待机小人可见", empty.shown.s === true, "display≠none", `shown.stick=${empty.shown.s}`, "方向D：无 agents 时 .empty-stick 可见"));
      results.push(check("D6 有 agents 时空状态整体隐藏", empty.hiddenDisplay === "none", "display:none", `display=${empty.hiddenDisplay}`, "方向D：有 agents 时雷达/待机小人随 #empty-state.hidden 一并隐藏"));
    }

    // ── A：尘土粒子（在途 >0、到达后归零） ──
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("M1 子卡出现", false, "出现", "未出现")];
    const runStick = await waitUntil(async () => {
      const list = await stickmanSnapshot(page);
      return list.find((s) => !s.flip) || null;
    }, 5000, 150, "派发火柴人");
    if (!runStick) {
      results.push(check("M2 在途尘土 >0", false, "派发火柴人出现", "无", "方向A：无火柴人则无尘土"));
    } else {
      let maxDust = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        const d = await animDustCount(page);
        maxDust = Math.max(maxDust, d);
        if (maxDust > 0) break;
        await sleep(100);
      }
      results.push(check("M2 在途尘土 >0", maxDust > 0, ">0", maxDust, "方向A：跑动时脚底产生 .stick-dust（~120ms/个）"));
      // 等到派发火柴人移除（5s 跑完 + 100ms），再等最后尘土 700ms 移除窗口
      await waitUntil(async () => {
        const list = await stickmanSnapshot(page);
        return !list.find((s) => !s.flip);
      }, 7000, 200, "派发火柴人移除");
      await sleep(1200);
      const afterDust = await animDustCount(page);
      results.push(check("M3 到达后尘土归零", afterDust === 0, 0, afterDust, "方向A：到达后不再产生，~700ms 内清除"));
    }

    // ── B：done 卡 card-pop（done 后 ≤1s 出现、约 1s 后消失） ──
    await injectEvents([eventLine({ hook: "subagent_stop", agent: id, status: "success", detail: { result: { status: "success" } } })]);
    const doneSnap = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("leaving-done") ? s : null;
    }, 5000, 150, "done 状态");
    if (!doneSnap) {
      results.push(check("B1 done 后 ≤1s 出现 card-pop", false, "leaving-done", "未完成"));
      results.push(check("B2 card-pop 约 1s 后消失", false, "—", "SKIP", "依赖 B1"));
      results.push(check("B3 card-pop 消失时卡片仍在", false, "—", "SKIP", "依赖 B1"));
    } else {
      let firstSeen = null, goneAt = null, cardAliveWhenGone = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const s = await cardSnapshot(page, id);
        if (!s) break; // 卡片提前消失（异常）
        if (firstSeen === null && s.classes.includes("card-pop")) {
          firstSeen = Date.now() - t0;
        }
        if (firstSeen !== null && goneAt === null && !s.classes.includes("card-pop")) {
          goneAt = Date.now() - t0;
          cardAliveWhenGone = true;
          break;
        }
        await sleep(50);
      }
      results.push(check("B1 done 后 ≤1s 出现 card-pop", firstSeen !== null && firstSeen <= 1000, "≤1000ms 采样到", firstSeen === null ? "未出现" : `${firstSeen}ms`, "方向B：done 挂 .card-pop 一次性上弹"));
      results.push(check("B2 card-pop 约 1s 后消失", firstSeen !== null && goneAt !== null && goneAt - firstSeen <= 2000 && goneAt - firstSeen >= 150, "出现后 150~2000ms 移除", goneAt === null ? "未移除" : `${goneAt - firstSeen}ms`, "方向B：~620ms 移除，一次性"));
      results.push(check("B3 card-pop 消失时卡片仍在", cardAliveWhenGone === true, "卡片仍存在", cardAliveWhenGone === null ? "卡片已消失" : "在", "方向B：card-pop 移除不影响卡片离场"));
    }

    return results;
  },
};
