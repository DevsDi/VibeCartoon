/* =========================================================================
 * Vibe Agent Dashboard — 动画模块
 * 职责：火柴人跑动动画、庆祝粒子、尘土效果、卡片动画反馈、办公场景文件交接
 * ========================================================================= */
'use strict';

(function () {
  var S = VC.S;
  var C = VC.C;
  var shared = VC.shared;
  var util = VC.util;
  var A = VC.A;

  /* 火柴人 SVG（内联字符串） */
  var STICKMAN_SVG =
    '<svg class="stickman" viewBox="0 0 30 40" aria-hidden="true">' +
      '<text class="stick-head stick-head-run" x="15" y="12" text-anchor="middle" font-size="11">😎</text>' +
      '<text class="stick-head stick-head-report" x="15" y="12" text-anchor="middle" font-size="11">😄</text>' +
      '<text class="stick-head stick-head-fail" x="15" y="12" text-anchor="middle" font-size="11">😢</text>' +
      '<line x1="15" y1="14" x2="15" y2="26" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="arm-left" x1="15" y1="18" x2="6" y2="13" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="arm-right" x1="15" y1="18" x2="24" y2="13" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="leg-left" x1="15" y1="26" x2="7" y2="36" stroke="currentColor" stroke-width="2.5"></line>' +
      '<line class="leg-right" x1="15" y1="26" x2="23" y2="36" stroke="currentColor" stroke-width="2.5"></line>' +
      '<rect class="doc" x="22" y="4" width="6" height="9" rx="1" fill="#e7eaf3" opacity="0"></rect>' +
      '<line class="doc-line" x1="24" y1="7" x2="26" y2="7" stroke="#8d97ad" stroke-width="1" opacity="0"></line>' +
      '<line class="doc-line" x1="24" y1="9" x2="26" y2="9" stroke="#8d97ad" stroke-width="1" opacity="0"></line>' +
      '<circle class="report-mark" cx="25" cy="6" r="3.4" fill="#22c55e" opacity="0"></circle>' +
    '</svg>';

  /* 交接文件小纸片 */
  var OFFICE_FILE_SVG =
    '<g class="office-file" aria-hidden="true">' +
      '<rect x="27" y="18" width="9" height="13" rx="1.5" fill="#e7eaf3" stroke="#8d97ad" stroke-width="1"></rect>' +
      '<line x1="29" y1="23" x2="34" y2="23" stroke="#8d97ad" stroke-width="1.2"></line>' +
      '<line x1="29" y1="26" x2="34" y2="26" stroke="#8d97ad" stroke-width="1.2"></line>' +
    '</g>';

  /* main 卡片不存在时的起点/终点占位 */
  var FALLBACK_MAIN_RECT = { left: 0, top: 56, right: 8, height: 40 };

  /* 庆祝粒子 emoji */
  var CELEBRATE_EMOJI = ['🎉', '✨', '⭐', '🎊', '💫'];

  /* ==================== 缓动函数 ==================== */

  function easeInOut(p) {
    return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  }

  function easeIn(p) {
    return p * p;
  }

  function easeOut(p) {
    return 1 - Math.pow(1 - p, 2);
  }

  /* ==================== 火柴人路径与驱动 ==================== */

  /* 火柴人三段式路径：起步加速 → 巡航 → 到站减速 */
  function buildRunPath(from, to, totalMs) {
    var d10 = totalMs * 0.10;
    var d80 = totalMs * 0.80;
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

  /* 火柴人位置驱动：16ms 定时器逐帧插值 */
  function driveStickman(stick, path, totalMs, onDone, dynamicTarget) {
    var t0 = performance.now();
    var t0ScrollY = window.scrollY;
    var scrollDelta = function () {
      return t0ScrollY - window.scrollY;
    };
    var rafId = null;
    var removeTimer = null;
    var fallbackTimer = null;
    var cancel = function () {
      if (removeTimer) { window.clearTimeout(removeTimer); removeTimer = null; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (fallbackTimer) { window.clearInterval(fallbackTimer); fallbackTimer = null; }
    };
    var envelope = function (t) {
      var startEnd = C.STICKMAN_BOUNCE_RAMP.start * totalMs;
      var endStart = totalMs * (1 - C.STICKMAN_BOUNCE_RAMP.end);
      var sm = function (u) { return u * u * (3 - 2 * u); };
      if (startEnd > 0 && t < startEnd) return sm(t / startEnd);
      if (totalMs - endStart > 0 && t > endStart) return sm((totalMs - t) / (totalMs - endStart));
      return 1;
    };
    var step = function (now) {
      var t = Math.min(now - t0, totalMs);
      if (dynamicTarget) {
        var targetRect = dynamicTarget.getBoundingClientRect();
        if (targetRect && (targetRect.width > 0 || targetRect.height > 0)) {
          var liveEndX = targetRect.right - 20;
          var liveEndY = targetRect.top + targetRect.height / 2;
          path[path.length - 1].x = liveEndX;
          path[path.length - 1].y = liveEndY;
          if (path.length >= 3) {
            path[path.length - 2].x = path[0].x + (liveEndX - path[0].x) * 0.90;
            path[path.length - 2].y = path[0].y + (liveEndY - path[0].y) * 0.90;
          }
        }
      }
      var acc = 0;
      var seg = -1;
      for (var i = 0; i + 1 < path.length; i++) {
        if (t <= acc + path[i + 1].dur) { seg = i; break; }
        acc += path[i + 1].dur;
      }
      if (seg === -1) {
        var last = path[path.length - 1];
        stick.style.left = last.x + 'px';
        stick.style.top = (last.y + scrollDelta()) + 'px';
        return;
      }
      var from = path[seg];
      var to = path[seg + 1];
      var p = to.dur > 0 ? (to.ease || easeInOut)(Math.max(0, Math.min(1, (t - acc) / to.dur))) : 1;
      var baseTop = from.y + (to.y - from.y) * p + scrollDelta();
      var bounce = -Math.abs(Math.sin(t / C.STICKMAN_BOUNCE_MS * Math.PI * 2)) * C.STICKMAN_BOUNCE_AMP * envelope(t);
      stick.style.left = (from.x + (to.x - from.x) * p) + 'px';
      stick.style.top = (baseTop + bounce) + 'px';
      if (t < totalMs) {
        rafId = requestAnimationFrame(step);
      }
    };
    removeTimer = window.setTimeout(function () {
      cancel();
      if (stick.parentNode) stick.parentNode.removeChild(stick);
      if (typeof onDone === 'function') onDone();
    }, totalMs + 100);
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(step);
    } else {
      fallbackTimer = window.setInterval(function () {
        step(performance.now());
      }, 16);
      window.setTimeout(function () { if (fallbackTimer) window.clearInterval(fallbackTimer); }, totalMs + 100);
      step(performance.now());
    }
  }

  /* ==================== 火柴人主函数 ==================== */

  /* direction: 'toSub'（主 → 子）| 'backToMain'（子 → 主） */
  function runStickman(direction, agent, isFailed) {
    var layer = S.els.animLayer;
    if (!layer || !agent || agent.id === 'main') return;
    if (A.isMotionReduced()) return;

    if (direction === 'toSub') {
      S.stickmanQueue.push(agent.id);
      S.inFlightToSub.add(agent.id);
      if (!S.stickmanBusy) runQueuedToSub();
      return;
    }

    /* 汇报（backToMain）：直接执行不排队 */
    var fromEl = getCardElById(agent.id);
    var toEl = getCardElById('main');

    if (!fromEl) return;
    var fromRect = fromEl.getBoundingClientRect();
    var toRect = toEl ? toEl.getBoundingClientRect() : FALLBACK_MAIN_RECT;

    var stick = document.createElement('div');
    stick.className = 'stickman-runner flip with-doc' + (isFailed ? ' failed' : ' report');
    stick.innerHTML = STICKMAN_SVG;
    stick.style.transition = 'none';
    layer.appendChild(stick);

    var startX = fromRect.left + 20;
    var startY = fromRect.top + fromRect.height / 2;
    var endX = toRect.right - 20;
    var endY = toRect.top + toRect.height / 2;
    var totalMs = shared.STICKMAN_TRAVEL_MS;

    driveStickman(stick, buildRunPath({ x: startX, y: startY }, { x: endX, y: endY }, totalMs), totalMs, undefined, toEl);
    spawnStickDust(stick, totalMs);
    window.setTimeout(function () { mainReceiveFile(!isFailed); }, totalMs);
  }

  /* 派发火柴人串行执行器 */
  function runQueuedToSub() {
    S.stickmanBusy = true;
    if (S.stickmanQueue.length > 20) {
      S.stickmanQueue.length = 0;
      S.inFlightToSub.clear();
    }
    var id;
    while (S.stickmanQueue.length > 0) {
      id = S.stickmanQueue.shift();
      if (launchToSubStickman(id)) return;
      S.inFlightToSub.delete(id);
      if (S.stickmanQueue.indexOf(id) !== -1) S.inFlightToSub.add(id);
    }
    S.stickmanBusy = false;
  }

  /* 创建单个"派发"火柴人 */
  function launchToSubStickman(id) {
    var layer = S.els.animLayer;
    var fromEl = getCardElById('main');
    var toEl = getCardElById(id);
    if (!toEl) return false;
    var launched = false;
    try {
      var fromRect = fromEl ? fromEl.getBoundingClientRect() : FALLBACK_MAIN_RECT;
      var toRect = toEl.getBoundingClientRect();

      var stick = document.createElement('div');
      stick.className = 'stickman-runner with-doc';
      stick.innerHTML = STICKMAN_SVG;
      stick.style.transition = 'none';
      layer.appendChild(stick);

      var startX = fromRect.right - 20;
      var startY = fromRect.top + fromRect.height / 2;
      var endX = toRect.left + 20;
      var endY = toRect.top + toRect.height / 2;

      var onRemoved = function () {
        S.inFlightToSub.delete(id);
        if (S.stickmanQueue.indexOf(id) !== -1) S.inFlightToSub.add(id);
        S.stickmanBusy = false;
        if (S.stickmanQueue.length > 0) runQueuedToSub();
      };

      var totalMs = shared.STICKMAN_TRAVEL_MS;
      driveStickman(stick, buildRunPath({ x: startX, y: startY }, { x: endX, y: endY }, totalMs), totalMs, onRemoved);
      launched = true;

      spawnStickDust(stick, totalMs);

      window.setTimeout(function () {
        var el = getCardElById(id);
        if (!el) return;
        setOfficeFile(el, true);
        el.classList.add('task-delivered');
        var drop = document.createElement('span');
        drop.className = 'task-drop';
        drop.textContent = '📄';
        el.appendChild(drop);
        window.setTimeout(function () {
          el.classList.remove('task-delivered');
          if (drop.parentNode) drop.parentNode.removeChild(drop);
        }, 900);
        window.setTimeout(function () {
          if (el.classList.contains('is-leaving') || el.classList.contains('celebrating')) return;
          setOfficeFile(el, false);
        }, 2500);
      }, totalMs);

      return true;
    } catch (err) {
      if (launched) return true;
      S.stickmanBusy = false;
      return false;
    }
  }

  /* 脚底尘土 */
  function spawnStickDust(stick, totalMs) {
    var timer = window.setInterval(function () {
      if (!stick.parentNode) { window.clearInterval(timer); return; }
      var left = parseFloat(stick.style.left);
      var top = parseFloat(stick.style.top);
      if (!isFinite(left) || !isFinite(top) || !S.els.animLayer) return;
      var dust = document.createElement('span');
      dust.className = 'stick-dust';
      dust.style.left = (left + 22 + (Math.random() * 8 - 4)) + 'px';
      dust.style.top = (top + 54) + 'px';
      dust.style.setProperty('--dx', (Math.random() * 16 - 8).toFixed(0) + 'px');
      dust.style.setProperty('--dy', (Math.random() * 8 + 6).toFixed(0) + 'px');
      S.els.animLayer.appendChild(dust);
      window.setTimeout(function () {
        if (dust.parentNode) dust.parentNode.removeChild(dust);
      }, C.STICK_DUST_LIFE_MS);
    }, C.STICK_DUST_EVERY_MS);
    window.setTimeout(function () { window.clearInterval(timer); }, totalMs + 100);
  }

  /* ==================== 办公场景文件交接 ==================== */

  /* 给卡片办公小人加/去"手持文件"状态 */
  function setOfficeFile(cardEl, has) {
    if (!cardEl) return;
    var scene = cardEl.querySelector('.office-scene');
    if (!scene) return;
    scene.classList.toggle('has-file', has);
    if (has && !scene.querySelector('.office-file')) {
      scene.insertAdjacentHTML('beforeend', OFFICE_FILE_SVG);
    }
  }

  /* 主 Agent 接收文件 */
  function mainReceiveFile(success) {
    var mainEl = getCardElById('main');
    if (!mainEl) return;
    var ok = success !== false;
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

  /* ==================== 卡片动画反馈 ==================== */

  /* 子 Agent 失败离场视觉 */
  function markCardFailed(el) {
    if (!el) return;
    el.classList.add('task-failed');
    var area = el.querySelector('.status-area');
    if (!area) return;
    var meta = VC.STATUS_META.failed;
    area.innerHTML =
      '<div class="status-line">' +
        '<span class="status-emoji">' + meta.emoji + '</span>' +
        '<span class="status-label">' + meta.label + '</span>' +
        '<span class="status-extra"><span class="failed-x" aria-hidden="true">✕</span></span>' +
      '</div>';
  }

  /* 子 Agent 完成庆祝粒子 */
  function celebrateCard(id) {
    var el = getCardElById(id);
    if (!el) return;
    var particles = [];
    for (var i = 0; i < 8; i++) {
      var sp = document.createElement('span');
      sp.className = 'celebrate-particle';
      sp.textContent = CELEBRATE_EMOJI[i % CELEBRATE_EMOJI.length];
      var dx = Math.random() * 220 - 110;
      var dy = -(Math.random() * 130 + 50);
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
    }, shared.CELEBRATE_MS + 500);
  }

  /* 完成反馈弹出 */
  function popCard(el) {
    if (!el || el.classList.contains('enter')) return;
    el.classList.add('card-pop');
    window.setTimeout(function () {
      if (el.classList) el.classList.remove('card-pop');
    }, shared.CARD_POP_MS);
  }

  /* 新任务标记闪烁 */
  function showNewTaskTag(id) {
    var el = getCardElById(id);
    if (!el) return;
    var badge = document.createElement('span');
    badge.className = 'new-task-tag';
    badge.textContent = '新任务';
    var badgeSlot = el.querySelector('.type-badge');
    if (badgeSlot) badgeSlot.after(badge);
    window.setTimeout(function () {
      if (badge.parentNode) badge.parentNode.removeChild(badge);
    }, 2200);
  }

  /* 新任务"翻脸"表情 */
  function assignTaskFace(el, nowMap) {
    if (!el || !el.isConnected) return;
    if (nowMap) {
      var st = nowMap.get(el.dataset.id);
      if (st === 'done' || st === 'failed') return;
    }
    el.classList.add('task-assigned');
    window.setTimeout(function () {
      if (!el.isConnected) return;
      el.classList.remove('task-assigned');
    }, 3500);
  }

  /* ==================== 工具函数 ==================== */

  /* Agent 卡片元素查找 */
  function getCardElById(id) {
    var rec = S.mainCards[id] || S.activeCards[id];
    if (rec) return rec.el;
    var grids = [S.els.mainGrid, S.els.activeGrid];
    for (var g = 0; g < grids.length; g++) {
      var grid = grids[g];
      if (!grid) continue;
      var cards = grid.querySelectorAll('.agent-card');
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].dataset && cards[i].dataset.id === id) return cards[i];
      }
    }
    return null;
  }

  /* main 的 history 中派发/补充子 Agent 任务的工具调用累计次数 */
  function mainAgentCallCount(agents) {
    var mainAgent = agents.find(function (a) { return a.id === 'main'; });
    if (!mainAgent || !Array.isArray(mainAgent.history)) return 0;
    return mainAgent.history.filter(function (h) {
      return h === 'tool:Agent' || h === 'tool:SendMessage';
    }).length;
  }

  /* ==================== 挂载到命名空间 ==================== */
  VC.AN.STICKMAN_SVG = STICKMAN_SVG;
  VC.AN.OFFICE_FILE_SVG = OFFICE_FILE_SVG;
  VC.AN.FALLBACK_MAIN_RECT = FALLBACK_MAIN_RECT;
  VC.AN.CELEBRATE_EMOJI = CELEBRATE_EMOJI;
  VC.AN.buildRunPath = buildRunPath;
  VC.AN.driveStickman = driveStickman;
  VC.AN.runStickman = runStickman;
  VC.AN.runQueuedToSub = runQueuedToSub;
  VC.AN.launchToSubStickman = launchToSubStickman;
  VC.AN.spawnStickDust = spawnStickDust;
  VC.AN.setOfficeFile = setOfficeFile;
  VC.AN.mainReceiveFile = mainReceiveFile;
  VC.AN.markCardFailed = markCardFailed;
  VC.AN.celebrateCard = celebrateCard;
  VC.AN.popCard = popCard;
  VC.AN.showNewTaskTag = showNewTaskTag;
  VC.AN.assignTaskFace = assignTaskFace;
  VC.AN.getCardElById = getCardElById;
  VC.AN.mainAgentCallCount = mainAgentCallCount;
})();
