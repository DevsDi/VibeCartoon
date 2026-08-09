// tests/cases/10-tool-screen.mjs — 用例 10：按当前工具显示对应屏幕层（方向 C）
//
// 断言目标（方向 C，实现依据 web/app.js updateCard 按 currentTool 挂 tool-type-* 类、
// style.css 按卡类显隐 .screen-content 下 .screen-code / .screen-search /
// .screen-dispatch / .screen-default 四个默认隐藏子层）：
//   1. pre_tool_use 依次为 Read/Grep/Agent/Bash 时，卡片挂
//      tool-type-code / tool-type-search / tool-type-dispatch / tool-type-default，
//      且对应 .screen-* 子层 getComputedStyle().display 非 none、其余子层为 none；
//   2. post_tool_use（转 thinking）后 tool-type-* 类消失，屏幕层回到默认隐藏。
// 方法：注入事件驱动真实状态（600ms 轮询），读 DOM 类与 SVG 层计算 display。
//
// 说明：page.$eval 仅在本项目自己的本地页面执行只读 DOM 查询，不执行外部不可信代码。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard, waitUntil, toolScreenSnapshot } from "../helpers/board.mjs";

// 工具 → 工具类型类 映射（与计划约定一致）
const TOOL_TYPE = [
  ["Read", "code"],
  ["Grep", "search"],
  ["Agent", "dispatch"],
  ["Bash", "default"],
];

export default {
  name: "10-工具屏(方向C)",
  spec: "按当前工具挂 tool-type-code/search/dispatch/default，对应 .screen-* 层显隐；转 thinking 后消失",
  run: async (ctx) => {
    const { page, makeId, check } = ctx;
    const id = makeId("toolscreen");
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
    if (!appear) return [check("T1 子卡出现", false, "出现", "未出现")];

    // T1：OFFICE_SVG 内 .screen-content 层结构存在（与状态无关）
    const base = await toolScreenSnapshot(page, id);
    results.push(check("T1b .screen-content 结构存在", !!base && base.hasScreenContent, true, base ? base.hasScreenContent : false, "方向C：OFFICE_SVG 内新增 .screen-content 层"));

    // 依次注入 4 种工具：断言 tool-type-* 类 + 对应屏幕层显隐（其余为 none）
    for (let i = 0; i < TOOL_TYPE.length; i++) {
      const [tool, type] = TOOL_TYPE[i];
      await injectEvents([eventLine({ hook: "pre_tool_use", agent: id, tool, detail: detailFor(tool) })]);
      const snap = await waitUntil(async () => {
        const s = await toolScreenSnapshot(page, id);
        return s && s.classes.includes("tool-type-" + type) ? s : null;
      }, 6000, 150, `tool=${tool} → tool-type-${type}`);
      if (!snap) {
        results.push(check(`T${i + 2} tool=${tool} → tool-type-${type}`, false, "类已挂", "未出现", "方向C：按 currentTool 挂对应 tool-type-* 类"));
        continue;
      }
      const others = Object.keys(snap.screen).filter((k) => k !== type);
      results.push(check(`T${i + 2} tool=${tool} → tool-type-${type}`, true, `tool-type-${type}`, `tool-type-${type}`));
      results.push(check(`T${i + 2}b 对应屏幕层可见(${type})`, snap.screen[type] !== "none" && snap.screen[type] !== "missing", "display≠none", `display=${snap.screen[type]}`, "方向C：.screen-* 层按卡类显隐"));
      results.push(check(`T${i + 2}c 其余子层为 none`, others.every((k) => snap.screen[k] === "none"), "其余 none", JSON.stringify(snap.screen), "方向C：四个 .screen-* 子层互斥"));
    }

    // 转 thinking：tool-type-* 类消失，屏幕层回到默认隐藏
    await injectEvents([eventLine({ hook: "post_tool_use", agent: id, tool: "Bash", detail: { tool_response: { type: "text" } } })]);
    const think = await waitUntil(async () => {
      const s = await toolScreenSnapshot(page, id);
      return s && s.classes.includes("status-thinking") ? s : null;
    }, 6000, 150, "thinking 状态");
    if (!think) {
      results.push(check("T9 转 thinking 后 tool-type-* 消失", false, "status-thinking", "未出现"));
    } else {
      const left = think.classes.filter((c) => c.startsWith("tool-type-"));
      results.push(check("T9 转 thinking 后 tool-type-* 消失", left.length === 0, "无 tool-type-*", left.length ? left.join(",") : "无", "方向C：仅 tool 状态下挂工具类型类（currentTool 仍保留但类移除）"));
      const visible = Object.keys(think.screen).filter((k) => think.screen[k] !== "none" && think.screen[k] !== "missing");
      results.push(check("T10 转 thinking 后屏幕层全部隐藏", visible.length === 0, "全部 none", visible.length ? JSON.stringify(think.screen) : "none", "方向C：无 tool-type-* 类时 .screen-* 默认隐藏"));
    }

    return results;
  },
};
