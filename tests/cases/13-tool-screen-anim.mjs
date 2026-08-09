// tests/cases/13-tool-screen-anim.mjs — 用例 13：工具屏幕微动画（动画完善-方向C）
//
// 断言目标（方向 C，实现依据 web/app.js 按 currentTool 挂 tool-type-* 类、
// style.css 给 .screen-content 下对应 .screen-* 子层加微动画）：
//   1. pre_tool_use 依次为 Read/Grep/Agent/Bash 时，卡片挂
//      tool-type-code / tool-type-search / tool-type-dispatch / tool-type-default，
//      且对应 .screen-* 子层 getComputedStyle().animationName 非 'none'（有微动画）、
//      display 非 none，其余子层 display 为 none（互斥）；
//   2. post_tool_use（转 thinking）后 tool-type-* 类消失，各 .screen-* 子层回到隐藏。
//
// 说明：display 显隐已在用例 10 覆盖，本用例聚焦"可见层有动画"；与用例 10 互补。
// page.$eval 仅在本项目自己的本地页面执行只读 DOM 查询，不执行外部不可信代码。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, toolScreenAnimSnapshot } from "../helpers/board.mjs";

// 工具 → 工具类型类 映射（与用例 10 / 计划约定一致）
const TOOL_TYPE = [
  ["Read", "code"],
  ["Grep", "search"],
  ["Agent", "dispatch"],
  ["Bash", "default"],
];

export default {
  name: "13-工具屏微动画(方向C)",
  spec: "tool 状态且挂 tool-type-* 类时对应 .screen-* 子层 animationName 非 none；转 thinking 后层隐藏",
  run: async (ctx) => {
    const { page, makeId, check } = ctx;
    const id = makeId("toolanim");
    const results = [];
    const detailFor = (tool) =>
      tool === "Agent"
        ? { tool_input: { description: "e2e 派发任务" } }
        : tool === "Bash"
          ? { tool_input: { command: "echo hi" } }
          : { tool_input: { file_path: "/e2e/tmp" } };

    // 准备一张子卡（queued）
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id);
    if (!appear) return [check("S1 子卡出现", false, "出现", "未出现")];

    // 依次注入 4 种工具：断言 tool-type-* 类 + 对应 .screen-* 子层有动画（其余隐藏）
    for (let i = 0; i < TOOL_TYPE.length; i++) {
      const [tool, type] = TOOL_TYPE[i];
      await injectEvents([eventLine({ hook: "pre_tool_use", agent: id, tool, detail: detailFor(tool) })]);
      const snap = await waitUntil(async () => {
        const s = await toolScreenAnimSnapshot(page, id);
        return s && s.classes.includes("tool-type-" + type) ? s : null;
      }, 6000, 150, `tool=${tool} → tool-type-${type}`);
      if (!snap) {
        results.push(check(`S${i + 2} tool=${tool} → tool-type-${type}`, false, "类已挂", "未出现", "方向C：按 currentTool 挂对应 tool-type-* 类"));
        continue;
      }
      const self = snap.screen[type];
      const others = Object.keys(snap.screen).filter((k) => k !== type);
      results.push(check(`S${i + 2} tool=${tool} → tool-type-${type}`, true, `tool-type-${type}`, `tool-type-${type}`));
      results.push(check(`S${i + 2}b 对应屏幕层可见(${type})`, self && self.display !== "none" && self.display !== "missing",
        "display≠none", self ? `display=${self.display}` : "missing", "方向C：.screen-* 层按卡类显隐"));
      results.push(check(`S${i + 2}c 可见屏幕层有微动画(${type})`, !!self && self.animationName !== "none",
        "animationName≠none", self ? `animationName=${self.animationName}` : "missing", "方向C：tool 状态下子层应有微动画"));
      results.push(check(`S${i + 2}d 其余子层隐藏`, others.every((k) => snap.screen[k].display === "none"),
        "其余 display=none", JSON.stringify(snap.screen), "方向C：四个 .screen-* 子层互斥"));
    }

    // 转 thinking：tool-type-* 类消失，屏幕层回到默认隐藏
    await injectEvents([eventLine({ hook: "post_tool_use", agent: id, tool: "Bash", detail: { tool_response: { type: "text" } } })]);
    const think = await waitUntil(async () => {
      const s = await toolScreenAnimSnapshot(page, id);
      return s && s.classes.includes("status-thinking") ? s : null;
    }, 6000, 150, "thinking 状态");
    if (!think) {
      results.push(check("S10 转 thinking 后 tool-type-* 消失", false, "status-thinking", "未出现"));
    } else {
      const left = think.classes.filter((c) => c.startsWith("tool-type-"));
      results.push(check("S10 转 thinking 后 tool-type-* 消失", left.length === 0, "无 tool-type-*", left.length ? left.join(",") : "无", "方向C：仅 tool 状态下挂工具类型类"));
      const visible = Object.keys(think.screen).filter((k) => think.screen[k].display !== "none" && think.screen[k].display !== "missing");
      results.push(check("S11 转 thinking 后屏幕层全部隐藏", visible.length === 0, "全部 display=none",
        visible.length ? JSON.stringify(think.screen) : "none", "方向C：无 tool-type-* 类时 .screen-* 默认隐藏"));
    }

    return results;
  },
};
