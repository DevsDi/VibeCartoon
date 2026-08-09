// tests/cases/17-motion-toggle.mjs — 用例 17：特效密度开关（localStorage vc-motion）
//
// 断言目标（契约来自 web/app.js loadPrefs/setMotion/applyMotion + style.css body[data-motion] 规则）：
//   - 默认（无偏好）→ body[data-motion=auto]
//   - localStorage vc-motion=off → 刷新后 body[data-motion=off]，且 .bg-symbols 被 CSS 隐藏（display:none）
//   - localStorage vc-motion=reduced → 刷新后 body[data-motion=reduced]
//   - 偏好持久化：切换后不丢失；功能不受开关影响（off 下子卡仍可正常渲染）
// 方法：在页面上下文内直接写 localStorage → reload → 断言 body 属性与 UI 控件状态。

import { eventLine, injectEvents } from "../helpers/inject.mjs";
import { waitForCard } from "../helpers/board.mjs";

export default {
  name: "17-特效密度开关(vc-motion)",
  spec: "localStorage vc-motion=off/reduced → body[data-motion=off/reduced]；off 下背景符号隐藏、功能正常、控件同步",
  run: async (ctx) => {
    const { page, makeId, check } = ctx;
    const results = [];
    const id = makeId("motion");

    const reloadAndWaitInit = async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!document.getElementById("anim-layer"), null, { timeout: 8000 });
    };
    const bodyMotion = () => page.evaluate(() => document.body.dataset.motion || null);

    // 0) 默认（上下文无自动化偏好）→ auto
    const auto = await bodyMotion();
    results.push(check("M0 默认特效密度 auto", auto === "auto", "auto", auto));

    // 1) vc-motion=off → body[data-motion=off]，控件选中 off，背景符号隐藏
    await page.evaluate(() => { try { localStorage.setItem("vc-motion", "off"); } catch { /* 隐私模式忽略 */ } });
    await reloadAndWaitInit();
    const off = await bodyMotion();
    results.push(check("M1 vc-motion=off → body[data-motion=off]", off === "off", "off", off));
    const selOff = await page.evaluate(() => document.getElementById("motion-select")?.value ?? null);
    results.push(check("M2 控件同步选中 off", selOff === "off", "off", selOff));
    const bgHidden = await page.$eval("body", (b) => {
      const s = b.querySelector(".bg-symbols");
      return s ? getComputedStyle(s).display === "none" : null;
    }).catch(() => null);
    results.push(check("M3 off 关闭背景符号动画(.bg-symbols display:none)", bgHidden === true,
      "none", String(bgHidden), "style.css: body[data-motion=off] .bg-symbols { display:none }"));

    // 2) vc-motion=reduced → body[data-motion=reduced]
    await page.evaluate(() => { try { localStorage.setItem("vc-motion", "reduced"); } catch { /* 同上 */ } });
    await reloadAndWaitInit();
    const reduced = await bodyMotion();
    results.push(check("M4 vc-motion=reduced → body[data-motion=reduced]", reduced === "reduced", "reduced", reduced));

    // 3) 回到 off，验证功能不受影响：子卡仍可正常渲染
    await page.evaluate(() => { try { localStorage.setItem("vc-motion", "off"); } catch { /* 同上 */ } });
    await reloadAndWaitInit();
    await injectEvents([eventLine({ hook: "subagent_start", agent: id, type: "general-purpose" })]);
    const appear = await waitForCard(page, id, 8000);
    results.push(check("M5 off 下子卡仍正常渲染", !!appear, "出现", appear ? "存在" : "未出现",
      "动效开关只降级动画，不影响功能"));

    return results;
  },
};