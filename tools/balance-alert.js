// 余额预警工具（供定时任务/对话调用）
//
// 为什么要有这个工具：插件总线里没有 notify.send（那是宿主内部工具的事件），
// 插件无法直接推微信。因此拆成两步 —— 本工具只负责**判定并给出可直接转发的文本**，
// 投递交给宿主的官方通知能力（由 Agent 或定时任务调用 notify）。
//
// 节奏：只在「跌破阈值」那一刻推一次；持续低于不再重推；恢复后复位，下次再跌破仍立即推。
// （曾有「未解除则按固定间隔重推」，已按作者的要求移除；相关配置项也已从清单中退出。）
// 状态写在插件数据目录的 state.json（alertState / lastAlertPushAt），与路由共用该文件；写不进去时降级为整点桶。

export const name = 'deepseek_balance_alert';

export const description =
  '检查 DeepSeek 可用余额是否低于插件里配置的预警阈值。低于阈值时返回 due=true 与一条可直接发给用户的提醒文本（含官方充值入口链接）。供定时任务做余额推送：拿到 due=true 后，用 notify 工具把 text 发到目标平台（如微信）。';

export const parameters = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// 注意：本工具**会写 state.json**（持久化预警状态机 alertState / lastAlertPushAt），
// 因此**不声明 sessionPermission.readOnly** —— 声明 readOnly 却写盘是自相矛盾；
// 由宿主按实际能力授权（本插件 trust=full-access）。

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const TOP_UP_URL = 'https://platform.deepseek.com/top_up';

function fmt2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : String(n);
}

function cfg(ctx, key) {
  try {
    if (ctx && ctx.config && typeof ctx.config.get === 'function') return ctx.config.get(key);
  } catch (e) {
    /* 配置不可读时按未配置处理 */
  }
  return undefined;
}

function cfgSet(ctx, key, value) {
  try {
    if (ctx && ctx.config && typeof ctx.config.set === 'function') {
      ctx.config.set(key, value);
      return true;
    }
  } catch (e) {
    /* 写失败：下面按「无状态」降级处理 */
  }
  return false;
}

// 留痕：本工具被 isolated 定时任务的 Agent 消费，失败只体现为返回 JSON → 事后无痕。
// 双写：ctx.log（会并进调用方会话记录）+ 插件自有 diagnostics.log（用户可读，可经 GET /api/diagnostics 读回）。
let DIAG = null;
let DIAG_DIR = '';
async function ensureDiag(ctx) {
  DIAG_DIR = ctx && typeof ctx.dataDir === 'string' ? ctx.dataDir : '';
  if (DIAG) return;
  try { DIAG = await import('../lib/diag-log.js?v=' + Date.now()); } catch (e) { DIAG = null; }
}
function tlog(ctx, level, msg) {
  try {
    const logger = ctx && ctx.log;
    const fn = logger && (typeof logger[level] === 'function' ? logger[level] : logger.log);
    if (typeof fn === 'function') fn.call(logger, '[deepseek-balance:alert] ' + msg);
  } catch (e) { /* 忽略 */ }
  try { if (DIAG) DIAG.appendDiagnostic(DIAG_DIR, level, 'tool', msg); } catch (e) { /* 忽略 */ }
}

// 状态存储：优先写插件数据目录（与路由共用 state.json）；不可用时退回配置键（并回读校验）。
async function loadStore(ctx) {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = ctx && typeof ctx.dataDir === 'string' && ctx.dataDir ? ctx.dataDir : null;
    if (dir) {
      const file = path.join(dir, 'state.json');
      return {
        kind: 'file',
        read: () => {
          try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return {}; }
        },
        // 写：先读盘，只把自己负责的键（patch）合并进去，再临时文件 + rename 原子落盘。
        // 绝不整对象覆盖 —— 路由的 saveState 会在这同一个文件里写 balanceSamples /
        // lastToppedUpBalance 等键，整对象覆盖会把它们抹掉（实测踩过：每轮被判成
        // 「首次跌破」反复推送，也丢掉余额样本）。原子写避免崩溃时写坏 JSON。
        write: (patch) => {
          try {
            let disk = {};
            try {
              const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
              if (cur && typeof cur === 'object' && !Array.isArray(cur)) disk = cur;
            } catch (e) { disk = {}; }
            const merged = Object.assign({}, disk, patch || {});
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // tmp 名带 pid + 随机串：与路由共用同一 state.json，固定 '.tmp' 名跨进程并发写会互相覆盖
            const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
            fs.renameSync(tmp, file);
            return true;
          } catch (e) { return false; }
        },
      };
    }
  } catch (e) { /* 退化到配置 */ }
  return {
    kind: 'config',
    read: () => ({ alertState: cfg(ctx, 'toolAlertState'), lastAlertPushAt: cfg(ctx, 'toolAlertPushAt') }),
    write: (obj) => {
      const a = cfgSet(ctx, 'toolAlertState', obj.alertState);
      const b = cfgSet(ctx, 'toolAlertPushAt', obj.lastAlertPushAt);
      return a && b && Number(cfg(ctx, 'toolAlertState')) === Number(obj.alertState);
    },
  };
}

export async function execute(_args, ctx) {
  await ensureDiag(ctx);
  if (cfg(ctx, 'alertNotify') === false) {
    tlog(ctx, 'info', 'disabled by alertNotify=false; no balance check performed');
    return JSON.stringify({ ok: true, due: false, reason: 'disabled' });
  }
  const threshold = Number(cfg(ctx, 'alertThreshold'));
  if (!Number.isFinite(threshold) || threshold <= 0) {
    tlog(ctx, 'info', 'no threshold configured; no balance check performed');
    return JSON.stringify({ ok: true, due: false, reason: 'no_threshold' });
  }

  const apiKey = cfg(ctx, 'apiKey');
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    tlog(ctx, 'warn', 'not configured: empty apiKey');
    return JSON.stringify({ ok: false, due: false, error: 'not_configured' });
  }

  let body = null;
  try {
    const res = await ctx.network.fetch(BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + apiKey.trim(), Accept: 'application/json' },
    });
    if (!res || !res.ok) {
      tlog(ctx, 'warn', 'upstream error: HTTP ' + (res && res.status));
      return JSON.stringify({ ok: false, due: false, error: 'upstream_' + (res && res.status) });
    }
    body = await res.json();
  } catch (e) {
    const m = String((e && e.message) || e);
    tlog(ctx, 'warn', 'upstream fetch failed: ' + m);
    return JSON.stringify({ ok: false, due: false, error: m });
  }

  const info = body && body.balance_infos && body.balance_infos[0];
  if (!info) {
    tlog(ctx, 'warn', 'upstream payload unrecognized (balance_infos[0] missing)');
    return JSON.stringify({ ok: false, due: false, error: 'bad_response' });
  }
  const total = Number(info.total_balance);
  const currency = typeof info.currency === 'string' && info.currency ? info.currency : 'CNY';
  const sym = currency === 'USD' ? '$' : '¥';
  const low = Number.isFinite(total) && total < threshold;

  // 节奏：刚跌破阈值 → 立即推一次；持续低于不重推；恢复 → 复位，下次再跌破仍立即推。
  // 状态写在插件数据目录的 state.json（loadStore 已优先走这条路）；读不到 dataDir 时退回配置键。
  const store = await loadStore(ctx);
  const st = (store.read() || {});
  const wasAlerting = Number(st.alertState) === 1;
  const now = Date.now();
  let due = false;
  let reason = 'normal';
  if (low) {
    // 同一次跌破只推一次：已推过就不再重推
    reason = wasAlerting ? 'still_low' : 'entered_alert';
    if (!wasAlerting) due = true;
  } else {
    reason = wasAlerting ? 'recovered' : 'normal';
  }
  let persisted = true;
  if (due) persisted = store.write({ alertState: 1, lastAlertPushAt: now });
  else if (!low && wasAlerting) persisted = store.write({ alertState: 0, lastAlertPushAt: 0 });
  // 持久化不可用时退化为「整点桶」（每小时只在前 5 分钟推），避免每 5 分钟刷屏；降级必须留痕
  if (!persisted && low) {
    const inBucket = now % 3600000 < 300000;
    due = inBucket;
    reason = inBucket ? 'bucket_alert' : 'bucket_wait';
    tlog(ctx, 'warn', 'state persist FAILED (store=' + store.kind + ') -> degraded to hourly bucket; due=' + due + ' reason=' + reason);
  } else if (persisted && due) {
    tlog(ctx, 'info', 'alert entered: pushed once; lastAlertPushAt=' + now + ' total=' + fmt2(total));
  } else if (persisted && reason === 'recovered') {
    tlog(ctx, 'info', 'alert recovered: alertState reset to 0');
  }
  tlog(ctx, 'info', 'decision: alerting=' + low + ' due=' + due + ' reason=' + reason + ' threshold=' + fmt2(threshold) + ' total=' + fmt2(total));

  // 注意：工具返回值必须是**字符串**（返回对象会被宿主渲染成 "[object Object]"，Agent 读不到字段）
  return JSON.stringify({
    ok: true,
    due,
    reason,
    alerting: low,
    total,
    threshold,
    currency,
    text: due
      ? 'DeepSeek API 可用余额 ' + sym + fmt2(total) + '，低于预警阈值 ' + sym + fmt2(threshold) + '。点此去充值：' + TOP_UP_URL
      : '',
    hint: due ? '请把 text 原文发给用户（微信里该链接可直接点开）；若 notify 投递失败，请回报失败并改走桌面通知。' : '本轮无需通知',
  });
}
