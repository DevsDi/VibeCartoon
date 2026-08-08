/* =========================================================================
 * Vibe Agent Dashboard — 前端逻辑
 * 原生 JS，无框架、无依赖、不连外网。
 * 职责：每 600ms 轮询 /api/state，
 *       增量刷新 Agent 卡片（保证动画不因重绘重置），
 *       处理完成/失败折叠、断连横幅与空状态占位。
 * ========================================================================= */
'use strict';

(function () {
  /* ---------------- 配置 ---------------- */
  const POLL_INTERVAL = 600;          // 轮询间隔（毫秒）
  const FETCH_TIMEOUT = 2500;         // 单次请求超时（毫秒），防止轮询堆积
  const HISTORY_TAIL = 6;             // history 轨迹最多显示的条数

  /* 状态 → 展示元信息 */
  const STATUS_META = {
    queued:   { emoji: '⏳', label: '排队中' },
    thinking: { emoji: '🔍', label: '思考中' },
    tool:     { emoji: '🛠️', label: '调用工具中' },
    asking:   { emoji: '💬', label: '等待输入' },
    done:     { emoji: '✅', label: '已完成' },
    failed:   { emoji: '❌', label: '失败' },
    running:  { emoji: '🚀', label: '执行中' },
    unknown:  { emoji: '🌀', label: '未知状态' }
  };

  /* 折叠到“底部紧凑列表”的状态 */
  const FOLDED_STATUS = { done: true, failed: true };

  /* 活动卡片网格内的排序优先级：越靠前越优先 */
  const ACTIVE_PRIORITY = { asking: 0, tool: 1, thinking: 2, queued: 3, running: 4, unknown: 5 };

  /* ---------------- 内部状态 ---------------- */
  let els = {};                 // 缓存的 DOM 引用
  let activeCards = {};         // 子 Agent: id -> { el, status, elapsedText, toolsText, historyKey, flashTimer }
  let mainCards = {};           // 主 Agent: 同上（渲染到 main-grid 全宽大卡片）
  let finishedSignature = '';   // 折叠区渲染签名，内容没变就不重建（避免动画重启）
  let finishedOpen = true;      // 折叠区默认展开
  let polling = false;          // 轮询互斥锁

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // 收集 DOM
    els.mainGrid = document.getElementById('main-grid');
    els.mainWrap = document.getElementById('main-wrap');
    els.activeGrid = document.getElementById('active-grid');
    els.activeWrap = document.getElementById('active-wrap');
    els.emptyState = document.getElementById('empty-state');
    els.noActiveNote = document.getElementById('no-active-note');
    els.finishedSection = document.getElementById('finished-section');
    els.finishedHead = document.getElementById('finished-head');
    els.finishedCount = document.getElementById('finished-count');
    els.finishedList = document.getElementById('finished-list');
    els.connBanner = document.getElementById('conn-banner');
    els.updatedAt = document.getElementById('updated-at');
    els.summary = {};
    ['total', 'active', 'queued', 'thinking', 'tool', 'done', 'failed'].forEach(function (k) {
      els.summary[k] = document.getElementById('sum-' + k);
    });

    // 折叠区交互（按钮语义）
    els.finishedHead.addEventListener('click', toggleFinished);
    els.finishedHead.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleFinished();
      }
    });

    // 初始空状态
    setEmptyVisible(true);
    els.finishedSection.classList.add('hidden');
    // 折叠区默认展开（紧凑行 + 勾号/抖动动画可见）
    els.finishedSection.classList.add('open');
    els.finishedList.classList.remove('hidden');

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
    renderSummary(data.summary || {});
    renderFooter(data.updatedAt);

    // 无任何 Agent：展示空状态占位
    if (!agents.length) {
      setEmptyVisible(true);
      renderFinished([]);
      return;
    }
    setEmptyVisible(false);

    // 拆分：主 Agent（id=main）与子 Agent
    const mainAgents = agents.filter(function (a) { return a.id === 'main'; });
    const subAgents = agents.filter(function (a) { return a.id !== 'main'; });

    // 主 Agent 独立网格（顶部全宽）
    renderMain(mainAgents);

    // 子 Agent 活动卡片（进行中，未折叠）
    const active = subAgents.filter(function (a) {
      return !FOLDED_STATUS[normalizeStatus(a.status)];
    }).sort(function (a, b) {
      return priorityOf(a) - priorityOf(b);
    });

    // 完成/失败折叠区：主 Agent 与子 Agent 都进入（不破坏原有折叠逻辑）
    const finished = agents.filter(function (a) {
      return FOLDED_STATUS[normalizeStatus(a.status)];
    });

    renderActive(active);
    renderFinished(finished);
  }

  /* ---------------- 空状态 ---------------- */
  function setEmptyVisible(show) {
    els.emptyState.classList.toggle('hidden', !show);
    els.mainWrap.classList.toggle('hidden', show);
    els.activeWrap.classList.toggle('hidden', show);
  }

  /* ---------------- 主 Agent 卡片（顶部全宽网格） ---------------- */
  /* 渲染主 Agent（id=main）到 main-grid，复用 createCard/upsertCard/removeActiveCard。
   * 主 Agent 变为 done/failed 时进入折叠区（renderFinished），此处负责隐藏与清理。 */
  function renderMain(mainList) {
    const list = Array.isArray(mainList) ? mainList : [];

    // 无主 Agent：隐藏整个网格，并清空残留卡片（避免隐藏期间遗留旧 DOM）
    if (!list.length) {
      els.mainWrap.classList.add('hidden');
      Object.keys(mainCards).forEach(function (id) { removeActiveCard(id, mainCards); });
      return;
    }
    els.mainWrap.classList.remove('hidden');

    const seen = new Set(list.map(function (a) { return a.id; }));

    // 清理已不在主列表中的旧卡片（例如状态变为 done/failed 被折叠走）
    Object.keys(mainCards).forEach(function (id) {
      if (!seen.has(id)) removeActiveCard(id, mainCards);
    });

    // 更新或新建
    list.forEach(function (agent) { upsertCard(agent, mainCards, els.mainGrid); });
  }

  /* ---------------- 活动卡片网格 ---------------- */
  function renderActive(active) {
    const seen = new Set(active.map(function (a) { return a.id; }));

    // 清理已不在活动集合中的卡片（例如状态变为 done/failed 被折叠走）
    Object.keys(activeCards).forEach(function (id) {
      if (!seen.has(id)) removeActiveCard(id);
    });

    // 提示文案
    els.noActiveNote.classList.toggle('hidden', active.length > 0);

    // 更新或新建
    active.forEach(function (agent) { upsertCard(agent); });
  }

  /* 创建卡片：grid 指定目标网格（主 Agent 用 mainGrid），缺省挂到 activeGrid */
  function upsertCard(agent, cache, grid) {
    const map = cache || activeCards;
    let rec = map[agent.id];
    if (!rec) {
      rec = createCard(agent, grid);
      map[agent.id] = rec;
    }
    updateCard(rec, agent);
  }

  /* 移除卡片：cache 指定所属缓存（主 Agent 用 mainCards），缺省为 activeCards */
  function removeActiveCard(id, cache) {
    const map = cache || activeCards;
    const rec = map[id];
    if (!rec) return;
    delete map[id];
    rec.el.classList.add('removing');
    window.setTimeout(function () {
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }, 420);
  }

  /* ---------- 创建 / 更新单张卡片 ---------- */
  /* grid：目标网格元素，缺省挂到 activeGrid（主 Agent 卡片传入 mainGrid） */
  function createCard(agent, grid) {
    const el = document.createElement('article');
    el.className = 'agent-card enter';
    el.innerHTML = cardShell(agent);
    (grid || els.activeGrid).appendChild(el);

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

  function updateCard(rec, agent) {
    const status = normalizeStatus(agent.status);
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

  /* 卡片外壳：头部 + 状态区（动态）+ 元信息 + 历史 */
  function cardShell(agent) {
    const type = typeof agent.type === 'string' ? agent.type : 'Agent';
    var name = typeof agent.name === 'string' && agent.name ? agent.name : type;
    name = truncate(name, 30);
    return '' +
      '<div class="card-wrap">' +
        '<span class="accent" aria-hidden="true"></span>' +
        '<div class="card-head">' +
          '<span class="agent-id">' + escapeHtml(agent.id) + '</span>' +
          '<span class="type-badge">' + escapeHtml(name) + '</span>' +
        '</div>' +
        '<div class="status-area"></div>' +
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

  /* 依据状态构建状态区（此处是各状态动画的“家”） */
  function buildStatusArea(agent) {
    const status = normalizeStatus(agent.status);
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
    if (s.toLowerCase() === 'failed') return { kind: 'k-other', text: '失败' };
    return { kind: 'k-other', text: s };
  }

  /* ---------------- 完成 / 失败折叠区 ---------------- */
  function renderFinished(finished) {
    if (!finished.length) {
      els.finishedSection.classList.add('hidden');
      return;
    }
    els.finishedSection.classList.remove('hidden');

    const sorted = finished.slice().sort(function (a, b) {
      // 失败的排前面，更醒目
      const pa = normalizeStatus(a.status) === 'failed' ? 0 : 1;
      const pb = normalizeStatus(b.status) === 'failed' ? 0 : 1;
      return pa - pb;
    });

    els.finishedCount.textContent = String(sorted.length);

    const sig = sorted.map(function (a) {
      return a.id + '#' + normalizeStatus(a.status);
    }).join(',');

    if (sig !== finishedSignature) {
      finishedSignature = sig;
      els.finishedList.innerHTML = sorted.map(finishedRow).join('');
    }
  }

  function finishedRow(agent) {
    const status = normalizeStatus(agent.status);
    const meta = STATUS_META[status];
    const dot = '<span class="fin-dot" aria-hidden="true"></span>';
    const id = '<span class="fin-id">' + escapeHtml(agent.id) + '</span>';
    var name = typeof agent.name === 'string' && agent.name ? agent.name : meta.label;
    name = truncate(name, 30);
    const label = '<span class="fin-em">' + meta.emoji + '</span><span>' + escapeHtml(name) + '</span>';

    let prefix = '';
    if (status === 'done') {
      prefix = CHECK_SVG;      // 完成：绿色勾号 svg（绘制动画）
    } else if (status === 'failed') {
      prefix = '<span class="failed-x" aria-hidden="true">✕</span>';
    }

    return '<div class="finished-item is-' + status + ' chime-in">' +
      dot + prefix + id + label +
    '</div>';
  }

  /* ---------------- summary 与页脚 ---------------- */
  function renderSummary(s) {
    setSum('total', s.total);
    setSum('active', s.active);
    setSum('queued', s.queued);
    setSum('thinking', s.thinking);
    setSum('tool', s.tool);
    setSum('done', s.done);
    setSum('failed', s.failed);
  }

  function setSum(key, value) {
    const node = els.summary[key];
    if (node) node.textContent = fmtNum(value);
  }

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

  /* ---------------- 折叠区开关 ---------------- */
  function toggleFinished() {
    finishedOpen = !finishedOpen;
    els.finishedSection.classList.toggle('open', finishedOpen);
    els.finishedList.classList.toggle('hidden', !finishedOpen);
    els.finishedHead.setAttribute('aria-expanded', String(finishedOpen));
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