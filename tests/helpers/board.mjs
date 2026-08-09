// tests/helpers/board.mjs — Playwright 看板封装与 DOM 断言工具
//
// 职责：
//   - 启动浏览器（默认优先使用系统 Edge/Chrome，避免下载浏览器内核）
//   - 打开看板页面、等待首帧渲染完成
//   - 提供卡片快照 / 火柴人快照 / 轮询等待等断言辅助函数
//
// 说明：A-F 修复方案全部在前端（app.js + style.css），本套件通过
// "真实页面 + 注入事件"做端到端验证：服务端状态机只负责把事件聚合成
// /api/state，前端轮询渲染并驱动动画。
//
// 注意：page.$eval / page.$$eval 是 Playwright 官方 API，用于在本项目自己的
// 本地看板页面里执行只读的 DOM 查询断言，不执行外部不可信代码。

import { chromium } from "playwright";

const BASE_URL = "http://localhost:8617/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动浏览器：优先环境变量 VC_TEST_BROWSER（msedge/chrome/chromium），
 * 否则依次尝试系统 Edge → Chrome → playwright 自带 chromium。 */
export async function launchBrowser({ headless = true } = {}) {
  const override = process.env.VC_TEST_BROWSER;
  const candidates = override ? [override] : ["msedge", "chrome"];
  for (const channel of candidates) {
    try {
      if (channel === "chromium") return await chromium.launch({ headless });
      return await chromium.launch({ headless, channel });
    } catch { /* 尝试下一个 */ }
  }
  throw new Error("无法启动浏览器：请设置 VC_TEST_BROWSER=chromium 或安装系统 Edge/Chrome");
}

/** 在给定浏览器上新建独立 context + 页面并打开看板。
 * 每个用例使用独立页面，保证前端状态（动画基准等）互不干扰。 */
export async function newPage(browser, { reducedMotion = false } = {}) {
  const context = await browser.newContext({
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => { console.log(`[页面JS错误] ${err.message}`); });
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  // 等 app.js 初始化完成（动画层已挂载、首帧渲染已跑）
  await page.waitForFunction(() => !!document.getElementById("anim-layer"), null, { timeout: 8000 });
  return { context, page };
}

/** 便捷入口：一次性启动浏览器并打开默认页面。 */
export async function openBoard(opts = {}) {
  const browser = await launchBrowser(opts);
  const { context, page } = await newPage(browser, opts);
  return { browser, context, page };
}

/** 轮询等待，fn 返回真值即结束；超时返回 null。 */
export async function waitUntil(fn, timeout = 8000, interval = 150, desc = "") {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); } catch { last = null; }
    if (last) return last;
    await sleep(interval);
  }
  return null;
}

/** 等待卡片出现（.agent-card[data-id=...] 挂载到 DOM）。 */
export async function waitForCard(page, id, timeout = 8000) {
  return waitUntil(() => cardSnapshot(page, id), timeout, 150, `等卡片 ${id} 出现`);
}

/** 等待卡片消失（DOM 移除）。 */
export async function waitForCardGone(page, id, timeout = 12000) {
  return waitUntil(() => {
    return page.$(`.agent-card[data-id="${id}"]`).then((el) => (el ? null : true));
  }, timeout, 200, `等卡片 ${id} 消失`);
}

/** 卡片状态快照：类名、可见办公表情、状态区内容、失败/成功视觉、辉光与抖动。
 * 卡片不存在时返回 null。opts.lastMatch=true 时取 DOM 中最后一张同 id 卡片
 * （方案 F：同 id 复活后新旧两卡并存，新卡排在后）。 */
export async function cardSnapshot(page, id, opts = {}) {
  const selector = `.agent-card[data-id="${id}"]`;
  if (opts.lastMatch) {
    return page.$$eval(selector, (els) => {
      if (!els.length) return null;
      const el = els[els.length - 1];
      const visibleEmoji = Array.from(el.querySelectorAll(".office-head"))
        .filter((e) => getComputedStyle(e).display !== "none")
        .map((e) => e.textContent.trim());
      const head = el.querySelector(".office-head");
      return {
        classes: Array.from(el.classList),
        emoji: visibleEmoji,
        statusEmoji: el.querySelector(".status-emoji")?.textContent.trim() ?? null,
        statusLabel: el.querySelector(".status-label")?.textContent.trim() ?? null,
        spinner: !!el.querySelector(".spinner"),
        failedX: !!el.querySelector(".failed-x"),
        checkSvg: !!el.querySelector(".check-svg"),
        headFilter: head ? getComputedStyle(head).filter : null,
        cardWrapAnim: el.querySelector(".card-wrap")
          ? getComputedStyle(el.querySelector(".card-wrap")).animationName
          : null,
      };
    }).catch(() => null);
  }
  return page.$eval(selector, (el) => {
    const visibleEmoji = Array.from(el.querySelectorAll(".office-head"))
      .filter((e) => getComputedStyle(e).display !== "none")
      .map((e) => e.textContent.trim());
    const head = el.querySelector(".office-head");
    return {
      classes: Array.from(el.classList),
      emoji: visibleEmoji,
      statusEmoji: el.querySelector(".status-emoji")?.textContent.trim() ?? null,
      statusLabel: el.querySelector(".status-label")?.textContent.trim() ?? null,
      spinner: !!el.querySelector(".spinner"),
      failedX: !!el.querySelector(".failed-x"),
      checkSvg: !!el.querySelector(".check-svg"),
      headFilter: head ? getComputedStyle(head).filter : null,
      cardWrapAnim: el.querySelector(".card-wrap")
        ? getComputedStyle(el.querySelector(".card-wrap")).animationName
        : null,
    };
  }).catch(() => null);
}

/** 火柴人快照：anim-layer 下所有 .stickman-runner。
 * 每项含：flip（是否交回方向）、可见头部表情、绿勾 opacity。 */
export async function stickmanSnapshot(page) {
  return page.$$eval("#anim-layer .stickman-runner", (els) =>
    els.map((e) => {
      const mark = e.querySelector(".report-mark");
      return {
        flip: e.classList.contains("flip"),
        reportMarkOpacity: mark ? getComputedStyle(mark).opacity : null,
        headVisible: Array.from(e.querySelectorAll(".stick-head"))
          .filter((h) => getComputedStyle(h).display !== "none")
          .map((h) => h.textContent.trim()),
      };
    })
  );
}

/** 在卡片上临时追加/移除一组 class，并读取叠加态下的可见表情。
 * 用于"表情显隐互斥"（用例 8）的 CSS 级断言。 */
export async function setClassesAndReadEmoji(page, id, classes) {
  return page.$eval(`.agent-card[data-id="${id}"]`, (el, cls) => {
    cls.forEach((c) => el.classList.add(c));
    const emoji = Array.from(el.querySelectorAll(".office-head"))
      .filter((e) => getComputedStyle(e).display !== "none")
      .map((e) => e.textContent.trim());
    cls.forEach((c) => el.classList.remove(c));
    return emoji;
  }, classes).catch(() => null);
}

/* ---------- 方向 C/D 新增断言辅助（动画趣味化优化） ---------- */

/** 工具屏快照：卡片 tool-type-* 类 + .screen-content 内各 .screen-* 子层计算 display。
 * 用于"按当前工具显示对应屏幕层"（方向 C）的 CSS 级断言。
 * 卡片不存在返回 null；screen[k]：'none'（隐藏）| 其它 display 值（可见）| 'missing'（元素缺失）。 */
export async function toolScreenSnapshot(page, id) {
  return page.$eval(`.agent-card[data-id="${id}"]`, (el) => {
    const kinds = ["code", "search", "dispatch", "default"];
    const screen = {};
    kinds.forEach((k) => {
      const node = el.querySelector(".screen-content .screen-" + k);
      screen[k] = node ? getComputedStyle(node).display : "missing";
    });
    return {
      classes: Array.from(el.classList),
      hasScreenContent: !!el.querySelector(".screen-content"),
      screen,
    };
  }).catch(() => null);
}

/** 动画层当前尘土粒子数（#anim-layer .stick-dust，方向 A）。 */
export async function animDustCount(page) {
  return page.$$eval("#anim-layer .stick-dust", (els) => els.length).catch(() => 0);
}

/** 工具屏动画快照：卡片 tool-type-* 类 + .screen-content 内各 .screen-* 子层的
 * 计算 display 与 animationName（动画完善-方向C：tool 状态子层应有微动画）。
 * 卡片不存在返回 null；screen[k] = { display, animationName }，
 * 子层缺失时 display='missing'、animationName=null。 */
export async function toolScreenAnimSnapshot(page, id) {
  return page.$eval(`.agent-card[data-id="${id}"]`, (el) => {
    const kinds = ["code", "search", "dispatch", "default"];
    const screen = {};
    kinds.forEach((k) => {
      const node = el.querySelector(".screen-content .screen-" + k);
      if (!node) { screen[k] = { display: "missing", animationName: null }; return; }
      const cs = getComputedStyle(node);
      screen[k] = { display: cs.display, animationName: cs.animationName };
    });
    return {
      classes: Array.from(el.classList),
      screen,
    };
  }).catch(() => null);
}
