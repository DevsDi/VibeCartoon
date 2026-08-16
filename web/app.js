/* =========================================================================
 * Vibe Agent Dashboard — 入口与协调模块
 * 职责：初始化、DOM 缓存收集、事件绑定、启动流程、FPS 监控
 * 加载顺序：namespace.js → audio.js → animations.js → render.js → state.js → app.js
 * ========================================================================= */
'use strict';

(function () {
  var S = VC.S;
  var C = VC.C;
  var A = VC.A;
  var N = VC.N;
  var R = VC.R;

  /* ==================== 启动 ==================== */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    /* 收集 DOM */
    S.els.boardWrap = document.getElementById('board-wrap');
    S.els.mainGrid = document.getElementById('main-grid');
    S.els.activeGrid = document.getElementById('active-grid');
    S.els.emptyState = document.getElementById('empty-state');
    S.els.connBanner = document.getElementById('conn-banner');
    S.els.updatedAt = document.getElementById('updated-at');
    S.els.liveRegion = document.getElementById('status-live');
    S.els.soundTip = document.getElementById('sound-tip');
    S.els.syncBtn = document.getElementById('sync-btn');

    /* 音效解锁 */
    A.maybeShowSoundTip();
    A.ensureAudio();
    document.addEventListener('pointerdown', A.onUserGesture, { passive: true });
    document.addEventListener('touchstart', A.onUserGesture, { passive: true });
    document.addEventListener('keydown', A.onUserGesture);
    if (S.els.soundTip) {
      var tipClose = S.els.soundTip.querySelector('[data-close]');
      if (tipClose) tipClose.addEventListener('click', A.hideSoundTip);
    }

    /* 同步按钮 */
    if (S.els.syncBtn) S.els.syncBtn.addEventListener('click', N.onSyncClick);

    /* 停止按钮：事件委托 */
    S.els.activeGrid.addEventListener('click', N.onStopClick);

    /* 火柴人动画层 */
    S.els.animLayer = document.createElement('div');
    S.els.animLayer.id = 'anim-layer';
    S.els.animLayer.className = 'anim-layer';
    S.els.animLayer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(S.els.animLayer);

    /* 初始空状态 */
    R.setEmptyVisible(true);

    /* SSE 优先：连接正常时暂停 600ms 轮询；SSE 断开时自动恢复轮询兜底 */
    N.startPolling();
    N.setupSSE();

    /* 页面可见性：后台标签页暂停轮询和 SSE 事件处理 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        N.stopPolling();
      } else if (S.sseActive) {
        N.poll();
      } else {
        N.startPolling();
      }
    });

    /* FPS 监控（开发模式） */
    var params = new URLSearchParams(location.search);
    if (params.has('debug') || location.hash === '#debug') {
      initFPSMonitor();
    }
  }

  /* ==================== FPS 监控（开发模式） ==================== */
  function initFPSMonitor() {
    var el = document.createElement('div');
    el.id = 'fps-monitor';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);

    var frames = 0;
    var lastTime = performance.now();
    var rafId;

    function tick() {
      frames++;
      var now = performance.now();
      if (now - lastTime >= 1000) {
        el.textContent = Math.round(frames * 1000 / (now - lastTime)) + ' FPS';
        frames = 0;
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return function stop() {
      cancelAnimationFrame(rafId);
      el.remove();
    };
  }
})();
