// 计价与 token 口径（纯函数，无宿主依赖，便于单测）
//
// 口径依据（2026-09-24 核实官方价格页）：
//   · 价格单位：元 / 百万 tokens；
//   · 高峰时段为基准价的 2 倍，高峰定义为北京时间周一至周五 9:00-12:00、14:00-18:00；
//   · 判定始终按北京时间，不受展示时区影响。
//
// 类型说明：本文件用 JSDoc 标注契约，可选跑 `npx -y typescript tsc --noEmit --allowJs --checkJs lib/*.js` 做静态校验。

/**
 * 单价规则表（按顺序匹配，命中即止）。
 * `exact` 命中视为**确定价**；`family` 命中视为**按族估算**；两者都不命中 → 未收录。
 * 官方改价、改名、新增型号时只改这张表（或改用配置覆盖表），不改逻辑。
 * @type {Array<{id: string, label: string, exact?: RegExp, family?: RegExp, prices: {hit: number, miss: number, output: number}}>}
 */
export const PRICE_RULES = [
  {
    id: 'deepseek-v4-pro',
    label: 'v4-pro',
    exact: /^deepseek-v4-pro$/,
    family: /^deepseek-v4-pro[-.]/,
    prices: { hit: 0.15, miss: 4.5, output: 13.5 },
  },
  {
    id: 'deepseek-flash',
    label: 'flash',
    exact: /^deepseek-flash$/,
    family: /^deepseek-(v4-)?flash[-.]/,
    prices: { hit: 0.02, miss: 1, output: 4 },
  },
];

/**
 * 内置价目表（由规则表派生，保持向后兼容）。
 * @type {Record<string, {hit: number, miss: number, output: number}>}
 */
export const MODEL_PRICES = Object.fromEntries(PRICE_RULES.map((r) => [r.id, r.prices]));

/**
 * 模型名别名表：旧名 → 现名。官方改名或下线时只改这里。
 * （内置规则只认现名，历史账本里的旧名先过这张表。）
 * @type {Record<string, string>}
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/**
 * 安全数值转换：非有限数归 0。
 * @param {*} v 任意输入
 * @returns {number} 有限数值或 0
 */
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 保留两位小数。
 * 修正经典二进制边界（`2.675→2.67`、`1.005→1.00`）：先加一个与符号同向的极小量再四舍五入，
 * 对负数同样成立（半离零舍入，如 `-1.005 → -1.01`）。
 * 限制：与真实 .xx5 边界相差 <1e-9 的值仍可能翻向 —— 金额场景可忽略，但不适合做精确十进制运算。
 * @param {number} v
 * @returns {number}
 */
export function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return n;
  const eps = (n >= 0 ? 1 : -1) * 1e-9;
  return Math.round((n + eps) * 100) / 100;
}

/**
 * 保留四位小数（金额估算需要更细的精度）。
 * 同样做符号同向的极小量修正（见 round2）；限制相同。
 * @param {number} v
 * @returns {number}
 */
export function round4(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return n;
  const eps = (n >= 0 ? 1 : -1) * 1e-9;
  return Math.round((n + eps) * 10000) / 10000;
}

/**
 * 把账本里的原始模型名归并为展示标识。
 * 先查别名表，再按前缀归并到同族；**未收录的名字原样保留**（报表里独立成项，绝不被合并或丢掉）。
 * @param {string} modelId 账本中记录的原始模型名
 * @returns {string} 归并后的模型标识
 */
export function canonicalModelId(modelId) {
  const id = String(modelId || '');
  if (!id) return 'unknown';
  if (MODEL_ALIASES[id]) return MODEL_ALIASES[id];
  if (id === 'deepseek-v4-pro') return 'deepseek-v4-pro';
  if (id.indexOf('deepseek-flash') === 0 || id.indexOf('deepseek-v4-flash') === 0) return 'deepseek-flash';
  return id;
}

/**
 * 判定是否为高峰时段（北京时间周一至周五 9:00-12:00 / 14:00-18:00）。
 * 未扣除法定节假日，节假日会略高估。
 * @param {number} epochMs 毫秒时间戳
 * @returns {boolean}
 */
export function isPeakHour(epochMs) {
  const t = new Date(epochMs + 8 * 3600 * 1000);
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = t.getUTCHours() + t.getUTCMinutes() / 60;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 解析单价：优先用配置覆盖，非法或空则回落到内置价目表。
 * @deprecated 仅供旧调用方与旧单测使用。新代码请用 `resolveModel` —— 它能把“未收录”与“确定价”区分开，
 *   而本函数对未收录型号只能回落 Flash 价（静默低估），因此生产路径不再使用。
 * @param {string} modelId 模型标识
 * @param {string} [overrideRaw] 「命中/未命中/输出」格式的覆盖值
 * @returns {{hit: number, miss: number, output: number}}
 */
export function resolvePrice(modelId, overrideRaw) {
  // 兼容旧签名：单个「命中/未命中/输出」值（不含 = 号）视为该型号的覆盖价
  if (typeof overrideRaw === 'string' && overrideRaw.trim() && overrideRaw.indexOf('=') < 0) {
    const parts = overrideRaw.split('/').map((x) => Number(x.trim()));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0)) {
      return { hit: parts[0], miss: parts[1], output: parts[2] };
    }
  }
  const r = resolveModel(modelId, overrideRaw);
  return r.prices || MODEL_PRICES['deepseek-flash'];
}

/**
 * 解析单价覆盖表。每行 `名称或前缀*=命中/未命中/输出`；`#` 开头为注释。
 * 名称以 `*` 结尾表示前缀族匹配。
 * @param {string} [raw] 多行文本
 * @returns {{exact: Record<string, {hit: number, miss: number, output: number}>, prefixes: Array<{prefix: string, prices: {hit: number, miss: number, output: number}}>, invalid: string[]}}
 */
export function parsePriceOverrides(raw) {
  const out = { exact: {}, prefixes: [], invalid: [] };
  if (typeof raw !== 'string' || !raw.trim()) return out;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.charAt(0) === '#') continue;
    const eq = text.indexOf('=');
    if (eq <= 0) { out.invalid.push(text); continue; }
    const name = text.slice(0, eq).trim();
    const nums = text.slice(eq + 1).split('/').map((x) => Number(x.trim()));
    if (!name || nums.length !== 3 || !nums.every((n) => Number.isFinite(n) && n >= 0)) { out.invalid.push(text); continue; }
    const prices = { hit: nums[0], miss: nums[1], output: nums[2] };
    if (name.endsWith('*')) out.prefixes.push({ prefix: name.slice(0, -1), prices });
    else out.exact[name] = prices;
  }
  return out;
}

/**
 * 解析型号 → 单价与来源。优先级：配置覆盖表 → **自动同步的官方价格** → 内置价目表。
 * 三级判定：
 *   exact   命中精确规则（或同步到官方价）→ 确定价
 *   family  命中族规则 → 按族估算
 *   unknown 未收录 → **不臆测价格**（prices 为 null）
 * @param {string} modelId 归并后的模型标识
 * @param {string} [overridesRaw] 配置覆盖表文本
 * @param {Record<string, {hit: number, miss: number, output: number}>} [syncedPrices] 官方价格页自动同步结果
 * @returns {{id: string, status: 'exact'|'family'|'unknown', prices: {hit: number, miss: number, output: number}|null, source: string}}
 */
export function resolveModel(modelId, overridesRaw, syncedPrices) {
  const id = String(modelId || '');
  if (!id) return { id, status: 'unknown', prices: null, source: '无型号标识' };
  const ov = parsePriceOverrides(overridesRaw);
  if (ov.exact[id]) return { id, status: 'exact', prices: ov.exact[id], source: '配置覆盖' };
  for (const p of ov.prefixes) {
    if (id.indexOf(p.prefix) === 0) return { id, status: 'family', prices: p.prices, source: '配置覆盖（前缀 ' + p.prefix + '*）' };
  }
  // 官方价格页同步到的价格优先于内置表（官方是权威来源，内置表只是离线傅底）
  const synced = syncedPrices && typeof syncedPrices === 'object' ? syncedPrices[id] : null;
  if (synced && Number(synced.hit) >= 0 && Number(synced.miss) >= 0 && Number(synced.output) >= 0) {
    return { id, status: 'exact', prices: { hit: Number(synced.hit), miss: Number(synced.miss), output: Number(synced.output) }, source: '官方价格页（自动同步）' };
  }
  for (const r of PRICE_RULES) {
    if (r.exact && r.exact.test(id)) return { id, status: 'exact', prices: r.prices, source: '内置价目表' };
  }
  for (const r of PRICE_RULES) {
    if (r.family && r.family.test(id)) return { id, status: 'family', prices: r.prices, source: '内置价目表（按族 ' + r.label + ' 估算）' };
  }
  return { id, status: 'unknown', prices: null, source: '未收录' };
}

/**
 * 从账本条目提取 token 口径，对准官方账单的三类。
 *
 * 官方三类 → 本机字段（2026-09-27 用官方 00:00 行逐值核对）：
 *   input_cache_hit_tokens  ← cache.readTokens（缓存的已写入前缀，命中）
 *   input_cache_miss_tokens ← input.uncachedTokens + cache.writeTokens（未命中缓存的新输入；
 *                            写入缓存的部分在官方口径里也按“未命中输入”计价，不能漏）
 *   output_tokens           ← output.totalTokens（官方输出已含推理 token，
 *                            本机 reasoningTokens 与之同口径，不再另外相加，避免重复计算）
 * 实测本机账本 cache.writeTokens 恒为 0、reasoningTokens 恒为 null，故两项加与不加等价；
 * 这里显式并入 write 是为了对齐官方口径、防未来账本出现该字段时低估。
 * 同时保留与 cache.missTokens 取较大者的保守策略（实测二者相等或 missTokens 更小）。
 * @param {*} entry 账本条目
 * @returns {{hit: number, miss: number, output: number, total: number}}
 */
export function entryTokens(entry) {
  const u = (entry && entry.usage) || {};
  const cache = u.cache || {};
  const input = u.input || {};
  const output = u.output || {};
  const hit = Number(cache.readTokens) > 0 ? Number(cache.readTokens) : 0;
  const uncached = Number.isFinite(Number(input.uncachedTokens)) ? Number(input.uncachedTokens) : 0;
  const write = Number.isFinite(Number(cache.writeTokens)) ? Number(cache.writeTokens) : 0;
  const rawMiss = Math.max(
    Number.isFinite(Number(cache.missTokens)) ? Number(cache.missTokens) : 0,
    uncached + write,
  );
  let miss = rawMiss;
  if (!(miss > 0)) miss = Math.max(0, Number(input.totalTokens) - hit);
  if (!Number.isFinite(miss) || miss < 0) miss = 0;
  const out = Number(output.totalTokens) > 0 ? Number(output.totalTokens) : 0;
  const total = Number(u.totalTokens);
  return { hit, miss, output: out, total: Number.isFinite(total) && total > 0 ? total : hit + miss + out };
}

/**
 * 单条用量金额（元）：token 数 / 百万 × 单价 ×（高峰 2 倍）。
 * @param {{hit: number, miss: number, output: number}} tokens
 * @param {{hit: number, miss: number, output: number}} price
 * @param {boolean} peak 是否高峰
 * @returns {number}
 */
export function costOf(tokens, price, peak) {
  const mult = peak ? 2 : 1;
  return (
    (tokens.hit / 1e6) * price.hit * mult +
    (tokens.miss / 1e6) * price.miss * mult +
    (tokens.output / 1e6) * price.output * mult
  );
}
