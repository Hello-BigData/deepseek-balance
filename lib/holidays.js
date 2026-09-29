// 中国法定节假日与「高峰时段」判定（纯函数，无宿主依赖，便于单测）
//
// 为什么内置：高峰判定要「按北京时间 + 中国法定节假日」，而节假安排每年由国务院办公厅公布，
// 属低频、公开、可离线固化的数据。插件不新增出网域名（manifest.network.allowedHosts 只有官方两个域名），
// 因此把 2026 年安排内置；用户可在配置项 holidayDates 里补充/覆盖（逗号或换行分隔的 YYYY-MM-DD）。
//
// 判定口径（与官方价格页一致）：
//   高峰 = 北京时间周一至周五 && 非法定节假日 && (9:00-12:00 或 14:00-18:00)
//   其余时段（含周末与法定节假日全天）为空闲。
//
// 关于调休上班日：国务院的放假安排同时含「放假」与「调休上班」。按官方措辞，调休上班日仍落在周末，
//   因此**不按高峰计**。这里单独内置 MAKEUP_WORKDAYS_2026 备核对与日后调整，默认不参与判定。
//
// 数据来源：《国务院办公厅关于 2026 年部分节假日安排的通知》，2026-09 核实：
//   元旦 1/1-1/3（1/4 上班）；春节 2/15-2/23（2/14、2/28 上班）；清明 4/4-4/6；
//   劳动节 5/1-5/5（5/9 上班）；端午 6/19-6/21；中秋 9/25-9/27；国庆 10/1-10/7（9/20、10/10 上班）。

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 2026 年中国法定节假日（全天按空闲时段计价）。
 * @type {string[]}
 */
export const HOLIDAYS_2026 = [
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
];

/**
 * 2026 年调休上班日（把周末调成工作日）。
 * 按官方措辞，这些日子仍属「周末」，**不作为高峰**；仅内置备核对与日后调整。
 * @type {string[]}
 */
export const MAKEUP_WORKDAYS_2026 = [
  '2026-01-04', // 元旦：周日上班
  '2026-02-14', // 春节：周六上班
  '2026-02-28', // 春节：周六上班
  '2026-05-09', // 劳动节：周六上班
  '2026-09-20', // 国庆：周日上班
  '2026-10-10', // 国庆：周六上班
];

/** 内置节假日的只读副本，供调用方核对。 */
export const BUILTIN_HOLIDAYS = HOLIDAYS_2026.slice();

/**
 * 内置节假日表覆盖的年份。新增官方安排时在此登记——未覆盖年份会给出可见告示，不静默按工作日计高峰。
 * @type {number[]}
 */
export const COVERED_YEARS = [2026];

// 关于「整表补齐 / 扩展年份」：国务院办公厅通常在上一年末才公布次年安排，属建库时不可知的权威数据。
// 在库内凭空推演（照搬往年 / 猜调休）会引入新的系统性错误，因此**不做自动外推**，也不靠猜。
// 现状：用户可用配置项 holidayDates 追加已公布的日期（buildHolidaySet 是并集，不会删除内置项）；
// 正式支持新年份需在插件更新时把该年 HOLIDAYS_YYYY 一并并入判定与 COVERED_YEARS。

/**
 * 某年是否被内置节假日表覆盖。
 * @param {number} year
 * @returns {boolean}
 */
export function isYearCovered(year) {
  return COVERED_YEARS.indexOf(Number(year)) >= 0;
}

/**
 * 某时刻所在（北京）日历年。
 * @param {number} epochMs
 * @returns {number}
 */
export function beijingYear(epochMs) {
  const t = new Date(Number(epochMs) + BEIJING_OFFSET_MS);
  return t.getUTCFullYear();
}

/**
 * 节假日覆盖情况（供路由/详情页给可见告示）。
 * **方向克制**：未覆盖年份不擅自改成「全高峰」或「全空闲」——两种都会引入新的系统性错误；
 * 保持现行「周一至周五 + 已知节假日」规则，只把「相关时段可能高估约 2×」如实告知。
 * @param {number} epochMs
 * @returns {{covered: boolean, year: number, coveredYears: number[], message: string}}
 */
export function holidayCoverage(epochMs) {
  const year = beijingYear(epochMs);
  const covered = isYearCovered(year);
  const message = covered
    ? ''
    : ('内置节假日表只覆盖 ' + COVERED_YEARS.join('、') + ' 年；当前年份（' + year + '）的法定节假日未收录，'
      + '会按工作日计入高峰时段，相关时段的金额可能被高估约 2×。可在插件设置 holidayDates 里按 YYYY-MM-DD 补充，或等待插件更新。');
  return { covered, year, coveredYears: COVERED_YEARS.slice(), message };
}

/** 内置高峰规则文案（默认显示值；未发生真变化或同步失败时都用它，绝不清空）。 */
export const PEAK_RULE_BUILTIN =
  '空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。';

/** 迷你图 X 轴的基础网格：每 3 小时一个整点；高峰整点由服务端掩码额外补标并按掩码着色。
 * （曾经的 PEAK_CLOCK_HOURS 已删除：刻度着色已改为与计费共用 isPeakAt，见 buildPeakTickMask。） */
export const TICK_GRID_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

/** 兼容别名（历史引用）。 */
export const PEAK_RULE_TEXT = PEAK_RULE_BUILTIN;

const BUILTIN_SET = new Set(HOLIDAYS_2026);
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * 北京时间下的日历日键（YYYY-MM-DD）。
 * @param {number} epochMs 毫秒时间戳
 * @returns {string}
 */
export function beijingDayKey(epochMs) {
  const t = new Date(Number(epochMs) + BEIJING_OFFSET_MS);
  return String(t.getUTCFullYear()) + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}

/**
 * 解析用户配置的节假日日期串（逗号/换行/空格/顿号分隔），只保留合法 YYYY-MM-DD 并去重。
 * @param {string} [raw]
 * @returns {string[]}
 */
export function parseHolidayDates(raw) {
  const out = [];
  if (typeof raw !== 'string' || !raw.trim()) return out;
  for (const piece of raw.split(/[\s,;，、]+/)) {
    const k = piece.trim();
    if (!DAY_KEY_RE.test(k)) continue;
    if (out.indexOf(k) < 0) out.push(k);
  }
  return out;
}

/**
 * 合成节假日集合：内置 2026 安排 ∪ 用户补充。
 * @param {string} [extraRaw] 用户配置串
 * @returns {{set: Set<string>, builtin: string[], extra: string[]}}
 */
export function buildHolidaySet(extraRaw) {
  const extra = Array.isArray(extraRaw)
    ? extraRaw.map((x) => String(x)).filter((x) => DAY_KEY_RE.test(x))
    : parseHolidayDates(extraRaw);
  const set = new Set(HOLIDAYS_2026);
  for (const k of extra) set.add(k);
  return { set, builtin: HOLIDAYS_2026.slice(), extra: extra.slice() };
}

function toSet(extra) {
  if (extra instanceof Set) return extra;
  if (Array.isArray(extra)) return new Set(extra.map((x) => String(x)));
  return new Set(parseHolidayDates(extra));
}

/**
 * 是否为法定节假日（含用户补充）。
 * @param {string} dayKey YYYY-MM-DD（北京时间）
 * @param {Set<string>|string[]|string} [extraHolidays]
 * @returns {boolean}
 */
export function isHoliday(dayKey, extraHolidays) {
  const k = String(dayKey || '');
  if (!k) return false;
  if (BUILTIN_SET.has(k)) return true;
  if (extraHolidays === undefined || extraHolidays === null) return false;
  return toSet(extraHolidays).has(k);
}

/**
 * 该时刻所在（北京）日是否为「高峰日」：周一至周五且非法定节假日。
 * 与具体钟点无关，用于日/周粒度的柱形着色与「今日」判定。
 * @param {number} epochMs
 * @param {Set<string>|string[]|string} [extraHolidays]
 * @returns {boolean}
 */
export function isPeakDay(epochMs, extraHolidays) {
  const t = new Date(Number(epochMs) + BEIJING_OFFSET_MS);
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !isHoliday(beijingDayKey(epochMs), extraHolidays);
}

/**
 * 该时刻是否处于高峰时段（北京时间周一至周五、非节假日、9:00-12:00 / 14:00-18:00）。
 * @param {number} epochMs
 * @param {Set<string>|string[]|string} [extraHolidays] 用户补充的节假日
 * @returns {boolean}
 */
export function isPeakAt(epochMs, extraHolidays) {
  if (!isPeakDay(epochMs, extraHolidays)) return false;
  const t = new Date(Number(epochMs) + BEIJING_OFFSET_MS);
  const h = t.getUTCHours() + t.getUTCMinutes() / 60;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 生成从 sinceMs 起逐小时的「高峰刻度掩码」（供服务端下发给前端上色，单一事实源）。
 * **与计费同源**：mask[i] = isPeakAt(该整点起点的绝对时刻, 节假日集合) —— 与 bucket.peak 用**同一个谓词**，
 * 不再维护第二条平行窗口规则。边界整点 12 / 18 归非高峰，与官方「 9:00-12:00、14:00-18:00 」的右开区间语义一致。
 * （这是作者的明确决定：刻度着色对齐计费，去掉 12/18 两个边界红刻度。）
 * 掩码按绝对时刻算，因此展示时区变化不影响它 —— 前端无需节假日数据就能正确着色。
 * @param {number} sinceMs 起点毫秒
 * @param {number} count 小时数
 * @param {Set<string>|string[]|string} [extraHolidays]
 * @returns {boolean[]}
 */
export function buildPeakTickMask(sinceMs, count, extraHolidays) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const start = Number(sinceMs);
  const out = [];
  for (let k = 0; k < n; k += 1) out.push(isPeakAt(start + k * 3600000, extraHolidays));
  return out;
}
