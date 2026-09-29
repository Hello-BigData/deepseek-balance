// 插件自有诊断日志（路由 / 工具 / 面板异常三处共用，不各写一份）。
//
// 为什么必须有这份：实测宿主的 `ctx.log` 只会被并进**调用方 Agent 的会话记录**（sessions/*.jsonl），
// 用户遇到故障时根本读不到（`~\.hanako\logs\*.log` 里查不到插件消息）。因此留痕必须落到
// **插件自己可控、用户可读**的地方：插件数据目录下的 diagnostics.log，并可经 GET /api/diagnostics 读回。
//
// 契约：
//   · 单行格式：`ISO(含本地时区偏移) + 级别 + [来源] + 消息`（来源 ∈ route|tool|client）；
//   · 尺寸轮转：超过 maxBytes 就轮转为 diagnostics.1.log（只保留上一份），永不无限增长；
//   · 写/读**永不抛**（失败静默，绝不影响主流程）；
//   · **绝不记录 apiKey**：沿用 sk-*** 兜底脱敏；消息限长（默认 2048 字符）。
import fs from 'node:fs';
import path from 'node:path';

/** 当前日志文件名 */
export const DIAG_FILE = 'diagnostics.log';
/** 轮转后的文件名（只保留上一份） */
export const DIAG_ROTATED = 'diagnostics.1.log';
/** 轮转阈值：512KB */
export const DIAG_MAX_BYTES = 512 * 1024;
/** 单条消息最大字符数 */
export const DIAG_MAX_MESSAGE_CHARS = 2048;
/** GET /api/diagnostics 的 tail 默认值 / 上限 */
export const DIAG_TAIL_DEFAULT = 200;
export const DIAG_TAIL_MAX = 500;

/** 本地时区偏移的 ISO 时间（如 2026-09-27T23:16:00+08:00）。
 *  有意用**本机时区**：诊断日志是给人排查本机问题看的，且行内已带显式偏移（+08:00），不存在歧义。 */
function isoTs(ms) {
  const d = new Date(Number(ms) || Date.now());
  const off = -d.getTimezoneOffset(); // 分钟，东为正
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
}

/**
 * 脱敏 + 清洗 + 限长（不可信输入统一入口）：
 * 剥离控制字符、把 sk-... 一律替换为 sk-***、trim、截断。
 * @param {*} s
 * @param {number} [maxChars]
 * @returns {string}
 */
export function scrub(s, maxChars) {
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DIAG_MAX_MESSAGE_CHARS;
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 组装一行诊断日志。
 * @param {string} level info|warn|error
 * @param {string} source route|tool|client
 * @param {*} message
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatLine(level, source, message, nowMs) {
  return isoTs(nowMs) + ' ' + String(level || 'info').toUpperCase() +
    ' [' + String(source || '?') + '] ' + scrub(message) + '\n';
}

/**
 * 追加一条诊断日志（超阈值先轮转）。**永不抛**。
 * @param {string} dataDir 插件数据目录
 * @param {string} level
 * @param {string} source
 * @param {*} message
 * @param {{maxBytes?: number, nowMs?: number}} [opts]
 * @returns {boolean} 是否写入成功（失败返回 false，绝不抛）
 */
export function appendDiagnostic(dataDir, level, source, message, opts) {
  const o = opts || {};
  try {
    if (!dataDir || typeof dataDir !== 'string') return false;
    const maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : DIAG_MAX_BYTES;
    const file = path.join(dataDir, DIAG_FILE);
    const line = formatLine(level, source, message, o.nowMs || Date.now());
    fs.mkdirSync(dataDir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { size = 0; }
    if (size > 0 && size + Buffer.byteLength(line, 'utf8') > maxBytes) {
      try { fs.renameSync(file, path.join(dataDir, DIAG_ROTATED)); } catch (e) { /* 轮转失败就继续追加 */ }
    }
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch (e) {
    return false; // 永不抛
  }
}

/**
 * 归一化 tail：非法/缺失回落默认值，超过上限截到上限。
 * @param {*} tail
 * @param {number} [maxTail]
 * @returns {number}
 */
export function clampTail(tail, maxTail) {
  const max = Number.isFinite(maxTail) && maxTail > 0 ? Math.floor(maxTail) : DIAG_TAIL_MAX;
  const v = Number(tail);
  if (!Number.isFinite(v) || v <= 0) return Math.min(DIAG_TAIL_DEFAULT, max);
  return Math.min(max, Math.floor(v));
}

/**
 * 读回最近 N 行（每行再脱敏一次）。**永不抛**。
 * @param {string} dataDir
 * @param {*} tail
 * @param {number} [maxTail]
 * @returns {string[]} 按时间先后（旧→新）的最近若干行
 */
export function readDiagnostics(dataDir, tail, maxTail) {
  try {
    if (!dataDir || typeof dataDir !== 'string') return [];
    const n = clampTail(tail, maxTail);
    let text = '';
    try { text = fs.readFileSync(path.join(dataDir, DIAG_FILE), 'utf8'); } catch (e) { return []; }
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(Math.max(0, lines.length - n)).map((l) => scrub(l));
  } catch (e) {
    return [];
  }
}
