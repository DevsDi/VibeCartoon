// server/file-utils.mjs — 事件文件通用区间读取（共享模块）
//
// 从 server.mjs / transcript.mjs 提取的 readFileRange 与 closeHandle，
// 消除跨文件代码重复。函数签名与返回值保持不变。

import { open as openFile } from "node:fs/promises";

/**
 * 安全关闭文件句柄，忽略关闭异常。
 * @param {import("node:fs/promises").FileHandle} fh
 */
async function closeHandle(fh) {
  if (!fh) return;
  try { await fh.close(); } catch { /* 忽略 */ }
}

/**
 * 事件文件通用区间读取：从 offset 开始读取到文件末尾，返回行数组。
 * 文件不存在或 offset 超出范围时返回空数组；文件被截断时自动回退到 0。
 *
 * 实现要点（轮转竞态安全）：打开句柄后用 fh.stat() 取文件尺寸，而非"先 stat 路径再 open"——
 * 避免 stat 与 open 之间目标文件被轮转改名（旧路径已消失/新文件尺寸不同）导致的尺寸错配。
 *
 * @param {string} filePath 文件路径
 * @param {number} offset 起始字节偏移
 * @param {number} [maxSize=Infinity] 最大读取字节数
 * @returns {Promise<{lines:string[], size:number, truncated:boolean, exists:boolean}>}
 *   exists=false → 文件缺失/打不开（调用方可据此标记不可读）
 */
async function readFileRange(filePath, offset, maxSize = Infinity) {
  let fh;
  try {
    fh = await openFile(filePath, "r");
  } catch {
    // 文件瞬时缺失 / 从未创建 → exists=false，调用方标记会话不可读
    return { lines: [], size: 0, truncated: true, exists: false };
  }
  try {
    const size = (await fh.stat()).size;
    // 文件被截断/轮转后变小（size < offset，游标已越过新文件末尾）：
    // 0..size 段仍是存活的既有行，本轮直接从 0 重读并返回，不丢行。
    const start = size < offset ? 0 : offset;
    if (size === start) return { lines: [], size, truncated: size < offset, exists: true };

    const readLen = Math.min(size - start, maxSize);
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return { lines: text.split(/\r?\n/).filter(Boolean), size, truncated: size < offset, exists: true };
  } finally {
    await closeHandle(fh);
  }
}

export { readFileRange, closeHandle };
