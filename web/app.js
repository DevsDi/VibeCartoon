/* =========================================================================
 * Vibe Agent Dashboard — 前端逻辑
 * 原生 JS，无框架、无依赖、不连外网。
 * 职责：每 600ms 轮询 /api/state，
 *       增量刷新 Agent 卡片（保证动画不因重绘重置），
 *       处理子 Agent 完成/失败拜拜离场、断连横幅与空状态占位，
 *       播放任务派发/汇报的火柴人过渡动画。
 * ========================================================================= */
'use strict';

(function () {
  /* ---------------- 配置 ---------------- */
  const POLL_INTERVAL = 600;          // 轮询间隔（毫秒）
  const FETCH_TIMEOUT = 2500;         // 单次请求超时（毫秒），防止轮询堆积
  /* main 主 Agent 空闲判定阈值（毫秒）：lastSeen 距今超过该值 → 前端展示"待机"。
   * 仅影响 main 卡片展示，不改服务端数据；有新事件（lastSeen 刷新）自动恢复真实状态 */
  const IDLE_TIMEOUT = 60000;

  /* 超时回收前端判定阈值（毫秒，方向 B）：对齐服务端 config.mjs 的 STALE_MS=10min。
   * 服务端超时会回收 Agent（从 /api/state 移除）；前端以"本轮消失 + lastSeen 距今
   * 超过该值"判定为超时回收，展示"打盹淡出"可视化（见 detectTimeoutRecycled） */
  const STALE_FRONT_MS = 10 * 60 * 1000;

  /* "最近工具"最多显示的条数：只取 history 中的 tool:xxx 条目（简化版，
   * thinking/start/done 等状态项不展示） */
  const TOOL_TAIL = 3;

  /* 状态 → 展示元信息 */
  const STATUS_META = {
    queued:   { emoji: '⏳', label: '排队中' },
    thinking: { emoji: '🔍', label: '思考中' },
    tool:     { emoji: '🛠️', label: '调用工具中' },
    asking:   { emoji: '💬', label: '等待输入' },
    idle:     { emoji: '😴', label: '待机中' },
    done:     { emoji: '✅', label: '已完成' },
    failed:   { emoji: '❌', label: '失败' },
    running:  { emoji: '🚀', label: '执行中' },
    unknown:  { emoji: '🌀', label: '未知状态' }
  };

  /* 工具名 → 关联动作类型（方向 C）：按工具类型切换卡片电脑屏幕上的内容
   * code（写代码）→ 代码行；search（搜索）→ 🔍；dispatch（派发）→ 📨；
   * 未命中的工具 → 'default'（🛠）。由 toolTypeOf() 匹配，见工具函数区。 */
  const TOOL_TYPE_MAP = {
    code: ['read', 'edit', 'write'],
    search: ['grep', 'glob', 'search'],
    dispatch: ['agent', 'sendmessage']
  };

  /* 折叠到"底部紧凑列表"的状态：子 Agent 完成/失败后不再进折叠区，
   * 而是播放"拜拜"（挥手 + 淡出）动画后消失（见 leaveCard） */
  const FOLDED_STATUS = { done: true, failed: true };

  /* 子 Agent 完成/失败后的离场动画时长（毫秒）：
   * 挥手拜拜 4s → 淡出 3s → 由 JS 移除 DOM */
  const LEAVE_WAVE_MS = 4000;
  const LEAVE_FADE_MS = 3000;
  const LEAVE_TOTAL_MS = LEAVE_WAVE_MS + LEAVE_FADE_MS + 100;

  /* 子 Agent 完成（done）庆祝时长：粒子散开播放完，才进入挥手拜拜 */
  const CELEBRATE_MS = 1800;

  /* 火柴人单程跑动耗时（毫秒）：两栏三段式 1.8+2.4+0.8s = 5s，窄屏单栏直线同为 5s。
   * 方案 D：done 子卡的挥手拜拜等待窗口 = 庆祝 + 火柴人到达，
   * 使"主 Agent 接住文件"与"子卡挥手告别"同屏。 */
  const STICKMAN_TRAVEL_MS = 5000;

  /* 火柴人奔跑质感（A 方向）：
   * - 弹跳：STICKMAN_BOUNCE_MS 为一个完整上下周期，振幅 STICKMAN_BOUNCE_AMP（px）；
   *   STICKMAN_BOUNCE_RAMP 为 totalMs 前/后的渐入渐出比例（0.08 = 前/后 8%）。
   * - 脚底尘土：跑动时每 STICK_DUST_EVERY_MS 生成一颗尘土，STICK_DUST_LIFE_MS 后消失。 */
  const STICKMAN_BOUNCE_MS = 600;
  const STICKMAN_BOUNCE_AMP = 2;
  const STICKMAN_BOUNCE_RAMP = { start: 0.08, end: 0.08 };
  const STICK_DUST_EVERY_MS = 120;
  const STICK_DUST_LIFE_MS = 700;

  /* 完成反馈增强（B 方向）：.card-pop 弹出动画时长（毫秒），结束后移除类名 */
  const CARD_POP_MS = 620;

  /* 背景氛围符号（方向 D）：全屏缓慢漂移的代码符号，取前 BG_SYMBOL_COUNT 个生成
   * .bg-symbols 层（每个符号随机位置 / 字号 / 时长 / 延迟，见 init()） */
  const BG_SYMBOLS = ['<', '>', '{', '}', '/', ';', ':', '=', '#', '*', '_', '[', ']', '(', ')'];
  const BG_SYMBOL_COUNT = 14;

  /* 卡片移除动画时长（毫秒）：.removing 淡出过渡 */
  const REMOVE_ANIM_MS = 420;

  /* 超时回收可视化时长（毫秒，方向 B）：.timeout-leaving 打盹淡出动画时长，
   * 结束后由 JS 移除 DOM（与 style.css 的 timeoutLeave keyframes 时长对齐） */
  const TIMEOUT_LEAVE_MS = 1500;

  /* 卡片入场动画时长（毫秒）：.enter 过渡结束后移除类名 */
  const ENTER_ANIM_MS = 1700;

  /* 活动卡片网格内的排序优先级：越靠前越优先 */
  const ACTIVE_PRIORITY = { asking: 0, tool: 1, thinking: 2, queued: 3, running: 4, unknown: 5 };

  /* ---------------- 内部状态 ---------------- */
  let els = {};                 // 缓存的 DOM 引用
  let mainCards = {};           // 主 Agent（id=main）卡片缓存（main-grid）: id -> { el, status, elapsedText, toolsText, toolsKey, flashTimer }
  let activeCards = {};         // 子 Agent 卡片缓存（active-grid）: id -> { el, status, elapsedText, toolsText, toolsKey, flashTimer }
  let polling = false;          // 轮询互斥锁
  let prevAgentMap = new Map(); // 全部 Agent: id -> 上次渲染时的状态（用于检测新出现/完成）
  let stickmanSeeded = false;   // 首次渲染是否已建立基准（首次不触发火柴人动画）
  let lastMainAgentCallCount = 0; // main 的 history 中派发/补充任务工具调用（Agent/SendMessage）累计次数基准
  let hasSubAgents = false;       // 本轮渲染是否存在存活子 Agent（方案 E：main 正等子 Agent 交回结果时不判待机）
  let pollTimer = null;           // 轮询定时器句柄，页面不可见时暂停用

  /* 在途派发小人集合：正在途中（toSub）跑向子 Agent 的火柴人的 agent id。
   * animateAgentChanges 据此抑制 done/failed 时重复创建 backToMain 汇报小人：
   * 子 Agent 完成/失败时若仍有在途派发小人，跳过 backToMain，避免两个小人同时跑回。 */
  const inFlightToSub = new Set();

  /* 派发火柴人串行队列（方向 A）：toSub 派发小人先入队、逐个执行，
   * 避免多个派发小人同时跑造成视觉重叠（backToMain 汇报不排队，直接执行）。
   * stickmanQueue 存排队中的 agent.id；stickmanBusy 标记队列正有火柴人在跑，
   * 为 true 期间新派发只入队不启动，由前一个火柴人的移除回调继续出队。 */
  let stickmanQueue = [];
  let stickmanBusy = false;

  /* 方向 B：Agent 上次活动时间快照（agent id -> Date.parse(a.lastSeen) 时间戳）。
   * 每次 render 更新当前存活 Agent；用于"超时回收"判定——服务端按 STALE_MS=10min
   * 超时回收 Agent，前端据此把"本轮消失 + lastSeen 过旧"的卡片标记为超时回收。 */
  let lastSeenMap = new Map();

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // 收集 DOM
    els.boardWrap = document.getElementById('board-wrap');
    els.mainGrid = document.getElementById('main-grid');
    els.activeGrid = document.getElementById('active-grid');
    els.emptyState = document.getElementById('empty-state');
    els.connBanner = document.getElementById('conn-banner');
    els.updatedAt = document.getElementById('updated-at');

    // 停止按钮：事件委托到子 Agent 网格（按钮 DOM 随轮询重建，委托避免重复绑定）
    els.activeGrid.addEventListener('click', onStopClick);

    // 火柴人动画层：固定定位覆盖全屏，挂在 body 末尾，不参与布局
    els.animLayer = document.createElement('div');
    els.animLayer.id = 'anim-layer';
    els.animLayer.className = 'anim-layer';
    els.animLayer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(els.animLayer);

    // 背景氛围符号层（方向 D）：全屏代码符号缓慢漂移，挂在 body 末尾。
    // 每个符号随机：水平 left% / 垂直 top% / 字号 10-20px / --dur(12-24s) / --delay(0-20s)
    els.bgSymbols = document.createElement('div');
    els.bgSymbols.className = 'bg-symbols';
    els.bgSymbols.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < BG_SYMBOL_COUNT; i++) {
      const sp = document.createElement('span');
      sp.textContent = BG_SYMBOLS[i % BG_SYMBOLS.length];
      sp.style.left = (Math.random() * 100).toFixed(1) + '%';
      sp.style.top = (Math.random() * 100).toFixed(1) + '%';
      sp.style.fontSize = (10 + Math.random() * 10).toFixed(1) + 'px';
      sp.style.setProperty('--dur', (12 + Math.random() * 12).toFixed(1) + 's');
      sp.style.setProperty('--delay', (Math.random() * 20).toFixed(1) + 's');
      els.bgSymbols.appendChild(sp);
    }
    document.body.appendChild(els.bgSymbols);

    // 初始空状态
    setEmptyVisible(true);

    // 立即拉取一次，然后按固定间隔轮询
    poll();
    pollTimer = window.setInterval(poll, POLL_INTERVAL);

    // 页面可见性：后台标签页暂停轮询，节省 CPU；火柴人动画仅在动画期间运行，不影响常驻性能，不暂停
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
      } else {
        if (!pollTimer) { poll(); pollTimer = window.setInterval(poll, POLL_INTERVAL); }
      }
    });
  }

  /* ---------------- 轮询 ---------------- */
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const data = await fetchState();
      setOnline(true);
      render(data);
    } catch (err) {
      // 断连：显示横幅但不崩溃，等待下一次轮询自动重连
      setOnline(false);
    } finally {
      polling = false;
    }
  }

  async function fetchState() {
    const ctrl = new AbortController();
    const timer = window.setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
    try {
      const res = await fetch('/api/state', { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      window.clearTimeout(timer);
    }
  }

  function setOnline(ok) {
    els.connBanner.classList.toggle('hidden', ok);
  }

  /* ---------------- 停止子 Agent ----------------
   * 前端只负责「发起停止请求 + 状态标记」闭环：
   * 点击 ⏹ 停止 → POST /api/agents/:id/stop → 成功即把卡片置为"已停止"
   * （按钮 disabled + 文案已停止 + 卡片灰化 status-stopped），
   * 服务端 stopRequested 在下一轮轮询中继续保持该视觉；
   * 失败仅 console 提示并恢复按钮，不阻断轮询。 */
  async function requestAgentStop(id) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(id) + '/stop', {
        method: 'POST', cache: 'no-store', signal: ctrl.signal
      });
      if (!res.ok) return false;
      const data = await res.json().catch(function () { return null; });
      return !!(data && data.ok);
    } catch (err) {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function onStopClick(ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.stop-agent-btn') : null;
    if (!btn || btn.disabled) return;
    const card = btn.closest('.agent-card');
    if (!card) return;
    const id = card.dataset && card.dataset.id;
    if (!id) return;
    const rec = activeCards[id];
    btn.disabled = true; // 立即禁用防重复点击
    requestAgentStop(id).then(function (ok) {
      if (ok && rec) {
        rec.stopSent = true;     // 本地置位：立即显示"已停止"，不必等下一轮轮询
        rec.stopState = null;    // 强制刷新停止区
        updateStopZone(rec, rec.agent);
      } else if (!ok) {
        console.warn('[vc-dashboard] 停止子 Agent 请求失败：', id);
        // 失败不阻断轮询：恢复按钮可点（卡片若已离场/移除，交给轮询隐藏）
        const cur = card.querySelector('.stop-agent-btn');
        if (cur && !card.classList.contains('is-leaving') && !card.classList.contains('removing')) {
          cur.disabled = false;
        }
      }
    });
  }

  /* ---------------- 主渲染 ---------------- */
  function render(data) {
    const agents = Array.isArray(data.agents) ? data.agents : [];
    renderFooter(data.updatedAt);

    // 方向 B：更新 lastSeen 快照（agent id -> 时间戳），供超时回收判定使用
    updateLastSeenMap(agents);

    // 无任何 Agent：展示空状态占位；同时清空旧卡片缓存与 DOM，
    // 避免服务端重启（agents 清空）后旧卡片残留、新事件到来时"复活"
    if (!agents.length) {
      setEmptyVisible(true);
      clearAllCards();           // 清空 mainCards/activeCards 缓存 + 移除两网格下所有 .agent-card
      prevAgentMap = new Map();  // 清空基准快照：新 Agent 再出现时视为"新出现"触发动画
      return;
    }
    setEmptyVisible(false);

    // 拆分主 Agent 与子 Agent：主 Agent（id=main）常驻左栏 main-grid（任何状态都不消失），
    // 子 Agent 渲染到右栏 active-grid（一列多行）
    const mainList = agents.filter(function (a) { return a.id === 'main'; });
    const subList = agents.filter(function (a) { return a.id !== 'main'; });

    // 方案 E：main 是否在等待子 Agent 交回结果（有存活子 Agent 时 main 不判"待机"）
    hasSubAgents = subList.length > 0;

    const mainActive = mainList; // 常驻：不做 done/failed 过滤
    const subActive = subList.filter(function (a) {
      return !FOLDED_STATUS[normalizeStatus(a.status)]; // 完成/失败的子 Agent 走拜拜消失，不进活动区
    }).sort(function (a, b) {
      return priorityOf(a) - priorityOf(b);
    });

    // 本轮各 Agent 状态快照：renderActive 清理与 animateAgentChanges 共用，
    // 保证"刚完成/失败"的判定一致（避免清理路径抢先触发离场、破坏庆祝时序）
    const nowStatus = new Map(agents.map(function (a) {
      return [a.id, normalizeStatus(a.status)];
    }));

    // 方向 B：超时回收可视化——在 renderActive 清理之前判定"超时回收"的卡片，
    // 挂 .timeout-leaving 打盹淡出（agents 为空时 render 已提前返回，不会误判整体清空）
    detectTimeoutRecycled(agents);

    renderMain(mainActive);
    renderActive(subActive, activeCards, els.activeGrid, nowStatus);

    // 火柴人任务动画：放在渲染之后检测，此时新卡片已进 DOM、坐标可读
    animateAgentChanges(agents, nowStatus);
  }

  /* ---------------- 火柴人任务动画 ---------------- */
  /* 任务派发时火柴人从主 Agent 卡片跑向子 Agent 卡片；任务完成后跑回来汇报。
   * 纯 CSS 走路动画（腿部交替摆动），JS 只负责创建元素与驱动 left/top 过渡。 */

  /* 火柴人 SVG（内联字符串，挂在 .stickman-runner 内，颜色跟随 currentColor）。
   * doc（派发时拿的文件）与 report-mark（汇报带回的绿勾）默认隐藏，
   * 由 style.css 依据 .stickman-runner.with-doc / .report 控制显隐。 */
  const STICKMAN_SVG =
    '<svg class="stickman" viewBox="0 0 30 40" aria-hidden="true">' +
      // 头部三层 emoji（font-size 11、y=12，视觉"圆点"大小居中）：
      // 派发（toSub）显示 😎（主 Agent 派人送文件）；交回汇报（backToMain，.flip）
      // 按子 Agent 最终状态切换：done → 😄（.report，与 celebrating 表情呼应）、
      // failed → 😢（.failed，失败回禀），显隐规则见 style.css
      '<text class="stick-head stick-head-run" x="15" y="12" text-anchor="middle" font-size="11">😎</text>' +
      '<text class="stick-head stick-head-report" x="15" y="12" text-anchor="middle" font-size="11">😄</text>' +
      '<text class="stick-head stick-head-fail" x="15" y="12" text-anchor="middle" font-size="11">😢</text>' +
      '<line x1="15" y1="14" x2="15" y2="26" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="arm-left" x1="15" y1="18" x2="6" y2="13" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="arm-right" x1="15" y1="18" x2="24" y2="13" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="leg-left" x1="15" y1="26" x2="7" y2="36" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="leg-right" x1="15" y1="26" x2="23" y2="36" stroke="currentColor" stroke-width="2.5"></line>' +
      // 派发时手里拿的文件（画在右手上方）
      '<rect class="doc" x="22" y="4" width="6" height="9" rx="1" fill="#e7eaf3" opacity="0"></rect>' +
      '<line class="doc-line" x1="24" y1="7" x2="26" y2="7" stroke="#8d97ad" stroke-width="1" opacity="0"></line>' +
      '<line class="doc-line" x1="24" y1="9" x2="26" y2="9" stroke="#8d97ad" stroke-width="1" opacity="0"></line>' +
      // 汇报时带回的绿色勾标（手右侧小圆点）
      '<circle class="report-mark" cx="25" cy="6" r="3.4" fill="#22c55e" opacity="0"></circle>' +
    '</svg>';

  /* main 卡片不存在时（main 未出现时）的起点/终点占位：页面左上角附近 */
  const FALLBACK_MAIN_RECT = { left: 0, top: 56, right: 8, height: 40 };

  /* main 的 history 中派发/补充子 Agent 任务的工具调用累计次数：
   * Agent（派发新任务）与 SendMessage（给运行中的子 Agent 补充任务）
   * 都会让主 Agent 向子 Agent 派人送文件，都应触发派发动画 */
  function mainAgentCallCount(agents) {
    const mainAgent = agents.find(function (a) { return a.id === 'main'; });
    if (!mainAgent || !Array.isArray(mainAgent.history)) return 0;
    return mainAgent.history.filter(function (h) {
      return h === 'tool:Agent' || h === 'tool:SendMessage';
    }).length;
  }

  /* 检测新子 Agent / 主 Agent 补充任务 / 完成失败状态变化，驱动火柴人往返动画。
   * nowMap 由 render() 统一构建（与 renderActive 清理共用同一份状态快照）。 */
  function animateAgentChanges(agents, nowMap) {
    if (!nowMap) {
      nowMap = new Map(agents.map(function (a) {
        return [a.id, normalizeStatus(a.status)];
      }));
    }

    // 首次渲染：只建立基准快照，不触发动画（避免刷新页面时一堆火柴人涌出）
    if (!stickmanSeeded) {
      stickmanSeeded = true;
      prevAgentMap = nowMap;
      lastMainAgentCallCount = mainAgentCallCount(agents);
      return;
    }

    // 新子 Agent 出现 → 火柴人从主 Agent 跑过去 + 卡片顶部"新任务"闪烁标记
    const toSubThisRound = new Set(); // 本轮已派过火柴人的子 Agent（补充派发去重用）
    agents.forEach(function (a) {
      if (a.id !== 'main' && !prevAgentMap.has(a.id)) {
        toSubThisRound.add(a.id);
        runStickman('toSub', a);
        showNewTaskTag(a.id); // C：新任务标记
        assignTaskFace(getCardElById(a.id), nowMap); // C：接到任务即"翻脸"😟（无需等火柴人到达）
      }
    });

    // 主 Agent 补充/再次派发任务（main 的 history 新增 tool:Agent）→ 同样派火柴人送文件。
    // 目标：最近活跃（lastSeen 最新）的现有子 Agent；本轮刚出现的子 Agent 已派过，跳过
    if (mainAgentCallCount(agents) > lastMainAgentCallCount) {
      let target = null;
      agents.forEach(function (a) {
        if (a.id === 'main' || toSubThisRound.has(a.id)) return;
        if (!target || (a.lastSeen || '') > (target.lastSeen || '')) target = a;
      });
      if (target) {
        runStickman('toSub', target);
        showNewTaskTag(target.id);
        assignTaskFace(getCardElById(target.id), nowMap); // C：补充任务同样"翻脸"😟
      }
    }
    lastMainAgentCallCount = mainAgentCallCount(agents);

    // 子 Agent 完成/失败 → 火柴人跑回主 Agent 汇报 + 卡片挥手拜拜后淡出消失
    agents.forEach(function (a) {
      if (a.id === 'main') return;
      const prev = prevAgentMap.get(a.id);
      const now = nowMap.get(a.id);
      if (prev && prev !== 'done' && prev !== 'failed' &&
          (now === 'done' || now === 'failed')) {
        const isDone = now === 'done';
        const isReduced = window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // 交接第二步：子 Agent 办公小人拿起文件 → 火柴人（持文件）跑回主 Agent 汇报
        const cardEl = getCardElById(a.id);
        setOfficeFile(cardEl, true);
        // 失败：子卡挂 .task-failed 失败视觉（红辉光 + 😢 + 抖动 + 状态区改"失败"）。
        // 失败后子卡即被移出活动列表、不再被 updateCard 刷新，状态区会停留在进入
        // failed 前一刻（如"调用工具中"蓝色 spinner），必须在此一次性改写。
        // 不复用 status-failed / status-done，避免与完成举手/挥手动画互相干扰
        if (!isDone) markCardFailed(cardEl);
        // 完成庆祝（仅 done）：粒子散开 ~1.8s 后才进入挥手拜拜；
        // 失败不庆祝（走 .task-failed 失败视觉，不再是"保留 ❌ 抖动"）；
        // 动效敏感用户跳过庆祝与延时
        if (isDone && !isReduced) celebrateCard(a.id);
        // 完成反馈增强（B 方向）：完成瞬间给卡片一个"弹出"缩放反馈
        // （celebrateCard 之后执行，避免与粒子动画同帧叠加；cardEl 已在分支顶部取得）
        if (isDone) popCard(cardEl);
        // 火柴人跑回汇报：done → 😄 + 带回绿勾；failed → 😢 不带绿勾（第三参 isFailed）。
        // 若该 agent 仍有在途派发小人（inFlightToSub），掉头小人已负责"返回"，
        // 跳过 backToMain，避免两个小人同时跑回主 Agent 造成视觉重复
        if (!inFlightToSub.has(a.id)) {
          runStickman('backToMain', a, !isDone);
        }
        // 挥手拜拜等待窗口（方案 D）：done = 庆祝 1.8s + 火柴人到达 5s，
        // 让"主 Agent 接住文件"与"子卡挥手告别"同屏；动效敏感用户无火柴人，
        // 保持仅庆祝；失败不庆祝，直接进入挥手
        leaveCard(a.id, isDone && !isReduced ? CELEBRATE_MS + STICKMAN_TRAVEL_MS : 0, isDone);
      }
    });

    prevAgentMap = nowMap;
  }

  /* 缓动：ease-in-out（二次贝塞尔近似） */
  function easeInOut(p) {
    return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  }

  /* 缓动：ease-in（起步加速，二次） */
  function easeIn(p) {
    return p * p;
  }

  /* 缓动：ease-out（到站减速，二次） */
  function easeOut(p) {
    return 1 - Math.pow(1 - p, 2);
  }

  /* 火柴人三段式路径：起步加速（easeIn）→ 巡航（easeInOut）→ 到站减速（easeOut）。
   * 中间点取直线 10% / 90% 处，三段时长 10% / 80% / 10%，总时长精确等于 totalMs，
   * 起点终点精确落在 from / to；终点段挂 easeOut 保证到站减速落地。 */
  function buildRunPath(from, to, totalMs) {
    const d10 = totalMs * 0.10;
    const d80 = totalMs * 0.80;
    return [
      { x: from.x, y: from.y, dur: 0 },
      {
        x: from.x + (to.x - from.x) * 0.10,
        y: from.y + (to.y - from.y) * 0.10,
        dur: d10,
        ease: easeIn
      },
      {
        x: from.x + (to.x - from.x) * 0.90,
        y: from.y + (to.y - from.y) * 0.90,
        dur: d80,
        ease: easeInOut
      },
      { x: to.x, y: to.y, dur: d10, ease: easeOut }
    ];
  }

  /* 火柴人位置驱动：16ms 定时器逐帧插值，逐段 ease-in-out。
   * 不依赖 CSS transition / requestAnimationFrame（低帧率或节流环境下也稳定）。
   * path: [{ x, y, dur }, ...] 依次经过的路径点（首点为起点，dur 为到达该点的用时）；
   * totalMs 结束后停止并移除火柴人。
   * onDone（可选）：火柴人从动画层移除后回调一次（方向 A：派发队列据此继续出队）。 */
  function driveStickman(stick, path, totalMs, onDone) {
    const t0 = performance.now();
    // 滚动补偿（方案：滚动错位修复）：path 坐标是动画开始时一次性读取的
    // getBoundingClientRect 视口坐标，而火柴人容器是 fixed 定位。动画期间页面
    // 滚动（scrollY 变化）会让火柴人停在旧视口位置、与卡片错位。逐帧读取当前
    // scrollY，把差值补偿到 top（页面仅垂直滚动，left 无需补偿）：
    // 滚动后卡片视口位置 = 文档坐标 - scrollY，故补偿量为 t0ScrollY - scrollY。
    const t0ScrollY = window.scrollY;
    const scrollDelta = function () {
      return t0ScrollY - window.scrollY;
    };
    // rAF 句柄统一管理：正常走完由移除定时器清理，
    // 途中目标消失则由 cancel() 一并清除（防止继续插值 / 重复回调）
    let rafId = null;
    let removeTimer = null;
    const cancel = function () {
      if (removeTimer) { window.clearTimeout(removeTimer); removeTimer = null; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    };
    /* 弹跳包络：totalMs 前/后 8%（STICKMAN_BOUNCE_RAMP）用 smoothstep 渐入渐出
     * 归零（保证起终点精确落地、不叠卡片），中段返回 1（全幅弹跳）。 */
    const envelope = function (t) {
      const startEnd = STICKMAN_BOUNCE_RAMP.start * totalMs;
      const endStart = totalMs * (1 - STICKMAN_BOUNCE_RAMP.end);
      const sm = function (u) { return u * u * (3 - 2 * u); }; // smoothstep
      if (startEnd > 0 && t < startEnd) return sm(t / startEnd);
      if (totalMs - endStart > 0 && t > endStart) return sm((totalMs - t) / (totalMs - endStart));
      return 1;
    };
    const step = function (now) {
      const t = Math.min(now - t0, totalMs);
      // 定位当前所在路径段
      let acc = 0;
      let seg = -1;
      for (let i = 0; i + 1 < path.length; i++) {
        if (t <= acc + path[i + 1].dur) { seg = i; break; }
        acc += path[i + 1].dur;
      }
      if (seg === -1) {
        // 终态（超出总时长兜底）：精确落地，不叠加弹跳
        const last = path[path.length - 1];
        stick.style.left = last.x + 'px';
        stick.style.top = (last.y + scrollDelta()) + 'px';
        return;
      }
      const from = path[seg];
      const to = path[seg + 1];
      // 逐段缓动：路径点可携带 ease（buildRunPath 三段变速），缺省回退 easeInOut
      const p = to.dur > 0 ? (to.ease || easeInOut)(Math.max(0, Math.min(1, (t - acc) / to.dur))) : 1;
      const baseTop = from.y + (to.y - from.y) * p + scrollDelta();
      // 弹跳：跑动中脚部离地（负方向 = 向上），振幅受包络约束（起终点无弹跳）
      const bounce = -Math.abs(Math.sin(t / STICKMAN_BOUNCE_MS * Math.PI * 2)) * STICKMAN_BOUNCE_AMP * envelope(t);
      stick.style.left = (from.x + (to.x - from.x) * p) + 'px';
      stick.style.top = (baseTop + bounce) + 'px';
      if (t < totalMs) {
        rafId = requestAnimationFrame(step);
      }
    };
    // 先注册 rAF / 移除定时器，再画首帧：即使首帧就检测到目标消失，
    // cancel() 也能清掉刚注册的句柄，保证 onGone 只回调一次
    removeTimer = window.setTimeout(function () {
      cancel();
      if (stick.parentNode) stick.parentNode.removeChild(stick);
      // 方向 A：火柴人移除后回调（派发队列据此继续出队下一个；backToMain 不传）
      if (typeof onDone === 'function') onDone();
    }, totalMs + 100);
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(step);
    } else {
      // 降级：requestAnimationFrame 不可用时使用 setInterval
      const timer = window.setInterval(function () {
        step(performance.now());
      }, 16);
      window.setTimeout(function () { window.clearInterval(timer); }, totalMs + 100);
      step(performance.now());
    }
  }

  /* direction: 'toSub'（主 → 子）| 'backToMain'（子 → 主）
   * isFailed（仅 backToMain 有效）：子 Agent 最终状态为 failed 时火柴人表情切换为
   * 😢 且不带汇报绿勾（.report 仅在 done 时挂，见 style.css）。
   * 路径：主 Agent 在左栏、子 Agent 在右栏，两栏之间有宽阔跑道（列间 gap 100px）。
   * 两栏布局（跑道 ≥ 30px）时火柴人沿虚线方向直线过渡——从来源卡片右缘中心斜线
   * 走到目标卡片左缘中心，方向与 SVG 发散虚线一致（虚线也由主卡右缘中心 → 子卡
   * 左缘中心，火柴人只是起点/终点在卡片边缘 ±20px 内、y 相同 → 平行贴合虚线）；
   * 窄屏单栏（两栏间距 < 30px）时同样退化为直线过渡。
   * 方向 A（并发排队）：toSub 派发先入队串行执行（避免多个派发小人重叠跑），
   * backToMain 汇报保持直接执行不排队（原有逻辑不变）。 */
  function runStickman(direction, agent, isFailed) {
    const layer = els.animLayer;
    if (!layer || !agent || agent.id === 'main') return;
    // 动效敏感用户：直接不创建火柴人（style.css 另有全局降级）
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // 派发（toSub，方向 A）：先入队；若队列空闲立即启动 runQueuedToSub 出队执行，
    // 否则等上一个火柴人的移除回调继续出队（串行排队，同一时刻至多 1 个派发小人）
    if (direction === 'toSub') {
      stickmanQueue.push(agent.id);
      if (!stickmanBusy) runQueuedToSub();
      return;
    }

    /* ============ 汇报（backToMain）：直接执行不排队（原有逻辑保持不变） ============ */
    const fromEl = getCardElById(agent.id);
    const toEl = getCardElById('main');

    let fromRect, toRect;
    if (!fromEl) return; // 子 Agent 卡片已被移出 DOM → 无法出发
    fromRect = fromEl.getBoundingClientRect();
    toRect = toEl ? toEl.getBoundingClientRect() : FALLBACK_MAIN_RECT;

    // 创建火柴人：跑回来时镜像翻转（面向左）+ 手里拿着交接的文件（.doc 随 with-doc
    // 显形）。汇报表情按成败区分：done → .report（😄 + 绿勾）、failed → .failed
    // （😢 不带绿勾），显隐规则见 style.css
    const stick = document.createElement('div');
    stick.className = 'stickman-runner flip with-doc' + (isFailed ? ' failed' : ' report');
    stick.innerHTML = STICKMAN_SVG;
    stick.style.transition = 'none'; // 位置由 JS 逐帧驱动，禁用 CSS 过渡
    layer.appendChild(stick);

    // 起点/终点：卡片边缘 ±20px 处（火柴人放大到 44px 宽后，半宽 22px≈20px，
    // 到达时身体中心大致对齐卡片边缘）、卡片垂直中心高度
    const startX = fromRect.left + 20;
    const startY = fromRect.top + fromRect.height / 2;
    const endX = toRect.right - 20;
    const endY = toRect.top + toRect.height / 2;
    // 两栏间距（来源卡片边缘 - 目标卡片边缘）；≥30px 视为两栏跑道可用
    const runway = fromRect.left - toRect.right;

    let totalMs;
    if (runway >= 30) {
      // 两栏布局：沿虚线方向直线过渡。火柴人从来源卡片边缘中心斜线走到目标卡片
      // 边缘中心，方向与 SVG 发散虚线一致；起点/终点均在卡片边缘 ±20px 内，
      // 斜线全程位于两栏之间的跑道区域，不压卡片。总时长 = STICKMAN_TRAVEL_MS 5s
      totalMs = STICKMAN_TRAVEL_MS;
      driveStickman(stick, buildRunPath({ x: startX, y: startY }, { x: endX, y: endY }, totalMs), totalMs);
    } else {
      // 窄屏单栏布局：退化为直接直线过渡（同样放慢到 5s，与两栏节奏接近）
      totalMs = STICKMAN_TRAVEL_MS;
      driveStickman(stick, buildRunPath({ x: startX, y: startY }, { x: endX, y: endY }, totalMs), totalMs);
    }

    // 脚底尘土（A 方向）：跑动期间脚下迸出小土点，totalMs+100 后停止生成
    spawnStickDust(stick, totalMs);

    // 交接第三步：火柴人到达主 Agent → 主 Agent 办公小人接住文件 + 收/拒收闪光：
    // done（成功）→ 绿色"收到" + 😄；failed（失败）→ 红色"驳回" + 😟
    window.setTimeout(function () { mainReceiveFile(!isFailed); }, totalMs);
  }

  /* 派发火柴人串行执行器（方向 A）：队列空闲时由 runStickman 首次触发，火柴人移除
   * 回调 / 卡片缺失跳过时继续触发，处理到队列为空为止。
   * 兜底：队列累计长度异常（如 >20）时清空队列防卡死；任何异常不阻断轮询。 */
  function runQueuedToSub() {
    stickmanBusy = true;
    // 兜底：队列累计长度异常（如 >20）时清空队列防卡死
    if (stickmanQueue.length > 20) stickmanQueue.length = 0;
    let id;
    while (stickmanQueue.length > 0) {
      id = stickmanQueue.shift();
      // 存在则创建 toSub 火柴人并启动（由 driveStickman 移除回调继续出队）；
      // 卡片已不存在则跳过，继续出队下一个
      if (launchToSubStickman(id)) return;
    }
    // 队列已空（或全部卡片已消失）：复位忙碌标记
    stickmanBusy = false;
  }

  /* 创建单个"派发"火柴人（方向 A）：从主 Agent 卡片跑向 id 对应子 Agent 卡片，
   * 到达后播放送达效果（与 runStickman 原 toSub 分支逻辑一致）。
   * 子 Agent 卡片已不存在（getCardElById 返回 null）时返回 false，由调用方跳过；
   * 创建/驱动过程异常同样返回 false（兜底，不阻断轮询）。 */
  function launchToSubStickman(id) {
    const layer = els.animLayer;
    const fromEl = getCardElById('main');
    const toEl = getCardElById(id);
    if (!toEl) return false; // 子 Agent 卡片已不存在（被回收/离场）→ 跳过本单
    let launched = false;    // 火柴人是否已成功启动（后续异常不再并发启动下一个）
    try {
      const fromRect = fromEl ? fromEl.getBoundingClientRect() : FALLBACK_MAIN_RECT;
      const toRect = toEl.getBoundingClientRect();

      // 创建火柴人：派发样式（.with-doc 持文件，不镜像翻转）
      const stick = document.createElement('div');
      stick.className = 'stickman-runner with-doc';
      stick.innerHTML = STICKMAN_SVG;
      stick.style.transition = 'none'; // 位置由 JS 逐帧驱动，禁用 CSS 过渡
      layer.appendChild(stick);

      // 起点/终点：主卡右缘 -20px → 子卡左缘 +20px，卡片垂直中心高度
      const startX = fromRect.right - 20;
      const startY = fromRect.top + fromRect.height / 2;
      const endX = toRect.left + 20;
      const endY = toRect.top + toRect.height / 2;
      // 两栏间距（目标卡片边缘 - 来源卡片边缘）；≥30px 视为两栏跑道可用
      const runway = toRect.left - fromRect.right;

      // 火柴人移除回调（方向 A）：标记队列空闲并继续出队下一个（若队列非空）
      const onRemoved = function () {
        stickmanBusy = false;
        if (stickmanQueue.length > 0) runQueuedToSub();
      };

      let totalMs;
      if (runway >= 30) {
        // 两栏布局：沿虚线方向直线过渡（派发 toSub 路径，与 runStickman 原逻辑一致）
        totalMs = STICKMAN_TRAVEL_MS;
        driveStickman(stick, buildRunPath({ x: startX, y: startY }, { x: endX, y: endY }, totalMs), totalMs, onRemoved);
      } else {
        // 窄屏单栏布局：退化为直接直线过渡（同样放慢到 5s）
        totalMs = STICKMAN_TRAVEL_MS;
        driveStickman(stick, buildRunPath({ x: startX, y: startY }, { x: endX, y: endY }, totalMs), totalMs, onRemoved);
      }
      launched = true; // 已启动：此后异常交由 onRemoved 收尾

      // 脚底尘土（A 方向）：跑动期间脚下迸出小土点，totalMs+100 后停止生成
      spawnStickDust(stick, totalMs);

      // 派发动画到达终点：子 Agent 办公小人接住文件 + 送达闪光 + 放下文件。
      // totalMs 时刻火柴人正好到达目标卡片边缘，此刻把文件"传递"给子卡小人。
      // 到站回调基于 agent.id 找卡片：卡片已不存在则跳过送达效果（守卫保留）
      window.setTimeout(function () {
        const el = getCardElById(id);
        if (!el) return; // 卡片已被移除（如离场动画中）→ 跳过送达效果
        // 交接第一步：子 Agent 办公小人伸手接住文件
        setOfficeFile(el, true);
        el.classList.add('task-delivered');
        // 表情切换（方案 C）：😟 已在派发时刻由 assignTaskFace 挂上（无需等火柴人到达）
        const drop = document.createElement('span');
        drop.className = 'task-drop';
        drop.textContent = '📄';
        el.appendChild(drop);
        window.setTimeout(function () {
          el.classList.remove('task-delivered');
          if (drop.parentNode) drop.parentNode.removeChild(drop);
        }, 900);
        // 送达效果结束（2.5s）后收回文件，工作期间保持干净；
        // 若期间已完成/失败（正在庆祝 celebrating / 离场 is-leaving）则保留文件——
        // 那正是"拿起文件出发"的状态
        window.setTimeout(function () {
          if (el.classList.contains('is-leaving') || el.classList.contains('celebrating')) return;
          setOfficeFile(el, false);
        }, 2500);
      }, totalMs);

      return true;
    } catch (err) {
      // 兜底：任何异常不阻断轮询。
      // 火柴人已启动（launched）→ 交给 onRemoved 收尾，不再并发启动下一个；
      // 未启动 → 复位忙碌标记并返回 false，由队列继续下一个
      if (launched) return true;
      stickmanBusy = false;
      return false;
    }
  }

  /* 脚底尘土（A 方向）：跑动期间每 STICK_DUST_EVERY_MS 在火柴人脚下生成一颗尘土
   * 圆点，沿 --dx/--dy 随机轨迹上浮淡出（CSS dustPuff，仿 celebrate-particle），
   * STICK_DUST_LIFE_MS 后移除元素；totalMs+100 时停止生成（与火柴人移除同步）。
   * 出生点：stick 左缘 +22（身体中心）、top +54（脚底），加小幅水平抖动避免成直线。
   * stick 可能中途被移除（目标卡片消失），parentNode 守卫直接停表。 */
  function spawnStickDust(stick, totalMs) {
    const timer = window.setInterval(function () {
      if (!stick.parentNode) { window.clearInterval(timer); return; }
      const left = parseFloat(stick.style.left);
      const top = parseFloat(stick.style.top);
      if (!isFinite(left) || !isFinite(top) || !els.animLayer) return; // 首帧坐标未写入前跳过
      const dust = document.createElement('span');
      dust.className = 'stick-dust';
      dust.style.left = (left + 22 + (Math.random() * 8 - 4)) + 'px';
      dust.style.top = (top + 54) + 'px';
      dust.style.setProperty('--dx', (Math.random() * 16 - 8).toFixed(0) + 'px');
      dust.style.setProperty('--dy', (Math.random() * 8 + 6).toFixed(0) + 'px');
      els.animLayer.appendChild(dust);
      window.setTimeout(function () {
        if (dust.parentNode) dust.parentNode.removeChild(dust);
      }, STICK_DUST_LIFE_MS);
    }, STICK_DUST_EVERY_MS);
    window.setTimeout(function () { window.clearInterval(timer); }, totalMs + 100);
  }

  /* 任务交接：给卡片办公小人加/去"手持文件"状态。
   * has=true：SVG 场景加 .has-file（CSS 驱动右手臂前伸 + 文件浮现），
   *            并保证场景内有文件元素（没有则创建一次）；
   * has=false：收回手臂、隐藏文件（元素保留，避免反复创建）。 */
  function setOfficeFile(cardEl, has) {
    if (!cardEl) return;
    const scene = cardEl.querySelector('.office-scene');
    if (!scene) return;
    scene.classList.toggle('has-file', has);
    if (has && !scene.querySelector('.office-file')) {
      scene.insertAdjacentHTML('beforeend', OFFICE_FILE_SVG);
    }
  }

  /* 主 Agent 接收文件：办公小人手持文件 + 卡片收/拒收闪光 + 表情切换。
   * success=true（子 Agent 完成）：绿色"收到"闪光 + 😄（main-receiving，见 style.css）；
   * success=false（子 Agent 失败）：红色"驳回"闪光 + 😟（main-receiving-fail）。
   * 约 2.5s 后收回并恢复默认表情；多个子 Agent 连续汇报时重置计时窗口，避免提前收回。 */
  function mainReceiveFile(success) {
    const mainEl = getCardElById('main');
    if (!mainEl) return;
    const ok = success !== false;
    setOfficeFile(mainEl, true);
    mainEl.classList.add(ok ? 'received-flash' : 'received-flash-fail');
    mainEl.classList.add(ok ? 'main-receiving' : 'main-receiving-fail');
    if (mainEl._receiveTimer) window.clearTimeout(mainEl._receiveTimer);
    mainEl._receiveTimer = window.setTimeout(function () {
      setOfficeFile(mainEl, false);
      mainEl.classList.remove('received-flash');
      mainEl.classList.remove('received-flash-fail');
      mainEl.classList.remove('main-receiving');
      mainEl.classList.remove('main-receiving-fail');
    }, 2500);
  }

  /* 子 Agent 失败离场视觉（方案 A）：挂 .task-failed 类（CSS 驱动红色辉光 / 😢 低头 /
   * 失败抖动 + 红色 ✕ 圆标，见 style.css）+ 重建状态区为失败文案。失败后子卡即被
   * 移出活动列表、updateCard 不再刷新它，状态区会停留在进入 failed 前一刻
   * （如"调用工具中"蓝色 spinner），必须在此一次性改写为 ❌ 失败。
   * 用独立类 .task-failed 而非 status-failed / status-done，避免与完成举手/挥手动画冲突。
   * el 可能为 null（卡片已移出 DOM），调用方需自行保证。 */
  function markCardFailed(el) {
    if (!el) return;
    el.classList.add('task-failed');
    const area = el.querySelector('.status-area');
    if (!area) return;
    const meta = STATUS_META.failed;
    area.innerHTML =
      '<div class="status-line">' +
        '<span class="status-emoji">' + meta.emoji + '</span>' +
        '<span class="status-label">' + meta.label + '</span>' +
        '<span class="status-extra"><span class="failed-x" aria-hidden="true">✕</span></span>' +
      '</div>';
  }

  /* 子 Agent 完成庆祝：卡片顶部散开彩带/星星粒子（CSS 动画沿 --dx/--dy/--rot
   * 随机轨迹飞散），约 CELEBRATE_MS 后自动移除。仅 done 调用；动效敏感用户跳过。 */
  const CELEBRATE_EMOJI = ['🎉', '✨', '⭐', '🎊', '💫'];
  function celebrateCard(id) {
    const el = getCardElById(id);
    if (!el) return;
    const particles = [];
    for (let i = 0; i < 8; i++) {
      const sp = document.createElement('span');
      sp.className = 'celebrate-particle';
      sp.textContent = CELEBRATE_EMOJI[i % CELEBRATE_EMOJI.length];
      // 每个粒子随机：水平 ±110px、向上 50~180px、旋转 ±180°、大小、起播延迟
      const dx = Math.random() * 220 - 110;
      const dy = -(Math.random() * 130 + 50);
      sp.style.setProperty('--dx', dx.toFixed(0) + 'px');
      sp.style.setProperty('--dy', dy.toFixed(0) + 'px');
      sp.style.setProperty('--rot', (Math.random() * 360 - 180).toFixed(0) + 'deg');
      sp.style.left = (30 + Math.random() * 40) + '%';
      sp.style.fontSize = (12 + Math.random() * 10) + 'px';
      sp.style.animationDelay = (Math.random() * 0.35) + 's';
      el.appendChild(sp);
      particles.push(sp);
    }
    window.setTimeout(function () {
      particles.forEach(function (sp) {
        if (sp.parentNode) sp.parentNode.removeChild(sp);
      });
    }, CELEBRATE_MS + 500);
  }

  /* 完成反馈增强（B 方向）：完成瞬间给卡片加 .card-pop（CSS 弹出动画，见 style.css）。
   * 卡片仍处于入场动画（.enter，约 1.7s）时跳过，避免入场动画被覆盖；
   * CARD_POP_MS 后移除类名，供下次重复使用。 */
  function popCard(el) {
    if (!el || el.classList.contains('enter')) return;
    el.classList.add('card-pop');
    window.setTimeout(function () {
      if (el.classList) el.classList.remove('card-pop');
    }, CARD_POP_MS);
  }

  /* 新子 Agent 卡片顶部闪烁"新任务"标记（C 方案）：
   * 在 type-badge 旁插入 .new-task-tag，约 2.2s 后移除（CSS 负责闪烁动画）。 */
  function showNewTaskTag(id) {
    const el = getCardElById(id);
    if (!el) return;
    const badge = document.createElement('span');
    badge.className = 'new-task-tag';
    badge.textContent = '新任务';
    const badgeSlot = el.querySelector('.type-badge');
    if (badgeSlot) badgeSlot.after(badge);
    window.setTimeout(function () {
      if (badge.parentNode) badge.parentNode.removeChild(badge);
    }, 2200);
  }

  /* 新任务"翻脸"表情（方案 C）：给子 Agent 卡片挂 task-assigned（😟，"又要干活了"），
   * 约 3.5s 后移除（恢复默认表情）。在"新子卡出现 / 补充派发"时刻调用——子 Agent
   * 1-2 秒就开始干活，表情应同步跟上，而不是等火柴人 5s 到达才"翻脸"。
   * 卡片已离场（isConnected 守卫）或首帧即完成/失败（nowMap 状态快照）时跳过。
   * 参数：el 目标卡片元素；nowMap 本轮状态快照（可空，用于"首帧即 done/failed"判定）。 */
  function assignTaskFace(el, nowMap) {
    if (!el || !el.isConnected) return;
    if (nowMap) {
      const st = nowMap.get(el.dataset.id);
      if (st === 'done' || st === 'failed') return;
    }
    el.classList.add('task-assigned');
    window.setTimeout(function () {
      if (!el.isConnected) return;
      el.classList.remove('task-assigned');
    }, 3500);
  }

  /* Agent 卡片元素：已完成/失败被移出活动区后返回 null，调用方自行跳过。
   * 主 Agent（id=main）缓存在 mainCards（左栏 main-grid），子 Agent 缓存在
   * activeCards（右栏 active-grid）；两个缓存都未命中时再按卡片 data-id
   * 兜底扫描两个网格——卡片刚被移出缓存但仍在 DOM 的 removing/离场动画
   * 窗口内也能定位到，保证"汇报跑回"动画可出发。 */
  function getCardElById(id) {
    const rec = mainCards[id] || activeCards[id];
    if (rec) return rec.el;
    const grids = [els.mainGrid, els.activeGrid];
    for (let g = 0; g < grids.length; g++) {
      const grid = grids[g];
      if (!grid) continue;
      const cards = grid.querySelectorAll('.agent-card');
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].dataset && cards[i].dataset.id === id) return cards[i];
      }
    }
    return null;
  }

  /* ---------------- 空状态 ---------------- */
  function setEmptyVisible(show) {
    els.emptyState.classList.toggle('hidden', !show);
    els.boardWrap.classList.toggle('hidden', show);
  }

  /* 全量清空：移除 main-grid / active-grid 下所有 Agent 卡片 DOM，并重置
   * mainCards / activeCards 缓存。
   * 仅"无任何 Agent"的空状态调用（服务端重启/清空后旧卡片必须消失）。
   * 残留的离场/闪烁定时器到期后都有 parentNode / 缓存引用守卫，不会误删新卡。 */
  function clearAllCards() {
    [mainCards, activeCards].forEach(function (cache) {
      Object.keys(cache).forEach(function (id) {
        const rec = cache[id];
        if (rec && rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      });
    });
    mainCards = {};
    activeCards = {};
  }

  /* ---------------- 活动卡片网格（主/子分栏，共用一套卡片逻辑） ---------------- */
  /* 主 Agent（左栏 main-grid） */
  function renderMain(mainActive) {
    renderActive(mainActive, mainCards, els.mainGrid);
  }

  /* 方向 B：更新 lastSeen 快照。服务端 lastSeen 为 ISO 字符串，用 Date.parse 转时间戳；
   * 解析失败/缺失时记为当前时间（视为"刚活跃"，不参与超时判定，避免误判）。 */
  function updateLastSeenMap(agents) {
    agents.forEach(function (a) {
      const t = Date.parse(a.lastSeen);
      lastSeenMap.set(a.id, isNaN(t) ? Date.now() : t);
    });
  }

  /* 方向 B：超时回收可视化。服务端按 config.mjs STALE_MS=10min 超时回收 Agent（从
   * /api/state 移除）；前端遍历 lastSeenMap，对"本轮 agents 中不存在"且"lastSeen 距今
   * 超过 STALE_FRONT_MS"的 id 判定为超时回收：卡片仍在 DOM 则挂 .timeout-leaving 类
   * （复用 😴 打盹表情层 office-head-idle）并安排淡出移除（TIMEOUT_LEAVE_MS 后删 DOM）。
   * 排除项：agents 为空（整体清空，render 已提前返回）；main 常驻不参与；
   * done/failed 正常回收走现有 leaveCard/removeActiveCard，用 prevAgentMap 判断 prev
   * 非 done/failed，避免误判为超时。任何异常不阻断轮询（try/catch 兜底）。 */
  function detectTimeoutRecycled(agents) {
    try {
      const now = Date.now();
      const currentIds = new Set(agents.map(function (a) { return a.id; }));
      lastSeenMap.forEach(function (ts, id) {
        if (id === 'main') return;                    // 主 Agent 常驻，不参与超时回收
        if (currentIds.has(id)) return;               // 本轮仍存在 → 跳过
        const prev = prevAgentMap.get(id);
        if (prev === 'done' || prev === 'failed') return; // done/failed 正常回收不误判
        if (!ts || !isFinite(ts) || now - ts <= STALE_FRONT_MS) return; // 未超时 → 跳过
        // 判定为超时回收：卡片仍在 DOM 则挂 .timeout-leaving（😴 打盹）并安排淡出移除；
        // 已在离场（is-leaving）/ 淡出移除（removing）中的卡片交由现有动画收尾
        const el = getCardElById(id);
        if (el && el.isConnected &&
            !el.classList.contains('is-leaving') &&
            !el.classList.contains('removing')) {
          el.classList.add('timeout-leaving');
          if (activeCards[id]) delete activeCards[id]; // 不再由 renderActive 清理（避免双重处理）
          window.setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
          }, TIMEOUT_LEAVE_MS);
        }
        lastSeenMap.delete(id);                        // 已判定处理，移出跟踪
      });
    } catch (err) {
      // 兜底：异常不阻断轮询
    }
  }

  /* 子 Agent（右栏 active-grid）：list 为空时清理缓存中多余卡片。
   * 清理与离场动画协调：
   * - 本轮刚完成/失败的卡片（状态快照中 now 为 done/failed）跳过，
   *   统一交由 animateAgentChanges 走"庆祝 → 挥手拜拜"时序，避免抢先触发离场；
   * - 其他从活动区消失的进行中卡片（prev 非 done/failed，如被服务端超时回收）
   *   同样播放"挥手拜拜 → 淡出"离场动画（leaveCard）；
   * - 其余（main、已完成/失败过、无状态记录的）直接 removeActiveCard 淡出移除。 */
  function renderActive(list, cache, grid, statusMap) {
    const seen = new Set(list.map(function (a) { return a.id; }));

    // 清理已不在活动集合中的卡片
    Object.keys(cache).forEach(function (id) {
      const rec = cache[id];
      if (seen.has(id) || !rec || rec.leavingTimer) return;
      const prev = prevAgentMap.get(id);
      const now = statusMap ? statusMap.get(id) : null;
      if (prev && prev !== 'done' && prev !== 'failed' && cache === activeCards) {
        if (now === 'done' || now === 'failed') return; // 本轮刚完成/失败：交给 animateAgentChanges
        leaveCard(id);   // 其他原因消失：挥手拜拜 → 淡出消失
        return;
      }
      removeActiveCard(id, cache);
    });

    // 更新或新建
    list.forEach(function (agent) { upsertCard(agent, cache, grid); });
  }

  /* 创建/更新卡片：cache 区分 main-grid / active-grid，grid 指定挂载网格。
   * 方案 F：缓存里已存在正在离场（leavingTimer 未清）的旧 rec 时，说明同 id
   * Agent 复活——丢弃旧 rec、新建替换；旧 rec 的离场定时器到期只会移除旧 DOM
   * （leaveCard 删除回调还有 activeCards[id] === rec 守卫），不会误删新卡。 */
  function upsertCard(agent, cache, grid) {
    let rec = cache[agent.id];
    if (rec && rec.leavingTimer) {
      delete cache[agent.id];
      rec = null;
    }
    if (!rec) {
      rec = createCard(agent, grid);
      cache[agent.id] = rec;
    }
    updateCard(rec, agent);
  }

  /* 移除卡片：从对应缓存删除并播放淡出动画 */
  function removeActiveCard(id, cache) {
    const rec = cache[id];
    if (!rec) return;
    delete cache[id];
    rec.el.classList.add('removing');
    window.setTimeout(function () {
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }, REMOVE_ANIM_MS);
  }

  /* 子 Agent 完成/失败离场：done 时先播庆祝（waveDelay > 0 的等待窗口内挂
   * .celebrating 类，保持手持文件姿势），窗口结束后加 is-leaving 类
   * （CSS 挥手拜拜 → 延迟淡出消失），总时长顺延 waveDelay 后从缓存与 DOM 移除。
   * done 离场额外挂 .leaving-done（style.css 据此在挥手/淡出期间保持 😄 表情，
   * 失败卡不加，避免"失败还开心"）；子卡在离场期间不再被 updateCard 更新，
   * 状态类停留在进入 done 前一刻，故不能依赖 status-done 选择器；
   * 失败卡的红色失败视觉（😢 + 抖动 + 状态区改"失败"）由 markCardFailed
   * 挂的 .task-failed 类驱动（style.css）。
   * 主 Agent（main）常驻左栏，不参与。 */
  function leaveCard(id, waveDelay, isDone) {
    const rec = activeCards[id];
    if (!rec || rec.leavingTimer) return;
    const delay = waveDelay || 0;
    rec.el.classList.add('celebrating');
    if (isDone) rec.el.classList.add('leaving-done');
    rec.leavingTimer = window.setTimeout(function () {
      rec.el.classList.remove('celebrating');
      rec.el.classList.add('is-leaving');
    }, delay);
    window.setTimeout(function () {
      // 仅当缓存仍是本卡片时删除（防止同 id 复活出新卡时误删）
      if (activeCards[id] === rec) delete activeCards[id];
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }, LEAVE_TOTAL_MS + delay);
  }

  /* ---------- 创建 / 更新单张卡片 ---------- */
  function createCard(agent, grid) {
    const el = document.createElement('article');
    el.className = 'agent-card enter';
    el.innerHTML = cardShell(agent);
    // 主 Agent 特殊标识（金色边框 + 徽章样式见 style.css）
    if (agent.id === 'main') el.classList.add('is-main');
    el.dataset.id = agent.id; // ID 只存 data 属性供定位，不在界面展示
    grid.appendChild(el);

    const rec = {
      el: el,
      status: null,
      toolType: null,           // 方向 C：工具关联动作类型（'code'/'search'/'dispatch'/'default'/''），缓存比较避免重复操作 classList
      elapsedText: '',
      toolsText: '',
      toolsKey: null,           // 初始 null（非空串）：空工具列表也要触发首次"暂无工具"渲染
      flashTimer: 0,
      statusArea: el.querySelector('.status-area'),
      elapsedEl: el.querySelector('.elapsed-num'),
      toolsEl: el.querySelector('.tools-num'),
      toolItems: el.querySelector('.tool-items'),
      stopZone: el.querySelector('.stop-zone'), // 停止按钮容器（meta-line 内）
      stopState: 'none',                         // 停止区缓存状态：'none' / 'active' / 'stopped'
      stopSent: false,                           // 本地是否已发送停止请求（成功前不依赖服务端回显）
      agent: agent,                // 最近一次渲染的 agent 数据（供停止点击回调使用）
    };

    // 1.5s 入场动画结束后移除 enter，避免干扰后续状态闪烁
    window.setTimeout(function () { el.classList.remove('enter'); }, ENTER_ANIM_MS);
    return rec;
  }

  /* main 主 Agent 的展示状态：lastSeen 距今超过 IDLE_TIMEOUT（且非完成/失败）时
   * 显示"待机"（idle，见 STATUS_META），否则按实际状态显示。
   * 方案 E：main 正在思考/调用工具、且仍有存活子 Agent 时不算待机——它正阻塞等待
   * 子 Agent 交回结果，应显示真实状态，避免"边干活边睡觉"。
   * 只影响前端展示，不改服务端数据；main 有新事件（lastSeen 刷新）后自动恢复正常状态。
   * 子 Agent 不走此逻辑（完成/失败走拜拜离场，不适用待机）。 */
  function effectiveStatus(agent) {
    if (agent.id === 'main' && agent.lastSeen) {
      const idleMs = Date.now() - new Date(agent.lastSeen).getTime();
      const busyWaiting = hasSubAgents &&
        (agent.status === 'thinking' || agent.status === 'tool');
      if (idleMs > IDLE_TIMEOUT && agent.status !== 'done' && agent.status !== 'failed' && !busyWaiting) {
        return 'idle';
      }
    }
    return normalizeStatus(agent.status);
  }

  function updateCard(rec, agent) {
    const status = effectiveStatus(agent);
    const el = rec.el;
    rec.agent = agent; // 供停止点击回调读取最新 agent 数据

    // 1) 状态变化 → 重建状态区（保证 dot/spinner 动画不被 600ms 重绘打断）+ 边框脉冲一次
    if (rec.status !== status) {
      if (rec.status) el.classList.remove('status-' + rec.status);
      el.classList.add('status-' + status);
      rec.status = status;
      rec.statusArea.innerHTML = buildStatusArea(agent);
      flashCard(rec);
    }

    // 1b) 工具关联动作分类（方向 C）：tool 状态按当前工具名计算分类，
    //     给卡片挂/移除 tool-type-XXX 类（驱动屏幕内容切换，见 style.css）；
    //     非 tool 状态清空分类并移除旧类。rec.toolType 缓存避免重复操作 classList
    const toolType = status === 'tool' ? toolTypeOf(toolNameFor(agent)) : '';
    if (rec.toolType !== toolType) {
      if (rec.toolType) el.classList.remove('tool-type-' + rec.toolType);
      rec.toolType = toolType;
      if (toolType) el.classList.add('tool-type-' + toolType);
    }

    // 2) 已用时长
    const elapsedText = formatElapsed(agent.startTime);
    if (rec.elapsedText !== elapsedText) {
      rec.elapsedText = elapsedText;
      rec.elapsedEl.textContent = elapsedText;
    }

    // 3) 工具计数
    const toolsText = '工具调用 ' + fmtNum(agent.toolCount) + ' 次';
    if (rec.toolsText !== toolsText) {
      rec.toolsText = toolsText;
      rec.toolsEl.textContent = toolsText;
    }

    // 4) 最近工具（简化版：仅 tool:xxx 条目，内容变化才重绘避免闪烁；
    //    超出卡片固定高度时由 .tool-items 内部滚动，见 style.css）
    const toolsKey = extractRecentTools(agent.history).join('|');
    if (rec.toolsKey !== toolsKey) {
      rec.toolsKey = toolsKey;
      const tools = toolsKey ? toolsKey.split('|') : [];
      rec.toolItems.innerHTML = tools.length
        ? tools.map(function (t) {
            return '<span class="tool-chip">' + escapeHtml(t) + '</span>';
          }).join('')
        : '<span class="tool-none">— 暂无工具 —</span>';
    }

    // 5) 停止按钮：仅存活中的子 Agent 显示；已停止（stopRequested 或本地已发送）→ 禁用 + 灰化
    updateStopZone(rec, agent);
  }

  /* 停止按钮渲染（本任务闭环）：
   * - 存活中的子 Agent（非 main、queued/thinking/tool/asking 之一）→ 显示「⏹ 停止」；
   * - /api/state 的 stopRequested 为 true，或本地已发送停止请求（rec.stopSent）→ 显示
   *   「⏹ 已停止」（按钮 disabled + 卡片灰化 status-stopped）；
   * - 其余（main、done/failed、离场/移除中的子 Agent）→ 隐藏按钮区。
   * rec.stopState 缓存避免 600ms 轮询反复重建 DOM。 */
  function updateStopZone(rec, agent) {
    const zone = rec.stopZone;
    if (!zone) return;
    const agentObj = agent || rec.agent;
    const requested = !!(agentObj && agentObj.stopRequested) || rec.stopSent;
    let state;
    if (requested) {
      state = 'stopped';
    } else if (canStopAgent(agentObj)) {
      state = 'active';
    } else {
      state = 'none';
    }
    if (rec.stopState !== state) {
      rec.stopState = state;
      if (state === 'none') {
        zone.innerHTML = '';
      } else if (state === 'active') {
        zone.innerHTML =
          '<button type="button" class="stop-agent-btn" title="向主会话发送停止该子 Agent 的请求">⏹ 停止</button>';
      } else {
        zone.innerHTML = '<button type="button" class="stop-agent-btn" disabled>⏹ 已停止</button>';
      }
    }
    // 卡片整体灰化：stopRequested（服务端回显）或本地已发送停止请求均触发
    rec.el.classList.toggle('status-stopped', requested);
  }

  /* 子 Agent 是否处于"存活中"可停止状态（非 main、未 done/failed） */
  function canStopAgent(agent) {
    if (!agent || agent.id === 'main') return false;
    const st = normalizeStatus(agent.status);
    return st === 'queued' || st === 'thinking' || st === 'tool' || st === 'asking';
  }

  /* ---------------- 办公场景（卡片内坐姿小人） ---------------- */
  /* 坐姿小人 + 电脑（屏幕+键盘）+ 桌子，70x55 视口；
   * 屏幕闪光 / 手臂姿势等状态动画由 style.css 按 .agent-card.status-* 驱动。 */
  const OFFICE_SVG =
    '<svg class="office-scene" viewBox="0 0 90 70" aria-hidden="true">' +
      // 桌子
      '<rect x="8" y="48" width="74" height="5" rx="2" fill="currentColor" opacity="0.25"></rect>' +
      '<rect x="10" y="53" width="4" height="12" fill="currentColor" opacity="0.2"></rect>' +
      '<rect x="76" y="53" width="4" height="12" fill="currentColor" opacity="0.2"></rect>' +
      // 电脑屏幕（暗底 + 可动画的发光层）
      '<rect class="pc-screen" x="28" y="22" width="34" height="24" rx="3" fill="currentColor" opacity="0.15"></rect>' +
      '<rect class="pc-screen-glow" x="31" y="25" width="28" height="18" rx="2" fill="currentColor" opacity="0"></rect>' +
      // 屏幕内容层（方向 C）：按工具关联动作类型切换（tool-type-XXX 类驱动显隐，
      // 见 style.css）。4 个子层默认全部隐藏，28×18 屏幕视口内绘制、复用 currentColor：
      // - screen-code：3 条细矩形模拟代码行；
      // - screen-search / screen-dispatch / screen-default：🔍 / 📨 / 🛠 图标
      '<g class="screen-content">' +
        '<g class="screen-code">' +
          '<rect x="33" y="27" width="15" height="2" rx="1" fill="currentColor" opacity="0.9"></rect>' +
          '<rect x="33" y="31" width="10" height="2" rx="1" fill="currentColor" opacity="0.55"></rect>' +
          '<rect x="33" y="35" width="17" height="2" rx="1" fill="currentColor" opacity="0.75"></rect>' +
        '</g>' +
        '<text class="screen-search" x="45" y="39" text-anchor="middle" font-size="8">🔍</text>' +
        '<text class="screen-dispatch" x="45" y="39" text-anchor="middle" font-size="8">📨</text>' +
        '<text class="screen-default" x="45" y="39" text-anchor="middle" font-size="8">🛠</text>' +
      '</g>' +
      // 电脑底座
      '<rect x="38" y="46" width="14" height="3" fill="currentColor" opacity="0.3"></rect>' +
      // 坐姿小人（头 + 身体 + 手臂伸向键盘）
      // 头部为多层 text：默认按角色区分——主 Agent 显示戴墨镜酷脸（office-head-active 😎），
      // 子 Agent 显示翻白眼（office-head-sub 🙄，由 style.css 的 :not(.is-main) 规则切换）。
      // status-idle（主 Agent 待机）切换为打盹表情，task-assigned 切换为不开心，
      // celebrating / main-receiving 切换为开心表情。emoji 字形由状态类控制显隐，无需 JS 改 DOM。
      '<text class="office-head office-head-active" x="15" y="28" text-anchor="middle" font-size="16">😎</text>' +
      // 子 Agent 默认表情层：翻白眼（"又让我干活"），仅非 main 卡片显示
      '<text class="office-head office-head-sub" x="15" y="28" text-anchor="middle" font-size="16">🙄</text>' +
      '<text class="office-head office-head-idle" x="15" y="28" text-anchor="middle" font-size="16">😴</text>' +
      // 不开心表情层：子 Agent 接到新任务（task-assigned，约 3.5s）时切换为 😟（"又要干活了"）
      '<text class="office-head office-head-sad" x="15" y="28" text-anchor="middle" font-size="16">😟</text>' +
      // 开心表情层：子 Agent 完成庆祝（celebrating）/ 挥手拜拜（is-leaving，仅 done）、
      // 主 Agent 接收任务（main-receiving）时切换为 😄（显隐规则见 style.css）
      '<text class="office-head office-head-happy" x="15" y="28" text-anchor="middle" font-size="16">😄</text>' +
      // 失败表情层：子 Agent 失败离场（.task-failed，markCardFailed 加挂）时切换为 😢
      '<text class="office-head office-head-fail" x="15" y="28" text-anchor="middle" font-size="16">😢</text>' +
      '<line class="office-body" x1="15" y1="31" x2="15" y2="44" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="office-arm-l" x1="15" y1="33" x2="26" y2="39" stroke="currentColor" stroke-width="2"></line>' +
      '<line class="office-arm-r" x1="15" y1="33" x2="26" y2="41" stroke="currentColor" stroke-width="2"></line>' +
      // 坐姿腿（弯曲在桌下）
      '<line class="office-leg-l" x1="15" y1="44" x2="9" y2="50" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="office-leg-r" x1="15" y1="44" x2="22" y2="50" stroke="currentColor" stroke-width="2.5"></line>' +
    '</svg>';

  /* 交接文件小纸片：追加到 .office-scene 内，由 .has-file 控制显隐。
   * 位置在坐姿小人右手前上方（右手臂前伸 -50° 时指尖 ~(28,29)，纸片左缘即落点）。 */
  const OFFICE_FILE_SVG =
    '<g class="office-file" aria-hidden="true">' +
      '<rect x="27" y="18" width="9" height="13" rx="1.5" fill="#e7eaf3" stroke="#8d97ad" stroke-width="1"></rect>' +
      '<line x1="29" y1="23" x2="34" y2="23" stroke="#8d97ad" stroke-width="1.2"></line>' +
      '<line x1="29" y1="26" x2="34" y2="26" stroke="#8d97ad" stroke-width="1.2"></line>' +
    '</g>';

  /* 卡片外壳：头部（任务描述，不显示长 ID）+ 状态区（动态）+ 办公场景 + 元信息 + 历史 */
  function cardShell(agent) {
    const type = typeof agent.type === 'string' && agent.type ? agent.type : 'Agent';
    // 名称显示：主 Agent 固定显示"主 Agent"（不受服务端可能误写的 name 影响）；
    // 子 Agent 优先任务描述 name，为空回退显示 type
    const name = truncate(agent.id === 'main' ? '主 Agent' : (typeof agent.name === 'string' && agent.name ? agent.name : type), 30);
    const badge = agent.id === 'main' ? '主' : type;
    return '' +
      '<div class="card-wrap">' +
        '<span class="accent" aria-hidden="true"></span>' +
        '<div class="card-head">' +
          '<span class="agent-name">' + escapeHtml(name) + '</span>' +
          '<span class="type-badge">' + escapeHtml(badge) + '</span>' +
        '</div>' +
        '<div class="status-area"></div>' +
        OFFICE_SVG +
        '<div class="meta-line">' +
          '<span class="meta-item">⏱ <b class="elapsed-num">已用 --:--</b></span>' +
          '<span class="meta-item">🧰 <b class="tools-num">工具 0 次</b></span>' +
          '<span class="stop-zone"></span>' +
        '</div>' +
        '<div class="tool-block">' +
          '<div class="tool-block-title">最近工具</div>' +
          '<div class="tool-items"></div>' +
        '</div>' +
      '</div>';
  }

  /* 依据状态构建状态区（此处是各状态动画的“家”）。
   * 与 updateCard 一致用 effectiveStatus：main 空闲时显示"待机"表情与标签 */
  function buildStatusArea(agent) {
    const status = effectiveStatus(agent);
    const meta = STATUS_META[status];
    let extra = '';
    let bar = '';

    if (status === 'queued') {
      // 呼吸脉动发生在 .card-wrap 上，这里不再加额外动画块
      extra = '<span class="ask-ring" aria-hidden="true"></span>';
    } else if (status === 'thinking') {
      // 三点弹跳
      extra = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    } else if (status === 'tool') {
      // 工具名胶囊 + conic 环形 spinner
      extra = '<span class="tool-pill">' + escapeHtml(toolNameFor(agent)) +
        '</span><span class="spinner" aria-hidden="true"></span>';
      // 全宽进度条流光
      bar = '<div class="progress" aria-hidden="true"></div>';
    } else if (status === 'asking') {
      // 黄色脉冲在 .card-wrap 上，状态行补一个请求环
      extra = '<span class="ask-ring" aria-hidden="true"></span>';
    } else if (status === 'done') {
      // 绿色勾号（stroke-dasharray 绘制）
      extra = CHECK_SVG;
    } else if (status === 'failed') {
      // 红色 ✕
      extra = '<span class="failed-x" aria-hidden="true">✕</span>';
    }

    return '<div class="status-line">' +
      '<span class="status-emoji">' + meta.emoji + '</span>' +
      '<span class="status-label">' + meta.label + '</span>' +
      '<span class="status-extra">' + extra + '</span>' +
    '</div>' + bar;
  }

  /* 边框脉冲一次（提示状态发生变化） */
  function flashCard(rec) {
    if (rec.flashTimer) window.clearTimeout(rec.flashTimer);
    const el = rec.el;
    el.classList.remove('status-flash');
    void el.offsetWidth; // 强制重排以便动画重新播放
    el.classList.add('status-flash');
    rec.flashTimer = window.setTimeout(function () {
      el.classList.remove('status-flash');
    }, 760);
  }

  /* 提取"最近调用的工具"（简化版）：只取 history 中的 tool:xxx 条目，
   * thinking / start / done 等状态项不展示；倒序收集最近 TOOL_TAIL 条工具名。
   * 返回工具名数组（无则空数组）。 */
  function extractRecentTools(history) {
    const arr = Array.isArray(history) ? history : [];
    const tools = [];
    for (let i = arr.length - 1; i >= 0 && tools.length < TOOL_TAIL; i--) {
      const m = String(arr[i]).match(/^tool:(.+)$/i);
      if (m) tools.unshift(m[1].trim() || '工具');
    }
    return tools;
  }

  /* ---------------- 页脚 ---------------- */
  function renderFooter(updatedAt) {
    if (!updatedAt) {
      els.updatedAt.textContent = '—';
      return;
    }
    const d = new Date(updatedAt);
    if (isNaN(d.getTime())) {
      els.updatedAt.textContent = '—';
      return;
    }
    els.updatedAt.textContent = '更新时间 ' + d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  /* ---------------- 工具函数 ---------------- */
  function normalizeStatus(s) {
    const v = String(s || '').toLowerCase();
    return STATUS_META[v] ? v : 'unknown';
  }

  function priorityOf(agent) {
    return ACTIVE_PRIORITY[normalizeStatus(agent.status)] !== undefined
      ? ACTIVE_PRIORITY[normalizeStatus(agent.status)]
      : 5;
  }

  /* 工具名：优先 currentTool，其次从 history 里反向找最近一次 tool: */
  function toolNameFor(agent) {
    if (typeof agent.currentTool === 'string' && agent.currentTool.trim()) {
      return stripToolPrefix(agent.currentTool);
    }
    const h = Array.isArray(agent.history) ? agent.history : [];
    for (let i = h.length - 1; i >= 0; i--) {
      const m = String(h[i]).match(/^tool:(.+)$/i);
      if (m) return m[1].trim() || '工具';
    }
    return '调用工具';
  }

  function stripToolPrefix(value) {
    const m = String(value).match(/^tool:(.+)$/i);
    return m ? m[1].trim() : String(value);
  }

  /* 工具名 → 关联动作类型（方向 C）：先去 tool: 前缀并小写，再按 TOOL_TYPE_MAP
   * 逐类匹配，命中返回 'code' / 'search' / 'dispatch'，否则返回 'default'。
   * 由 updateCard 用于挂 tool-type-XXX 类，切换卡片电脑屏幕内容。 */
  function toolTypeOf(name) {
    const clean = stripToolPrefix(name).toLowerCase();
    for (const type in TOOL_TYPE_MAP) {
      if (Object.prototype.hasOwnProperty.call(TOOL_TYPE_MAP, type) &&
          TOOL_TYPE_MAP[type].indexOf(clean) !== -1) return type;
    }
    return 'default';
  }

  /* 已用时长：mm:ss，超过 1 小时显示 h:mm:ss */
  function formatElapsed(startTime) {
    if (!startTime) return '已用 --:--';
    const start = new Date(startTime).getTime();
    if (isNaN(start)) return '已用 --:--';
    let sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    const pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0
      ? '已用 ' + h + ':' + pad(m) + ':' + pad(ss)
      : '已用 ' + m + ':' + pad(ss);
  }

  function fmtNum(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 截断字符串，超过 max 长度时加省略号 */
  function truncate(str, max) {
    var s = String(str);
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  /* 完成状态勾号 SVG（stroke-dasharray 绘制动画见 style.css） */
  const CHECK_SVG =
    '<svg class="check-svg" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 12.5 L10 18.5 L20 5.5" fill="none" stroke="currentColor" ' +
        'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />' +
    '</svg>';
})();