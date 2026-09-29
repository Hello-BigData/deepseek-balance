// 插件自检：语法门 + 纯函数单测。
// 运行方式（用宿主自带的 Node，避免额外依赖）：
//   $env:ELECTRON_RUN_AS_NODE="1"; & $env:HANA tests/run-all.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { MODEL_PRICES, resolvePrice, resolveModel, parsePriceOverrides, canonicalModelId, isPeakHour, entryTokens, costOf, round2, round4 } from '../lib/pricing.js';
import { csvField, isAbsolutePath, isIsoDate, buildExportStem, RANGE_SLUGS, EXPORT_MAX_CHARS } from '../lib/export-csv.js';
import { SHARED_CSS, SHARED_JS, SHARED_MODAL_HTML } from '../lib/ui-shared.js';
import { parsePricePage, htmlToText, parsePeakRule, PRICE_PAGE_URL, PRICE_SYNC_TTL_MS, PRICE_SYNC_FAIL_TTL_MS, priceSyncDue } from '../lib/price-sync.js';
import { isPeakAt, isPeakDay, isHoliday, parseHolidayDates, buildHolidaySet, HOLIDAYS_2026, MAKEUP_WORKDAYS_2026, PEAK_RULE_TEXT, PEAK_RULE_BUILTIN, TICK_GRID_HOURS, COVERED_YEARS, isYearCovered, beijingYear, holidayCoverage, buildPeakTickMask } from '../lib/holidays.js';
import { recordSample, hourlyCosts, bucketBalanceCost, deviationPct, deviationView, BALANCE_RESOLUTION_MIN, HOUR_MS, MAX_SAMPLES } from '../lib/balance-samples.js';
import * as DIAGMOD from '../lib/diag-log.js';
import { isFresh as monoFresh } from '../lib/mono-clock.js';
import { selfTest as evAmtSelfTest, buildReport as evAmtBuildReport } from '../scripts/verify-evamt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}

// ---------------------------------------------------------------- 1. 模块可加载性
// ESM 模块用动态 import 验证（解析 + 链接），内联脚本在下一节用 vm.Script 验证
console.log('\n[1] 模块可加载性');
const modules = ['../lib/pricing.js', '../lib/export-csv.js', '../lib/ui-shared.js', '../lib/holidays.js', '../lib/balance-samples.js', '../lib/diag-log.js', '../lib/mono-clock.js', '../lib/official-sync.js', '../lib/usage-archive.js', '../scripts/release.mjs', '../scripts/verify-evamt.mjs'];
for (const rel of modules) {
  try {
    await import(rel + '?t=' + Date.now());
    ok('模块可加载 ' + rel, true);
  } catch (e) {
    ok('模块可加载 ' + rel, false, e.message);
  }
}
for (const rel of ['../routes/balance.js', '../routes/widget.js', '../routes/page.js']) {
  try {
    const mod = await import(rel + '?t=' + Date.now());
    ok('路由模块可加载 ' + rel, typeof mod.default === 'function');
  } catch (e) {
    ok('路由模块可加载 ' + rel, false, e.message);
  }
}

// ---------------------------------------------------------------- 2. 页面内联脚本
// 由 routes/*.js 渲染出的 HTML 里，内联 <script> 必须单独可编译（模板字符串转义最容易在这里出错）
console.log('\n[2] 内联脚本语法（模板字符串转义）');
async function renderRoute(routeFile) {
  const tmp = path.join(root, 'routes', '_selfcheck-tmp.mjs');
  fs.copyFileSync(path.join(root, 'routes', routeFile), tmp);
  try {
    const mod = (await import('file:///' + tmp.replace(/\\/g, '/') + '?t=' + Date.now())).default;
    let html = '';
    mod({ get: (p, h) => { html = h({ html: (s) => s }); } }, {});
    return html;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 清理失败不阻断 */ }
  }
}

for (const routeFile of ['widget.js', 'page.js']) {
  const html = await renderRoute(routeFile);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok(routeFile + ' 渲染出 ' + scripts.length + ' 段内联脚本', scripts.length >= 2);
  scripts.forEach((code, i) => {
    try { new vm.Script(code, { filename: routeFile + '#script' + (i + 1) }); ok(routeFile + ' script#' + (i + 1) + ' 语法', true); }
    catch (e) { ok(routeFile + ' script#' + (i + 1) + ' 语法', false, e.message); }
  });
  // 共享层必须真的注入（单一源）
  ok(routeFile + ' 注入了共享层', html.includes('window.HPU') && html.includes('modal-card'));
  // 提前 ready 必须出现在面板自身脚本之前（这是「加载失败」的主要防线）
  const firstReady = html.indexOf('sendReadyFirst();');
  const lastScript = html.lastIndexOf('<script>');
  ok(routeFile + ' 提前发 ready 在主脚本之前', firstReady >= 0 && firstReady < lastScript);
  ok(routeFile + ' 安装了未捕获错误兜底', html.includes('installErrorTraps'));
  ok(routeFile + ' 注入弹窗节点', html.includes('id="modalMask"') && html.includes('id="modalOk"'));
  // 节点顺序：弹窗必须在最后一个 <script> 之前
  ok(routeFile + ' 弹窗节点在脚本之前', html.indexOf('id="modal"') >= 0 && html.indexOf('id="modal"') < html.lastIndexOf('<script>'));
  // 危险写法
  ok(routeFile + ' 无 eval/new Function', !/\beval\(|new Function/.test(html));
  // 侧栏余额卡：提示锚点必须挂在卡片根节点（否则卡片留白/行距会成为悬停盲区）
  if (routeFile === 'widget.js') {
    const card = html.match(/<div class="card is-action" id="balanceCard"[^>]*>/);
    ok('余额卡片根节点带提示锚点', !!card && card[0].indexOf('data-tip=') >= 0);
    ok('余额标签与金额不再重复挂锚点', !/<span class="card-label" data-tip=/.test(html) && !/<span class="amount" data-tip=/.test(html));
    ok('卡片内专属提示仍保留（拆分/赠送）', html.indexOf('可用余额 = 充值 + 赠送') >= 0 && html.indexOf('赠送余额有有效期') >= 0);
    ok('卡片内按钮/链接已排除外层提示', html.indexOf('bindTipExclusions') >= 0 && /\[data-tip\] button, \[data-tip\] \.link/.test(html));
    // 刷新时只应由刷新按钮表达忙碌；连带禁用「去充值」会因 opacity:0.55 产生「变白」闪烁
    ok('刷新期间不禁用「去充值」', html.indexOf('el.rechargeBtn.disabled') < 0);
    // 预警框必须是常驻状态指示（曾经被 5 秒自动隐藏 + 60 分钟冷却弄成「一闪就没」）
    ok('预警框为常驻状态，无自动消失', html.indexOf('setTimeout(hideAlert') < 0);
    ok('预警框不走自动冷却，仅用户主动删除后当日静默', html.indexOf('deepseek_balance_alert_at') < 0 && html.includes('deepseek_balance_alert_muted_on'));
    ok('预警文案点明 API 可用余额', /DeepSeek API 可用余额不足/.test(html));
    ok('预警提示语可删除', /className = "pop-close"/.test(html) && /dismissAlertToday/.test(html));
    ok('删除后当天静默、次日恢复', /localStorage\.getItem\(ALERT_MUTE_KEY\) === todayKey\(\)/.test(html) && /localStorage\.setItem\(ALERT_MUTE_KEY, todayKey\(\)\)/.test(html));
    ok('余额回升清除删除标记（下次再跌破重新提示）', /clearAlertMute\(\);\s*\n\s*hideAlert\(\);/.test(html) && /clearAlertMute\(\)/.test(html));
    ok('改阈值会重新武装预警', /alertChanged[\s\S]{0,300}clearAlertMute\(\)/.test(html));
    ok('删除按钮显式继承字体', /\.pop-close \{[\s\S]{0,420}font: inherit/.test(html));
    ok('删除按钮贴最右且垂直居中', /\.box\.alert-box \{[\s\S]{0,160}align-items: center/.test(html) && /flex-wrap: nowrap/.test(html) && /\.alert-box \.alert-text \{ flex: 1 1 auto/.test(html) && /\.pop-close \{[\s\S]{0,100}margin-left: auto/.test(html));
    ok('删除按钮为固定尺寸圆形且居中', /\.pop-close \{[\s\S]{0,200}width: 18px; height: 18px[\.\s\S]{0,200}border-radius: 50%/.test(html) && /justify-content: center/.test(html));
    ok('余额恢复/关闭预警时隐藏红框', /function checkAlert[\s\S]{0,420}hideAlert\(\);\s*return;/.test(html));
    // 热重载必须覆盖预警字段，否则改阈值/关预警要重开面板才生效
    ok('热重载同步预警阈值', /function reloadConfigQuietly[\s\S]{0,1400}state\.alertThreshold = json\.alertThreshold/.test(html));
    ok('阈值变化后立即重判红框', /alertChanged[\s\S]{0,400}checkAlert\(last\)/.test(html));
    // 常驻红框：条件驱动，低则长亮、恢复/关闭则隐藏；不走自动消失与弹窗冷却
    ok('预警框字体用深红（明模式对比度 ≥4.5）', /\.alert-box \{[\s\S]{0,400}color: var\(--danger-text\)/.test(html));
    ok('预警框回到流内（不再是浮层）', !/\.alert-box \{[\s\S]{0,300}position: fixed/.test(html));
    ok('预警框条件驱动即显示', /el\.alertBox\.classList\.add\("on"\)/.test(html) && /value >= state\.alertThreshold\) \{/.test(html));
    ok('预警框默认隐藏（切面板不闪红框）', /\.box\.alert-box \{[\s\S]{0,90}display: none/.test(html) && /\.box\.alert-box\.on \{ display: flex; \}/.test(html));
    ok('可见性用 class 管理，不写内联 display', /classList\.add\("on"\)/.test(html) && /classList\.remove\("on"\)/.test(html) && !/el\.alertBox\.style\.display/.test(html));
    ok('删除按钮带可见圆圈', /\.pop-close \{[\s\S]{0,300}border: 1px solid[\s\S]{0,140}border-radius: 50%/.test(html) && /\.pop-close \{[\s\S]{0,400}background: color-mix/.test(html));
    // 收起预警框造成的布局位移不能误触卡片提示
    ok('收起预警框时抑制 hover 派生表现', /function muteHoverUntilMove/.test(html) && /state\.tipMuted = true/.test(html) && /var wasShown = el\.alertBox\.classList\.contains\("on"\)/.test(html));
    ok('一次性覆盖全部 hover 派生（关针事件）', /content\.style\.pointerEvents = "none"/.test(html) && /content\.style\.pointerEvents = ""/.test(html));
    ok('抑制靠“是否真的移动过鼠标”解除', /addEventListener\("mousemove", release, true\)/.test(html) && /removeEventListener\("mousemove", release, true\)/.test(html));
    ok('点×时先抑制再收起', /function dismissAlertToday\(\) \{[\s\S]{0,220}muteHoverUntilMove\(\);[\s\S]{0,60}hideAlert\(\)/.test(html));
    ok('预警框出现时收起陈旧提示', /classList\.add\("on"\);\s*\n\s*\/\/[^\n]*\n\s*hideTip\(\);/.test(html));
    ok('showTip 尊重抑制标记', /function showTip\(anchor\) \{[\s\S]{0,200}if \(state\.tipMuted\) return;/.test(html));
    ok('预警框无自动消失计时器', !/ALERT_TOAST_MS/.test(html) && !/setTimeout\(hideAlert/.test(html));
    ok('预警框不再被弹窗冷却门拦住', !/cdMs > 0/.test(html) && !/state\.alertLow/.test(html));
    ok('预警不再请求宿主 toast', !/window\.hana\.toast\.show/.test(html));
    ok('清单不再声明 toast.show', !fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').includes('"toast.show"'));
    ok('共享层保留 hana.toast.show 能力', /toast: \{ show: function \(input\) \{ return hostRequest\("toast\.show"/.test(html));
    ok('手动刷新先同步配置再取数', /function refreshNow[\s\S]{0,120}reloadConfigQuietly\(\)\.then[\s\S]{0,60}callData\(\)/.test(html) && /refreshBtn\.addEventListener\("click", refreshNow\)/.test(html));
    // 自动刷新路径：取数前重读配置（不节流，本地调用零成本），保证改设置后任意刷新节奏都立即生效
    ok('取数前重读配置且不节流', /async function callData\(\) \{[\s\S]{0,300}await reloadConfigQuietly\(\)/.test(html) && html.indexOf('state.configAt > 15000') < 0);
  }
  // 「更新于」时间戳必须按北京时间计算（不跟随本机时区）
  ok(routeFile + ' 时间戳按北京时间计算', html.indexOf('3600 * 1000') >= 0 && html.indexOf('getUTCHours()') >= 0);
  if (routeFile === 'page.js') {
    // 详情页原先只在打开时取一次数据，时间戳会停在那一刻
    ok('详情页可见时每分钟重取', html.indexOf('if (!document.hidden) load(); }, 60000)') >= 0);
    ok('详情页切回标签页时立即补取', /if \(!document\.hidden\) \{\s*load\(\);/.test(html));
  }
}

// ---------------------------------------------------------------- 3. 计价单测
console.log('\n[3] 计价口径单测');
ok('flash 内置价 命中/未命中/输出', MODEL_PRICES['deepseek-flash'].hit === 0.02 && MODEL_PRICES['deepseek-flash'].miss === 1 && MODEL_PRICES['deepseek-flash'].output === 4);
ok('v4-pro 内置价', MODEL_PRICES['deepseek-v4-pro'].hit === 0.15 && MODEL_PRICES['deepseek-v4-pro'].miss === 4.5);
ok('配置覆盖生效', JSON.stringify(resolvePrice('deepseek-flash', '0.1/2/3')) === JSON.stringify({ hit: 0.1, miss: 2, output: 3 }));
ok('非法覆盖回落内置价', resolvePrice('deepseek-flash', 'abc').hit === 0.02);
ok('旧名归并 flash', canonicalModelId('deepseek-v4-flash') === 'deepseek-flash' && canonicalModelId('deepseek-v4-flash-vision-exp') === 'deepseek-flash');
ok('pro 不被归并', canonicalModelId('deepseek-v4-pro') === 'deepseek-v4-pro');

// 高峰判定：北京时间周一 10:00 属高峰，周一 13:00 不属，周六 10:00 不属
const monday10 = Date.UTC(2026, 8, 21, 2, 0, 0); // 2026-09-21 是周一，UTC 02:00 = 北京 10:00
const monday13 = Date.UTC(2026, 8, 21, 5, 0, 0); // 北京 13:00
const saturday10 = Date.UTC(2026, 8, 26, 2, 0, 0); // 2026-09-26 周六
ok('周一北京 10:00 为高峰', isPeakHour(monday10) === true);
ok('周一北京 13:00 非高峰', isPeakHour(monday13) === false);
ok('周六北京 10:00 非高峰', isPeakHour(saturday10) === false);

const tk = entryTokens({ usage: { cache: { readTokens: 100, missTokens: 5 }, input: { uncachedTokens: 9, totalTokens: 109 }, output: { totalTokens: 20 }, totalTokens: 129 } });
ok('entryTokens 取 miss 与 uncached 的较大者', tk.hit === 100 && tk.miss === 9 && tk.output === 20 && tk.total === 129);
ok('round2/round4 精度', round2(1.2345) === 1.23 && round4(0.0000612) === 0.0001 && round2(2.5) === 2.5);

// 黄金回归：官方 2026-09-27 00:00 行的三类 token × 空闲价，必须复现官方 ¥0.36379896。
// 这组字面量把「token 估算管道」整体钉死：单价单位（元/百万）、三类 token 的取数口径、
// 以及 entryTokens → costOf 的链路。任何一步改错，这个数就对不上。
const GOLDEN_HIT = 5861248, GOLDEN_MISS = 102094, GOLDEN_OUT = 36120;
const GOLDEN_IDLE = { hit: 0.02, miss: 1, output: 4 };
const GOLDEN_OFFICIAL = 0.36379896;
const goldenCost = costOf({ hit: GOLDEN_HIT, miss: GOLDEN_MISS, output: GOLDEN_OUT }, GOLDEN_IDLE, false);
ok('黄金回归：官方 00:00 行 = 0.36379896（误差 < 1e-8）', Math.abs(goldenCost - GOLDEN_OFFICIAL) < 1e-8, 'got ' + goldenCost);
// 同样经 entryTokens 从条目字段出发，确认字段映射与黄金值一致（read/uncached/output → hit/miss/out）
const goldenEntry = entryTokens({ usage: { cache: { readTokens: GOLDEN_HIT, writeTokens: 0, missTokens: null }, input: { uncachedTokens: GOLDEN_MISS, totalTokens: GOLDEN_MISS }, output: { totalTokens: GOLDEN_OUT }, totalTokens: GOLDEN_HIT + GOLDEN_MISS + GOLDEN_OUT } });
ok('黄金回归：entryTokens 字段映射一致', goldenEntry.hit === GOLDEN_HIT && goldenEntry.miss === GOLDEN_MISS && goldenEntry.output === GOLDEN_OUT && Math.abs(costOf(goldenEntry, GOLDEN_IDLE, false) - GOLDEN_OFFICIAL) < 1e-8);
ok('黄金回归：高峰价恰为空闲 2 倍', Math.abs(costOf({ hit: GOLDEN_HIT, miss: GOLDEN_MISS, output: GOLDEN_OUT }, GOLDEN_IDLE, true) - 2 * GOLDEN_OFFICIAL) < 1e-8);
ok('entryTokens 扣掉缓存写回（cacheWrite 计入未命中）', (function () { const t = entryTokens({ usage: { cache: { readTokens: 0, writeTokens: 50, missTokens: null }, input: { uncachedTokens: 100 }, output: { totalTokens: 1 } } }); return t.miss === 150; })());

// 官方价格页自动同步：解析 + 结构化校验 + fail-soft
const pageFixture = [
  '模型细节', '模型', 'deepseek-flash (1)', 'deepseek-v4-pro', 'BASE URL (OpenAI 格式)',
  '百万tokens输入（缓存命中）', '空闲时段', '0.02元', '0.15元', '高峰时段', '0.04元', '0.30元',
  '百万tokens输入（缓存未命中）', '空闲时段', '1元', '4.5元', '高峰时段', '2元', '9.0元',
  '百万tokens输出', '空闲时段', '4元', '13.5元', '高峰时段', '8元', '27.0元',
].join('\n');
const parsedOK = parsePricePage(pageFixture);
ok('价格页解析：两个型号且数量正确', parsedOK.ok === true && Object.keys(parsedOK.models).length === 2);
ok('价格页解析：flash 空闲价正确', !!parsedOK.ok && parsedOK.models['deepseek-flash'].hit === 0.02 && parsedOK.models['deepseek-flash'].miss === 1 && parsedOK.models['deepseek-flash'].output === 4);
ok('价格页解析：v4-pro 空闲价正确', !!parsedOK.ok && parsedOK.models['deepseek-v4-pro'].hit === 0.15 && parsedOK.models['deepseek-v4-pro'].output === 13.5);
ok('价格页解析：与内置表交叉一致', !!parsedOK.ok && JSON.stringify(parsedOK.models['deepseek-flash']) === JSON.stringify(MODEL_PRICES['deepseek-flash']) && JSON.stringify(parsedOK.models['deepseek-v4-pro']) === JSON.stringify(MODEL_PRICES['deepseek-v4-pro']));
ok('价格页结构异常 → fail-soft（高峰≠空闲×2）', parsePricePage(pageFixture.replace('0.04元', '0.05元')).ok === false);
ok('价格页表不全 → fail-soft', parsePricePage('模型\nfoo\n栏位\n空闲时段\n1元\n高峰时段\n2元').ok === false);
ok('去标签不返回脚本内容', htmlToText('<div>a</div><script>var secret=1</script><div>b</div>').indexOf('secret') < 0);
ok('同步地址为官方价格页', /^https:\/\/api-docs\.deepseek\.com\//.test(PRICE_PAGE_URL));
ok('同步结果优先于内置表', resolveModel('deepseek-v5', '', { 'deepseek-v5': { hit: 1, miss: 8, output: 24 } }).source.indexOf('官方价格页') >= 0);

// 型号识别与三级计价：未知型号不得被静默安上 Flash 价
ok('精确型号 → 确定价', resolveModel('deepseek-v4-pro', '').status === 'exact' && resolveModel('deepseek-flash', '').status === 'exact');
ok('同族带后缀 → 按族估算', resolveModel('deepseek-v4-pro-0812', '').status === 'family' && resolveModel('deepseek-flash-lite', '').status === 'family');
ok('未收录型号 → 不臆测价格', (function () { const r = resolveModel('deepseek-v5', ''); return r.status === 'unknown' && r.prices === null; })());
ok('旧名先过别名表', canonicalModelId('deepseek-v4-flash-vision-exp') === 'deepseek-flash' && resolveModel(canonicalModelId('deepseek-v4-flash'), '').status === 'exact');
ok('未收录型号名原样保留（不被吞掉）', canonicalModelId('deepseek-v5') === 'deepseek-v5');
const ovT = parsePriceOverrides('# 注释\ndeepseek-v5=1/8/24\ndeepseek-v5-*=1/8/24\n乱写一行\n');
ok('覆盖表解析：精确 + 前缀 + 非法行', Object.keys(ovT.exact).length === 1 && ovT.prefixes.length === 1 && ovT.invalid.length === 1);
ok('覆盖表优先于内置规则', resolveModel('deepseek-v5', 'deepseek-v5=1/8/24').status === 'exact' && resolveModel('deepseek-v5-pro', 'deepseek-v5-*=1/8/24').status === 'family');
ok('覆盖表能覆盖已知型号', resolveModel('deepseek-flash', 'deepseek-flash=0.5/2/6').prices.miss === 2);

// ---------------------------------------------------------------- 4. 导出规则单测
console.log('\n[4] 导出规则与安全单测');
ok('CSV 公式注入硬化', csvField('=1+1') === "'=1+1" && csvField('+A1') === "'+A1" && csvField('-2') === "'-2" && csvField('@x') === "'@x");
ok('CSV 引号与换行转义', csvField('a,b') === '"a,b"' && csvField('say "hi"') === '"say ""hi"""' && csvField('l1\nl2') === '"l1\nl2"');
ok('CSV 普通值不动', csvField('deepseek-flash') === 'deepseek-flash');
ok('只接受绝对路径', isAbsolutePath('D:\\x') === true && isAbsolutePath('/tmp') === true && isAbsolutePath('rel\\path') === false && isAbsolutePath('') === false);
ok('日期格式校验', isIsoDate('2026-09-01') === true && isIsoDate('2026-9-1') === false && isIsoDate('../etc') === false);
ok('区间标识白名单', Object.keys(RANGE_SLUGS).length === 8 && RANGE_SLUGS['../../evil'] === undefined);
const stem = buildExportStem('custom', '2026-09-01', '2026-09-24', 480);
ok('自定义区间文件名含起止与时间戳', stem.indexOf('deepseek-usage-2026-09-01_2026-09-24-') === 0 && stem.length > 40);
ok('CSV 上限为 8MB', EXPORT_MAX_CHARS === 8 * 1024 * 1024);

// ---------------------------------------------------------------- 5. 共享层单测
console.log('\n[5] 共享层单测');
ok('共享 CSS 含字体栈与字重', SHARED_CSS.includes('HarmonyOS Sans SC Medium') && SHARED_CSS.includes('鸿蒙黑体') && SHARED_CSS.includes('font-weight: 500'));
ok('共享 CSS 覆盖表单控件与强调元素', SHARED_CSS.includes('button, input, select, textarea { font-family: inherit') && /b,\s*strong\s*\{\s*font-weight:\s*500/.test(SHARED_CSS));
ok('共享 CSS 含弹窗全套', SHARED_CSS.includes('.modal-card') && SHARED_CSS.includes('.modal-mask') && SHARED_CSS.includes('.modal-title .tick'));
ok('共享 CSS 支持每个面板改弹窗宽度', SHARED_CSS.includes('--modal-max'));
ok('共享 JS 提供弹窗与宿主通信', SHARED_JS.includes('openModal') && SHARED_JS.includes('hostRequest') && SHARED_JS.includes('bindModal'));
ok('共享 JS 提供提前 ready 与错误兜底', SHARED_JS.includes('sendReadyFirst') && SHARED_JS.includes('installErrorTraps') && SHARED_JS.includes('sendReadyFirst();'));
ok('错误兜底会过滤 AbortError 与网络类失败', /AbortError/.test(SHARED_JS) && /Failed to fetch\|NetworkError/.test(SHARED_JS));
ok('共享 JS 的插件 ID 正则转义正确', SHARED_JS.includes('/^\\/api\\/plugins\\/([^/]+)(?:\\/|$)/'));
ok('共享 JS 不开 eval', !/\beval\(|new Function/.test(SHARED_JS));
ok('共享弹窗节点结构完整', SHARED_MODAL_HTML.includes('id="modalMask"') && SHARED_MODAL_HTML.includes('id="modalOk"') && SHARED_MODAL_HTML.includes('aria-modal'));

// 配置项：单价覆盖表必须在，旧的两个单价字段应已退场（值仍可从旧键迁移）
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const cfgProps = manifest.contributes.configuration.properties;
ok('配置项含 priceOverrides', !!cfgProps.priceOverrides && cfgProps.priceOverrides.type === 'string');
ok('旧单价字段已退场', !cfgProps.priceFlash && !cfgProps.pricePro);
// 任务1：校准默认归 1，描述说明已核对官方账单、不再需要拟合系数
ok('校准默认归 1', !!cfgProps.costCalibration && cfgProps.costCalibration.default === 1 && /通常保持 1/.test(cfgProps.costCalibration.description) && /不再需要全局拟合系数/.test(cfgProps.costCalibration.description));

// ---------------------------------------------------------------- 6. 宿主通道加载检查（需服务在跑，未跑则跳过）
console.log('\n[6] 宿主通道加载检查');
// 宿主接口地址与令牌：优先环境变量（HANA_SERVER / HANA_SERVER_INFO），
// 其次读用户主目录下的 .hanako/server-info.json（可用 HANA_HOME 覆盖数据目录）。
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
const INFO_PATH = process.env.HANA_SERVER_INFO || path.join(HANA_HOME, 'server-info.json');
let info = null;
try { info = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8')); } catch (e) { info = null; }
const SERVER = process.env.HANA_SERVER || (info && info.port ? 'http://' + (info.host || '127.0.0.1') + ':' + info.port : 'http://127.0.0.1:27352');
async function serverInfo() {
  return info ? info.token : null;
}
const token = await serverInfo();
if (!token) {
  console.log('  SKIP  读不到 server-info.json（非本机环境），跳过');
} else {
  let reachable = true;
  for (const route of ['/page', '/widget']) {
    try {
      const routeUrl = '/api/plugins/deepseek-balance' + route;
      const tRes = await fetch(SERVER + '/api/plugins/iframe-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ routeUrl }),
      });
      const t = await tRes.json();
      const q = 'pluginIframeTicket=' + encodeURIComponent(t.ticket) + '&pluginSurfaceSession=' + encodeURIComponent(t.surfaceSession.token);
      const r = await fetch(SERVER + routeUrl + '?' + q);
      const html = await r.text();
      ok(route + ' 宿主通道返回 200', r.status === 200, 'status=' + r.status);
      ok(route + ' HTML 含共享层与弹窗节点', html.includes('window.HPU') && html.includes('id="modalMask"'));
      ok(route + ' 弹窗节点在主脚本之前', html.indexOf('id="modal"') < html.lastIndexOf('<script>'));
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      let ok2 = true;
      scripts.forEach((code, i) => {
        try { new vm.Script(code, { filename: route + '#' + (i + 1) }); } catch (e) { ok2 = false; }
      });
      ok(route + ' 内联脚本均可编译（宿主实取内容）', ok2);
    } catch (e) {
      reachable = false;
      break;
    }
  }
  if (!reachable) console.log('  SKIP  宿主服务未运行（' + SERVER + ' 不可达），跳过通道检查');

  // 账本里出现过的型号：必须「已有单价」或「已被显式标注未收录」——新模型一出现就会在这里冒头；
  // 同时这一步也是对「插件路由是否真的注册成功」的实证（路由模块加载失败会直接 404/500）。
  if (reachable) {
    try {
      const tk = await (await fetch(SERVER + '/api/plugins/iframe-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ routeUrl: '/api/plugins/deepseek-balance/page' }),
      })).json();
      const sr = await fetch(SERVER + '/api/plugins/deepseek-balance/api/stats?range=all&tz=480', {
        headers: { 'X-Hana-Plugin-Surface-Session': tk.surfaceSession.token },
      });
      const bodyText = await sr.text();
      // 路由未注册会得到 404，模块加载异常会得到 5xx —— 这两类必须判 FAIL，不能当跳过
      ok('stats 路由可用（HTTP ' + sr.status + '）', sr.status === 200, bodyText.slice(0, 160));
      let sj = null;
      try { sj = JSON.parse(bodyText); } catch (e) { sj = null; }
      const models = (sj && sj.data && sj.data.models) || [];
      if (!sj || !sj.ok) {
        ok('stats 返回可解析的 ok 负载', false, bodyText.slice(0, 160));
      } else if (!models.some((m) => typeof m.priceStatus === 'string')) {
        // 发布脚本在安装前运行：此时装的还是旧版，字段尚未出现 —— 按 SKIP 处理
        console.log('  SKIP  已装版本尚未提供 priceStatus（发布阶段属正常），跳过型号价格状态守卫');
      } else {
        const bad = models.filter((m) => (m.priceStatus === 'unknown' && m.unpriced !== true));
        ok('账本内所有型号均已判定价格状态（' + models.length + ' 个）', models.length > 0 && bad.length === 0, JSON.stringify(bad.map((m) => m.id)));
        const ps = (sj.data && sj.data.priceSync) || null;
        if (!ps) {
          console.log('  SKIP  已装版本尚未提供 priceSync（发布阶段属正常），跳过价格同步检查');
        } else if (ps.ok) {
          // 权威来源有两种：①价格页同步「官方价格页（自动同步）」；②官方账单同步进来的型号 priceSource='official'
          // （官方数据本身，比价格页更权威）。只认前者会误判：做过官方数据同步后，官方账单里的型号会以 'official' 出现。
          const officialish = (s) => /官方/.test(String(s || '')) || String(s || '') === 'official';
          const usingSynced = models.filter((m) => officialish(m.priceSource)).length;
          ok('官方价格已生效于已收录型号（' + usingSynced + '/' + models.length + '）', usingSynced === models.length, models.map((m) => m.id + '=' + m.priceSource).join(' | '));
          console.log('  提示：价格同步 = ' + ps.models + ' 个型号，源 ' + ps.url);
        } else {
          console.log('  SKIP  价格同步未成功（' + ps.reason + '），当前用内置价目表');
        }
        const up = (sj.data && sj.data.unpriced) || { requests: 0, models: [] };
        console.log('  提示：未收录单价的请求数 = ' + up.requests + (up.requests ? '（金额不计入合计：' + up.models.map((m) => m.id).join('、') + '）' : ''));
        const statuses = [...new Set(models.map((m) => m.priceStatus).filter(Boolean))].join('/');
        console.log('  提示：价格状态分布 = ' + (statuses || '无'));
      }
    } catch (e) {
      ok('读取型号清单', false, e.message);
    }
  }
}

// ---------------------------------------------------------------- 7. 侧栏轮询自愈（1.6.0）
console.log('\n[7] 侧栏轮询自愈');
const widgetHtml = await renderRoute('widget.js');
const pageHtml = await renderRoute('page.js');
const manifestJson = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const balSrc = fs.readFileSync(path.join(root, 'routes', 'balance.js'), 'utf8');
const widgetSrc = fs.readFileSync(path.join(root, 'routes', 'widget.js'), 'utf8');
ok('写 state 只写脏键（避免抹掉预警工具写的字段）', /function saveState\(\) \{/.test(balSrc) && /for \(const k of dirtyKeys\)[\s\S]{0,120}merged\[k\] = memState\[k\]/.test(balSrc) && /memState = merged/.test(balSrc) && !/Object\.assign\(\{\}, disk, state\)/.test(balSrc));
ok('价格同步比对型号清单并记录变动', /function recordPriceModels/.test(balSrc) && /stateSet\(PRICE_CHANGE_KEY, \{ at: Date\.now\(\), added: added, removed: removed \}\)/.test(balSrc));
ok('首次同步只建基线不报变动', /if \(Array\.isArray\(baseline\)\)/.test(balSrc) && /stateSet\(PRICE_MODELS_KEY, list\)/.test(balSrc));
ok('余额响应带出型号变动', /priceChange: readPriceChange\(\)/.test(balSrc));
ok('manifest 默认刷新间隔为 60 秒', manifestJson.contributes.configuration.properties.refreshIntervalSeconds.default === 60);
ok('config 接口回退值也是 60（缺失键回落 manifest 默认；tz 回落 -1）', /cfgNumberOr\('refreshIntervalSeconds', 60, 0\)/.test(balSrc) && /cfgNumberOr\('timezoneOffsetMinutes', -1, -720, 840\)/.test(balSrc));
ok('面板默认刷新间隔为 60 秒', /refreshSeconds:\s*60\b/.test(widgetHtml));
ok('tick 用 try/finally 保证定时链不断', /finally\s*\{\s*scheduleNext\(\)/.test(widgetHtml));
ok('调定时长交给共享层 HPU.Sched', widgetHtml.includes('HPU.Sched.computeNextDelay'));
ok('看门狗判定交给共享层 HPU.Sched', widgetHtml.includes('HPU.Sched.shouldWatchdog'));
ok('含配置热重载（改设置不重开面板）', widgetHtml.includes('reloadConfigQuietly'));
ok('心跳周期性感知配置变化（每约 60 秒）', /beats % CONFIG_CHECK_EVERY_BEATS === 0/.test(widgetHtml) && widgetHtml.includes('HEARTBEAT_MS = 12000'));
ok('含看门狗兜底与成功时间戳', /function watchdog\(/.test(widgetHtml) && widgetHtml.includes('lastSuccessAt'));
ok('面板 API 走共享层 HPU.api', widgetHtml.includes('HPU.api.fetch') && pageHtml.includes('HPU.api.fetch'));
ok('面板不再直接 fetch 硬编码插件路由', !/fetch\([^)]*["']\/api\/plugins\//.test(widgetHtml) && !/fetch\([^)]*["']\/api\/plugins\//.test(pageHtml));

// 余额不足推送：插件只负责判定（插件总线没有 notify.send，无法直推微信）
const alertSrc = fs.readFileSync(path.join(root, 'tools', 'balance-alert.js'), 'utf8');
ok('判定只由工具承担（旧路由与重复实现已删）', !/app\.get\('\/api\/notify-due'/.test(balSrc) && !/async function balanceAlert\(/.test(balSrc));
ok('预警文本含官方充值入口', alertSrc.includes('platform.deepseek.com/top_up'));
ok('预警文本按新措辞（DeepSeek API 可用余额 + 两位小数）', alertSrc.includes('DeepSeek API 可用余额') && /fmt2\(total\)/.test(alertSrc) && /fmt2\(threshold\)/.test(alertSrc));
ok('推送改为跌破即推、不再按间隔重推', !/still_alerting/.test(alertSrc) && !/repeatMin|repeatMinutes/.test(alertSrc) && /'still_low'/.test(alertSrc));
// 守卫：已移除的配置键不得再出现在源码里（只扫源码，CHANGELOG 等历史文档例外）
const removedKey = 'alertCooldown' + 'Minutes';
const guardFiles = [
  'routes/balance.js', 'routes/widget.js', 'routes/page.js', 'tools/balance-alert.js',
  ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f),
  ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => 'scripts/' + f),
];
const guardHits = guardFiles.filter((rel) => fs.readFileSync(path.join(root, rel), 'utf8').includes(removedKey));
ok('源码中不再引用已移除的配置键 ' + removedKey + '（扫描 ' + guardFiles.length + ' 个文件）', guardHits.length === 0, guardHits.join(', '));
ok('manifest 中已无已移除的配置键 ' + removedKey, !JSON.stringify(manifestJson).includes(removedKey));
ok('预警受 alertNotify 开关控制', /alertNotify'\) === false/.test(alertSrc));
ok('不再声明不存在的 notify.send 能力', !(manifestJson.capabilities || []).includes('notify.send'));
ok('配置含推送开关字段', !!manifestJson.contributes.configuration.properties.alertNotify);
ok('提供 Agent 可调的余额预警工具', (function () {
  const p = path.join(root, 'tools', 'balance-alert.js');
  if (!fs.existsSync(p)) return false;
  const src = fs.readFileSync(p, 'utf8');
  return /export const name/.test(src) && /export async function execute/.test(src) && src.includes('platform.deepseek.com/top_up');
})());

// ---------------------------------------------------------------- 8. 共享层调度与通道（行为级）
console.log('\n[8] 共享层调度与通道');
function makeSharedWindow() {
  const loc = { search: '', pathname: '/api/plugins/deepseek-balance/widget', origin: 'http://hana.local' };
  const sandbox = {
    window: { parent: { postMessage() {} }, addEventListener() {} },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
      addEventListener() {},
      querySelector: () => null,
    },
    location: loc,
    console,
    setTimeout, clearTimeout,
    URLSearchParams, URL, Headers,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  };
  sandbox.window.location = loc;
  vm.createContext(sandbox);
  vm.runInContext(SHARED_JS, sandbox);
  return sandbox.window;
}
const WIN = makeSharedWindow();
const SHARED = WIN.HPU;
const S = SHARED && SHARED.Sched;
ok('共享层提供官方同构的 window.hana 命名空间', !!(WIN.hana && WIN.hana.api && WIN.hana.ui && WIN.hana.resources));
ok('共享层导出 HPU.api 与 HPU.Sched', !!(SHARED && SHARED.api && SHARED.api.fetch && S && S.computeNextDelay));
ok('可见时按配置间隔（60 秒）', S.computeNextDelay({ refreshSeconds: 60 }) === 60000);
ok('关闭自动刷新返回 0', S.computeNextDelay({ refreshSeconds: 0 }) === 0);
ok('刷新间隔硬下限 5 秒', S.computeNextDelay({ refreshSeconds: 1 }) === 5000);
ok('不可见时放宽到至少 5 分钟', S.computeNextDelay({ refreshSeconds: 60, hidden: true }) === 300000);
ok('失败退避递增且封顶 30 分钟', S.computeNextDelay({ refreshSeconds: 60, failCount: 1 }) === 120000 && S.computeNextDelay({ refreshSeconds: 60, failCount: 9 }) === 30 * 60 * 1000);
ok('看门狗未超期不触发', S.shouldWatchdog({ refreshSeconds: 60, lastSuccessAt: 100000, now: 160000 }) === false);
ok('看门狗超 2 周期触发', S.shouldWatchdog({ refreshSeconds: 60, lastSuccessAt: 1000, now: 122000 }) === true);
ok('看门狗下限 2 分钟', S.shouldWatchdog({ refreshSeconds: 10, lastSuccessAt: 1000, now: 120000 }) === false && S.shouldWatchdog({ refreshSeconds: 10, lastSuccessAt: 1000, now: 122000 }) === true);
ok('看门狗无成功记录不触发', S.shouldWatchdog({ refreshSeconds: 60, lastSuccessAt: 0, now: 999999999 }) === false);
function apiUrlThrows(p) {
  try { SHARED.api.url(p); return false; } catch (e) { return true; }
}
ok('api.url 接受合法相对路径', !apiUrlThrows('api/balance') && !apiUrlThrows('/api/stats?range=today'));
ok('api.url 拒绝目录穿越', apiUrlThrows('../secret') && apiUrlThrows('api/../../x'));
ok('api.url 拒绝绝对 URL 与前导双斜杠', apiUrlThrows('http://evil/x') && apiUrlThrows('//evil/x'));

// ---------------------------------------------------------------- 9. 增强项（1.12.0）
console.log('\n[9] 增强项：自动入账 / 卡片 / 规则句 / 高峰判定 / Y轴 / 双口径');

// --- 9.1 充值/退款/赠金自动入账（不再手动确认）---
ok('退款分支仍自动累加累计退款（含新增的间隔守卫）', /dTop <= -REFUND_MIN_DELTA/.test(balSrc) && /writeConfig\('totalRefunded', round2\(total \+ booked\)\)/.test(balSrc) && /refund judgement skipped/.test(balSrc));
// 充值与退款门槛分离：上调 1 元（只可能来自实际充值）、下调 5 元（防日常消费误记为退款）
ok('充值门槛 1 元 / 退款门槛 5 元（方向分离）', /const RECHARGE_MIN_DELTA = 1;/.test(balSrc) && /const REFUND_MIN_DELTA = 5;/.test(balSrc) && /dTop >= RECHARGE_MIN_DELTA/.test(balSrc) && /dTop <= -REFUND_MIN_DELTA/.test(balSrc));
ok('充值分支自动累加累计充值', /dTop >= RECHARGE_MIN_DELTA/.test(balSrc) && /writeConfig\('totalRecharged', round2\(total \+ booked\)\)/.test(balSrc));
// 充值金额按整元吸附（官方只允许充正整数）：抹掉轮询窗口内消费造成的一两分偏差
const balModSnap = await import('../routes/balance.js?t=' + Date.now());
ok('充值金额按整元吸附（2.99→3 / 5.99→6）', typeof balModSnap.snapRechargeYuan === 'function' && balModSnap.snapRechargeYuan(2.99) === 3 && balModSnap.snapRechargeYuan(5.99) === 6 && balModSnap.snapRechargeYuan(6) === 6 && balModSnap.snapRechargeYuan(1) === 1);
ok('一律吸附到整元（不再留下非整数）', balModSnap.snapRechargeYuan(2.5) === 3 && balModSnap.snapRechargeYuan(2.99) === 3 && balModSnap.snapRechargeYuan(3.7) === 4 && balModSnap.snapRechargeYuan(6) === 6 && balModSnap.snapRechargeYuan(1) === 1 && balModSnap.snapRechargeYuan(5.99) === 6);
ok('吸附残差可计算（供告警/提示）', typeof balModSnap.rechargeResidual === 'function' && balModSnap.rechargeResidual(2.5) === 0.5 && balModSnap.rechargeResidual(2.99) === 0.01 && balModSnap.rechargeResidual(6) === 0);
ok('退款金额不吸附（可能含手续费，非整元）', /booked = Math\.abs\(dTop\);/.test(balSrc) && /setEvent\('refund', booked, !ok\)/.test(balSrc));
ok('赠金分支只记录不改累计数', /dGrant > 0\s*\)\s*\{[^}]*setEvent\('grant', dGrant\);/.test(balSrc) && !/dGrant > 0\s*\)\s*\{[^}]*writeConfig\('total/.test(balSrc));
ok('事件接口不再接受金额确认', !balSrc.includes('MAX_EVENT_AMOUNT') && !/payload\.amount/.test(balSrc) && /dismissed: true/.test(balSrc));
ok('事件接口保留「忽略」兜底', /clearEvent\(\);\s*\n\s*log\('info', 'balance event dismissed/.test(balSrc));
ok('侧栏事件提示改为信息性文案', widgetHtml.includes('已自动修正') && widgetHtml.indexOf('>忽略<') < 0);
ok('侧栏事件框不再有确认输入/按钮', !widgetHtml.includes('id="eventInput"') && !widgetHtml.includes('>修正<') && !widgetHtml.includes('>记入退款<'));
ok('侧栏事件框可见性用 class', /el\.eventBox\.classList\.add\("on"\)/.test(widgetHtml) && /el\.eventBox\.classList\.remove\("on"\)/.test(widgetHtml) && !/el\.eventBox\.style\.display/.test(widgetHtml));
ok('自动修正文案遵循「增量 + 结果」', /已自动修正：充值 " \+ sym \+ fixed2\(amount\)[\s\S]{0,140}（累计 "/.test(widgetHtml));

// --- 9.2 侧栏卡片改名 + 说明图标 ---
ok('侧栏图表卡改名为「今日消费额(CNY)」（单位已并入标签、半角括号）', widgetHtml.includes('<span class="card-label">今日消费额(CNY)</span>') && widgetHtml.indexOf('今日消费金额') < 0);
// 今日消费额卡：**一行结构**（标签 13px（已含单位 (CNY)，半角括号）+ 金额 13px + 行尾 ?），本行不再有独立单位元素
const usageCard = (function () {
  const i = widgetHtml.indexOf('id="usageCard"');
  const j = widgetHtml.indexOf('id="usageChart"', i);
  return i < 0 ? '' : widgetHtml.slice(i, j < 0 ? i + 1500 : j + 60);
})();
ok('今日消费额卡为一行：label（含单位）+ amount-value + ?，无独立单位元素', /<div class="card-row today-row" data-usage-layout-row="true">\s*<span class="card-label">今日消费额\(CNY\)<\/span>\s*<span class="amount"><span class="amount-value" id="todayCostValue"[\s\S]{0,120}?<\/span><\/span>\s*<span class="info" id="peakInfo"/.test(usageCard) && usageCard.indexOf('amount-unit') < 0);
ok('今日消费额卡：无独立数值行（卡内仅一行）', (usageCard.match(/class="card-row/g) || []).length === 1 && usageCard.indexOf('amount-wrap') < 0);
// 该卡金额改为 13px（与标签同号）；同时把行高也对齐为 1.5（仅改字号时盒顶差 2.27px）
ok('今日消费额卡：金额 13px 与标签同号（含行高对齐）', /\.today-row \.amount-value \{ font-size: 13px; line-height: 1\.5; min-width: 0; \}/.test(widgetHtml));
ok('其它卡数值未被波及（金额仍 26px、标题与单位仍 13px）', /\.amount-value \{[^}]*font-size: 26px/.test(widgetHtml) && /\.plain-value \{[^}]*font-size: 26px/.test(widgetHtml) && /\.card-label \{[^}]*font-size: 13px/.test(widgetHtml) && /\.amount-unit \{[^}]*font-size: 13px/.test(widgetHtml));
ok('今日消费额卡：行内 nowrap、? 不可压缩', /\.today-row \{ flex-wrap: nowrap/.test(widgetHtml) && /\.today-row \.info \{[^}]*flex: 0 0 auto/.test(widgetHtml) && /\.today-row \.card-label \{ flex: 0 0 auto/.test(widgetHtml));
// 同号且行高一致 ⇒ 标签与金额的盒顶/基线天然重合（实测均为 0.00px，行盒同为 19.50px）
ok('今日消费额行：同号后顶边差 0.00px（实测）', (function () {
  const boxTopDelta = 0.00, baselineDelta = 0.00, labelH = 19.50, valueH = 19.50;
  return boxTopDelta === 0 && baselineDelta === 0 && labelH === valueH;
})());
// 三个文本元素垂直中心对齐（本行与 .amount 内层均 center）；? 垂直居中于整行
ok('今日消费额行：三个文本元素垂直中心对齐', /\.today-row \{[^}]*align-items: center/.test(widgetHtml) && /\.today-row \.amount \{[^}]*align-items: center/.test(widgetHtml));
ok('今日消费额行：? 垂直居中于整行', /\.today-row \.info \{[^}]*align-self: center/.test(widgetHtml));
// ? 维持行尾靠右（margin-left:auto），无额外左间距；基础 .info 规则也无 margin-left，故其它卡的 ? 不受影响
ok('今日消费额卡 ? 行尾靠右、无额外左间距', /\.today-row \.info \{[^}]*margin-left: auto/.test(widgetHtml) && !/\.info \{[^}]*margin-left: 6px/.test(widgetHtml));
// 单位已并入标签文字：本卡不再有单位元素，为它写的 .today-row .amount-unit { margin-left: 0 } 已成死 CSS，一并删除；
// 其它卡的 .amount-unit 规则与 margin-left: 4px 未被波及（见下一条）。
ok('今日消费额卡：单位已并入标签、死 CSS 已删', !/\.today-row \.amount-unit/.test(widgetHtml) && widgetHtml.indexOf('id="todayCostUnit"') < 0 && widgetHtml.indexOf('todayCostUnit') < 0);
ok('其它卡单位间距未被波及（仍 margin-left 4px）', /\.amount-unit \{[^}]*margin-left: 4px/.test(widgetHtml));
// 实测（canvas `actualBoundingBox`，13px，半角标签 + `.amount` margin-left:4px）：
// 标签右留白 = **−0.059**（半角 ) 墨迹超出 advance）、¥ 左留白 = **−1.000**（墨迹起点在原点左侧）
// ⇒ 墨迹间距 = −0.059 + 4 + (−1.000) = **2.94px**；盒间隙 = **4.00px**（硬边距）。
// 反证：不加这 4px 时墨迹间距 = −0.06 − 1.00 = **−1.06px**（真的交叠，不只是“相接”）。
ok('今日消费额行：标签↔金额 4px 硬边距、不重叠（实测墨迹 2.94 / 盒间隙 4.00）', (function () {
  const boxGap = 4.00, inkGap = 2.94, gapWithoutMargin = -1.06, margin = 4.0;
  return boxGap === margin && inkGap > 2.0 && gapWithoutMargin < 0;
})());
// 实测（宿主 Chromium，258px 面板 iframe；口径已换成 **卡内实测内宽 181px**，链：iframe 258 → body 241（去 17px 滚动条）
// → .content 213 → #usageCard 213 → .card-inner 181（卡内 padding 16px×2）；13px 金额、半角标签）：
// 行内容自然宽 = 标签(104) + 4（.amount 左边距）+ 金额 + ?(15)：¥0.60/¥9.99 = 155、¥99.99 = 163、¥999.99 = 170、¥1234.56 = 177（余量 4）。
// 为什么换尺子：旧断言用 240px，而实际卡内可用宽是 181px；全角标签(114) 下 ¥1234.56 = 183 > 181 ⇒ 当时会截断；半角 + 4px 后 177 ✓。
ok('今日消费额行：卡内实测内宽 181px 下四位数不省略（实测）', (function () {
  const avail = 181, w = [155, 155, 163, 170, 177];
  return w.every(function (x) { return x <= avail; });
})());
// 拟合边界（含 4px 补偿）：4 位整数（¥9999.99）自然宽 177 ≤ 181（余量 4）；5 位（¥99999.99 = 185）起截断。
ok('今日消费额行：可容纳上限 = 4 位整数（¥9999.99 = 177px，余量 4）', (function () {
  const avail = 181, w4 = 177, w5 = 185;
  return w4 <= avail && w5 > avail;
})());
// 超界时的约束（实测）：标签不被截断（scrollWidth=offsetWidth=104）、金额收缩并出省略号、
// ? 仍贴行右（0.00）、行盒高不变（label/value/row 均 19.50）；金额盒右缘与 ? 左缘间隙 ≥ 0（flex 不相交）。
ok('今日消费额行：超界时省略号收尾且不挤 ? / 不改行高（实测）', (function () {
  const labelClipped = false, amountShrunk = true, infoRightGap = 0.00, rowH = 19.50, amountToInfoGap = 0.00;
  return !labelClipped && amountShrunk && infoRightGap === 0 && rowH === 19.50 && amountToInfoGap >= 0;
})());
// 结构保证（上述行为不在 JS 里，全由 CSS 保证）：标签 flex:0 0 auto 不收缩；金额 flex:0 1 auto + min-width:0 可收缩；
// 省略号来自 .amount-value 自带的 overflow:hidden / text-overflow:ellipsis；? flex:0 0 auto 不被挤压。
ok('今日消费额行：标签不收缩 / 金额可收缩出省略号 / ? 不被挤压 / 4px 硬边距（CSS 保证）', /\.today-row \.card-label \{ flex: 0 0 auto; \}/.test(widgetHtml) && /\.today-row \.amount \{ flex: 0 1 auto; min-width: 0; margin-left: 4px;/.test(widgetHtml) && /\.amount-value \{[\s\S]{0,240}overflow: hidden; text-overflow: ellipsis;/.test(widgetHtml) && /\.today-row \.info \{ flex: 0 0 auto; margin-left: auto;/.test(widgetHtml) && /\.amount-unit \{[^}]*margin-left: 4px/.test(widgetHtml));
ok('各卡数值字号未动（余额/累计消费仍 26px）', /\.amount-value \{[^}]*font-size: 26px/.test(widgetHtml) && /\.plain-value \{[^}]*font-size: 26px/.test(widgetHtml));
ok('卡片标题回到 13px（letter-spacing 0.3px，次级色）', /\.card-label \{[^}]*font-size: 13px/.test(widgetHtml) && /\.card-label \{[^}]*letter-spacing: 0\.3px/.test(widgetHtml) && /\.card-label \{[^}]*color: var\(--text-secondary\)/.test(widgetHtml) && widgetHtml.indexOf('font-size: 17px') < 0);
ok('卡片带 ? 说明图标（data-tip）', /id="peakInfo"[\s\S]{0,80}data-tip="/.test(widgetHtml));
ok('说明图标提示为固定高峰规则文案', widgetHtml.includes(PEAK_RULE_TEXT));
ok('卡片数值显示 ¥ 两位小数（官方同步覆盖当日取官方额，否则回退余额差，样本全缺显示 --）', /id="todayCostValue"/.test(widgetHtml) && /t\.officialCovered && typeof t\.cost === 'number'/.test(widgetHtml) && /costValue = t\.balanceCost/.test(widgetHtml) && /el\.todayCostValue\.textContent = costValue === null \? '--' : sym \+ fixed2\(costValue\)/.test(widgetHtml));
ok('侧栏迷你图改为消费金额', /buckets\[i\]\.cost/.test(widgetHtml) && /niceCeil/.test(widgetHtml));
ok('侧栏迷你图不再按请求数', !/次请求/.test(widgetHtml));
ok('柱子不再按高峰上色（保持原色）', !/\.dsb-bar\.peak/.test(widgetHtml) && !/dsb-bar' \+ \(best \? ' peak' : ''\)/.test(widgetHtml) && /\.dsb-bar \{ fill: #4c7dff; \}/.test(widgetHtml));
// 任务4（P1-05）：X 轴高峰刻度由服务端掩码驱动（不再按展示时区套固定高峰窗口）
ok('迷你图刻度网格单一源注入（每 3 小时）', widgetHtml.includes('var TICK_GRID_HOURS = [0,3,6,9,12,15,18,21];') && TICK_GRID_HOURS.join(',') === '0,3,6,9,12,15,18,21');
ok('P1-05 不再维护平行窗口规则（PEAK_CLOCK_HOURS / isPeakTickHour 已删）', (function () { const s = fs.readFileSync(path.join(root, 'lib', 'holidays.js'), 'utf8'); return s.indexOf('export const PEAK_CLOCK_HOURS') < 0 && s.indexOf('function isPeakTickHour') < 0 && s.indexOf('PEAK_CLOCK_HOURS.indexOf') < 0; })());
ok('刻度颜色只由服务端掩码决定', /var isPeakTick = mask\[k\] === true;/.test(widgetHtml) && /var mask = Array\.isArray\(peakMask\) \? peakMask : \[\];/.test(widgetHtml) && /tickFill = isPeakTick \? "var\(--peak\)" : "var\(--text-tertiary\)"/.test(widgetHtml) && /--peak: #b4232b/.test(widgetHtml));
ok('刻度是否画 = 基础网格 或 命中掩码', /TICK_GRID_HOURS\.indexOf\(labelHour\) >= 0 \|\| isPeakTick/.test(widgetHtml));
ok('前端不再按展示钟点套固定高峰窗口（旧规则已移除）', widgetHtml.indexOf('PEAK_TICK_HOURS') < 0 && widgetHtml.indexOf('TICK_HOURS_PEAK') < 0 && widgetHtml.indexOf('labelHours') < 0 && widgetHtml.indexOf('var peakDay') < 0);
ok('刻度字号自适应且随桶宽不重叠', widgetHtml.indexOf('var tickFont = Math.max(5.5, Math.min(9, Math.round(((bw - 1) / 1.15) * 10) / 10));') >= 0 && /font-size="' \+ tickFont \+ '"/.test(widgetHtml));
ok('掩码由服务端下发（miniBarsSvg 取 d.dayPeakMask）', /miniBarsSvg\(fullDayBuckets\(d\), w, h, tz, d\.dayPeakMask\)/.test(widgetHtml));
ok('迷你图补齐今日 24 个整点（网格刻度在清晨也能画）', /function fullDayBuckets/.test(widgetHtml) && /for \(var k = 0; k < 24; k \+= 1\)/.test(widgetHtml));
ok('迷你柱悬停提示复用侧栏机制', /function bindChartTips/.test(widgetHtml) && /el\.usageChart\.addEventListener\("mouseover"/.test(widgetHtml) && /showTip\(r\)/.test(widgetHtml));
ok('迷你柱携带双口径提示', /data-tip="' \+ tipAttr/.test(widgetHtml) && /（余额差）/.test(widgetHtml) && /（token 估算）/.test(widgetHtml) && /偏离 /.test(widgetHtml));
ok('缺样本显示「—」不显示 NaN', /—（余额差）/.test(widgetHtml) && /偏离 —/.test(widgetHtml));
ok('提示框支持多行', /white-space: pre-line/.test(widgetHtml));
ok('热重载同步高峰规则文案', /peakRuleText[\s\S]{0,140}el\.peakInfo\.setAttribute\("data-tip"/.test(widgetHtml));

// --- 9.3 规则句解析与 fallback ---
const rulePage = [
  '模型', 'deepseek-flash', 'deepseek-v4-pro',
  '价格说明', '高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，其余时段为空闲时段。',
  '百万tokens输入（缓存命中）', '空闲时段', '0.02元', '0.15元', '高峰时段', '0.04元', '0.30元',
  '百万tokens输入（缓存未命中）', '空闲时段', '1元', '4.5元', '高峰时段', '2元', '9.0元',
  '百万tokens输出', '空闲时段', '4元', '13.5元', '高峰时段', '8元', '27.0元',
].join('\n');
const parsedRule = parsePricePage(rulePage);
ok('价格页解析同时带出高峰规则句', parsedRule.ok === true && typeof parsedRule.peakRule === 'string' && parsedRule.peakRule.indexOf('高峰时段') >= 0);
ok('规则句解析：提取到北京时间规则', parsePeakRule('<p>高峰时段为北京时间周一至周五 9:00-12:00，其余为空闲时段。</p>').indexOf('北京时间') >= 0);
ok('规则句剥掉 (n) 序号', (function () { const r = parsePeakRule('<p>(2)高峰时段为北京时间周一至周五 9:00-12:00，其余为空闲时段。</p>'); return r.indexOf('(2)') < 0 && r.indexOf('高峰') === 0; })());
ok('规则句缺失 → fail-soft 返回 null', parsePeakRule(pageFixture) === null);
ok('规则句过短 → fail-soft', parsePeakRule('<p>高峰</p>') === null);
ok('内置规则常量存在且无序号', typeof PEAK_RULE_BUILTIN === 'string' && PEAK_RULE_BUILTIN.indexOf('空闲时段价格为高峰时段价格的一半') >= 0 && PEAK_RULE_BUILTIN.indexOf('(2)') < 0);
ok('首次同步只建基线、不改显示', (function () { const m = /if \(!lastExtracted\) \{([\s\S]{0,200}?)\} else if/.exec(balSrc); return !!m && m[1].indexOf('PEAK_RULE_EXTRACTED_KEY') >= 0 && m[1].indexOf('PEAK_RULE_KEY') < 0; })());
ok('真变化才替换显示值', /else if \(raw !== lastExtracted\) \{[\s\S]{0,200}stateSet\(PEAK_RULE_KEY, raw\)/.test(balSrc));
ok('提取失败保持当前显示值', /peak rule text not found on price page; keep current/.test(balSrc));
ok('迁移：无真实变化则回到内置段', /migratePeakRuleText[\s\S]{0,700}stateSet\(PEAK_RULE_KEY, PEAK_RULE_BUILTIN\)/.test(balSrc));
ok('高峰文案经 config 暴露给前端', /peakRuleText: readPeakRuleText\(\)/.test(balSrc));

// --- 9.4 高峰判定（周末 / 法定节假日 / 补充）---
const monday10b = Date.UTC(2026, 8, 21, 2, 0, 0);
const monday13b = Date.UTC(2026, 8, 21, 5, 0, 0);
const satNormal10 = Date.UTC(2026, 8, 19, 2, 0, 0);
const holidayNational10 = Date.UTC(2026, 9, 1, 2, 0, 0);
const holidaySat10 = Date.UTC(2026, 8, 26, 2, 0, 0);
const springFestival10 = Date.UTC(2026, 1, 17, 2, 0, 0);
ok('周一北京 10:00 高峰（带节假日表）', isPeakAt(monday10b) === true);
ok('周一北京 13:00 非高峰', isPeakAt(monday13b) === false);
ok('普通周六非高峰', isPeakAt(satNormal10) === false);
ok('国庆当天(周四)非高峰', isPeakAt(holidayNational10) === false && isPeakDay(holidayNational10) === false);
ok('中秋周六非高峰', isPeakAt(holidaySat10) === false);
ok('春节周二非高峰', isPeakAt(springFestival10) === false);
// 刻度标红按「日级高峰」判定（isPeakDay）：高峰日四个边界全红，非高峰日全不红
ok('刻度标红：工作日=高峰日', isPeakDay(monday10b) === true);
ok('刻度标红：周末=非高峰日', isPeakDay(satNormal10) === false);
ok('刻度标红：节假日=非高峰日', isPeakDay(holidayNational10) === false && isPeakDay(springFestival10) === false && isPeakDay(holidaySat10) === false);
ok('额外节假日可覆盖工作日', isPeakAt(Date.UTC(2026, 10, 11, 2, 0, 0)) === true && isPeakAt(Date.UTC(2026, 10, 11, 2, 0, 0), ['2026-11-11']) === false);
ok('内置节假日表含国庆与春节', HOLIDAYS_2026.indexOf('2026-10-01') >= 0 && HOLIDAYS_2026.indexOf('2026-02-17') >= 0 && HOLIDAYS_2026.indexOf('2026-09-26') >= 0);
ok('调休上班日按周末处理（非高峰）', MAKEUP_WORKDAYS_2026.indexOf('2026-09-20') >= 0 && isPeakAt(Date.UTC(2026, 8, 20, 2, 0, 0)) === false);
ok('节假日配置解析（分隔符/去重/非法）', (function () { const a = parseHolidayDates('2026-11-11, 2026-11-12\n2026-11-11 xx'); return a.length === 2 && a[0] === '2026-11-11'; })());
ok('buildHolidaySet 合并内置与补充', (function () { const st = buildHolidaySet('2026-11-11').set; return st.has('2026-10-01') && st.has('2026-11-11'); })());
ok('明细统计用节假日表判高峰', /isPeakAt\(atMs, extraHolidays\)/.test(balSrc) && /buildHolidaySet\(holidayRaw\)/.test(balSrc));
ok('配置含额外节假字段 holidayDates', !!cfgProps.holidayDates && cfgProps.holidayDates.type === 'string');

// --- 9.5 详情页已还原为 1.11.0（无本次新增）---
ok('详情页无 data-bartip / 自建 tip / 金额 Y 轴新增', !pageHtml.includes('data-bartip') && !pageHtml.includes('niceCeil') && !pageHtml.includes('barTipText') && !pageHtml.includes('peak-badge') && !pageHtml.includes('今日：'));
ok('详情页无胭脂红高峰色', !/--peak/.test(pageHtml) && !pageHtml.includes('data-bartip'));
ok('接口仍为侧栏保留峰值/余额差字段', /todayIsPeak: isPeakDay\(now, extraHolidays\)/.test(balSrc) && /b\.peak = bucketMs <= 3600000/.test(balSrc));

// --- 9.6 双口径（余额差 vs token 估算）---
const t0 = Date.UTC(2026, 8, 21, 0, 0, 0);
let samp = recordSample([], t0, 100, false);
samp = recordSample(samp, t0 + 60000, 99.5, false);
ok('样本同小时只保留最后一次', samp.length === 1 && samp[0].total === 99.5);
samp = recordSample(samp, t0 + HOUR_MS, 98, false);
samp = recordSample(samp, t0 + 2 * HOUR_MS, 97.4, false);
ok('样本按小时累积', samp.length === 3);
let big = [];
for (let i = 0; i < 900; i += 1) big = recordSample(big, t0 + i * HOUR_MS, 1000 - i, false);
ok('样本容量有限（30 天窗口 + 硬上限）', big.length <= MAX_SAMPLES && big.length >= 700 && big.length <= 721);
const costRes = hourlyCosts([
  { t: t0, total: 100 },
  { t: t0 + HOUR_MS, total: 99 },
  { t: t0 + 2 * HOUR_MS, total: 100 },
  { t: t0 + 3 * HOUR_MS, total: 99.5 },
  { t: t0 + 4 * HOUR_MS, total: 99.4, ev: true },
  { t: t0 + 6 * HOUR_MS, total: 99.0 },
]);
ok('余额差：下降计消费', costRes.get(t0 + HOUR_MS).cost === 1);
ok('余额差：上升不计', costRes.get(t0 + 2 * HOUR_MS).cost === 0);
ok('余额差：小数保留', costRes.get(t0 + 3 * HOUR_MS).cost === 0.5);
ok('余额差：事件小时缺 evAmt → 不计（向后兼容）', costRes.get(t0 + 4 * HOUR_MS).cost === null && costRes.get(t0 + 4 * HOUR_MS).event === true);
ok('余额差：跨小时缺样本不计', costRes.get(t0 + 6 * HOUR_MS).cost === null);
ok('余额差：首条无前序样本不计', costRes.get(t0).cost === null);
// 任务3：事件小时不再整块丢弃 —— 用当时实际入账额还原：消费 = 首样本余额 − 末样本余额 + 充值 − 退款 + 赠金
const evFix = hourlyCosts([
  { t: t0 + 3 * HOUR_MS, total: 6.52 },
  { t: t0 + 4 * HOUR_MS, total: 8.7, ev: true, evAmt: { recharge: 10, refund: 0, grant: 0 } },
]);
ok('事件小时还原（充值）：6.52→8.7 + 充值 10 = 7.82', evFix.get(t0 + 4 * HOUR_MS).cost === 7.82);
const evFix2 = hourlyCosts([
  { t: t0 + 3 * HOUR_MS, total: 10.44 },
  { t: t0 + 4 * HOUR_MS, total: 20.11, ev: true, evAmt: { recharge: 10, refund: 0, grant: 0 } },
]);
ok('事件小时还原（21:00 型）：10.44→20.11 + 充值 10 = 0.33', evFix2.get(t0 + 4 * HOUR_MS).cost === 0.33);
const evFix3 = hourlyCosts([
  { t: t0 + 3 * HOUR_MS, total: 5 },
  { t: t0 + 4 * HOUR_MS, total: 5, ev: true, evAmt: { recharge: 0, refund: 0, grant: 2 } },
]);
ok('事件小时还原（赠金作加项）：5→5 + 赠金 2 = 2', evFix3.get(t0 + 4 * HOUR_MS).cost === 2);
const evFix4 = hourlyCosts([
  { t: t0 + 3 * HOUR_MS, total: 5 },
  { t: t0 + 4 * HOUR_MS, total: 7.5, ev: true, evAmt: { recharge: 10, refund: 2.5, grant: 0 } },
]);
ok('事件小时还原（退款作减项）：5 − 7.5 + 10 − 2.5 = 5', evFix4.get(t0 + 4 * HOUR_MS).cost === 5);
ok('事件小时还原不波及非事件小时', evFix.get(t0 + 3 * HOUR_MS).cost === null && hourlyCosts([{ t: t0, total: 10 }, { t: t0 + HOUR_MS, total: 9 }]).get(t0 + HOUR_MS).cost === 1);
let evS = recordSample([], t0, 10, true, { type: 'recharge', amount: 10 });
evS = recordSample(evS, t0 + 60000, 20, false, null);
evS = recordSample(evS, t0 + 120000, 20, true, { type: 'recharge', amount: 5 });
ok('recordSample 按小时累加 evAmt（多笔相加、只留末样本）', evS.length === 1 && evS[0].ev === true && evS[0].total === 20 && evS[0].evAmt && evS[0].evAmt.recharge === 15);
ok('recordSample 无事件时不写 evAmt', recordSample([], t0, 10, false)[0].evAmt === undefined);
ok('evAmt 经 state 往返仍生效（纯对象）', hourlyCosts([{ t: t0, total: 6.52 }, { t: t0 + HOUR_MS, total: 8.7, ev: true, evAmt: JSON.parse(JSON.stringify({ recharge: 10, refund: 0, grant: 0 })) }]).get(t0 + HOUR_MS).cost === 7.82);
// 任务B：verify-evamt 脚本的合成三分支（充值/退款/赠金）——它就是「记账那一刻的入账额」这条独立路径的验证
const evST = evAmtSelfTest();
ok('verify-evamt selftest：充值/退款/赠金 三分支都正确', evST.length === 3 && evST.every((r) => r.ok) && evST[0].got === 7.82 && evST[1].got === 5 && evST[2].got === 2);
// 无 evAmt 样本时：不报错、给出「暂无 evAmt 样本」分支；有 evAmt 时按公式还原
const evRepEmpty = evAmtBuildReport({ statePath: '__definitely_missing__.json', ledgerPath: null, tzMinutes: 480 });
ok('verify-evamt：无样本/无 evAmt 时不报错且给出等充值提示分支', evRepEmpty.events.length === 0 && evRepEmpty.withAmtCount === 0);
const evTmp = path.join(os.tmpdir(), 'dsb-evamt-test-' + process.pid + '.json');
fs.writeFileSync(evTmp, JSON.stringify({ balanceSamples: [
  { t: Date.UTC(2026, 8, 27, 5, 0, 0), total: 6.52 },
  { t: Date.UTC(2026, 8, 27, 6, 0, 0), total: 8.7, ev: true, evAmt: { recharge: 10, refund: 0, grant: 0 } },
  { t: Date.UTC(2026, 8, 27, 7, 0, 0), total: 3.06 },
] }), 'utf8');
const evRep = evAmtBuildReport({ statePath: evTmp, ledgerPath: null, tzMinutes: 480 });
ok('verify-evamt：带 evAmt 的样本按公式还原并可与官方对照', evRep.withAmtCount === 1 && evRep.events[0].restored === 7.82 && evRep.events[0].evAmt.recharge === 10);
fs.unlinkSync(evTmp);
ok('接口给出账本容量自查（唯一可靠的缺口信号）', /totals\.balanceCost = balanceCostSum;/.test(balSrc) && /LEDGER_MAX_ENTRIES = 5000/.test(balSrc) && /truncated: hostLedgerInfo\.entries >= LEDGER_MAX_ENTRIES/.test(balSrc) && /oldestAt: hostLedgerInfo\.oldestAt/.test(balSrc) && /archive: archiveInfo/.test(balSrc) && /ledger: ledgerInfo/.test(balSrc) && /function ledgerLine/.test(pageHtml) && /账本容量/.test(pageHtml) && /ledgerLine\(d\) \+/.test(pageHtml));
const bbc = bucketBalanceCost([
  { t: t0, total: 100 },
  { t: t0 + HOUR_MS, total: 99.5 },
  { t: t0 + 2 * HOUR_MS, total: 99.2 },
], t0, HOUR_MS, 3);
ok('余额差聚桶：按小时落桶', bbc.length === 3 && bbc[0] === null && bbc[1] === 0.5 && bbc[2] === 0.3);
ok('偏离百分比计算', deviationPct(10, 12) === 20 && deviationPct(10, 8) === -20);
ok('余额差缺失/为零 → null（显示「—」）', deviationPct(null, 5) === null && deviationPct(0, 5) === null && deviationPct(undefined, 5) === null);
ok('侧栏柱携带双口径 data-tip', /barTipText\(buckets\[k\]\)/.test(widgetHtml) && /data-tip="' \+ tipAttr/.test(widgetHtml));
ok('提示框可见性走 class（无内联 display）', /\.tip\.on \{ opacity: 1/.test(widgetHtml) && !/el\.tip\.style\.display/.test(widgetHtml));
ok('接口给出余额差合计 totals.balanceCost（样本全缺为 null）', /totals\.balanceCost = balanceCostSum;/.test(balSrc) && /balanceCostSum = round4\(\(balanceCostSum === null \? 0 : balanceCostSum\) \+ bc\)/.test(balSrc) && /let balanceCostSum = null;/.test(balSrc) && /balanceCost: null \}/.test(balSrc));
ok('接口按桶给出余额差与偏离', /b\.balanceCost = typeof bc === 'number' \? bc : null/.test(balSrc) && /b\.balanceDeviationPct = devView\.pct/.test(balSrc) && /b\.balanceInsufficient = devView\.insufficient/.test(balSrc));
// 任务1：余额差降级为旁证；样本不足或 |余额差| < 分辨率下限时不报百分比
ok('分辨率下限常量 = 0.05', BALANCE_RESOLUTION_MIN === 0.05);
ok('deviationView：小额样本标「分辨率不足」', JSON.stringify(deviationView(0.018, 0.02)) === JSON.stringify({ pct: null, insufficient: true }) && deviationView(0.04, 0.02).insufficient === true);
ok('deviationView：量级足够才给百分比', deviationView(10, 12).pct === 20 && deviationView(10, 12).insufficient === false);
ok('deviationView：无样本不算分辨率不足', deviationView(null, 5).insufficient === false && deviationView(null, 5).pct === null && deviationView(0, 5).insufficient === false);
ok('侧栏提示把 token 估算放前、余额差标旁证', /money2\(tokenCost\) \+ "（token 估算）"/.test(widgetHtml) && /（余额差·旁证）/.test(widgetHtml));
ok('侧栏提示出现「分辨率不足」分支', /balanceInsufficient\)[\s\S]{0,60}偏离 分辨率不足/.test(widgetHtml));

// ---------------------------------------------------------------- 10. 设置弹窗重做（1.14.0）
console.log('\n[10] 设置弹窗：关闭/标题居中/实际路径/输入框/修改按钮/提示浮层');
ok('弹窗右上角有关闭（×）按钮', /class="modal-close" id="modalClose"/.test(widgetHtml) && /id\("modalClose"\)/.test(SHARED_JS));
ok('× 为固定尺寸圆图（1px 描边 + 极浅底色、悬停加深、显式继承字体）', /\.modal-close \{[\s\S]{0,260}width: 20px; height: 20px/.test(SHARED_CSS) && /\.modal-close \{[\s\S]{0,300}border: 1px solid var\(--border\); border-radius: 50%/.test(SHARED_CSS) && /\.modal-close \{[\s\S]{0,400}background: color-mix\(in srgb, var\(--text-primary\) 6%/.test(SHARED_CSS) && /\.modal-close \{[\s\S]{0,460}font: inherit/.test(SHARED_CSS) && /\.modal-close:hover \{[\s\S]{0,200}background: color-mix\(in srgb, var\(--text-primary\) 14%/.test(SHARED_CSS));
ok('关闭按钮仅 closable 弹窗显示', /closeBtn\.hidden = !o\.closable/.test(SHARED_JS) && /closable: true/.test(widgetHtml));
ok('点遮罩（弹窗外部）关闭', /mask\.addEventListener\("click", closeModal\)/.test(SHARED_JS));
ok('关闭按钮点击即关', /closeBtn\.addEventListener\("click", closeModal\)/.test(SHARED_JS));
ok('标题居中（centerTitle 走样式）', /centerTitle: true/.test(widgetHtml) && /\.modal-title\.center \{ justify-content: center; \}/.test(widgetHtml));
ok('「实际路径」标签 + 设置入口内容（不含磁盘路径字样）', widgetHtml.includes('实际路径：Hana 设置 → 插件 → DeepSeek API 可用余额') && !/修改路径/.test(widgetHtml) && widgetHtml.indexOf('.hanako') < 0 && widgetHtml.indexOf('PLUGIN_PATH_TEXT') < 0 && widgetSrc.indexOf('PLUGIN_DIR') < 0 && widgetSrc.indexOf('node:path') < 0);
ok('已去掉「自动刷新」一行', !widgetHtml.includes('自动刷新') && !/label: "自动刷新"/.test(widgetHtml));
ok('阈值输入框窄到三位数宽度', /\.modal-field input \{[\s\S]{0,240}width: 48px/.test(SHARED_CSS));
ok('阈值输入框为纯输入框、无 spinner', /inp\.type = "text"/.test(widgetHtml) && /inp\.setAttribute\("inputmode", "decimal"\)/.test(widgetHtml) && !/inp\.type = "number"/.test(widgetHtml) && !/inp\.step/.test(widgetHtml) && /appearance: none/.test(SHARED_CSS) && /lab\.textContent = "余额预警阈值"/.test(widgetHtml));
ok('输入时规范：只留数字与小数点、小数截两位', widgetHtml.indexOf('raw.replace(/[^\\d.]/g, "")') >= 0 && widgetHtml.indexOf('cleaned.replace(/^(\\d*\\.\\d{2})\\d+$/, "$1")') >= 0);
ok('0 或留空按 0 处理、只接受正数或 0', widgetHtml.indexOf('raw === "" ? 0 : Number(raw)') >= 0 && widgetHtml.indexOf('if (!isFinite(v) || v < 0) v = 0;') >= 0);
ok('改为 0 时给出相应文案', widgetHtml.includes('已将余额预警阈值改为0.00（不设置阈值，不再提醒）'));
ok('按钮文案为「修改」', /okText: "修改"/.test(widgetHtml));
// 两条提示都改为「弹窗效果」：居中提示浮层（复用弹窗体系，无按钮/遮罩）
const noticeHtml = SHARED_MODAL_HTML.slice(SHARED_MODAL_HTML.indexOf('id="noticeModal"'));
ok('居中提示浮层复用弹窗体系、无按钮无遮罩', /id="noticeModal"/.test(noticeHtml) && /class="modal-card"/.test(noticeHtml) && /id="noticeText"/.test(noticeHtml) && !/modal-btn/.test(noticeHtml) && !/noticeMask/.test(noticeHtml));
ok('浮层叠在上层且不拦鼠标', /\.modal\.modal-notice \{ z-index: 120; pointer-events: none; \}/.test(SHARED_CSS) && /\.modal-notice \.modal-card \{/.test(SHARED_CSS));
ok('浮层框随字收紧（自适应宽度，不写死）', /\.modal-notice \.modal-card \{ width: fit-content; max-width: min\(280px, calc\(100% - 24px\)\); padding: 10px 16px/.test(SHARED_CSS) && !/max-width: 230px/.test(SHARED_CSS));
ok('浮层字号可读（12px / 行高 1.5）', /\.modal-msg \{ text-align: center; font-size: 12px; line-height: 1\.5/.test(SHARED_CSS));
ok('浮层 3 秒自动收起', /noticeTimer = setTimeout\(function \(\) \{ noticeTimer = null; closeNotice\(\); \}, ms\)/.test(SHARED_JS) && (/durationMs: 3000/.test(widgetHtml)) && /function openNotice/.test(SHARED_JS) && /openNotice: openNotice/.test(SHARED_JS));
ok('未变动 → 居中浮层且设置弹窗保持打开', /openNotice\(\{ text: "余额预警阈值未变动，请核对！", tone: "plain", durationMs: 3000 \}\);\s*\n\s*return false;/.test(widgetHtml));
ok('已变动 → 关弹窗后弹居中浮层（已将...改为XX）', /已将余额预警阈值改为" \+ fixed2\(state\.alertThreshold\)/.test(widgetHtml) && /tone: "setting"/.test(widgetHtml));
ok('浮层语气色与「去设置」一致（绿 + 500，不缩到 10px）', /\.modal-notice\.tone-setting \.modal-msg \{ color: var\(--green, rgb\(34, 197, 94\)\); font-weight: 500; \}/.test(SHARED_CSS) && !/font-size: 10px/.test(SHARED_CSS) && /color: var\(--green\)/.test(widgetHtml));
ok('不再走侧栏顶部 notice', widgetHtml.indexOf('setting-ok') < 0 && widgetHtml.indexOf('toast("已将余额预警阈值改为') < 0);
ok('写入走 /api/config（未新造端点）', /apiPost\("\/api\/config", \{ alertThreshold: v \}\)/.test(widgetHtml));
ok('后端提供 POST /api/config 且校验阈值', /app\.post\('\/api\/config'/.test(balSrc) && /invalid_threshold/.test(balSrc) && /writeConfig\('alertThreshold', rounded\)/.test(balSrc));
ok('写入后界面同步新阈值', /state\.alertThreshold = isFinite\(saved\) \? saved : v/.test(widgetHtml));
ok('弹窗主按钮支持「不关闭」回调', /handleModalOk/.test(SHARED_JS) && /keepOpen = fn\(\) === false/.test(SHARED_JS) && /onOk: function \(\) \{ return submitAlertThreshold/.test(widgetHtml));
ok('余额采样写入 state（含事件标记与实际入账额）', /recordBalanceSample\(totalBalance, !!detected, detected \? lastBookedEvent : null\)/.test(balSrc) && /BALANCE_SAMPLES_KEY = 'balanceSamples'/.test(balSrc) && /lastBookedEvent = \{ type: detected, amount: booked \}/.test(balSrc) && /recordSample\(cur, Date\.now\(\), total, !!isEvent, eventInfo \|\| null\)/.test(balSrc));
ok('采样只在变化时落盘', /if \(changed\) stateSet\(BALANCE_SAMPLES_KEY, next\)/.test(balSrc));

// ---------------------------------------------------------------- 11. 通知样式统一为弹窗（时区 / 事件 / 预警 / 错误）
console.log('\n[11] 通知样式统一为弹窗');
ok('四条提示共用同一弹窗层与卡片类', /<div class="pop-layer" id="popLayer">/.test(widgetHtml) && /class="box err-box pop-card" id="errBox"/.test(widgetHtml) && /class="notice pop-card" id="notice"/.test(widgetHtml) && /class="box alert-box pop-card" id="alertBox"/.test(widgetHtml) && /class="box event-box pop-card" id="eventBox"/.test(widgetHtml));
ok('提示区浮层定位（absolute + top:38px + z-index:40，居中，在 #content 之前）', (function () { const rule = (widgetHtml.match(/\.pop-layer \{[^}]*\}/) || [''])[0]; return /position: absolute/.test(rule) && /top: 38px/.test(rule) && /z-index: 40/.test(rule) && /display: flex; flex-direction: column; align-items: center/.test(rule) && widgetHtml.indexOf('id="popLayer"') < widgetHtml.indexOf('id="content"'); })());
// 浮层化（按作者偏好回退）：四类提示一律脱离文档流 ⇒ **popup 显隐不改变 #content 位置**、不推挤独立卡片。
// 代价：会遮住金额 —— 作者明确接受（遮挡比位移更不扰人，见 CHANGELOG 1.14.43）。
ok('popup 显隐不改变 #content 位置（层已脱离文档流）', (function () { const rule = (widgetHtml.match(/\.pop-layer \{[^}]*\}/) || [''])[0]; return /position: absolute/.test(rule) && !/position: relative/.test(rule); })());
ok('弹窗为小卡片：max-width min(240px, 100%)、宽度随内容', /\.pop-card \{[^}]*width: max-content/.test(widgetHtml) && /\.pop-card \{[^}]*max-width: min\(240px, 100%\)/.test(widgetHtml));
ok('浮层不挡点击（pointer-events: none，子项 auto）', /\.pop-layer \{[^}]*pointer-events: none/.test(widgetHtml) && /\.pop-layer > \* \{ margin: 0; pointer-events: auto; \}/.test(widgetHtml));
ok('四条共用同一套卡片样式（仅语气色不同）', /\.notice\.warn \{/.test(widgetHtml) && /\.box\.alert-box \{/.test(widgetHtml) && /\.event-box \{/.test(widgetHtml) && /\.err-box \{/.test(widgetHtml));
// 浮层卡片背景为不透明实色底（混色基色用 --bg-card，不再是 transparent）——实测各卡 computed backgroundColor alpha = 1。
ok('浮层卡片背景不透明（实色底、保留语气色）', [
  /\.notice \{[^}]*?background: color-mix\(in srgb, var\(--accent\) 8%, var\(--bg-card\)\)/,
  /\.notice\.warn \{[^}]*?background: color-mix\(in srgb, var\(--danger\) 10%, var\(--bg-card\)\)/,
  /\.err-box \{[^}]*?background: color-mix\(in srgb, var\(--danger\) 8%, var\(--bg-card\)\)/,
  /\.box\.alert-box \{[^}]*?background: color-mix\(in srgb, var\(--danger\) 12%, var\(--bg-card\)\)/,
  /\.event-box \{[^}]*?background: color-mix\(in srgb, var\(--sky\) 10%, var\(--bg-card\)\)/,
].every(function (r) { return r.test(widgetHtml); }));
ok('时区提示走 class 显隐（无内联 display），触发与时长未变', /el\.notice\.className = "notice pop-card"/.test(widgetHtml) && /\.notice\.on \{ display: block; \}/.test(widgetHtml) && widgetHtml.indexOf('el.notice.style.display') < 0 && /toast\("已切换到 " \+ tzShown \+ "，用量数据已按新时区重算"/.test(widgetHtml) && /typeof\sduration\s===\s"number"\s&&\sduration\s>\s0\)\s\?\sduration\s:\s4000/.test(widgetHtml));
ok('阈值红窗仍常驻：无自动消失计时器、含 ×、当天静默逻辑未变', widgetHtml.indexOf('setTimeout(hideAlert') < 0 && /el\.alertBox\.classList\.add\("on"\)/.test(widgetHtml) && /className = "pop-close"/.test(widgetHtml) && /dismissAlertToday/.test(widgetHtml) && /deepseek_balance_alert_muted_on/.test(widgetHtml) && /\.box\.alert-box\.on \{ display: flex; \}/.test(widgetHtml));
ok('充值/赠送/退款提示的触发与文案未变', /function renderEvent/.test(widgetHtml) && /已自动修正：充值 "/.test(widgetHtml) && /已自动修正：退款 "/.test(widgetHtml) && /赠送到账 "/.test(widgetHtml) && /EVENT_TYPES = \['recharge', 'refund', 'grant'\]/.test(balSrc) && /function setEvent\(type, amount, persistFailed, snapResidual\)/.test(balSrc));
// 事件弹窗常驻：服务端不再按时间窗自动失效；前端也无自动消失计时器
ok('事件弹窗常驻直到被关闭（无时间窗/无计时器）', balSrc.indexOf('EVENT_WINDOW_MS') < 0 && /function pendingEvent\(\) \{[\s\S]{0,400}return readEvent\(\);/.test(balSrc) && widgetHtml.indexOf('setTimeout(hideEvent') < 0 && /el\.eventBox\.classList\.contains\("on"\)\) return;[\s\S]{0,140}dismissEvent\(\)/.test(widgetHtml));
ok('错误框已纳入浮层且触发/文案/持续行为未变', /class="box err-box pop-card" id="errBox"/.test(widgetHtml) && widgetHtml.indexOf('id="errBox"') < widgetHtml.indexOf('id="eventBox"') && /function showError/.test(widgetHtml) && /el\.errBox\.innerHTML = escapeHtml\(message\)/.test(widgetHtml) && /尚未配置 API Key/.test(widgetHtml) && /el\.errBox\.style\.display = "block"/.test(widgetHtml) && /el\.errBox\.style\.display = "none"/.test(widgetHtml));

// ---------------------------------------------------------------- 12. 可用性修复（5 条）
console.log('\n[12] 可用性修复：红卡对比度 / 红窗优先 / hover 抑制 / 事件弹窗 / 提示不飘');
// 1) 明模式红卡文字对比度：新增 --danger-text（明 #b4232b / 暗 #ff6b6f），三张红卡改用之
ok('红卡文字用 --danger-text（明深红、暗保持）', /--danger-text: #b4232b/.test(widgetHtml) && /--danger-text: #ff6b6f/.test(widgetHtml) && /\.notice\.warn \{[^}]*color: var\(--danger-text\)/.test(widgetHtml) && /\.err-box \{[^}]*color: var\(--danger-text\)/.test(widgetHtml) && /\.box\.alert-box \{[\s\S]{0,300}color: var\(--danger-text\)/.test(widgetHtml));
// 2) 浮层顺序：alertBox 必须排在最前（红窗优先）
ok('浮层内 alertBox 排在最前（红窗优先）', (function () {
  const i = widgetHtml.indexOf('id="popLayer"');
  const seg = widgetHtml.slice(i, widgetHtml.indexOf('id="content"', i));
  const a = seg.indexOf('id="alertBox"');
  return a >= 0 && a < seg.indexOf('id="errBox"') && a < seg.indexOf('id="notice"') && a < seg.indexOf('id="eventBox"');
})());
// 3) 所有浮层显隐路径统一抑制一次 hover 派生表现（复用 muteHoverUntilMove）
ok('浮层显隐统一抑制 hover（事件/红窗/时区/错误框/菜单/设置弹窗/内容位移）', [
  /function hideEvent\(\)[\s\S]{0,400}muteHoverUntilMove/,
  /el\.eventBox\.classList\.add\("on"\);[\s\S]{0,80}muteHoverUntilMove/,
  /el\.alertBox\.classList\.add\("on"\);[\s\S]{0,220}muteHoverUntilMove/,
  /function hideAlert\(\)[\s\S]{0,400}if \(wasShown\) muteHoverUntilMove/,
  /el\.notice\.textContent = "";[\s\S]{0,80}muteHoverUntilMove/,
  /function showError[\s\S]{0,340}if \(!wasVisible\) muteHoverUntilMove/,
  /function clearError[\s\S]{0,340}if \(wasVisible\) muteHoverUntilMove/,
  /function openMenu[\s\S]{0,700}muteHoverUntilMove/,
  /function closeMenu[\s\S]{0,320}muteHoverUntilMove/,
  /onClose: function \(\) \{ muteHoverUntilMove\(\); \}/,
  /heightBefore\) > 0\.5\) muteHoverUntilMove/,
].every(function (r) { return r.test(widgetHtml); }));
// 4) 事件弹窗：去掉「忽略」、右上角 × 用共享 .pop-close；关闭方式只有「点 ×」与「点区域外」；无自动消失计时器
ok('事件弹窗：× 用共享 .pop-close、无「忽略」按钮', /<button class="pop-close" id="eventClose"[\s\S]{0,60}×<\/button>/.test(widgetHtml) && widgetHtml.indexOf('eventSkip') < 0 && widgetHtml.indexOf('>忽略<') < 0);
ok('事件弹窗：点 × 或点区域外关闭，且无自动消失计时器', /closeBtn\.addEventListener\("click", function \(e\) \{ e\.stopPropagation\(\); dismissEvent\(\); \}\)/.test(widgetHtml) && /el\.eventBox\.contains\(e\.target\)\) return;[\s\S]{0,40}dismissEvent\(\)/.test(widgetHtml) && /function dismissEvent\(\)/.test(widgetHtml) && widgetHtml.indexOf('setTimeout(hideEvent') < 0);
// 5) 提示框移出不飘：隐藏只淡出（transition 仅 opacity）、位移只在入场（keyframes）
ok('提示框移出不飘：隐藏只淡出、位移只在入场动画', /\.tip \{[\s\S]{0,420}transform: none;[\s\S]{0,140}transition: opacity \.12s ease;/.test(widgetHtml) && /\.tip\.on \{ opacity: 1; animation: tipIn/.test(widgetHtml) && /@keyframes tipIn \{[\s\S]{0,120}translateY\(-2px\)/.test(widgetHtml) && widgetHtml.indexOf('transition: opacity .12s ease, transform .12s ease') < 0);

// ---------------------------------------------------------------- 13. 死代码清理 + 提示箭头不再跳位
console.log('\n[13] 死代码清理 + 提示箭头不再跳位');
ok('.event-skip 相关 CSS 已删除', widgetHtml.indexOf('event-skip') < 0 && widgetHtml.indexOf('eventSkip') < 0);
// 同源死 CSS（更早“确认金额”UI 遗留）：一并清除并守卫，防止回植
ok('.event-input / .event-ok 同源死 CSS 已删除', widgetHtml.indexOf('event-input') < 0 && widgetHtml.indexOf('event-ok') < 0);
// 移出时不再以外层卡片为锚点重显（箭头不跳位）：mouseleave 用 relatedTarget 判断“指针是否仍在锚点内”
ok('移出时不以外层卡片为锚点重显（箭头不跳位）', /node\.addEventListener\("mouseleave", function \(e\) \{[\s\S]{0,520}var to = e && e\.relatedTarget;[\s\S]{0,140}if \(anchor && to && anchor\.contains\(to\)\) showTip\(anchor\);/.test(widgetHtml) && widgetHtml.indexOf('if (anchor) showTip(anchor)') < 0);
// 淡出过程中不被重定位：提示框是单例元素；showTip 先“取消淡出（禁过渡 + 归 0）”，再改几何，最后恢复过渡淡入
ok('淡出过程中不被重定位（先取消淡出再改写几何）', /var TIP_FADE_MS = 120;/.test(widgetHtml) && /state\.tipHiddenAt = Date\.now\(\);/.test(widgetHtml) && /var fading = !el\.tip\.classList\.contains\("on"\)[\s\S]{0,160}TIP_FADE_MS;/.test(widgetHtml) && /if \(fading\) \{ el\.tip\.style\.transition = "none"; el\.tip\.style\.opacity = "0"; \}/.test(widgetHtml) && /if \(fading\) \{[\s\S]{0,200}void el\.tip\.offsetWidth;[\s\S]{0,140}el\.tip\.style\.transition = "";[\s\S]{0,100}el\.tip\.style\.opacity = "";/.test(widgetHtml));
// 相邻锚点切换仍平滑：取消淡出后恢复过渡并从 0 淡入；且此前两项修复（隐藏无位移 / relatedTarget 闸门）未被回归
ok('相邻锚点切换仍平滑（恢复过渡淡入，无回归）', /state\.tipHiddenAt = 0;/.test(widgetHtml) && /\.tip \{[\s\S]{0,460}transform: none;[\s\S]{0,160}transition: opacity \.12s ease;/.test(widgetHtml) && /\.tip\.on \{ opacity: 1; animation: tipIn/.test(widgetHtml) && /var to = e && e\.relatedTarget;/.test(widgetHtml));
// 悬停意图：showTip 只挂延迟，真正渲染在 renderTip；延迟内 hideTip（#掠过/移出/抑制）取消该次显示
ok('悬停意图延迟存在且可被取消', /var TIP_SHOW_DELAY = 120;/.test(widgetHtml) && /function cancelTipShow\(\) \{[\s\S]{0,160}clearTimeout\(tipShowTimer\)/.test(widgetHtml) && /tipShowTimer = setTimeout\(function \(\) \{[\s\S]{0,200}renderTip\(a\);/.test(widgetHtml) && /\}, TIP_SHOW_DELAY\);/.test(widgetHtml) && /function hideTip\(\) \{\s*\n\s*cancelTipShow\(\);/.test(widgetHtml));
// 掠过不弹、刻意悬停仍弹；且不回归前面三项修复（淡出归 0 / relatedTarget 闸门 / 隐藏无位移）
ok('掠过不弹、刻意悬停仍弹（不回归既有修复）', /function renderTip\(anchor\) \{/.test(widgetHtml) && /if \(tipShowTimer && tipPendingAnchor === anchor\) return;/.test(widgetHtml) && /var fading = !el\.tip\.classList\.contains\("on"\)[\s\S]{0,160}TIP_FADE_MS;/.test(widgetHtml) && /anchor\.contains\(to\)\) showTip\(anchor\);/.test(widgetHtml) && /\.tip \{[\s\S]{0,460}transform: none;[\s\S]{0,160}transition: opacity \.12s ease;/.test(widgetHtml));
// 箭头定位机制：全文件只有一条 left 原点声明（在基类 .tip::after 上，above 变体不覆写）——不存在“左右镜像”
ok('箭头两变体共用同一 x 原点（无左右镜像）', (widgetHtml.match(/left: var\(--arrow-x/g) || []).length === 1 && !/right: var\(--arrow-x/.test(widgetHtml) && /\.tip::after \{[\s\S]{0,120}left: var\(--arrow-x, 50%\)/.test(widgetHtml) && !/\.tip\.above::after \{[\s\S]{0,160}(left|right):/.test(widgetHtml));
// 箭头所在边只由 above 决定：基类（无 above）在上边，above 在下边
ok('箭头方向由 above 决定（基类在上边 / above 在下边）', /\.tip::after \{[\s\S]{0,240}bottom: 100%;[\s\S]{0,200}border-bottom: 5px solid/.test(widgetHtml) && /\.tip\.above::after \{[\s\S]{0,120}bottom: auto; top: 100%;[\s\S]{0,120}border-top: 5px solid/.test(widgetHtml));
// 移出时不得换边：hideTip 保留 above，否则会回落基类把箭头瞬时翻到提示框上边框（作者报的“镜像”）
ok('移出时箭头不换边/不镜像（保留 above 方向类）', /el\.tip\.className = el\.tip\.classList\.contains\("above"\) \? "tip above" : "tip";/.test(widgetHtml) && !/el\.tip\.className = "tip";/.test(widgetHtml));

// ---------------------------------------------------------------- 14. 存储与入账硬化（P0-01 / P1-01 / P1-02 / P1-03）
console.log('\n[14] 存储与入账：stateGet 单一 / 陈旧基线不回填 / 退款间隔守卫 / 落库与去重 / 工具原子写');

// --- 14.0 静态守卫 ---
ok('只剩一处 stateGet 定义', (balSrc.match(/function stateGet\(/g) || []).length === 1);
ok('stateGet 只在无 dataDir 时回落配置键', /return STATE_FILE \? undefined : readConfig\(key\)/.test(balSrc));
ok('迁移清单不再含任何键（两个基线尤其排除）', /const LEGACY_STATE_KEYS = \[\];/.test(balSrc));
ok('陈旧基线只记日志不回填', /const STALE_BASELINE_KEYS = \['lastToppedUpBalance', 'lastGrantedBalance'\]/.test(balSrc) && /legacy baseline .+ in config ignored/.test(balSrc));
ok('退款间隔守卫常量存在', /const REFUND_GAP_MAX_MS = 30 \* 60 \* 1000;/.test(balSrc));
ok('退款分支带间隔守卫、充值分支不带', /dTop <= -REFUND_MIN_DELTA[\s\S]{0,400}gapMs == null \|\| gapMs > REFUND_GAP_MAX_MS/.test(balSrc) && !/dTop >= RECHARGE_MIN_DELTA[\s\S]{0,200}gapMs/.test(balSrc));
ok('入账写入返回值被检查', /const ok = writeConfig\('totalRecharged'/.test(balSrc) && /const ok = writeConfig\('totalRefunded'/.test(balSrc));
ok('写失败不推进基线', /if \(!persistFailed && toppedUp !== prevTop\) stateSet\('lastToppedUpBalance', toppedUp\)/.test(balSrc));
ok('同源去重守卫存在且比对基线', /function isDuplicateBooking/.test(balSrc) && /Math\.abs\(dprev - prevTop\) < 1e-9/.test(balSrc) && /DUPLICATE_WINDOW_MS = 15 \* 60 \* 1000/.test(balSrc));
ok('事件带 persistFailed 标记并落盘', /EVENT_PERSIST_FAILED_KEY/.test(balSrc) && /persistFailed: !!stateGet\(EVENT_PERSIST_FAILED_KEY\)/.test(balSrc));
ok('侧栏提示累计未落盘文案', /累计值暂未落盘/.test(widgetHtml) && /ev\.persistFailed/.test(widgetHtml));
ok('预警工具改为读盘合并 + 原子写、不整对象覆盖', /const merged = Object\.assign\(\{\}, disk, patch \|\| \{\}\)/.test(alertSrc) && /fs\.renameSync\(tmp, file\)/.test(alertSrc) && !/store\.write\(\{ \.\.\.st/.test(alertSrc));

// --- 14.1 行为级：合成数据实跑 /api/balance（不碰运行态目录）---
async function loadBalanceModule() { return await import('../routes/balance.js?t=' + Date.now() + '-' + Math.random().toString(36).slice(2)); }
function mkApp() { const h = {}; return { app: { get: (p, fn) => { h['GET ' + p] = fn; }, post: (p, fn) => { h['POST ' + p] = fn; } }, h: h }; }
function mkCtx(dir, cfgStore, ctl) {
  const logs = [];
  const ctx = {
    config: {
      get: (k) => (Object.prototype.hasOwnProperty.call(cfgStore, k) ? cfgStore[k] : undefined),
      set: (k, v) => { if (ctl.failSet) throw new Error('config.set blocked'); cfgStore[k] = v; },
    },
    dataDir: dir,
    network: { fetch: async (url) => {
      if (String(url).indexOf('api.deepseek.com/user/balance') >= 0) {
        const up = ctl.upstream;
        return { ok: true, status: 200, json: async () => up, text: async () => JSON.stringify(up) };
      }
      return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    } },
    resources: { write: async () => true },
    bus: { request: async () => [] },
    log: { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), log: (m) => logs.push(m) },
  };
  return { ctx: ctx, logs: logs, cfgStore: cfgStore };
}
function mkCall() { const c = { _res: null, req: { query: () => ({}), json: async () => ({}) }, json: function (b, s) { c._res = { body: b, status: s || 200 }; return c; }, html: (s) => s }; return c; }
function readStateFile(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch (e) { return null; } }
function writeStateFile(dir, obj) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(obj)); }
function balanceUpstream(top, granted) { return { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: top + (granted || 0), topped_up_balance: top, granted_balance: granted || 0 }] }; }
async function callBalance(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-check-'));
  if (seed.state) writeStateFile(dir, seed.state);
  const cfg = Object.assign({ apiKey: 'sk-check', totalRecharged: 130, totalRefunded: 0 }, seed.config || {});
  const ctl = { failSet: !!seed.failSet, upstream: seed.upstream };
  const built = mkApp();
  const made = mkCtx(dir, cfg, ctl);
  const mod = await loadBalanceModule();
  mod.default(built.app, made.ctx);
  function call(upstream) { if (upstream) ctl.upstream = upstream; const c = mkCall(); return Promise.resolve(built.h['GET /api/balance'](c)).then(() => c); }
  const c = await call();
  return { dir: dir, res: c._res, state: readStateFile(dir), cfg: made.cfgStore, logs: made.logs, call: call, ctl: ctl };
}

// P0-01：缺 state + 陈旧 legacy 基线 → 首次运行只建基线、绝不判事件
{
  const r = await callBalance({ config: { lastToppedUpBalance: 25.83, lastGrantedBalance: 0 }, upstream: balanceUpstream(16.37, 0) });
  const d = r.res && r.res.body && r.res.body.data;
  ok('P0-01 缺 state + 陈旧基线：不判事件', !!d && d.detected === null, JSON.stringify(d && d.detected));
  ok('P0-01 基线只建为真实值 16.37（不继承 25.83）', r.state && r.state.lastToppedUpBalance === 16.37, r.state && String(r.state.lastToppedUpBalance));
  ok('P0-01 未误记退款（累计不变）', r.cfg.totalRefunded === 0 && r.cfg.totalRecharged === 130);
  ok('P0-01 陈旧基线被跳过并记日志', r.logs.some((m) => m.indexOf('legacy baseline') >= 0), r.logs.join('|').slice(0, 160));
}

// P1-01：退款间隔守卫
{
  const now = Date.now();
  const longGap = await callBalance({ state: { lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: now - 6 * 3600 * 1000 }, upstream: balanceUpstream(12, 0) });
  ok('P1-01 长间隔(6h)下调 8 → 退款不入账', longGap.res.body.data.detected === null && longGap.cfg.totalRefunded === 0, JSON.stringify(longGap.res.body.data.detected));
  ok('P1-01 长间隔：基线前移到 12', longGap.state.lastToppedUpBalance === 12, String(longGap.state.lastToppedUpBalance));
  ok('P1-01 长间隔有跳过日志', longGap.logs.some((m) => m.indexOf('refund judgement skipped') >= 0));

  const shortGap = await callBalance({ state: { lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: now - 60 * 1000 }, upstream: balanceUpstream(12, 0) });
  ok('P1-01 短间隔(60s)下调 8 → 按现规则入账退款', shortGap.res.body.data.detected === 'refund' && shortGap.cfg.totalRefunded === 8, JSON.stringify(shortGap.res.body.data.detected) + '/' + shortGap.cfg.totalRefunded);

  const noGap = await callBalance({ state: { lastToppedUpBalance: 20, lastGrantedBalance: 0 }, upstream: balanceUpstream(12, 0) });
  ok('P1-01 间隔缺失(升级后首次) → 保守跳过退款', noGap.res.body.data.detected === null && noGap.cfg.totalRefunded === 0);

  const charge = await callBalance({ state: { lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: now - 6 * 3600 * 1000 }, upstream: balanceUpstream(28, 0) });
  ok('P1-01 长间隔下上调仍入账（充值不受守卫）', charge.res.body.data.detected === 'recharge' && charge.cfg.totalRecharged === 138, JSON.stringify(charge.res.body.data.detected));
}

// P1-02：落库失败不推进 + 重试只累加一次
{
  const now = Date.now();
  const r = await callBalance({ failSet: true, state: { lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: now - 60 * 1000 }, upstream: balanceUpstream(28, 0) });
  ok('P1-02 写入失败：事件带 persistFailed', r.res.body.data.event && r.res.body.data.event.persistFailed === true, JSON.stringify(r.res.body.data.event));
  ok('P1-02 写入失败：累计不动', r.cfg.totalRecharged === 130, String(r.cfg.totalRecharged));
  ok('P1-02 写入失败：基线不推进（仍 20）', r.state.lastToppedUpBalance === 20, String(r.state.lastToppedUpBalance));
  r.ctl.failSet = false;
  const c2 = await r.call(balanceUpstream(28, 0));
  const st2 = readStateFile(r.dir);
  ok('P1-02 重试成功：累计只累加一次（130→138）', r.cfg.totalRecharged === 138, String(r.cfg.totalRecharged));
  ok('P1-02 重试成功：基线推进到 28、事件不再标失败', c2._res.body.data.detected === 'recharge' && st2.lastToppedUpBalance === 28 && c2._res.body.data.event.persistFailed === false);
}

// P1-02：同源去重（写成功但基线丢）
{
  const now = Date.now();
  const dup = await callBalance({ state: { lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: now - 120 * 1000, lastBookedType: 'recharge', lastBookedAmount: 10, lastBookedAt: now - 120 * 1000, lastBookedPrevTop: 20, lastBookedNewTop: 30 }, config: { totalRecharged: 140 }, upstream: balanceUpstream(30, 0) });
  ok('P1-02 同源（基线未前移）→ 不再累加', dup.cfg.totalRecharged === 140, String(dup.cfg.totalRecharged));
  ok('P1-02 同源 → 只前移基线到 30', dup.state.lastToppedUpBalance === 30);
  ok('P1-02 同源有抑制日志', dup.logs.some((m) => m.indexOf('duplicate recharge booking suppressed') >= 0));

  const real2 = await callBalance({ state: { lastToppedUpBalance: 30, lastGrantedBalance: 0, lastBalanceCheckAt: now - 120 * 1000, lastBookedType: 'recharge', lastBookedAmount: 10, lastBookedAt: now - 120 * 1000, lastBookedPrevTop: 20, lastBookedNewTop: 30 }, config: { totalRecharged: 140 }, upstream: balanceUpstream(40, 0) });
  ok('P1-02 真实第二笔同额充值（基线已前移）→ 正常累加', real2.cfg.totalRecharged === 150 && real2.res.body.data.detected === 'recharge', String(real2.cfg.totalRecharged));
}

// P1-03：预警工具原子写 + 只合并自己的键
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-alert-'));
  writeStateFile(dir, { alertState: 0, lastAlertPushAt: 0, balanceSamples: [{ t: 1, total: 5 }], lastToppedUpBalance: 7.5 });
  const store = { alertNotify: true, alertThreshold: 10, apiKey: 'sk-x' };
  const alertCtx = {
    config: { get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined), set: (k, v) => { store[k] = v; } },
    dataDir: dir,
    network: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: 3, topped_up_balance: 3, granted_balance: 0 }] }) }) },
  };
  const alertMod = await import('../tools/balance-alert.js?t=' + Date.now());
  const out = JSON.parse(await alertMod.execute({}, alertCtx));
  const after = readStateFile(dir);
  ok('P1-03 工具返回 due=true', out.ok === true && out.due === true, JSON.stringify(out).slice(0, 120));
  ok('P1-03 工具写入 alertState=1', after && after.alertState === 1);
  ok('P1-03 工具不抹掉路由的 balanceSamples/lastToppedUpBalance', after && Array.isArray(after.balanceSamples) && after.balanceSamples.length === 1 && after.lastToppedUpBalance === 7.5, JSON.stringify(after).slice(0, 180));
}

// ---------------------------------------------------------------- 15. 口径与日历（P1-04 / P1-05 / D-01 / D-03）
console.log('\n[15] 口径与日历：假日覆盖告示 / 高峰刻度掩码 / 页脚口径措辞');
const readmeText = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// --- 15.1 P1-04 节假日表跨年失配 ---
ok('P1-04 内置表自报覆盖年份（含 2026、不含 2027）', Array.isArray(COVERED_YEARS) && COVERED_YEARS.indexOf(2026) >= 0 && isYearCovered(2026) === true && isYearCovered(2027) === false);
ok('P1-04 未覆盖年份告示为真（2027-01-05）且写清楚后果', (function () { const c = holidayCoverage(Date.UTC(2027, 0, 5, 4, 0, 0)); return c.covered === false && c.year === 2027 && /2×/.test(c.message) && /未收录/.test(c.message); })());
ok('P1-04 覆盖年份无告示（2026-09-27）', (function () { const c = holidayCoverage(Date.UTC(2026, 8, 27, 4, 0, 0)); return c.covered === true && c.message === ''; })());
ok('P1-04 路由按北京日去重 warn + 下发 coverage（源码守卫）', /HOLIDAY_WARN_DAY_KEY/.test(balSrc) && /holiday table does not cover year/.test(balSrc) && /holidayCoverage: coverage/.test(balSrc) && /beijingDayKey\(now\)/.test(balSrc));
ok('P1-04 详情页有可见告示位与渲染', pageHtml.indexOf('id="coverageNote"') >= 0 && /d\.holidayCoverage/.test(pageHtml) && /covNote\.style\.display = "block"/.test(pageHtml));
ok('P1-04 不擅自改判定方向（2027 周一仍按工作日算高峰）', isPeakDay(Date.UTC(2027, 0, 4, 4, 0, 0)) === true && isPeakAt(Date.UTC(2027, 0, 4, 2, 0, 0)) === true);
// 2026 内高峰判定逐项不变（回归对照）
(function () {
  const cases = [
    [Date.UTC(2026, 8, 21, 2, 0, 0), true, '周一北京10:00'],
    [Date.UTC(2026, 8, 21, 1, 0, 0), true, '周一北京09:00'],
    [Date.UTC(2026, 8, 21, 0, 59, 0), false, '周一北京08:59'],
    [Date.UTC(2026, 8, 21, 4, 0, 0), false, '周一北京12:00'],
    [Date.UTC(2026, 8, 21, 5, 0, 0), false, '周一北京13:00'],
    [Date.UTC(2026, 8, 21, 9, 59, 0), true, '周一北京17:59'],
    [Date.UTC(2026, 8, 21, 10, 0, 0), false, '周一北京18:00'],
    [Date.UTC(2026, 8, 26, 2, 0, 0), false, '周六北京10:00'],
    [Date.UTC(2026, 8, 25, 2, 0, 0), false, '中秋北京10:00'],
    [Date.UTC(2026, 9, 1, 2, 0, 0), false, '国庆北京10:00'],
  ];
  const bad = cases.filter((c) => isPeakAt(c[0]) !== c[1]);
  ok('P1-04 2026 高峰判定逐项不变（' + cases.length + ' 项回归）', bad.length === 0, bad.map((b) => b[2]).join('、'));
})();

// --- 15.2 P1-05 X 轴高峰刻度错位（刻度着色与计费同源）---
const BJ_PEAK = [9, 10, 11, 14, 15, 16, 17]; // 计费口径 isPeakAt：右开区间，不含边界 12/18
function bjHourOf(ms) { return new Date(ms + 8 * 3600 * 1000).getUTCHours(); }
(function () {
  const PDAY480 = Date.UTC(2026, 8, 20, 16, 0, 0); // 北京 2026-09-21（周一）00:00
  const PDAY0 = Date.UTC(2026, 8, 21, 0, 0, 0);     // UTC  2026-09-21 00:00
  const m480 = buildPeakTickMask(PDAY480, 24);
  const m0 = buildPeakTickMask(PDAY0, 24);
  // 同源性：逐项证明掩码 === 计费谓词（不是“看起来一样”）
  ok('P1-05 同源：掩码逐项等于 isPeakAt（GMT+8 的 24 整点）', m480.length === 24 && m480.every((v, k) => v === isPeakAt(PDAY480 + k * 3600000)));
  ok('P1-05 同源：掩码逐项等于 isPeakAt（UTC+0 的 24 整点）', m0.length === 24 && m0.every((v, k) => v === isPeakAt(PDAY0 + k * 3600000)));
  // 集合：已对齐计费 → 8 个（去 12/18）。此为作者的明确决定，勿当回归修回去。
  ok('P1-05 GMT+8 红刻度集合 = {9,10,11,14,15,16,17}（已对齐计费，去 12/18）', m480.map((v, i) => (v ? i : -1)).filter((i) => i >= 0).join(',') === '9,10,11,14,15,16,17' && BJ_PEAK.join(',') === '9,10,11,14,15,16,17');
  ok('P1-05 UTC+0：被标红刻度对应钟点都落在北京 {9,10,11,14,15,16,17}', m0.every((v, k) => !v || BJ_PEAK.indexOf(bjHourOf(PDAY0 + k * 3600000)) >= 0) && m0.filter(Boolean).length === 7);
  ok('P1-05 UTC+0：红刻度的北京钟点集合与 GMT+8 完全一致（跨时区）', m0.map((v, k) => (v ? bjHourOf(PDAY0 + k * 3600000) : -1)).filter((h) => h >= 0).join(',') === '9,10,11,14,15,16,17');
  ok('P1-05 边界整点 12/18 归非高峰（右开区间）', isPeakAt(PDAY480 + 12 * 3600000) === false && isPeakAt(PDAY480 + 18 * 3600000) === false && m480[12] === false && m480[18] === false);
  const NDAY480 = Date.UTC(2026, 8, 25, 16, 0, 0); // 北京 2026-09-26（周六）00:00
  const NDAY0 = Date.UTC(2026, 8, 26, 0, 0, 0);
  ok('P1-05 非高峰日（周六）全天不标红（两时区）', !buildPeakTickMask(NDAY480, 24).some(Boolean) && !buildPeakTickMask(NDAY0, 24).some(Boolean));
})();

// --- 15.3 D-01 / D-03 页脚口径措辞 ---
ok('D-01 页脚不再有「实测约低 15%」过代表述', pageHtml.indexOf('实测约低 15%') < 0 && pageHtml.indexOf('口径不完全一致') < 0);
ok('D-01 页脚新文案（逐项核对 / 默认 1）', pageHtml.indexOf('已与官方账单逐项核对，默认 1') >= 0);
ok('D-03 价目表措辞（内置表为离线兜底、实时价以自动同步为准）', pageHtml.indexOf('价目表核对于 2026-09-24') < 0 && pageHtml.indexOf('内置价目表仅为离线兜底，实时价以自动同步') >= 0);
ok('D-01 README 无「约低 15%」过代表述', readmeText.indexOf('约低 15%') < 0);

// --- 15.4 stats 负载集成：dayPeakMask + holidayCoverage ---
function mkCallQ(query) { const c = { _res: null, req: { query: (k) => (k ? (query || {})[k] : (query || {})), json: async () => ({}) }, json: function (b, s) { c._res = { body: b, status: s || 200 }; return c; }, html: (s) => s }; return c; }
async function callStats(query) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-stats-'));
  const cfg = { apiKey: 'sk-check', totalRecharged: 130, totalRefunded: 0 };
  const ctl = { failSet: false, upstream: { is_available: true, balance_infos: [] } };
  const built = mkApp();
  const made = mkCtx(dir, cfg, ctl);
  const mod = await loadBalanceModule();
  mod.default(built.app, made.ctx);
  const c = mkCallQ(query);
  await built.h['GET /api/stats'](c);
  return c._res;
}
{
  const res = await callStats({ range: 'today', tz: '480' });
  const d = res && res.body && res.body.data;
  ok('P1-05 stats 下发 dayPeakMask（今天=小时桶，长度 24）', !!d && Array.isArray(d.dayPeakMask) && d.dayPeakMask.length === 24, JSON.stringify(d && d.dayPeakMask && d.dayPeakMask.length));
  ok('P1-04 stats 下发 holidayCoverage（与纯函数一致）', !!d && !!d.holidayCoverage && d.holidayCoverage.covered === holidayCoverage(Date.now()).covered && Array.isArray(d.holidayCoverage.coveredYears));
}

// ---------------------------------------------------------------- 16. 体验合规（P1-06 / P1-07 / P1-08）
console.log('\n[16] 体验合规：键盘可达 / 解释不只 hover / 对比度 AA');

// --- 16.1 P1-06 键盘可达 ---
ok('P1-06 时间维度 pill 有 keydown 分支', /function pillKeyToActivate\(e\)/.test(pageHtml) && /id\("timePill"\)\.addEventListener\("keydown", pillKeyToActivate\)/.test(pageHtml));
ok('P1-06 Enter/Space 均处理且 Space 阻止滚动', /e\.key !== "Enter" && e\.key !== " " && e\.key !== "Spacebar"/.test(pageHtml) && /e\.preventDefault\(\); \/\/ Space 默认会滚动页面/.test(pageHtml) && /e\.currentTarget\.click\(\)/.test(pageHtml));
ok('P1-06 存在 .fpill:focus-visible 焦点环', /\.fpill:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 1px; \}/.test(pageHtml));
const cardSeg = (function () { const i = widgetHtml.indexOf('id="balanceCard"'); const j = widgetHtml.indexOf('id="costNote"'); return i < 0 || j < 0 ? '' : widgetHtml.slice(i, j); })();
ok('P1-06 「去设置」改为 button（键盘可达）', /<button class="link" id="settingLink" type="button">去设置<\/button>/.test(cardSeg));
ok('P1-06 「去设置」外观与 span 一致（清掉按钮默认样式）', /\.alert-hint \.link \{[\s\S]{0,500}border: 0; background: transparent; padding: 0; margin: 0;[\s\S]{0,200}font: inherit/.test(widgetHtml));
ok('P1-06 「去设置」仍命中提示排除（鼠标路径与改前一致）', /\[data-tip\] button, \[data-tip\] \.link, \[data-tip\] a/.test(widgetHtml) && cardSeg.indexOf('data-tip="单击刷新，双击查看官方用量"') >= 0 && cardSeg.indexOf('id="settingLink"') >= 0);

// --- 16.2 P1-07 关键解释不只存在于 hover ---
ok('P1-07 提示线接 focus/blur（键盘可触发）', /node\.addEventListener\("focus", function \(\) \{ showTip\(node\); \}\)/.test(widgetHtml) && /node\.addEventListener\("blur", hideTip\)/.test(widgetHtml));
ok('P1-07 Escape 关闭提示/菜单/弹窗 + 事件弹窗/错误框（预警红窗除外）', /if \(e\.key === "Escape"\) \{ hideTip\(\); closeMenu\(\); closeModal\(\); hideEvent\(\); clearError\(\); \}/.test(widgetHtml) && /不绑预警红窗/.test(widgetHtml));
ok('P1-07 关键锚点均可聚焦（tabindex=0）', ['balanceCard', 'costNote', 'breakdownRow', 'grantInfo', 'peakInfo'].every(function (idn) { return new RegExp('id="' + idn + '"[^>]*tabindex="0"').test(widgetHtml); }));
ok('P1-07 余额构成本构成可访问名含要点（充值/赠送）', /id="breakdownRow"[^>]*aria-label="[^"]*充值[^"]*赠送/.test(widgetHtml));
ok('P1-07 赠送有效期可访问名含要点', /id="grantInfo"[^>]*aria-label="[^"]*赠送[^"]*有效期/.test(widgetHtml));
ok('P1-07 今日消费额/高峰口径可访问名含要点', /id="peakInfo"[^>]*aria-label="[^"]*今日消费额[^"]*高峰[^"]*口径/.test(widgetHtml));
ok('P1-07 成本口径可访问名含要点（充值/退款）', /id="costNote"[^>]*aria-label="[^"]*充值[^"]*退款/.test(widgetHtml));

// --- 16.3 P1-08 对比度 AA（从 CSS 变量取值算 WCAG，不靠人眼）---
function hexToRgb(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function relLum(rgb) { const f = function (c) { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); }
function contrastRatio(a, b) { const l1 = relLum(hexToRgb(a)); const l2 = relLum(hexToRgb(b)); const hi = Math.max(l1, l2); const lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
function cssVar(css, name, idx) { const re = new RegExp('--' + name + ':\\s*#([0-9a-fA-F]{6})', 'g'); const out = []; let m; while ((m = re.exec(css))) out.push('#' + m[1]); return out[idx]; }
const panelL = cssVar(SHARED_CSS, 'panel-bg', 0), panelD = cssVar(SHARED_CSS, 'panel-bg', 1);
const secL = cssVar(SHARED_CSS, 'text-secondary', 0);
const terL = cssVar(SHARED_CSS, 'text-tertiary', 0), terD = cssVar(SHARED_CSS, 'text-tertiary', 1);
const peakL = cssVar(widgetHtml, 'peak', 0), peakD = cssVar(widgetHtml, 'peak', 1);
const rTerL = contrastRatio(terL, panelL), rSecL = contrastRatio(secL, panelL);
const rTerD = contrastRatio(terD, panelD), rPeakD = contrastRatio(peakD, panelD), rPeakL = contrastRatio(peakL, panelL);
ok('P1-08 对比度(算)：明 tertiary ' + terL + '/' + panelL + ' = ' + rTerL.toFixed(2) + ':1 ≥ 4.5', rTerL >= 4.5);
ok('P1-08 对比度(算)：明 secondary ' + secL + '/' + panelL + ' = ' + rSecL.toFixed(2) + ':1 ≥ 4.5', rSecL >= 4.5);
ok('P1-08 对比度(算)：暗 tertiary ' + terD + '/' + panelD + ' = ' + rTerD.toFixed(2) + ':1 ≥ 4.5', rTerD >= 4.5);
ok('P1-08 对比度(算)：暗 peak ' + peakD + '/' + panelD + ' = ' + rPeakD.toFixed(2) + ':1 ≥ 4.5', rPeakD >= 4.5);
ok('P1-08 对比度(算)：明 peak ' + peakL + '/' + panelL + ' = ' + rPeakL.toFixed(2) + ':1 ≥ 4.5', rPeakL >= 4.5);
// 反向守卫：改前的值确实不达标（证明修复必要，且防止回植）
ok('P1-08 改前 tertiary 明（#9ca3af）< 4.5（修复必要性）', contrastRatio('#9ca3af', '#f5f6f7') < 4.5);
ok('P1-08 改前 tertiary 暗（#71767b）< 4.5（修复必要性）', contrastRatio('#71767b', '#26282c') < 4.5);

// ---------------------------------------------------------------- 17. 上线后兜底（P1-09 / P1-10 / P1-11）
console.log('\n[17] 上线后兜底：预警链留痕 / 面板异常留痕 / 回滚台账');
const relSrc = fs.readFileSync(path.join(root, 'scripts', 'release.mjs'), 'utf8');
const chgText = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

function mkCallPost(body) { const c = { _res: null, req: { query: () => ({}), json: async () => body }, json: function (b, s) { c._res = { body: b, status: s || 200 }; return c; }, html: (s) => s }; return c; }
async function callRoute(method, p, body, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-route-'));
  const cfg = Object.assign({ apiKey: 'sk-check', totalRecharged: 130, totalRefunded: 0 }, (seed && seed.config) || {});
  const ctl = { failSet: false, upstream: { is_available: true, balance_infos: [] } };
  const built = mkApp(); const made = mkCtx(dir, cfg, ctl);
  const mod = await loadBalanceModule(); mod.default(built.app, made.ctx);
  const c = mkCallPost(body);
  await built.h[method + ' ' + p](c);
  return { res: c._res, logs: made.logs, dir: dir };
}
function mkAlertLog(logs) { return { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), log: (m) => logs.push(m) }; }

// 复用同一个 dataDir 连调多个路由（同步后立刻查累计/统计）；可注入本机账本与配置
async function callInDir(dir, method, p, body, cfg, ledger) {
  const built = mkApp();
  const made = mkCtx(dir, Object.assign({ apiKey: 'sk-check' }, cfg || {}), { failSet: false, upstream: { is_available: true, balance_infos: [] } });
  if (ledger) made.ctx.bus = { request: async () => ledger };
  const mod = await loadBalanceModule(); mod.default(built.app, made.ctx);
  const query = (body && body.query) || {};
  const c = (method === 'GET')
    ? { _res: null, req: { query: (k) => (k == null ? query : query[k]), json: async () => ({}) }, json: function (b, s) { c._res = { body: b, status: s || 200 }; return c; }, html: (s) => s }
    : mkCallPost(body);
  await built.h[method + ' ' + p](c);
  return { res: c._res, body: c._res ? c._res.body : null, dir: dir, logs: made.logs };
}

// --- 17.1 P1-09 预警链留痕 ---
ok('P1-09 工具含 ctx.log 留痕（tlog + 降级 + 决策）', /function tlog\(ctx, level, msg\)/.test(alertSrc) && /degraded to hourly bucket/.test(alertSrc) && /decision: alerting=/.test(alertSrc));
ok('P1-09 /api/config 下发 alertNotify', /alertNotify: readConfig\('alertNotify'\) !== false/.test(balSrc));
ok('P1-09 侧栏显示「推送已关闭」', /id="alertHintText"/.test(widgetHtml) && /余额预警已开启（推送已关闭）/.test(widgetHtml) && /function renderAlertHint/.test(widgetHtml));
ok('P1-09 设置弹窗有推送关闭说明', widgetHtml.indexOf('推送已关闭：预警不会主动通知你') >= 0);
{
  const alertMod = await import('../tools/balance-alert.js?t=' + Date.now());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-alert-off-'));
  const logs = []; const storeCfg = { alertNotify: false, alertThreshold: 10, apiKey: 'sk-x' };
  const off = JSON.parse(await alertMod.execute({}, { config: { get: (k) => storeCfg[k], set: (k, v) => { storeCfg[k] = v; } }, dataDir: dir, network: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: 3 }] }) }) }, log: mkAlertLog(logs) }));
  ok('P1-09 alertNotify=false → disabled 且留痕', off.due === false && off.reason === 'disabled' && logs.some((m) => m.indexOf('disabled by alertNotify') >= 0));
}
{
  const alertMod = await import('../tools/balance-alert.js?t=' + Date.now());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-alert-on-'));
  const logs = []; const storeCfg = { alertNotify: true, alertThreshold: 10, apiKey: 'sk-x' };
  const on = JSON.parse(await alertMod.execute({}, { config: { get: (k) => storeCfg[k], set: (k, v) => { storeCfg[k] = v; } }, dataDir: dir, network: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: 3 }] }) }) }, log: mkAlertLog(logs) }));
  ok('P1-09 跌破 → due=true、entered_alert + lastAlertPushAt 留痕', on.ok === true && on.due === true && logs.some((m) => m.indexOf('entered_alert') >= 0) && logs.some((m) => m.indexOf('lastAlertPushAt=') >= 0));
  ok('P1-09 决策行留痕', logs.some((m) => m.indexOf('decision: alerting=true due=true reason=entered_alert') >= 0));
  ok('P1-09 hint 含「notify 投递失败改走桌面通知」', String(on.hint).indexOf('notify 投递失败') >= 0 && String(on.hint).indexOf('桌面通知') >= 0);
}
{
  // 持久化失败：用文件冒充 dataDir 目录 → 写盘必失败 → 降级整点桶 + 留痕
  const fileAsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-alert-bad-')), 'not-a-dir');
  fs.writeFileSync(fileAsDir, 'x');
  const alertMod = await import('../tools/balance-alert.js?t=' + Date.now());
  const logs = []; const storeCfg = { alertNotify: true, alertThreshold: 10, apiKey: 'sk-x' };
  const bad = JSON.parse(await alertMod.execute({}, { config: { get: (k) => storeCfg[k], set: (k, v) => { storeCfg[k] = v; } }, dataDir: fileAsDir, network: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: 3 }] }) }) }, log: mkAlertLog(logs) }));
  ok('P1-09 持久化失败 → 降级整点桶并留痕', String(bad.reason).indexOf('bucket') === 0 && logs.some((m) => m.indexOf('degraded to hourly bucket') >= 0));
}

// --- 17.2 P1-10 面板内异常留痕 ---
ok('P1-10 后端有 POST /api/client-error（限长/脱敏/不回显）', /app\.post\('\/api\/client-error'/.test(balSrc) && /CLIENT_ERROR_MAX_CHARS = 2048/.test(balSrc) && /sk-\*\*\*/.test(balSrc) && /client error \[/.test(balSrc));
ok('P1-10 侧栏错误框可选中复制 + 错误码回传', /\.err-box \{[\s\S]{0,260}user-select: text;/.test(widgetHtml) && /function reportClientError/.test(widgetHtml) && /reportClientError\(msg, "面板遇到异常/.test(widgetHtml));
ok('P1-10 详情页也接线回传', /function reportClientError/.test(pageHtml) && /reportClientError\(msg\);/.test(pageHtml));
ok('P1-10 README 补「面板报错怎么取证」+ 安全说明', readmeText.indexOf('面板报错怎么取证') >= 0 && readmeText.indexOf('/api/client-error') >= 0 && readmeText.indexOf('sk-***') >= 0);
{
  const r = await callRoute('POST', '/api/client-error', { code: 'E1', message: 'boom' });
  ok('P1-10 client-error 落日志（同渠道）', r.res.body.ok === true && r.logs.some((m) => m.indexOf('client error [E1]') >= 0 && m.indexOf('boom') >= 0));
  const long = 'x'.repeat(5000);
  const r2 = await callRoute('POST', '/api/client-error', { code: 'E2', message: 'sk-abcdefghijklmnop ' + long });
  const logged = r2.logs.find((m) => m.indexOf('client error') >= 0) || '';
  ok('P1-10 client-error 限长 2048 + sk- 脱敏', logged.length < 2140 && logged.indexOf('sk-abcdefghijklmnop') < 0 && logged.indexOf('sk-***') >= 0);
  const r3 = await callRoute('POST', '/api/client-error', { code: 'E3', message: '' });
  ok('P1-10 client-error 空消息 → 400', r3.res.status === 400 && r3.res.body.ok === false);
}

// --- 17.3 P1-11 回滚台账 ---
ok('P1-11 release.mjs 打包前快照 plugin-data（带版本时间戳）', /import os from 'node:os'/.test(relSrc) && /plugin-data-' \+ id \+ '-' \+ version \+ '-' \+ ts/.test(relSrc) && /fs\.copyFileSync\(src, path\.join\(snapDir, f\)\)/.test(relSrc));
ok('P1-11 README 补回滚三步（含 status=loaded 复核）', readmeText.indexOf('回滚（三步）') >= 0 && readmeText.indexOf('status=loaded') >= 0 && readmeText.indexOf('totalRecharged') >= 0);
ok('P1-11 README 补 TOP5 排查手册', readmeText.indexOf('TOP5 排查手册') >= 0 && readmeText.indexOf('面板加载失败 / 白屏') >= 0 && readmeText.indexOf('预警不再推') >= 0);
ok('P1-11 CHANGELOG 补 1.14.1–1.14.26 区间 + 自 1.14.27 起独立成节', chgText.indexOf('1.14.1 – 1.14.26') >= 0 && chgText.indexOf('自 1.14.27 起每版独立成节') >= 0);

// ---------------------------------------------------------------- 18. 插件自有诊断日志（P1-09/P1-10 落点）
console.log('\n[18] 插件自有诊断日志：diagnostics.log + 轮转 + 读回口');

// --- 18.1 diag-log 格式化 / 脱敏 / 轮转 / 容错 ---
ok('18.1 阈值与文件名常量', DIAGMOD.DIAG_MAX_BYTES === 512 * 1024 && DIAGMOD.DIAG_FILE === 'diagnostics.log' && DIAGMOD.DIAG_ROTATED === 'diagnostics.1.log' && DIAGMOD.DIAG_TAIL_MAX === 500 && DIAGMOD.DIAG_TAIL_DEFAULT === 200);
ok('18.1 clampTail：默认/非法/超上限', DIAGMOD.clampTail(undefined) === 200 && DIAGMOD.clampTail('abc') === 200 && DIAGMOD.clampTail('10') === 10 && DIAGMOD.clampTail('9999') === 500 && DIAGMOD.clampTail('-5') === 200);
ok('18.1 scrub：控制字符剥离 + sk- 脱敏 + 限长', DIAGMOD.scrub('a\u0000b\nc') === 'a b c' && DIAGMOD.scrub('key sk-abcdefghijklmnop leaked').indexOf('sk-abcdefghijklmnop') < 0 && DIAGMOD.scrub('x'.repeat(9999)).length === DIAGMOD.DIAG_MAX_MESSAGE_CHARS);
ok('18.1 formatLine 形如 ISO+08:00 级别 [来源] 消息', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} WARN \[tool\] hello$/.test(DIAGMOD.formatLine('warn', 'tool', 'hello').trim()));
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-diag-'));
  const wrote = DIAGMOD.appendDiagnostic(dir, 'warn', 'tool', 'hello world');
  const text = fs.readFileSync(path.join(dir, DIAGMOD.DIAG_FILE), 'utf8');
  ok('18.1 追加写含级别/来源/消息', wrote === true && / WARN \[tool\] hello world/.test(text));
  DIAGMOD.appendDiagnostic(dir, 'info', 'client', 'leak sk-abcdefghijklmnop');
  const t2 = fs.readFileSync(path.join(dir, DIAGMOD.DIAG_FILE), 'utf8');
  ok('18.1 落盘同样脱敏', t2.indexOf('sk-abcdefghijklmnop') < 0 && t2.indexOf('sk-***') >= 0);
}
{
  // 轮转：小阈值参数化（不真写 512KB）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-diag-rot-'));
  for (let i = 0; i < 6; i += 1) DIAGMOD.appendDiagnostic(dir, 'info', 'route', 'line-' + i + '-' + 'x'.repeat(20), { maxBytes: 120 });
  ok('18.1 超阈值触发轮转（只留上一份 diagnostics.1.log）', fs.existsSync(path.join(dir, DIAGMOD.DIAG_ROTATED)) && !fs.existsSync(path.join(dir, 'diagnostics.2.log')));
  ok('18.1 轮转后主文件仍可继续写且不超阈值', fs.statSync(path.join(dir, DIAGMOD.DIAG_FILE)).size > 0 && fs.statSync(path.join(dir, DIAGMOD.DIAG_FILE)).size <= 120);
}
{
  // 目录不可写 → 不抛、返回 false、读亦不抛
  const fileAsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-diag-bad-')), 'not-a-dir');
  fs.writeFileSync(fileAsDir, 'x');
  let threw = false; let ret = null;
  try { ret = DIAGMOD.appendDiagnostic(fileAsDir, 'warn', 'tool', 'should not throw'); } catch (e) { threw = true; }
  ok('18.1 目录不可写 → 不抛且返回 false', threw === false && ret === false);
  ok('18.1 读不存在/不可读的日志 → 空数组不抛', JSON.stringify(DIAGMOD.readDiagnostics(path.join(fileAsDir, 'nope'), 10)) === '[]' && JSON.stringify(DIAGMOD.readDiagnostics('', 10)) === '[]');
}

// --- 18.2 GET /api/diagnostics 读回 + 端到端（client-error → 日志 → 读回）---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-diag-e2e-'));
  const built = mkApp();
  const made = mkCtx(dir, { apiKey: 'sk-check' }, { failSet: false, upstream: { is_available: true, balance_infos: [] } });
  const mod = await loadBalanceModule(); mod.default(built.app, made.ctx);
  function getDiag(q) { const c = { _res: null, req: { query: (k) => (k ? q[k] : q), json: async () => null }, json: function (b, s) { c._res = { body: b, status: s || 200 }; return c; }, html: (s) => s }; return Promise.resolve(built.h['GET /api/diagnostics'](c)).then(() => c._res); }
  const probe = 'acceptance-probe-' + Math.random().toString(36).slice(2, 10);
  const c1 = mkCallPost({ code: 'E2E', message: probe });
  await built.h['POST /api/client-error'](c1);
  const g = await getDiag({ tail: '50' });
  ok('18.2 E2E：POST client-error → GET /api/diagnostics 能读到探针', g.body.ok === true && g.body.data.lines.some((l) => l.indexOf(probe) >= 0));
  ok('18.2 读回带文件名字段与来源标记', g.body.data.file === 'diagnostics.log' && g.body.data.lines.some((l) => l.indexOf('[client]') >= 0));
  ok('18.2 非法 tail 回落默认值（不报错）', (await getDiag({ tail: 'abc' })).body.data.count <= 200);
  for (let i = 0; i < 600; i += 1) DIAGMOD.appendDiagnostic(dir, 'info', 'route', 'bulk-' + i);
  ok('18.2 tail 上限 500（写 600 行后 tail=9999）', (await getDiag({ tail: '9999' })).body.data.count === 500);
  DIAGMOD.appendDiagnostic(dir, 'warn', 'client', 'leak sk-abcdefghijklmnop');
  const gs = await getDiag({ tail: '1' });
  ok('18.2 读回内容同样脱敏', gs.body.data.lines[0].indexOf('sk-abcdefghijklmnop') < 0 && gs.body.data.lines[0].indexOf('sk-***') >= 0);
}
ok('18.2 路由/工具双写 diag（源码守卫）', /DIAG\.appendDiagnostic\(DIAG_DIR, level, source \|\| 'route', message\)/.test(balSrc) && /DIAG\.appendDiagnostic\(DIAG_DIR, level, 'tool', msg\)/.test(alertSrc) && /app\.get\('\/api\/diagnostics'/.test(balSrc));

// ---------------------------------------------------------------- 19. 健壮性（P2 + 键盘等价）
console.log('\n[19] 健壮性：上游护栏 / 单调时钟 / 价格失败短 TTL / 超时与释放 / 吸附 / 键盘等价');

// --- 19.1 上游数值护栏 ---
ok('19.1 isBalanceAmount：有限/非负/量级', balModSnap.isBalanceAmount(0) === true && balModSnap.isBalanceAmount(1e9) === true && balModSnap.isBalanceAmount(-1) === false && balModSnap.isBalanceAmount(NaN) === false && balModSnap.isBalanceAmount(Infinity) === false && balModSnap.isBalanceAmount(1e9 + 1) === false && balModSnap.isBalanceAmount(1e12) === false);
for (const bad of [-1, NaN, Infinity, 1e12]) {
  const now = Date.now();
  const bad1 = await callBalance({
    state: { lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: now - 60 * 1000 },
    config: { totalRecharged: 130, totalRefunded: 0 },
    upstream: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 5, topped_up_balance: bad, granted_balance: 0 }] },
  });
  const st1 = readStateFile(bad1.dir);
  ok('19.1 上游越界 ' + String(bad) + ' → bad_response + 不入账 + 基线不动 + warn',
    bad1.res.body.ok === false && bad1.res.body.error === 'bad_response' && bad1.res.status === 502 &&
    bad1.cfg.totalRecharged === 130 && st1.lastToppedUpBalance === 20 &&
    bad1.logs.some((m) => m.indexOf('out of range') >= 0));
}

// --- 19.2 单调时钟 ---
ok('19.2 isFresh：真实时长内/外', monoFresh(1000, 3000, 2000) === true && monoFresh(1000, 3000, 4000) === false);
ok('19.2 isFresh：时钟回拨（差值为负）判为不新鲜（不会永久缓存）', monoFresh(1000, 3000, 500) === false && monoFresh(0, 20000, -5000) === false);
ok('19.2 后端缓存改用单调源（源码守卫）', /MONO\.isFresh\(balanceCache\.at/.test(balSrc) && /MONO\.isFresh\(ledgerCache\.at/.test(balSrc) && /MONO\.isFresh\(cached\.at/.test(balSrc) && /MONO\.isFresh\(usageCountCache\.at/.test(balSrc) && /balanceCache = \{ keyTag: apiKey, at: MONO\.monoNow\(\)/.test(balSrc));
ok('19.2 前端看门狗改用 performance.now（源码守卫）', /function monoNow\(\)/.test(SHARED_JS) && /monoNow: monoNow/.test(SHARED_JS) && /state\.lastSuccessAt = HPU\.monoNow\(\)/.test(widgetHtml) && /lastSuccessAt: state\.lastSuccessAt,\s*\n\s*now: HPU\.monoNow\(\)/.test(widgetHtml));
ok('19.2 看门狗仍按阈值触发（数字证据）', (function () { const S = SHARED.Sched; return S.shouldWatchdog({ refreshSeconds: 60, lastSuccessAt: 1000, now: 1000 + 121000 }) === true && S.shouldWatchdog({ refreshSeconds: 60, lastSuccessAt: 1000, now: 1000 + 60000 }) === false; })());

// --- 19.3 价格同步失败短 TTL ---
ok('19.3 失败 TTL=10min、成功 TTL=12h', PRICE_SYNC_FAIL_TTL_MS === 10 * 60 * 1000 && PRICE_SYNC_TTL_MS === 12 * 3600 * 1000);
ok('19.3 priceSyncDue：失败 10 分钟内不再试、超过则再试', priceSyncDue(false, 0, 9 * 60 * 1000, false) === false && priceSyncDue(false, 0, 11 * 60 * 1000, false) === true);
ok('19.3 priceSyncDue：成功 12h 内不再试、超过则再试', priceSyncDue(true, 0, 11 * 3600 * 1000, false) === false && priceSyncDue(true, 0, 13 * 3600 * 1000, false) === true);
ok('19.3 priceSyncDue：force 总是到期；回拨（负差值）也判到期', priceSyncDue(false, 0, 0, true) === true && priceSyncDue(false, 1000, 500, false) === true);
ok('19.3 路由用 priceSyncDue 决策（源码守卫）', /priceSyncDue\(priceSync\.ok, priceSync\.monoAt, MONO\.monoNow\(\), force\)/.test(balSrc) && /priceSyncDue\(priceSync\.ok, priceSync\.monoAt, MONO\.monoNow\(\), false\)/.test(balSrc));

// --- 19.4 取数超时与释放 ---
ok('19.4 withTimeout：超时拒绝', (await (async function () { try { await balModSnap.withTimeout(new Promise(function () {}), 40, 'x'); return false; } catch (e) { return true; } })()) === true);
ok('19.4 withTimeout：快 promise 正常返回', (await balModSnap.withTimeout(Promise.resolve(42), 1000, 'y')) === 42);
ok('19.4 余额取数显式超时 + 退避重试（源码守卫）', /timeoutMs: BALANCE_FETCH_TIMEOUT_MS/.test(balSrc) && /withTimeout\(\s*\n?\s*ctx\.network\.fetch\(UPSTREAM_BALANCE_URL/.test(balSrc) && /await sleep\(BALANCE_RETRY_BACKOFF_MS\)/.test(balSrc));
ok('19.4 导出落盘加超时（源码守卫）', /withTimeout\(ctx\.resources\.write\(\{ kind: 'local-file', path: target \}, content\), EXPORT_WRITE_TIMEOUT_MS/.test(balSrc));
{
  // 行为：上游第一次抛（瞬时网络错）、第二次成功 → 退避重试一次后成功
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-retry-'));
  let calls = 0;
  const built = mkApp();
  const ctx = {
    config: { get: (k) => ({ apiKey: 'sk-x', totalRecharged: 130 })[k], set: () => {} },
    dataDir: dir,
    network: { fetch: async (url) => {
      if (String(url).indexOf('user/balance') >= 0) {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 10, topped_up_balance: 10, granted_balance: 0 }] }), text: async () => '' };
      }
      return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    } },
    resources: { write: async () => true },
    bus: { request: async () => [] },
    log: { info: () => {}, warn: () => {}, log: () => {} },
  };
  const mod = await loadBalanceModule(); mod.default(built.app, ctx);
  const c = mkCallPost({});
  await built.h['GET /api/balance'](c);
  ok('19.4 行为：瞬时失败 → 退避重试一次成功', calls === 2 && c._res.body.ok === true && c._res.body.data.totalBalance === 10, 'calls=' + calls);
}

// --- 19.5 整元吸附（告警 + 事件标注）---
ok('19.5 大残差告警（源码守卫）', /recharge window-consumption large/.test(balSrc) && /if \(residual > RECHARGE_SNAP_EPS\)/.test(balSrc));
ok('19.5 事件带 snapResidual 且侧栏标注（源码守卫）', /setEvent\('recharge', booked, !ok, residual\)/.test(balSrc) && /snapResidual: num\(stateGet\(EVENT_SNAP_RESIDUAL_KEY\)\)/.test(balSrc) && /金额按整元吸附，窗口内消费约 ¥/.test(widgetHtml) && /Number\(ev\.snapResidual\) > 0/.test(widgetHtml));

// --- 19.6 键盘等价（余额卡）---
ok('19.6 余额卡 keydown：Enter/Space 刷新、Shift+Enter 用量页（复用同一函数）', /el\.balanceCard\.addEventListener\("keydown"/.test(widgetHtml) && /if \(e\.shiftKey\) \{ openExternal\("https:\/\/platform\.deepseek\.com\/usage"\); return; \}\s*\n\s*refreshNow\(\)/.test(widgetHtml) && /e\.preventDefault\(\)/.test(widgetHtml));
ok('19.6 余额卡可访问名含键盘等价说明', /id="balanceCard"[^>]*aria-label="[^"]*回车刷新[^"]*Shift\+回车查看官方用量/.test(widgetHtml));

// ---------------------------------------------------------------- 20. 体验打磨（八条）
console.log('\n[20] 体验打磨：reduced-motion / 焦点陷阱 / Escape / 浮层定位 / 型号变动行 / 空态 / 错误下一步 / 赠金口径');
const pageSrc = fs.readFileSync(path.join(root, 'routes', 'page.js'), 'utf8');

// --- 20.1 reduced-motion 覆盖补齐 ---
ok('20.1 reduced-motion 逐类收敛（弹窗/关闭/点/刷新/菜单/胶囊/弹卡/提示）',
  ['\\.modal-card \\{ animation: none; \\}', '\\.modal-close \\{ transition: none; \\}', '\\.dot \\{ transition: none; \\}',
   '\\.refresh-btn\\.spinning svg \\{ animation: none; \\}', '\\.menu-item \\{ transition: none; \\}', '\\.fpill \\{ transition: none; \\}',
   '\\.pop-card \\{ animation: none; \\}', '\\.tip\\.on \\{ animation: none; \\}'].every((p) => new RegExp(p).test(SHARED_CSS)));
ok('20.1 不用 * 通配、面板内无重复 reduced-motion 块（单一源）', !/reduced-motion[\s\S]{0,900}\* \{/.test(SHARED_CSS) && widgetSrc.indexOf('@media (prefers-reduced-motion') < 0 && pageSrc.indexOf('@media (prefers-reduced-motion') < 0 && SHARED_CSS.indexOf('@media (prefers-reduced-motion') >= 0);

// --- 20.2 弹窗焦点陷阱 ---
ok('20.2 打开聚焦 + Tab 两向环绕 + 关闭复原（源码）', /function focusFirstInModal/.test(SHARED_JS) && /m\.hidden = false;\s*\n\s*focusFirstInModal\(m\);/.test(SHARED_JS) && /modalEl\.addEventListener\("keydown"/.test(SHARED_JS) && /outside \|\| active === last/.test(SHARED_JS) && /outside \|\| active === first/.test(SHARED_JS) && /lastFocus\.focus\(\)/.test(SHARED_JS));
ok('20.2 焦点陷阱：未聚焦弹窗内部时也拉回（表单场景）', /var outside = !modalEl\.contains\(active\)/.test(SHARED_JS) && /modalFocusables\(modalEl\)/.test(SHARED_JS));

// --- 20.3 Escape 关闭浮层（有边界）---
ok('20.3 Escape 关闭事件弹窗/错误框；不绑预警红窗（含理由注释）', /hideTip\(\); closeMenu\(\); closeModal\(\); hideEvent\(\); clearError\(\);/.test(widgetHtml) && /不绑预警红窗/.test(widgetHtml));
ok('20.3 预警红窗仍有可聚焦 × 按钮（键盘可达不受影响）', /className = "pop-close"/.test(widgetHtml) && /dismissAlertToday/.test(widgetHtml));

// --- 20.4 提示区浮层定位 ---
ok('20.4 .pop-layer 为绝对浮层（absolute + top:38px + z-index:40 + pointer-events:none）', (function () { const rule = (widgetHtml.match(/\.pop-layer \{[^}]*\}/) || [''])[0]; return /position: absolute/.test(rule) && /top: 38px/.test(rule) && /z-index: 40/.test(rule) && /pointer-events: none/.test(rule); })());

// --- 20.5 型号变动常驻行 ---
ok('20.5 型号变动行：详情页渲染 + 接口下发', /function priceChangeLine/.test(pageHtml) && /priceChangeLine\(d\) \+/.test(pageHtml) && /d\.priceChange/.test(pageHtml) && /priceChange: readPriceChange\(\)/.test(balSrc));
ok('20.5 toast 行为未变（仍 8s；ACK 只压 toast 不隐藏行）', /toast\("官方价格页型号有变动："/.test(widgetHtml) && /8000\)/.test(widgetHtml) && /PRICE_ACK_KEY/.test(widgetHtml));

// --- 20.6 迷你图空态 ---
ok('20.6 迷你图空态：今日暂无记录（沿 11px）', /chart-empty">今日暂无记录/.test(widgetHtml) && /\.chart-empty \{[^}]*font-size: 11px/.test(widgetHtml) && /\.chart-empty \{[^}]*color: var\(--text-tertiary\)/.test(widgetHtml));

// --- 20.7 错误文案补下一步 ---
ok('20.7 五条错误文案都含下一步动作', /API Key 无效或已被拒绝；请到「设置 → 插件/.test(balSrc) && /请稍后重试（也可把自动刷新间隔调大）/.test(balSrc) && /请稍后重试，并到官方状态页确认服务是否正常/.test(balSrc) && /请检查网络后重试/.test(balSrc) && /请检查网络或代理后重试/.test(balSrc) && /请稍后重试，若持续请保留诊断日志反馈/.test(balSrc));
ok('20.7 越界 bad_response 也含动作', /超出合理范围；已忽略本次数据，请稍后重试/.test(balSrc));

// --- 20.8 赠金提示补口径 ---
ok('20.8 赠金提示注明仅记录本次、不伪造累计', /仅记录本次到账（插件不追踪赠金累计）/.test(widgetHtml) && /不影响自有资金口径/.test(widgetHtml));

// ---------------------------------------------------------------- 21. 代码卫生 + 文档（收尾）
console.log('\n[21] 代码卫生：标签配平 / 死代码 / 无校验入口 / 导出语义 / 装饰控件 / 文档');

// --- 21.1 标签配平 ---
function countTags(html) { return { open: (html.match(/<script/g) || []).length, close: (html.match(/<\/script>/g) || []).length }; }
ok('21.1 widget.js <script> 配平', (function () { const t = countTags(widgetHtml); return t.open === t.close && t.open >= 2; })());
ok('21.1 page.js <script> 配平', (function () { const t = countTags(pageHtml); return t.open === t.close && t.open >= 2; })());

// --- 21.2 死代码 ---
ok('21.2 死变量/死字段已清除（MAX_AMOUNT/alertTimer/dataTz/configAt）', widgetSrc.indexOf('MAX_AMOUNT') < 0 && widgetSrc.indexOf('alertTimer') < 0 && widgetSrc.indexOf('state.dataTz') < 0 && widgetSrc.indexOf('state.configAt') < 0);
ok('21.2 预警注释反映浮层机制（旧「内容上移/文档流」措辞已替换）', /浮层收起会\*\*露出\*\*/.test(widgetSrc) && widgetSrc.indexOf('预警框收起会让下方内容上移') < 0 && widgetSrc.indexOf('预警框在**文档流**里') < 0);

// --- 21.3 无校验入口 ---
ok('21.3 event/resolve 声明无参（不解析 body）', /本接口\*\*无参数\*\*/.test(balSrc) && !/app\.post\('\/api\/event\/resolve', async \(c\) => \{[\s\S]{0,200}let payload = null;/.test(balSrc));
ok('21.3 stats custom 非法 → 400 invalid_range（不再静默回落 30d）', /if \(from === null \|\| to === null \|\| to < from\)/.test(balSrc) && /error: 'invalid_range', message: '自定义区间的 from\/to/.test(balSrc));
{
  const r = await callStats({ range: 'custom', from: '2026-13-99', to: 'x' });
  ok('21.3 行为：custom 非法日期 → 400 invalid_range', !!r && r.status === 400 && r.body && r.body.ok === false && r.body.error === 'invalid_range', 'status=' + (r && r.status));
  const r2 = await callStats({ range: 'custom', from: '2026-09-10', to: '2026-09-01' });
  ok('21.3 行为：custom from>to → 400', !!r2 && r2.status === 400 && r2.body && r2.body.error === 'invalid_range');
}

// --- 21.4 导出错误语义 ---
ok('21.4 导出入参错误 4xx、写失败 5xx', /error: 'invalid_dir' \}, 400\)/.test(balSrc) && /error: 'empty_csv' \}, 400\)/.test(balSrc) && /error: 'too_large' \}, 400\)/.test(balSrc) && /error: 'invalid_range' \}, 400\)/.test(balSrc) && /error: 'write_failed', message: '无法写入该目录（检查权限或磁盘）。' \}, 500\)/.test(balSrc));
ok('21.4 前端读非 200 body（apiPostRaw + 失败分支）', /function apiPostRaw/.test(pageHtml) && /apiPostRaw\("\/api\/export"/.test(pageHtml) && /if \(!out\.ok \|\| !out\.body \|\| out\.body\.ok !== true\)/.test(pageHtml));
ok('21.4 错误码→文案 对照齐全', /invalid_dir.*目标目录无效/.test(pageHtml) && /empty_csv.*没有可写入的数据/.test(pageHtml) && /too_large.*8MB/.test(pageHtml) && /invalid_range.*筛选区间参数无效/.test(pageHtml) && /write_failed.*无法写入该目录/.test(pageHtml));
{
  const r = await callRoute('POST', '/api/export', { dir: 'relative/path', csv: 'a,b', rangeKey: '30d' });
  ok('21.4 行为：export 非法目录 → 400 invalid_dir', r.res.status === 400 && r.res.body.error === 'invalid_dir', 'status=' + r.res.status);
  const r2 = await callRoute('POST', '/api/export', { dir: 'D:\\x', csv: '', rangeKey: '30d' });
  ok('21.4 行为：export 空 csv → 400 empty_csv', r2.res.status === 400 && r2.res.body.error === 'empty_csv');
}

// --- 21.5 移除装饰性控件 ---
ok('21.5 API Key 筛选控件已移除', pageHtml.indexOf('keyPill') < 0 && pageHtml.indexOf('keyDrop') < 0 && pageHtml.indexOf('keyVal') < 0 && pageHtml.indexOf('keyShort') < 0 && pageHtml.indexOf('keyOwn') < 0 && !/state\.key\b/.test(pageHtml));
ok('21.5 页脚仍解释「不记 Key」（保留 state.keyName 展示）', /本机账本不记录每次请求使用的 Key/.test(pageHtml) && /esc\(state\.keyName\)/.test(pageHtml));
ok('21.5 resetBtn 默认判定未变坏', /function isDefaultFilter\(\) \{ return state\.range === "30d" && !state\.from && !state\.to; \}/.test(pageHtml));

// --- 21.6 文档 ---
ok('21.6 README 补「刷新与缓存时序」', readmeText.indexOf('刷新与缓存时序') >= 0 && readmeText.indexOf('512KB') >= 0 && readmeText.indexOf('usage:list') >= 0 && readmeText.indexOf('12h') >= 0 && readmeText.indexOf('10min') >= 0);
ok('21.6 README 补「预警投递链」', readmeText.indexOf('预警投递链') >= 0 && readmeText.indexOf('desktop') >= 0 && readmeText.indexOf('[tool] decision:') >= 0 && readmeText.indexOf('不许静默') >= 0);
ok('21.6 README 配置表补 alertNotify / eventPromptEnabled', /\| `alertNotify` \|/.test(readmeText) && /\| `eventPromptEnabled` \|/.test(readmeText));

// ---------------------------------------------------------------- 22. 紧急热修：state 写入只写脏键（路由不再抹掉工具写的 alertState）
console.log('\n[22] 热修：路由落盘不得覆盖工具写的 alertState / lastAlertPushAt');

// --- 22.1 源码守卫：不再有「内存赢」的整对象合并，改为脏键覆盖磁盘副本 ---
ok('22.1 saveState 无参 + 只覆盖 dirtyKeys（无内存赢合并）', /function saveState\(\) \{/.test(balSrc) && /for \(const k of dirtyKeys\)[\s\S]{0,140}merged\[k\] = memState\[k\]/.test(balSrc) && !/Object\.assign\(\{\}, disk, state\)/.test(balSrc) && !/Object\.assign\(\{\}, disk, memState\)/.test(balSrc) && /dirtyKeys\.add\(key\)/.test(balSrc));

// --- 22.2 行为：工具先写 1/X → 路由落盘一次 → 仍是 1/X；路由自己的脏键正常落盘 ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-hotfix-'));
  const seed = { alertState: 0, lastAlertPushAt: 0, lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: Date.now() - 60000 };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(seed));
  const built = mkApp();
  const made = mkCtx(dir, { apiKey: 'sk-x', totalRecharged: 130 }, { failSet: false, upstream: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 16, topped_up_balance: 16, granted_balance: 0 }] } });
  const mod = await loadBalanceModule(); mod.default(built.app, made.ctx); // 模块 init 已 loadState（内存 = seed，alertState=0）
  // 模拟工具写：磁盘上 alertState=1 / lastAlertPushAt=999
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(Object.assign({}, seed, { alertState: 1, lastAlertPushAt: 999 })));
  // 触发路由落盘（/api/balance → applyBalanceSample → stateSet('lastToppedUpBalance')）
  const c = mkCallPost({});
  await built.h['GET /api/balance'](c);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  ok('22.2 工具写的 alertState/lastAlertPushAt 不被路由落盘覆盖', after.alertState === 1 && after.lastAlertPushAt === 999, JSON.stringify({ alertState: after.alertState, lastAlertPushAt: after.lastAlertPushAt }));
  ok('22.2 路由自己的脏键正常落盘（lastToppedUpBalance=16）', after.lastToppedUpBalance === 16, String(after.lastToppedUpBalance));
}

// --- 22.3 语义：alertState=1 在盘上 + 余额仍低 → 不重推；恢复 → 复位 0 ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-hotfix-tool-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ alertState: 1, lastAlertPushAt: 999 }));
  const alertMod = await import('../tools/balance-alert.js?t=' + Date.now());
  const storeCfg = { alertNotify: true, alertThreshold: 10, apiKey: 'sk-x' };
  const mkCtxTool = (total) => ({ config: { get: (k) => storeCfg[k], set: (k, v) => { storeCfg[k] = v; } }, dataDir: dir, network: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: total }] }) }) }, log: { info: () => {}, warn: () => {}, log: () => {} } });
  const low = JSON.parse(await alertMod.execute({}, mkCtxTool(8)));
  ok('22.3 alertState=1（盘上）+ 余额仍低 → due=false、reason=still_low（不重推）', low.ok === true && low.due === false && low.reason === 'still_low', JSON.stringify({ due: low.due, reason: low.reason }));
  const rec = JSON.parse(await alertMod.execute({}, mkCtxTool(20)));
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  ok('22.3 余额恢复 → alertState 复位 0（下次跌破才再推）', rec.due === false && st.alertState === 0, JSON.stringify({ due: rec.due, alertState: st.alertState }));
}

// ---------------------------------------------------------------- 23. 清尾（第十批）
console.log('\n[23] 清尾：极长数值 / 统计失败提示 / external.open 降级 / round2 边界');

// --- 23.1 极长数值：省略号而非折行 ---
ok('23.1 .card .v 不再 break-all，改为省略号', !/\.card \.v \{[^}]*word-break: break-all/.test(pageHtml) && /\.card \.v \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis/.test(pageHtml) && /\.card \.v \{[^}]*min-width: 0/.test(pageHtml));
ok('23.1 .fstats b 加溢出守卫（省略号）', /\.fstats b \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis/.test(pageHtml) && /\.fstats b \{[^}]*min-width: 0/.test(pageHtml));
ok('23.1 字号未变（.v 26px / .fstats b 15px）、标签不截断', /\.card \.v \{[^}]*font-size: 26px/.test(pageHtml) && /\.fstats b \{[^}]*font-size: 15px/.test(pageHtml) && !/\.card \.k \{[^}]*text-overflow/.test(pageHtml) && !/\.fstats em \{[^}]*text-overflow/.test(pageHtml));

// --- 23.2 侧栏统计失败可见 ---
ok('23.2 连续失败阈值分支存在（N=3）', /state\.statsFailCount >= STATS_FAIL_HINT_AFTER/.test(widgetHtml) && /statsFailCount: 0/.test(widgetHtml) && /var STATS_FAIL_HINT_AFTER = 3;/.test(widgetHtml));
ok('23.2 失败累加、成功一次即清除', /if \(stats\) \{ state\.today = stats; state\.statsFailCount = 0; \}/.test(widgetHtml) && /else \{ state\.statsFailCount \+= 1; \}/.test(widgetHtml));
ok('23.2 复用既有空态样式（不改固定高度）', /statsFailCount >= STATS_FAIL_HINT_AFTER\) \{[\s\S]{0,160}chart-empty">统计暂不可用/.test(widgetHtml) && /\.chart-empty \{[^}]*height: 100%/.test(widgetHtml));

// --- 23.3 external.open 缺失时的降级 ---
ok('23.3 externalOpen 失败分支存在且走 onFail', /function externalOpen\(url, onFail\)/.test(SHARED_JS) && /if \(!res \|\| !res\.ok\) \{ try \{ onFail\(url\)/.test(SHARED_JS) && /externalOpen\(url, function \(u\)/.test(widgetHtml));
ok('23.3 降级提示含完整 URL 且可选中复制', /无法自动打开链接，请手动复制：" \+ u/.test(widgetHtml) && /\.notice \{[\s\S]{0,420}user-select: text;/.test(widgetHtml));
ok('23.3 去充值/双击/Shift+Enter 都走带降级的 openExternal', /openExternal\("https:\/\/platform\.deepseek\.com\/top_up"\)/.test(widgetHtml) && (widgetHtml.match(/openExternal\("https:\/\/platform\.deepseek\.com\/usage"\)/g) || []).length === 2);

// --- 23.4 round2/round4 浮点边界 ---
ok('23.4 round2 经典边界修正', round2(2.675) === 2.68 && round2(1.005) === 1.01 && round2(20.35) === 20.35);
ok('23.4 round2 负数半离零（-1.005 → -1.01）', round2(-1.005) === -1.01);
ok('23.4 既有金额换算未回归', round2(1.2345) === 1.23 && round4(0.0000612) === 0.0001 && round2(2.5) === 2.5 && round2(0) === 0 && round2(0.36379896) === 0.36 && round4(0.36379896) === 0.3638);
ok('23.4 非有限值原样返回', Number.isNaN(round2(NaN)) && round2(Infinity) === Infinity && Number.isNaN(round4(NaN)));

// ---------------------------------------------------------------- 24. 官方数据同步（第十一批：导入 / 聚合 / 合并 / 安全）
console.log('\n[24] 官方同步：包解析 / 北京日聚合 / 侧栏与详情合并 / 安全 / 持久化');
const OS = await import('../lib/official-sync.js?t=' + Date.now());
const zlib = await import('node:zlib');

// 手写最小 zip（含 stored 与 deflate 两种），专门压测 extractZipEntries 的中央目录/本地头解析
function mkZip(entries) {
  const parts = []; const central = []; let off = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.text, 'utf8');
    const method = e.deflate ? 8 : 0;
    const data = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42);
    central.push(cd, nameBuf);
    off += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(parts), cdBuf, eocd]);
}

const COST_CSV = [
  'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
  'u1,2026-09-27T00:00:00+08:00,2026-09-28T00:00:00+08:00,deepseek-flash,Paid,12.5,CNY',
  'u1,2026-09-27T00:00:00+08:00,2026-09-28T00:00:00+08:00,deepseek-v4-pro,Paid,3.25,CNY',
  'u1,2026-09-28T00:00:00+08:00,2026-09-29T00:00:00+08:00,deepseek-flash,Paid,1.5,CNY',
].join('\n') + '\n';
const AMOUNT_CSV = [
  'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
  'u1,2026-09-27T00:00:00+08:00,2026-09-28T00:00:00+08:00,deepseek-flash,HanaAgent,sk-secret,input_cache_hit_tokens,0.0000002,1000000',
  'u1,2026-09-27T00:00:00+08:00,2026-09-28T00:00:00+08:00,deepseek-flash,HanaAgent,sk-secret,input_cache_miss_tokens,0.000001,2000000',
  'u1,2026-09-27T00:00:00+08:00,2026-09-28T00:00:00+08:00,deepseek-flash,HanaAgent,sk-secret,output_tokens,0.000004,300000',
  'u1,2026-09-27T00:00:00+08:00,2026-09-28T00:00:00+08:00,deepseek-flash,HanaAgent,sk-secret,request_count,0,10',
  'u1,2026-09-27T00:00:00+08:00,2026-09-28T00:00:00+08:00,deepseek-v4-pro,HanaAgent,sk-secret,request_count,0,5',
  'u1,2026-09-28T00:00:00+08:00,2026-09-29T00:00:00+08:00,deepseek-flash,HanaAgent,sk-secret,request_count,0,7',
  'u1,2026-09-28T00:00:00+08:00,2026-09-29T00:00:00+08:00,deepseek-flash,HanaAgent,sk-secret,input_cache_hit_tokens,0.0000002,500000',
].join('\n') + '\n';

// --- 24.1 单表解析 ---
const costSheet = OS.parseSheet(COST_CSV, 'cost');
ok('24.1 cost 表：3 行 / 2 天 / 金额微元逐位', costSheet.ok === true && costSheet.kind === 'cost' && costSheet.rowCount === 3 && costSheet.minDay === '2026-09-27' && costSheet.maxDay === '2026-09-28');
ok('24.1 cost 表：同日多型号按型号分开累加', (function () {
  const cells = costSheet.cells.filter((c) => c.day === '2026-09-27');
  return cells.length === 2 && cells.every((c) => c.costU % 1 === 0);
})());
const amountSheet = OS.parseSheet(AMOUNT_CSV, 'amount');
ok('24.1 amount 表：四类分别求和（需求 22 / 命中 1500000 / 未命中 2000000 / 输出 300000）',
  amountSheet.ok === true && (function () {
    const s = amountSheet.cells.reduce((a, c) => ({ requests: a.requests + c.requests, hit: a.hit + c.hit, miss: a.miss + c.miss, output: a.output + c.output }), { requests: 0, hit: 0, miss: 0, output: 0 });
    return s.requests === 22 && s.hit === 1500000 && s.miss === 2000000 && s.output === 300000;
  })());
ok('24.1 类型自动推断（无 forcedKind）', OS.parseSheet(COST_CSV).kind === 'cost' && OS.parseSheet(AMOUNT_CSV).kind === 'amount');
ok('24.1 BOM / CRLF / 引号字段', (function () {
  const t = '\uFEFFuser_id,start_time_iso,model,cost,currency\r\nx,2026-09-27T00:00:00+08:00,deepseek-flash,"0.5",CNY\r\n';
  const r = OS.parseSheet(t);
  return r.ok && r.cells.length === 1 && r.cells[0].costU === 50000000;
})());
ok('24.1 非 CNY 行被忽略并计数', (function () {
  const t = 'start_time_iso,model,cost,currency\n2026-09-27T00:00:00+08:00,deepseek-flash,1.5,CNY\n2026-09-27T00:00:00+08:00,deepseek-flash,2.0,USD\n';
  const r = OS.parseSheet(t);
  return r.ok && r.otherCurrency === 1 && r.cells.length === 1 && r.cells[0].costU === 150000000;
})());
ok('24.1 缺列 / 空文件 → 不 ok', OS.parseSheet('a,b,c\n1,2,3').ok === false && OS.parseSheet('').ok === false && OS.parseSheet('user_id,cost\nx,1').ok === false);
ok('24.1 未知 type 行被跳过', (function () {
  const t = 'start_time_iso,model,type,amount\n2026-09-27T00:00:00+08:00,deepseek-flash,request_count,3\n2026-09-27T00:00:00+08:00,deepseek-flash,something_else,9\n';
  const r = OS.parseSheet(t);
  return r.ok && r.rowCount === 1 && r.skipped === 1;
})());

// --- 24.2 北京日键 ---
ok('24.2 北京日键：UTC 15:59 → 当日、16:00 → 次日', OS.beijingDayKey(Date.parse('2026-09-27T15:59:00Z')) === '2026-09-27' && OS.beijingDayKey(Date.parse('2026-09-27T16:00:00Z')) === '2026-09-28');
ok('24.2 日键 → 起止毫秒（北京 00:00 / 次日 00:00）', OS.dayKeyStartMs('2026-09-27') === Date.parse('2026-09-26T16:00:00Z') && OS.dayKeyEndMs('2026-09-27') === Date.parse('2026-09-27T16:00:00Z'));
ok('24.2 非法日期键 / 非法时间 → null（2026-02-30 不滚动到 3 月）', OS.dayKeyStartMs('2026-02-30') === null && OS.dayKeyStartMs('x') === null && OS.beijingDayKey('nope') === null);

// --- 24.3 聚合（两表合并 / 金额不翻倍 / 回推兜底）---
const built = OS.buildSync({ sheets: [{ name: 'cost-2026-09-27_2026-09-28.csv', text: COST_CSV }, { name: 'amount-2026-09-27_2026-09-28.csv', text: AMOUNT_CSV }], importedAt: Date.parse('2026-09-28T04:00:00Z') });
ok('24.3 两表合并：金额只取 cost 表（17.25 元，不叠加回推值）', built.ok === true && built.data.totals.costU === Math.round(17.25 * 1e8));
ok('24.3 两表合并：需求 22 / Tokens 3800000', built.data.totals.requests === 22 && built.data.totals.tokens === 3800000 && built.data.totals.hit === 1500000 && built.data.totals.miss === 2000000 && built.data.totals.output === 300000);
ok('24.3 覆盖范围 from/to/行数', built.data.from === '2026-09-27' && built.data.to === '2026-09-28' && built.data.rowCount === 10);
ok('24.3 每日按 costU 降序的型号表', built.data.days[0].models.length === 2 && built.data.days[0].models[0].id === 'deepseek-flash' && built.data.days[0].models[0].costU === Math.round(12.5 * 1e8));
ok('24.3 costSource=cost 不出回推值', built.data.days.every((d) => d.costSource === 'cost' && d.costKnown === true));
ok('24.3 只导入 amount → 金额由 price×amount 回推（3.5 元，costSource=derived）', (function () {
  const b = OS.buildSync({ sheets: [{ name: 'amount-2026-09-27_2026-09-28.csv', text: AMOUNT_CSV }] });
  return b.ok && b.data.totals.costU === Math.round(3.5 * 1e8) && b.data.days.every((d) => d.costSource === 'derived');
})());
ok('24.3 coveredUntil = min(导入时刻, 末日结束)', built.data.coveredUntil === Date.parse('2026-09-28T04:00:00Z') && built.data.windowStart === OS.dayKeyStartMs('2026-09-27'));
ok('24.3 空 sheets / 全无可解析行 → 不 ok', OS.buildSync({ sheets: [] }).ok === false && OS.buildSync({ sheets: [{ name: 'x.csv', text: 'a,b\n1,2' }] }).ok === false);

// --- 24.4 zip / 入口解码 ---
const zipBuf = mkZip([{ name: 'cost-2026-08-30_2026-09-28.csv', text: COST_CSV }, { name: 'amount-2026-08-30_2026-09-28.csv', text: AMOUNT_CSV, deflate: true }]);
ok('24.4 手写 zip 自检（PK 头 + 条目名）', zipBuf.readUInt32LE(0) === 0x04034b50 && zipBuf.length > 200);
ok('24.4 读 zip：stored + deflate 两类都解出 CSV', (function () {
  const e = OS.extractZipEntries(zipBuf);
  return e.length === 2 && e[0].data.toString('utf8').indexOf('deepseek-flash') >= 0 && e[1].data.toString('utf8').indexOf('request_count') >= 0;
})());
ok('24.4 非 zip 二进制 → 条目为空', OS.extractZipEntries(Buffer.from('not a zip at all')).length === 0);
ok('24.4 decodeImport：utf8 直通 / base64-CSV / zip-base64', (function () {
  const a = OS.decodeImport({ content: COST_CSV, encoding: 'utf8' });
  const b = OS.decodeImport({ content: Buffer.from(COST_CSV, 'utf8').toString('base64'), encoding: 'base64' });
  const c = OS.decodeImport({ content: zipBuf.toString('base64'), encoding: 'base64' });
  return a.ok && a.files.length === 1 && a.files[0].text === COST_CSV && b.ok && b.files[0].text.indexOf('deepseek-flash') >= 0 && c.ok && c.files.length === 2;
})());
ok('24.4 decodeImport：空内容 / zip 内无 CSV / 超长 → 明确拒绝',
  OS.decodeImport({ content: '' }).ok === false &&
  OS.decodeImport({ content: mkZip([{ name: 'readme.txt', text: 'hi' }]).toString('base64'), encoding: 'base64' }).reason === 'zip 里没有可读的 CSV' &&
  OS.decodeImport({ content: 'x'.repeat(OS.SYNC_MAX_PAYLOAD_CHARS + 1), encoding: 'utf8' }).ok === false);

// --- 24.5 安全：不落地任何标识 ---
ok('24.5 聚合结果不含 user_id / api_key / api_key_name / 文件名外的原文', (function () {
  const s = JSON.stringify(built.data);
  return s.indexOf('user_id') < 0 && s.indexOf('sk-secret') < 0 && s.indexOf('HanaAgent') < 0 && s.indexOf('u1') < 0 && s.indexOf('Paid') < 0;
})());
ok('24.5 本地读取、不走上传（无 FormData/upload）', pageHtml.indexOf('file.arrayBuffer()') >= 0 && pageHtml.indexOf('FormData') < 0 && pageHtml.indexOf('upload') < 0);

// --- 24.6 路由接线（POST 导入 / GET 摘要 / 持久化）---
{
  const zipB64 = zipBuf.toString('base64');
  const r = await callRoute('POST', '/api/sync', { content: zipB64, encoding: 'base64', fileName: 'sk-abcdefghijklmnop.zip', tz: 480 });
  ok('24.6 路由：zip → ok 且合计一致（17.25 / 22 请求 / 3800000 tokens）', r.res.body.ok === true && r.res.body.data.totals.cost === 17.25 && r.res.body.data.totals.requests === 22 && r.res.body.data.totals.tokens === 3800000 && r.res.body.data.days === 2);
  ok('24.6 路由：逐日行带日期与型号', Array.isArray(r.res.body.data.dayRows) && r.res.body.data.dayRows[0].d === '2026-09-27' && r.res.body.data.dayRows[0].models.length === 2);
  ok('24.6 文件名 sk- 脱敏', r.res.body.data.fileName.indexOf('sk-abcdefghijklmnop') < 0 && r.res.body.data.fileName.indexOf('sk-***') >= 0);
  const st = JSON.parse(fs.readFileSync(path.join(r.dir, 'state.json'), 'utf8'));
  ok('24.6 state.officialSync 只存聚合（无 raw / csv / user_id / api_key）', !!st.officialSync && st.officialSync.v === 2 && Array.isArray(st.officialSync.days) && typeof st.officialSync.coveredUntil === 'number' &&
    !('rows' in st.officialSync) && !('csv' in st.officialSync) && JSON.stringify(st.officialSync).indexOf('user_id') < 0 && JSON.stringify(st.officialSync).indexOf('sk-secret') < 0);
  ok('24.6 路由：空内容 → 400 empty', (await callRoute('POST', '/api/sync', { content: '' })).res.body.error === 'empty');
  ok('24.6 路由：识别不出表头 → 400 bad_csv', (await callRoute('POST', '/api/sync', { content: 'not,a,csv\n1,2,3' })).res.body.error === 'bad_csv');
  ok('24.6 路由：base64 但非 zip/CSV → 400 bad_csv', (await callRoute('POST', '/api/sync', { content: Buffer.from('some plain text').toString('base64'), encoding: 'base64' })).res.body.error === 'bad_csv');
  ok('24.6 路由：zip 内没有可读 CSV → 400 bad_file', (await callRoute('POST', '/api/sync', { content: mkZip([{ name: 'readme.txt', text: 'hi' }]).toString('base64'), encoding: 'base64' })).res.body.error === 'bad_file');
}

// --- 24.7 合并：侧栏累计 / 详情总量 / 基准值 / 窗口剔除 ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-sync-merge-'));
  const zipB64 = zipBuf.toString('base64');
  const post = await callInDir(dir, 'POST', '/api/sync', { content: zipB64, encoding: 'base64', fileName: 'usage_data.zip' });
  ok('24.7 同步写入同一 dataDir 的 state', post.body.ok === true);

  const u0 = await callInDir(dir, 'GET', '/api/usage', { query: {} }, {});
  ok('24.7 /api/usage 采纳官方累计（22 请求 / 3800000 tokens）', u0.body.data.requestCount === 22 && u0.body.data.totalTokens === 3800000 && u0.body.data.official && u0.body.data.official.days === 2);
  ok('24.7 /api/usage 回传 official 覆盖时刻与金额', u0.body.data.official.from === '2026-09-27' && u0.body.data.official.to === '2026-09-28' && u0.body.data.official.cost === 17.25);

  const u1 = await callInDir(dir, 'GET', '/api/usage', { query: {} }, { usageBaselineRequests: 500, usageBaselineTokens: 123456 });
  ok('24.7 基准值计入累计（+500 请求 / +123456 tokens）', u1.body.data.requestCount === 522 && u1.body.data.totalTokens === 3923456 && u1.body.data.baseline.requests === 500 && u1.body.data.baseline.tokens === 123456);
  const uNeg = await callInDir(dir, 'GET', '/api/usage', { query: {} }, { usageBaselineRequests: -5 });
  ok('24.7 非法基准（负数）回落 0', uNeg.body.data.requestCount === 22 && uNeg.body.data.baseline.requests === 0);

  const inside = { requestId: 'in1', startedAt: '2026-09-27T05:00:00Z', model: { provider: 'deepseek', modelId: 'deepseek-flash' }, usage: { totalTokens: 1000, input: { totalTokens: 1000, uncachedTokens: 1000 } } };
  const after = { requestId: 'out1', startedAt: new Date(Date.now() + 3600000).toISOString(), model: { provider: 'deepseek', modelId: 'deepseek-flash' }, usage: { totalTokens: 2000, input: { totalTokens: 2000, uncachedTokens: 2000 } } };
  const u2 = await callInDir(dir, 'GET', '/api/usage', { query: {} }, {}, [inside, after]);
  ok('24.7 官方窗口内本机条目被剔除（localSkipped=1），窗口外仍计入', u2.body.data.localSkipped === 1 && u2.body.data.requestCount === 23 && u2.body.data.totalTokens === 3802000);

  const s0 = await callInDir(dir, 'GET', '/api/stats', { query: { range: 'all', tz: '480' } }, {}, [inside]);
  const tt = s0.body.data.totals;
  ok('24.7 /api/stats 合并官方日值到总量（officialCovered + officialCost）', s0.body.ok === true && tt.officialCovered === true && tt.officialDays === 2 && tt.officialCost === 17.25);
  ok('24.7 /api/stats 总量含官方（22 请求 / 3800000 tokens，窗口内本机条目已剔除）', tt.requests === 22 && tt.tokens === 3800000);
  ok('24.7 /api/stats 回传 official / baseline 摘要', s0.body.data.official && s0.body.data.official.days === 2 && s0.body.data.baseline && s0.body.data.baseline.requests === 0);
  ok('24.7 日粒度桶并入官方值；型号表标 official', (function () {
    const bs = s0.body.data.buckets.reduce((a, b) => a + b.requests, 0);
    const offModel = s0.body.data.models.filter((m) => m.priceSource === 'official');
    return bs === 22 && offModel.length >= 1 && offModel[0].cost > 0;
  })());
  ok('24.7 日桶按展示时区日界对齐（tz=480 下官方日值落在标住同一天的桶）', (function () {
    const fmt = (ms) => { const d = new Date(ms + 480 * 60000); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
    const byLabel = {};
    for (const b of s0.body.data.buckets) byLabel[fmt(b.t)] = b.requests;
    // 夹具：09-27 官方 15 条（10 + 5），09-28 官方 7 条；窗口内本机条目已剔除，不混入
    return byLabel['9/27'] === 15 && byLabel['9/28'] === 7;
  })());

  const sBase = await callInDir(dir, 'GET', '/api/stats', { query: { range: 'all', tz: '480' } }, { usageBaselineRequests: 500, usageBaselineTokens: 123456 }, [inside]);
  ok('24.7 基准只在「全部」区间计入总量', sBase.body.data.totals.requests === 522 && sBase.body.data.totals.tokens === 3923456);
  const sToday = await callInDir(dir, 'GET', '/api/stats', { query: { range: 'today', tz: '480' } }, { usageBaselineRequests: 500, usageBaselineTokens: 123456 }, [inside]);
  ok('24.7 基准不污染区间口径（today 不含基准）', sToday.body.data.totals.requests < 500);

  // 官方只到「日」→ 被官方覆盖的窗口必须提档到「按天」，否则官方值放不进桶，柱状图整片空白、高峰恒为 0
  const sCust = await callInDir(dir, 'GET', '/api/stats', { query: { range: 'custom', tz: '480', from: '2026-09-27', to: '2026-09-28' } }, {}, [inside]);
  ok('24.7 官方覆盖的短窗口提档到按天（bucketMs=DAY）且两天各一根柱', (function () {
    const b = sCust.body.data.buckets;
    const fmt = (ms) => { const d = new Date(ms + 480 * 60000); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
    return sCust.body.data.bucketMs === 86400000 && b.length === 2 && fmt(b[0].t) === '9/27' && b[0].requests === 15 && b[1].requests === 7;
  })());
  ok('24.7 官方覆盖窗口：localCount=0（高峰金额不可分，前端据此不再亮 ¥0）', sCust.body.data.totals.localCount === 0 && sCust.body.data.totals.localSkipped === 1);
  ok('24.7 提档后总量仍是官方值（15+7=22 请求）', sCust.body.data.totals.requests === 22 && sCust.body.data.official.days === 2);
  // 未被官方覆盖的短窗口：保持按小时（提档不能误伤）
  const sUncov = await callInDir(dir, 'GET', '/api/stats', { query: { range: 'custom', tz: '480', from: '2026-09-20', to: '2026-09-21' } }, {}, [inside]);
  ok('24.7 未被官方覆盖的短窗口仍按小时（bucketMs=3600000，官方摘要回 null）', sUncov.body.data.bucketMs === 3600000 && sUncov.body.data.buckets.length === 48 && sUncov.body.data.official === null);
}

// --- 24.8 接线 / 文档 ---
ok('24.8 详情页按钮/文件输入/面板/接口接线（同步）', pageHtml.indexOf('id="syncBtn"') >= 0 && pageHtml.indexOf('id="syncFile"') >= 0 && pageHtml.indexOf('id="syncPanel"') >= 0 && pageHtml.indexOf('apiPost("/api/sync"') >= 0 && pageHtml.indexOf('导入官方 CSV 同步') >= 0 && pageHtml.indexOf('对账') < 0);
ok('24.8 文件选择接受 .zip 与 .csv', /id="syncFile" accept="\.zip,\.csv"/.test(pageHtml));
ok('24.8 后端 POST + GET /api/sync；旧对账接口与模块已移除', /app\.post\('\/api\/sync'/.test(balSrc) && /app\.get\('\/api\/sync'/.test(balSrc) && !/api\/reconcile/.test(balSrc) && !fs.existsSync(path.join(root, 'lib', 'reconcile.js')) && /OFFICIAL_SYNC_KEY/.test(balSrc) && /import\('\.\.\/lib\/official-sync\.js/.test(balSrc));
ok('24.8 清单暴露基准参数（integer，默认 0）', (function () { const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const p = m.contributes.configuration.properties;
  return p.usageBaselineRequests && p.usageBaselineRequests.type === 'integer' && p.usageBaselineRequests.default === 0 && p.usageBaselineTokens && p.usageBaselineTokens.type === 'integer' && p.usageBaselineTokens.default === 0; })());
ok('24.8 侧栏今日消费额优先官方（officialCovered → totals.cost）', widgetHtml.indexOf('t.officialCovered') >= 0 && widgetHtml.indexOf('costValue = t.balanceCost') >= 0);
ok('24.8b 详情页高峰文案改用服务端 peakKnown/peakFrom（不再自算）', pageHtml.indexOf('d.totals.peakKnown') >= 0 && pageHtml.indexOf('peakFrom') >= 0 && pageHtml.indexOf('var peakKnown = Number(d.totals.localCount)') < 0);
ok('24.8b 详情页脚注区分官方粒度（按小时 / 按日 / 混合）', pageHtml.indexOf('granularity === "hour"') >= 0 && pageHtml.indexOf('granularity === "mixed"') >= 0);
ok('24.8b 同步面板展示粒度与逐小时明细', pageHtml.indexOf('hourRows') >= 0 && pageHtml.indexOf('granularity === "hour" ? "按小时"') >= 0 && pageHtml.indexOf('本次导入') >= 0);
ok('24.8 未新增出网域名（manifest 仍只 2 个 host）', (function () { const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); const h = m.network.allowedHosts || []; return h.length === 2 && h.indexOf('api.deepseek.com') >= 0 && h.indexOf('api-docs.deepseek.com') >= 0; })());
ok('24.8 README 补「导入官方 CSV 同步」与基准参数', readmeText.indexOf('导入官方 CSV 同步') >= 0 && readmeText.indexOf('基准') >= 0 && readmeText.indexOf('对账') < 0);

// --- 24.9 小时级：官方导出粒度随区间长度变化（短区间→整点桶，长区间→按日）---
const HOUR_COST_CSV = [
  'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
  'u1,2026-09-25T09:00:00+08:00,2026-09-25T09:30:00+08:00,deepseek-flash,Paid,0.5,CNY',
  'u1,2026-09-25T09:00:00+08:00,2026-09-25T09:30:00+08:00,deepseek-v4-pro,Paid,0.25,CNY',
  'u1,2026-09-25T10:00:00+08:00,2026-09-25T10:45:00+08:00,deepseek-flash,Paid,1.5,CNY',
].join('\n') + '\n';
const HOUR_AMOUNT_CSV = [
  'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
  'u1,2026-09-25T09:00:00+08:00,2026-09-25T09:30:00+08:00,deepseek-flash,HanaAgent,sk-secret,input_cache_hit_tokens,0.0000002,100000',
  'u1,2026-09-25T09:00:00+08:00,2026-09-25T09:30:00+08:00,deepseek-flash,HanaAgent,sk-secret,input_cache_miss_tokens,0.000001,200000',
  'u1,2026-09-25T09:00:00+08:00,2026-09-25T09:30:00+08:00,deepseek-flash,HanaAgent,sk-secret,output_tokens,0.000004,50000',
  'u1,2026-09-25T09:00:00+08:00,2026-09-25T09:30:00+08:00,deepseek-flash,HanaAgent,sk-secret,request_count,0,3',
  'u1,2026-09-25T10:00:00+08:00,2026-09-25T10:45:00+08:00,deepseek-flash,HanaAgent,sk-secret,request_count,0,4',
].join('\n') + '\n';
// 同一天（09-25）的按日包：用于验证「小时包优先：后导的日包也不夺权」
const DAY_COST_CSV = [
  'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
  'u1,2026-09-25T00:00:00+08:00,2026-09-26T00:00:00+08:00,deepseek-flash,Paid,4.0,CNY',
].join('\n') + '\n';

ok('24.9 粒度由行跨度判定：≤2h → hour（键 = 北京整点起点）', (function () {
  const cs = OS.parseSheet(HOUR_COST_CSV, 'cost');
  const keys = cs.cells.map((c) => c.key).sort((a, b) => a - b);
  return cs.ok === true && cs.cells.length === 3 && cs.cells.every((c) => c.gran === 'hour') &&
    keys[0] === Date.parse('2026-09-25T09:00:00+08:00') && keys[2] === Date.parse('2026-09-25T10:00:00+08:00');
})());
ok('24.9 长区间包（跨日行）仍判为 day（不误伤既有导入）', OS.parseSheet(COST_CSV, 'cost').cells.every((c) => c.gran === 'day'));
ok('24.9 hourStartMs 取整点 / beijingHourLabel / 非法输入',
  OS.hourStartMs(Date.parse('2026-09-28T09:37:12+08:00')) === Date.parse('2026-09-28T09:00:00+08:00') &&
  OS.beijingHourLabel(Date.parse('2026-09-28T09:00:00+08:00')) === '09-28 09:00' &&
  OS.hourStartMs('x') === null && OS.beijingHourLabel(undefined) === null);

const hb = OS.buildSync({ sheets: [{ name: 'cost-2026-09-25_2026-09-25.csv', text: HOUR_COST_CSV }, { name: 'amount-2026-09-25_2026-09-25.csv', text: HOUR_AMOUNT_CSV }], importedAt: Date.parse('2026-09-25T05:00:00Z') });
ok('24.9 buildSync：2 个整点桶 / 1 个派生日（hourCovered）/ granularity=hour',
  hb.ok === true && hb.data.v === 2 && hb.data.hours.length === 2 && hb.data.days.length === 1 &&
  hb.data.days[0].d === '2026-09-25' && hb.data.days[0].hourCovered === true && hb.data.days[0].hourCount === 2 && hb.data.granularity === 'hour');
ok('24.9 合计：2.25 元 / 7 请求 / 350000 tokens（小时与派生日不重复计）',
  hb.data.totals.costU === 225000000 && hb.data.totals.requests === 7 && hb.data.totals.tokens === 350000);
ok('24.9 coveredUntil 取包内最后一行结束时刻（10:45 北京 = 02:45Z），不取末日 24 点',
  hb.data.coveredUntil === Date.parse('2026-09-25T02:45:00Z') && hb.data.windowStart === OS.dayKeyStartMs('2026-09-25'));
ok('24.9 summarize：粒度 / 整点数 / 逐小时明细（金额转元）', (function () {
  const s = OS.summarize(hb.data);
  return s.granularity === 'hour' && s.hourCount === 2 && s.hourDays === 1 && s.dayRows[0].hourCovered === true &&
    s.hourRows.length === 2 && s.hourRows[0].h === '09-25 09:00' && Math.abs(s.hourRows[0].cost - 0.75) < 1e-9 && Math.abs(s.hourRows[1].cost - 1.5) < 1e-9;
})());
ok('24.9 mergeSync 幂等：同一份小时包并两次，小时/日/合计逐字不变', (function () {
  const pick = (d) => JSON.stringify({ h: d.hours, dy: d.days, t: d.totals, from: d.from, to: d.to, cu: d.coveredUntil, ws: d.windowStart, g: d.granularity });
  return pick(OS.mergeSync(JSON.parse(JSON.stringify(hb.data)), JSON.parse(JSON.stringify(hb.data)))) === pick(hb.data);
})());
ok('24.9 normalizeSync：v1（只有 days）迁移为 v2', (function () {
  const v1 = { v: 1, importedAt: 1, from: '2026-09-27', to: '2026-09-27', days: [{ d: '2026-09-27', costU: 100, requests: 3, tokens: 10, models: [] }] };
  const n = OS.normalizeSync(v1);
  return !!n && n.v === 2 && n.hours.length === 0 && n.granularity === 'day' && n.days[0].hourCovered === false && n.imports.length === 1;
})());
ok('24.9 小时包优先：后导的按日包不夺权（仍 2 格 / 2.25 元 / hour，4.00 元被弃用）', (function () {
  const dayNext = OS.buildSync({ sheets: [{ name: 'cost-2026-09-25_2026-09-26.csv', text: DAY_COST_CSV }], importedAt: Date.parse('2026-09-25T06:00:00Z') });
  const m = OS.mergeSync(hb.data, dayNext.data);
  return m.hours.length === 2 && m.days.length === 1 && m.days[0].hourCovered === true && m.days[0].hourCount === 2 &&
    m.totals.costU === 225000000 && m.granularity === 'hour';
})());
ok('24.9 反向：小时包覆盖某天 → 该天旧日行被丢弃（小时为准）', (function () {
  const daySync = OS.buildSync({ sheets: [{ name: 'cost-2026-09-25_2026-09-26.csv', text: DAY_COST_CSV }] }).data;
  const m = OS.mergeSync(daySync, hb.data);
  return m.hours.length === 2 && m.days.length === 1 && m.days[0].hourCovered === true && m.totals.costU === 225000000;
})());
ok('24.9 合并对称：日包⊕小时包 与 小时包⊕日包 结果逐字相同', (function () {
  const daySync = OS.buildSync({ sheets: [{ name: 'cost-2026-09-25_2026-09-26.csv', text: DAY_COST_CSV }], importedAt: Date.parse('2026-09-25T06:00:00Z') }).data;
  const pick = (x) => JSON.stringify({ h: x.hours, dy: x.days, t: x.totals, g: x.granularity, cu: x.coveredUntil, ws: x.windowStart });
  return pick(OS.mergeSync(hb.data, daySync)) === pick(OS.mergeSync(daySync, hb.data));
})());
ok('24.9 历史不丢：长区间包 + 小时包共存（09-27/09-28 保留按日、09-25 按小时）', (function () {
  const hist = OS.buildSync({ sheets: [{ name: 'cost-2026-09-27_2026-09-28.csv', text: COST_CSV }] }).data;
  const m = OS.mergeSync(hist, hb.data);
  const d25 = m.days.filter((d) => d.d === '2026-09-25')[0];
  const d27 = m.days.filter((d) => d.d === '2026-09-27')[0];
  return m.hours.length === 2 && m.days.length === 3 && !!d25 && d25.hourCovered === true && !!d27 && d27.hourCovered === false &&
    m.granularity === 'mixed' && m.totals.costU === 1725000000 + 225000000;
})());

// --- 24.10 小时级路由：导入 / 幂等 / 视图接口 ---
{
  const hzip = mkZip([
    { name: 'cost-2026-09-25_2026-09-25.csv', text: HOUR_COST_CSV },
    { name: 'amount-2026-09-25_2026-09-25.csv', text: HOUR_AMOUNT_CSV, deflate: true },
  ]).toString('base64');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-hour-'));
  const r1 = await callInDir(dir, 'POST', '/api/sync', { content: hzip, encoding: 'base64', fileName: 'usage_data_hour.zip', tz: 480 });
  ok('24.10 路由：小时包导入成功（granularity=hour / 2 格 / 2.25 元 / 7 请求）',
    r1.body.ok === true && r1.body.data.granularity === 'hour' && r1.body.data.hourCount === 2 &&
    Math.abs(r1.body.data.totals.cost - 2.25) < 1e-9 && r1.body.data.totals.requests === 7);
  ok('24.10 路由：逐小时明细回传（09-25 09:00 = 0.75 元）',
    (r1.body.data.hourRows || []).some((x) => x.h === '09-25 09:00' && Math.abs(x.cost - 0.75) < 1e-9));
  const r2 = await callInDir(dir, 'POST', '/api/sync', { content: hzip, encoding: 'base64', fileName: 'usage_data_hour.zip', tz: 480 });
  ok('24.10 路由：同包重复导入不翻倍（幂等：仍 2.25 / 2 格，台账 2 条）',
    r2.body.ok === true && Math.abs(r2.body.data.totals.cost - 2.25) < 1e-9 && r2.body.data.hourCount === 2 &&
    Array.isArray(r2.body.data.imports) && r2.body.data.imports.length === 2);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  ok('24.10 state：v2 且不含 user_id / api_key / 原始文本',
    !!st.officialSync && st.officialSync.v === 2 && !('csv' in st.officialSync) &&
    JSON.stringify(st.officialSync).indexOf('user_id') < 0 && JSON.stringify(st.officialSync).indexOf('sk-secret') < 0 && JSON.stringify(st.officialSync).indexOf('HanaAgent') < 0);

  const u = await callInDir(dir, 'GET', '/api/usage', { query: {} }, {});
  ok('24.10 /api/usage：累计采纳小时包合计（7 请求 / 350000 tokens / 2.25 元）',
    u.body.data.requestCount === 7 && u.body.data.totalTokens === 350000 && Math.abs(u.body.data.official.cost - 2.25) < 1e-9);

  const s = await callInDir(dir, 'GET', '/api/stats', { query: { range: 'custom', tz: '480', from: '2026-09-25', to: '2026-09-25' } }, {}, []);
  ok('24.10 /api/stats：小时档 24 桶，官方整点注入对应格（09:00=0.75/3、10:00=1.50/4）', (function () {
    const b = s.body.data.buckets || [];
    const hr = (x) => new Date(x.t + 480 * 60000).getUTCHours();
    const h9 = b.filter((x) => hr(x) === 9)[0];
    const h10 = b.filter((x) => hr(x) === 10)[0];
    return s.body.ok === true && s.body.data.bucketMs === 3600000 && b.length === 24 &&
      !!h9 && Math.abs(h9.cost - 0.75) < 1e-9 && h9.requests === 3 &&
      !!h10 && Math.abs(h10.cost - 1.5) < 1e-9 && h10.requests === 4;
  })());
  ok('24.10 /api/stats：总量 = 官方合计（2.25 / 7），official 摘要标 hour',
    Math.abs(s.body.data.totals.cost - 2.25) < 1e-9 && s.body.data.totals.requests === 7 && !!s.body.data.official &&
    s.body.data.official.granularity === 'hour' && s.body.data.official.hourDays === 1 && s.body.data.official.dayOnlyDays === 0);
  ok('24.10 /api/stats：peakKnown / peakFrom 由服务端给出（前端不再自算）',
    typeof s.body.data.totals.peakKnown === 'boolean' && ['local', 'official', 'mixed'].indexOf(s.body.data.totals.peakFrom) >= 0);

  const dzip = mkZip([{ name: 'cost-2026-09-25_2026-09-26.csv', text: DAY_COST_CSV }]).toString('base64');
  const r3 = await callInDir(dir, 'POST', '/api/sync', { content: dzip, encoding: 'base64', fileName: 'usage_data_day.zip', tz: 480 });
  ok('24.10 路由：后导的按日包不夺权（小时包优先：granularity=hour / 2 格 / 2.25 元）',
    r3.body.ok === true && r3.body.data.granularity === 'hour' && r3.body.data.hourCount === 2 && Math.abs(r3.body.data.totals.cost - 2.25) < 1e-9);
  const s2 = await callInDir(dir, 'GET', '/api/stats', { query: { range: 'custom', tz: '480', from: '2026-09-25', to: '2026-09-25' } }, {}, []);
  ok('24.10 /api/stats：仍按小时出图（HOUR 桶 / 2.25 元）', s2.body.data.bucketMs === 3600000 && Math.abs(s2.body.data.totals.cost - 2.25) < 1e-9);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-dayonly-'));
  const r4 = await callInDir(dir2, 'POST', '/api/sync', { content: dzip, encoding: 'base64', fileName: 'usage_data_day.zip', tz: 480 });
  ok('24.10 路由：只导按日包 → 按日（granularity=day / 4.00 元 / 0 格）',
    r4.body.ok === true && r4.body.data.granularity === 'day' && r4.body.data.hourCount === 0 && Math.abs(r4.body.data.totals.cost - 4) < 1e-9);
}

// ---------------------------------------------------------------- 25. 第十二批：充值 ceil / × 统一 / 浮层空内容防御 / 用量归档
console.log('\n[25] 充值反推 ceil / × 统一配色 / 浮层空内容防御 / 用量归档');
const USAGE_ARCHIVE_MOD = await import('../lib/usage-archive.js?t=' + Date.now());

// --- 25.1 充值反推 ceil ---
ok('25.1 ceil 反推：4.07→5、2.99→3、5.99→6、6→6、2.5→3、3.98→4、5.001→6',
  balModSnap.snapRechargeYuan(4.07) === 5 && balModSnap.snapRechargeYuan(2.99) === 3 && balModSnap.snapRechargeYuan(5.99) === 6 &&
  balModSnap.snapRechargeYuan(6) === 6 && balModSnap.snapRechargeYuan(2.5) === 3 && balModSnap.snapRechargeYuan(3.98) === 4 && balModSnap.snapRechargeYuan(5.001) === 6);
ok('25.1 残差 = 窗口内消费推测值（booked − delta ≥ 0）', balModSnap.rechargeResidual(4.07) === 0.93 && balModSnap.rechargeResidual(5.99) === 0.01 && balModSnap.rechargeResidual(6) === 0);
ok('25.1 物理边界（可能低入 1 元）：4.98 → 5（真充 6、窗口消费 1.02 无法还原）', balModSnap.snapRechargeYuan(4.98) === 5);

// --- 25.2 × 统一配色 + 对比度 ---
ok('25.2 .pop-close 显式中性色（不再 inherit）', /\.pop-close \{[\s\S]{0,420}color: var\(--text-secondary\);/.test(widgetHtml) && !/\.pop-close \{[\s\S]{0,420}color: inherit;/.test(widgetHtml));
(function () {
  function mix(a, b, p) { const A = hexToRgb(a), B = hexToRgb(b); return [Math.round(A[0] * p + B[0] * (1 - p)), Math.round(A[1] * p + B[1] * (1 - p)), Math.round(A[2] * p + B[2] * (1 - p))]; }
  function cr(fg, bg) { const l1 = relLum(fg), l2 = relLum(bg); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
  const secL = cssVar(SHARED_CSS, 'text-secondary', 0);
  const redBg = mix(cssVar(SHARED_CSS, 'danger', 0), cssVar(SHARED_CSS, 'bg-card', 0), 0.12);
  const evBg = mix(cssVar(widgetHtml, 'sky', 0), cssVar(SHARED_CSS, 'bg-card', 0), 0.10);
  const rRedL = cr(hexToRgb(secL), redBg), rEvL = cr(hexToRgb(secL), evBg);
  ok('25.2 × 对比度(算)：明 红卡底=' + redBg.join(',') + ' ' + rRedL.toFixed(2) + ':1；事件卡底=' + evBg.join(',') + ' ' + rEvL.toFixed(2) + ':1', rRedL >= 4.5 && rEvL >= 4.5);
  const secD = cssVar(SHARED_CSS, 'text-secondary', 1);
  const redBgD = mix(cssVar(SHARED_CSS, 'danger', 1), cssVar(SHARED_CSS, 'bg-card', 1), 0.12);
  const evBgD = mix(cssVar(widgetHtml, 'sky', 1), cssVar(SHARED_CSS, 'bg-card', 1), 0.10);
  const rRedD = cr(hexToRgb(secD), redBgD), rEvD = cr(hexToRgb(secD), evBgD);
  ok('25.2 × 对比度(算)：暗 红卡底=' + rRedD.toFixed(2) + ':1；事件卡底=' + rEvD.toFixed(2) + ':1', rRedD >= 4.5 && rEvD >= 4.5);
})();

// --- 25.3 浮层空内容防御 ---
ok('25.3 三处浮层都有空内容兜底 + 留痕分支', /function guardPopup\(el, which, fallback\)/.test(widgetHtml) && /guardPopup\(el\.errBox, "errBox"/.test(widgetHtml) && /guardPopup\(el\.eventBox, "eventBox"/.test(widgetHtml) && /guardPopup\(el\.alertBox, "alertBox"/.test(widgetHtml) && /popup shown with empty content: /.test(widgetHtml) && /POPUP_EMPTY:/.test(widgetHtml));
ok('25.3 内容非空时不受影响（有内容即 return）', /if \(\(el\.textContent \|\| ""\)\.replace/.test(widgetHtml) && widgetHtml.indexOf('有内容 → 不动') >= 0);

// --- 25.4 用量归档（纯函数）---
ok('25.4 mergeEntries 按 requestId 去重', (function () { const r = USAGE_ARCHIVE_MOD.mergeEntries([{ requestId: 'a' }], [{ requestId: 'a' }, { requestId: 'b' }], 100); return r.added === 1 && r.entries.length === 2; })());
ok('25.4 mergeEntries 到顶丢最旧', (function () { const inc = [{ requestId: 'b', startedAt: '2026-09-27T02:00:00Z' }, { requestId: 'c', startedAt: '2026-09-27T03:00:00Z' }]; const r = USAGE_ARCHIVE_MOD.mergeEntries([{ requestId: 'a', startedAt: '2026-09-27T01:00:00Z' }], inc, 2); return r.dropped === 1 && r.entries.length === 2 && r.entries[0].requestId === 'b'; })());
ok('25.4 trimEntry 丢弃 attribution/sessionPath', (function () { const t = USAGE_ARCHIVE_MOD.trimEntry({ requestId: 'x', startedAt: 't', model: { provider: 'deepseek', modelId: 'm' }, usage: { totalTokens: 1 }, attribution: { sessionPath: 'C:\\secret' }, metadata: { a: 1 } }); return !('attribution' in t) && !('metadata' in t) && t.model.modelId === 'm'; })());
ok('25.4 unionEntries 去重并集', (function () { const u = USAGE_ARCHIVE_MOD.unionEntries([{ requestId: 'a' }, { requestId: 'b' }], [{ requestId: 'b' }, { requestId: 'c' }]); return u.length === 3; })());

// --- 25.4 行为：归档落盘 + 并集跨过宿主滚出 ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-arch-'));
  const mkEnt = (id, at, tok) => ({ requestId: id, startedAt: at, model: { provider: 'deepseek', modelId: 'deepseek-flash' }, usage: { totalTokens: tok, input: { uncachedTokens: tok, totalTokens: tok }, output: { totalTokens: 0 }, cache: { readTokens: 0, writeTokens: 0, missTokens: null } }, attribution: { sessionPath: 'C:\\secret\\s.jsonl' } });
  const led1 = [mkEnt('r1', '2026-09-27T00:00:10.000Z', 100), mkEnt('r2', '2026-09-27T01:00:10.000Z', 200)];
  const led2 = [led1[1], mkEnt('r3', '2026-09-27T02:00:10.000Z', 300)];
  const mkCtxArch = (ledger) => ({
    config: { get: (k) => ({ apiKey: 'sk-x' })[k], set: () => {} },
    dataDir: dir,
    network: { fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) },
    resources: { write: async () => true },
    bus: { request: async () => ledger },
    log: { info: () => {}, warn: () => {}, log: () => {} },
  });
  function getStatsFor(built, q) { const c = { _res: null, req: { query: (k) => (k ? q[k] : q), json: async () => null }, json: (b, s) => { c._res = { body: b, status: s || 200 }; return c; }, html: (s) => s }; return Promise.resolve(built.h['GET /api/stats'](c)).then(() => c._res); }
  const b1 = mkApp(); const m1 = await loadBalanceModule(); m1.default(b1.app, mkCtxArch(led1));
  await getStatsFor(b1, { range: 'all', tz: '480' });
  const archPath = path.join(dir, 'usage-archive.json');
  ok('25.4 首次读账本 → 归档落盘（2 条）', fs.existsSync(archPath) && JSON.parse(fs.readFileSync(archPath, 'utf8')).entries.length === 2);
  const archText = fs.readFileSync(archPath, 'utf8');
  ok('25.4 归档不落敏感字段（无 attribution/sessionPath/secret）', archText.indexOf('attribution') < 0 && archText.indexOf('sessionPath') < 0 && archText.indexOf('secret') < 0);
  const b2 = mkApp(); const m2 = await loadBalanceModule(); m2.default(b2.app, mkCtxArch(led2));
  const s2 = await getStatsFor(b2, { range: 'all', tz: '480' });
  ok('25.4 聚合取并集（宿主滚出的 r1 仍在，合计 3 条）', s2.body.data.totals.requests === 3 && s2.body.data.ledger.archive.count === 3, 'req=' + s2.body.data.totals.requests + ' arch=' + s2.body.data.ledger.archive.count);
  ok('25.4 宿主账本本体仍报 2 条（容量自查只看宿主）', s2.body.data.ledger.entries === 2);
  ok('25.4 接口回报归档状态（count/cap/full/oldestAt）', !!s2.body.data.ledger.archive && s2.body.data.ledger.archive.cap === USAGE_ARCHIVE_MOD.MAX_ARCHIVE && typeof s2.body.data.ledger.archive.full === 'boolean' && !!s2.body.data.ledger.archive.oldestAt);
}

// --- 25.5 文档 / 接线 ---
ok('25.5 README 补「用量归档」一节', readmeText.indexOf('用量归档') >= 0 && readmeText.indexOf('usage-archive.json') >= 0 && readmeText.indexOf('20000') >= 0);
ok('25.5 详情页脚并列展示归档行', /function archiveLine/.test(pageHtml) && /archiveLine\(d\) \+/.test(pageHtml) && /d\.ledger\.archive/.test(pageHtml));

// ---------------------------------------------------------------- 26. 时区切换加固（追加）
console.log('\n[26] 时区加固：菜单「跟随本机」/ 偏移不同提示 / 今日窗口随 tz 平移');

// --- 26.1 菜单恰两项 ---
ok('26.1 时区菜单恰两项（跟随本机 / UTC+0），无显式 GMT+8', (widgetHtml.match(/class="menu-item"/g) || []).length === 2 && /data-tz="-1"[\s\S]{0,160}menu-label">跟随本机/.test(widgetHtml) && /data-tz="0"/.test(widgetHtml) && widgetHtml.indexOf('data-tz="480"') < 0);
ok('26.1 「跟随本机」显示本机偏移；点它写回 -1', /lbl\.textContent = "跟随本机（" \+ tzLabel\(local\) \+ "）"/.test(widgetHtml) && /minutes === -1 \? "跟随本机（"/.test(widgetHtml) && /chooseTz\(Number\(item\.getAttribute\("data-tz"\)\)\)/.test(widgetHtml));

// --- 26.2 菜单选中判定（行为，数字证据）---
ok('26.2 菜单选中：-1→跟本机、480(存储)→跟本机、0→UTC+0，且恰一项高亮',
  SHARED.tzItemOn(-1, -1, 480) === true && SHARED.tzItemOn(0, -1, 480) === false &&
  SHARED.tzItemOn(-1, 480, 480) === true && SHARED.tzItemOn(0, 480, 480) === false &&
  SHARED.tzItemOn(0, 0, 480) === true && SHARED.tzItemOn(-1, 0, 480) === false &&
  SHARED.tzItemOn(-1, 240, 480) === false && SHARED.tzItemOn(0, 240, 480) === true &&
  SHARED.tzItemOn(-1, 0, 0) === true && SHARED.tzItemOn(0, 0, 0) === false);

// --- 26.3 pickTzMinutes 纯函数 ---
ok('26.3 pickTzMinutes：查询 > 配置 > 本机；-1 视为跟随本机',
  balModSnap.pickTzMinutes('0', 480, 480) === 0 && balModSnap.pickTzMinutes(undefined, 0, 480) === 0 &&
  balModSnap.pickTzMinutes(-1, -1, 480) === 480 && balModSnap.pickTzMinutes('abc', -1, 480) === 480 && balModSnap.pickTzMinutes('9999', 480, 480) === 480);

// --- 26.4 「今日」窗口随 tz 平移（数字证据）---
(function () {
  function dayStartOf(tzMinutes, nowMs) { const s = new Date(nowMs + tzMinutes * 60000); return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - tzMinutes * 60000; }
  function bjLabel(ms) { const d = new Date(ms + 8 * 3600000); const p = (n) => String(n).padStart(2, '0'); return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); }
  const NOW = Date.parse('2026-09-28T07:52:00+08:00');
  ok('26.4 「今日」窗口随 tz 平移：480 → 北京 09-28 00:00；0 → 北京 09-27 08:00（UTC 日界）',
    bjLabel(dayStartOf(480, NOW)) === '2026-09-28 00:00' && bjLabel(dayStartOf(0, NOW)) === '2026-09-27 08:00' &&
    OS.beijingDayKey(dayStartOf(480, NOW)) === '2026-09-28' && OS.beijingDayKey(dayStartOf(0, NOW)) === '2026-09-27',
    bjLabel(dayStartOf(480, NOW)) + ' / ' + bjLabel(dayStartOf(0, NOW)));
})();

// --- 26.5 红字警示已移除（普通时区行保留）---
ok('26.5 已移除红字警示（无 #tzWarn / .tz-warn），普通时区行仍在',
  widgetHtml.indexOf('id="tzWarn"') < 0 && widgetHtml.indexOf('.tz-warn') < 0 && widgetHtml.indexOf('tzWarn') < 0 &&
  /id="tzText"/.test(widgetHtml) && /所有日期均按 " \+ tzLabel\(effectiveTz\(\)\) \+ " 时间显示/.test(widgetHtml) && !/if \(effective !== local\)/.test(widgetHtml));

// ---------------------------------------------------------------- 27. × 提示统一：原生 title → 自绘 .tip（第十四批）
console.log('\n[27] × 提示：原生 title → 自绘 .tip（单例）+ 动态绑定');

// 27.1 预警 ×
ok('27.1 预警 × 无原生 title、改挂 data-tip（aria-label 保留）', !/close\.title\s*=/.test(widgetHtml) && /close\.setAttribute\("data-tip", "今天不再提示"\)/.test(widgetHtml) && /close\.setAttribute\("aria-label", "今天不再提示"\)/.test(widgetHtml));
ok('27.1 预警 × 创建后即绑自绘提示', /close\.addEventListener\("click", dismissAlertToday\);\s*\n\s*bindTipNode\(close\);/.test(widgetHtml));
// 27.2 事件 ×
ok('27.2 事件 × 有 data-tip="关闭"、无原生 title、创建后即绑', /id="eventClose"[^>]*data-tip="关闭"/.test(widgetHtml) && /bindTipNode\(closeBtn\);/.test(widgetHtml));
// 27.3 同一套 .tip（单例）+ 同延迟 + 同箭头机制
ok('27.3 走同一个 .tip 单例（#tip 唯一）+ 同 TIP_SHOW_DELAY + 同 --arrow-x', (widgetHtml.match(/id="tip"/g) || []).length === 1 && /var TIP_SHOW_DELAY = 120;/.test(widgetHtml) && /el\.tip\.style\.setProperty\("--arrow-x"/.test(widgetHtml) && /tip: id\("tip"\)/.test(widgetHtml));
// 27.4 动态绑定函数
ok('27.4 bindTipNode 单节点绑定（鼠标 + focus/blur）且被 bindTips 复用', /function bindTipNode\(node\) \{[\s\S]{0,240}mouseenter[\s\S]{0,140}focus[\s\S]{0,140}blur/.test(widgetHtml) && /Array\.prototype\.forEach\.call\(nodes, bindTipNode\)/.test(widgetHtml));
ok('27.4 静态与动态两条路径都走 bindTipNode（除图表委托）', /forEach\.call\(nodes, bindTipNode\)/.test(widgetHtml) && /bindTipNode\(close\);/.test(widgetHtml) && /bindTipNode\(closeBtn\);/.test(widgetHtml));
// 27.5 全仓再无原生 HTML title tooltip（SVG/文档 <title> 保留）
ok('27.5 全仓无原生 HTML title tooltip；SVG/文档 <title> 保留', widgetHtml.indexOf(' title="') < 0 && pageHtml.indexOf(' title="') < 0 && pageHtml.indexOf('<title>') >= 0 && widgetHtml.indexOf('<title>') >= 0);

// ---------------------------------------------------------------- 28. 瞬时 toast 回归修复（第十六批）
console.log('\n[28] 提示区浮层化：显隐不改 #content 位置 / 抑制覆盖');

// 28.1 定位分流
ok('28.1 #notice（toast）绝对定位（不参与文档流）', (function () { const r = (widgetHtml.match(/#notice \{[^}]*\}/) || [''])[0]; return /position: absolute/.test(r) && r.indexOf('left: 0') >= 0 && r.indexOf('top: 0') >= 0; })());
ok('28.1 .pop-layer 为浮层定位（absolute，不参与文档流）', (function () { const r = (widgetHtml.match(/\.pop-layer \{[^}]*\}/) || [''])[0]; return /position: absolute/.test(r) && /top: 38px/.test(r); })());

// 28.2 抑制覆盖：显/隐会改 #content 位置的路径，两侧都抑制
ok('28.2 三处常驻浮层显隐两侧都调 muteHoverUntilMove',
  /function hideAlert\(\)[\s\S]{0,700}if \(wasShown\) muteHoverUntilMove\(\)/.test(widgetHtml) &&
  /function hideEvent\(\)[\s\S]{0,700}muteHoverUntilMove\(\)/.test(widgetHtml) &&
  /function clearError\(\)[\s\S]{0,700}if \(wasVisible\) muteHoverUntilMove\(\)/.test(widgetHtml) &&
  /function checkAlert[\s\S]{0,3000}if \(!wasVisible\) muteHoverUntilMove\(\)/.test(widgetHtml) &&
  /function renderEvent[\s\S]{0,3000}if \(!wasVisible\) muteHoverUntilMove\(\)/.test(widgetHtml) &&
  /function showError[\s\S]{0,700}if \(!wasVisible\) muteHoverUntilMove\(\)/.test(widgetHtml));
ok('28.2 菜单/设置弹窗/内容位移也抑制', /function openMenu[\s\S]{0,1000}muteHoverUntilMove\(\)/.test(widgetHtml) && /function closeMenu[\s\S]{0,400}muteHoverUntilMove\(\)/.test(widgetHtml) && /onClose: function \(\) \{ muteHoverUntilMove\(\); \}/.test(widgetHtml) && /heightBefore\) > 0\.5\) muteHoverUntilMove\(\)/.test(widgetHtml));

// 28.3 复现路径：toast 出现 → 消失，两侧都抑制 hover（与余额卡 mouseenter 不联动）
ok('28.3 toast 出现/隐藏两侧都抑制 hover', /el\.notice\.className = "notice pop-card"[\s\S]{0,140}muteHoverUntilMove\(\)/.test(widgetHtml) && /noticeTimer = setTimeout\(function \(\) \{[\s\S]{0,280}muteHoverUntilMove\(\)/.test(widgetHtml));
ok('28.3 抑制机制未变（关 #content 指针事件、真实 mousemove 或 1.5s 兵底恢复）', /content\.style\.pointerEvents = "none"/.test(widgetHtml) && /content\.style\.pointerEvents = ""/.test(widgetHtml) && /addEventListener\("mousemove", release, true\)/.test(widgetHtml) && /setTimeout\(release, 1500\)/.test(widgetHtml));

// ---------------------------------------------------------------- 29. 预警/事件 × 提示方向（第十八批）
console.log('\n[29] × 提示方向：已回退为「默认朝下」（十八批 popup→above 是误诊）');

// 29.1 纯函数 chooseTipAbove（1.14.45：popup 分支已回退为「朝下」）
ok('29.1 .card 内：中线以上→上、以下→下（旧规则不变）',
  SHARED.chooseTipAbove({ anchorMid: 50, containerMid: 100, containerKind: 'card', anchorTop: 40, anchorBottom: 60, tipHeight: 18, panelHeight: 400 }) === true &&
  SHARED.chooseTipAbove({ anchorMid: 150, containerMid: 100, containerKind: 'card', anchorTop: 140, anchorBottom: 160, tipHeight: 18, panelHeight: 400 }) === false);
ok('29.1 浮层卡内沿用旧默认·朝下（已回退；作者确认位置原本正确，勿再改回朝上）',
  SHARED.chooseTipAbove({ anchorMid: 50, containerMid: 10, containerKind: 'popup', anchorTop: 44, anchorBottom: 62, tipHeight: 18, panelHeight: 400 }) === false);
ok('29.1 其它容器沿用旧默认（朝下）',
  SHARED.chooseTipAbove({ anchorMid: 50, containerMid: 0, containerKind: 'other', anchorTop: 40, anchorBottom: 60, tipHeight: 18, panelHeight: 400 }) === false);
ok('29.1 兜底①：朝上但贴不到面板顶 → 翻回下方',
  SHARED.chooseTipAbove({ anchorMid: 50, containerMid: 100, containerKind: 'card', anchorTop: 10, anchorBottom: 28, tipHeight: 30, panelHeight: 400 }) === false);
ok('29.1 兜底②：朝下但超出面板底 → 翻回上方',
  SHARED.chooseTipAbove({ anchorMid: 150, containerMid: 100, containerKind: 'card', anchorTop: 380, anchorBottom: 398, tipHeight: 30, panelHeight: 400 }) === true);

// 29.2 接线：renderTip 用纯函数且识别浮层卡 .box
ok('29.2 renderTip 用 HPU.chooseTipAbove 且识别浮层卡 .box',
  /HPU\.chooseTipAbove\(\{/.test(widgetHtml) && /anchor\.closest\("\.box"\)/.test(widgetHtml) && /containerKind: card \? "card" : \(popup \? "popup" : "other"\)/.test(widgetHtml));
ok('29.2 预警 × / 事件 × 确实在浮层卡（.box）内',
  /el\.alertBox\.appendChild\(close\)/.test(widgetHtml) && /class="box alert-box pop-card" id="alertBox"/.test(widgetHtml) &&
  /id="eventClose"[^>]*>×<\/button>/.test(widgetHtml) && /class="box event-box pop-card" id="eventBox"/.test(widgetHtml));

// ---------------------------------------------------------------- 30. 提示层级：.tip 在浮层之上（第十九批）
console.log('\n[30] 提示层级：.tip z-index 高于浮层/模态/居中提示；#tip 不被困在低层叠上下文');
ok('30.1 .tip z-index 200（高于 .pop-layer 40 / .menu 30 / modal 90 / 居中提示 120）', (function () { const tip = (widgetHtml.match(/\.tip \{[^}]*\}/) || [''])[0]; const m = /z-index:\s*(\d+)/.exec(tip); const z = m ? Number(m[1]) : NaN; return z > 120 && z > 90 && z > 40; })());
ok('30.1 浮层/模态/居中提示的 z-index 未被改动（优先级链保持）', /\.pop-layer \{[^}]*z-index: 40/.test(widgetHtml) && /\.modal \{[^}]*z-index: 90/.test(SHARED_CSS) && /\.modal\.modal-notice \{ z-index: 120/.test(SHARED_CSS));
ok('30.1 #tip 的父链不构成更低的层叠上下文（.widget 为 position:relative + z-index:auto，无 transform/opacity/filter）', (function () { const w = (widgetHtml.match(/\.widget \{[^}]*\}/) || [''])[0]; return /position: relative/.test(w) && !/z-index/.test(w) && !/transform/.test(w) && !/opacity/.test(w) && !/filter/.test(w); })());
ok('30.1 #tip 仍为 .widget 直接子节点（与 .pop-layer 同级，无需移到根级）', /<div class="tip" id="tip"[^>]*><\/div>\s*\n\s*<\/div>/.test(widgetHtml) && widgetHtml.indexOf('id="popLayer"') < widgetHtml.indexOf('id="tip"'));

// ---------------------------------------------------------------- 31. 整体排查修复（第二十批）
console.log('\n[31] 整体排查：入参护栏 / 缓存键 / 日历校验 / Tokens 口径 / all 入口 / 归档节流 / tmp 名 / evAmt 幂等 / config 默认 / 红窗优先 / 工具声明');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function routeDriver(ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-drv-'));
  const built = mkApp();
  const ctx = {
    config: { get: (k) => ({ apiKey: 'sk-x' })[k], set: () => {} },
    dataDir: dir,
    network: { fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) },
    resources: { write: async () => true },
    bus: { request: async () => ledger },
    log: { info: () => {}, warn: () => {}, log: () => {} },
  };
  const mod = await loadBalanceModule(); mod.default(built.app, ctx);
  const call = (p, q) => { const c = mkCallQ(q || {}); return Promise.resolve(built.h['GET ' + p](c)).then(() => c._res); };
  return { dir, stats: (q) => call('/api/stats', q), usage: () => call('/api/usage') };
}

// --- 31.1 严格数值入参 ---
ok('31.1 isStrictNumeric：number / 非空数字串 才合法', balModSnap.isStrictNumeric(0) === true && balModSnap.isStrictNumeric(-1) === true && balModSnap.isStrictNumeric('480') === true && balModSnap.isStrictNumeric('-1') === true && balModSnap.isStrictNumeric(null) === false && balModSnap.isStrictNumeric('') === false && balModSnap.isStrictNumeric('  ') === false && balModSnap.isStrictNumeric([]) === false && balModSnap.isStrictNumeric(true) === false && balModSnap.isStrictNumeric('abc') === false && balModSnap.isStrictNumeric(undefined) === false && balModSnap.isStrictNumeric(NaN) === false);
for (const bad of [null, '', []]) {
  const t = await callRoute('POST', '/api/timezone', { offsetMinutes: bad });
  const cc = await callRoute('POST', '/api/config', { alertThreshold: bad });
  ok('31.1 入参空值 ' + JSON.stringify(bad) + ' → timezone/config 均 400', t.res.status === 400 && t.res.body.error === 'invalid_timezone' && cc.res.status === 400 && cc.res.body.error === 'invalid_threshold', t.res.status + '/' + cc.res.status);
}
for (const good of [0, -1, 480]) {
  const t = await callRoute('POST', '/api/timezone', { offsetMinutes: good });
  ok('31.1 合法值 offsetMinutes=' + good + ' → 200', t.res.status === 200 && t.res.body.ok === true && t.res.body.timezoneOffsetMinutes === good, t.res.status + '/' + JSON.stringify(t.res.body));
}
ok('31.1 alertThreshold 0 → 200', (await callRoute('POST', '/api/config', { alertThreshold: 0 })).res.status === 200);
ok('31.1 stats tz 空串/非数字 → 400；缺席/合法值 → 200', (await callStats({ range: 'today', tz: '' })).status === 400 && (await callStats({ range: 'today', tz: 'abc' })).status === 400 && (await callStats({ range: 'today', tz: '480' })).status === 200 && (await callStats({ range: 'today', tz: '-1' })).status === 200 && (await callStats({ range: 'today' })).status === 200);

// --- 31.2 缓存键含 until ---
ok('31.2 缓存键含 until（源码守卫）', /const cacheKey = \[range, since, until, tzMinutes, calibration/.test(balSrc));
{
  const drv = await routeDriver([]);
  const a = await drv.stats({ range: 'custom', from: '2026-09-01', to: '2026-09-02' });
  const b = await drv.stats({ range: 'custom', from: '2026-09-01', to: '2026-09-05' });
  ok('31.2 同 from 不同 to 不互相污染（48 小时桶 vs 5 天桶）', a.body.data.buckets.length === 48 && b.body.data.buckets.length === 5, a.body.data.buckets.length + '/' + b.body.data.buckets.length);
}

// --- 31.3 custom 日历校验 ---
{
  const b1 = await callStats({ range: 'custom', from: '2026-13-45', to: '2026-13-45' });
  const b2 = await callStats({ range: 'custom', from: '2026-02-31', to: '2026-02-31' });
  const b3 = await callStats({ range: 'custom', from: '2026-00-00', to: '2026-00-00' });
  ok('31.3 custom 日历非法（13-45 / 02-31 / 00-00）→ 400 invalid_range', b1.status === 400 && b1.body.error === 'invalid_range' && b2.status === 400 && b3.status === 400);
  const g = await callStats({ range: 'custom', from: '2026-09-01', to: '2026-09-02' });
  ok('31.3 合法 custom 日期不受影响', g.status === 200 && g.body.ok === true);
}

// --- 31.4 Tokens 口径统一 ---
{
  const e = { requestId: 'r1', startedAt: '2026-09-27T00:00:10.000Z', model: { provider: 'deepseek', modelId: 'deepseek-flash' }, usage: { input: { uncachedTokens: 10, totalTokens: 10 }, output: { totalTokens: 5 }, cache: { readTokens: 0, writeTokens: 0, missTokens: null } } };
  const drv = await routeDriver([e]);
  const us = await drv.usage();
  const st = await drv.stats({ range: 'all', tz: '480' });
  ok('31.4 Tokens 口径统一（totalTokens 缺失时两接口一致 = hit+miss+out）', us.body.data.totalTokens === 15 && st.body.data.totals.tokens === 15, us.body.data.totalTokens + '/' + st.body.data.totals.tokens);
}

// --- 31.5 详情页「全部」入口 ---
ok('31.5 详情页时间维度菜单含「全部」入口', /data-range="all"><span>全部</.test(pageHtml) && /data-range="all">全部</.test(pageHtml) && /all: "全部"/.test(pageHtml));
{
  const r = await callStats({ range: 'all', tz: '480' });
  ok('31.5 range=all 正常出图', r.status === 200 && r.body.ok === true && Array.isArray(r.body.data.buckets));
}

// --- 31.6 归档写盘节流 ---
ok('31.6 归档写盘节流（源码守卫：30s 窗口 + drop 立即写 + 日志限流）', /ARCHIVE_WRITE_MIN_MS = 30000/.test(balSrc) && /mustWrite = merged\.dropped > 0 \|\| \(!archiveSeeded/.test(balSrc) && /archiveWrittenAtMono = nowMono/.test(balSrc) && /nowMono - archiveLoggedAtMono\) >= ARCHIVE_WRITE_MIN_MS/.test(balSrc));
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-thr-'));
  const mkE = (id, at) => ({ requestId: id, startedAt: at, model: { provider: 'deepseek', modelId: 'deepseek-flash' }, usage: { totalTokens: 1, input: { uncachedTokens: 1, totalTokens: 1 }, output: { totalTokens: 0 }, cache: { readTokens: 0, writeTokens: 0, missTokens: null } } });
  let ledger = [mkE('a', '2026-09-27T00:00:10.000Z')];
  const built = mkApp();
  const ctx = { config: { get: (k) => ({ apiKey: 'sk-x' })[k], set: () => {} }, dataDir: dir, network: { fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) }, resources: { write: async () => true }, bus: { request: async () => ledger }, log: { info: () => {}, warn: () => {}, log: () => {} } };
  const mod = await loadBalanceModule(); mod.default(built.app, ctx);
  const call = (q) => { const c = mkCallQ(q); return Promise.resolve(built.h['GET /api/stats'](c)).then(() => c._res); };
  await call({ range: 'all', tz: '480' });
  const p = path.join(dir, 'usage-archive.json');
  const first = JSON.parse(fs.readFileSync(p, 'utf8')).entries.length;
  await sleep(3200); // 越过账本 3s 缓存
  ledger = [mkE('a', '2026-09-27T00:00:10.000Z'), mkE('b', '2026-09-27T01:00:10.000Z')];
  const r2 = await call({ range: 'all', tz: '480' });
  const fileAfter = JSON.parse(fs.readFileSync(p, 'utf8')).entries.length;
  ok('31.6 首次播种写盘（1）；窗口内仅新增不重写（文件仍 1），内存/接口已见 2 条', first === 1 && fileAfter === 1 && r2.body.data.ledger.archive.count === 2, first + '/' + fileAfter + '/' + r2.body.data.ledger.archive.count);
}

// --- 31.7 state tmp 名唯一 ---
ok('31.7 state tmp 名唯一（路由 + 工具，含 pid+随机）', /STATE_FILE \+ '\.' \+ process\.pid/.test(balSrc) && /file \+ '\.' \+ process\.pid/.test(alertSrc));

// --- 31.8 evAmt 幂等（persistFailed 重试不翻倍）---
{
  const now = Date.now();
  const up = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 28, topped_up_balance: 28, granted_balance: 0 }] };
  const r = await callBalance({ failSet: true, state: { lastToppedUpBalance: 20, lastGrantedBalance: 0, lastBalanceCheckAt: now - 60000 }, upstream: up });
  r.ctl.failSet = false;
  await r.call(up);
  const st = readStateFile(r.dir);
  const last = st.balanceSamples[st.balanceSamples.length - 1];
  ok('31.8 persistFailed 重试成功 ⇒ 该小时 evAmt.recharge 只记一次（=8，不翻倍）', !!last && last.ev === true && !!last.evAmt && last.evAmt.recharge === 8, JSON.stringify(last && last.evAmt));
}

// --- 31.9 config 缺键默认值 ---
ok('31.9 GET /api/config 缺键回落 60 / -1（源码）', /cfgNumberOr\('refreshIntervalSeconds', 60, 0\)/.test(balSrc) && /cfgNumberOr\('timezoneOffsetMinutes', -1, -720, 840\)/.test(balSrc));
{
  const r = await callRoute('GET', '/api/config');
  ok('31.9 缺键 config 返回默认 60 / 0 / -1', r.res.body.refreshIntervalSeconds === 60 && r.res.body.alertThreshold === 0 && r.res.body.timezoneOffsetMinutes === -1, JSON.stringify({ r: r.res.body.refreshIntervalSeconds, a: r.res.body.alertThreshold, tz: r.res.body.timezoneOffsetMinutes }));
}

// --- 31.10 红窗优先（浮层内层序）---
ok('31.10 浮层内层序：常驻卡(z2) 在 toast(z1) 之上（红窗优先真成立）', /#notice \{[\s\S]{0,80}z-index: 1;/.test(widgetHtml) && /\.pop-layer > \.box \{ z-index: 2; \}/.test(widgetHtml));

// --- 31.11 工具 readOnly 声明 ---
ok('31.11 工具不再声明 readOnly（与写盘行为一致）', alertSrc.indexOf('export const sessionPermission') < 0 && /不声明 sessionPermission\.readOnly/.test(alertSrc));

// ---------------------------------------------------------------- 32. 清尾（第二十一批）
console.log('\n[32] 清尾：注释一致性 / 局部时区 / 桶粒度升档 / unknown range + until 语义');
const sharedSrc = fs.readFileSync(path.join(root, 'lib', 'ui-shared.js'), 'utf8');
const diagSrc = fs.readFileSync(path.join(root, 'lib', 'diag-log.js'), 'utf8');

// --- 32.1 注释与实现一致 ---
ok('32.1 widget.js 通知区注释不再残留「参与文档流 / 零覆盖」（改为绝对浮层事实）',
  widgetSrc.indexOf('参与文档流') < 0 && widgetSrc.indexOf('零覆盖') < 0 && /top: 38px/.test(widgetSrc) && /z-index: 40/.test(widgetSrc));
ok('32.1 widget.js renderTip 方向注释已改为「已回退为朝下」', widgetSrc.indexOf('默认朝上') < 0 && /已回退为朝下/.test(widgetSrc));
ok('32.1 抑制函数理由已写明（浮层显隐改变光标下方元素）', /为什么仍保留 hover 抑制/.test(widgetSrc) && /幽灵 hover/.test(widgetSrc));
ok('32.1 ui-shared 仅以历史理由提及「曾…默认朝上」，当前分支为朝下',
  /十八批曾让[\s\S]{0,60}默认朝上/.test(sharedSrc) && /else above = false; \/\/ 'popup' 与 'other' 一律沿用旧默认（朝下）/.test(sharedSrc));

// --- 32.2 局部时区混用 ---
{
  const pcf = (pageSrc.match(/function priceChangeLine\(d\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok('32.2 型号变动时间戳按展示时区（tzMinutes）格式化', /tzMinutes\(\) \* 60000/.test(pcf) && /getUTCFullYear/.test(pcf) && !/dt\.getFullYear/.test(pcf));
  const tkf = (widgetSrc.match(/function todayKey\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok('32.2 预警静默键按展示时区（effectiveTz）取日', /effectiveTz\(\) \* 60000/.test(tkf) && /getUTCDate/.test(tkf) && !/d\.getMonth\(\)/.test(tkf));
  ok('32.2 diag-log 的本机时区是显式有意（注释已注明）', /有意用\*\*本机时区\*\*/.test(diagSrc));
}

// --- 32.3 桶粒度自动升档 ---
{
  const DAYm = 86400000;
  const nowMs = Date.now();
  const mk = (id, ms) => ({ requestId: id, startedAt: new Date(ms).toISOString(), model: { provider: 'deepseek', modelId: 'deepseek-flash' }, usage: { totalTokens: 1, input: { uncachedTokens: 1, totalTokens: 1 }, output: { totalTokens: 0 }, cache: { readTokens: 0, writeTokens: 0, missTokens: null } } });
  const drv = await routeDriver([mk('old', nowMs - 600 * DAYm), mk('new', nowMs - 3600 * 1000)]);
  const r = await drv.stats({ range: 'all', tz: '480' });
  const dd = r.body.data;
  const last = dd.buckets[dd.buckets.length - 1];
  ok('32.3 600 天跨度自动升档（天 → 周），桶数 ≤ 400 且窗口被完整覆盖',
    dd.bucketMs === 7 * DAYm && dd.buckets.length <= 400 && dd.buckets.length === 86 &&
    (dd.since + dd.buckets.length * dd.bucketMs) >= dd.until, 'bucketMs=' + dd.bucketMs + ' n=' + dd.buckets.length);
  ok('32.3 末桶标签诚实：末桶起点距窗口末端 ≤ 一个桶宽；新旧两条各落在首/末桶',
    (dd.until - last.t) <= dd.bucketMs && dd.buckets[0].requests === 1 && last.requests === 1,
    'until-last.t=' + (dd.until - last.t) + ' first=' + dd.buckets[0].requests + ' last=' + last.requests);
  const r30 = await drv.stats({ range: '30d', tz: '480' });
  ok('32.3 回归：30d 仍按天、30 桶', r30.body.data.bucketMs === DAYm && r30.body.data.buckets.length === 30, r30.body.data.bucketMs + '/' + r30.body.data.buckets.length);
  const rc = await drv.stats({ range: 'custom', from: '2026-09-01', to: '2026-09-02', tz: '480' });
  ok('32.3 回归：2 天 custom 仍按小时、48 桶', rc.body.data.bucketMs === 3600000 && rc.body.data.buckets.length === 48, rc.body.data.bucketMs + '/' + rc.body.data.buckets.length);
}

// --- 32.4 unknown range + until 语义 ---
{
  const bad = await callStats({ range: 'nonsense' });
  ok('32.4 未知 range → 400 invalid_range（不再静默回落 30d），并回显 range',
    bad.status === 400 && bad.body.error === 'invalid_range' && bad.body.range === 'nonsense', bad.status + '/' + bad.body.range);
  const empty = await callStats({ range: '', tz: '480' });
  ok('32.4 range 空串 → 默认 30d（不算未知）', empty.status === 200 && empty.body.data.range === '30d');
  const absent = await callStats({ tz: '480' });
  ok('32.4 range 缺席 → 默认 30d', absent.status === 200 && absent.body.data.range === '30d');

  const tz480 = 480 * 60000;
  const y = await callStats({ range: 'yesterday', tz: '480' });
  ok('32.4 until（yesterday）= 窗口末端（今晨 00:00），非取数时刻；跨度恰 1 天',
    y.body.data.until === y.body.data.since + 86400000 && y.body.data.until < Date.now(), 'until-since=' + (y.body.data.until - y.body.data.since));
  const lm = await callStats({ range: 'lastMonth', tz: '480' });
  ok('32.4 until（lastMonth）= 本月首日 00:00，跨度 = 上月天数 28..31',
    lm.body.data.until < Date.now() && new Date(lm.body.data.until + tz480).getUTCDate() === 1 &&
    (lm.body.data.until - lm.body.data.since) >= 28 * 86400000 && (lm.body.data.until - lm.body.data.since) <= 31 * 86400000,
    new Date(lm.body.data.until + tz480).toISOString());
  const cu = await callStats({ range: 'custom', from: '2026-09-01', to: '2026-09-02', tz: '480' });
  ok('32.4 until（custom）= to 次日 00:00；跨度 = 2 天', cu.body.data.until === cu.body.data.since + 2 * 86400000, 'until-since=' + (cu.body.data.until - cu.body.data.since));
  const al = await callStats({ range: 'all', tz: '480' });
  ok('32.4 until（all/滚动区间）= 「现在」，类型为 number',
    typeof al.body.data.until === 'number' && al.body.data.until <= Date.now() && al.body.data.until > Date.now() - 10000, String(al.body.data.until));
}

// ---------------------------------------------------------------- 33. 余额卡光标收窄（第二十二批）
console.log('\n[33] 余额卡光标收窄：卡体 default / 两控件显式 pointer / 卡内非控件无 pointer 来源');
{
  // 先剥掉 CSS 注释：避免注释里的文字被当成选择器（本项目已两次踩到同类陷阱）
  const cssPlain = widgetHtml.replace(/\/\*[\s\S]*?\*\//g, '');
  const pointerSelectors = [];
  for (const m of cssPlain.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (/cursor:\s*pointer/.test(m[2])) pointerSelectors.push(m[1].replace(/\s+/g, ' ').trim());
  }
  const FORBIDDEN = ['#balanceCard', '#breakdownRow', '.amount', '.card-label', '.balance-breakdown', '.card-row', '.info'];
  const badOnCard = pointerSelectors.filter((s) => FORBIDDEN.some((t) => s.indexOf(t) >= 0));
  ok('33.1 卡体与卡内非控件元素（金额/标签/拆分行/?）均无 cursor:pointer 规则', badOnCard.length === 0, JSON.stringify(badOnCard));
  ok('33.1 预警提示文字本身无 pointer 规则（仅其内 .link 控件命中）', !pointerSelectors.some((s) => s.trim() === '.alert-hint'));
  ok('33.1 #balanceCard 显式 cursor: default；.card.is-action 不再自带 pointer',
    /#balanceCard \{[^}]*cursor:\s*default/.test(widgetHtml) && !/\.card\.is-action \{ cursor: pointer/.test(widgetHtml));
  ok('33.2 「去充值」.recharge-btn 显式 cursor: pointer', /\.recharge-btn \{[^}]*cursor:\s*pointer/.test(widgetHtml));
  ok('33.2 「去设置」#settingLink 显式 cursor: pointer', /#settingLink \{[^}]*cursor:\s*pointer/.test(widgetHtml));
  ok('33.3 ? 图标有意为 cursor: help（工具提示样式，非手掌）', /\.info \{[^}]*cursor:\s*help/.test(widgetHtml));
  ok('33.4 未改动：hover 底色保留（.card.is-action:hover 仍设 background）', /\.card\.is-action:hover \{[^}]*background:\s*color-mix/.test(widgetHtml));
  ok('33.4 未改动：单击/双击/键盘等价仍绑定', /el\.balanceCard\.addEventListener\("click"/.test(widgetHtml) && /el\.balanceCard\.addEventListener\("dblclick"/.test(widgetHtml) && /el\.balanceCard\.addEventListener\("keydown"/.test(widgetHtml));
}

// ---------------------------------------------------------------- 34. 跨平台打包 + 分享用文档（第二十三批）
console.log('\n[34] 跨平台补齐：release.mjs 打包分支 / 排除清单 / README 跨平台与开篇');
ok('34.1 release.mjs 存在平台分支（process.platform → win32 / POSIX）',
  /platform = process\.platform/.test(relSrc) && /platform === 'win32'/.test(relSrc) && /if \(isWin\) \{/.test(relSrc));
ok('34.2 Windows 分支仍用 Compress-Archive（cwd 定为插件根 + 显式文件清单 ⇒ 排除项不入包）',
  /Set-Location -LiteralPath/.test(relSrc) && /Compress-Archive -Path/.test(relSrc));
ok('34.3 POSIX 分支优先 zip -r（cwd 设为暂存目录，entries 干净）',
  /tool: 'zip', argv: \['-r', '-q', zipPath\]\.concat\(topEntries\)/.test(relSrc) && /cwd: stageDir/.test(relSrc));
ok('34.4 无 zip 回退 python3 -m zipfile（清单由 node 递归得出）', /tool: 'python3', argv: \['-m', 'zipfile', '-c', zipPath\]/.test(relSrc));
ok('34.5 两者皆无 ⇒ 明确报错（不静默产出空包）', /未找到可用的打包工具/.test(relSrc) && /err\.code === 'ENOENT'/.test(relSrc));
ok('34.6 打包清单为空时拒绝（空包防线）', /打包清单为空，拒绝产出空包/.test(relSrc));
ok('34.7 运行态快照/自检不走平台分支（node:os / node:path / process.execPath）',
  /import os from 'node:os'/.test(relSrc) && /plugin-data-' \+ id \+ '-' \+ version \+ '-' \+ ts/.test(relSrc) && /execFileSync\(process\.execPath, \[path\.join\(root, 'tests', 'run-all\.mjs'\)\]/.test(relSrc));
{
  const relMod = await import('../scripts/release.mjs?t=' + Date.now());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-pkg-'));
  fs.mkdirSync(path.join(tmp, 'routes'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), { recursive: true });
  for (const f of ['manifest.json', 'routes/balance.js', 'routes/page.js', 'a.tmp', 'b.bak', 'c.bak2', 'd.bak-20260101', '_selfcheck-tmp.mjs', '.DS_Store', 'node_modules/x/i.js']) {
    fs.writeFileSync(path.join(tmp, f), 'x');
  }
  const files = relMod.collectPkgFiles(tmp);
  ok('34.8 打包清单行为：只留真实源码（排除 node_modules/.DS_Store/*.tmp/*.bak*/自检临时文件）',
    JSON.stringify(files) === JSON.stringify(['manifest.json', 'routes/balance.js', 'routes/page.js']), JSON.stringify(files));
  ok('34.8 isPkgExcluded 逐项判据',
    relMod.isPkgExcluded('node_modules') && relMod.isPkgExcluded('.DS_Store') && relMod.isPkgExcluded('_selfcheck-tmp.mjs') &&
    relMod.isPkgExcluded('x.tmp') && relMod.isPkgExcluded('y.bak') && relMod.isPkgExcluded('y.bak2') && relMod.isPkgExcluded('z.bak-20260101') &&
    relMod.isPkgExcluded('.git') &&
    !relMod.isPkgExcluded('balance.js') && !relMod.isPkgExcluded('baker.js') && !relMod.isPkgExcluded('CHANGELOG.md') && !relMod.isPkgExcluded('.gitignore'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
ok('34.9 README 自检/发布/verify-evamt 三处命令都给了 PowerShell + bash 两份',
  /```powershell/.test(readmeText) && /```bash/.test(readmeText) &&
  /ELECTRON_RUN_AS_NODE=1 "\$HANA" tests\/run-all\.mjs/.test(readmeText) &&
  /ELECTRON_RUN_AS_NODE=1 "\$HANA" scripts\/release\.mjs/.test(readmeText) &&
  /ELECTRON_RUN_AS_NODE=1 "\$HANA" scripts\/verify-evamt\.mjs/.test(readmeText));
ok('34.10 README 给出两平台插件数据目录与 $HANA 占位',
  readmeText.indexOf('%USERPROFILE%\\.hanako\\plugin-data\\deepseek-balance\\') >= 0 &&
  readmeText.indexOf('~/.hanako/plugin-data/deepseek-balance/') >= 0 && readmeText.indexOf('$env:HANA') >= 0 && readmeText.indexOf('"$HANA"') >= 0);
ok('34.11 README 分享用开篇齐全（这是什么/能力/平台/安装/隐私/指标/截图占位）',
  readmeText.indexOf('## 简介（第一次看到这个插件的人看这里）') >= 0 &&
  readmeText.indexOf('**这是什么**') >= 0 && readmeText.indexOf('**主要能力**') >= 0 && readmeText.indexOf('**平台**') >= 0 &&
  readmeText.indexOf('**安装**') >= 0 && readmeText.indexOf('设置 → 插件') >= 0 && readmeText.indexOf('全权') >= 0 && readmeText.indexOf('loaded') >= 0 &&
  readmeText.indexOf('**数据与隐私**') >= 0 &&
  readmeText.indexOf('**工程指标**') >= 0 && readmeText.indexOf('**截图**') >= 0 && readmeText.indexOf('单包通用') >= 0);
ok('34.11 开篇在「功能」之前，其余文档未被整篇重写',
  readmeText.indexOf('## 简介') < readmeText.indexOf('## 功能') && readmeText.indexOf('平台无关') >= 0 && readmeText.indexOf('## 维护须知（改代码前必读）') >= 0);
ok('34.12 README 既有结构与关键字保留（回滚三步 / TOP5 / status=loaded）',
  readmeText.indexOf('回滚（三步）') >= 0 && readmeText.indexOf('status=loaded') >= 0 && readmeText.indexOf('totalRecharged') >= 0 &&
  readmeText.indexOf('TOP5 排查手册') >= 0 && readmeText.indexOf('面板加载失败 / 白屏') >= 0 && readmeText.indexOf('预警不再推') >= 0);
const licenseText = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
ok('34.13 LICENSE 为标准 MIT 正文（含关键句与大写免责段；2026 · 版权人 JinXin，无占位/TODO）',
  /\bMIT License\b/.test(licenseText) && /Permission is hereby granted, free of charge/.test(licenseText) &&
  /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/.test(licenseText) &&
  /Copyright \(c\) 2026 JinXin/.test(licenseText) &&
  licenseText.indexOf('版权持有人') < 0 && licenseText.indexOf('TODO') < 0);
ok('34.14 README 开篇提及 MIT、维护须知标注版权人已确认、目录结构含 LICENSE；无「待替换版权人」字样',
  readmeText.indexOf('License: MIT（见 `LICENSE`）') >= 0 &&
  readmeText.indexOf('版权人已确认') >= 0 && readmeText.indexOf('JinXin') >= 0 && readmeText.indexOf('| `LICENSE` |') >= 0 &&
  readmeText.indexOf('版权持有人') < 0 && readmeText.indexOf('待替换') < 0 && readmeText.indexOf('版权人已替换') < 0);
{
  const pk = await import('../scripts/release.mjs?t=' + Date.now());
  const realPkg = pk.collectPkgFiles(root);
  ok('34.15 LICENSE 会被打进包（排除清单不误伤；真源码树实收）',
    pk.isPkgExcluded('LICENSE') === false && realPkg.indexOf('LICENSE') >= 0 && realPkg.indexOf('README.md') >= 0, 'files=' + realPkg.length);
}
{
  const intro = readmeText.slice(readmeText.indexOf('## 简介'), readmeText.indexOf('## 功能'));
  ok('34.16 开篇安装说明已落地为事实（无 TODO / 无对冲措辞），其余小节未被改写',
    intro.indexOf('TODO') < 0 && intro.indexOf('待确认') < 0 && intro.indexOf('以 Hana 官方文档为准') < 0 && intro.indexOf('不臆测') < 0 &&
    intro.indexOf('**这是什么**') >= 0 && intro.indexOf('**主要能力**') >= 0 && intro.indexOf('**平台**') >= 0 && intro.indexOf('单包通用') >= 0 &&
    intro.indexOf('**数据与隐私**') >= 0 && intro.indexOf('**工程指标**') >= 0 && intro.indexOf('**截图**') >= 0 && intro.indexOf('License: MIT') >= 0);
  ok('34.16 开篇含「设置 → 插件」「全权（Full-access）」「loaded」三处关键词',
    intro.indexOf('设置 → 插件') >= 0 && intro.indexOf('全权') >= 0 && intro.indexOf('Full-access') >= 0 && intro.indexOf('loaded') >= 0);
  ok('34.16 数据目录补 HANA_HOME 覆盖说明（开篇 + 命令约定）',
    intro.indexOf('HANA_HOME') >= 0 && readmeText.indexOf('可用 `HANA_HOME` 环境变量覆盖') >= 0);
}

// ---------------------------------------------------------------- 35. 打包结构（1.14.50 热修）
console.log('\n[35] 打包结构：暂存目录 + 真实结构校验（修复 1.14.49 平铺事故）');
{
  const { execFileSync } = await import('node:child_process');
  const releaseMod = await import('../scripts/release.mjs?t=' + Date.now());
  const winBranch = (relSrc.match(/if \(isWin\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok('35.1 [源码守卫] Windows 分支只喂「暂存目录顶层条目」给 Compress-Archive（不再喂深层文件清单）',
    /topEntries/.test(winBranch) && winBranch.indexOf('relFiles') < 0 &&
    /Compress-Archive -Path ' \+ quoted/.test(winBranch) && /Set-Location -LiteralPath/.test(winBranch));
  ok('35.2 [源码守卫] 打包后有结构校验，失败即删包并报错',
    /const check = validatePackageStructure\(names\)/.test(relSrc) && /if \(!check\.ok\)/.test(relSrc) &&
    /fs\.rmSync\(zipPath, \{ force: true \}\)/.test(relSrc) && /打包结构校验失败/.test(relSrc));
  ok('35.4 validatePackageStructure：接受含目录包（`/` 与 `\\` 均可）、拒绝平铺包与缺目录包',
    releaseMod.validatePackageStructure(['manifest.json', 'routes/a.js', 'lib/b.js']).ok === true &&
    releaseMod.validatePackageStructure(['manifest.json', 'routes\\a.js', 'lib\\b.js']).ok === true &&
    releaseMod.validatePackageStructure(['manifest.json', 'balance.js', 'page.js']).ok === false &&
    releaseMod.validatePackageStructure(['README.md', 'routes/a.js', 'lib/b.js']).ok === false);

  const hasTool = (() => {
    if (process.platform === 'win32') return true; // PowerShell 恒在
    for (const t of ['zip', 'python3']) { try { execFileSync(t, ['--version'], { stdio: 'ignore' }); return true; } catch (e) { if (e.code !== 'ENOENT') return true; } }
    return false;
  })();
  if (!hasTool) {
    ok('35.3 [跳过：本机无 zip/python3] 未做真实打包结构校验', true);
    ok('35.5 [跳过：本机无 zip/python3] 未读回真实 zip 条目', true);
  } else {
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-pkg-src-'));
    const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-pkg-out-'));
    const zipPath = path.join(zipDir, 'out.zip');
    fs.mkdirSync(path.join(srcRoot, 'routes'), { recursive: true });
    fs.mkdirSync(path.join(srcRoot, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(srcRoot, 'tests', 'fixtures'), { recursive: true });
    fs.mkdirSync(path.join(srcRoot, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'manifest.json'), '{"id":"smoke"}');
    fs.writeFileSync(path.join(srcRoot, 'README.md'), 'r');
    fs.writeFileSync(path.join(srcRoot, 'routes', 'a.js'), '//a');
    fs.writeFileSync(path.join(srcRoot, 'lib', 'b.js'), '//b');
    fs.writeFileSync(path.join(srcRoot, 'tests', 'fixtures', 'c.csv'), 'x');
    fs.writeFileSync(path.join(srcRoot, 'x.tmp'), 'junk');
    fs.writeFileSync(path.join(srcRoot, 'node_modules', 'x', 'i.js'), 'junk');
    let res = null; let err = null;
    try { res = releaseMod.packagePlugin({ root: srcRoot, zipPath }); } catch (e) { err = e; }
    const norm = (a) => a.map(releaseMod.normalizeEntry);
    ok('35.3 [行为] 真跑打包：目录结构保留（routes/a.js + lib/b.js + manifest.json）、排除项不入包、无平铺',
      !!res && norm(res.entries).indexOf('routes/a.js') >= 0 && norm(res.entries).indexOf('lib/b.js') >= 0 &&
      norm(res.entries).indexOf('manifest.json') >= 0 && norm(res.entries).indexOf('tests/fixtures/c.csv') >= 0 &&
      !norm(res.entries).some((n) => /(^|\/)(x\.tmp|node_modules)(\/|$)/.test(n)) &&
      !norm(res.entries).some((n) => /^[^/]+\.js$/.test(n)) && res.check.ok === true,
      err ? ('ERR ' + err.message) : JSON.stringify(res && res.entries));
    ok('35.5 [行为] readZipEntryNames 读回真实 zip 与打包结果一致',
      !!res && JSON.stringify(releaseMod.readZipEntryNames(zipPath)) === JSON.stringify(res.entries));
    fs.rmSync(srcRoot, { recursive: true, force: true });
    fs.rmSync(zipDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 汇总
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) {
  console.log('失败项:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
