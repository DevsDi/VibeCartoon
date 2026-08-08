// tests/run.mjs — E2E 测试入口
//
// 顺序执行 tests/cases/*.mjs 中的各用例，每个用例使用独立页面（同一浏览器实例），
// 通过向 data/events.jsonl 追加构造事件驱动真实的前端行为（A-F 修复方案验收）。
//
// 用法：
//   node tests/run.mjs                        # 全部用例
//   node tests/run.mjs --only=01-失败          # 按用例名前缀过滤
//   node tests/run.mjs --headful              # 有头模式（可观察动画）
//   node tests/run.mjs --keep-events          # 测试后不清理由注入产生的 e2e- 行
//   node tests/run.mjs --report=out.json      # 报告输出路径（默认 tests/reports/latest.json）
//
// 环境要求：
//   - 看板服务已在 http://localhost:8617 运行（npm start）
//   - 浏览器：优先系统 Edge/Chrome（无需下载内核），可用 VC_TEST_BROWSER=chromium 指定
//
// 输出：
//   1. 控制台逐用例 PASS/FAIL 明细 + 汇总
//   2. tests/reports/latest.json（结构化报告，供测试报告模板填充）

import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser, newPage } from "./helpers/board.mjs";
import { cleanupInjectedEvents } from "./cleanup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES_DIR = path.join(ROOT, "tests", "cases");
const HEALTH_URL = "http://localhost:8617/api/health";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    only: null, headless: true, keepEvents: false,
    report: path.join(ROOT, "tests", "reports", "latest.json"),
  };
  for (const a of argv) {
    if (a.startsWith("--only=")) opts.only = a.slice(7);
    else if (a === "--headful") opts.headless = false;
    else if (a === "--keep-events") opts.keepEvents = true;
    else if (a.startsWith("--report=")) opts.report = path.resolve(a.slice(9));
  }
  return opts;
}

async function checkHealth() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("================ vc-dashboard E2E 测试（表情体系方案 A-F 验收）================");

  if (!(await checkHealth())) {
    console.error("服务未运行：请先执行 npm start（http://localhost:8617）再运行测试。");
    process.exit(1);
  }

  // 加载用例
  const files = (await readdir(CASES_DIR)).filter((f) => f.endsWith(".mjs")).sort();
  const cases = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(CASES_DIR, f)).href);
    if (mod.default && typeof mod.default.run === "function") cases.push(mod.default);
  }
  if (opts.only) {
    const filtered = cases.filter((c) => c.name.startsWith(opts.only));
    if (!filtered.length) { console.error(`--only=${opts.only} 未匹配任何用例`); process.exit(1); }
    cases.splice(0, cases.length, ...filtered);
  }
  console.log(`共 ${cases.length} 个用例：${cases.map((c) => c.name).join(" | ")}`);

  // 启动浏览器（复用实例，逐用例独立页面）
  let browser;
  try { browser = await launchBrowser({ headless: opts.headless }); }
  catch (err) { console.error(`浏览器启动失败：${err.message}`); process.exit(1); }

  const seq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const report = { startedAt: new Date().toISOString(), opts: { ...opts, report: undefined }, cases: [] };
  const makeId = (prefix) => `e2e-${prefix}-${seq}`;

  let passTotal = 0, failTotal = 0;

  for (const tc of cases) {
    console.log(`\n━━━ 用例 ${tc.name} ━━━`);
    console.log(`    验收依据：${tc.spec}`);
    const results = [];
    const check = (desc, pass, expected, actual, note = "") =>
      results.push({ desc, pass, expected: fmt(expected), actual: fmt(actual), note });

    const { context, page } = await newPage(browser, { headless: opts.headless, reducedMotion: false });
    const ctx = {
      page,
      makeId,
      check,
      results,
      sleep,
      // 供用例 07（reduced-motion）创建独立上下文
      newPage: (o = {}) => newPage(browser, { headless: opts.headless, ...o }),
    };
    try {
      await tc.run(ctx);
    } catch (err) {
      results.push({ desc: "用例执行异常", pass: false, expected: "无异常", actual: String(err.message || err), note: err.stack || "" });
    } finally {
      await context.close().catch(() => {});
    }

    // 输出结果
    for (const r of results) {
      const tag = r.pass ? "PASS" : "FAIL";
      if (r.pass) passTotal++; else failTotal++;
      console.log(`  [${tag}] ${r.desc}`);
      if (!r.pass) {
        console.log(`        期望: ${JSON.stringify(r.expected)}  实际: ${JSON.stringify(r.actual)}`);
        if (r.note) console.log(`        说明: ${r.note}`);
      }
    }
    report.cases.push({ name: tc.name, spec: tc.spec, results, passed: results.filter((r) => r.pass).length, total: results.length });
  }

  await browser.close();

  // 文件清理（默认执行；--keep-events 跳过）
  if (!opts.keepEvents) {
    try {
      const r = await cleanupInjectedEvents();
      console.log(`\n[清理] 已从 events.jsonl 移除 ${r.removed} 行测试事件。`);
      console.log("[提示] 服务端内存中的测试 agent 将由 10 分钟超时自动回收，不影响真实看板。");
    } catch (err) {
      console.log(`\n[清理] 失败（可稍后执行 node tests/cleanup.mjs）：${err.message}`);
    }
  } else {
    console.log("\n[提示] 已跳过文件清理（--keep-events），可执行 node tests/cleanup.mjs 手动清理。");
  }

  // 汇总
  report.finishedAt = new Date().toISOString();
  report.summary = { pass: passTotal, fail: failTotal, cases: report.cases.length };
  await mkdir(path.dirname(opts.report), { recursive: true });
  await writeFile(opts.report, JSON.stringify(report, null, 2), "utf8");

  const failedItems = report.cases.flatMap((c) => c.results.filter((r) => !r.pass).map((r) => ({ case: c.name, ...r })));
  console.log(`\n================ 测试汇总 ================`);
  console.log(`用例数: ${report.cases.length} | 断言通过: ${passTotal} | 断言失败: ${failTotal}`);
  if (failedItems.length) {
    console.log(`\n--- 失败项清单（供修复与复核） ---`);
    failedItems.forEach((f, i) => {
      console.log(`${i + 1}. [${f.case}] ${f.desc}`);
      console.log(`   期望: ${JSON.stringify(f.expected)} | 实际: ${JSON.stringify(f.actual)}`);
      if (f.note) console.log(`   说明: ${f.note}`);
    });
  }
  console.log(`\n结构化报告已写入: ${opts.report}`);
}

function fmt(v) {
  if (Array.isArray(v) || v === null || v === undefined) return v;
  return v;
}

main().catch((err) => { console.error("测试运行失败:", err); process.exit(1); });
