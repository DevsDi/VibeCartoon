// hooks/dry-run.mjs — 演示脚本
// 读取 sample-payloads.json，逐个调用 collect.mjs --dry，仅打印解析结果，不写事件文件。
//
// 用法：
//   node hooks/dry-run.mjs

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const samples = JSON.parse(
  await readFile(path.join(__dirname, "sample-payloads.json"), "utf8"),
);
const collectPath = path.join(__dirname, "collect.mjs");

for (const { name, payload } of samples) {
  const res = spawnSync(process.execPath, [collectPath, "--dry"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });

  console.log(`\n===== ${name} =====`);
  console.log((res.stdout || "").trim() || "(无输出)");
  if (res.status !== 0) {
    console.error(`[exit ${res.status}] stderr: ${(res.stderr || "").trim()}`);
  }
}