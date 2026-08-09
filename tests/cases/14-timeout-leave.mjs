// tests/cases/14-timeout-leave.mjs — 用例 14：超时回收可视化（动画完善-方向B）
//
// 断言目标（方向 B）：活跃 Agent 消失且 lastSeen 超阈值（对齐 STALE_MS 10min）时，
//   卡片挂 .timeout-leaving 类，播放"打盹😴 → 熄灯 → 淡出"离场；正常 done/failed
//   回收不挂此类。
//
// 真实超时需等 10min 难复现，采用两条简化断言：
//   1. 静态校验：web/style.css 文本含 `.timeout-leaving` 选择器（实现方需落地 CSS）；
//   2. 页面内校验：给某张 e2e- 子卡手动挂 .timeout-leaving，断言
//      ① 打盹表情 😴（.office-head-idle）随类可见；
//      ② 淡出结构存在（卡元素 animationName 由 none 变为非 none，或 transition 出现
//         opacity，或 .card-wrap 动画被替换）——差分对比加类前后；
//      ③ 熄灯：.office-scene 的 opacity 降低或 filter 变化（加类前后差分）。
//   读取后移除类还原，不残留 DOM 改动。
//
// 说明：page.$eval 仅在本项目自己的本地页面做临时 class 翻转与只读查询（仿用例 11
// 的空状态翻转套路），不执行外部不可信代码。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, cardSnapshot } from "../helpers/board.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLE_CSS = path.join(ROOT, "web", "style.css");

export default {
  name: "14-超时回收(方向B)",
  spec: "style.css 含 .timeout-leaving 选择器；卡片挂该类后打盹😴可见、淡出结构（opacity 过渡/动画）与熄灯差分出现",
  run: async (ctx) => {
    const { page, makeId, check, sleep } = ctx;
    const id = makeId("tmout");
    const results = [];

    // ── D1：静态校验 style.css 含 .timeout-leaving 选择器 ──
    let cssText = "";
    try {
      cssText = await readFile(STYLE_CSS, "utf8");
    } catch (err) {
      results.push(check("D1 style.css 含 .timeout-leaving", false, "可读 style.css", String(err.message || err)));
    }
    if (cssText) {
      results.push(check("D1 style.css 含 .timeout-leaving", cssText.includes(".timeout-leaving"),
        ".timeout-leaving 选择器", cssText.includes(".timeout-leaving") ? "存在" : "缺失", "方向B：超时回收动画需落地 CSS"));
    }

    // ── D2-D4：页面内给 e2e 子卡挂 .timeout-leaving，差分断言打盹/淡出/熄灯 ──
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id);
    if (!appear) return results.concat([check("D2 子卡出现", false, "出现", "未出现")]);

    // 等卡片稳定：入场 / 新任务翻脸 / 状态闪烁等临时类全部移除后再做差分，避免误判
    const settled = await waitUntil(async () => {
      const s = await cardSnapshot(page, id);
      if (!s) return false;
      return !["enter", "task-assigned", "status-flash", "removing"].some((c) => s.classes.includes(c));
    }, 8000, 150, "卡片稳定");
    if (!settled) {
      return results.concat([check("D2 卡片进入稳定态", false, "无临时类", "仍有 enter/task-assigned 等")]);
    }

    // 差分探针：add=true 挂 .timeout-leaving，false 移除；返回加类后的 DOM 快照
    const probe = (add) =>
      page.$eval(`.agent-card[data-id="${id}"]`, (el, addClass) => {
        const visEmoji = () =>
          Array.from(el.querySelectorAll(".office-head"))
            .filter((e) => getComputedStyle(e).display !== "none")
            .map((e) => e.textContent.trim());
        if (addClass) el.classList.add("timeout-leaving");
        else el.classList.remove("timeout-leaving");
        const cs = getComputedStyle(el);
        const wrap = el.querySelector(".card-wrap");
        const scene = el.querySelector(".office-scene");
        const headIdle = el.querySelector(".office-head-idle");
        return {
          emoji: visEmoji(),
          idleVisible: headIdle ? getComputedStyle(headIdle).display !== "none" : false,
          cardAnim: cs.animationName,
          cardTransition: cs.transitionProperty,
          wrapAnim: wrap ? getComputedStyle(wrap).animationName : null,
          sceneOpacity: scene ? getComputedStyle(scene).opacity : null,
          sceneFilter: scene ? getComputedStyle(scene).filter : null,
        };
      }, add).catch(() => null);

    const before = await probe(false);      // 基线（确保类不在）
    const during = await probe(true);       // 挂类后
    await probe(false).catch(() => {});     // 还原，不残留改动

    if (!before || !during) {
      return results.concat([check("D2 差分快照可用", false, "before+during", `${before ? "before" : "缺"} ${during ? "during" : "缺"}`)]);
    }

    // D2：打盹 😴 —— 加类后 office-head-idle 可见且表情含 😴
    results.push(check("D2 打盹表情😴可见", during.idleVisible && during.emoji.includes("😴"),
      "含😴", during.emoji.length ? during.emoji.join(",") : "无可见表情", "方向B：.timeout-leaving 显示打盹层"));
    results.push(check("D2b 打盹为类驱动（差分）", !before.emoji.includes("😴"),
      "加类前无😴", before.emoji.join(","), "方向B：差分确认 😴 由 .timeout-leaving 驱动"));

    // D3：淡出结构 —— 加类后出现 opacity 过渡 / 卡元素动画 / 卡片wrap动画被替换
    const fadeDetected =
      (during.cardAnim !== "none" && before.cardAnim === "none") ||
      (during.cardTransition.includes("opacity") && !before.cardTransition.includes("opacity")) ||
      (during.wrapAnim !== before.wrapAnim);
    results.push(check("D3 淡出结构存在", fadeDetected,
      "animation 或 opacity 过渡", `cardAnim=${during.cardAnim} transition=${during.cardTransition} wrapAnim=${before.wrapAnim}→${during.wrapAnim}`,
      "方向B：.timeout-leaving 驱动熄灯→淡出（本轮断言类驱动的淡出机制存在）"));

    // D4：熄灯 —— 加类后 .office-scene 变暗（opacity 降低 或 filter 变化）
    const dimDetected =
      Number(during.sceneOpacity) < Number(before.sceneOpacity) ||
      during.sceneFilter !== before.sceneFilter;
    results.push(check("D4 熄灯（场景变暗）", dimDetected,
      "opacity 降低或 filter 变化", `sceneOpacity=${before.sceneOpacity}→${during.sceneOpacity} filter=${before.sceneFilter}→${during.sceneFilter}`,
      "方向B：熄灯阶段可经 scene 的 opacity/filter 差分观测"));

    return results;
  },
};
