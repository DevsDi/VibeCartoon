// tests/cases/08-emoji-exclusive.mjs — 用例 8：表情显隐互斥（CSS 组合）
//
// 断言目标：celebrating / task-assigned / is-leaving / main-receiving(-fail) 等
// 状态类叠加时，卡片上只显示一个表情层（方案 B/C/D 的 CSS 互斥规则，
// style.css 表情层优先级：task-failed ≥ celebrating > task-assigned > idle > 默认）。
// 方法：在真实卡片上临时叠加 class（读取后立即移除），断言可见表情集合。
//
// 说明：page.$eval 仅在本项目自己的本地页面上执行只读 DOM 查询与 class
// 临时叠加（读取后即还原），不执行外部不可信代码。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitUntil, cardSnapshot, setClassesAndReadEmoji } from "../helpers/board.mjs";

export default {
  name: "08-表情显隐互斥(CSS组合)",
  spec: "celebrating/task-assigned/is-leaving/main-receiving(-fail) 叠加时仅一个表情可见",
  run: async (ctx) => {
    const { page, makeId, check } = ctx;
    const id = makeId("excl");
    const results = [];
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // 准备一张常驻卡片（tool 状态，不会离场）
    await injectEvents([
      eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" }),
      eventLine({ hook: "pre_tool_use", agent: id, tool: "Bash", detail: { tool_input: { command: "sleep" } } }),
    ]);
    const snap = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      return s && s.classes.includes("status-tool") ? s : null;
    }, 6000, 150, "子卡 tool 状态");
    if (!snap) return [check("G1 卡片就绪(tool)", false, "status-tool", "未出现")];

    // G1：task-assigned 单独 → 😟（方案 C 表情层）
    const g1 = await setClassesAndReadEmoji(page, id, ["task-assigned"]);
    results.push(check("G2 task-assigned → 仅😟", eq(g1, ["😟"]), ["😟"], g1, "方案C：接任务显示😟"));

    // G2：task-assigned + celebrating → 😄（celebrating 隐藏 sad 层，方案 B）
    const g2 = await setClassesAndReadEmoji(page, id, ["task-assigned", "celebrating"]);
    results.push(check("G3 task-assigned+celebrating → 仅😄", eq(g2, ["😄"]), ["😄"], g2, "方案B：celebrating 隐藏 sad 层"));

    // G3：task-assigned + is-leaving + leaving-done → 😄（leaving-done 也隐藏 sad 层）
    const g3 = await setClassesAndReadEmoji(page, id, ["task-assigned", "is-leaving", "leaving-done"]);
    results.push(check("G4 task-assigned+leaving-done → 仅😄", eq(g3, ["😄"]), ["😄"], g3, "方案B：leaving-done 隐藏 sad 层"));

    // G4：task-failed + task-assigned + celebrating → 😢（失败视觉优先级最高，方案 A）
    const g4 = await setClassesAndReadEmoji(page, id, ["task-failed", "task-assigned", "celebrating"]);
    results.push(check("G5 task-failed 叠加最高优先 → 仅😢", eq(g4, ["😢"]), ["😢"], g4, "方案A：失败视觉压过庆祝/翻脸"));

    // G5：main 卡 main-receiving + status-idle → 😄（main-receiving 优先级最高）
    const mainBase = await cardSnapshot(page, "main");
    if (mainBase) {
      const g5 = await setClassesAndReadEmoji(page, "main", ["main-receiving", "status-idle"]);
      results.push(check("G6 main接收+待机 → 仅😄", eq(g5, ["😄"]), ["😄"], g5, "main-receiving 优先级最高，显式隐藏 idle 层"));
      // G6：main-receiving-fail + status-idle → 😟（失败接收表情，方案 A）
      const g6 = await setClassesAndReadEmoji(page, "main", ["main-receiving-fail", "status-idle"]);
      results.push(check("G7 main接收失败+待机 → 仅😟", eq(g6, ["😟"]), ["😟"], g6, "方案A：main-receiving-fail 显示😟"));
    } else {
      results.push(check("G6 main接收+待机 → 仅😄", false, "存在 main 卡", "无 main 卡", "环境无 main，本断言 SKIP"));
      results.push(check("G7 main接收失败+待机 → 仅😟", false, "存在 main 卡", "无 main 卡", "环境无 main，本断言 SKIP"));
    }

    return results;
  },
};
