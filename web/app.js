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
  const HISTORY_TAIL = 6;             // history 轨迹最多显示的条数
  /* main 主 Agent 空闲判定阈值（毫秒）：lastSeen 距今超过该值 → 前端展示"待机"。
   * 仅影响 main 卡片展示，不改服务端数据；有新事件（lastSeen 刷新）自动恢复真实状态 */
  const IDLE_TIMEOUT = 60000;

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

  /* 活动卡片网格内的排序优先级：越靠前越优先 */
  const ACTIVE_PRIORITY = { asking: 0, tool: 1, thinking: 2, queued: 3, running: 4, unknown: 5 };

  /* ---------------- 内部状态 ---------------- */
  let els = {};                 // 缓存的 DOM 引用
  let mainCards = {};           // 主 Agent（id=main）卡片缓存（main-grid）: id -> { el, status, elapsedText, toolsText, historyKey, flashTimer }
  let activeCards = {};         // 子 Agent 卡片缓存（active-grid）: id -> { el, status, elapsedText, toolsText, historyKey, flashTimer }
  let polling = false;          // 轮询互斥锁
  let prevAgentMap = new Map(); // 全部 Agent: id -> 上次渲染时的状态（用于检测新出现/完成）
  let stickmanSeeded = false;   // 首次渲染是否已建立基准（首次不触发火柴人动画）
  let lastMainAgentCallCount = 0; // main 的 history 中派发/补充任务工具调用（Agent/SendMessage）累计次数基准

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // 收集 DOM
    els.boardWrap = document.getElementById('board-wrap');
    els.mainGrid = document.getElementById('main-grid');
    els.activeGrid = document.getElementById('active-grid');
    els.emptyState = document.getElementById('empty-state');
    els.noActiveNote = document.getElementById('no-active-note');
    els.connBanner = document.getElementById('conn-banner');
    els.updatedAt = document.getElementById('updated-at');

    // 火柴人动画层：固定定位覆盖全屏，挂在 body 末尾，不参与布局
    els.animLayer = document.createElement('div');
    els.animLayer.id = 'anim-layer';
    els.animLayer.className = 'anim-layer';
    els.animLayer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(els.animLayer);

    // 初始空状态
    setEmptyVisible(true);

    // 立即拉取一次，然后按固定间隔轮询
    poll();
    window.setInterval(poll, POLL_INTERVAL);
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

  /* ---------------- 主渲染 ---------------- */
  function render(data) {
    const agents = Array.isArray(data.agents) ? data.agents : [];
    renderFooter(data.updatedAt);

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

    const mainActive = mainList; // 常驻：不做 done/failed 过滤
    const subActive = subList.filter(function (a) {
      return !FOLDED_STATUS[normalizeStatus(a.status)]; // 完成/失败的子 Agent 走拜拜消失，不进活动区
    }).sort(function (a, b) {
      return priorityOf(a) - priorityOf(b);
    });

    // 子 Agent 区提示：没有进行中的子 Agent 时显示
    els.noActiveNote.classList.toggle('hidden', subActive.length > 0);

    // 本轮各 Agent 状态快照：renderActive 清理与 animateAgentChanges 共用，
    // 保证"刚完成/失败"的判定一致（避免清理路径抢先触发离场、破坏庆祝时序）
    const nowStatus = new Map(agents.map(function (a) {
      return [a.id, normalizeStatus(a.status)];
    }));

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
      // 头部双层 emoji（font-size 11、y=12，视觉"圆点"大小居中）：
      // 派发（toSub）显示 😎（主 Agent 派人送文件）；交回汇报（backToMain，.flip）
      // 切换为 😄（子 Agent 完成交回，与 celebrating 表情呼应），显隐规则见 style.css
      '<text class="stick-head stick-head-run" x="15" y="12" text-anchor="middle" font-size="11">😎</text>' +
      '<text class="stick-head stick-head-report" x="15" y="12" text-anchor="middle" font-size="11">😄</text>' +
      '<line x1="15" y1="14" x2="15" y2="26" stroke="currentColor" stroke-width="2.5"/>' +
      '<line class="arm-left" x1="15" y1="18" x2="6" y2="13" stroke="currentColor" stroke-width="2.5"/>' +
      '<line class="arm-right" x1="15" y1="18" x2="24" y2="13" stroke="currentColor" stroke-width="2.5"/>' +
      '<line class="leg-left" x1="15" y1="26" x2="7" y2="36" stroke="currentColor" stroke-width="2.5"/>' +
      '<line class="leg-right" x1="15" y1="26" x2="23" y2="36" stroke="currentColor" stroke-width="2.5"/>' +
      // 派发时手里拿的文件（画在右手上方）
      '<rect class="doc" x="22" y="4" width="6" height="9" rx="1" fill="#e7eaf3" opacity="0"/>' +
      '<line class="doc-line" x1="24" y1="7" x2="26" y2="7" stroke="#8d97ad" stroke-width="1" opacity="0"/>' +
      '<line class="doc-line" x1="24" y1="9" x2="26" y2="9" stroke="#8d97ad" stroke-width="1" opacity="0"/>' +
      // 汇报时带回的绿色勾标（手右侧小圆点）
      '<circle class="report-mark" cx="25" cy="6" r="3.4" fill="#22c55e" opacity="0"/>' +
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
        // 交接第二步：子 Agent 办公小人拿起文件 → 火柴人（持文件）跑回主 Agent 汇报
        setOfficeFile(getCardElById(a.id), true);
        // 完成庆祝（仅 done）：粒子散开 ~1.8s 后才进入挥手拜拜；
        // 失败不庆祝（保留 ❌ 抖动）；动效敏感用户跳过庆祝与延时
        const reducedMotion = window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (now === 'done' && !reducedMotion) celebrateCard(a.id);
        runStickman('backToMain', a);
        leaveCard(a.id, now === 'done' && !reducedMotion ? CELEBRATE_MS : 0, now === 'done');
      }
    });

    prevAgentMap = nowMap;
  }

  /* 缓动：ease-in-out（二次贝塞尔近似） */
  function easeInOut(p) {
    return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  }

  /* 火柴人位置驱动：16ms 定时器逐帧插值，逐段 ease-in-out。
   * 不依赖 CSS transition / requestAnimationFrame（低帧率或节流环境下也稳定）。
   * path: [{ x, y, dur }, ...] 依次经过的路径点（首点为起点，dur 为到达该点的用时）；
   * totalMs 结束后停止并移除火柴人。 */
  function driveStickman(stick, path, totalMs) {
    const t0 = Date.now();
    const step = function () {
      const t = Math.min(Date.now() - t0, totalMs);
      // 定位当前所在路径段
      let acc = 0;
      let seg = -1;
      for (let i = 0; i + 1 < path.length; i++) {
        if (t <= acc + path[i + 1].dur) { seg = i; break; }
        acc += path[i + 1].dur;
      }
      if (seg === -1) {
        const last = path[path.length - 1];
        stick.style.left = last.x + 'px';
        stick.style.top = last.y + 'px';
        return;
      }
      const from = path[seg];
      const to = path[seg + 1];
      const p = to.dur > 0 ? easeInOut(Math.max(0, Math.min(1, (t - acc) / to.dur))) : 1;
      stick.style.left = (from.x + (to.x - from.x) * p) + 'px';
      stick.style.top = (from.y + (to.y - from.y) * p) + 'px';
    };
    step();
    const timer = window.setInterval(step, 16);
    window.setTimeout(function () {
      window.clearInterval(timer);
      if (stick.parentNode) stick.parentNode.removeChild(stick);
    }, totalMs + 100);
  }

  /* direction: 'toSub'（主 → 子）| 'backToMain'（子 → 主）
   * 三段式路径：主 Agent 在左栏、子 Agent 在右栏，两栏之间有宽阔跑道（列间 gap 100px）。
   * 火柴人先水平穿过跑道 → 在跑道内垂直移动到目标卡片中心高度 → 水平切入/切出卡片边缘，
   * 全程不与其他卡片重叠；窄屏单栏（两栏间距 < 30px）时退化为直线过渡。 */
  function runStickman(direction, agent) {
    const layer = els.animLayer;
    if (!layer || !agent || agent.id === 'main') return;
    // 动效敏感用户：直接不创建火柴人（style.css 另有全局降级）
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // 主 Agent 在左栏 main-grid、子 Agent 在右栏 active-grid，统一用 getCardElById 取卡片
    // （main 未出现时返回 null，走 FALLBACK_MAIN_RECT 占位）
    const fromEl = direction === 'toSub' ? getCardElById('main') : getCardElById(agent.id);
    const toEl = direction === 'toSub' ? getCardElById(agent.id) : getCardElById('main');

    let fromRect, toRect;
    if (direction === 'toSub') {
      if (!toEl) return; // 子 Agent 卡片还不存在（如首帧即 done/failed）→ 无法到达
      fromRect = fromEl ? fromEl.getBoundingClientRect() : FALLBACK_MAIN_RECT;
      toRect = toEl.getBoundingClientRect();
    } else {
      if (!fromEl) return; // 子 Agent 卡片已被移出 DOM → 无法出发
      fromRect = fromEl.getBoundingClientRect();
      toRect = toEl ? toEl.getBoundingClientRect() : FALLBACK_MAIN_RECT;
    }

    // 创建火柴人：跑回来时镜像翻转（面向左）+ 带回汇报绿勾 + 手里拿着交接的文件
    // （.doc 文件随 with-doc 显形；派发时同样持文件）
    const stick = document.createElement('div');
    stick.className = 'stickman-runner' + (direction === 'backToMain' ? ' flip report with-doc' : ' with-doc');
    stick.innerHTML = STICKMAN_SVG;
    stick.style.transition = 'none'; // 位置由 JS 逐帧驱动，禁用 CSS 过渡
    layer.appendChild(stick);

    // 起点/终点：卡片边缘 ±20px 处（火柴人放大到 44px 宽后，半宽 22px≈20px，
    // 到达时身体中心大致对齐卡片边缘）、卡片垂直中心高度
    const startX = direction === 'toSub' ? fromRect.right - 20 : fromRect.left + 20;
    const startY = fromRect.top + fromRect.height / 2;
    const endX = direction === 'toSub' ? toRect.left + 20 : toRect.right - 20;
    const endY = toRect.top + toRect.height / 2;
    // 跑道内垂直移动的专用 x 通道：紧贴目标卡片外侧 24px（位于两栏之间，
    // 与放大后的火柴人半宽匹配，全程不压卡片）
    const gapX = direction === 'toSub' ? toRect.left - 24 : toRect.right + 24;
    // 两栏间距（目标卡片边缘 - 来源卡片边缘）；≥30px 视为两栏跑道可用
    const runway = direction === 'toSub'
      ? toRect.left - fromRect.right
      : fromRect.left - toRect.right;

    let totalMs;
    if (runway >= 30) {
      // 两栏布局：水平(1.8s) → 垂直(2.4s) → 水平(0.8s) 三段式，全程在跑道内
      // （派发 toSub 与汇报 backToMain 共用本路径；用户要求派发总时长 5s）
      const PH1 = 1800, PH2 = 2400, PH3 = 800;
      totalMs = PH1 + PH2 + PH3;
      driveStickman(stick, [
        { x: startX, y: startY, dur: 0 },
        { x: gapX,   y: startY, dur: PH1 },
        { x: gapX,   y: endY,   dur: PH2 },
        { x: endX,   y: endY,   dur: PH3 }
      ], totalMs);
    } else {
      // 窄屏单栏布局：退化为直接直线过渡（同样放慢到 5s，与两栏节奏接近）
      totalMs = 5000;
      driveStickman(stick, [
        { x: startX, y: startY, dur: 0 },
        { x: endX,   y: endY,   dur: totalMs }
      ], totalMs);
    }

    // 派发动画（toSub）到达终点：子 Agent 办公小人接住文件 + 送达闪光 + 放下文件。
    // totalMs 时刻火柴人正好到达目标卡片边缘，此刻把文件"传递"给子卡小人
    // （.has-file：手臂前伸 + 文件浮现），并落一个 📄 闪一下边框，短暂停留后移除，
    // 让用户明确看到"任务送到了子 Agent"。
    if (direction === 'toSub') {
      window.setTimeout(function () {
        const el = getCardElById(agent.id);
        if (!el) return; // 卡片已被移除（如离场动画中）→ 跳过送达效果
        // 交接第一步：子 Agent 办公小人伸手接住文件
        setOfficeFile(el, true);
        el.classList.add('task-delivered');
        // 表情切换：接到任务 → 😟（"又要干活了"），约 3.5s 后恢复 🧑 开始工作。
        // 若期间已完成（celebrating/is-leaving，优先级更高显示 😄）则无碍，
        // 移除时卡若已离场（isConnected 守卫）直接跳过。
        el.classList.add('task-assigned');
        window.setTimeout(function () {
          if (!el.isConnected) return;
          el.classList.remove('task-assigned');
        }, 3500);
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
    } else if (direction === 'backToMain') {
      // 交接第三步：火柴人到达主 Agent → 主 Agent 办公小人接住文件 + 绿色"收到"闪光
      window.setTimeout(mainReceiveFile, totalMs);
    }
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

  /* 主 Agent 接收文件：办公小人手持文件 + 卡片绿色"收到"闪光 + 表情切换 😄
   * （main-receiving 类，见 style.css），约 2.5s 后收回并恢复 🧑。
   * 多个子 Agent 连续汇报时重置计时窗口，避免提前收回。 */
  function mainReceiveFile() {
    const mainEl = getCardElById('main');
    if (!mainEl) return;
    setOfficeFile(mainEl, true);
    mainEl.classList.add('received-flash');
    mainEl.classList.add('main-receiving');
    if (mainEl._receiveTimer) window.clearTimeout(mainEl._receiveTimer);
    mainEl._receiveTimer = window.setTimeout(function () {
      setOfficeFile(mainEl, false);
      mainEl.classList.remove('received-flash');
      mainEl.classList.remove('main-receiving');
    }, 2500);
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

  /* 创建/更新卡片：cache 区分 main-grid / active-grid，grid 指定挂载网格 */
  function upsertCard(agent, cache, grid) {
    let rec = cache[agent.id];
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
    }, 420);
  }

  /* 子 Agent 完成/失败离场：done 时先播庆祝（waveDelay > 0 的等待窗口内挂
   * .celebrating 类，保持手持文件姿势），窗口结束后加 is-leaving 类
   * （CSS 挥手拜拜 → 延迟淡出消失），总时长顺延 waveDelay 后从缓存与 DOM 移除。
   * done 离场额外挂 .leaving-done（style.css 据此在挥手/淡出期间保持 😄 表情，
   * 失败卡不加，避免"失败还开心"）；子卡在离场期间不再被 updateCard 更新，
   * 状态类停留在进入 done 前一刻，故不能依赖 status-done 选择器。
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
      elapsedText: '',
      toolsText: '',
      historyKey: '',
      flashTimer: 0,
      statusArea: el.querySelector('.status-area'),
      elapsedEl: el.querySelector('.elapsed-num'),
      toolsEl: el.querySelector('.tools-num'),
      historyItems: el.querySelector('.history-items')
    };

    // 1.5s 入场动画结束后移除 enter，避免干扰后续状态闪烁
    window.setTimeout(function () { el.classList.remove('enter'); }, 1700);
    return rec;
  }

  /* main 主 Agent 的展示状态：lastSeen 距今超过 IDLE_TIMEOUT（且非完成/失败）时
   * 显示"待机"（idle，见 STATUS_META），否则按实际状态显示。
   * 只影响前端展示，不改服务端数据；main 有新事件（lastSeen 刷新）后自动恢复正常状态。
   * 子 Agent 不走此逻辑（完成/失败走拜拜离场，不适用待机）。 */
  function effectiveStatus(agent) {
    if (agent.id === 'main' && agent.lastSeen) {
      const idleMs = Date.now() - new Date(agent.lastSeen).getTime();
      if (idleMs > IDLE_TIMEOUT && agent.status !== 'done' && agent.status !== 'failed') {
        return 'idle';
      }
    }
    return normalizeStatus(agent.status);
  }

  function updateCard(rec, agent) {
    const status = effectiveStatus(agent);
    const el = rec.el;

    // 1) 状态变化 → 重建状态区（保证 dot/spinner 动画不被 600ms 重绘打断）+ 边框脉冲一次
    if (rec.status !== status) {
      if (rec.status) el.classList.remove('status-' + rec.status);
      el.classList.add('status-' + status);
      rec.status = status;
      rec.statusArea.innerHTML = buildStatusArea(agent);
      flashCard(rec);
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

    // 4) 历史轨迹（内容变化才重绘，避免闪烁）
    updateHistory(rec, agent);
  }

  /* ---------------- 办公场景（卡片内坐姿小人） ---------------- */
  /* 坐姿小人 + 电脑（屏幕+键盘）+ 桌子，90x70 视口；
   * 屏幕闪光 / 手臂姿势等状态动画由 style.css 按 .agent-card.status-* 驱动。 */
  const OFFICE_SVG =
    '<svg class="office-scene" viewBox="0 0 90 70" aria-hidden="true">' +
      // 桌子
      '<rect x="8" y="48" width="74" height="5" rx="2" fill="currentColor" opacity="0.25"/>' +
      '<rect x="10" y="53" width="4" height="12" fill="currentColor" opacity="0.2"/>' +
      '<rect x="76" y="53" width="4" height="12" fill="currentColor" opacity="0.2"/>' +
      // 电脑屏幕（暗底 + 可动画的发光层）
      '<rect class="pc-screen" x="28" y="22" width="34" height="24" rx="3" fill="currentColor" opacity="0.15"/>' +
      '<rect class="pc-screen-glow" x="31" y="25" width="28" height="18" rx="2" fill="currentColor" opacity="0"/>' +
      // 电脑底座
      '<rect x="38" y="46" width="14" height="3" fill="currentColor" opacity="0.3"/>' +
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
      '<line class="office-body" x1="15" y1="28" x2="15" y2="44" stroke="currentColor" stroke-width="2.5"/>' +
      '<line class="office-arm-l" x1="15" y1="32" x2="26" y2="38" stroke="currentColor" stroke-width="2"/>' +
      '<line class="office-arm-r" x1="15" y1="32" x2="26" y2="40" stroke="currentColor" stroke-width="2"/>' +
      // 坐姿腿（弯曲在桌下）
      '<line class="office-leg-l" x1="15" y1="44" x2="9" y2="50" stroke="currentColor" stroke-width="2.5"/>' +
      '<line class="office-leg-r" x1="15" y1="44" x2="22" y2="50" stroke="currentColor" stroke-width="2.5"/>' +
    '</svg>';

  /* 交接文件小纸片：追加到 .office-scene 内，由 .has-file 控制显隐。
   * 位置在坐姿小人右手前上方（右手臂前伸 -50° 时指尖 ~(28,29)，纸片左缘即落点）。 */
  const OFFICE_FILE_SVG =
    '<g class="office-file" aria-hidden="true">' +
      '<rect x="27" y="18" width="9" height="13" rx="1.5" fill="#e7eaf3" stroke="#8d97ad" stroke-width="1"/>' +
      '<line x1="29" y1="23" x2="34" y2="23" stroke="#8d97ad" stroke-width="1.2"/>' +
      '<line x1="29" y1="26" x2="34" y2="26" stroke="#8d97ad" stroke-width="1.2"/>' +
    '</g>';

  /* 卡片外壳：头部（任务描述，不显示长 ID）+ 状态区（动态）+ 办公场景 + 元信息 + 历史 */
  function cardShell(agent) {
    const type = typeof agent.type === 'string' && agent.type ? agent.type : 'Agent';
    // 名称显示：优先任务描述 name；为空时主 Agent 固定显示"主 Agent"，子 Agent 显示 type
    var name = typeof agent.name === 'string' && agent.name ? agent.name : (agent.id === 'main' ? '主 Agent' : type);
    name = truncate(name, 30);
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
        '</div>' +
        '<div class="history-block">' +
          '<div class="history-title">最近动作</div>' +
          '<div class="history-items"></div>' +
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

  /* ---------------- 历史轨迹 ---------------- */
  function updateHistory(rec, agent) {
    const arr = Array.isArray(agent.history) ? agent.history : [];
    const tail = arr.slice(-HISTORY_TAIL);
    const key = tail.map(function (t, i) { return i + ':' + t; }).join('|');
    if (rec.historyKey === key) return;
    rec.historyKey = key;

    if (!tail.length) {
      rec.historyItems.innerHTML = '<span class="history-none">— 暂无动作 —</span>';
      return;
    }

    rec.historyItems.innerHTML = tail.map(function (item) {
      const info = describeHistory(item);
      return '<span class="history-pill"><i class="' + info.kind + '"></i>' + escapeHtml(info.text) + '</span>';
    }).join('');
  }

  /* 把后端原始轨迹项翻译成人话 */
  function describeHistory(item) {
    const s = String(item);
    const m = s.match(/^tool:(.+)$/i);
    if (m) return { kind: 'k-tool', text: m[1].trim() || '工具' };
    if (s.toLowerCase() === 'thinking') return { kind: 'k-think', text: '思考' };
    if (s.toLowerCase() === 'asking') return { kind: 'k-other', text: '等待输入' };
    if (s.toLowerCase() === 'tool') return { kind: 'k-tool', text: '调用工具' };
    if (s.toLowerCase() === 'start') return { kind: 'k-start', text: '开始' };
    if (s.toLowerCase() === 'done' || s.toLowerCase() === 'end') return { kind: 'k-done', text: '结束' };
    // 服务端失败历史简记 push 的是 "error"（见 server/server.mjs），与 "failed" 一并翻译
    if (s.toLowerCase() === 'failed' || s.toLowerCase() === 'error') return { kind: 'k-other', text: '失败' };
    return { kind: 'k-other', text: s };
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