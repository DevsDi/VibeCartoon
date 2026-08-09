import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

// 当前模块所在目录，用于定位项目内文件
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = 8617;                       // 本地看板服务端口
// 监听主机：默认仅本机回环（外部访问不可达，安全）；显式设为 '0.0.0.0' 可监听全网卡（局域网可访问）。
// 可通过环境变量 HOST 覆盖（如 HOST=0.0.0.0 npm start）。
export const HOST = process.env.HOST || "127.0.0.1";
export const STALE_MS = 10 * 60 * 1000;         // agent 超过 10 分钟无任何事件 → 回收
export const MAX_BYTES = 10 * 1024 * 1024;      // events.jsonl 轮转阈值 10MB（增大以减少频繁轮转导致 readOffset 重置）
export const EVENTS_FILE = path.join(__dirname, "data", "events.jsonl");   // 事件文件
export const COLLECT_LOG = path.join(__dirname, "data", "collect.log");    // 采集日志
export const WEB_DIR = path.join(__dirname, "web");                        // 静态资源目录
// 停止请求信号文件：看板把"停止子 Agent"意图追加到该文件（禁止写 events.jsonl，避免与采集器并发冲突），
// 由外部主会话消费执行真实中断。可通过环境变量 STOP_SIGNALS_FILE 覆盖路径。
export const STOP_SIGNALS_FILE = process.env.STOP_SIGNALS_FILE || path.join(__dirname, "data", "stop-signals.jsonl");
// 停止请求信号保留时长（默认 24h）：超过该时长仍未被消费/清理的信号视为过期，清文件时移除。
export const STOP_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
// CORS 允许来源（字符串，可用逗号分隔多个，如 "http://localhost:8617,http://127.0.0.1:8617"）：
// 优先使用环境变量 ALLOWED_ORIGIN，默认 http://localhost:PORT
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
// 允许来源列表：把上面的字符串拆成数组，供服务端逐请求校验 Origin
export const ALLOWED_ORIGINS = ALLOWED_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// 自动同步（T1-T9）：从 Claude Code 转录文件（~/.claude/projects/<slug>/<sessionId>.jsonl）
// 增量读取，解析出权威的子 Agent 启动/完成状态，与看板 events.jsonl 状态机 diff 收敛。
// ---------------------------------------------------------------------------
// 转录文件根目录：Claude Code 默认把每个项目会话的转录写在 ~/.claude/projects/<项目slug>/ 下
export const TRANSCRIPT_ROOT = path.join(os.homedir(), ".claude", "projects");
// Claude Code 二进制：默认 "claude"（PATH 解析），可通过环境变量 CLAUDE_BIN 覆盖
// （如安装位置特殊或使用 claude.cmd 时指定完整路径）
export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// `claude agents --json` 子进程超时：超时 kill 并降级为注册表模式（默认 5000ms）
export const SYNC_ENUM_TIMEOUT_MS = 5000;
// 转录会话注册表条目保留时长：超过该时长仍未刷新（无新事件携带该 transcriptPath）→ 清理（默认 24h）
export const TRANSCRIPT_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
// 对账删除阈值：看板有、转录无记录的 Agent，且 lastSeen 超过该时长才允许删除（默认 10 分钟，与 STALE_MS 同级）
export const SYNC_STALE_REMOVE_MS = 10 * 60 * 1000;