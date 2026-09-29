// 余额差口径（纯函数，无宿主依赖，便于单测）
//
// 定位：**旁证**，不是主口径。主口径 = token 估算（token × 官方单价 × 高峰倍数），
// 已用官方账单逐值核对（见 tests/run-all.mjs 的黄金回归）。余额差只用于交叉验证，
// 且受官方余额只有两位小数的物理限制：小额小时的差值分辨率不足，百分比无意义。
//
// 口径：
//   · routes/balance.js 每次成功取到余额时，把 { t, total, ev?, evAmt? } 写入 state.json 的小时级样本；
//   · 某小时消费 = 该小时末样本 − 上一小时末样本，**只取正数**（余额下降额）；
//   · 若该小时内检测到充值/退款/赠金事件，则累加**当时实际入账额** evAmt，
//     该小时消费 = 首样本余额 − 末样本余额 + 充值 − 退款 + 赠金（不再整块丢弃）；
//     历史样本没有 evAmt 时仍归为 null（不臆测）。
//
// 容量：只保留最近 30 天（外加条数硬上限），避免 state.json 无限增长。

/** 一小时毫秒数 */
export const HOUR_MS = 3600000;
/** 样本保留时长：30 天 */
export const SAMPLE_RETENTION_MS = 30 * 24 * HOUR_MS;
/** 条数硬上限（30 天 × 24 = 720，留余量） */
export const MAX_SAMPLES = 800;

/**
 * 把时间戳对齐到整点（小时）桶。
 * @param {number} atMs
 * @returns {number}
 */
export function hourKey(atMs) {
  return Math.floor(Number(atMs) / HOUR_MS) * HOUR_MS;
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

/** 事件类型（与 balance.js 的 EV_TYPES 一致） */
const EV_TYPES = ['recharge', 'refund', 'grant'];

/**
 * 归一化小时事件金额累计：`{recharge, refund, grant}`；全为 0 / 缺失 → null。
 * @param {any} v
 * @returns {{recharge:number,refund:number,grant:number}|null}
 */
function normEvAmt(v) {
  if (!v || typeof v !== 'object') return null;
  const o = { recharge: Number(v.recharge) || 0, refund: Number(v.refund) || 0, grant: Number(v.grant) || 0 };
  return o.recharge || o.refund || o.grant ? o : null;
}

/**
 * 把一条事件金额并入小时累计（按实际入账额）。
 * @param {{recharge:number,refund:number,grant:number}|null} prev
 * @param {{type?:string,amount?:number}|null} info
 * @returns {{recharge:number,refund:number,grant:number}|null}
 */
function mergeEvAmt(prev, info) {
  const out = normEvAmt(prev) || { recharge: 0, refund: 0, grant: 0 };
  const type = info && info.type;
  const amt = Number(info && info.amount);
  if (EV_TYPES.indexOf(type) >= 0 && Number.isFinite(amt) && amt > 0) {
    out[type] = r2(out[type] + amt);
  }
  return normEvAmt(out);
}

/**
 * 记一条余额样本（纯函数，返回新数组）。
 * 同一小时内的多次采样只保留**最后一次**（即「该小时末样本」）；只要本小时内任一次检测到事件，整小时标记事件，
 * 并把该次事件的**实际入账额**累加到该小时的 evAmt（供 hourlyCosts 还原消费）。
 * @param {Array<{t:number,total:number,ev?:boolean,evAmt?:object}>} samples 现有样本
 * @param {number} atMs 采样时刻
 * @param {number} total 该次余额（CNY 总额）
 * @param {boolean} [isEvent] 本次采样是否伴随充值/退款/赠金事件
 * @param {{type:string,amount:number}} [eventInfo] 本次事件的实际入账额（充值已按整元吸附）
 * @returns {Array<{t:number,total:number,ev?:boolean,evAmt?:object}>}
 */
export function recordSample(samples, atMs, total, isEvent, eventInfo) {
  const arr = Array.isArray(samples)
    ? samples
        .filter((s) => s && Number.isFinite(Number(s.t)) && Number.isFinite(Number(s.total)))
        .map((s) => {
          const rec = { t: Number(s.t), total: Number(s.total), ev: !!(s && s.ev) };
          const amt = normEvAmt(s && s.evAmt);
          if (amt) rec.evAmt = amt;
          return rec;
        })
    : [];
  const t = hourKey(atMs);
  const totalNum = Number(total);
  if (!Number.isFinite(t) || !Number.isFinite(totalNum)) return arr;

  const idx = arr.findIndex((s) => s.t === t);
  const evAmt = mergeEvAmt(idx >= 0 ? arr[idx].evAmt : null, eventInfo);
  if (idx >= 0) {
    arr[idx] = { t: t, total: r2(totalNum), ev: !!(arr[idx].ev || isEvent) };
    if (evAmt) arr[idx].evAmt = evAmt;
  } else {
    const rec = { t: t, total: r2(totalNum), ev: !!isEvent };
    if (evAmt) rec.evAmt = evAmt;
    arr.push(rec);
  }
  arr.sort((a, b) => a.t - b.t);

  // 容量控制：先按 30 天窗口裁剪，再按条数硬上限兜底
  const cutoff = t - SAMPLE_RETENTION_MS;
  let out = arr.filter((s) => s.t >= cutoff);
  if (out.length > MAX_SAMPLES) out = out.slice(out.length - MAX_SAMPLES);
  return out;
}

/**
 * 逐小时消费（余额差口径）。
 * 普通小时：上一小时末余额 − 本小时末余额（只取正数）。
 * 事件小时（ev=true）：用当时累加的实际入账额还原——
 *   `消费 = 首样本余额 − 末样本余额 + 充值 − 退款 + 赠金`；
 *   若缺 evAmt（历史样本）或与上一小时不相邻，则仍为 null。
 * @param {Array<{t:number,total:number,ev?:boolean,evAmt?:object}>} samples
 * @returns {Map<number, {cost: number|null, event: boolean}>} 键为该小时起始毫秒
 */
export function hourlyCosts(samples) {
  const arr = (Array.isArray(samples) ? samples : [])
    .map((s) => ({ t: Number(s.t), total: Number(s.total), ev: !!(s && s.ev), evAmt: normEvAmt(s && s.evAmt) }))
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.total))
    .sort((a, b) => a.t - b.t);
  const map = new Map();
  for (let i = 0; i < arr.length; i += 1) {
    const cur = arr[i];
    const prev = arr[i - 1];
    let cost = null;
    // 只有与上一小时相邻（差正好 1 小时）才有可比性；中间缺样本则视为不可比
    const adjacent = !!(prev && cur.t - prev.t === HOUR_MS);
    if (cur.ev) {
      // 事件小时：用实际入账额还原（缺 evAmt 的历史样本仍为 null，不臆测）
      if (adjacent && cur.evAmt) {
        const raw = prev.total - cur.total + cur.evAmt.recharge - cur.evAmt.refund + cur.evAmt.grant;
        cost = r2(Math.max(0, raw));
      }
    } else if (adjacent) {
      const decrease = prev.total - cur.total; // 余额下降 = 消费
      cost = decrease > 0 ? r2(decrease) : 0;
    }
    map.set(cur.t, { cost, event: cur.ev });
  }
  return map;
}

/**
 * 把逐小时余额差聚合到图表的桶里（无样本覆盖的桶返回 null，前端显示「—」而不是 NaN）。
 * @param {Array<{t:number,total:number,ev?:boolean}>} samples
 * @param {number} since 区间起点（毫秒）
 * @param {number} bucketMs 桶宽
 * @param {number} bucketCount 桶数
 * @returns {Array<number|null>}
 */
export function bucketBalanceCost(samples, since, bucketMs, bucketCount) {
  const costs = hourlyCosts(samples);
  const acc = new Array(bucketCount).fill(null);
  costs.forEach((info, hourT) => {
    if (info.cost === null) return;
    const mid = hourT + HOUR_MS / 2; // 用小时中点归属桶，避免边界歧义
    const idx = Math.floor((mid - since) / bucketMs);
    if (idx < 0 || idx >= bucketCount) return;
    if (acc[idx] === null) acc[idx] = 0;
    acc[idx] += info.cost;
  });
  for (let i = 0; i < acc.length; i += 1) {
    if (acc[i] !== null) acc[i] = Math.round(acc[i] * 10000) / 10000;
  }
  return acc;
}

/**
 * 双口径偏离（%）：看 token 估算相对余额差偏了多少。
 * 定义 `偏离 = (token 估算 − 余额差) / 余额差 × 100`；余额差缺失或 ≤0 时返回 null（前端显示「—」）。
 * 注意：这是**未做分辨率判定**的纯百分比；展示层请优先用 `deviationView`。
 * @param {number|null} balanceCost 余额差
 * @param {number} tokenCost token 估算
 * @returns {number|null}
 */
export function deviationPct(balanceCost, tokenCost) {
  const b = Number(balanceCost);
  const t = Number(tokenCost);
  if (!Number.isFinite(b) || b <= 0) return null;
  if (!Number.isFinite(t)) return null;
  return Math.round(((t - b) / b) * 1000) / 10;
}

/**
 * 官方余额只有两位小数，低于「5 分」的小时余额差无法分辨（差值本身就是舍入噪声）。
 * 这类样本不再给出百分比，展示层显示「分辨率不足」。
 */
export const BALANCE_RESOLUTION_MIN = 0.05;

/**
 * 双口径偏离的展示视图：把「无样本」与「有样本但分辨率不足」区分开。
 *   - 无样本 / 余额差 ≤0 → `{ pct: null, insufficient: false }`（展示「—」）
 *   - |余额差| < BALANCE_RESOLUTION_MIN → `{ pct: null, insufficient: true }`（展示「分辨率不足」）
 *   - 其余 → `{ pct: <百分比>, insufficient: false }`
 * @param {number|null} balanceCost 余额差
 * @param {number} tokenCost token 估算
 * @returns {{pct: number|null, insufficient: boolean}}
 */
export function deviationView(balanceCost, tokenCost) {
  const b = Number(balanceCost);
  if (!Number.isFinite(b) || b <= 0) return { pct: null, insufficient: false };
  if (Math.abs(b) < BALANCE_RESOLUTION_MIN) return { pct: null, insufficient: true };
  return { pct: deviationPct(b, tokenCost), insufficient: false };
}
