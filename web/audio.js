/* =========================================================================
 * Vibe Agent Dashboard — 音效与无障碍模块
 * 职责：WebAudio 音效播放、无障碍 aria-live 播报、音效提示管理
 * ========================================================================= */
'use strict';

(function () {
  var S = VC.S;
  var C = VC.C;
  var util = VC.util;

  /* 是否处于动效降级（固定 auto）：仅系统开启 prefers-reduced-motion 时降级 */
  function isMotionReduced() {
    return !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* WebAudio 上下文懒加载（autoplay 政策）：
   * init 时先创建一次 suspended 的 AudioContext（合法且不发声），此后任一用户交互
   * 再调用本函数把上下文 resume 解锁。 */
  function ensureAudio() {
    if (!S.audioCtx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        S.audioCtx = AC ? new AC() : null;
      } catch (err) { S.audioCtx = null; }
    }
    if (S.audioCtx && S.audioCtx.state === 'suspended') {
      S.audioCtx.resume().catch(function () { /* 忽略拒绝 */ });
    }
  }

  /* 首次用户手势：resume 解锁音频，并收起提示 */
  function onUserGesture() {
    ensureAudio();
    hideSoundTip();
  }

  /* 音效启用轻提示：仅首次访问、且尚未点击页面时提示 */
  function maybeShowSoundTip() {
    if (!S.els.soundTip || S.audioCtx) return;
    var seen = '0';
    try { seen = localStorage.getItem(C.SOUND_TIP_KEY) || '0'; } catch (err) { /* 忽略 */ }
    if (seen !== '1') S.els.soundTip.classList.remove('hidden');
  }

  /* 收起轻提示：淡出过渡结束后移除 DOM，并记录已看过 */
  function hideSoundTip() {
    if (!S.els.soundTip || S.els.soundTip.dataset.done) return;
    S.els.soundTip.dataset.done = '1';
    try { localStorage.setItem(C.SOUND_TIP_KEY, '1'); } catch (err) { /* 忽略 */ }
    S.els.soundTip.classList.add('sound-tip-hide');
    window.setTimeout(function () {
      if (S.els.soundTip && S.els.soundTip.parentNode) {
        S.els.soundTip.parentNode.removeChild(S.els.soundTip);
      }
    }, 260);
  }

  /* 完成/失败提示音（P1，零依赖 WebAudio，默认开启）：
   * done → C5→E5→G5 大三和弦欢呼；仅保留完成音效 */
  function playChime(kind) {
    if (isMotionReduced()) return;
    if (kind !== 'done') return;
    if (!S.audioCtx) return;

    function scheduleNotes() {
      try {
        var ctx = S.audioCtx;
        var t0 = ctx.currentTime + 0.02;
        var notes = [{ f: 523.25, at: 0.0, dur: 0.10 }, { f: 659.25, at: 0.10, dur: 0.10 }, { f: 783.99, at: 0.20, dur: 0.15 }];
        notes.forEach(function (n) {
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = n.f;
          osc.connect(gain);
          gain.connect(ctx.destination);
          var a = t0 + n.at;
          gain.gain.setValueAtTime(0.0001, a);
          gain.gain.exponentialRampToValueAtTime(0.5, a + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, a + n.dur);
          osc.start(a);
          osc.stop(a + n.dur + 0.04);
        });
      } catch (err) {
        console.warn('[playChime] 音效播放失败:', err);
      }
    }

    if (S.audioCtx.state === 'suspended') {
      S.audioCtx.resume().then(scheduleNotes).catch(function (err) {
        console.warn('[playChime] AudioContext resume 失败:', err);
      });
    } else {
      scheduleNotes();
    }
  }

  /* aria-live 无障碍播报（P1）：写入可读文本，屏幕阅读器可感知 */
  function announce(text) {
    if (!S.els.liveRegion) return;
    S.els.liveRegion.textContent = '';
    window.setTimeout(function () {
      S.els.liveRegion.textContent = text;
    }, 30);
  }

  /* 挂载到命名空间 */
  VC.A.isMotionReduced = isMotionReduced;
  VC.A.ensureAudio = ensureAudio;
  VC.A.onUserGesture = onUserGesture;
  VC.A.maybeShowSoundTip = maybeShowSoundTip;
  VC.A.hideSoundTip = hideSoundTip;
  VC.A.playChime = playChime;
  VC.A.announce = announce;
})();
