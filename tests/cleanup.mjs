// tests/cleanup.mjs — 清理 events.jsonl 中的测试注入行
//
// 测试事件以 e2e- 开头的 agent id 注入 data/events.jsonl，本脚本把它们
// 从文件中过滤掉（原子替换：临时文件 + rename）。
//
// 注意：
//   - 服务端内存中的 agent 状态无法通过删文件清除，只能等 STALE_MS
//     （10 分钟）超时自动回收；重写文件后服务端 readOffset 检测到文件
//     变小会自动归零并重放剩余真实事件（状态确定性重建，与测试前一致）。
//   - 重写期间若 hooks/collect.mjs 恰好追加新行，存在极小概率的竞态丢失，
//     属可接受的测试环境风险。
//
// 用法：node tests/cleanup.mjs

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENTS_FILE } from "./helpers/inject.mjs";

/** 过滤掉 agent id 以 e2e- 开头的行，返回 { removed, kept }。 */
export async function cleanupInjectedEvents() {
  const raw = await readFile(EVENTS_FILE, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    let drop = false;
    try {
      const e = JSON.parse(line);
      drop = !!(e && typeof e.agent === "string" && e.agent.startsWith("e2e-"));
    } catch { /* 损坏行保留原样 */ }
    if (drop) removed++;
    else kept.push(line);
  }
  if (removed === 0) return { removed: 0, kept: kept.length };
  const tmp = EVENTS_FILE + ".cleanup.tmp";
  await writeFile(tmp, kept.join("\n") + "\n", "utf8");
  await rename(tmp, EVENTS_FILE);
  return { removed, kept: kept.length };
}

// 直接运行时执行（node tests/cleanup.mjs）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  cleanupInjectedEvents()
    .then((r) => console.log(`清理完成：移除 ${r.removed} 行测试事件，保留 ${r.kept} 行。`))
    .catch((err) => { console.error("清理失败:", err.message); process.exitCode = 1; });
}
