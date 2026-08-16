/* =========================================================================
 * Vibe Agent Dashboard — 状态管理与网络模块
 * 职责：轮询逻辑、SSE 连接、停止子 Agent、同步按钮、网络请求
 * ========================================================================= */
'use strict';

(function () {
  var S = VC.S;
  var C = VC.C;
  var R = VC.R;

  /* ==================== 轮询 ==================== */

  async function poll() {
    if (S.polling) return;
    S.polling = true;
    try {
      var data = await fetchState();
      setOnline(true);
      R.render(data);
    } catch (err) {
      setOnline(false);
    } finally {
      S.polling = false;
    }
  }

  async function fetchState() {
    var ctrl = new AbortController();
    var timer = window.setTimeout(function () { ctrl.abort(); }, C.FETCH_TIMEOUT);
    try {
      var res = await fetch('/api/state', { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      window.clearTimeout(timer);
    }
  }

  function setOnline(ok) {
    S.els.connBanner.classList.toggle('hidden', ok);
  }

  /* ==================== SSE 优先刷新 ==================== */

  /* SSE 恢复定时器：永久关闭后定期尝试重建连接 */
  var _sseRecoveryTimer = null;

  function _startSSERecovery() {
    if (_sseRecoveryTimer) return;
    _sseRecoveryTimer = window.setInterval(function () {
      if (S.sse) { window.clearInterval(_sseRecoveryTimer); _sseRecoveryTimer = null; return; }
      S.sseFails = 0;
      setupSSE();
    }, 30000);
  }

  function _stopSSERecovery() {
    if (_sseRecoveryTimer) { window.clearInterval(_sseRecoveryTimer); _sseRecoveryTimer = null; }
  }

  function setupSSE() {
    if (S.sse || typeof EventSource === 'undefined') return;
    try {
      S.sse = new EventSource('/api/stream');
      S.sse.onopen = function () {
        S.sseFails = 0;
        S.sseActive = true;
        _stopSSERecovery();
        stopPolling();
      };
      S.sse.onmessage = function (ev) {
        if (document.hidden) return;
        try {
          var msg = JSON.parse(ev.data || '');
          if (msg && msg.type === 'event') {
            if (!S.sseActive) { S.sseActive = true; _stopSSERecovery(); stopPolling(); }
            poll();
          }
        } catch (err) { /* 非 JSON 数据忽略 */ }
      };
      S.sse.onerror = function () {
        /* 仅在 readyState === CLOSED（真正断开）时计数；
         * readyState === CONNECTING 表示浏览器正在自动重连，不计入失败次数 */
        if (S.sse && S.sse.readyState === EventSource.CLOSED) {
          S.sseFails++;
          S.sseActive = false;
          if (S.sseFails >= C.SSE_MAX_FAILS) {
            if (S.sse) { try { S.sse.close(); } catch (err) { /* 忽略 */ } S.sse = null; }
            /* 启动恢复定时器，每 30 秒尝试重建 SSE */
            _startSSERecovery();
          }
        }
        if (!document.hidden && !S.pollTimer) {
          poll();
          S.pollTimer = window.setInterval(poll, C.POLL_INTERVAL);
        }
      };
    } catch (err) {
      S.sse = null;
    }
  }

  /* ==================== 轮询启停 ==================== */

  function stopPolling() {
    if (S.pollTimer) { window.clearInterval(S.pollTimer); S.pollTimer = null; }
  }

  function startPolling() {
    if (S.sseActive) return;
    poll();
    if (!S.pollTimer) S.pollTimer = window.setInterval(poll, C.POLL_INTERVAL);
  }

  /* ==================== 停止子 Agent ==================== */

  async function requestAgentStop(id) {
    var ctrl = new AbortController();
    var timer = window.setTimeout(function () { ctrl.abort(); }, C.FETCH_TIMEOUT);
    try {
      var res = await fetch('/api/agents/' + encodeURIComponent(id) + '/stop', {
        method: 'POST', cache: 'no-store', signal: ctrl.signal
      });
      if (!res.ok) return false;
      var data = await res.json().catch(function () { return null; });
      return !!(data && data.ok);
    } catch (err) {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function onStopClick(ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.stop-agent-btn') : null;
    if (!btn || btn.disabled) return;
    var card = btn.closest('.agent-card');
    if (!card) return;
    var id = card.dataset && card.dataset.id;
    if (!id) return;
    var rec = S.activeCards[id];
    btn.disabled = true;
    requestAgentStop(id).then(function (ok) {
      if (ok && rec) {
        rec.stopSent = true;
        rec.stopState = null;
        R.updateStopZone(rec, rec.agent);
      } else if (!ok) {
        console.warn('[vc-dashboard] 停止子 Agent 请求失败：', id);
        var cur = card.querySelector('.stop-agent-btn');
        if (cur && !card.classList.contains('is-leaving') && !card.classList.contains('removing')) {
          cur.disabled = false;
        }
      }
    });
  }

  /* ==================== 同步子 Agent ==================== */

  async function requestSync() {
    var ctrl = new AbortController();
    var timer = window.setTimeout(function () { ctrl.abort(); }, C.SYNC_FETCH_TIMEOUT);
    try {
      var res = await fetch('/api/sync', {
        method: 'POST', cache: 'no-store', signal: ctrl.signal
      });
      if (!res.ok) return null;
      var data = await res.json().catch(function () { return null; });
      return (data && data.ok) ? data : null;
    } catch (err) {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function resetSyncBtnText(btn) {
    if (!btn) return;
    btn.classList.remove('busy');
    btn.textContent = '🔄 同步';
  }

  function onSyncClick() {
    S.syncGeneration++;
    var gen = S.syncGeneration;
    if (!S.els.syncBtn || S.els.syncBtn.disabled) return;
    var btn = S.els.syncBtn;
    btn.disabled = true;
    btn.classList.add('busy');
    btn.textContent = '🔄 同步中…';
    setTimeout(function () {
      if (gen === S.syncGeneration) btn.disabled = false;
    }, 5000);
    requestSync().then(function (data) {
      if (gen !== S.syncGeneration) return;
      if (!data || !data.sync || !data.sync.ok) {
        console.warn('[vc-dashboard] 同步子 Agent 请求失败');
        resetSyncBtnText(btn);
        VC.A.announce('同步失败');
        return;
      }
      poll();
      var sync = data.sync;
      var backfilled = sync.backfilled || 0;
      var fixedZombies = sync.fixedZombies || 0;
      var removed = sync.removed || 0;
      var label = '✓ 已同步';
      var msg = '同步完成';
      if (backfilled + fixedZombies + removed > 0) {
        label += '（回填' + backfilled + '/修复' + fixedZombies + '/删除' + removed + '）';
        msg += '：回填 ' + backfilled + ' 个、修复 ' + fixedZombies + ' 个、删除 ' + removed + ' 个';
      }
      if (sync.degraded) {
        label += ' ⚠ 降级';
        msg += '；claude 不可用，已降级处理';
      }
      btn.textContent = label;
      setTimeout(function () {
        if (gen === S.syncGeneration) resetSyncBtnText(btn);
      }, 5000);
      VC.A.announce(msg);
    });
  }

  /* ==================== 挂载到命名空间 ==================== */
  VC.N.poll = poll;
  VC.N.fetchState = fetchState;
  VC.N.setOnline = setOnline;
  VC.N.setupSSE = setupSSE;
  VC.N.stopPolling = stopPolling;
  VC.N.startPolling = startPolling;
  VC.N.requestAgentStop = requestAgentStop;
  VC.N.onStopClick = onStopClick;
  VC.N.requestSync = requestSync;
  VC.N.resetSyncBtnText = resetSyncBtnText;
  VC.N.onSyncClick = onSyncClick;
})();
