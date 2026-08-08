// tests/cases/01-failure.mjs — 用例 1：失败流程（方案 A）
//
// 断言目标（方案 A，实现依据 web/app.js markCardFailed / runStickman(isFailed) /
// mainReceiveFile(success) 与 style.css .task-failed / .stickman-runner.flip.failed /
// .main-receiving-fail）：
//   1. 子 Agent 失败：卡片显示红色 ✕ + 失败表情 😢 + 红色辉光/抖动（.task-failed 类）
//   2. 状态区显示 ❌（不再停留"调用工具中"蓝色 spinner）
//   3. 火柴人交回时显示 😢 且不带绿勾（.flip.failed，无 .report 类）
//   4. main 接收失败显示 😟 + 红色"驳回"闪光（.main-receiving-fail），不显示 😄

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot, stickmanSnapshot, waitForCardGone } from "../helpers/board.mjs";

export default {
  name: "01-失败流程(方案A)",
  spec: "失败→红色✕+😢+红辉光/抖动；交回😢不带绿勾；main 不显示😄；状态区❌无spinner",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("fail");
    const results = [];
    const now = () => new Date().toISOString();

    // 阶段 1：派发 → 卡片出现
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose", ts: now() })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("F1 子卡出现", false, "出现", "未出现", "子卡未渲染，后续断言跳过")];

    // 阶段 2：工作（tool）→ 蓝色 spinner 基线
    await sleep(400);
    await injectEvents([eventLine({ hook: "pre_tool_use", agent: id, tool: "Bash", detail: { tool_input: { command: "echo hi" } }, ts: now() })]);
    const toolSnap = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("status-tool") ? s : null;
    }, 5000, 150, "tool 状态");
    if (toolSnap) {
      results.push(check("F2 失败前基线：tool 状态有蓝色 spinner", toolSnap.spinner === true, true, toolSnap.spinner, "tool 状态有 spinner"));
    }

    // 阶段 3：失败（subagent_stop status=error）
    await sleep(300);
    await injectEvents([
      eventLine({ hook: "subagent_stop", agent: id, type: "general-purpose", status: "error", detail: { error: "e2e 测试失败", result: { status: "error" } }, ts: now() }),
    ]);
    const failSnap = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("task-failed") ? s : null;
    }, 5000, 150, "task-failed 状态");
    if (!failSnap) {
      return [check("F3 卡片进入失败视觉(task-failed)", false, "task-failed", "未出现", "subagent_stop(error) 未让卡片失败")];
    }
    results.push(check("F3 卡片进入失败视觉(task-failed)", true, "task-failed", failSnap.classes.join(",")));

    // A1：状态区显示 ❌（方案A：失败时状态区 ❌，不再停留"调用工具中"蓝色 spinner）
    results.push(check("F4 状态区显示 ❌ 表情", failSnap.statusEmoji === "❌", "❌", failSnap.statusEmoji, "方案A：状态区 ❌"));
    results.push(check("F5 状态标签为「失败」", failSnap.statusLabel === "失败", "失败", failSnap.statusLabel));
    results.push(check("F6 红色 ✕（failed-x）", failSnap.failedX === true, true, failSnap.failedX, "方案A：卡片显示红色 ✕"));
    results.push(check("F7 蓝色 spinner 已消失", failSnap.spinner === false, false, failSnap.spinner, "方案A：失败后不再停留调用工具中 spinner"));

    // A2：失败表情 😢（.task-failed → office-head-fail）
    results.push(check("F8 失败表情显示 😢", JSON.stringify(failSnap.emoji) === JSON.stringify(["😢"]), ["😢"], failSnap.emoji, "方案A：失败表情😢"));

    // A3：红色辉光 + 抖动
    results.push(check("F9 红色辉光（head drop-shadow）", /drop-shadow/.test(failSnap.headFilter || ""), "filter 含 drop-shadow", failSnap.headFilter, "方案A：失败红色辉光"));
    results.push(check("F10 卡片抖动（shakeOnce）", failSnap.cardWrapAnim === "shakeOnce", "shakeOnce", failSnap.cardWrapAnim, "方案A：失败抖动"));

    // 阶段 4：火柴人交回（backToMain）——失败也触发交回动画，表情应为 😢、无绿勾
    const flip = await waitUntil(async () => {
      const list = await stickmanSnapshot(page);
      return list.find((s) => s.flip) || null;
    }, 6000, 150, "交回火柴人");
    if (flip) {
      results.push(check("F11 交回火柴人出现", true, "flip 火柴人", "在"));
      // A4：交回火柴人头部表情应为 😢（.flip.failed → stick-head-fail）
      results.push(check("F12 交回火柴人头部表情 😢", JSON.stringify(flip.headVisible) === JSON.stringify(["😢"]), ["😢"], flip.headVisible, "方案A：失败交回显示😢"));
      // A5：交回不带绿勾（.failed 无 .report 类 → .report-mark opacity 0）
      results.push(check("F13 交回火柴人不带绿勾", flip.reportMarkOpacity === "0", "opacity 0", flip.reportMarkOpacity, "方案A：失败交回不带绿勾"));
    } else {
      results.push(check("F11 交回火柴人出现", false, "flip 火柴人", "未出现", "未捕获到交回火柴人"));
    }

    // 阶段 5：main 接收——失败交回后 main 应显示 😟（.main-receiving-fail + 红色驳回闪光），不显示 😄
    // 采样窗口：交回到达 main 前后 [tFail+4.8s, tFail+8.5s]
    const tFail = Date.now();
    let mainSeen = false, mainHappy = false, mainSad = false, failFlash = false;
    const mainEmojis = [];
    const tWinEnd = tFail + 8500;
    while (Date.now() < tWinEnd) {
      if (Date.now() < tFail + 4800) { await sleep(200); continue; }
      const snap = await cardSnapshot(page, "main");
      if (!snap) break;
      mainSeen = true;
      if (snap.emoji.includes("😄")) mainHappy = true;
      if (snap.emoji.includes("😟")) mainSad = true;
      if (snap.classes.includes("received-flash-fail")) failFlash = true;
      mainEmojis.push(snap.emoji.join(""));
      await sleep(200);
    }
    if (!mainSeen) {
      results.push(check("F14 main 不显示😄(失败交回)", false, "存在 main 卡", "无 main 卡", "环境无 main agent，本断言 SKIP"));
    } else {
      results.push(check("F14 main 不显示😄(失败交回)", mainHappy === false, "采样窗口内从不显示😄", mainHappy ? "出现😄" : "未出现😄", "方案A：main 接收失败显示😟或保持默认+红色闪光"));
      results.push(check("F15 main 接收失败显示😟/红闪", mainSad || failFlash, "😟 或 received-flash-fail", `😟=${mainSad} 红闪=${failFlash}`, "方案A：main-receiving-fail 显示😟+红色驳回闪光"));
    }

    // 阶段 6：失败卡最终离场消失（拜拜→淡出→移除，约 done+7.1s）
    const gone = await waitForCardGone(page, id, 15000);
    results.push(check("F16 失败卡离场消失", gone === true, "DOM 移除", gone, "失败卡挥手拜拜→淡出→移除"));

    return results;
  },
};
