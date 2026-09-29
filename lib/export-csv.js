// 导出 CSV 的路径与文件名规则（纯函数，便于单测与安全校验）
//
// 安全边界：
//   · 目标目录来自宿主目录选择器，这里仍只接受绝对路径；
//   · 文件名完全由服务端生成（区间白名单 + 时区时间戳），前端字符串不参与路径拼接；
//   · 区间标识走白名单映射，杜绝 ../ 之类的注入。
//
// 类型说明：本文件用 JSDoc 标注契约，可选跑 `npx -y typescript tsc --noEmit --allowJs --checkJs lib/*.js` 做静态校验。

/** @type {number} CSV 文本上限（字符数） */
export const EXPORT_MAX_CHARS = 8 * 1024 * 1024;

/**
 * 区间标识白名单：外部字符串只能映射到这些固定值。
 * @type {Record<string, string>}
 */
export const RANGE_SLUGS = {
  today: 'today',
  yesterday: 'yesterday',
  '7d': '7d',
  '30d': '30d',
  thisMonth: 'this-month',
  lastMonth: 'last-month',
  all: 'all',
  custom: 'custom',
};

/**
 * 是否为绝对路径（Windows 盘符、UNC 或 POSIX 根）。
 * @param {string} p
 * @returns {boolean}
 */
export function isAbsolutePath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.charAt(0) === '/';
}

/**
 * 按路径风格返回分隔符。
 * @param {string} p
 * @returns {'\\' | '/'}
 */
export function pathSep(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) ? '\\' : '/';
}

/**
 * 是否为 YYYY-MM-DD 形式的日期。
 * @param {*} s
 * @returns {boolean}
 */
export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * 按给定时区偏移生成时间戳片段（yyyyMMdd-HHmmss）。
 * @param {number} tzMinutes
 * @returns {string}
 */
export function stampInTz(tzMinutes) {
  const d = new Date(Date.now() + tzMinutes * 60000);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return (
    String(d.getUTCFullYear()) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
    '-' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds())
  );
}

/**
 * 组装最终文件名（不含扩展名）：自定义区间用起止日期，其余用区间标识 + 秒级时间戳。
 * @param {string} rangeKey 白名单内的区间标识
 * @param {string} from 起始日（custom）
 * @param {string} to 结束日（custom）
 * @param {number} tzMinutes 展示时区偏移
 * @returns {string}
 */
export function buildExportStem(rangeKey, from, to, tzMinutes) {
  if (rangeKey === 'custom') return 'deepseek-usage-' + from + '_' + to + '-' + stampInTz(tzMinutes);
  return 'deepseek-usage-' + RANGE_SLUGS[rangeKey] + '-' + stampInTz(tzMinutes);
}

/**
 * CSV 字段转义：防公式注入（= + - @ 制表 回车 开头前置单引号）+ RFC4180 引号转义。
 * @param {*} v
 * @returns {string}
 */
export function csvField(v) {
  let s = String(v === null || v === undefined ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
