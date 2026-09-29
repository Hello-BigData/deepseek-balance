// DeepSeek 余额 + 用量查询 API routes
// 挂载路径：/api/plugins/deepseek-balance/api/balance
//          /api/plugins/deepseek-balance/api/usage
//          /api/plugins/deepseek-balance/api/config
//          /api/plugins/deepseek-balance/api/recharge/correct  → 已并入 /api/event/resolve
//          /api/plugins/deepseek-balance/api/event/resolve
//
// 官方事实（依据 DeepSeek 开放平台文档与价格页）：
//   · GET /user/balance 每币种返回 total_balance（可用总额）、granted_balance（未过期赠金）、
//     topped_up_balance（充值余额）。
//   · 充值余额与赠送余额同时存在时，优先扣减赠送余额。
//   · 充值余额不会过期；赠送余额有有效期（账单页可查）。
//   · 退款有两条路：用户申请的退款把剩余未消费充值金额退回原路（充值余额下降）；
//     平台补偿以赠金形式返还（赠送余额上升）。
//
// 口径：
//   自有资金净支出 = 累计充值 − 累计退款 − 当前充值余额
//     （因赠金优先扣减，充值余额只在花到自有资金时才下降，故该差值为自有资金口径）
//   API 总消耗 = 累计充值 − 累计退款 + 累计获得赠金 − 累计过期赠金 − 当前总余额
//     （赠金到账/过期金额无法从接口完整还原，因此不作为主口径，仅作参考）
//
// 余额事件检测：任何超出日常量级的余额跳变都自动入账，并在侧边栏给出一条信息性提示（不再要求确认）。
//   · 充值余额 ↑ ≥ RECHARGE_MIN_DELTA（1 元）→ recharge（自动累加累计充值）
//   · 充值余额 ↓ ≥ REFUND_MIN_DELTA（5 元）  → refund（自动累加累计退款）
//     两个方向门槛不同：上调只可能来自实际充值（消费只降不升），故取小额即可捕捉；
//     下调也可能是「花到自有资金」的日常消费，门槛过低会把消费误记成退款。
//     充值金额 = ceil(观测跳变)（消费只让观测变小 ⇒ 观测 ≤ 真实充值额）；残差 = 窗口内消费推测值；
//     残差过大（> RECHARGE_SNAP_EPS）只额外告警；退款可能因手续费而非整元，故不吸附。
//   · 赠送余额 ↑         → grant（仅记录/提示，不影响自有资金口径）
//   · 赠送余额 ↓         → 不判定（无法与赠金消耗区分；且不影响自有资金口径）
// 自动入账的值是按跳变反推的近似值，事后可在插件设置里直接改 totalRecharged / totalRefunded 手工校正。
//
// 稳定性：
//   · 余额请求带短 TTL 缓存 + single-flight，避免多面板同时轮询打爆上游；
//   · 余额状态的读改写全部落在同一个同步块内（无 await），不存在竞态；
//   · writeConfig 失败会写日志而不是静默吞掉。
//
// 安全边界：本文件运行在宿主进程内，API Key 永不下发到前端 iframe；
//   上游错误只做分类映射，不回传原始响应体。

// 计价与导出规则已抽到 lib/ 下（纯函数，可单测）。
// 必须用带时间戳的动态 import：宿主进程会缓存**静态** import 的模块，插件重装后会出现
// 「routes 新版 + lib 旧版」错位（实测报 `does not provide an export named ...`，且本地新进程测不出来）。
const PRICING = await import('../lib/pricing.js?v=' + Date.now());
const EXPORT_CSV = await import('../lib/export-csv.js?v=' + Date.now());
const PRICE_SYNC = await import('../lib/price-sync.js?v=' + Date.now());
const HOLIDAYS = await import('../lib/holidays.js?v=' + Date.now());
const BALANCE_SAMPLES = await import('../lib/balance-samples.js?v=' + Date.now());
const DIAG = await import('../lib/diag-log.js?v=' + Date.now());
const MONO = await import('../lib/mono-clock.js?v=' + Date.now());
const OFFICIAL_SYNC = await import('../lib/official-sync.js?v=' + Date.now());
const USAGE_ARCHIVE = await import('../lib/usage-archive.js?v=' + Date.now());
const { PRICE_PAGE_URL, PRICE_SYNC_TTL_MS, priceSyncDue, parsePricePage } = PRICE_SYNC;
const { isPeakAt, isPeakDay, buildHolidaySet, holidayCoverage, buildPeakTickMask, beijingDayKey, PEAK_RULE_BUILTIN } = HOLIDAYS;
const { recordSample, bucketBalanceCost, deviationView } = BALANCE_SAMPLES;
const {
  MODEL_PRICES,
  num,
  round2,
  round4,
  canonicalModelId,
  isPeakHour,
  resolveModel,
  entryTokens,
} = PRICING;
const {
  EXPORT_MAX_CHARS,
  RANGE_SLUGS,
  isAbsolutePath,
  pathSep,
  isIsoDate,
  buildExportStem,
} = EXPORT_CSV;
import fs from 'node:fs';
import path from 'node:path';

const RECHARGE_MIN_DELTA = 1; // 判定「充值」的余额上调阈值（元）：上调只可能来自实际充值，取小额即可捕捉
const REFUND_MIN_DELTA = 5; // 判定「退款」的余额下调阈值（元）：下调也可能是花到自有资金的日常消费，须高于日常量级
const RECHARGE_SNAP_EPS = 0.2; // 充值反推值与整元的差在此以内 → 判为轮询窗口内的消费，按整元记账（官方只允许充正整数）
// 退款判定最长采样间隔（毫秒）：余额下调既是「退款」也可能是「花到自有资金」的消费，
// 窗口越长、窗口内累计消费越大，越容易越过退款门槛。仅对退款方向生效（充值/赠金为上调，见下）。
const REFUND_GAP_MAX_MS = 30 * 60 * 1000;
// 同源去重窗口（毫秒）：累计值写成功、但基线推进丢失（进程重启/写盘失败）时，
// 下一次轮询会看到同一跳变；在窗口内且基线未前移时判为重复，只前移基线不再累加。
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
// 上游数值护栏（P2）：只判 finite 不够 —— 负值/超大值会直接进事件判定并污染基线。
// 上限取 1e9（远高于任何真实余额，又远低于 1e12 这类明显损坏值）；前端那个 MAX_AMOUNT 是前端常量，这里另立。
const MAX_BALANCE_VALUE = 1e9;
// 余额取数：显式超时（不依赖宿主默认）+ 瞬时失败退避重试一次
const BALANCE_FETCH_TIMEOUT_MS = 10000;
const BALANCE_RETRY_BACKOFF_MS = 250;
// 导出落盘超时（避免 resources.write 挂住请求）
const EXPORT_WRITE_TIMEOUT_MS = 15000;

/**
 * 充值反推：余额上调只可能来自充值，而**消费只会让观测量变小** ⇒ 观测跳变 ≤ 真实充值额 ⇒ 取 **ceil**。
 * `4.07 → 5`（真充 5、窗口内消费 0.07）、`2.99 → 3`、`5.001 → 6`、`6.00 → 6`。
 * `1e-9` 直接减在入参上（防浮点噪声把 4.0000000001 抬成 5）；**不再先 round2** ——
 * 若先 round2，`5.001` 会被截成 `5.00` 反而漏 1 元（生产侧入参本就是 round2 后的 dTop，故等价）。
 * 物理边界：若真充值 6、窗口内消费 1.02（观测 4.98），仍会低入 1 元 —— 反推口径无法消除（见 README）。
 * @param {number} delta 余额上调的反推值
 * @returns {number} 实际入账金额（整数）
 */
export function snapRechargeYuan(delta) {
  return Math.ceil(Number(delta) - 1e-9);
}

/**
 * 吸附残差 = **窗口内消费推测值** = booked − delta（≥0）。
 * 供告警与事件提示用；> RECHARGE_SNAP_EPS 时告警（窗口内消费异常大）。
 * @param {number} delta
 * @returns {number}
 */
export function rechargeResidual(delta) {
  return round2(snapRechargeYuan(delta) - Number(delta));
}

/**
 * 余额数值是否在合理范围（上游护栏）：有限、非负、不超过量级上限。
 * @param {*} v
 * @returns {boolean}
 */
export function isBalanceAmount(v) {
  return Number.isFinite(v) && v >= 0 && v <= MAX_BALANCE_VALUE;
}

/**
 * 严格数值入参：只接受有限 number，或**非空数字串**；`null`/`''`/`[]`/`true` 一律非法。
 * 为什么：`Number(null)===0`、`Number('')===0` 会把“空值”静默当成 0
 * （时区 0=UTC、预警阈值 0=关预警），必须显式拒绝。
 * @param {*} v
 * @returns {boolean}
 */
export function isStrictNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && Number.isFinite(Number(v));
  return false;
}

/**
 * 单条账本条目的估算成本（**token 估算的唯一口径**，供 /api/stats 与官方同步的差集回推共用）。
 * @param {*} entry 账本条目
 * @param {number} atMs startedAt 的毫秒时间戳
 * @param {string} overridesRaw 单价覆盖表
 * @param {Record<string, {hit:number,miss:number,output:number}>} syncedPrices 同步价
 * @param {number} calibration 校准系数
 * @param {Set<string>|string[]|string} extraHolidays 节假日集合
 * @returns {{modelId:string, info:object, priced:boolean, peak:boolean, tk:object, costHit:number, costMiss:number, costOut:number, cost:number}}
 */
export function computeEntryCost(entry, atMs, overridesRaw, syncedPrices, calibration, extraHolidays) {
  const modelId = canonicalModelId(entry.model.modelId);
  const info = resolveModel(modelId, overridesRaw, syncedPrices);
  const price = info.prices;
  const priced = price !== null;
  const peak = isPeakAt(atMs, extraHolidays);
  const mult = peak ? 2 : 1;
  const tk = entryTokens(entry);
  const costHit = priced ? ((tk.hit * price.hit * mult) / 1e6) * calibration : 0;
  const costMiss = priced ? ((tk.miss * price.miss * mult) / 1e6) * calibration : 0;
  const costOut = priced ? ((tk.output * price.output * mult) / 1e6) * calibration : 0;
  return { modelId, info, priced, peak, tk, costHit, costMiss, costOut, cost: costHit + costMiss + costOut };
}

/** 金额保留八位小数（对账输出用；官方金额是 8 位小数）。 */
export function round8(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e8) / 1e8 : n;
}

/**
 * 展示时区偏移的**纯核心**（便于单测）：查询参数 > 插件设置 > 本机。
 * `-1` 是「跟随本机」哨兵，不能当有效偏移（否则会得到 GMT-0:01 这种假偏移）。
 * @param {*} rawTz 查询参数
 * @param {*} configTz 插件设置 timezoneOffsetMinutes
 * @param {number} localMinutes 本机偏移（`-new Date().getTimezoneOffset()`）
 * @returns {number}
 */
export function pickTzMinutes(rawTz, configTz, localMinutes) {
  const v = Number(rawTz);
  if (Number.isFinite(v) && v >= -720 && v <= 840 && v !== -1) return v;
  const c = Number(configTz);
  if (Number.isFinite(c) && c >= -720 && c <= 840 && c !== -1) return c;
  const l = Number(localMinutes);
  return Number.isFinite(l) ? l : 0;
}

/**
 * 给 promise 套超时：超时后 reject（并释放本条链的等待），settle 时清理定时器。
 * 注意：它不会取消底层 promise（JS 无此能力），但调用方的 single-flight 会因 reject 而释放，
 * 后续并发轮询不会再挂在同一条已超时的链上。
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<any>}
 */
export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
const BALANCE_CACHE_TTL_MS = 3000; // 余额结果缓存时长（毫秒），用于合并并发轮询
const UPSTREAM_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const PEAK_RULE_KEY = 'peakRuleText'; // 当前展示的高峰规则文案
const PEAK_RULE_EXTRACTED_KEY = 'peakRuleExtracted'; // 上次从页面提取到的值（用于比对“真变化”）
const PEAK_RULE_CHANGED_KEY = 'peakRuleChangedAt'; // 最近一次真实替换的时间戳
const BALANCE_SAMPLES_KEY = 'balanceSamples'; // 余额差口径的小时级样本键名
const LAST_CHECK_AT_KEY = 'lastBalanceCheckAt'; // 上次成功采样并处理完的毫秒时间戳（退款间隔守卫用）
const BOOKED_TYPE_KEY = 'lastBookedType'; // 上次入账类型（同源去重用）
const BOOKED_AMOUNT_KEY = 'lastBookedAmount'; // 上次入账的实际金额（吸附后）
const BOOKED_AT_KEY = 'lastBookedAt'; // 上次入账时间戳
const BOOKED_PREV_TOP_KEY = 'lastBookedPrevTop'; // 上次入账前的充值余额基线
const BOOKED_NEW_TOP_KEY = 'lastBookedNewTop'; // 上次入账后的充值余额基线
const EVENT_PERSIST_FAILED_KEY = 'lastEventPersistFailed'; // 事件提示：累计值是否未落盘
const EVENT_SNAP_RESIDUAL_KEY = 'lastEventSnapResidual'; // 事件提示：充值按整元吸附后的残差（元）
const HOLIDAY_WARN_DAY_KEY = 'holidayWarnDay'; // 节假日表未覆盖年份时的告警去重（按北京日）

const EVENT_TYPES = ['recharge', 'refund', 'grant'];

export default function (app, ctx) {
  // ---------------------------------------------------------------- 基础设施

  // 插件自有诊断日志目录（与 state.json 同目录）。实测宿主 ctx.log 只会被并进**调用方 Agent 的会话记录**
  // （sessions/*.jsonl），用户故障时读不到；因此这里**双写**：一份给 ctx.log（会话留痕），一份落
  // diagnostics.log（用户可读，可经 GET /api/diagnostics 读回）。
  const DIAG_DIR = (ctx && typeof ctx.dataDir === 'string') ? ctx.dataDir : '';

  function log(level, message, source) {
    try {
      const logger = ctx && ctx.log;
      const fn = logger && (typeof logger[level] === 'function' ? logger[level] : logger.log);
      if (typeof fn === 'function') fn.call(logger, '[deepseek-balance] ' + message);
    } catch (e) {
      // 日志不可用时忽略，不能因为日志影响主流程
    }
    // 双写：落到插件自有 diagnostics.log（appendDiagnostic 永不自抛）
    try { DIAG.appendDiagnostic(DIAG_DIR, level, source || 'route', message); } catch (e) { /* 忽略 */ }
  }

  function readConfig(key) {
    try {
      if (ctx && ctx.config && typeof ctx.config.get === 'function') {
        return ctx.config.get(key);
      }
    } catch (e) {
      log('warn', 'read config "' + key + '" failed: ' + e.message);
    }
    return undefined;
  }

  function writeConfig(key, value) {
    try {
      if (ctx && ctx.config && typeof ctx.config.set === 'function') {
        ctx.config.set(key, value);
        return true;
      }
    } catch (e) {
      log('warn', 'write config "' + key + '" failed: ' + e.message);
    }
    return false;
  }

  // 读配置里的数值：缺失/非法回落**默认值**（避免 num(undefined)=0 把「缺省」误报成 0）。
  function cfgNumberOr(key, dflt, min, max) {
    const raw = readConfig(key);
    if (raw === undefined || raw === null || raw === '') return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n)) return dflt;
    if (min !== undefined && n < min) return dflt;
    if (max !== undefined && n > max) return dflt;
    return n;
  }

  // ---------------------------------------------------------------- 官方同步与历史基准
  // 官方导出的用量包（zip/csv）解析后整理成「北京日 × 型号」的权威账，存进 state.officialSync；
  // 侧栏累计与详情页在此基础上把本机账本「官方已覆盖的那一段」剔掉，避免重复计数。
  const OFFICIAL_SYNC_KEY = 'officialSync';

  // 读回官方同步数据集（旧版 v1 自动迁移为 v2）；窗口非法时退化为「无同步」
  // （宁可只显示本机，也不乱删数据）。
  // 返回的 covers(at) 是「该时刻是否已被官方数据覆盖」的唯一谓词：小时桶所在的日只认表内
  // 存在的小时格，仅按日的日整日有效。聚合时本机条目落在 covers 内就剔除（由官方代表）。
  function readOfficialSync() {
    const v = OFFICIAL_SYNC.normalizeSync(stateGet(OFFICIAL_SYNC_KEY));
    if (!v || !v.days.length) return null;
    let start = Number(v.windowStart);
    if (!Number.isFinite(start)) {
      const s = OFFICIAL_SYNC.dayKeyStartMs(v.from);
      start = s === null ? NaN : s;
    }
    const until = Number(v.coveredUntil);
    if (!Number.isFinite(start) || !Number.isFinite(until)) return null;

    const hours = new Map(); // 北京整点起点（ms）→ 小时桶
    for (const h of v.hours || []) {
      const k = Number(h && h.h);
      if (Number.isFinite(k)) hours.set(k, h);
    }
    const dayOnly = new Map(); // 北京日 → 仅按日的行
    const hourDays = new Set(); // 有小时桶的北京日（这些日以小时为准）
    for (const d of v.days) {
      if (d.hourCovered) hourDays.add(d.d);
      else dayOnly.set(d.d, d);
    }

    const covers = (at) => {
      if (!Number.isFinite(at) || at >= until) return false;
      const h = OFFICIAL_SYNC.hourStartMs(at);
      if (h !== null && hours.has(h)) return true;
      const day = OFFICIAL_SYNC.beijingDayKey(at);
      if (day === null || hourDays.has(day) || !dayOnly.has(day)) return false;
      const end = OFFICIAL_SYNC.dayKeyEndMs(day);
      return end === null || at < end;
    };

    return {
      ds: v,
      start,
      until,
      hours,
      dayOnly,
      hourDays,
      requests: num(v.totals && v.totals.requests),
      tokens: num(v.totals && v.totals.tokens),
      cost: OFFICIAL_SYNC.unitsToYuan(v.totals && v.totals.costU),
      covers,
    };
  }

  // 历史基准（本机账本之外的人工校正）：补上重装/清账前已经发生、但本机无从统计的累计量。
  function baselineNumbers() {
    return {
      requests: Math.max(0, Math.round(cfgNumberOr('usageBaselineRequests', 0, 0, 1e12))),
      tokens: Math.max(0, Math.round(cfgNumberOr('usageBaselineTokens', 0, 0, 1e15))),
    };
  }

  // 该时刻是否落在「官方已覆盖」的范围内（在内则本机条目已被官方数据代表，聚合时要剔除）。
  function inOfficialWindow(at, off) {
    if (!off || !Number.isFinite(at)) return false;
    return off.covers ? off.covers(at) : (at >= off.start && at < off.until);
  }

  // 官方小时桶按北京日归拢（供 /api/stats 按钟点拆官方金额与高峰）；无小时数据时是空表。
  function officialHourIndex(off) {
    const byDay = new Map();
    if (!off) return byDay;
    for (const hr of off.ds.hours || []) {
      const d = OFFICIAL_SYNC.beijingDayKey(Number(hr && hr.h));
      if (d === null) continue;
      let g = byDay.get(d);
      if (!g) { g = []; byDay.set(d, g); }
      g.push(hr);
    }
    return byDay;
  }

  // ---------------------------------------------------------------- 内部状态存储
  // 余额基准与待确认事件是插件自己维护的运行状态，不是用户配置，
  // 因此放在插件自有目录（ctx.dataDir），让设置界面只留用户真正会改的项。
  // 旧版本把它们写在配置里，这里做一次性迁移（首次读不到 state.json 时从旧键取）。
  const STATE_FILE = (function () {
    try {
      const dir = ctx && typeof ctx.dataDir === 'string' && ctx.dataDir ? ctx.dataDir : '';
      return dir ? path.join(dir, 'state.json') : '';
    } catch (e) {
      return '';
    }
  })();
  // 一次性迁移清单（旧版把运行状态写在配置里 → 首次升级搬到 state.json）。
  // 这个清单**刻意是空的**：
  //   · lastToppedUpBalance / lastGrantedBalance 是「上一次测量值」，不是用户设置 ——
  //     state.json 丢失后若从配置回填陈旧基线，会与当前真实余额形成一次虚假跳变，
  //     被误判成充值/退款并把累计值改坏（审计 P0-01，本次要掐掉的就是这条路）。
  //   · lastEventType / lastEventAmount / lastEventAt 只是「待展示的信息性提示」：
  //     入账结果早已落在配置的 totalRecharged / totalRefunded，state 丢失后重放一条陈旧提示
  //     只会造成重复提示，对判定与金额均无影响，故同样丢弃、等下一次真实事件自然重建。
  const LEGACY_STATE_KEYS = [];
  // 仅用于「发现陈旧基线时给出可观测日志」，不参与迁移。
  const STALE_BASELINE_KEYS = ['lastToppedUpBalance', 'lastGrantedBalance'];
  let memState = null;
  // 本进程**这次真正改过**的键。落盘时只把这些键覆盖到磁盘副本上（见 saveState）。
  const dirtyKeys = new Set();

  // 只写脏键：落盘前先读盘，**只把 dirtyKeys 覆盖到磁盘副本上**，其余键一律保留磁盘值。
  // 这样任何「不是本进程这次改的」键（工具写的 alertState/lastAlertPushAt、未来别的写者的键）
  // 都会被原样保留 —— 不再依赖「谁拥有哪个键」，也不会用内存陈旧副本覆盖磁盘。
  // 历史教训（线上巡检发现）：曾经的写法是「先读盘、再整体合并内存副本」，方向是**内存赢**；
  // 路由从不更新 alertState，于是每轮落盘都把工具刚写的 alertState=1 抹回 0，
  // 导致余额预警每 10 分钟重复推送一次（契约是「跌破即推一次、不按间隔重推」）。
  function saveState() {
    if (!STATE_FILE) return;
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      let disk = {};
      try {
        const cur = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (cur && typeof cur === 'object' && !Array.isArray(cur)) disk = cur;
      } catch (e) { disk = {}; }
      const merged = Object.assign({}, disk);
      for (const k of dirtyKeys) {
        if (memState && Object.prototype.hasOwnProperty.call(memState, k)) merged[k] = memState[k];
      }
      // tmp 名带 pid + 随机串：路由与工具共用同一 state.json，固定 '.tmp' 名跨进程并发写会互相覆盖。
      const tmp = STATE_FILE + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
      // 写入后回读校验，失败重试一次（原子写应不会发生，防意外截断）
      try { JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e2) {
        fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
        fs.renameSync(tmp, STATE_FILE);
      }
      memState = merged;
      dirtyKeys.clear();
    } catch (e) {
      log('warn', 'state write failed: ' + (e && e.message));
    }
  }

  function loadState() {
    if (memState) return memState;
    let disk = {};
    if (STATE_FILE) {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        disk = parsed;
      } else {
        // 文件缺失/损坏：从旧配置键做一次性迁移（当前 LEGACY_STATE_KEYS 为空，不会触发写盘）。
        for (const k of LEGACY_STATE_KEYS) {
          const v = readConfig(k);
          if (v !== undefined && v !== null && v !== '') { disk[k] = v; dirtyKeys.add(k); }
        }
        // 陈旧余额基线只记一笔日志，绝不回填（回填即产生虚假跳变 → 假充值/假退款）。
        for (const k of STALE_BASELINE_KEYS) {
          const v = readConfig(k);
          if (v !== undefined && v !== null && v !== '') {
            log('info', 'legacy baseline "' + k + '" in config ignored (measurement, not setting; avoided stale jump)');
          }
        }
      }
    }
    memState = disk;
    if (dirtyKeys.size) { saveState(); log('info', 'state migrated from legacy config keys'); }
    return memState;
  }

  function stateGet(key) {
    const s = loadState();
    if (Object.prototype.hasOwnProperty.call(s, key)) return s[key];
    return STATE_FILE ? undefined : readConfig(key);
  }

  function stateSet(key, value) {
    const s = loadState();
    s[key] = value;
    if (STATE_FILE) { dirtyKeys.add(key); saveState(); }
    else writeConfig(key, value);
  }

  // 规则文案清洗：去掉开头的 (n)/（n） 序号、压缩空白。
  function normalizeRuleText(s) {
    return String(s || '')
      .replace(/^[\s(（]*\d+[)）]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 当前展示的高峰规则文案：默认内置段；只有发生过真实变化（见 syncPrices）才会被替换。
  // 读不到就是内置文案（fail-soft，绝不把提示框清空）。
  function readPeakRuleText() {
    try {
      const v = normalizeRuleText(stateGet(PEAK_RULE_KEY));
      if (v) return v;
    } catch (e) { /* 读不到就用内置 */ }
    return PEAK_RULE_BUILTIN;
  }

  // 一次性迁移：历史版本把页面原句（可能带 (2)）直接写进了 peakRuleText。
  // 若从未记录过“真实变化”（无 peakRuleExtracted，或提取值与展示值一致且无替换时间戳）→ 显示值回到内置段。
  (function migratePeakRuleText() {
    let text = '';
    try { text = normalizeRuleText(stateGet(PEAK_RULE_KEY)); } catch (e) { text = ''; }
    if (!text || text === PEAK_RULE_BUILTIN) return;
    let extracted = '';
    let changedAt = 0;
    try { extracted = normalizeRuleText(stateGet(PEAK_RULE_EXTRACTED_KEY)); } catch (e) { extracted = ''; }
    try { changedAt = num(stateGet(PEAK_RULE_CHANGED_KEY)); } catch (e) { changedAt = 0; }
    const noRealChange = !extracted || (extracted === text && !changedAt);
    if (noRealChange) {
      stateSet(PEAK_RULE_KEY, PEAK_RULE_BUILTIN);
      log('info', 'peak rule text reset to builtin (no real change recorded)');
    } else {
      const stored = stateGet(PEAK_RULE_KEY);
      if (typeof stored !== 'string' || normalizeRuleText(stored) !== stored) stateSet(PEAK_RULE_KEY, text);
    }
  })();

  // ---------------------------------------------------------------- 余额不足预警
  // 判定与节奏统一由工具 tools/balance-alert.js 承担（定时任务调用它，再用宿主 notify 投递微信）。
  // 这里曾有一份重复实现（balanceAlert()）与 GET /api/notify-due 路由，已删除，避免两份状态机各自漂移。

  // 价格覆盖表：优先用新表。首次运行时把旧的 priceFlash / pricePro 平滑迁成表里的一行（旧键保留不删，便于回滚）。
  (function migratePriceOverrides() {
    const current = readConfig('priceOverrides');
    if (typeof current === 'string' && current.trim()) return;
    const lines = [];
    const flash = readConfig('priceFlash');
    const pro = readConfig('pricePro');
    if (typeof flash === 'string' && flash.trim()) lines.push('deepseek-flash=' + flash.trim());
    if (typeof pro === 'string' && pro.trim()) lines.push('deepseek-v4-pro=' + pro.trim());
    if (!lines.length) return;
    if (writeConfig('priceOverrides', lines.join('\n'))) {
      log('info', '价格覆盖表已从 priceFlash/pricePro 迁移：' + lines.join(' | '));
    }
  })();

  // ---------------------------------------------------------------- 官方价格自动同步
  // 目标：新模型/改价自动跟上，不要求用户手工填单价。
  // 做法：抓官方价格页 → 结构化校验（高峰必须等于空闲×2）→ 覆盖内置价目表。
  // 任何失败都 fail-soft：保留内置表并把原因带回前端，绝不用半成品数据。
  let priceSync = { at: 0, monoAt: 0, ok: false, models: {}, reason: '尚未同步', url: PRICE_PAGE_URL };

  // 官方价格页的型号清单变动检测：把「定时抓新闻、叫模型判断」的职责搬回本地，零模型调用。
  // 基线存 state.json（priceSync 是内存变量，重启即丢）；首次同步只建基线不报变动，避免装完就假警。
  const PRICE_MODELS_KEY = 'priceModels';
  const PRICE_CHANGE_KEY = 'priceChange';
  function recordPriceModels(ids) {
    const list = Array.isArray(ids) ? ids.slice().sort() : [];
    let baseline = null;
    try { baseline = stateGet(PRICE_MODELS_KEY); } catch (e) { baseline = undefined; }
    if (Array.isArray(baseline)) {
      const before = baseline.slice().sort();
      const added = list.filter((x) => before.indexOf(x) < 0);
      const removed = before.filter((x) => list.indexOf(x) < 0);
      if (added.length || removed.length) {
        stateSet(PRICE_CHANGE_KEY, { at: Date.now(), added: added, removed: removed });
        log('info', 'price models changed: +[' + added.join(', ') + '] -[' + removed.join(', ') + ']');
      }
    }
    stateSet(PRICE_MODELS_KEY, list);
  }

  function readPriceChange() {
    try {
      const v = stateGet(PRICE_CHANGE_KEY);
      return v && typeof v === 'object' ? v : null;
    } catch (e) { return null; }
  }

  async function syncPrices(force) {
    // 到期判定用单调时钟；失败用短 TTL（10min）重试，成功才 12h。
    if (!priceSyncDue(priceSync.ok, priceSync.monoAt, MONO.monoNow(), force)) return priceSync;
    try {
      const res = await ctx.network.fetch(PRICE_PAGE_URL, { method: 'GET' });
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      const html = await res.text();
      const parsed = parsePricePage(html);
      if (!parsed.ok) {
        priceSync = { at: Date.now(), monoAt: MONO.monoNow(), ok: false, models: {}, reason: parsed.reason, url: PRICE_PAGE_URL };
        log('warn', 'price sync failed: ' + parsed.reason);
      } else {
        priceSync = { at: Date.now(), monoAt: MONO.monoNow(), ok: true, models: parsed.models, reason: '', url: PRICE_PAGE_URL };
        log('info', 'price sync ok (' + Object.keys(parsed.models).length + '): ' + Object.keys(parsed.models).join(', '));
        recordPriceModels(Object.keys(parsed.models));
        // 同步「高峰/空闲时段」规则句：只有与“上次提取到的”不同（真变化）才替换显示值；
        // 首次同步只建基线不改显示；提取失败则保持当前显示值（fail-soft）。
        const raw = normalizeRuleText(parsed.peakRule);
        if (raw) {
          let lastExtracted = '';
          try { lastExtracted = normalizeRuleText(stateGet(PEAK_RULE_EXTRACTED_KEY)); } catch (e) { lastExtracted = ''; }
          if (!lastExtracted) {
            stateSet(PEAK_RULE_EXTRACTED_KEY, raw);
            log('info', 'peak rule baseline established (display keeps builtin)');
          } else if (raw !== lastExtracted) {
            stateSet(PEAK_RULE_KEY, raw);
            stateSet(PEAK_RULE_EXTRACTED_KEY, raw);
            stateSet(PEAK_RULE_CHANGED_KEY, Date.now());
            log('info', 'peak rule text changed and replaced (' + raw.length + ' chars)');
          }
        } else {
          log('info', 'peak rule text not found on price page; keep current');
        }
      }
    } catch (e) {
      priceSync = { at: Date.now(), monoAt: MONO.monoNow(), ok: false, models: {}, reason: String((e && e.message) || e), url: PRICE_PAGE_URL };
      log('warn', 'price sync error: ' + priceSync.reason);
    }
    return priceSync;
  }

  // 启动即后台同步一次（不阻塞任何请求）；之后按 TTL 定时刷新
  syncPrices(true);
  setInterval(() => { syncPrices(false); }, PRICE_SYNC_TTL_MS);

  // 单价解析交给纯函数 resolveModel：区分 确定价 / 按族估算 / 未收录，不再把未知型号静默当 Flash 算。
  function priceOf(modelId, overridesRaw, syncedPrices) {
    const r = resolveModel(modelId, overridesRaw, syncedPrices);
    return r.prices || null;
  }

  // 余额请求合并：短 TTL 缓存 + single-flight
  let balanceCache = { keyTag: null, at: 0, payload: null };
  let balanceInFlight = null;

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  // 单次余额取数：显式超时（不依赖宿主默认），瞬时失败（超时/网络异常）退避重试一次。
  async function fetchBalanceOnce(apiKey) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await withTimeout(
          ctx.network.fetch(UPSTREAM_BALANCE_URL, {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
            timeoutMs: BALANCE_FETCH_TIMEOUT_MS, // 显式传给宿主（若支持；不支持则靠上面的 withTimeout 兜住）
          }),
          BALANCE_FETCH_TIMEOUT_MS,
          'balance fetch',
        );
        let body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        return { status: res.status, ok: !!res.ok, body };
      } catch (e) {
        lastErr = e;
        // 只对「没有响应」的瞬时错误重试一次；拿到响应（含 4xx/5xx）不重试
        if (attempt === 0) { await sleep(BALANCE_RETRY_BACKOFF_MS); continue; }
      }
    }
    throw lastErr || new Error('balance fetch failed');
  }

  async function fetchBalance(apiKey) {
    if (balanceCache.payload && balanceCache.keyTag === apiKey && MONO.isFresh(balanceCache.at, BALANCE_CACHE_TTL_MS, MONO.monoNow())) {
      return balanceCache.payload;
    }
    if (balanceInFlight) return balanceInFlight;

    balanceInFlight = (async () => {
      try {
        const payload = await fetchBalanceOnce(apiKey);
        if (payload.ok) balanceCache = { keyTag: apiKey, at: MONO.monoNow(), payload };
        return payload;
      } finally {
        // 关键：无论成功、异常还是超时，都释放 single-flight，避免后续并发轮询挂在同一条链上
        balanceInFlight = null;
      }
    })();

    return balanceInFlight;
  }

  // 上游错误分类，避免把原始响应体透给前端。每条都带一句可操作的「下一步」。
  function mapUpstreamError(status) {
    if (status === 401 || status === 403) {
      return { error: 'invalid_key', message: 'API Key 无效或已被拒绝；请到「设置 → 插件 → DeepSeek API 可用余额」核对 Key，或到官方平台重新生成。' };
    }
    if (status === 402) {
      return { error: 'insufficient_balance', message: '账户可用余额不足，DeepSeek 拒绝了本次请求；请到官方平台充值后重试。' };
    }
    if (status === 429) {
      return { error: 'rate_limited', message: '请求过于频繁；请稍后重试（也可把自动刷新间隔调大）。' };
    }
    if (status >= 500) {
      return { error: 'upstream_error', message: 'DeepSeek 服务暂时不可用（HTTP ' + status + '）；请稍后重试，并到官方状态页确认服务是否正常。' };
    }
    return { error: 'upstream_error', message: '查询余额失败（HTTP ' + status + '）；请检查网络后重试。' };
  }

  // 优先取 CNY，其次取第一个字段齐全的币种
  function pickBalanceInfo(body) {
    const infos = body && body.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0) return null;
    // 只做「字段存在」的形状判断；数值合法性（非负 / 量级）交给调用方的护栏统一判定，
    // 这样 NaN/Infinity/负值/超大值都能走到护栏、得到精确的 bad_response + warn。
    const readable = (info) => !!info
      && info.total_balance !== undefined && info.total_balance !== null
      && info.topped_up_balance !== undefined && info.topped_up_balance !== null;
    for (const info of infos) {
      if (info && info.currency === 'CNY' && readable(info)) return info;
    }
    for (const info of infos) {
      if (readable(info)) return info;
    }
    return null;
  }

  // ------------------------------------------------------------ 余额事件维护

  function readEvent() {
    const type = String(stateGet('lastEventType') || '');
    const amount = num(stateGet('lastEventAmount'));
    const at = num(stateGet('lastEventAt'));
    if (!EVENT_TYPES.includes(type) || !(at > 0)) return null;
    // persistFailed：本次入账的累计值是否没写进配置（写入失败 → 下次轮询重试）。
    // snapResidual：充值按整元吸附时留下的残差（>0 时前端会标注）。
    return { type, amount, at, persistFailed: !!stateGet(EVENT_PERSIST_FAILED_KEY), snapResidual: num(stateGet(EVENT_SNAP_RESIDUAL_KEY)) };
  }

  function pendingEvent() {
    // **常驻直到被关闭**（不再按时间窗自动失效）：关闭（点 × / 点弹窗外）会调
    // /api/event/resolve 清空它，之后不再重弹；下次又有新的自动修正事件会重新弹出。
    // 触发与状态管理未变（仍写 state.json 的 lastEventType/Amount/At，无新持久化）。
    return readEvent();
  }

  function setEvent(type, amount, persistFailed, snapResidual) {
    stateSet('lastEventType', type);
    stateSet('lastEventAmount', round2(amount));
    stateSet('lastEventAt', Date.now());
    stateSet(EVENT_PERSIST_FAILED_KEY, !!persistFailed);
    stateSet(EVENT_SNAP_RESIDUAL_KEY, num(snapResidual));
  }

  function clearEvent() {
    stateSet('lastEventType', '');
    stateSet('lastEventAmount', 0);
    stateSet('lastEventAt', 0);
    stateSet(EVENT_PERSIST_FAILED_KEY, false);
    stateSet(EVENT_SNAP_RESIDUAL_KEY, 0);
  }

  // 用一次余额采样推进状态：同步执行（无 await），因此不会出现读改写竞态
  // 返回本次检测到的事件类型（无事件返回 null）
  // 备注：实际入账额同时写入 lastBookedEvent，供余额样本累计 evAmt。
  let lastBookedEvent = null;
  // 同源去重：上一次入账的「类型 + 吸附后金额」与本次相同、间隔在窗口内、
  // **且基线仍停在上次入账前**（说明上次「累计已写、基线没写」）→ 判为重复，只前移基线不再累加。
  // 为什么还要比对基线：若基线已正常前移，同类型同额度的二次跳变就是**真实的第二笔**
  // （例如 15 分钟内真的充了两次 ¥10），不应被误吞。
  function isDuplicateBooking(type, amount, nowMs, prevTop) {
    const dt = String(stateGet(BOOKED_TYPE_KEY) || '');
    const da = num(stateGet(BOOKED_AMOUNT_KEY));
    const dat = num(stateGet(BOOKED_AT_KEY));
    const dprev = num(stateGet(BOOKED_PREV_TOP_KEY));
    return dt === type
      && Math.abs(da - amount) < 1e-9
      && dat > 0 && (nowMs - dat) <= DUPLICATE_WINDOW_MS
      && Math.abs(dprev - prevTop) < 1e-9;
  }

  function recordBooked(type, amount, nowMs, prevTop, newTop) {
    stateSet(BOOKED_TYPE_KEY, type);
    stateSet(BOOKED_AMOUNT_KEY, round2(amount));
    stateSet(BOOKED_AT_KEY, nowMs);
    stateSet(BOOKED_PREV_TOP_KEY, round2(prevTop));
    stateSet(BOOKED_NEW_TOP_KEY, round2(newTop));
  }

  function applyBalanceSample(toppedUp, granted) {
    lastBookedEvent = null;
    const nowMs = Date.now();
    // 采样间隔：上一次成功采样到现在。缺失（升级后首次）或过久 → 退款判定保守跳过。
    const lastCheckRaw = stateGet(LAST_CHECK_AT_KEY);
    const lastCheck = num(lastCheckRaw);
    const gapMs = (lastCheckRaw != null && lastCheck > 0) ? (nowMs - lastCheck) : null;

    const prevTopRaw = stateGet('lastToppedUpBalance');
    const prevGrantRaw = stateGet('lastGrantedBalance');
    const prevTop = num(prevTopRaw);
    const prevGrant = num(prevGrantRaw);

    // 首次运行（或基准未初始化）：只记录基准，不判定事件
    if (prevTopRaw == null || prevTop < 0 || prevGrantRaw == null || prevGrant < 0) {
      stateSet('lastToppedUpBalance', toppedUp);
      stateSet('lastGrantedBalance', granted);
      stateSet(LAST_CHECK_AT_KEY, nowMs);
      return null;
    }

    const dTop = round2(toppedUp - prevTop);
    const dGrant = round2(granted - prevGrant);
    let detected = null;
    let booked = 0; // 实际入账金额（充值会按整元吸附）
    let persistFailed = false; // 累计值写入失败：不推进基线、下次轮询重试

    if (dTop >= RECHARGE_MIN_DELTA) {
      // 充值（上调）：官方只允许充正整数，先吸附到整元再累加累计充值。
      // 上调方向**不加采样间隔守卫**：消费只让余额下降，任何长度的窗口里余额上调
      // 都只能来自充值，故长窗口下仍无歧义（不对称依据见退款分支）。
      booked = snapRechargeYuan(dTop);
      // 一律吸附到整元；残差过大（> RECHARGE_SNAP_EPS）只**额外告警**（可能窗口内消费异常大），
      // 不再改回非整元（避免留下 2.5 这种不可能出现的充值额）。
      const residual = rechargeResidual(dTop); // = booked − dTop（≥0，窗口内消费推测值）
      if (residual > RECHARGE_SNAP_EPS) {
        log('warn', 'recharge window-consumption large: dTop=' + dTop + ' booked=' + booked + ' consumed≈' + residual);
      }
      if (isDuplicateBooking('recharge', booked, nowMs, prevTop)) {
        log('info', 'duplicate recharge booking suppressed: ' + booked + ' (baseline not advanced last time)');
      } else {
        const total = num(readConfig('totalRecharged'));
        const ok = writeConfig('totalRecharged', round2(total + booked));
        setEvent('recharge', booked, !ok, residual);
        detected = 'recharge';
        if (ok) recordBooked('recharge', booked, nowMs, prevTop, toppedUp);
        else persistFailed = true;
      }
    } else if (dTop <= -REFUND_MIN_DELTA) {
      // 退款（下调）：仅对本方向加采样间隔守卫。窗口越长，窗口内「花到自有资金」的累计消费越大，
      // 越可能越过 5 元门槛被误记成退款；间隔缺失（升级后首次）或超阈值 → 只前移基线、不判事件。
      // 不对称依据：消费只会让余额下降 ⇒ 上调（充值/赠金）无歧义，只有下调才与消费混淆。
      if (gapMs == null || gapMs > REFUND_GAP_MAX_MS) {
        log('info', 'refund judgement skipped: gap ' + (gapMs == null ? 'unknown' : Math.round(gapMs / 1000) + 's') + ' > max ' + Math.round(REFUND_GAP_MAX_MS / 1000) + 's');
      } else if (isDuplicateBooking('refund', Math.abs(dTop), nowMs, prevTop)) {
        log('info', 'duplicate refund booking suppressed: ' + Math.abs(dTop) + ' (baseline not advanced last time)');
      } else {
        // 退款可能因手续费而非整元，故不吸附
        booked = Math.abs(dTop);
        const total = num(readConfig('totalRefunded'));
        const ok = writeConfig('totalRefunded', round2(total + booked));
        setEvent('refund', booked, !ok);
        detected = 'refund';
        if (ok) recordBooked('refund', booked, nowMs, prevTop, toppedUp);
        else persistFailed = true;
      }
    } else if (dGrant > 0) {
      // 赠金到账（平台补偿/活动）：只记录、只提示，不影响自有资金口径
      booked = dGrant;
      setEvent('grant', dGrant);
      detected = 'grant';
    }

    // 只在**入账成功**时附带 evAmt：写失败(persistFailed)会重试，若此处也记，重试成功时同一事件会再次并入 ⇒ evAmt 翻倍。
    if (detected && !persistFailed) lastBookedEvent = { type: detected, amount: booked };
    // 累计写入失败时**不推进充值余额基线**，让下一次轮询看到同一跳变并重试；
    // 赠金余额与采样时间戳照常推进（它们与累计值无关）。
    if (!persistFailed && toppedUp !== prevTop) stateSet('lastToppedUpBalance', toppedUp);
    if (granted !== prevGrant) stateSet('lastGrantedBalance', granted);
    stateSet(LAST_CHECK_AT_KEY, nowMs);

    if (detected) log('info', 'balance event detected: ' + detected + ' (dTop ' + dTop + ', booked ' + booked + ', persistFailed ' + persistFailed + ')');
    return detected;
  }

  // 记录余额差口径的小时级样本（写 state.json）。
  // 事件小时额外累加当时实际入账额（evAmt），供 hourlyCosts 还原消费（不再整块丢弃）。
  // 只在样本真正变化时落盘，避免每分钟都能写一次文件。
  function recordBalanceSample(total, isEvent, eventInfo) {
    try {
      const cur = stateGet(BALANCE_SAMPLES_KEY);
      const next = recordSample(cur, Date.now(), total, !!isEvent, eventInfo || null);
      const prevArr = Array.isArray(cur) ? cur : [];
      const prevLast = prevArr.length ? prevArr[prevArr.length - 1] : null;
      const nextLast = next.length ? next[next.length - 1] : null;
      const changed = next.length !== prevArr.length
        || !prevLast || !nextLast
        || prevLast.t !== nextLast.t
        || Number(prevLast.total) !== Number(nextLast.total)
        || !!prevLast.ev !== !!nextLast.ev
        // evAmt 变化也要落盘：否则事件小时重试时新并入的 evAmt 不会写入（失持久化）
        || JSON.stringify(prevLast.evAmt || null) !== JSON.stringify(nextLast.evAmt || null);
      if (changed) stateSet(BALANCE_SAMPLES_KEY, next);
    } catch (e) {
      log('warn', 'balance sample record failed: ' + (e && e.message));
    }
  }

  // ------------------------------------------------------------------ 路由

  app.get('/api/config', (c) => {
    // 缺失键回落 **manifest 默认值**（refresh 60 / tz -1），而不是 num(undefined)=0
    // （否则 tz 会报 0=UTC、refresh 会报 0=关闭刷新）。tz 的 -1 是「跟随本机」哨兵，属合法值。
    const seconds = cfgNumberOr('refreshIntervalSeconds', 60, 0);
    const threshold = cfgNumberOr('alertThreshold', 0, 0);
    const tzOffset = cfgNumberOr('timezoneOffsetMinutes', -1, -720, 840);
    return c.json({
      refreshIntervalSeconds: seconds,
      alertThreshold: threshold,
      totalRecharged: num(readConfig('totalRecharged')),
      totalRefunded: num(readConfig('totalRefunded')),
      eventPromptEnabled: readConfig('eventPromptEnabled') !== false,
      // 预警推送开关：让侧栏能显示「推送已关闭」，避免用户以为「预警开着」却收不到
      alertNotify: readConfig('alertNotify') !== false,
      peakRuleText: readPeakRuleText(),
      timezoneOffsetMinutes: tzOffset,
      // 历史基准：本机账本之外的人工校正量（侧栏累计 = 基准 + 官方同步 + 本机未覆盖段）
      usageBaselineRequests: baselineNumbers().requests,
      usageBaselineTokens: baselineNumbers().tokens,
      // 仅返回脱敏形式，永不回传明文 key
      apiKeyMasked: (function () {
        const k = readConfig('apiKey');
        if (typeof k !== 'string' || !k.trim()) return '';
        const s = k.trim();
        if (s.length <= 11) return '****';
        return s.slice(0, 7) + '*'.repeat(s.length - 11) + s.slice(-4);
      })(),
    });
  });

  // 保存预警阈值（侧栏「去设置」弹窗的「修改」按钮写这里）。
  // 只接受 alertThreshold 一个字段，不把内部状态键暴露成可写入口。
  app.post('/api/config', async (c) => {
    let payload = null;
    try {
      payload = await c.req.json();
    } catch (e) {
      payload = null;
    }
    const raw = payload ? payload.alertThreshold : undefined;
    // 严格数值入参：null/''/[]/true 一律非法（否则 Number(null)===0 会静默关掉预警）
    if (!isStrictNumeric(raw)) {
      return c.json({ ok: false, error: 'invalid_threshold', message: '余额预警阈值需为不小于 0 的数值。' }, 400);
    }
    const v = Number(raw);
    if (v < 0) {
      return c.json({ ok: false, error: 'invalid_threshold', message: '余额预警阈值需为不小于 0 的数值。' }, 400);
    }
    const rounded = round2(v);
    writeConfig('alertThreshold', rounded);
    log('info', 'alert threshold updated: ' + rounded);
    return c.json({ ok: true, alertThreshold: rounded });
  });

  // 保存展示时区（分钟，-1 = 跟随本机）
  app.post('/api/timezone', async (c) => {
    let payload = null;
    try {
      payload = await c.req.json();
    } catch (e) {
      payload = null;
    }
    const raw = payload ? payload.offsetMinutes : undefined;
    // 严格数值入参：null/''/[]/true 一律非法（否则 Number(null)===0 会静默切成 UTC）
    if (!isStrictNumeric(raw)) {
      return c.json({ ok: false, error: 'invalid_timezone', message: '时区偏移需为 -720 到 840 之间的分钟数。' }, 400);
    }
    const v = Number(raw);
    if (v < -720 || v > 840) {
      return c.json({ ok: false, error: 'invalid_timezone', message: '时区偏移需为 -720 到 840 之间的分钟数。' }, 400);
    }
    writeConfig('timezoneOffsetMinutes', v);
    return c.json({ ok: true, timezoneOffsetMinutes: v });
  });

  // 面板内异常回传：把 iframe 里 installErrorTraps 抓到的未捕获错误落进**与路由同一条日志渠道**（ctx.log），
  // 否则前端异常只存在于用户手抄的红字里，事后无痕（README 自述的缺口）。
  // 安全边界：按**不可信输入**处理 —— 只接受字符串、限长（2048）、剥离控制字符、做一次 sk-*** 兜底脱敏，
  // 不回显给调用方；本路由**绝不读取也绝不记录 apiKey**。
  const CLIENT_ERROR_MAX_CHARS = 2048;
  app.post('/api/client-error', async (c) => {
    let payload = null;
    try {
      payload = await c.req.json();
    } catch (e) {
      payload = null;
    }
    const code = (payload && typeof payload.code === 'string' ? payload.code : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const message = (payload && typeof payload.message === 'string' ? payload.message : '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***') // 兜底：万一错误文本里带了 key，绝不落盘
      .trim()
      .slice(0, CLIENT_ERROR_MAX_CHARS);
    if (!message) return c.json({ ok: false, error: 'empty' }, 400);
    log('warn', 'client error [' + (code || 'no-code') + '] ' + message, 'client');
    return c.json({ ok: true });
  });

  // 诊断日志读回（本机只读）：让「取证」变成一条命令，而不是去翻文件。
  // tail 默认 200、上限 500；返回前逐行再脱敏（sk-***）与限长。
  app.get('/api/diagnostics', (c) => {
    const lines = DIAG.readDiagnostics(DIAG_DIR, c.req.query('tail'), DIAG.DIAG_TAIL_MAX);
    return c.json({ ok: true, data: { file: DIAG.DIAG_FILE, count: lines.length, lines } });
  });

  app.get('/api/balance', async (c) => {
    const apiKey = readConfig('apiKey');
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      return c.json(
        { ok: false, error: 'not_configured', message: '尚未配置 DeepSeek API Key，请在插件设置中填写。' },
        400,
      );
    }

    try {
      const upstream = await fetchBalance(apiKey.trim());

      if (!upstream.ok) {
        const mapped = mapUpstreamError(upstream.status);
        log('warn', 'upstream balance query failed: HTTP ' + upstream.status + ' (' + mapped.error + ')');
        return c.json({ ok: false, status: upstream.status, ...mapped }, 502);
      }

      const info = pickBalanceInfo(upstream.body);
      if (!info) {
        log('warn', 'upstream balance payload shape is unrecognized');
        return c.json(
          { ok: false, error: 'bad_response', message: '官方接口返回的数据结构无法识别；请稍后重试，若持续请保留诊断日志反馈。' },
          502,
        );
      }

      const totalBalance = Number(info.total_balance);
      const toppedUpBalance = Number(info.topped_up_balance);
      // 上游数值护栏（P2）：只判 finite 不够 —— 负值/NaN/Infinity/超大值会直接进事件判定并污染基线。
      // 越界时**不进事件判定、不推进基线**，按 bad_response 返回并留痕（走 diagnostics）。
      if (!isBalanceAmount(totalBalance) || !isBalanceAmount(toppedUpBalance)) {
        log('warn', 'upstream balance out of range (total=' + totalBalance + ', toppedUp=' + toppedUpBalance + '); rejected as bad_response');
        return c.json(
          { ok: false, error: 'bad_response', message: '官方接口返回的余额数值超出合理范围；已忽略本次数据，请稍后重试。' },
          502,
        );
      }
      // 官方未返回赠金时按 0 处理（余额构成里赠金可缺省）；越界同样按 0（绝不让异常值进 event 判定）
      const grantedRaw = Number(info.granted_balance);
      const grantedBalance = isBalanceAmount(grantedRaw) ? grantedRaw : 0;
      const currency = typeof info.currency === 'string' && info.currency ? info.currency : 'CNY';

      // 状态推进 + 读取结果：同一同步块内完成
      const detected = applyBalanceSample(toppedUpBalance, grantedBalance);
      // 余额差口径：记一条小时级样本（事件小时带上实际入账额，计算时用入账额还原消费）
      recordBalanceSample(totalBalance, !!detected, detected ? lastBookedEvent : null);

      const totalRecharged = num(readConfig('totalRecharged'));
      const totalRefunded = num(readConfig('totalRefunded'));
      const ownSpend = totalRecharged > 0
        ? round2(Math.max(0, totalRecharged - totalRefunded - toppedUpBalance))
        : null;

      return c.json({
        ok: true,
        data: {
          is_available: upstream.body && upstream.body.is_available !== false,
          totalBalance,
          toppedUpBalance,
          grantedBalance,
          currency,
          ownSpend,
          totalRecharged,
          totalRefunded,
          detected,
          event: pendingEvent(),
          priceChange: readPriceChange(),
        },
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = String((err && err.message) || err);
      log('warn', 'balance fetch failed: ' + message);
      return c.json(
        { ok: false, error: 'fetch_error', message: '无法连接 DeepSeek（' + message + '）；请检查网络或代理后重试。' },
        502,
      );
    }
  });

  // 忽略待处理的余额事件。
  // 充值/退款/赠金现在都在检测时**自动入账**，前端不再需要「确认金额/类型」。
  // 这里只保留「忽略」这条兜底通道，供前端/脚本主动清掉信息提示（不改变任何累计数）。
  // 事后要修正累计值，请在插件设置里直接改 totalRecharged / totalRefunded。
  //
  // 本接口**无参数**：只清掉待处理事件、不改任何累计值（totalRecharged/totalRefunded 原样返回）。
  // 请求体被显式忽略（未知字段一律不解析、不校验），因此不要把它当作可写入口。
  app.post('/api/event/resolve', async (c) => {
    const ev = readEvent();
    if (!ev) {
      return c.json({ ok: false, error: 'no_pending_event', message: '当前没有待处理的余额事件。' }, 400);
    }
    clearEvent();
    log('info', 'balance event dismissed: ' + ev.type);
    return c.json({
      ok: true,
      type: ev.type,
      dismissed: true,
      totalRecharged: num(readConfig('totalRecharged')),
      totalRefunded: num(readConfig('totalRefunded')),
    });
  });

  // ---------------- 读账本 + 统计结果的短 TTL 缓存 ----------------
  // 目的：避免每次切条件都重读账本、重复聚合，把响应时间压在百毫秒内。
  const LEDGER_TTL_MS = 3000;
  const STATS_TTL_MS = 3000;
  let ledgerCache = { at: 0, entries: null };
  const statsCacheMap = new Map(); // 按条件键存多份，避免切来切去互相顶掉
  const STATS_CACHE_MAX = 12;

  const LEDGER_TIMEOUT_MS = 8000;
  // 注：withTimeout 定义在模块作用域（见上方导出），本函数内不再重复定义。

  // 用量归档文件（与 state.json 同目录，原子写 tmp+rename）；没有 dataDir 时不做归档。
  const ARCHIVE_PATH = (function () {
    try {
      const dir = ctx && typeof ctx.dataDir === 'string' && ctx.dataDir ? ctx.dataDir : '';
      return dir ? path.join(dir, USAGE_ARCHIVE.ARCHIVE_FILE) : '';
    } catch (e) { return ''; }
  })();
  let memArchive = null;
  let hostLedgerInfo = { entries: 0, oldestAt: null };
  let archiveInfo = USAGE_ARCHIVE.archiveStatus(0, USAGE_ARCHIVE.MAX_ARCHIVE, null);
  let archiveSeeded = false; // 归档文件已存在（读过）或已写过
  let archiveWrittenAtMono = 0; // 上次写盘时刻（单调）
  let archiveLoggedAtMono = 0; // 上次归档日志时刻（单调，防止到顶后每轮刷屏）
  const ARCHIVE_WRITE_MIN_MS = 30000; // 仅新增条目时的合并写窗口（30s）；首次播种/发生 drop 不受限

  function loadArchiveEntries() {
    if (memArchive) return memArchive.entries;
    let list = [];
    let existed = false;
    if (ARCHIVE_PATH) {
      try {
        const cur = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
        existed = true;
        const arr = cur && Array.isArray(cur.entries) ? cur.entries : (Array.isArray(cur) ? cur : []);
        list = arr.filter((e) => e && typeof e === 'object');
      } catch (e) { list = []; }
    }
    memArchive = { entries: list };
    archiveSeeded = existed;
    archiveInfo = USAGE_ARCHIVE.archiveStatus(list.length, USAGE_ARCHIVE.MAX_ARCHIVE, list.length ? list[0].startedAt : null);
    return memArchive.entries;
  }
  function saveArchiveEntries(entries) {
    memArchive = { entries };
    archiveInfo = USAGE_ARCHIVE.archiveStatus(entries.length, USAGE_ARCHIVE.MAX_ARCHIVE, entries.length ? entries[0].startedAt : null);
    if (!ARCHIVE_PATH) return;
    try {
      fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
      const tmp = ARCHIVE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), entries }), 'utf8');
      fs.renameSync(tmp, ARCHIVE_PATH);
    } catch (e) {
      log('warn', 'usage archive write failed: ' + (e && e.message));
    }
  }

  // 读账本 = 宿主账本 ∪ 归档（按 requestId 去重），使区间能跨过宿主 5000 上限。
  async function loadLedger() {
    if (ledgerCache.entries && MONO.isFresh(ledgerCache.at, LEDGER_TTL_MS, MONO.monoNow())) return ledgerCache.entries;
    const result = await withTimeout(ctx.bus.request('usage:list', { limit: 100000 }), LEDGER_TIMEOUT_MS, 'usage:list');
    const all = Array.isArray(result) ? result : (result && result.entries) || [];
    // 宿主账本容量自查（供页脚「账本容量」）：entries/max/oldest 一律按**宿主**账本
    let oldest = null;
    for (const e of all) {
      const t = e && e.startedAt;
      if (typeof t === 'string' && (oldest === null || t < oldest)) oldest = t;
    }
    hostLedgerInfo = { entries: all.length, oldestAt: oldest };
    const archived = loadArchiveEntries();
    const merged = USAGE_ARCHIVE.mergeEntries(archived, all, USAGE_ARCHIVE.MAX_ARCHIVE);
    const nowMono = MONO.monoNow();
    // 写盘节流：首次播种必须写；发生「宿主滚出」（有数据真正面临丢失）立即写；
    // 仅新增条目时按窗口（30s）合并写一次（宿主账本仍保有 5000 条，窗口内不会丢）。原子写保持。
    const mustWrite = merged.dropped > 0 || (!archiveSeeded && merged.entries.length > 0) ||
      (merged.added > 0 && (nowMono - archiveWrittenAtMono) >= ARCHIVE_WRITE_MIN_MS);
    if (mustWrite) {
      saveArchiveEntries(merged.entries);
      archiveWrittenAtMono = nowMono;
      archiveSeeded = true;
      if ((nowMono - archiveLoggedAtMono) >= ARCHIVE_WRITE_MIN_MS) {
        archiveLoggedAtMono = nowMono;
        log('info', 'usage archive: +' + merged.added + (merged.dropped ? ' -' + merged.dropped : '') + ' → ' + merged.entries.length + '/' + USAGE_ARCHIVE.MAX_ARCHIVE);
      }
    } else {
      memArchive = { entries: merged.entries }; // 内存更新，文件留到窗口到点/下次 drop 再写
      archiveInfo = USAGE_ARCHIVE.archiveStatus(merged.entries.length, USAGE_ARCHIVE.MAX_ARCHIVE, merged.entries.length ? merged.entries[0].startedAt : null);
    }
    const union = USAGE_ARCHIVE.unionEntries(merged.entries, all);
    ledgerCache = { at: MONO.monoNow(), entries: union };
    return union;
  }

  // 时区偏移（分钟）：查询参数 > 插件设置 > 本机（-1 = 跟随本机，不能当有效偏移）
  function resolveTzMinutes(raw) {
    return pickTzMinutes(raw, readConfig('timezoneOffsetMinutes'), -new Date().getTimezoneOffset());
  }

  // 用量统计：把本机账本按小时/天聚合，按官方价目表（含高峰/空闲）估算金额
  // 口径：数据源为本机 usage 账本，只覆盖这台机器发出的请求；金额为估算值。
  // 时区：可用 ?tz=<分钟> 指定，否则读插件设置，再否则用本机时区。
  // 区间：range=today|yesterday|7d|30d|thisMonth|lastMonth|custom|all
  //       custom 需配 from/to=YYYY-MM-DD（按展示时区的日历日，含两端）
  // 注意：高峰/空闲判定始终按北京时间（官方定价定义的时区），不受展示时区影响。
  app.get('/api/stats', async (c) => {
    // range 缺席/空串 → 默认 30d；**未知值不再静默回落**（会让调用方拿到一个「以为是它要的区间」的结果）→ 400。
    const rangeRaw = c.req.query('range');
    const range = (rangeRaw === undefined || rangeRaw === '') ? '30d' : String(rangeRaw);
    const KNOWN_RANGES = ['today', 'yesterday', '7d', '30d', 'thisMonth', 'lastMonth', 'custom', 'all'];
    if (KNOWN_RANGES.indexOf(range) < 0) {
      return c.json({ ok: false, error: 'invalid_range', range, message: '未知的 range：' + range + '（可选：' + KNOWN_RANGES.join('|') + '）' }, 400);
    }
    const tzQuery = c.req.query('tz');
    // 空串 / 非数字一律拒绝（否则 Number('')===0 会静默按 UTC）；tz **缺席**才回落插件设置/本机
    if (tzQuery !== undefined && !isStrictNumeric(tzQuery)) {
      return c.json({ ok: false, error: 'invalid_timezone', message: 'tz 需为数字（分钟）。' }, 400);
    }
    const tzMinutes = resolveTzMinutes(tzQuery);
    const now = Date.now();
    const DAY = 86400000;
    const tzShift = tzMinutes * 60000;
    const dayStartOf = (ms) => {
      const s = new Date(ms + tzShift);
      return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - tzShift;
    };
    const todayStart = dayStartOf(now);
    let since = todayStart - 29 * DAY;
    let until = now;

    if (range === 'today') {
      since = todayStart;
    } else if (range === 'yesterday') {
      since = todayStart - DAY;
      until = todayStart;
    } else if (range === '7d') {
      since = todayStart - 6 * DAY;
    } else if (range === 'thisMonth') {
      const s = new Date(now + tzShift);
      since = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1) - tzShift;
    } else if (range === 'lastMonth') {
      const s = new Date(now + tzShift);
      since = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 1, 1) - tzShift;
      until = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1) - tzShift;
    } else if (range === 'custom') {
      const parseDay = (str) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
        if (!m) return null;
        const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
        // 日历校验：Date.UTC 会把 2026-13-45 归一化成 2027-02-13、造出畸形窗口，故回读年月日必须一致。
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
        return Date.UTC(y, mo - 1, d) - tzShift;
      };
      const from = parseDay(c.req.query('from'));
      const to = parseDay(c.req.query('to'));
      // 非法日期不再静默回落 30d（会让调用方拿到一个「以为是自定义区间」的结果）；
      // 前端本就会传合法日期，因此对非法输入明确报错。
      if (from === null || to === null || to < from) {
        return c.json({ ok: false, error: 'invalid_range', message: '自定义区间的 from/to 需为 YYYY-MM-DD 且 from ≤ to。' }, 400);
      }
      since = from;
      until = to + DAY;
    }
    if (until > now) until = now;
    // 安全兜底：限制最大跨度与分桶数，避免一次查询生成超大数组/SVG（DoS）
    const MAX_SPAN_MS = 400 * DAY;
    if (now - since > MAX_SPAN_MS) since = now - MAX_SPAN_MS;
    const MAX_BUCKETS = 400;
    // 校准系数：默认 1（token 估算已按官方三类口径核对过，不再需要全局拟合）。
    // 保留该系数只为极端情况下手动微调；设为 1 即纯 token × 单价。
    const calibrationRaw = num(readConfig('costCalibration'));
    const calibration = calibrationRaw > 0 ? calibrationRaw : 1;
    // 高峰判定用的节假日集合：内置 2026 安排 ∪ 用户补充（holidayDates）
    const holidayRaw = readConfig('holidayDates');
    const extraHolidays = buildHolidaySet(holidayRaw).set;
    // 节假日表覆盖检查：当前年份不在内置表内时给出可见告示 + 按北京日一次的 warn（不静默）。
    // 方向克制：**不改** isPeakAt/isPeakDay 的判定（未覆盖年份仍按星期规则），只如实提示可能高估约 2×。
    const coverage = holidayCoverage(now);
    if (!coverage.covered) {
      const warnDay = beijingDayKey(now);
      if (stateGet(HOLIDAY_WARN_DAY_KEY) !== warnDay) {
        stateSet(HOLIDAY_WARN_DAY_KEY, warnDay);
        log('warn', 'holiday table does not cover year ' + coverage.year + '; peak-hour cost may be overestimated ~2x');
      }
    }

    // 相同条件在短窗内直接复用结果（key 只用「条件」不用当前时间，否则毫秒级时间戳会让缓存永不命中）
    const cacheKey = [range, since, until, tzMinutes, calibration, (typeof holidayRaw === 'string' ? holidayRaw : ''), (function () { const o = readOfficialSync(); return o ? 'sync' + (o.ds.importedAt || 0) + '-' + o.ds.days.length + '-' + (o.ds.hours ? o.ds.hours.length : 0) : 'nosync'; })()].join('|');
    const cached = statsCacheMap.get(cacheKey);
    if (cached && MONO.isFresh(cached.at, STATS_TTL_MS, MONO.monoNow())) {
      return c.json(cached.payload);
    }

    try {
      const all = await loadLedger();
      const entries = all.filter((e) => e && e.model && e.model.provider === 'deepseek' && Number.isFinite(Date.parse(e.startedAt)));
      // 官方同步：覆盖窗口内的本机条目会被官方数据代表（下面聚合时剔除），窗口外照常统计。
      const off = readOfficialSync();
      const base = baselineNumbers();

      let bucketMs = 3600000;
      if (range === '7d' || range === '30d' || range === 'thisMonth' || range === 'lastMonth' || range === 'all' || (until - since) > 2 * DAY) {
        bucketMs = DAY;
      }
      if (range === 'all') {
        // 「全部」把窗口起点拉回最早一条记录 —— 跨度可能远超上面的 400 天安全上限，
        // 所以粒度必须在拉回**之后**才定，否则桶数被硬顶 400、末桶时间标签与实际数据不符。
        // 官方同步覆盖的区间同属「全部」，因此起点还要与官方首日取更早者。
        // 对齐按**展示时区**的日界（与 7d/30d 等其他区间一致）：否则日桶起点落在 UTC 整点，
        // 前端的 labelOf() 按展示时区格式化就会让桶标签与桶内数据错开（官方日值也会错位一格）。
        let minAt = null;
        if (entries.length) minAt = Math.min.apply(null, entries.map((e) => Date.parse(e.startedAt)));
        if (off && Number.isFinite(off.start)) minAt = minAt === null ? off.start : Math.min(minAt, off.start);
        if (minAt !== null) since = dayStartOf(minAt);
      }
      // 粒度自动升档（小时 → 天 → 周 → 月）：保证桶数 ≤ MAX_BUCKETS，且每个桶的时间标签
      // 就是该桶起点，与真实数据时间一致。小跨度时该循环不触发 ⇒ 行为逐项不变。
      // 注：「月」用统一 30 天步长近似（分桶循环假定等距步长），标签显示该桶起点。
      const nextGranularity = (ms) => (ms < DAY ? DAY : ms < 7 * DAY ? 7 * DAY : ms < 30 * DAY ? 30 * DAY : ms * 2);
      while ((until - since) / bucketMs > MAX_BUCKETS) bucketMs = nextGranularity(bucketMs);
      // 官方数据若只有「日」（长区间包）而桶按小时分：官方那几天的值无法拆回整点，柱状图会整片空白、
      // 高峰金额恒为 0 ⇒ 窗口与**按日的官方日**相交时就把粒度提到「天」。
      // 带小时桶的官方日不需要提档：能直接注入整点，反而更细（今日/昨日保持小时柱状图）。
      // 只有 today / yesterday / custom(≤ 2 天) 会落到小时档，这次提档最多把桶数从 ≤ 48 降到 ≤ 2。
      if (off && bucketMs < DAY) {
        for (const d of off.ds.days) {
          if (d.hourCovered) continue; // 有小时桶：能拆进小时柱
          const ds0 = OFFICIAL_SYNC.dayKeyStartMs(d.d);
          if (ds0 === null) continue;
          if (ds0 + DAY <= since || ds0 >= until) continue;
          bucketMs = DAY;
          break;
        }
      }
      const bucketCount = Math.max(1, Math.ceil((until - since) / bucketMs));

      // 当天 24 整点的「高峰刻度掩码」（服务端按北京时间 + 节假日算，单一事实源）：
      // 前端只用它给 X 轴刻度上色 —— 不复刻高峰规则、也不需要节假日数据；刻度位置按展示时区，
      // 掩码按绝对时刻算，因此切到任意展示时区都不会错位。仅小时分桶时给出（今天/昨天/短区间）。
      const dayPeakMask = bucketMs === 3600000 ? buildPeakTickMask(since, 24, extraHolidays) : null;

      const buckets = [];
      for (let i = 0; i < bucketCount; i += 1) {
        buckets.push({ t: since + i * bucketMs, requests: 0, tokens: 0, cost: 0, peak: false, balanceCost: null, balanceDeviationPct: null, balanceInsufficient: false, byModel: {} });
      }
      const modelMap = {};
      const totals = { requests: 0, tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, costPeak: 0, peakRequests: 0, balanceCost: null };
      // 未收录单价的型号：token 照实统计，但**金额不计入**（区分「事实」与「推断」），并把明细带回去供页面提示
      const overridesRaw = readConfig('priceOverrides');
      // 价格同步过期就在后台补一刷（不 await，不让同步拖慢这次响应）
      if (priceSyncDue(priceSync.ok, priceSync.monoAt, MONO.monoNow(), false)) syncPrices(true);
      const syncedPrices = priceSync.ok ? priceSync.models : {};
      const unpriced = { requests: 0, tokens: 0, models: {} };
      // 本机侧的可核计数：localCount = 真正计入总量的本机条数（也是高峰金额的唯一来源）
      let localCount = 0;
      let localSkipped = 0;

      for (const entry of entries) {
        const at = Date.parse(entry.startedAt);
        if (at < since || at >= until) continue;
        // 官方已覆盖的这一段由官方数据代表（下面合并），本机条目不能再计一次
        // （但**日粒度**时本机同样被剔除：一天的量已由官方日值代表，两不重复计）
        if (inOfficialWindow(at, off)) { localSkipped += 1; continue; }
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((at - since) / bucketMs)));
        const ec = computeEntryCost(entry, at, overridesRaw, syncedPrices, calibration, extraHolidays);
        const modelId = ec.modelId;
        const info = ec.info;
        const priced = ec.priced;
        const peak = ec.peak;
        const tk = ec.tk;
        const costHit = ec.costHit;
        const costMiss = ec.costMiss;
        const costOut = ec.costOut;
        const cost = ec.cost;
        if (!priced) {
          unpriced.requests += 1;
          unpriced.tokens += tk.total;
          const u = unpriced.models[modelId] || (unpriced.models[modelId] = { id: modelId, requests: 0, tokens: 0, rawIds: [] });
          u.requests += 1;
          u.tokens += tk.total;
          if (u.rawIds.indexOf(entry.model.modelId) < 0) u.rawIds.push(entry.model.modelId);
        }

        const b = buckets[idx];
        b.requests += 1;
        b.tokens += tk.total;
        b.cost += cost;
        const bm = b.byModel[modelId] || (b.byModel[modelId] = { requests: 0, tokens: 0, cost: 0, hit: 0, miss: 0, output: 0, costHit: 0, costMiss: 0, costOut: 0 });
        bm.requests += 1;
        bm.tokens += tk.total;
        bm.cost += cost;
        bm.hit += tk.hit;
        bm.miss += tk.miss;
        bm.output += tk.output;
        bm.costHit += costHit;
        bm.costMiss += costMiss;
        bm.costOut += costOut;

        const m = modelMap[modelId] || (modelMap[modelId] = { id: modelId, requests: 0, tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, costHit: 0, costMiss: 0, costOut: 0, costPeak: 0, peakRequests: 0, priceStatus: info.status, priceSource: info.source, unpriced: !priced, rawIds: [] });
        m.requests += 1;
        m.tokens += tk.total;
        m.hit += tk.hit;
        m.miss += tk.miss;
        m.output += tk.output;
        m.cost += cost;
        m.costHit += costHit;
        m.costMiss += costMiss;
        m.costOut += costOut;
        if (peak) { m.costPeak += cost; m.peakRequests += 1; }
        if (m.rawIds.indexOf(entry.model.modelId) < 0) m.rawIds.push(entry.model.modelId);

        totals.requests += 1;
        localCount += 1;
        totals.tokens += tk.total;
        totals.hit += tk.hit;
        totals.miss += tk.miss;
        totals.output += tk.output;
        totals.cost += cost;
        if (peak) {
          totals.costPeak += cost;
          totals.peakRequests += 1;
        }
      }

      // 本机侧计数（前端靠 localCount 判定高峰金额是否可得：全官方数据的区间推不出高峰）
      totals.localCount = localCount;
      totals.localSkipped = localSkipped;

      // 官方同步合并：窗口内的官方数据并进总量，两种粒度分别对待 ——
      //   · 长区间包（按日）：并入 totals；桶粒度 ≥ 天时同时并入对应桶；高峰金额不可分。
      //   · 短区间包（按小时）：桶粒度 = 小时时逐格注入（今日/昨日的柱状图看得出日内起伏），
      //     并按钟点拆出高峰金额；桶粒度 ≥ 天时退为按日并入（日合计 = 该日小时之和）。
      //   两种粒度绝不同时对同一天计数（合并时小时包优先，同一天只留小时桶）。
      let officialCostU = 0;
      let officialDays = 0;
      let officialHourDays = 0;
      let officialDayOnlyDays = 0;
      let officialPeakUsed = false;
      if (off) {
        const hourByDay = officialHourIndex(off);
        const toBucket = (idx, o, isPeak) => {
          const cost = OFFICIAL_SYNC.unitsToYuan(o.costU);
          const b = buckets[idx];
          b.requests += num(o.requests);
          b.tokens += num(o.tokens);
          b.cost += cost;
          for (const dm of (o.models || [])) {
            const dcost = OFFICIAL_SYNC.unitsToYuan(dm.costU);
            const bm = b.byModel[dm.id] || (b.byModel[dm.id] = { requests: 0, tokens: 0, cost: 0, hit: 0, miss: 0, output: 0, costHit: 0, costMiss: 0, costOut: 0 });
            bm.requests += num(dm.requests);
            bm.tokens += num(dm.tokens);
            bm.cost += dcost;
            bm.hit += num(dm.hit);
            bm.miss += num(dm.miss);
            bm.output += num(dm.output);
            const mm = modelMap[dm.id] || (modelMap[dm.id] = { id: dm.id, requests: 0, tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, costHit: 0, costMiss: 0, costOut: 0, costPeak: 0, peakRequests: 0, priceStatus: 'official', priceSource: 'official', unpriced: false, rawIds: [dm.id], official: true });
            mm.requests += num(dm.requests);
            mm.tokens += num(dm.tokens);
            mm.cost += dcost;
            mm.hit += num(dm.hit);
            mm.miss += num(dm.miss);
            mm.output += num(dm.output);
            if (isPeak) { mm.costPeak += dcost; mm.peakRequests += num(dm.requests); }
          }
          if (isPeak) {
            totals.costPeak += cost;
            totals.peakRequests += num(o.requests);
          }
        };
        const addTotals = (o) => {
          totals.requests += num(o.requests);
          totals.tokens += num(o.tokens);
          totals.hit += num(o.hit);
          totals.miss += num(o.miss);
          totals.output += num(o.output);
          totals.cost += OFFICIAL_SYNC.unitsToYuan(o.costU);
        };
        for (const d of off.ds.days) {
          const ds0 = OFFICIAL_SYNC.dayKeyStartMs(d.d);
          if (ds0 === null) continue;
          if (ds0 + OFFICIAL_SYNC.DAY_MS <= since || ds0 >= until) continue;
          officialDays += 1;
          if (d.hourCovered) officialHourDays += 1; else officialDayOnlyDays += 1;

          if (bucketMs === OFFICIAL_SYNC.HOUR_MS) {
            // 小时档：只并入**落在窗口内**的整点（窗口边界不再用「整天」的粗口径）
            for (const hr of hourByDay.get(d.d) || []) {
              const h = num(hr.h);
              const idx = Math.floor((h - since) / bucketMs);
              if (idx < 0 || idx >= bucketCount) continue;
              addTotals(hr);
              officialCostU += num(hr.costU);
              const isPeak = isPeakAt(h, extraHolidays);
              if (isPeak) officialPeakUsed = true;
              toBucket(idx, hr, isPeak);
            }
          } else {
            officialCostU += num(d.costU);
            addTotals(d);
            if (bucketMs >= OFFICIAL_SYNC.DAY_MS) {
              const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((ds0 - since) / bucketMs)));
              toBucket(idx, d, false);
            }
            // 高峰金额：只有带小时桶的日能按钟点拆出高峰段；纯按日的日不可分（peakKnown=false）
            if (d.hourCovered) {
              let peakU = 0;
              let peakReq = 0;
              const peakModels = new Map();
              for (const hr of hourByDay.get(d.d) || []) {
                if (!isPeakAt(num(hr.h), extraHolidays)) continue;
                peakU += num(hr.costU);
                peakReq += num(hr.requests);
                for (const dm of (hr.models || [])) {
                  const x = peakModels.get(dm.id) || { costU: 0, requests: 0 };
                  x.costU += num(dm.costU);
                  x.requests += num(dm.requests);
                  peakModels.set(dm.id, x);
                }
              }
              if (peakU > 0 || peakReq > 0) {
                officialPeakUsed = true;
                totals.costPeak += OFFICIAL_SYNC.unitsToYuan(peakU);
                totals.peakRequests += peakReq;
                for (const [id, x] of peakModels) {
                  const mm = modelMap[id] || (modelMap[id] = { id, requests: 0, tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, costHit: 0, costMiss: 0, costOut: 0, costPeak: 0, peakRequests: 0, priceStatus: 'official', priceSource: 'official', unpriced: false, rawIds: [id], official: true });
                  mm.costPeak += OFFICIAL_SYNC.unitsToYuan(x.costU);
                  mm.peakRequests += x.requests;
                }
              }
            }
          }
        }
      }
      totals.officialCost = round4(OFFICIAL_SYNC.unitsToYuan(officialCostU));
      totals.officialDays = officialDays;
      totals.officialCovered = officialDays > 0;
      totals.officialHours = officialHourDays;
      totals.officialDayOnly = officialDayOnlyDays;
      // 高峰金额是否可得：本机有样本，或官方给了小时桶（能按钟点拆）。peakFrom 说明数额来自谁。
      totals.peakKnown = localCount > 0 || officialPeakUsed;
      totals.peakFrom = officialPeakUsed ? (localCount > 0 ? 'mixed' : 'official') : 'local';
      // 「全部」= 生命周期总量：把人工历史基准也算进来（桶内不体现，页脚会单独注明）
      if (range === 'all') {
        totals.requests += base.requests;
        totals.tokens += base.tokens;
      }

      // 余额差口径：把小时级样本聚到同一个桶体系（无样本覆盖的桶为 null）
      const balCosts = bucketBalanceCost(stateGet(BALANCE_SAMPLES_KEY), since, bucketMs, bucketCount);
      for (let i = 0; i < buckets.length; i += 1) {
        const b = buckets[i];
        b.cost = round4(b.cost);
        // 高峰标记：小时桶看该钟点是否高峰；日桶看当天是否为高峰日；更粗的桶（周）不标
        b.peak = bucketMs <= 3600000
          ? isPeakAt(b.t, extraHolidays)
          : (bucketMs <= 86400000 ? isPeakDay(b.t + bucketMs / 2, extraHolidays) : false);
        const bc = balCosts[i];
        b.balanceCost = typeof bc === 'number' ? bc : null;
        // 余额差是旁证：样本不足或 |余额差| < 分辨率下限（官方余额两位小数）时不报百分比
        const devView = deviationView(b.balanceCost, b.cost);
        b.balanceDeviationPct = devView.pct;
        b.balanceInsufficient = devView.insufficient;
        for (const k of Object.keys(b.byModel)) {
          const bm = b.byModel[k];
          bm.cost = round4(bm.cost);
          bm.costHit = round4(bm.costHit);
          bm.costMiss = round4(bm.costMiss);
          bm.costOut = round4(bm.costOut);
        }
      }
      const models = Object.keys(modelMap)
        .map((k) => modelMap[k])
        .sort((a, b) => (b.cost - a.cost) || (b.requests - a.requests));
      for (const m of models) {
        m.cost = round4(m.cost);
        m.costHit = round4(m.costHit);
        m.costMiss = round4(m.costMiss);
        m.costOut = round4(m.costOut);
        m.costPeak = round4(m.costPeak);
      }
      totals.cost = round4(totals.cost);
      totals.costPeak = round4(totals.costPeak);
      // 余额差合计（与视图同源：把各桶的余额差相加；样本全缺 → null，前端显示「--」）
      let balanceCostSum = null;
      for (let i = 0; i < buckets.length; i += 1) {
        const bc = buckets[i].balanceCost;
        if (typeof bc === 'number' && Number.isFinite(bc)) {
          balanceCostSum = round4((balanceCostSum === null ? 0 : balanceCostSum) + bc);
        }
      }
      totals.balanceCost = balanceCostSum;

      // 宿主账本容量（唯一可靠的缺口信号）+ 归档状态（插件自己接住滚出去的记录）。
      const LEDGER_MAX_ENTRIES = 5000;
      const ledgerInfo = {
        entries: hostLedgerInfo.entries,
        maxEntries: LEDGER_MAX_ENTRIES,
        truncated: hostLedgerInfo.entries >= LEDGER_MAX_ENTRIES,
        oldestAt: hostLedgerInfo.oldestAt,
        archive: archiveInfo,
      };

      const payload = {
        ok: true,
        data: {
          range,
          since,
          until, // 真实窗口末端（yesterday/lastMonth/custom 各为其界；滚动区间为「现在」）；「取数时刻」见 fetchedAt
          bucketMs,
          tzMinutes,
          buckets,
          models,
          totals,
          official: (off && officialDays > 0) ? {
            from: off.ds.from,
            to: off.ds.to,
            coveredUntil: off.until,
            importedAt: off.ds.importedAt || null,
            cost: round4(off.cost),
            requests: off.requests,
            tokens: off.tokens,
            importDays: off.ds.days.length,
            days: officialDays, // 落在**本窗口**内的官方天数（0 时整个 official 回 null，前端不会误报「官方已介入」）
            hourDays: officialHourDays, // 本窗口内带小时桶的官方天数
            dayOnlyDays: officialDayOnlyDays, // 本窗口内仅按日的官方天数
            hours: off.ds.hours ? off.ds.hours.length : 0,
            granularity: officialHourDays ? (officialDayOnlyDays ? 'mixed' : 'hour') : 'day',
          } : null,
          baseline: base,
          prices: {
            'deepseek-flash': priceOf('deepseek-flash', overridesRaw, syncedPrices),
            'deepseek-v4-pro': priceOf('deepseek-v4-pro', overridesRaw, syncedPrices),
          },
          priceSync: {
            ok: priceSync.ok,
            at: priceSync.at,
            models: Object.keys(priceSync.models).length,
            reason: priceSync.reason || '',
            url: priceSync.url,
          },
          unpriced: {
            requests: unpriced.requests,
            tokens: unpriced.tokens,
            models: Object.keys(unpriced.models).map((k) => unpriced.models[k]),
          },
          ledger: ledgerInfo,
          calibration,
          dayPeakMask,
          holidayCoverage: coverage,
          priceChange: readPriceChange(),
          peakRuleText: readPeakRuleText(),
          todayIsPeak: isPeakDay(now, extraHolidays),
          todayIsPeakNow: isPeakAt(now, extraHolidays),
          holidayCount: extraHolidays.size,
        },
        fetchedAt: new Date().toISOString(),
      };
      statsCacheMap.set(cacheKey, { at: MONO.monoNow(), payload });
      if (statsCacheMap.size > STATS_CACHE_MAX) {
        statsCacheMap.delete(statsCacheMap.keys().next().value);
      }
      return c.json(payload);
    } catch (err) {
      const message = String((err && err.message) || err);
      log('warn', 'stats aggregation failed: ' + message);
      return c.json({ ok: false, error: 'stats_error', message: message }, 502);
    }
  });

  // ---------------------------------------------------------------- 导出 CSV 落盘
  // 目录由前端通过宿主目录选择器（resource.pick）取得，这里仍做防御性校验：
  // 只接受绝对路径、只接受白名单内的区间标识，文件名完全由服务端生成，
  // 前端字符串不会以任何形式进入路径拼接。校验与命名规则见 lib/export-csv.js。

  app.post('/api/export', async (c) => {
    let payload = null;
    try {
      payload = await c.req.json();
    } catch (e) {
      payload = null;
    }
    const dir = payload && typeof payload.dir === 'string' ? payload.dir.trim() : '';
    const csv = payload && typeof payload.csv === 'string' ? payload.csv : '';
    const rangeKey = payload && typeof payload.rangeKey === 'string' ? payload.rangeKey : '';
    const from = payload && isIsoDate(payload.from) ? payload.from : '';
    const to = payload && isIsoDate(payload.to) ? payload.to : '';
    const tzRaw = payload ? Number(payload.tz) : NaN;
    const tz = Number.isFinite(tzRaw) && tzRaw >= -720 && tzRaw <= 840 ? tzRaw : 0;

    if (!dir || !isAbsolutePath(dir)) return c.json({ ok: false, error: 'invalid_dir' }, 400);
    if (!csv) return c.json({ ok: false, error: 'empty_csv' }, 400);
    if (csv.length > EXPORT_MAX_CHARS) return c.json({ ok: false, error: 'too_large' }, 400);
    if (!RANGE_SLUGS[rangeKey]) return c.json({ ok: false, error: 'invalid_range' }, 400);
    if (rangeKey === 'custom' && (!from || !to)) return c.json({ ok: false, error: 'invalid_range' }, 400);

    const sep = pathSep(dir);
    const base = dir.replace(/[\\/]+$/, '');
    // 文件名自带秒级时间戳，同区间重复导出也不会互相覆盖
    const stem = buildExportStem(rangeKey, from, to, tz);
    const target = base + sep + stem + '.csv';

    const content = '\uFEFF' + csv; // BOM：Excel 直开中文不乱码
    try {
      await withTimeout(ctx.resources.write({ kind: 'local-file', path: target }, content), EXPORT_WRITE_TIMEOUT_MS, 'export write');
    } catch (e) {
      log('warn', 'export write failed: ' + (e && e.message));
      return c.json({ ok: false, error: 'write_failed', message: '无法写入该目录（检查权限或磁盘）。' }, 500);
    }
    log('info', 'export written: ' + stem + '.csv (' + content.length + ' chars)');
    return c.json({ ok: true, name: stem + '.csv', bytes: content.length });
  });

  // 导入官方用量包 = **同步**（POST）：把官方导出的 zip（`usage_data_*.zip`，内含 cost/amount 两份 CSV）
  // 或单份 CSV 解析成「北京【小时/日】× 型号」的权威账，**按天并入** state.officialSync；随后所有
  // 报表（侧栏累计计数、用量详情页、今日消费额与小时柱状图）都以官方数据为准重算。
  // 官方导出粒度随区间长度变化（短区间按小时、长区间按日），合并时小时包优先 ⇒ 先导 30 天再导今日小时包，
  // 历史不会被抹掉；同一天两种粒度都在时以小时桶为准（与哪份先导无关）。
  // 原始文件**不落盘**：state 里只有数值聚合（无 user_id / api_key / 原始文本）。
  // 安全：文件是不可信输入 —— 限长、类型探测、字段校验、只回传数值与派生标签。
  app.post('/api/sync', async (c) => {
    let payload = null;
    try { payload = await c.req.json(); } catch (e) { payload = null; }
    const content = payload && typeof payload.content === 'string' ? payload.content : '';
    const encoding = payload && payload.encoding === 'base64' ? 'base64' : 'utf8';
    // 文件名也按不可信处理：去控制字符 + 脱敏 + 限长
    const fileName = payload && typeof payload.fileName === 'string' ? DIAG.scrub(payload.fileName, 160) : '';
    const tzRaw = payload ? Number(payload.tz) : NaN;
    const tzMinutes = Number.isFinite(tzRaw) && tzRaw >= -720 && tzRaw <= 840 && tzRaw !== -1 ? tzRaw : 480;
    if (!content) return c.json({ ok: false, error: 'empty', message: '没有收到文件内容。' }, 400);

    const dec = OFFICIAL_SYNC.decodeImport({ content, encoding });
    if (!dec.ok) {
      log('warn', 'sync decode failed: ' + dec.reason);
      return c.json({ ok: false, error: 'bad_file', message: dec.reason || '文件无法解析' }, 400);
    }
    const built = OFFICIAL_SYNC.buildSync({ sheets: dec.files, importedAt: Date.now() });
    if (!built.ok) {
      log('warn', 'sync parse failed: ' + built.reason);
      return c.json({ ok: false, error: 'bad_csv', message: built.reason || 'CSV 解析失败' }, 400);
    }

    try {
      const next = built.data;
      next.fileName = fileName;
      // 按「天」定权威地并入既有数据集：先导长区间、再导今日小时包也不会互相抹除
      const prev = stateGet(OFFICIAL_SYNC_KEY);
      const ds = OFFICIAL_SYNC.mergeSync(prev, next) || next;
      ds.fileName = fileName;
      stateSet(OFFICIAL_SYNC_KEY, ds);
      // 同步后所有派生报表立即失效（否则侧栏/详情页最多滞后一个缓存周期）
      usageCountCache = { at: 0, payload: null };
      statsCacheMap.clear();
      const data = OFFICIAL_SYNC.summarize(ds);
      data.fileName = fileName;
      data.tzMinutes = tzMinutes;
      data.merged = !!prev;
      log('info', 'sync imported: ' + next.from + '~' + next.to + ' gran=' + (next.granularity || 'day') +
        ' days=' + next.days.length + ' hours=' + (next.hours ? next.hours.length : 0) +
        ' cost=' + OFFICIAL_SYNC.unitsToYuan(next.totals.costU).toFixed(4) +
        ' req=' + next.totals.requests + ' tok=' + next.totals.tokens + ' files=' + next.files.join(','));
      log('info', 'sync merged: total days=' + ds.days.length + ' hours=' + (ds.hours ? ds.hours.length : 0) +
        ' range=' + ds.from + '~' + ds.to + ' coveredUntil=' + new Date(ds.coveredUntil).toISOString());
      return c.json({ ok: true, data });
    } catch (err) {
      const message = String((err && err.message) || err);
      log('warn', 'sync persist failed: ' + message);
      return c.json({ ok: false, error: 'sync_error', message }, 502);
    }
  });

  // 最近一次同步（只读）：页面重开时读回，仍能看到上次同步的覆盖范围与合计。
  app.get('/api/sync', (c) => {
    const off = readOfficialSync();
    return c.json({
      ok: true,
      data: off ? OFFICIAL_SYNC.summarize(off.ds) : null,
      baseline: baselineNumbers(),
    });
  });

  // 用量计数独立缓存：侧栏心跳每 12 秒调一次，而账本聚合是全量扫描；
  // 计数不需要 12 秒级新鲜，缓存 20 秒可把冷读频率明显降下来。
  const USAGE_COUNT_TTL_MS = 20000;
  let usageCountCache = { at: 0, payload: null };

  app.get('/api/usage', async (c) => {
    const SCAN_LIMIT = 100000;
    if (usageCountCache.payload && MONO.isFresh(usageCountCache.at, USAGE_COUNT_TTL_MS, MONO.monoNow())) {
      return c.json(usageCountCache.payload);
    }
    try {
      const entries = await loadLedger();
      // 累计口径 = 历史基准 + 官方同步合计 + 本机账本中「官方未覆盖」的那一段。
      // 官方覆盖窗口内的本机条目一律剔除（否则与官方数据重复计数）。
      const off = readOfficialSync();
      const base = baselineNumbers();
      let requestCount = base.requests;
      let totalTokens = base.tokens;
      let officialRequests = 0;
      let officialTokens = 0;
      if (off) {
        officialRequests = off.requests;
        officialTokens = off.tokens;
        requestCount += off.requests;
        totalTokens += off.tokens;
      }
      let localSkipped = 0;
      for (const entry of entries) {
        const provider = entry && entry.model && entry.model.provider;
        if (provider !== 'deepseek') continue;
        const at = Date.parse(entry.startedAt);
        if (inOfficialWindow(at, off)) { localSkipped += 1; continue; }
        requestCount += 1;
        // 与 /api/stats 同一口径（entryTokens：totalTokens 缺失时回退 hit+miss+out），避免两处不等
        totalTokens += entryTokens(entry).total;
      }

      const payload = {
        ok: true,
        data: {
          requestCount,
          totalTokens,
          truncated: entries.length >= SCAN_LIMIT,
          archive: archiveInfo,
          baseline: base,
          official: off ? {
            from: off.ds.from,
            to: off.ds.to,
            coveredUntil: off.until,
            days: off.ds.days.length,
            requests: officialRequests,
            tokens: officialTokens,
            cost: round4(off.cost),
          } : null,
          localSkipped,
        },
        fetchedAt: new Date().toISOString(),
      };
      usageCountCache = { at: MONO.monoNow(), payload };
      return c.json(payload);
    } catch (err) {
      const message = String((err && err.message) || err);
      log('warn', 'usage ledger query failed: ' + message);
      return c.json({ ok: false, error: 'usage_error', message: message }, 502);
    }
  });
}
