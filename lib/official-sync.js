// 官方用量同步（纯函数，无宿主依赖，便于单测）。
//
// 目标：导入 DeepSeek 官方导出的用量包（`usage_data_<起>_<止>.zip`，内含两份 CSV），
// 把它整理成「北京【小时或日】× 型号」的**权威账**，供侧栏累计计数、今日消费额与用量详情页取用。
//
// 粒度：**由包本身决定，随区间长度变化** —— 短区间（1~2 天）导出逐小时的桶，长区间导出按日的桶。
// 因此本模块两种粒度都吃：行跨度 ≤ HOUR_SPAN_MAX_MS 视为小时桶，否则视为按日行；同一份包里
// 若某天既有小时桶又有按日行，则该天以小时桶为准（更细）。
//
// 官方包内两份文件：
//   · cost-*.csv   —— 按【粒度桶 × 型号】的**已结算金额**（列：start_time_iso,end_time_iso,model,wallet_type,cost,currency）
//   · amount-*.csv —— 按【粒度桶 × 型号 × 类型】的明细（列：…,type,price,amount），type ∈
//                      request_count / input_cache_hit_tokens / input_cache_miss_tokens / output_tokens
//
// 口径与纪律：
//   · 金额一律按**整数微元**（`Math.round(cost * 1e8)`）累加，避免浮点漂移 ⇒ 合计与官方逐位一致；
//   · 只取 `currency=CNY`，其余币种忽略并计数（amount 文件无 currency 列，不设币种过滤）；
//   · 明细分 tier 拆成多行（高峰/空闲各自一行），一律**求和**，不假设唯一。
//
// 合并（`mergeSync`）：导出的区间是用户自选的 —— 想拿小时粒度就得导短区间，想拿累计就得导长区间，
// 两者必须能叠加而互不摧毁。规则：**小时包优先** —— 某一天只要有小时桶（无论来自哪一侧），该天就以小时桶
// 求和为准，两侧的同天日行都丢弃；其余天按日行保留。因此哪份包后导都一样，结果相同（既幂等又对称）。
// 于是「导入今日小时包」不再抹掉此前导入的 30 天历史。
//
// 安全：导入包是不可信输入 —— 本模块只做解析 + 数值聚合，**不保留 user_id / api_key / api_key_name**，
// 也不保留原始字段文本；返回值只有日期键、型号名与数字。

import { inflateRawSync } from 'node:zlib';

/** 单份 CSV 文本上限（字符） */
export const SYNC_MAX_TEXT_CHARS = 4 * 1024 * 1024;
/** 入参（base64 或纯文本）上限（字符） */
export const SYNC_MAX_PAYLOAD_CHARS = 8 * 1024 * 1024;
/** 单个 zip 条目解压后上限（字节） */
export const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;
/** 北京时区固定偏移（毫秒） */
export const BEIJING_OFFSET_MS = 8 * 3600000;
/** 一天 */
export const DAY_MS = 86400000;
/** 一小时 */
export const HOUR_MS = 3600000;
/** 行跨度 ≤ 该值 → 视为「小时桶」，否则视为「按日」行（官方粒度随导出区间长度变化） */
export const HOUR_SPAN_MAX_MS = 2 * HOUR_MS;
/** 微元（1e-8 元） */
const UNIT = 1e8;

// ---------------------------------------------------------------- CSV 基础

/** RFC4180 风格拆字段：支持双引号包裹与 "" 转义；去首尾空白。 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  const s = String(line == null ? '' : line);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i += 1; } else { inQ = false; }
      } else { cur += ch; }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function headerIndex(header, names) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- 北京日键

/** 毫秒时间戳 → 北京日键 YYYY-MM-DD（非法输入返回 null） */
export function beijingDayKey(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return null;
  const s = new Date(t + BEIJING_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return s.getUTCFullYear() + '-' + p(s.getUTCMonth() + 1) + '-' + p(s.getUTCDate());
}

/** 北京日键 → 该日**起点**毫秒（北京 00:00） */
export function dayKeyStartMs(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key == null ? '' : key));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return t - BEIJING_OFFSET_MS;
}

/** 北京日键 → 该日**结束**毫秒（次日北京 00:00） */
export function dayKeyEndMs(key) {
  const s = dayKeyStartMs(key);
  return s === null ? null : s + DAY_MS;
}

/** 毫秒时间戳 → 该时刻所属**北京整点**的起点毫秒（北京与 UTC 差整小时，故按 UTC 整点取整等价） */
export function hourStartMs(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/** 毫秒 → 北京「MM-DD HH:00」标签（展示用，纯字符串拼装，不涉时区库） */
export function beijingHourLabel(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return null;
  const s = new Date(t + BEIJING_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return p(s.getUTCMonth() + 1) + '-' + p(s.getUTCDate()) + ' ' + p(s.getUTCHours()) + ':00';
}

/** 日期键比较（字符串按字典序即时间序） */
function minKey(a, b) { return a == null ? b : (b == null ? a : (a < b ? a : b)); }
function maxKey(a, b) { return a == null ? b : (b == null ? a : (a > b ? a : b)); }

// ---------------------------------------------------------------- 单表解析

const AMOUNT_TYPES = ['request_count', 'input_cache_hit_tokens', 'input_cache_miss_tokens', 'output_tokens'];

/**
 * 解析一份官方 CSV 表（cost 或 amount）。
 * @param {string} text
 * @param {'cost'|'amount'} [forcedKind] 已知类型时传入，未知则由表头推断
 * @returns {{ok:boolean, reason?:string, kind?:string, cells?:Array, rowCount?:number,
 *            otherCurrency?:number, skipped?:number, minDay?:string|null, maxDay?:string|null}}
 *   cells: [{gran:'hour'|'day', key, hour|null, day, model, costU, requests, hit, miss, output, hasCost, hasUsage, endMs}]
 *     · gran='day' 时 key 即北京日键；gran='hour' 时 key 为北京整点起点毫秒（hour 同值）
 *     · costU：cost 表里是已结算金额（微元）；amount 表里是 price × amount 的回推值
 */
export function parseSheet(text, forcedKind) {
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { ok: false, reason: 'CSV 为空' };
  const header = splitCsvLine(lines[0]).map((s) => s.toLowerCase());
  const iStart = headerIndex(header, ['start_time_iso', 'start_time', 'time']);
  const iEnd = headerIndex(header, ['end_time_iso', 'end_time']);
  const iModel = headerIndex(header, ['model']);
  const iCost = headerIndex(header, ['cost']);
  const iCur = headerIndex(header, ['currency']);
  const iAmount = headerIndex(header, ['amount']);
  const iPrice = headerIndex(header, ['price', 'unit_price']);
  const iType = headerIndex(header, ['type']);

  let kind = forcedKind || null;
  if (!kind) {
    if (iCost >= 0 && iStart >= 0) kind = 'cost';
    else if (iAmount >= 0 && iType >= 0) kind = 'amount';
  }
  if (kind !== 'cost' && kind !== 'amount') return { ok: false, reason: '未识别的文件类型（需要 cost 或 amount 列）' };
  if (iStart < 0) return { ok: false, reason: '缺少 start_time_iso 列' };
  if (kind === 'cost' && iCost < 0) return { ok: false, reason: 'cost 表缺少 cost 列' };
  if (kind === 'amount' && (iAmount < 0 || iType < 0)) return { ok: false, reason: 'amount 表缺少 amount/type 列' };

  const map = new Map();
  const cell = (gran, key, day, model) => {
    const k = gran + '\n' + key + '\n' + model;
    let c = map.get(k);
    if (!c) {
      c = {
        gran, key, hour: gran === 'hour' ? key : null, day, model,
        costU: 0, requests: 0, hit: 0, miss: 0, output: 0,
        hasCost: false, hasUsage: false, endMs: 0,
      };
      map.set(k, c);
    }
    return c;
  };

  let rowCount = 0; let otherCurrency = 0; let skipped = 0;
  let minDay = null; let maxDay = null; let maxEndMs = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const f = splitCsvLine(lines[i]);
    if (f.length <= Math.max(iStart, iEnd, iModel, iCost, iAmount, iType, iCur)) { skipped += 1; continue; }
    if (iCur >= 0) {
      const cur = String(f[iCur] || '').toUpperCase();
      if (cur && cur !== 'CNY') { otherCurrency += 1; continue; }
    }
    const t = Date.parse(f[iStart]);
    const day = beijingDayKey(t);
    if (!day) { skipped += 1; continue; }
    const model = String(iModel >= 0 ? f[iModel] : '').trim() || 'unknown';
    const endMs = iEnd >= 0 ? Date.parse(f[iEnd]) : NaN;
    // 粒度由**行自身**的跨度决定：整点桶（跨 1 小时；末日那格可能更短）→ hour，跨日 → day。
    const gran = (Number.isFinite(endMs) && endMs > t && (endMs - t) <= HOUR_SPAN_MAX_MS) ? 'hour' : 'day';
    const key = gran === 'hour' ? hourStartMs(t) : day;
    const c = cell(gran, key, day, model);
    if (Number.isFinite(endMs) && endMs > c.endMs) c.endMs = endMs;
    if (Number.isFinite(endMs) && endMs > maxEndMs) maxEndMs = endMs;
    minDay = minKey(minDay, day);
    maxDay = maxKey(maxDay, day);

    if (kind === 'cost') {
      const cost = Number(f[iCost]);
      if (!Number.isFinite(cost)) { skipped += 1; continue; }
      c.costU += Math.round(cost * UNIT);
      c.hasCost = true;
      rowCount += 1;
    } else {
      const type = String(f[iType] || '').trim();
      const amt = Number(f[iAmount]);
      if (!Number.isFinite(amt)) { skipped += 1; continue; }
      if (AMOUNT_TYPES.indexOf(type) < 0) { skipped += 1; continue; }
      if (type === 'request_count') c.requests += amt;
      else if (type === 'input_cache_hit_tokens') c.hit += amt;
      else if (type === 'input_cache_miss_tokens') c.miss += amt;
      else c.output += amt;
      // 明细行的 price 是「每 token 单价」：金额可由 price × amount 还原，作为 cost 表缺行时的兜底
      const price = iPrice >= 0 ? Number(f[iPrice]) : NaN;
      if (Number.isFinite(price)) {
        c.costU += Math.round(price * amt * UNIT);
        c.hasCost = true;
      }
      c.hasUsage = true;
      rowCount += 1;
    }
  }

  if (!map.size) return { ok: false, reason: otherCurrency ? '没有 CNY 数据行' : '没有可用的数据行' };
  return { ok: true, kind, cells: Array.from(map.values()), rowCount, otherCurrency, skipped, minDay, maxDay, maxEndMs };
}

// ---------------------------------------------------------------- zip 读取

function readLocalEntry(buf, localOff, compSize, method) {
  if (localOff + 30 > buf.length) return null;
  if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + nameLen + extraLen;
  let size = compSize;
  // 数据描述符兜底：本地头里长度为 0 时取到包尾（inflate 遇流结束即停）
  if (!size) size = Math.max(0, buf.length - start);
  if (size > MAX_ZIP_ENTRY_BYTES) return null;
  const raw = buf.subarray(start, start + size);
  if (method === 0) return Buffer.from(raw);
  if (method !== 8) return null;
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
  } catch (e) { return null; }
}

/**
 * 读 zip 内的 .csv 条目（纯 Node 解析中央目录，不依赖 unzip/python3）。
 * @param {Buffer} buf
 * @returns {Array<{name:string, data:Buffer}>}
 */
export function extractZipEntries(buf) {
  const out = [];
  if (!buf || buf.length < 22) return out;
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > 512) count = 512;
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length) break;
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (!/\.csv$/i.test(name)) continue;
    const data = readLocalEntry(buf, localOff, compSize, method);
    if (data) out.push({ name: name.replace(/\\/g, '/'), data });
  }
  return out;
}

// ---------------------------------------------------------------- 入口：解码 → 解析 → 聚合

function isZip(buf) { return !!buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; }

/**
 * 把「上传内容」解码成待解析的文本集合。
 * @param {{content?:string, encoding?:string}} input encoding: 'base64'（zip 或任意二进制）| 'utf8'（纯文本 CSV）
 * @returns {{ok:boolean, reason?:string, files?:Array<{name:string,text:string}>}}
 */
export function decodeImport(input) {
  const content = input && typeof input.content === 'string' ? input.content : '';
  const encoding = input && input.encoding === 'base64' ? 'base64' : 'utf8';
  if (!content) return { ok: false, reason: '没有收到文件内容' };
  if (content.length > SYNC_MAX_PAYLOAD_CHARS) return { ok: false, reason: '导入内容超过 8MB 上限' };

  if (encoding === 'utf8') {
    if (content.length > SYNC_MAX_TEXT_CHARS) return { ok: false, reason: 'CSV 超过 4MB 上限' };
    return { ok: true, files: [{ name: 'csv', text: content }] };
  }

  let buf;
  try { buf = Buffer.from(content, 'base64'); } catch (e) { return { ok: false, reason: 'base64 解码失败' }; }
  if (!buf.length) return { ok: false, reason: '文件内容为空' };
  if (isZip(buf)) {
    const entries = extractZipEntries(buf);
    if (!entries.length) return { ok: false, reason: 'zip 里没有可读的 CSV' };
    const files = [];
    for (const e of entries) {
      const text = e.data.toString('utf8').replace(/^\uFEFF/, '');
      if (text.length > SYNC_MAX_TEXT_CHARS) return { ok: false, reason: '解压后的 CSV 超过 4MB 上限' };
      files.push({ name: e.name, text });
    }
    return { ok: true, files };
  }
  // 不是 zip：可能直接就是 CSV 的 base64
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (text.length > SYNC_MAX_TEXT_CHARS) return { ok: false, reason: 'CSV 超过 4MB 上限' };
  return { ok: true, files: [{ name: 'csv', text }] };
}

/** 文件名 → 官方表类型（cost / amount）；认不出返回 null */
export function kindOfFile(name) {
  const n = String(name == null ? '' : name).toLowerCase();
  if (!/\.csv$/.test(n)) return null;
  if (n.indexOf('cost') >= 0) return 'cost';
  if (n.indexOf('amount') >= 0) return 'amount';
  return null;
}

/**
 * 把解析后的各表聚合成一份可持久化的同步数据集。
 * @param {{sheets?:Array<{name?:string, text:string}>, importedAt?:number}} input
 * @returns {{ok:boolean, reason?:string, data?:object}}
 */
export function buildSync(input) {
  const sheets = (input && Array.isArray(input.sheets)) ? input.sheets : [];
  if (!sheets.length) return { ok: false, reason: '没有可解析的文件' };

  const hourMap = new Map();
  const dayMap = new Map();
  const blankRec = () => ({ costU: 0, costFromAmountU: 0, costKnown: false, requests: 0, hit: 0, miss: 0, output: 0, usageKnown: false, endMs: 0, models: new Map() });
  const hourRec = (h, day) => {
    let r = hourMap.get(h);
    if (!r) { r = Object.assign(blankRec(), { h, d: day }); hourMap.set(h, r); }
    return r;
  };
  const dayRec = (day) => {
    let r = dayMap.get(day);
    if (!r) { r = Object.assign(blankRec(), { d: day }); dayMap.set(day, r); }
    return r;
  };
  const modelRec = (rec, id) => {
    let m = rec.models.get(id);
    if (!m) { m = { id, costU: 0, costFromAmountU: 0, requests: 0, tokens: 0, hit: 0, miss: 0, output: 0 }; rec.models.set(id, m); }
    return m;
  };

  const usedFiles = [];
  let rowCount = 0; let otherCurrency = 0; let skipped = 0; let okSheets = 0;
  let minDay = null; let maxDay = null; let pkgMaxEndMs = 0;

  for (const sh of sheets) {
    const kindHint = kindOfFile(sh && sh.name);
    const parsed = parseSheet((sh && sh.text) || '', kindHint || undefined);
    if (!parsed.ok) {
      return { ok: false, reason: (sh && sh.name ? sh.name + '：' : '') + (parsed.reason || '解析失败') };
    }
    const kind = parsed.kind;
    okSheets += 1;
    usedFiles.push(String((sh && sh.name) || kind));
    rowCount += parsed.rowCount || 0;
    otherCurrency += parsed.otherCurrency || 0;
    skipped += parsed.skipped || 0;
    minDay = minKey(minDay, parsed.minDay || null);
    maxDay = maxKey(maxDay, parsed.maxDay || null);
    pkgMaxEndMs = Math.max(pkgMaxEndMs, Number(parsed.maxEndMs) || 0);

    for (const c of parsed.cells || []) {
      const dr = c.gran === 'hour' ? hourRec(c.key, c.day) : dayRec(c.day);
      if (Number.isFinite(c.endMs) && c.endMs > dr.endMs) dr.endMs = c.endMs;
      const mr = modelRec(dr, c.model);
      if (kind === 'cost') {
        // cost 表是权威口径
        dr.costU += c.costU; mr.costU += c.costU;
        dr.costKnown = true;
      } else {
        dr.requests += c.requests; dr.hit += c.hit; dr.miss += c.miss; dr.output += c.output;
        dr.usageKnown = true;
        mr.requests += c.requests; mr.hit += c.hit; mr.miss += c.miss; mr.output += c.output;
        // 明细行自带 price × amount，先单独存 —— 只有该日缺 cost 表时才启用，否则两表相加会翻倍
        dr.costFromAmountU += c.costU; mr.costFromAmountU += c.costU;
      }
    }
  }

  if (!okSheets || !(hourMap.size || dayMap.size)) return { ok: false, reason: '没有可用的数据行' };

  const importedAt = Number.isFinite(Number(input && input.importedAt)) ? Number(input.importedAt) : Date.now();
  const hours = resolveCells(hourMap, 'h');
  const dayOnly = resolveCells(dayMap, 'd');
  const days = deriveDays(hours, dayOnly);
  const from = minDay || (days.length ? days[0].d : null);
  const to = maxDay || (days.length ? days[days.length - 1].d : null);
  const windowStart = dayKeyStartMs(from);
  // 覆盖末端 = min(导入时刻, 包内真实的**最后一行**时刻)。取行自身的 end_time 而不是「末日 24 点」：
  // 按小时导出的包末日那格是半截，用真实行尾才不会把官方其实没结算的那几分钟算成已覆盖。
  const windowEnd = pkgMaxEndMs > 0 ? pkgMaxEndMs : dayKeyEndMs(to);
  const coveredUntil = windowEnd === null ? importedAt : Math.min(importedAt, windowEnd);
  const granularity = hours.length ? (dayOnly.length ? 'mixed' : 'hour') : 'day';

  return {
    ok: true,
    data: {
      v: 2,
      importedAt,
      files: usedFiles,
      from,
      to,
      windowStart,
      coveredUntil,
      rowCount,
      otherCurrency,
      skipped,
      granularity,
      totals: sumDayList(days),
      hours,
      days,
      imports: [{ at: importedAt, from, to, rows: rowCount, files: usedFiles.slice(), granularity }],
    },
  };
}

// ---------------------------------------------------------------- 聚合内部工具

/** 内部聚合记录 → 可持久化记录（金额来源归一：cost 表 > 明细回推 > 无） */
function resolveRec(r) {
  const derived = !r.costKnown && r.costFromAmountU !== 0;
  const costU = r.costKnown ? r.costU : (derived ? r.costFromAmountU : 0);
  const models = Array.from(r.models.values()).map((m) => ({
    id: m.id,
    costU: r.costKnown ? m.costU : (derived ? m.costFromAmountU : 0),
    requests: m.requests,
    tokens: m.hit + m.miss + m.output,
    hit: m.hit,
    miss: m.miss,
    output: m.output,
  })).sort((a, b) => (b.costU - a.costU) || (b.tokens - a.tokens) || (a.id < b.id ? -1 : 1));
  return {
    costU,
    costKnown: !!r.costKnown,
    costSource: r.costKnown ? 'cost' : (derived ? 'derived' : 'none'),
    requests: r.requests,
    tokens: r.hit + r.miss + r.output,
    hit: r.hit,
    miss: r.miss,
    output: r.output,
    usageKnown: !!r.usageKnown,
    endMs: r.endMs || 0,
    models,
  };
}

/** Map<key, 内部记录> → 已归一记录数组（带 key 字段、按 key 升序） */
function resolveCells(map, keyField) {
  const out = [];
  for (const [k, r] of map) {
    const x = resolveRec(r);
    x[keyField] = k;
    if (keyField === 'h') x.d = r.d;
    out.push(x);
  }
  if (keyField === 'h') out.sort((a, b) => a.h - b.h);
  else out.sort(byDayKey);
  return out;
}

function byDayKey(a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); }

/** 逐日汇总（权威口径：有小时桶的日由小时桶求和，其余用按日行） */
function sumDayList(days) {
  const t = { costU: 0, requests: 0, tokens: 0, hit: 0, miss: 0, output: 0 };
  for (const d of days || []) {
    t.costU += d.costU; t.requests += d.requests; t.tokens += d.tokens;
    t.hit += d.hit; t.miss += d.miss; t.output += d.output;
  }
  return t;
}

/**
 * 按日合成权威日表：某天若在 `hours` 里有小时桶，就**以小时桶求和**（标 hourCovered=true），
 * 否则用按日行。两种粒度不会同时算一天，故不存在重复计数。
 * @param {Array} hours 小时桶（带 h）
 * @param {Array} dayOnly 仅按日的数据行（带 d）
 * @returns {Array}
 */
export function deriveDays(hours, dayOnly) {
  const groups = new Map();
  for (const hr of hours || []) {
    const d = beijingDayKey(hr.h);
    if (d === null) continue;
    let g = groups.get(d);
    if (!g) { g = []; groups.set(d, g); }
    g.push(hr);
  }
  const out = [];
  for (const d of dayOnly || []) if (!groups.has(d.d)) out.push(Object.assign({ hourCovered: false, hourCount: 0 }, d));
  for (const [d, list] of groups) out.push(sumHours(d, list));
  return out.sort(byDayKey);
}

/** 一天内的小时桶 → 该日的权威记录 */
function sumHours(day, list) {
  const acc = { costU: 0, costKnown: false, requests: 0, tokens: 0, hit: 0, miss: 0, output: 0, usageKnown: false, derivedSeen: false };
  const models = new Map();
  for (const hr of list) {
    acc.costU += hr.costU; acc.requests += hr.requests; acc.tokens += hr.tokens;
    acc.hit += hr.hit; acc.miss += hr.miss; acc.output += hr.output;
    if (hr.costKnown) acc.costKnown = true;
    if (hr.costSource === 'derived') acc.derivedSeen = true;
    if (hr.usageKnown) acc.usageKnown = true;
    for (const m of hr.models || []) {
      let x = models.get(m.id);
      if (!x) { x = { id: m.id, costU: 0, requests: 0, tokens: 0, hit: 0, miss: 0, output: 0 }; models.set(m.id, x); }
      x.costU += m.costU; x.requests += m.requests; x.tokens += m.tokens;
      x.hit += m.hit; x.miss += m.miss; x.output += m.output;
    }
  }
  return {
    d: day,
    hourCovered: true,
    hourCount: list.length,
    costU: acc.costU,
    costKnown: !!acc.costKnown,
    costSource: acc.costKnown ? 'cost' : (acc.derivedSeen ? 'derived' : 'none'),
    requests: acc.requests,
    tokens: acc.tokens,
    hit: acc.hit,
    miss: acc.miss,
    output: acc.output,
    usageKnown: !!acc.usageKnown,
    models: Array.from(models.values()).sort((a, b) => (b.costU - a.costU) || (b.tokens - a.tokens) || (a.id < b.id ? -1 : 1)),
  };
}

/** 旧版（v1，只有按日）数据集 → v2 结构，便于与新包合并 */
export function normalizeSync(ds) {
  if (!ds || typeof ds !== 'object' || !Array.isArray(ds.days) || !ds.days.length) return null;
  if (ds.v >= 2 && Array.isArray(ds.hours)) {
    return Object.assign({}, ds, {
      granularity: ds.granularity || (ds.hours.length ? 'hour' : 'day'),
      imports: Array.isArray(ds.imports) ? ds.imports : [],
    });
  }
  const at = Number(ds.importedAt) || 0;
  return {
    v: 2,
    importedAt: at,
    files: Array.isArray(ds.files) ? ds.files : [],
    from: ds.from || null,
    to: ds.to || null,
    windowStart: ds.windowStart,
    coveredUntil: ds.coveredUntil,
    rowCount: ds.rowCount || 0,
    otherCurrency: ds.otherCurrency || 0,
    skipped: ds.skipped || 0,
    granularity: 'day',
    totals: ds.totals || sumDayList(ds.days),
    hours: [],
    days: ds.days.map((d) => Object.assign({ hourCovered: false, hourCount: 0 }, d)),
    imports: [{ at, from: ds.from || null, to: ds.to || null, rows: ds.rowCount || 0, files: Array.isArray(ds.files) ? ds.files.slice() : [], granularity: 'day' }],
  };
}

/**
 * 把新导入的包并进已有数据集（**小时包优先**）。
 * 规则：某天只要有小时桶（任一侧），该天就以小时桶求和为准；两侧的该天日行都丢弃。
 * 其余天按日行保留（同一天两侧都有日行时，新包胜）。
 * 因为判据与导入顺序无关，所以「日包 ⊕ 小时包」两个方向的合并结果一致，重复导入也幂等。
 * @param {object|null} prevRaw 已有数据集（v1/v2 均可）
 * @param {object|null} next 新导入的数据集
 * @returns {object|null} 合并后的 v2 数据集
 */
export function mergeSync(prevRaw, next) {
  const prev = normalizeSync(prevRaw);
  if (!prev) return next || null;
  if (!next) return prev;

  const hMap = new Map();
  for (const hr of prev.hours || []) hMap.set(hr.h, hr);
  for (const hr of next.hours || []) hMap.set(hr.h, hr);
  // 有小时桶的那些天：日行一律让位（不区分新旧、不区分来自哪一侧）
  const hourDays = new Set();
  for (const h of hMap.keys()) { const d = beijingDayKey(h); if (d !== null) hourDays.add(d); }
  const dMap = new Map();
  for (const d of prev.days || []) if (!d.hourCovered && !hourDays.has(d.d)) dMap.set(d.d, d);
  for (const d of next.days || []) if (!d.hourCovered && !hourDays.has(d.d)) dMap.set(d.d, d);

  const hours = Array.from(hMap.values()).sort((a, b) => a.h - b.h);
  const dayOnly = Array.from(dMap.values()).sort(byDayKey);
  const days = deriveDays(hours, dayOnly);
  const importedAt = Math.max(Number(prev.importedAt) || 0, Number(next.importedAt) || 0) || Date.now();
  const imports = (prev.imports || []).concat(next.imports || []).slice(-20);
  const wsA = Number(prev.windowStart);
  const wsB = Number(next.windowStart);
  const windowStart = Number.isFinite(wsA) && Number.isFinite(wsB) ? Math.min(wsA, wsB) : (Number.isFinite(wsB) ? wsB : (Number.isFinite(wsA) ? wsA : null));
  const coveredUntil = Math.max(Number(prev.coveredUntil) || 0, Number(next.coveredUntil) || 0) || null;
  return {
    v: 2,
    importedAt,
    files: (next.files && next.files.length) ? next.files : (prev.files || []),
    from: days.length ? days[0].d : (next.from || prev.from || null),
    to: days.length ? days[days.length - 1].d : (next.to || prev.to || null),
    windowStart,
    coveredUntil,
    rowCount: Number.isFinite(Number(next.rowCount)) ? next.rowCount : (prev.rowCount || 0),
    otherCurrency: Number(next.otherCurrency) || 0,
    skipped: Number(next.skipped) || 0,
    granularity: hours.length ? (dayOnly.length ? 'mixed' : 'hour') : 'day',
    totals: sumDayList(days),
    hours,
    days,
    imports,
    fileName: next.fileName || prev.fileName || '',
  };
}

// ---------------------------------------------------------------- 读取辅助

/** 数据集 → 供接口返回的展示摘要（金额转元、按日展开 + 小时明细） */
export function summarize(ds) {
  if (!ds || !Array.isArray(ds.days)) return null;
  const t = ds.totals || {};
  const hours = Array.isArray(ds.hours) ? ds.hours : [];
  return {
    importedAt: ds.importedAt || null,
    files: Array.isArray(ds.files) ? ds.files : [],
    from: ds.from || null,
    to: ds.to || null,
    days: ds.days.length,
    granularity: ds.granularity || (hours.length ? 'hour' : 'day'),
    hourCount: hours.length,
    hourDays: ds.days.filter((d) => d.hourCovered).length,
    coveredUntil: ds.coveredUntil || null,
    rowCount: ds.rowCount || 0,
    otherCurrency: ds.otherCurrency || 0,
    skipped: ds.skipped || 0,
    imports: Array.isArray(ds.imports) ? ds.imports : [],
    totals: {
      cost: unitsToYuan(t.costU),
      requests: t.requests || 0,
      tokens: t.tokens || 0,
      hit: t.hit || 0,
      miss: t.miss || 0,
      output: t.output || 0,
    },
    dayRows: ds.days.map((d) => ({
      d: d.d,
      cost: unitsToYuan(d.costU),
      costKnown: !!d.costKnown,
      costSource: d.costSource || (d.costKnown ? 'cost' : 'none'),
      hourCovered: !!d.hourCovered,
      hourCount: d.hourCount || 0,
      requests: d.requests || 0,
      tokens: d.tokens || 0,
      hit: d.hit || 0,
      miss: d.miss || 0,
      output: d.output || 0,
      models: (d.models || []).map((m) => ({
        id: m.id,
        cost: unitsToYuan(m.costU),
        requests: m.requests || 0,
        tokens: m.tokens || 0,
      })),
    })),
    // 小时明细（最近 24 格，供同步面板展示今日逐小时金额；金额单位元）
    hourRows: hours.slice(-24).map((h) => ({
      h: beijingHourLabel(h.h),
      cost: unitsToYuan(h.costU),
      requests: h.requests || 0,
      tokens: h.tokens || 0,
    })),
  };
}

/** 微元 → 元（保留 8 位有效小数，供合计逐位一致） */
export function unitsToYuan(u) {
  const n = Number(u);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / UNIT;
}
