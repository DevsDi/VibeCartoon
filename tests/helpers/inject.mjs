// tests/helpers/inject.mjs — 事件注入助手
//
// 用途：把构造的 hook 事件以 collect.mjs 的归一化行格式追加到 data/events.jsonl。
// 服务端 /api/state 采用"增量读"（readOffset），前端每 600ms 轮询一次，
// 因此追加后最多 ~0.7s 内前端即可渲染出对应状态变化。
//
// 注意：
// 1. 测试事件使用 e2e- 前缀的 agent id，便于 cleanup.mjs 过滤清理；
// 2. 服务端内存中的 agent 状态只能由 STALE_MS（10 分钟）超时回收，
//    文件清理不会清除内存状态——详见 README 说明。

import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录（本文件位于 <root>/tests/helpers/）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EVENTS_FILE = path.join(ROOT, "data", "events.jsonl");

/** 构造一条事件行（与 hooks/collect.mjs buildLine 输出的字段一致）。
 * @param {object} opts { hook, agent, type, tool, status, detail, ts }
 *   - hook:   subagent_start | pre_tool_use | post_tool_use | subagent_stop | notification
 *   - agent:  子 Agent id（main 为 null，见 server.mjs key 规则）
 *   - detail: 可为 JSON 字符串或对象（服务端两者都兼容）
 * @returns {object} 事件对象
 */
export function eventLine({ hook, agent = null, type = null, tool = null, status = null, detail = null, ts = null }) {
  return {
    ts: ts ?? new Date().toISOString(),
    hook,
    agent,
    type,
    tool,
    status,
    detail: detail == null ? null : (typeof detail === "string" ? detail : JSON.stringify(detail)),
    tok: null,
  };
}

/** 按顺序追加事件行到 events.jsonl。
 * @param {Array<object>} events 由 eventLine() 构造的事件
 */
export async function injectEvents(events) {
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(EVENTS_FILE, text, { encoding: "utf8" });
}
