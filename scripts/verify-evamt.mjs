#!/usr/bin/env node
// evAmt 端到端验证：核对「事件小时按记账那一刻的实际入账额还原消费」这条独立路径。
//
// 背景：余额差口径对「事件小时」（充值/退款/赠金）不再整块丢弃，而是用
//   消费 = 首样本余额 − 末样本余额 + 充值 − 退款 + 赠金
// 还原。入账额来自样本上的 evAmt（由 recordSample 在记账那一刻累加），
// 它与「事后拿官方值反推」无关，因此是一条可独立验证的路径。
//
// 用法：
//   node scripts/verify-evamt.mjs                          # 读插件 state + 宿主账本
//   node scripts/verify-evamt.mjs --official <cost.csv>    # 追加与官方逐小时对照
//   node scripts/verify-evamt.mjs --selftest               # 用合成样本验证三分支（充值/退款/赠金）
// 可选参数：
//   --state <path>   插件 state.json（默认 <home>/plugin-data/deepseek-balance/state.json）
//   --ledger <path>  宿主用量账本（默认 <home>/usage-ledger.json）
//   --tz <minutes>   时区偏移（默认 480，即北京时间）
//   --json           以 JSON 输出（便于脚本消费）
//
// 没有 evAmt 样本时**不是错误**：打印「暂无 evAmt 样本（等下次真实充值）」并退出 0。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hourlyCosts, HOUR_MS } from '../lib/balance-samples.js';
import { entryTokens } from '../lib/pricing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');

/** 默认路径 */
export const DEFAULTS = {
  state: path.join(HANA_HOME, 'plugin-data', 'deepseek-balance', 'state.json'),
  ledger: path.join(HANA_HOME, 'usage-ledger.json'),
  tzMinutes: 480,
};

/** 合成样本：三个分支各一条，并给出期望值（供 --selftest 与自检引用） */
export const CASES = [
  {
    name: '充值',
    prev: 6.52,
    cur: 8.7,
    evAmt: { recharge: 10, refund: 0, grant: 0 },
    expect: 7.82, // 6.52 − 8.7 + 10
  },
  {
    name: '退款',
    prev: 5,
    cur: 7.5,
    evAmt: { recharge: 10, refund: 2.5, grant: 0 },
    expect: 5, // 5 − 7.5 + 10 − 2.5
  },
  {
    name: '赠金',
    prev: 5,
    cur: 5,
    evAmt: { recharge: 0, refund: 0, grant: 2 },
    expect: 2, // 5 − 5 + 2
  },
];

const T0 = Date.UTC(2026, 8, 27, 4, 0, 0); // 任意整点，仅用于构造样本键

/**
 * 用合成样本跑三个分支，返回逐项结果。
 * @returns {{name:string, got:number|null, expect:number, ok:boolean}[]}
 */
export function selfTest() {
  return CASES.map((c) => {
    const m = hourlyCosts([
      { t: T0, total: c.prev },
      { t: T0 + HOUR_MS, total: c.cur, ev: true, evAmt: c.evAmt },
    ]);
    const got = m.get(T0 + HOUR_MS).cost;
    return { name: c.name, got, expect: c.expect, ok: got === c.expect };
  });
}

function hourLabel(t, tzMinutes) {
  return new Date(t + tzMinutes * 60000).toISOString().replace('T', ' ').slice(0, 16);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 读宿主账本，按「整点小时」聚合 token 估算（与插件口径一致：仅 deepseek） */
function ledgerByHour(ledgerPath, tzMinutes) {
  const j = readJson(ledgerPath);
  if (!j || !Array.isArray(j.entries)) return null;
  const map = new Map();
  for (const e of j.entries) {
    const at = Date.parse(e.startedAt);
    if (!Number.isFinite(at)) continue;
    if (!(e.model && e.model.provider === 'deepseek')) continue;
    const key = Math.floor(at / HOUR_MS) * HOUR_MS;
    const o = map.get(key) || { n: 0, hit: 0, miss: 0, out: 0 };
    const tk = entryTokens(e);
    o.n += 1; o.hit += tk.hit; o.miss += tk.miss; o.out += tk.output;
    map.set(key, o);
  }
  return map;
}

/** 读官方 cost CSV（逐小时），键为「YYYY-MM-DDTHH」 */
function officialByHour(csvPath, tzMinutes) {
  let txt = '';
  try {
    txt = fs.readFileSync(csvPath, 'utf8');
  } catch (e) {
    return null;
  }
  const lines = txt.trim().split(/\r?\n/).slice(1);
  const map = new Map();
  for (const l of lines) {
    const p = l.split(',');
    if (p.length < 6) continue;
    const t = Date.parse(p[1]);
    const cost = Number(p[5]);
    if (!Number.isFinite(t) || !Number.isFinite(cost)) continue;
    const iso = new Date(t + tzMinutes * 60000).toISOString().slice(0, 13);
    map.set(iso, (map.get(iso) || 0) + cost);
  }
  return map;
}

/**
 * 生成报告（纯函数，便于单测）。
 * @param {{statePath:string, ledgerPath:string, officialPath?:string, tzMinutes?:number}} opt
 */
export function buildReport(opt) {
  const tz = Number.isFinite(Number(opt.tzMinutes)) ? Number(opt.tzMinutes) : DEFAULTS.tzMinutes;
  const st = readJson(opt.statePath);
  const samples = (st && Array.isArray(st.balanceSamples) ? st.balanceSamples : [])
    .map((s) => ({ t: Number(s.t), total: Number(s.total), ev: !!(s && s.ev), evAmt: s && s.evAmt }))
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.total))
    .sort((a, b) => a.t - b.t);

  const costs = hourlyCosts(samples);
  const events = [];
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s.ev) continue;
    const prev = samples[i - 1] || null;
    const info = costs.get(s.t) || {};
    events.push({
      hour: s.t,
      hourText: hourLabel(s.t, tz),
      evAmt: s.evAmt || null,
      prev,
      cur: s,
      restored: typeof info.cost === 'number' ? info.cost : null,
      adjacent: !!(prev && s.t - prev.t === HOUR_MS),
    });
  }

  const withAmt = events.filter((e) => e.evAmt);
  const ledger = opt.ledgerPath ? ledgerByHour(opt.ledgerPath, tz) : null;
  const official = opt.officialPath ? officialByHour(opt.officialPath, tz) : null;

  for (const e of events) {
    const key = new Date(e.hour + tz * 60000).toISOString().slice(0, 13);
    const lh = ledger ? ledger.get(e.hour) : null;
    e.tokenCost = lh
      ? { hit: lh.hit, miss: lh.miss, out: lh.out, n: lh.n }
      : null;
    e.officialCost = official ? (official.get(key) != null ? official.get(key) : null) : null;
  }

  return { tz, samples: samples.length, events, withAmtCount: withAmt.length, ledgerAvailable: !!ledger, officialAvailable: !!official };
}

/** 人类可读输出 */
export function formatReport(r) {
  const out = [];
  out.push('余额样本 = ' + r.samples + ' 条；带 evAmt 的事件小时 = ' + r.withAmtCount + ' 个');
  if (!r.events.length) {
    out.push('样本里没有任何事件小时（ev=true）。');
    return out.join('\n');
  }
  if (!r.withAmtCount) {
    out.push('暂无 evAmt 样本（等下次真实充值）：历史样本只带 ev 标记、不带入账额，');
    out.push('按实现会回落到 null（不臆测）。下次真实充值/退款/赠金时会自然写入 evAmt。');
  }
  for (const e of r.events) {
    out.push('');
    out.push('事件小时 ' + e.hourText + '（CST）');
    if (!e.evAmt) {
      out.push('  evAmt：缺失（历史样本）⇒ 该小时按实现回落 null，不参与合计');
    } else {
      const a = e.evAmt;
      out.push('  evAmt（记账那一刻的入账额）：充值 ' + (a.recharge || 0) + ' / 退款 ' + (a.refund || 0) + ' / 赠金 ' + (a.grant || 0));
    }
    out.push('  样本：' + (e.prev ? e.prev.total : '(无前一样本)') + ' → ' + e.cur.total + (e.adjacent ? '（与上一小时相邻）' : '（与上一小时不相邻 ⇒ 不可比）'));
    if (e.evAmt && e.restored !== null) {
      out.push('  还原：' + (e.prev ? e.prev.total : 0) + ' − ' + e.cur.total + ' + ' + (e.evAmt.recharge || 0) + ' − ' + (e.evAmt.refund || 0) + ' + ' + (e.evAmt.grant || 0) + ' = ' + e.restored);
    } else {
      out.push('  还原：—（缺 evAmt 或与上一小时不相邻）');
    }
    if (e.tokenCost) {
      out.push('  token 估算：hit ' + e.tokenCost.hit + ' / miss ' + e.tokenCost.miss + ' / out ' + e.tokenCost.out + '（宿主账本该小时 ' + e.tokenCost.n + ' 条）');
    } else {
      out.push('  token 估算：来源缺失（未读到宿主账本或该小时无条目）');
    }
    if (e.officialCost !== null) {
      out.push('  官方该小时：' + e.officialCost.toFixed(8) + (e.restored !== null ? '（差 ' + (e.restored - e.officialCost).toFixed(4) + '）' : ''));
    } else if (r.officialAvailable) {
      out.push('  官方该小时：该小时在传入的官方 CSV 里没有对应行（导出的最后一个窗口可能未走完）');
    } else {
      out.push('  官方对照：跳过（未传 --official <cost.csv>）');
    }
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const o = { statePath: DEFAULTS.state, ledgerPath: DEFAULTS.ledger, officialPath: null, tzMinutes: DEFAULTS.tzMinutes, json: false, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--state') o.statePath = argv[++i];
    else if (a === '--ledger') o.ledgerPath = argv[++i];
    else if (a === '--official') o.officialPath = argv[++i];
    else if (a === '--tz') o.tzMinutes = Number(argv[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('用法: node scripts/verify-evamt.mjs [--state <path>] [--ledger <path>] [--official <cost.csv>] [--tz <min>] [--json] [--selftest]');
    return;
  }
  if (o.selftest) {
    const rows = selfTest();
    for (const r of rows) console.log('  ' + (r.ok ? '✔' : '✘') + ' ' + r.name + ' 分支：还原 = ' + r.got + '（期望 ' + r.expect + '）');
    const allOk = rows.every((r) => r.ok);
    console.log(allOk ? '合成三分支全部通过。' : '合成三分支有失败项。');
    process.exitCode = allOk ? 0 : 1;
    return;
  }
  const r = buildReport(o);
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatReport(r));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
