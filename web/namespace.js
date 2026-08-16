/* =========================================================================
 * Vibe Agent Dashboard — 共享命名空间
 * 所有模块通过 VC 命名空间通信，避免全局变量污染。
 * 加载顺序：namespace.js → audio.js → animations.js → render.js → state.js → app.js
 * ========================================================================= */
'use strict';

/* 全局命名空间对象 */
var VC = {
  /* 共享配置常量（跨模块使用） */
  C: {
    POLL_INTERVAL: 600,
    FETCH_TIMEOUT: 2500,
    SYNC_FETCH_TIMEOUT: 10000,
    IDLE_TIMEOUT: 60000,
    STALE_FRONT_MS: 10 * 60 * 1000,
    TOOL_TAIL: 3,
    SSE_MAX_FAILS: 8,
    SOUND_TIP_KEY: 'vc-sound-tip-seen',
    STICKMAN_BOUNCE_MS: 600,
    STICKMAN_BOUNCE_AMP: 2,
    STICKMAN_BOUNCE_RAMP: { start: 0.08, end: 0.08 },
    STICK_DUST_EVERY_MS: 120,
    STICK_DUST_LIFE_MS: 700
  },

  /* 共享跨模块常量（动画+渲染共用） */
  shared: {
    CELEBRATE_MS: 1800,
    STICKMAN_TRAVEL_MS: 5000,
    CARD_POP_MS: 620,
    REMOVE_ANIM_MS: 420,
    TIMEOUT_LEAVE_MS: 1500,
    ENTER_ANIM_MS: 1700,
    LEAVE_WAVE_MS: 4000,
    LEAVE_FADE_MS: 3000,
    LEAVE_TOTAL_MS: 7100
  },

  /* 共享可变状态（所有模块读写） */
  S: {
    els: {},
    mainCards: {},
    activeCards: {},
    polling: false,
    prevAgentMap: new Map(),
    stickmanSeeded: false,
    lastMainAgentCallCount: 0,
    hasSubAgents: false,
    pollTimer: null,
    syncGeneration: 0,
    audioCtx: null,
    sse: null,
    sseFails: 0,
    sseActive: false,
    inFlightToSub: new Set(),
    stickmanQueue: [],
    stickmanBusy: false,
    lastSeenMap: new Map()
  },

  /* 映射表 */
  STATUS_META: {
    queued:   { emoji: '⏳', label: '排队中' },
    thinking: { emoji: '🔍', label: '思考中' },
    tool:     { emoji: '🛠️', label: '调用工具中' },
    asking:   { emoji: '💬', label: '等待输入' },
    idle:     { emoji: '😴', label: '待机中' },
    done:     { emoji: '✅', label: '已完成' },
    failed:   { emoji: '❌', label: '失败' },
    running:  { emoji: '🚀', label: '执行中' },
    unknown:  { emoji: '🌀', label: '未知状态' }
  },

  TOOL_TYPE_MAP: {
    code: ['read', 'edit', 'write'],
    search: ['grep', 'glob', 'search'],
    dispatch: ['agent', 'sendmessage']
  },

  FOLDED_STATUS: { done: true, failed: true },
  ACTIVE_PRIORITY: { asking: 0, tool: 1, thinking: 2, queued: 3, running: 4, unknown: 5 },

  /* 工具函数（纯函数，无副作用） */
  util: {},

  /* 音效与无障碍 */
  A: {},

  /* 动画 */
  AN: {},

  /* DOM 渲染 */
  R: {},

  /* 状态管理与网络 */
  N: {},

  /* 入口与协调 */
  E: {}
};
