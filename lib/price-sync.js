// 官方价格页自动同步（纯函数解析，便于单测）
//
// 背景：官方可能会改价、改名、新增型号。让用户手工填单价不可接受，因此改为
//   自动抓取官方价格页 → 解析出各型号的空闲时段单价 → 覆盖内置价目表。
//
// 设计原则（fail-soft，绝不臆测）：
//   · 解析结果必须通过结构化校验（型号数 == 每行数字个数、高峰 == 空闲 × 2、价格 > 0）；
//   · 任一校验不通过 → 返回 ok:false，调用方继续使用内置价目表，绝不写入半成品数据；
//   · 解析只取数字与型号名，不回传原始 HTML。
//
// 官方页面的口径（2026-09 核实）：
//   · 空闲时段价格为高峰时段价格的一半；
//   · 表格列顺序即型号顺序（先缓存命中、再缓存未命中、最后输出）。

/** 官方价格页地址 */
export const PRICE_PAGE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/** 自动同步的缓存时长（毫秒）：12 小时 */
export const PRICE_SYNC_TTL_MS = 12 * 3600 * 1000;

/** 同步**失败**后的重试间隔（毫秒）：10 分钟——失败不应把重试压到 12 小时后。 */
export const PRICE_SYNC_FAIL_TTL_MS = 10 * 60 * 1000;

/**
 * 价格同步是否到期（统一 TTL 决策，供路由复用）。
 * force 为真总是到期；否则：上次成功用 12h、上次失败用 10min。
 * 用单调时钟差值，回拨（差值负）也判为到期。
 * @param {boolean} ok 上次是否成功
 * @param {number} startMono 上次同步的单调时间戳
 * @param {number} nowMono 当前单调时间戳
 * @param {boolean} [force]
 * @returns {boolean}
 */
export function priceSyncDue(ok, startMono, nowMono, force) {
  if (force) return true;
  const ttl = ok ? PRICE_SYNC_TTL_MS : PRICE_SYNC_FAIL_TTL_MS;
  const d = Number(nowMono) - Number(startMono);
  return !(Number.isFinite(d) && d >= 0 && d < ttl);
}

/** 去标签：只保留可见文本，每行一个片段。去掉脚本与样式，避免误匹配。 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ');
}

/**
 * 从官方价格页提取「高峰/空闲时段」规则句。
 * 页面里会出现「高峰时段」「北京时间」等字样；自行按句拆分后取同时含高峰与空闲/北京时间/周一至周五的句子。
 * fail-soft：提不到 → 返回 null，调用方保留内置文案（绝不把提示框清空）。
 * @param {string} html 页面 HTML（或已去标签的文本）
 * @returns {string|null}
 */
export function parsePeakRule(html) {
  const text = htmlToText(html);
  if (!text) return null;
  const frags = text
    .split(/[\n。！？；;]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const hits = frags.filter((s) => /高峰/.test(s) && /空闲|北京时间|周一至周五|工作日/.test(s));
  if (!hits.length) return null;
  // 先剥掉开头的 (n)/（n） 序号，任何展示出去的地方都不应带序号
  const rule = hits.join('。').replace(/\s+/g, ' ').replace(/^[\s(（]*\d+[)）]\s*/, '').trim();
  if (rule.length < 8 || rule.length > 400) return null;
  if (!/高峰/.test(rule)) return null;
  return rule;
}

/** 型号名：小写字母/数字开头、含至少一个分隔符（避开 “BASE URL” 这类表格标题） */
const MODEL_NAME_RE = /^([a-z][a-z0-9]*(?:[-._][a-z0-9]+)+)(?:\s*\(\d+\))?$/;
/** 价格单元格：数字 + 元（允许中间有空格） */
const PRICE_CELL_RE = /^([0-9]+(?:\.[0-9]+)?)\s*元$/;

/**
 * 价格行类型：缓存命中 / 缓存未命中 / 输出。
 * 注意：HTML 去标签后，「百万tokens输入」与「（缓存命中）」会被拆成两行，
 * 因此把当前行与下一行拼起来判断；同时必须出现 tokens，以避开「输出长度」这类字段名。
 */
function kindOf(line, nextLine) {
  const label = String(line || '') + ' ' + String(nextLine || '');
  if (!/tokens/i.test(label)) return null;
  if (/缓存未命中/.test(label)) return 'miss';
  if (/缓存命中/.test(label)) return 'hit';
  if (/输出/.test(label)) return 'output';
  return null;
}

/** 失败时带上一小段上下文（仅价格相关文本，不含原始 HTML），便于定位页面结构变化 */
export function syncContext(lines, anchor) {
  const i = lines.findIndex((t) => t.indexOf(anchor) >= 0);
  if (i < 0) return lines.slice(0, 12).join(' | ').slice(0, 240);
  return lines.slice(Math.max(0, i - 4), i + 10).join(' | ').slice(0, 240);
}

/** 从 start 起按顺序读取最多 count 个价格数字 */
function readPrices(lines, start, count) {
  const out = [];
  for (let i = start; i < lines.length && out.length < count; i += 1) {
    const m = PRICE_CELL_RE.exec(lines[i]);
    if (!m) { if (out.length) break; continue; }
    out.push(Number(m[1]));
  }
  return out;
}

/**
 * 解析官方价格页。
 * @param {string} html 页面 HTML（或已去标签的文本）
 * @returns {{ok: boolean, reason?: string, url: string, models: Record<string, {hit: number, miss: number, output: number}>, note?: string}}
 */
export function parsePricePage(html) {
  const url = PRICE_PAGE_URL;
  const lines = htmlToText(html).split('\n').map((s) => s.trim()).filter(Boolean);

  const names = [];
  // 1) 型号名：取「模型」标题之后连续的型号行。
  // 注意：HTML 去标签后，型号名后面会跟一个独立的脚注标记行（如 "(1)"），
  //       不能因为碰到它就停，否则会少认型号、导致与价格列数量不匹配。
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== '模型' && lines[i] !== '模型细节') continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j];
      if (/^\(\d+\)$/.test(t)) continue; // 脚注标记
      const m = MODEL_NAME_RE.exec(t);
      if (m) {
        if (names.indexOf(m[1]) < 0) names.push(m[1]);
        if (names.length > 12) break;
        continue;
      }
      if (!names.length) continue;
      // 已开始收集型号后：碰到表格下一段（如 “BASE URL (OpenAI 格式)” 或长句）就停
      if (/[A-Z]/.test(t) && /\s/.test(t)) break;
      if (t.length > 24) break;
    }
    if (names.length) break;
  }
  if (!names.length) return { ok: false, reason: '未找到型号名', url, models: {} };

  // 2) 三组价格：命中 / 未命中 / 输出，各取「空闲时段」一行
  const idle = { hit: null, miss: null, output: null };
  const peak = { hit: null, miss: null, output: null };
  for (let i = 0; i < lines.length; i += 1) {
    const kind = kindOf(lines[i], lines[i + 1]);
    if (!kind || idle[kind]) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
      if (/空闲时段/.test(lines[j]) && !idle[kind]) idle[kind] = readPrices(lines, j + 1, names.length);
      else if (/高峰时段/.test(lines[j]) && !peak[kind]) peak[kind] = readPrices(lines, j + 1, names.length);
      if (idle[kind] && peak[kind]) break;
    }
  }
  for (const k of ['hit', 'miss', 'output']) {
    if (!idle[k] || idle[k].length !== names.length) {
      return { ok: false, reason: '价格行数量与型号数不匹配（' + k + '，空闲）', url, models: {}, context: syncContext(lines, '空闲时段') };
    }
    if (!peak[k] || peak[k].length !== names.length) {
      return { ok: false, reason: '价格行数量与型号数不匹配（' + k + '，高峰）', url, models: {}, context: syncContext(lines, '高峰时段') };
    }
  }

  // 3) 结构化校验：价格 > 0 且 高峰 == 空闲 × 2（官方明示「空闲价为高峰价的一半」）
  const models = {};
  for (let i = 0; i < names.length; i += 1) {
    for (const k of ['hit', 'miss', 'output']) {
      const a = idle[k][i];
      const b = peak[k][i];
      if (!(a > 0)) return { ok: false, reason: '解析到无效价格（' + names[i] + '/' + k + '）', url, models: {}, context: syncContext(lines, names[i]) };
      if (Math.abs(b - a * 2) > 1e-9) return { ok: false, reason: '高峰价不等于空闲价两倍（' + names[i] + '/' + k + '），页面结构可能已变', url, models: {}, context: syncContext(lines, names[i]) };
    }
    models[names[i]] = { hit: idle.hit[i], miss: idle.miss[i], output: idle.output[i] };
  }
  const peakRule = parsePeakRule(html);
  return { ok: true, url, models, peakRule: peakRule || null, note: '空闲价取自官方价格页，高峰价 = 空闲价 × 2（已校验）' };
}
