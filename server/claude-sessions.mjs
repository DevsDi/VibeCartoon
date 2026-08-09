// server/claude-sessions.mjs — T4 活跃会话枚举
//
// 通过 `claude agents --json` 子进程列出当前活跃的顶层会话（交互主会话 + 后台子 Agent），
// 供对账（sync.mjs）确定"权威转录集"覆盖哪些会话文件。
//
// 约束：
//   - 任何失败（二进制缺失 / 超时 kill / 非零退出 / JSON 解析失败）一律返回 { ok:false, degraded:true }，
//     由调用方（sync.mjs）降级为"仅注册表可读部分收敛"，绝不抛异常到上层。
//   - startedAt 保留来源的 epoch 毫秒值（与原样透传一致，便于调用方自行格式化）。

import { execFile } from "node:child_process";
import { CLAUDE_BIN, SYNC_ENUM_TIMEOUT_MS } from "../config.mjs";

// 运行 `claude agents --json`，超时自动 kill 子进程。
// 返回 Promise<string> stdout；出错 reject（调用方统一降级）。
function runClaudeAgentsJson() {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ["agents", "--json"],
      {
        timeout: SYNC_ENUM_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 输出上限 10MB（会话列表远小于此）
        windowsHide: true,           // Windows 下不弹黑窗
      },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      }
    );
    // execFile 的 timeout 会触发 kill；这里再加一层防御性兜底 kill（某些平台 kill 回调迟到时）。
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出则忽略 */ }
    }, SYNC_ENUM_TIMEOUT_MS + 1000);
    child.on("close", () => clearTimeout(t));
  });
}

/**
 * 枚举活跃顶层会话。
 * @returns {Promise<{ok:boolean, degraded?:boolean, sessions:Array<object>}>}
 *   ok=true  → sessions 为 [{ sessionId, cwd, kind, state, startedAt, name }]（字段缺失时为 null）
 *   ok=false → degraded=true，sessions 为空数组（调用方降级）
 */
export async function listActiveSessions() {
  try {
    const stdout = await runClaudeAgentsJson();
    const raw = JSON.parse(stdout);
    if (!Array.isArray(raw)) return { ok: true, sessions: [] };
    const sessions = raw
      .map((s) => ({
        sessionId: typeof s.sessionId === "string" ? s.sessionId : null,
        cwd: typeof s.cwd === "string" ? s.cwd : null,
        kind: typeof s.kind === "string" ? s.kind : null,
        state: typeof s.state === "string" ? s.state : null,
        startedAt: typeof s.startedAt === "number" ? s.startedAt : null,
        name: typeof s.name === "string" ? s.name : null,
      }))
      .filter((s) => s.sessionId); // 无 sessionId 的条目无法定位转录，直接丢弃
    return { ok: true, sessions };
  } catch (err) {
    // 二进制缺失 / 超时 / 非零退出 / 解析失败：统一降级，不抛异常
    console.error("[sync] 枚举活跃会话失败（claude 不可用或超时），降级为注册表模式:", err?.message ?? err);
    return { ok: false, degraded: true, sessions: [] };
  }
}
