# vc-dashboard E2E 测试（表情体系修复方案 A-F 验收）

## 一、运行说明

### 环境要求
| 项 | 要求 |
|---|---|
| Node.js | >= 18（本项目 v24 验证通过） |
| 看板服务 | 已在 `http://localhost:8617` 运行（`npm start`） |
| 浏览器 | 系统 Edge 或 Chrome（无需下载内核）；也可 `VC_TEST_BROWSER=chromium` 用 Playwright 自带内核（需先 `npx playwright install chromium`） |
| 依赖 | `npm install`（已含 playwright devDependency） |

### 运行命令
```bash
npm test                        # 运行全部用例（默认无头模式）
npm test -- --headful           # 有头模式（可观察动画过程）
npm test -- --only=01-失败       # 只跑用例名前缀匹配的用例
npm test -- --keep-events       # 测试后不清理 events.jsonl 中的注入行
npm test -- --report=out.json   # 指定报告输出路径（默认 tests/reports/latest.json）
node tests/cleanup.mjs          # 手动清理测试注入行（自动跑时无需）
```

### 工作原理
- 测试通过向 `data/events.jsonl` **追加构造事件**（与 `hooks/collect.mjs` 输出同格式）驱动真实看板：
  注入事件 → 服务端状态机聚合 → 前端 600ms 轮询 `/api/state` → 渲染/动画。
- 断言基于**真实 DOM**：卡片类名、可见表情（`getComputedStyle` 过滤 `display:none` 层）、
  状态区内容、CSS 动画（`animationName`/`filter`）、火柴人元素与绿勾 opacity。
- 每个用例使用独立页面（同一浏览器实例），用例间互不干扰。

### 对真实看板的影响（重要）
1. 测试事件使用 `e2e-` 前缀的 agent id，运行期间看板会短暂出现测试卡片；
2. **服务端内存**中的测试 agent 无法通过删文件清除，由 `STALE_MS`（10 分钟）超时自动回收；
3. 用例 05 会临时把 main 的 lastSeen 改为 90s 前（使 main 短暂显示"待机中"），测试结束会自动注入新事件唤醒；
4. 测试结束后自动清理 `events.jsonl` 中的 `e2e-` 行（`--keep-events` 可跳过）；
5. **请避免在测试运行期间操作 Claude Code**（真实事件可能干扰 main 相关断言）。

### 用例清单
| 文件 | 用例 | 对应方案 |
|---|---|---|
| `cases/01-failure.mjs` | 失败流程（✕/😢/红辉光/抖动、交回不带绿勾、main 不显示😄、状态区❌） | A |
| `cases/02-fast-overlap.mjs` | 快速任务（<7s）无 😟😄 双层重叠 | B |
| `cases/03-sad-timing.mjs` | 😟（task-assigned）子卡出现即显示，不等 5s | C |
| `cases/04-handoff-timing.mjs` | done 后 ≥4s 卡片仍在、交接同屏、拜拜保持😄 | D |
| `cases/05-main-idle.mjs` | main 有子 Agent 不待机 / 60s 无事件才待机 | E |
| `cases/06-success-regression.mjs` | 完整成功流程表情切换回归 | A-F |
| `cases/07-reduced-motion.mjs` | reduced-motion 无火柴人/粒子，功能正常 | A/C 附属 |
| `cases/08-emoji-exclusive.mjs` | 状态类叠加时仅一个表情可见（CSS 互斥） | B/C/D |

## 二、测试报告模板

测试完成后自动生成结构化报告 `tests/reports/latest.json`，控制台输出失败项清单。
人工汇总时按以下模板填写：

```
# vc-dashboard E2E 测试报告（表情体系方案 A-F）

- 日期：____
- 环境：Node ____ / 浏览器 ____ / 服务运行：是/否
- 运行方式：`npm test`（附加参数：____）
- 结果：用例 __ 个，断言通过 __ 项，失败 __ 项（通过率 __%）

## 逐用例结果

| 用例 | 对应方案 | 断言通过/总数 | 结果 | 关键失败项 |
|---|---|---|---|---|
| 01-失败流程 | A | x/y | PASS/FAIL | ... |
| 02-快速任务重叠 | B | x/y | PASS/FAIL | ... |
| ... | ... | ... | ... | ... |

## 失败项详情（Tester 结论）

1. 【方案A】F8 失败表情 😢 —— 期望显示😢，实际显示 ____。
   结论：____（如"当前实现无😢表情层，需 Frontender 补充"）
2. ...（每条含：期望 / 实际 / 涉及文件与行号 / 复现步骤 / 影响范围 / 建议）

## 通过项确认

- 方案 D 离场延迟、方案 B celebrating 阶段互斥、reduced-motion 降级等已符合预期。

## 回归风险

- 测试期间注入的 e2e agent 于 10 分钟后自动回收；events.jsonl 已清理。
- 测试 05 对 main 的临时影响已恢复。

## 建议

- 修复顺序建议：...；修复后重新运行 `npm test -- --only=xx` 回归验证。
```
