import { fileURLToPath } from "node:url";
import path from "node:path";

// 当前模块所在目录，用于定位项目内文件
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = 8617;                       // 本地看板服务端口
export const STALE_MS = 10 * 60 * 1000;         // agent 超过 10 分钟无任何事件 → 回收
export const MAX_BYTES = 5 * 1024 * 1024;       // events.jsonl 轮转阈值 5MB
export const EVENTS_FILE = path.join(__dirname, "data", "events.jsonl");   // 事件文件
export const COLLECT_LOG = path.join(__dirname, "data", "collect.log");    // 采集日志
export const WEB_DIR = path.join(__dirname, "web");                        // 静态资源目录