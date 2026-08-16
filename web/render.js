/* =========================================================================
 * Vibe Agent Dashboard — DOM 渲染模块
 * 职责：卡片创建/更新/移除、状态区构建、主渲染流程、工具函数
 * ========================================================================= */
'use strict';

(function () {
  var S = VC.S;
  var C = VC.C;
  var shared = VC.shared;
  var AN = VC.AN;
  var A = VC.A;

  /* ==================== 办公场景 SVG ==================== */

  var OFFICE_SVG =
    '<svg class="office-scene" viewBox="0 0 90 70" aria-hidden="true">' +
      '<rect x="8" y="48" width="74" height="5" rx="2" fill="currentColor" opacity="0.25"></rect>' +
      '<rect x="10" y="53" width="4" height="12" fill="currentColor" opacity="0.2"></rect>' +
      '<rect x="76" y="53" width="4" height="12" fill="currentColor" opacity="0.2"></rect>' +
      '<rect class="pc-screen" x="28" y="22" width="34" height="24" rx="3" fill="currentColor" opacity="0.15"></rect>' +
      '<rect class="pc-screen-glow" x="31" y="25" width="28" height="18" rx="2" fill="currentColor" opacity="0"></rect>' +
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
      '<rect x="38" y="46" width="14" height="3" fill="currentColor" opacity="0.3"></rect>' +
      '<text class="office-head office-head-active" x="15" y="28" text-anchor="middle" font-size="16">😎</text>' +
      '<text class="office-head office-head-sub" x="15" y="28" text-anchor="middle" font-size="16">🙄</text>' +
      '<text class="office-head office-head-idle" x="15" y="28" text-anchor="middle" font-size="16">😴</text>' +
      '<text class="office-head office-head-sad" x="15" y="28" text-anchor="middle" font-size="16">😟</text>' +
      '<text class="office-head office-head-happy" x="15" y="28" text-anchor="middle" font-size="16">😄</text>' +
      '<text class="office-head office-head-fail" x="15" y="28" text-anchor="middle" font-size="16">😢</text>' +
      '<line class="office-body" x1="15" y1="31" x2="15" y2="44" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="office-arm-l" x1="15" y1="33" x2="26" y2="39" stroke="currentColor" stroke-width="2"></line>' +
      '<line class="office-arm-r" x1="15" y1="33" x2="26" y2="41" stroke="currentColor" stroke-width="2"></line>' +
      '<line class="office-leg-l" x1="15" y1="44" x2="9" y2="50" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="office-leg-r" x1="15" y1="44" x2="22" y2="50" stroke="currentColor" stroke-width="2.5"></line>' +
    '</svg>';

  /* 完成状态勾号 SVG */
  var CHECK_SVG =
    '<svg class="check-svg" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 12.5 L10 18.5 L20 5.5" fill="none" stroke="currentColor" ' +
        'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />' +
    '</svg>';

  /* ==================== 工具函数（纯函数） ==================== */

  function normalizeStatus(s) {
    var v = String(s || '').toLowerCase();
    return VC.STATUS_META[v] ? v : 'unknown';
  }

  function priorityOf(agent) {
    return VC.ACTIVE_PRIORITY[normalizeStatus(agent.status)] !== undefined
      ? VC.ACTIVE_PRIORITY[normalizeStatus(agent.status)]
      : 5;
  }

  function toolNameFor(agent) {
    if (typeof agent.currentTool === 'string' && agent.currentTool.trim()) {
      return stripToolPrefix(agent.currentTool);
    }
    var h = Array.isArray(agent.history) ? agent.history : [];
    for (var i = h.length - 1; i >= 0; i--) {
      var m = String(h[i]).match(/^tool:(.+)$/i);
      if (m) return m[1].trim() || '工具';
    }
    return '调用工具';
  }

  function stripToolPrefix(value) {
    var m = String(value).match(/^tool:(.+)$/i);
    return m ? m[1].trim() : String(value);
  }

  function toolTypeOf(name) {
    var clean = stripToolPrefix(name).toLowerCase();
    for (var type in VC.TOOL_TYPE_MAP) {
      if (Object.prototype.hasOwnProperty.call(VC.TOOL_TYPE_MAP, type) &&
          VC.TOOL_TYPE_MAP[type].indexOf(clean) !== -1) return type;
    }
    return 'default';
  }

  function formatElapsed(startTime) {
    if (!startTime) return '已用 --:--';
    var start = new Date(startTime).getTime();
    if (isNaN(start)) return '已用 --:--';
    var sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var ss = sec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0
      ? '已用 ' + h + ':' + pad(m) + ':' + pad(ss)
      : '已用 ' + m + ':' + pad(ss);
  }

  function fmtNum(v) {
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function truncate(str, max) {
    var s = String(str);
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  function displayName(a) {
    if (!a) return 'Agent';
    if (a.id === 'main') return '主 Agent';
    var name = typeof a.name === 'string' && a.name ? a.name
      : (typeof a.type === 'string' && a.type ? a.type : 'Agent');
    return truncate(name, 30);
  }

  function effectiveStatus(agent) {
    if (agent.id === 'main' && agent.lastSeen) {
      var idleMs = Date.now() - new Date(agent.lastSeen).getTime();
      var busyWaiting = S.hasSubAgents &&
        (agent.status === 'thinking' || agent.status === 'tool');
      if (idleMs > C.IDLE_TIMEOUT && agent.status !== 'done' && agent.status !== 'failed' && !busyWaiting) {
        return 'idle';
      }
    }
    return normalizeStatus(agent.status);
  }

  /* 提取"最近调用的工具" */
  function extractRecentTools(history) {
    var arr = Array.isArray(history) ? history : [];
    var tools = [];
    for (var i = arr.length - 1; i >= 0 && tools.length < C.TOOL_TAIL; i--) {
      var m = String(arr[i]).match(/^tool:(.+)$/i);
      if (m) tools.unshift(m[1].trim() || '工具');
    }
    return tools;
  }

  /* ==================== 空状态 ==================== */

  function setEmptyVisible(show) {
    S.els.emptyState.classList.toggle('hidden', !show);
    S.els.boardWrap.classList.toggle('hidden', show);
  }

  function clearAllCards() {
    [S.mainCards, S.activeCards].forEach(function (cache) {
      Object.keys(cache).forEach(function (id) {
        var rec = cache[id];
        if (rec && rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      });
    });
    S.mainCards = {};
    S.activeCards = {};
  }

  /* ==================== lastSeen 快照与超时回收 ==================== */

  function updateLastSeenMap(agents) {
    agents.forEach(function (a) {
      var t = Date.parse(a.lastSeen);
      S.lastSeenMap.set(a.id, isNaN(t) ? Date.now() : t);
    });
  }

  function detectTimeoutRecycled(agents) {
    try {
      var now = Date.now();
      var currentIds = new Set(agents.map(function (a) { return a.id; }));
      S.lastSeenMap.forEach(function (ts, id) {
        if (id === 'main') return;
        if (currentIds.has(id)) return;
        var prev = S.prevAgentMap.get(id);
        if (prev === 'done' || prev === 'failed') {
          S.lastSeenMap.delete(id);
          return;
        }
        if (!ts || !isFinite(ts) || now - ts <= C.STALE_FRONT_MS) return;
        var el = AN.getCardElById(id);
        if (el && el.isConnected &&
            !el.classList.contains('is-leaving') &&
            !el.classList.contains('removing')) {
          el.classList.add('timeout-leaving');
          if (S.activeCards[id]) delete S.activeCards[id];
          window.setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
          }, shared.TIMEOUT_LEAVE_MS);
        }
        S.lastSeenMap.delete(id);
      });
    } catch (err) {
      /* 兜底：异常不阻断轮询 */
    }
  }

  /* ==================== 卡片渲染 ==================== */

  function renderMain(mainActive) {
    renderActive(mainActive, S.mainCards, S.els.mainGrid);
  }

  function renderActive(list, cache, grid, statusMap) {
    var seen = new Set(list.map(function (a) { return a.id; }));

    Object.keys(cache).forEach(function (id) {
      var rec = cache[id];
      if (seen.has(id) || !rec || rec.leavingTimer) return;
      var prev = S.prevAgentMap.get(id);
      var now = statusMap ? statusMap.get(id) : null;
      if (prev && prev !== 'done' && prev !== 'failed' && cache === S.activeCards) {
        if (now === 'done' || now === 'failed') return;
        leaveCard(id);
        return;
      }
      removeActiveCard(id, cache);
    });

    list.forEach(function (agent) { upsertCard(agent, cache, grid); });
  }

  function upsertCard(agent, cache, grid) {
    var rec = cache[agent.id];
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

  function removeActiveCard(id, cache) {
    var rec = cache[id];
    if (!rec) return;
    delete cache[id];
    rec.el.classList.add('removing');
    window.setTimeout(function () {
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }, shared.REMOVE_ANIM_MS);
  }

  function leaveCard(id, waveDelay, isDone) {
    var rec = S.activeCards[id];
    if (!rec || rec.leavingTimer) return;
    var delay = waveDelay || 0;
    rec.el.classList.add('celebrating');
    if (isDone) rec.el.classList.add('leaving-done');
    rec.leavingTimer = window.setTimeout(function () {
      rec.el.classList.remove('celebrating');
      rec.el.classList.add('is-leaving');
    }, delay);
    window.setTimeout(function () {
      if (S.activeCards[id] === rec) delete S.activeCards[id];
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }, shared.LEAVE_TOTAL_MS + delay);
  }

  /* ==================== 创建 / 更新单张卡片 ==================== */

  function createCard(agent, grid) {
    var el = document.createElement('article');
    el.className = 'agent-card enter';
    el.innerHTML = cardShell(agent);
    if (agent.id === 'main') el.classList.add('is-main');
    el.dataset.id = agent.id;
    grid.appendChild(el);

    var rec = {
      el: el,
      status: null,
      toolType: null,
      elapsedText: '',
      toolsText: '',
      toolsKey: null,
      flashTimer: 0,
      statusArea: el.querySelector('.status-area'),
      elapsedEl: el.querySelector('.elapsed-num'),
      toolsEl: el.querySelector('.tools-num'),
      toolItems: el.querySelector('.tool-items'),
      stopZone: el.querySelector('.stop-zone'),
      stopState: 'none',
      stopSent: false,
      agent: agent
    };

    window.setTimeout(function () { el.classList.remove('enter'); }, shared.ENTER_ANIM_MS);
    return rec;
  }

  function updateCard(rec, agent) {
    var status = effectiveStatus(agent);
    var el = rec.el;
    rec.agent = agent;

    if (rec.status !== status) {
      if (rec.status) el.classList.remove('status-' + rec.status);
      el.classList.add('status-' + status);
      rec.status = status;
      rec.statusArea.innerHTML = buildStatusArea(agent);
      flashCard(rec);
    }

    var toolType = status === 'tool' ? toolTypeOf(toolNameFor(agent)) : '';
    if (rec.toolType !== toolType) {
      if (rec.toolType) el.classList.remove('tool-type-' + rec.toolType);
      rec.toolType = toolType;
      if (toolType) el.classList.add('tool-type-' + toolType);
    }

    var elapsedText = formatElapsed(agent.startTime);
    if (rec.elapsedText !== elapsedText) {
      rec.elapsedText = elapsedText;
      rec.elapsedEl.textContent = elapsedText;
    }

    var toolsText = '工具调用 ' + fmtNum(agent.toolCount) + ' 次';
    if (rec.toolsText !== toolsText) {
      rec.toolsText = toolsText;
      rec.toolsEl.textContent = toolsText;
    }

    var toolsKey = extractRecentTools(agent.history).join('|');
    if (rec.toolsKey !== toolsKey) {
      rec.toolsKey = toolsKey;
      var tools = toolsKey ? toolsKey.split('|') : [];
      rec.toolItems.innerHTML = tools.length
        ? tools.map(function (t) {
            return '<span class="tool-chip">' + escapeHtml(t) + '</span>';
          }).join('')
        : '<span class="tool-none">— 暂无工具 —</span>';
    }

    updateStopZone(rec, agent);
  }

  /* ==================== 停止按钮 ==================== */

  function updateStopZone(rec, agent) {
    var zone = rec.stopZone;
    if (!zone) return;
    var agentObj = agent || rec.agent;
    var requested = !!(agentObj && agentObj.stopRequested) || rec.stopSent;
    var state;
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
    rec.el.classList.toggle('status-stopped', requested);
  }

  function canStopAgent(agent) {
    if (!agent || agent.id === 'main') return false;
    var st = normalizeStatus(agent.status);
    return st === 'queued' || st === 'thinking' || st === 'tool' || st === 'asking';
  }

  /* ==================== 状态区构建 ==================== */

  function cardShell(agent) {
    var type = typeof agent.type === 'string' && agent.type ? agent.type : 'Agent';
    var name = truncate(agent.id === 'main' ? '主 Agent' : (typeof agent.name === 'string' && agent.name ? agent.name : type), 30);
    var badge = agent.id === 'main' ? '主' : type;
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

  function buildStatusArea(agent) {
    var status = effectiveStatus(agent);
    var meta = VC.STATUS_META[status];
    var extra = '';
    var bar = '';

    if (status === 'queued') {
      extra = '<span class="ask-ring" aria-hidden="true"></span>';
    } else if (status === 'thinking') {
      extra = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    } else if (status === 'tool') {
      extra = '<span class="tool-pill">' + escapeHtml(toolNameFor(agent)) +
        '</span><span class="spinner" aria-hidden="true"></span>';
      bar = '<div class="progress" aria-hidden="true"></div>';
    } else if (status === 'asking') {
      extra = '<span class="ask-ring" aria-hidden="true"></span>';
    } else if (status === 'done') {
      extra = CHECK_SVG;
    } else if (status === 'failed') {
      extra = '<span class="failed-x" aria-hidden="true">✕</span>';
    }

    return '<div class="status-line">' +
      '<span class="status-emoji">' + meta.emoji + '</span>' +
      '<span class="status-label">' + meta.label + '</span>' +
      '<span class="status-extra">' + extra + '</span>' +
    '</div>' + bar;
  }

  function flashCard(rec) {
    if (rec.el.classList.contains('enter')) return;
    if (rec.flashTimer) window.clearTimeout(rec.flashTimer);
    var el = rec.el;
    el.classList.remove('status-flash');
    void el.offsetWidth;
    el.classList.add('status-flash');
    rec.flashTimer = window.setTimeout(function () {
      el.classList.remove('status-flash');
    }, 760);
  }

  /* ==================== 主渲染流程 ==================== */

  function render(data) {
    var agents = Array.isArray(data.agents) ? data.agents : [];
    renderFooter(data.updatedAt);

    updateLastSeenMap(agents);

    if (!agents.length) {
      setEmptyVisible(true);
      clearAllCards();
      S.prevAgentMap = new Map();
      return;
    }
    setEmptyVisible(false);

    var mainList = agents.filter(function (a) { return a.id === 'main'; });
    var subList = agents.filter(function (a) { return a.id !== 'main'; });

    S.hasSubAgents = subList.length > 0;

    var mainActive = mainList;
    var subActive = subList.filter(function (a) {
      return !VC.FOLDED_STATUS[normalizeStatus(a.status)];
    }).sort(function (a, b) {
      return priorityOf(a) - priorityOf(b);
    });

    var nowStatus = new Map(agents.map(function (a) {
      return [a.id, normalizeStatus(a.status)];
    }));

    detectTimeoutRecycled(agents);

    renderMain(mainActive);
    renderActive(subActive, S.activeCards, S.els.activeGrid, nowStatus);

    /* 火柴人任务动画：放在渲染之后检测 */
    animateAgentChanges(agents, nowStatus);
  }

  /* ==================== 火柴人任务动画协调 ==================== */

  function animateAgentChanges(agents, nowMap) {
    if (!nowMap) {
      nowMap = new Map(agents.map(function (a) {
        return [a.id, normalizeStatus(a.status)];
      }));
    }

    if (!S.stickmanSeeded) {
      S.stickmanSeeded = true;
      S.prevAgentMap = nowMap;
      S.lastMainAgentCallCount = AN.mainAgentCallCount(agents);
      return;
    }

    /* 首帧即终态的新子 Agent */
    agents.forEach(function (a) {
      if (a.id === 'main' || S.prevAgentMap.has(a.id)) return;
      var st = nowMap.get(a.id);
      if (st !== 'done' && st !== 'failed') return;
      if (S.activeCards[a.id]) return;
      var isDone = st === 'done';
      var rec = upsertCard(a, S.activeCards, S.els.activeGrid);
      if (!isDone) AN.markCardFailed(rec.el);
      if (isDone) {
        A.playChime('done');
        A.announce('子 Agent ' + displayName(a) + ' 完成');
      } else {
        A.announce('子 Agent ' + displayName(a) + ' 失败');
      }
      leaveCard(a.id, 0, isDone);
    });

    /* 新子 Agent 出现（非终态） → 火柴人从主 Agent 跑过去 */
    var toSubThisRound = new Set();
    agents.forEach(function (a) {
      if (a.id !== 'main' && !S.prevAgentMap.has(a.id)) {
        var st = nowMap.get(a.id);
        if (st === 'done' || st === 'failed') return;
        toSubThisRound.add(a.id);
        AN.runStickman('toSub', a);
        AN.showNewTaskTag(a.id);
        AN.assignTaskFace(AN.getCardElById(a.id), nowMap);
        A.announce('子 Agent ' + displayName(a) + ' 开始');
      }
    });

    /* 主 Agent 补充/再次派发任务 */
    if (AN.mainAgentCallCount(agents) > S.lastMainAgentCallCount) {
      var target = null;
      agents.forEach(function (a) {
        if (a.id === 'main' || toSubThisRound.has(a.id)) return;
        var targetNow = nowMap.get(a.id);
        if (targetNow === 'done' || targetNow === 'failed') return;
        if (!target || (a.lastSeen || '') > (target.lastSeen || '')) target = a;
      });
      if (target) {
        AN.runStickman('toSub', target);
        AN.showNewTaskTag(target.id);
        AN.assignTaskFace(AN.getCardElById(target.id), nowMap);
      }
    }
    S.lastMainAgentCallCount = AN.mainAgentCallCount(agents);

    /* 子 Agent 完成/失败 → 火柴人跑回主 Agent 汇报 + 卡片挥手拜拜 */
    agents.forEach(function (a) {
      if (a.id === 'main') return;
      var prev = S.prevAgentMap.get(a.id);
      var now = nowMap.get(a.id);
      if (prev && prev !== 'done' && prev !== 'failed' &&
          (now === 'done' || now === 'failed')) {
        var isDone = now === 'done';
        var isReduced = A.isMotionReduced();
        var cardEl = AN.getCardElById(a.id);
        AN.setOfficeFile(cardEl, true);
        if (!isDone) AN.markCardFailed(cardEl);
        if (isDone) {
          A.playChime('done');
          A.announce('子 Agent ' + displayName(a) + ' 完成');
        } else {
          A.announce('子 Agent ' + displayName(a) + ' 失败');
        }
        if (isDone && !isReduced) AN.celebrateCard(a.id);
        if (isDone) AN.popCard(cardEl);
        if (!S.inFlightToSub.has(a.id)) {
          AN.runStickman('backToMain', a, !isDone);
        }
        leaveCard(a.id, isDone && !isReduced ? shared.CELEBRATE_MS + shared.STICKMAN_TRAVEL_MS : 0, isDone);
      }
    });

    S.prevAgentMap = nowMap;
  }

  /* ==================== 页脚 ==================== */

  function renderFooter(updatedAt) {
    if (!updatedAt) {
      S.els.updatedAt.textContent = '—';
      return;
    }
    var d = new Date(updatedAt);
    if (isNaN(d.getTime())) {
      S.els.updatedAt.textContent = '—';
      return;
    }
    S.els.updatedAt.textContent = '更新时间 ' + d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  /* ==================== 挂载到命名空间 ==================== */
  VC.util.normalizeStatus = normalizeStatus;
  VC.util.priorityOf = priorityOf;
  VC.util.toolNameFor = toolNameFor;
  VC.util.stripToolPrefix = stripToolPrefix;
  VC.util.toolTypeOf = toolTypeOf;
  VC.util.formatElapsed = formatElapsed;
  VC.util.fmtNum = fmtNum;
  VC.util.escapeHtml = escapeHtml;
  VC.util.truncate = truncate;
  VC.util.displayName = displayName;
  VC.util.effectiveStatus = effectiveStatus;
  VC.util.extractRecentTools = extractRecentTools;
  VC.util.canStopAgent = canStopAgent;

  VC.R.render = render;
  VC.R.renderFooter = renderFooter;
  VC.R.setEmptyVisible = setEmptyVisible;
  VC.R.clearAllCards = clearAllCards;
  VC.R.renderMain = renderMain;
  VC.R.renderActive = renderActive;
  VC.R.upsertCard = upsertCard;
  VC.R.removeActiveCard = removeActiveCard;
  VC.R.leaveCard = leaveCard;
  VC.R.createCard = createCard;
  VC.R.updateCard = updateCard;
  VC.R.updateStopZone = updateStopZone;
  VC.R.cardShell = cardShell;
  VC.R.buildStatusArea = buildStatusArea;
  VC.R.flashCard = flashCard;
  VC.R.animateAgentChanges = animateAgentChanges;
  VC.R.OFFICE_SVG = OFFICE_SVG;
  VC.R.CHECK_SVG = CHECK_SVG;
})();
