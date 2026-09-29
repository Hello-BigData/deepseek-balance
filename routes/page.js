// 用量详情页路由
// 挂载路径：/api/plugins/deepseek-balance/page
// 是一个独立标签页（page contribution），不放侧边栏。
//
// 数据来源：本机 usage 账本（只含这台机器发出的请求），按小时/天聚合。
// 金额为估算：token × 官方单价（含高峰 / 空闲时段），不是官方账单数值。
//
// 安全边界：与 widget 相同，页面只通过本机插件路由取数，不含 API Key。
// 实现约束：零依赖、零外网、自绘 SVG，避免引入 CDN 或构建步骤。

// 共享层用带时间戳的动态 import 载入：插件重装时绕开 ESM 模块缓存。
// 否则会出现「routes 已更新、lib 还是旧版」的错位（实测会导致面板脚本抛错、连 ready 都发不出）。
const SHARED = await import('../lib/ui-shared.js?v=' + Date.now());
const SHARED_CSS = SHARED.SHARED_CSS;
const SHARED_JS = SHARED.SHARED_JS;
const SHARED_MODAL_HTML = SHARED.SHARED_MODAL_HTML;

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' http: https:; img-src 'self' data: http: https:; font-src 'self' data: http: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>用量详情</title>
<style>
${SHARED_CSS}
  /* 详情页附加变量：共享层已给出公共变量（含 --modal-max: 340px），这里只补配色与色列 */
  :root {
    --bg-page: #ffffff;
    --c1: #f59e0b;
    --c2: #3b82f6;
    --c3: #10b981;
    --c4: #8b5cf6;
    --c5: #ef4444;
    --c6: #0ea5e9;
    --modal-max: 340px;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg-page: transparent; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--bg-page); }
  body {
    color: var(--text-primary); font-size: 13px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  /* 字重口径：全局只用 Medium（500），层级靠字号/颜色区分 */
  .wrap { padding: 18px 20px 26px; max-width: 1180px; margin: 0 auto; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  /* .fpill 是 div[role=button][tabindex=0]，不命中上面的 button 规则，单独补焦点环（与 button 同风格） */
  .fpill:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  button:disabled { opacity: .55; cursor: default; }

  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 500; letter-spacing: .2px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); transition: background-color .2s ease; }
  .dot.ok { background: #30a46c; }
  .dot.err { background: var(--danger); }
  .sub { font-size: 11px; font-weight: 500; color: var(--text-tertiary); margin-left: 4px; }
  .controls { display: flex; align-items: center; gap: 10px; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; background: transparent; color: var(--text-secondary); font-size: 12px; padding: 5px 12px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button:hover { color: var(--text-primary); }
  .seg button.on { background: var(--accent); color: #fff; }
  .ghost {
    border: 1px solid var(--border); background: transparent; color: var(--text-secondary);
    border-radius: 8px; font-size: 12px; height: 28px; padding: 0 12px;
  }
  .ghost:hover { color: var(--accent); border-color: var(--accent); }

  /* ---- 时间维度筛选（对齐官网样式）---- */
  .fpill {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--panel-bg); border: 1px solid var(--border);
    border-radius: 8px; height: 30px; padding: 0 10px;
    font-size: 12px; color: var(--text-primary); cursor: pointer; user-select: none;
    transition: border-color .15s ease;
  }
  .fpill:hover { border-color: color-mix(in srgb, var(--border) 35%, var(--accent) 65%); }
  .fpill-key { color: var(--text-secondary); }
  .fpill-div { width: 1px; height: 14px; background: var(--border); }
  .fpill-caret { color: var(--text-tertiary); flex: none; }
  .reset-btn {
    border: 1px solid var(--border); background: transparent; color: var(--text-secondary);
    border-radius: 8px; font-size: 12px; height: 30px; padding: 0 12px; cursor: pointer;
  }
  .reset-btn:hover { color: var(--accent); border-color: var(--accent); }

  .pop {
    position: fixed; z-index: 60; background: var(--bg-card);
    border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
  }
  .pop[hidden] { display: none; }
  .dropdown { min-width: 150px; padding: 4px; }
  .dropdown button {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    width: 100%; border: 0; background: transparent; border-radius: 7px;
    font-size: 12.5px; color: var(--text-primary); padding: 7px 10px;
    cursor: pointer; text-align: left; font-family: inherit;
  }
  .dropdown button:hover { background: var(--panel-bg); }
  .dropdown .ck { display: none; color: var(--text-primary); font-size: 12px; }
  .dropdown button.on .ck { display: inline-block; }

  .calpanel { display: flex; padding: 10px; gap: 12px; }
  .cal-side {
    display: flex; flex-direction: column; min-width: 92px;
    border-right: 1px solid var(--border); padding-right: 10px;
  }
  .cal-side button {
    border: 0; background: transparent; text-align: left; font-size: 12.5px;
    color: var(--text-primary); padding: 7px 8px; border-radius: 7px;
    cursor: pointer; font-family: inherit;
  }
  .cal-side button:hover { background: var(--panel-bg); }
  .cal-side button.on { background: var(--panel-bg); color: var(--accent); }
  .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .cal-titles { display: flex; gap: 46px; font-size: 12.5px; color: var(--text-primary); }
  .cal-nav {
    border: 1px solid var(--border); background: transparent; border-radius: 7px;
    width: 24px; height: 24px; color: var(--text-secondary); cursor: pointer;
    font-size: 13px; line-height: 1; font-family: inherit;
  }
  .cal-nav:hover { color: var(--accent); border-color: var(--accent); }
  .cal-grids { display: flex; gap: 26px; }
  .cal-month table { border-collapse: collapse; }
  .cal-month th {
    font-size: 10.5px; color: var(--text-tertiary); font-weight: 500;
    padding: 0 0 4px; width: 30px; text-align: center;
  }
  .cal-day {
    width: 30px; height: 28px; font-size: 12px; color: var(--text-primary);
    border: 0; background: transparent; cursor: pointer; font-family: inherit;
    font-variant-numeric: tabular-nums;
  }
  .cal-day:hover { background: var(--panel-bg); }
  .cal-day.out { color: var(--text-tertiary); opacity: .45; }
  .cal-day.future { color: var(--text-tertiary); opacity: .35; cursor: default; }
  .cal-day.future:hover { background: transparent; }
  .cal-day.inrange { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .cal-day.edge { background: var(--text-primary); color: #fff; border-radius: 6px; }
  .cal-day.edge:hover { background: var(--text-primary); }
  .cal-foot { font-size: 11px; color: var(--text-tertiary); margin-top: 8px; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .card { background: var(--panel-bg); border-radius: 12px; padding: 14px 16px; }
  .card .k { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
  /* 极长值：不折行、超长省略；min-width:0 让它在外层容器里也能收缩（与金额/单位那套一致） */
  .card .v { font-size: 26px; font-weight: 500; letter-spacing: -.2px; font-variant-numeric: tabular-nums; margin-top: 6px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .s { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; font-variant-numeric: tabular-nums; }
  .tag { font-size: 10px; font-weight: 500; letter-spacing: .2px; color: var(--c1); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
  .tag.hint { color: var(--accent); border-color: currentColor; }

  .panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px 10px; margin-bottom: 14px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .panel-title { font-size: 13.5px; font-weight: 500; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--text-secondary); margin-bottom: 6px; }
  .legend .item { display: flex; align-items: center; gap: 5px; }
  .swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }
  .chart svg { display: block; width: 100%; height: auto; }

  .facets { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .facet { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px 8px; }
  .facet-head { display: flex; align-items: center; gap: 7px; font-weight: 500; font-size: 13.5px; }
  .facet-head .swatch { width: 10px; height: 10px; }
  .fstats { display: flex; gap: 16px; margin: 8px 0 2px; flex-wrap: wrap; }
  .fstats div { display: flex; flex-direction: column; }
  .fstats em { font-style: normal; font-size: 10px; color: var(--text-tertiary); }
  .fstats b { font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fmeta { font-size: 11px; color: var(--text-tertiary); margin-top: 6px; font-variant-numeric: tabular-nums; }
  .fmini svg { display: block; width: 100%; height: auto; }

  .notice { display: none; font-size: 12px; border-radius: 9px; padding: 8px 12px; margin-bottom: 12px; line-height: 1.5; }
  .notice.warn { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent); }
  .notice.info { color: var(--text-primary); background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent); }

  /* 弹窗样式见共享层 lib/ui-shared.js */
  .ghost:disabled { opacity: .5; cursor: default; }
  .empty { color: var(--text-tertiary); font-size: 12px; padding: 22px 0; text-align: center; }
  .foot { color: var(--text-tertiary); font-size: 11px; line-height: 1.7; border-top: 1px solid var(--border); padding-top: 10px; }
  /* ---- 官方数据同步面板 ---- */
  .sync-panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; }
  .sync-panel[hidden] { display: none; }
  .rq-head { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; line-height: 1.6; }
  .rq-head b { color: var(--text-primary); font-weight: 500; }
  .rq-totals { display: flex; gap: 18px; flex-wrap: wrap; margin: 8px 0; }
  .rq-totals div { display: flex; flex-direction: column; min-width: 0; }
  .rq-totals em { font-style: normal; font-size: 10px; color: var(--text-tertiary); }
  .rq-totals b { font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rq-table { width: 100%; border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
  .rq-table th, .rq-table td { text-align: right; padding: 3px 6px; border-top: 1px solid var(--border); white-space: nowrap; }
  .rq-table th:first-child, .rq-table td:first-child { text-align: left; }
  .rq-table thead th { color: var(--text-tertiary); font-weight: 500; border-top: 0; }
  .rq-fold { font-size: 11px; color: var(--text-tertiary); margin-top: 5px; }
  .rq-sub { font-size: 11px; color: var(--text-tertiary); margin: 10px 0 4px; }
  .rq-concl { font-size: 11px; color: var(--text-secondary); margin-top: 5px; line-height: 1.7; }
  .foot b { color: var(--text-secondary); font-weight: 500; }
  .skeleton { color: var(--text-tertiary); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <span class="dot" id="dot"></span>
        <span>DeepSeek 用量详情</span>
        <span class="sub" id="stamp"></span>
      </div>
      <div class="controls">
        <div class="fpill" id="timePill" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
          <span class="fpill-key">时间维度</span>
          <span class="fpill-div"></span>
          <span class="fpill-val" id="timeVal">近 30 天</span>
          <svg class="fpill-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <button type="button" class="reset-btn" id="resetBtn" hidden>重置筛选条件</button>
        <button type="button" class="ghost" id="exportBtn" hidden>导出 CSV</button>
        <button type="button" class="ghost" id="syncBtn">导入官方 CSV 同步</button>
        <button type="button" class="ghost" id="refreshBtn">刷新</button>
      </div>
    </div>

    <div class="pop dropdown" id="timeDrop" hidden role="menu">
      <button type="button" data-range="today"><span>今天</span><span class="ck">✓</span></button>
      <button type="button" data-range="yesterday"><span>昨天</span><span class="ck">✓</span></button>
      <button type="button" data-range="7d"><span>近 7 天</span><span class="ck">✓</span></button>
      <button type="button" data-range="30d"><span>近 30 天</span><span class="ck">✓</span></button>
      <button type="button" data-range="thisMonth"><span>本月</span><span class="ck">✓</span></button>
      <button type="button" data-range="lastMonth"><span>上月</span><span class="ck">✓</span></button>
      <button type="button" data-range="all"><span>全部</span><span class="ck">✓</span></button>
      <button type="button" data-range="custom"><span>自定义</span><span class="ck">✓</span></button>
    </div>

    <div class="pop calpanel" id="calPanel" hidden>
      <div class="cal-side" id="calSide">
        <button type="button" data-range="today">今天</button>
        <button type="button" data-range="yesterday">昨天</button>
        <button type="button" data-range="7d">近 7 天</button>
        <button type="button" data-range="30d">近 30 天</button>
        <button type="button" data-range="thisMonth">本月</button>
        <button type="button" data-range="lastMonth">上月</button>
        <button type="button" data-range="all">全部</button>
        <button type="button" data-range="custom" class="on">自定义</button>
      </div>
      <div class="cal-main">
        <div class="cal-head">
          <button type="button" class="cal-nav" id="calPrev" aria-label="上个月">‹</button>
          <div class="cal-titles" id="calTitles"></div>
          <button type="button" class="cal-nav" id="calNext" aria-label="下个月">›</button>
        </div>
        <div class="cal-grids" id="calGrids"></div>
        <div class="cal-foot" id="calHint">在右侧选择起始与结束日期</div>
      </div>
    </div>

    <div class="notice warn" id="notice"></div>
    <div class="notice info" id="unpricedNote"></div>
    <div class="notice warn" id="coverageNote"></div>

    <div class="cards">
      <div class="card">
        <div class="k">API 请求次数</div>
        <div class="v skeleton" id="kReq">--</div>
        <div class="s" id="kReqSub"></div>
      </div>
      <div class="card">
        <div class="k">Tokens</div>
        <div class="v skeleton" id="kTok">--</div>
        <div class="s" id="kTokSub"></div>
      </div>
      <div class="card">
        <div class="k">消费金额 <span class="tag">估算</span></div>
        <div class="v skeleton" id="kCost">--</div>
        <div class="s" id="kCostSub"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title" id="chartTitle">按小时分布</div>
        <div class="seg" id="metricSeg">
          <button type="button" data-metric="cost" class="on">消费金额</button>
          <button type="button" data-metric="requests">请求次数</button>
          <button type="button" data-metric="tokens">Tokens</button>
        </div>
      </div>
      <div class="legend" id="legend"></div>
      <div class="chart" id="chart"><div class="empty">正在读取账本…</div></div>
    </div>

    <div class="facets" id="facets"></div>

    <div class="sync-panel" id="syncPanel" hidden></div>
    <input type="file" id="syncFile" accept=".zip,.csv" hidden />

    <div class="foot" id="foot"></div>
  </div>
${SHARED_MODAL_HTML}

<script>${SHARED_JS}</script>
<script>
(function () {
  "use strict";

  // 共享层（lib/ui-shared.js 已注入）：宿主通信、转义、时区标签、弹窗
  var id = HPU.id, qs = HPU.qs, pad2 = HPU.pad2, genId = HPU.genId, post = HPU.post;
  var getHostOrigin = HPU.getHostOrigin, getPluginId = HPU.getPluginId, getSurfaceSession = HPU.getSurfaceSession;
  var esc = HPU.esc, sendReady = HPU.sendReady, tzLabel = HPU.tzLabel;
  var hostRequest = HPU.hostRequest, externalOpen = HPU.externalOpen;
  var openModal = HPU.openModal, closeModal = HPU.closeModal;

  // 未捕获错误兜底：在面板内显示可读提示，而不是白屏让宿主判成「加载失败」。
  // typeof 防御：若共享层与面板脚本出现版本错位，降级成「无兜底」而不是直接报错。
  if (typeof HPU.installErrorTraps === "function") {
    HPU.installErrorTraps(function (msg) {
      try { reportClientError(msg); } catch (e) { /* 展示失败不再抛 */ }
    });
  }

  var COLORS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"];
  var TZ_CHANNEL = "hana-plugin:deepseek-balance";
  var METRIC_LABEL = { cost: "消费金额（估算）", requests: "请求次数", tokens: "Tokens" };
  var state = { range: "30d", from: null, to: null, keyName: "本机 Key", metric: "cost", data: null, inFlight: false, pending: false, timer: null, calMonth: null, selFrom: null, selTo: null, picking: false };

  function colorOf(i) { return "var(" + COLORS[i % COLORS.length] + ")"; }
  function fmtInt(v) {
    var n = Number(v);
    if (!isFinite(n)) return "--";
    return String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  }
  function fmtMoney(v) {
    var n = Number(v);
    if (!isFinite(n)) return "--";
    if (n === 0) return "¥0";
    if (Math.abs(n) < 0.01) return "¥" + n.toFixed(4);
    return "¥" + n.toFixed(2);
  }
  // 纵轴刻度：根据量级选小数位，避免出现 ¥0.3522 这种刻度
  function fmtAxis(v, metric, max) {
    if (metric !== "cost") return fmtInt(v);
    if (!(v > 0)) return "¥0";
    if (max >= 10) return "¥" + v.toFixed(0);
    if (max >= 1) return "¥" + v.toFixed(2);
    if (max >= 0.1) return "¥" + v.toFixed(3);
    return "¥" + v.toFixed(4);
  }
  function fmtMetric(v, metric) {
    if (metric === "cost") return fmtMoney(v);
    return fmtInt(v);
  }
  function modelValue(bm, metric) {
    if (!bm) return 0;
    if (metric === "cost") return bm.cost || 0;
    if (metric === "requests") return bm.requests || 0;
    return bm.tokens || 0;
  }
  function labelOf(t, bucketMs, tzMin) {
    var tz = Number.isFinite(Number(tzMin)) ? Number(tzMin) : -new Date().getTimezoneOffset();
    var d = new Date(t + tz * 60000);
    if (bucketMs < 86400000) return pad2(d.getUTCHours()) + ":00";
    if (bucketMs < 28 * 86400000) return (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
    return d.getUTCFullYear() + "/" + (d.getUTCMonth() + 1); // 月粒度：标签即该桶起点（年月）
  }
  function stampText() {
    // 「更新于」统一按北京时间显示（与高峰价判定同一基准），不受本机时区影响
    var d = new Date(Date.now() + 8 * 3600 * 1000);
    return "更新于 " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
  }

  var API_TIMEOUT_MS = 15000; // 单次接口请求上限：超时按读取失败处理，避免界面一直等

  // 带超时的插件 API 请求：路径经共享层 HPU.api 规范并注入 surface session
  function apiFetchWithTimeout(path, opt) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    var o = opt ? Object.assign({}, opt) : {};
    if (ctrl) {
      o.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }, API_TIMEOUT_MS);
    }
    var req;
    try {
      req = HPU.api.fetch(path, o);
    } catch (e) {
      if (timer) clearTimeout(timer);
      return Promise.reject(e);
    }
    return req.then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json().catch(function () { return null; });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (ctrl && e && e.name === "AbortError") return null; // 超时视为无数据，交给调用方处理
      throw e;
    });
  }

  function apiGet(path) {
    var sep = path.indexOf("?") >= 0 ? "&" : "?";
    return apiFetchWithTimeout(path + sep + "_t=" + Date.now(), { method: "GET" });
  }

  function apiPost(path, body) {
    return apiFetchWithTimeout(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  // 导出专用：需同时拿到 HTTP 状态与响应体 —— 非 2xx 时也要读 body 里的 error/message，
  // 否则一旦后端改成 4xx/5xx，前端就会变成「静默失败」。
  function apiPostRaw(path, body) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    var o = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) };
    if (ctrl) { o.signal = ctrl.signal; timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }, API_TIMEOUT_MS); }
    var req;
    try { req = HPU.api.fetch(path, o); } catch (e) { if (timer) clearTimeout(timer); return Promise.reject(e); }
    return req.then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, ok: r.ok, body: j }; });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (ctrl && e && e.name === "AbortError") return { status: 0, ok: false, body: null, timeout: true };
      throw e;
    });
  }

  // ---------------------------------------------------------------- 图表

  function barsSvg(buckets, models, metric, opt) {
    var W = opt.width, H = opt.height;
    var padL = opt.padL, padR = 6, padT = 10, padB = opt.padB;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var n = buckets.length;
    var max = 0;
    for (var i = 0; i < n; i += 1) {
      var sum = 0;
      for (var mj = 0; mj < models.length; mj += 1) {
        sum += modelValue(buckets[i].byModel && buckets[i].byModel[models[mj].id], metric);
      }
      if (sum > max) max = sum;
    }
    if (!(max > 0)) max = 1;
    var bw = innerW / Math.max(1, n);
    var barW = Math.max(1.5, Math.min(opt.maxBarW, bw * 0.66));

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + METRIC_LABEL[metric] + '">');
    // 网格与 y 轴刻度
    var ticks = 4;
    for (var t = 0; t <= ticks; t += 1) {
      var y = padT + innerH - (innerH * t) / ticks;
      var val = (max * t) / ticks;
      svg.push('<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>');
      svg.push('<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="var(--text-tertiary)">' + fmtAxis(val, metric, max) + '</text>');
    }
    // 柱
    var xLabelEvery = n <= 8 ? 1 : (n <= 26 ? 3 : 5);
    for (var k = 0; k < n; k += 1) {
      var b = buckets[k];
      var cx = padL + k * bw + bw / 2;
      var x = cx - barW / 2;
      var acc = 0;
      for (var mi = 0; mi < models.length; mi += 1) {
        var mv = modelValue(b.byModel && b.byModel[models[mi].id], metric);
        if (!(mv > 0)) continue;
        var h = (mv / max) * innerH;
        var y0 = padT + innerH - acc - h;
        var title = labelOf(b.t, opt.bucketMs, opt.tzMin) + " · " + esc(models[mi].id) + " · " + fmtMetric(mv, metric);
        svg.push('<rect x="' + x.toFixed(1) + '" y="' + y0.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(0.6, h).toFixed(1) + '" rx="1.5" fill="' + colorOf(mi) + '"><title>' + title + '</title></rect>');
        acc += h;
      }
      if (k % xLabelEvery === 0) {
        svg.push('<text x="' + cx.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="9" fill="var(--text-tertiary)">' + labelOf(b.t, opt.bucketMs, opt.tzMin) + '</text>');
      }
    }
    svg.push('</svg>');
    return svg.join("");
  }

  // 价格来源一行：让「自动同步是否成功」对用户可见（失败也说明原因，且仍能正常估算）
  function priceSyncLine(d) {
    var ps = d && d.priceSync ? d.priceSync : null;
    if (!ps) return '';
    if (!ps.ok) {
      return '<b>价格同步</b>：未能从官方价格页同步（' + esc(ps.reason || '未知原因') + '），当前使用内置价目表；一旦同步成功会自动跟上。<br>';
    }
    var mins = ps.at ? Math.max(0, Math.round((Date.now() - ps.at) / 60000)) : null;
    var when = mins === null ? '' : (mins < 1 ? '刚刚' : mins + ' 分钟前');
    return '<b>价格同步</b>：已从官方价格页自动同步 ' + fmtInt(ps.models) + ' 个型号（' + when + '）；官方改价或新增型号无需你手动处理。<br>';
  }

  // 型号变动一行：最近一次官方价格页型号变动的方向与时间（常驻可复查；不影响 toast 的 ACK 逻辑）。
  // 「已阅」只压 toast，不隐藏本行 —— 错过 toast 后仍可在这里复查。
  function priceChangeLine(d) {
    var pc = d && d.priceChange ? d.priceChange : null;
    if (!pc || !pc.at) return '';
    var parts = [];
    if (pc.added && pc.added.length) parts.push('新增 ' + pc.added.join('、'));
    if (pc.removed && pc.removed.length) parts.push('移除 ' + pc.removed.join('、'));
    if (!parts.length) return '';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    // 按**展示时区**格式化（与页面其余时间同源：tzMinutes()，含 -1 跟随本机）——
    // 原实现用浏览器本地时区，与「所有日期均按 XX 时间显示」的口径矛盾。
    var dt = new Date(Number(pc.at) + tzMinutes() * 60000);
    var when = isFinite(dt.getTime())
      ? (dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()) + ' ' + pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes()))
      : '';
    return '<b>型号变动</b>：' + esc(parts.join('；')) + (when ? '（' + esc(when) + '）' : '') +
      '。已自动采用新价格；此处为最近一次变动，可复查。<br>';
  }

  // 账本容量一行：宿主账本有 5000 条上限，满了会滚掉最早的记录；
  // 这是插件能可靠判定的一类「数据不完整」，其余（如宿主漏记某次请求）本地无从判定，不告警。
  function ledgerLine(d) {
    var lg = d && d.ledger ? d.ledger : null;
    if (!lg || !lg.entries || !lg.truncated) return '';
    var when = '';
    if (lg.oldestAt) {
      var t = Date.parse(lg.oldestAt);
      if (isFinite(t)) {
        var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
        when = '（当前最早一条 ' + (mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前') + '）';
      }
    }
    return '<b>账本容量</b>：宿主用量账本已满上限 ' + fmtInt(lg.maxEntries) + ' 条，更早的记录会被滚出去' + when +
      '；插件会把滚出去的记录接进本机归档（见下一行），不影响计价口径。<br>';
  }

  // 用量归档一行：宿主 5000 上限插件改不了，但插件**自己接住**滚出去的记录（跨过上限）。
  function archiveLine(d) {
    var a = d && d.ledger && d.ledger.archive ? d.ledger.archive : null;
    if (!a || !a.count) return '';
    var when = '';
    if (a.oldestAt) {
      var t = Date.parse(a.oldestAt);
      if (isFinite(t)) {
        var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
        when = '（最早 ' + (mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前') + '）';
      }
    }
    return '<b>用量归档</b>：本机已接住宿主账本上限之外的记录，当前 ' + fmtInt(a.count) + ' / ' + fmtInt(a.cap) + ' 条' + when +
      (a.full ? '；归档已到上限，更早的会被丢弃（可导入官方数据同步补全累计）。' : '；「全部」区间可跨过宿主 5000 上限。') + '<br>';
  }

  function render() {
    var d = state.data;
    if (!d) return;
    var metric = state.metric;
    var cal = Number(d.calibration) || 1;
    var tz = Number.isFinite(Number(d.tzMinutes)) ? Number(d.tzMinutes) : -new Date().getTimezoneOffset();
    var mNames = d.models.map(function (m) { return m.id; });
    var mList = d.models.map(function (m, i) { return { id: m.id, colorIdx: i }; });

    id("kReq").textContent = fmtInt(d.totals.requests);
    id("kReqSub").textContent = mNames.length ? mNames.join(" · ") : "";
    id("kTok").textContent = fmtInt(d.totals.tokens);
    id("kTokSub").textContent = "输入命中 " + fmtInt(d.totals.hit) + " · 未命中 " + fmtInt(d.totals.miss) + " · 输出 " + fmtInt(d.totals.output);
    id("kCost").textContent = fmtMoney(d.totals.cost);
    // 高峰金额的来源：本机小时级记录按钟点算；官方若给的是小时桶，也能拆出高峰段（peakFrom 标明）。
    // 全官方且只有按日汇总时拆不出高峰 —— 如实说「不可分」，不亮误导性的 ¥0。
    var peakKnown = d.totals.peakKnown === true || Number(d.totals.localCount) > 0;
    var peakFrom = d.totals.peakFrom || "local";
    var peakText;
    if (peakKnown) {
      var peakPct = d.totals.cost > 0 ? Math.round((d.totals.costPeak / d.totals.cost) * 100) : 0;
      var peakNote = peakFrom === "official" ? "，官方小时数据"
        : (peakFrom === "mixed" ? "，含官方小时数据"
          : (d.official && Number(d.totals.localSkipped) > 0 ? "，仅本机记录" : ""));
      peakText = "高峰时段 " + fmtMoney(d.totals.costPeak) + "（占 " + peakPct + "%" + peakNote + "）";
    } else if (d.official) {
      peakText = "高峰金额：官方只给按日汇总，不可分";
    } else {
      peakText = "高峰时段 " + fmtMoney(0) + "（占 0%）";
    }
    id("kCostSub").textContent = peakText + " · 校准 ×" + cal;

    var granText = d.bucketMs < 86400000 ? "按小时" : (d.bucketMs < 7 * 86400000 ? "按天" : (d.bucketMs < 28 * 86400000 ? "按周" : "按月"));
    id("chartTitle").textContent = rangeLabel() + " · " + granText + " · " + METRIC_LABEL[metric];

    var legend = mList.map(function (m) {
      return '<span class="item"><span class="swatch" style="background:' + colorOf(m.colorIdx) + '"></span>' + esc(m.id) + '</span>';
    }).join("");
    id("legend").innerHTML = legend;

    if (!d.totals.requests) {
      id("chart").innerHTML = '<div class="empty">该区间没有记录</div>';
    } else {
      id("chart").innerHTML = barsSvg(d.buckets, mList, metric, {
        width: 900, height: 230, padL: 54, padB: 20, maxBarW: 22, bucketMs: d.bucketMs, tzMin: tz,
      });
    }

    var facets = d.models.map(function (m, i) {
      var mini = d.totals.requests
        ? barsSvg(d.buckets, [{ id: m.id }], metric, { width: 420, height: 96, padL: 40, padB: 16, maxBarW: 12, bucketMs: d.bucketMs, tzMin: tz })
        : "";
      return '<div class="facet">' +
        '<div class="facet-head"><span class="swatch" style="background:' + colorOf(i) + '"></span>' + esc(m.id) + '</div>' +
        '<div class="fstats">' +
          '<div><em>请求次数</em><b>' + fmtInt(m.requests) + '</b></div>' +
          '<div><em>Tokens</em><b>' + fmtInt(m.tokens) + '</b></div>' +
          '<div><em>估算金额</em><b>' + (m.unpriced ? "单价未收录" : fmtMoney(m.cost)) + '</b></div>' +
        '</div>' +
        '<div class="fmini">' + mini + '</div>' +
        '<div class="fmeta">命中 ' + fmtInt(m.hit) + ' · 未命中 ' + fmtInt(m.miss) + ' · 输出 ' + fmtInt(m.output) + '</div>' +
        '<div class="fmeta">金额构成：命中 ' + fmtMoney(m.costHit) + ' · 未命中 ' + fmtMoney(m.costMiss) + ' · 输出 ' + fmtMoney(m.costOut) +
          (m.costPeak > 0 ? ' · 其中高峰 ' + fmtMoney(m.costPeak) + '（' + Math.round((m.costPeak / (m.cost || 1)) * 100) + '%）' : '') + '</div>' +
      '</div>';
    }).join("");
    id("facets").innerHTML = facets;

    var prices = d.prices || {};
    var flash = prices["deepseek-flash"] || {};
    var pro = prices["deepseek-v4-pro"] || {};
    id("foot").innerHTML =
      '<b>数据来源</b>：本机 usage 账本，只覆盖这台机器上发出的请求（别的客户端共用同一个 key 不会计入）。<br>' +
      (d.official
        ? '<b>官方数据已介入</b>：' + esc(d.official.from) + " ~ " + esc(d.official.to) +
          ' 这 ' + fmtInt(d.official.days) + ' 天改用官方账单（含全部客户端）；' +
          (d.official.granularity === "hour"
            ? '官方给的是<b>按小时</b>汇总，已直接并入下方小时柱状图与高峰金额；官方区间之外的仍是本机账本估算。<br>'
            : (d.official.granularity === "mixed"
              ? '官方混合给了「按小时」与「按日」两种粒度：按小时的那部分能拆进小时柱与高峰金额，按日的只能按「天」呈现。<br>'
              : '官方只给「按日」汇总，官方覆盖的部分因此改按「天」呈现，峰值高峰金额无法再拆分。官方区间之外的仍是本机账本估算。<br>'))
        : '') +
      '<b>金额为估算</b>：官方价目表 token × 单价（高峰时段双倍），再乘校准系数 ×' + cal +
        '（token 口径已与官方账单逐项核对，默认 1，无需调整；一切以官方账单为准）。<br>' +
      '<b>空闲时段单价</b>（元/百万 tokens，命中/未命中/输出）：flash ' + (flash.hit || 0) + ' / ' + (flash.miss || 0) + ' / ' + (flash.output || 0) +
      '；v4-pro ' + (pro.hit || 0) + ' / ' + (pro.miss || 0) + ' / ' + (pro.output || 0) + '。单价自动同步自官方价格页，失败时回退内置价目表。<br>' +
      priceSyncLine(d) +
      priceChangeLine(d) +
      ledgerLine(d) +
      archiveLine(d) +
      '<b>时区</b>：' + tzLabel(tz) +
        '（可在侧边栏「⋯」切换，注意高峰价判定始终按北京时间）。<br>' +
      '<b>口径</b>：v4-flash、v4-flash-vision-exp 等旧模型名已归入 flash（官方按 Flash 价计费）。内置价目表仅为离线兜底，实时价以自动同步（官方价格页）为准。<br>' +
      '<b>API Key</b>：本机账本不记录每次请求使用的 Key，当前只统计插件配置中的这一把（' + esc(state.keyName) + '）。';

    reportHeight();
    syncExportBtn();

    // 未收录单价的型号：token 照实展示，金额不计入合计 —— 在页面顶部说清楚，避免把“未知”读成“零消费”
    var up = d.unpriced || { requests: 0, models: [] };
    var note = id("unpricedNote");
    if (up.requests > 0) {
      var names = (up.models || []).map(function (mm) {
        return mm.id + "（" + fmtInt(mm.requests) + " 次）";
      }).join("、");
      note.textContent = "有 " + fmtInt(up.requests) + " 次请求的模型单价未收录，其金额未计入合计：" + names +
        "。可在插件设置里按「型号=命中/未命中/输出」补充单价（名称以 * 结尾表示按前缀匹配）。";
      note.style.display = "block";
    } else {
      note.textContent = "";
      note.style.display = "none";
    }

    // 节假日表未覆盖当前年份：明确告示（相关时段金额可能高估约 2×），不静默。
    var cov = d.holidayCoverage;
    var covNote = id("coverageNote");
    if (cov && cov.covered === false && cov.message) {
      covNote.textContent = cov.message;
      covNote.style.display = "block";
    } else {
      covNote.textContent = "";
      covNote.style.display = "none";
    }
  }

  function reportHeight() {
    requestAnimationFrame(function () {
      var h = Math.ceil(document.documentElement.scrollHeight);
      if (h > 0) post({ protocol: "hana.plugin.ui", version: 1, id: genId(), kind: "event", type: "ui.resize", payload: { height: h } });
    });
  }

  function showError(message) {
    id("dot").className = "dot err";
    var n = id("notice");
    n.className = "notice warn";
    n.textContent = message;
    n.style.display = "block";
  }

  // 面板内异常回传：与路由同一条日志渠道（POST /api/client-error），并附短错误码。回传失败不阻塞展示。
  function reportClientError(message) {
    var code = "E" + Date.now().toString(36).slice(-5).toUpperCase();
    try {
      apiPost("/api/client-error", { code: code, message: String(message === undefined || message === null ? "" : message) })
        .catch(function () { /* 回传失败不阻塞 */ });
    } catch (e) { /* HPU.api 不可用时忽略 */ }
    showError(message + "（错误码 " + code + "）");
    return code;
  }

  function clearError() {
    var n = id("notice");
    n.className = "notice warn";
    n.textContent = "";
    n.style.display = "none";
  }

  // 弹窗实现见共享层（HPU.openModal / HPU.closeModal，上方已有别名）

  async function load() {
    if (state.inFlight) { state.pending = true; return; }
    state.inFlight = true;
    id("refreshBtn").disabled = true;
    try {
      var params = "range=" + encodeURIComponent(state.range);
      if (state.range === "custom" && state.from && state.to) {
        params += "&from=" + encodeURIComponent(state.from) + "&to=" + encodeURIComponent(state.to);
      }
      var json = await apiGet("/api/stats?" + params);
      if (json && json.ok && json.data) {
        state.data = json.data;
        clearError();
        id("dot").className = "dot ok";
        id("stamp").textContent = stampText();
        render();
      } else {
        showError((json && json.message) || "读取用量数据失败");
        id("dot").className = "dot err";
      }
    } catch (e) {
      showError("读取用量数据失败：" + (e && e.message ? e.message : String(e)));
      id("dot").className = "dot err";
    } finally {
      state.inFlight = false;
      id("refreshBtn").disabled = false;
      if (state.pending) { state.pending = false; load(); }
    }
  }

  // ---------------------------------------------------------------- 交互

  // ---------------------------------------------------------------- 时间维度筛选

  var RANGE_LABEL = { today: "今天", yesterday: "昨天", "7d": "近 7 天", "30d": "近 30 天", thisMonth: "本月", lastMonth: "上月", custom: "自定义", all: "全部" };

  function tzMinutes() {
    var d = state.data;
    return Number.isFinite(Number(d && d.tzMinutes)) ? Number(d.tzMinutes) : -new Date().getTimezoneOffset();
  }
  function dayKey(ms) {
    var d = new Date(ms + tzMinutes() * 60000);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }
  function todayKey() { return dayKey(Date.now()); }
  function rangeLabel() {
    if (state.range === "custom" && state.from && state.to) {
      return state.from.replace(/-/g, "/") + " - " + state.to.replace(/-/g, "/");
    }
    return RANGE_LABEL[state.range] || "近 30 天";
  }
  function isDefaultFilter() { return state.range === "30d" && !state.from && !state.to; }

  function syncFilterUI() {
    id("timeVal").textContent = rangeLabel();
    id("resetBtn").hidden = isDefaultFilter();
    var active = state.picking ? "custom" : state.range;
    Array.prototype.forEach.call(document.querySelectorAll("#timeDrop button[data-range]"), function (b) {
      b.className = b.getAttribute("data-range") === active ? "on" : "";
    });
    Array.prototype.forEach.call(document.querySelectorAll("#calSide button[data-range]"), function (b) {
      b.className = b.getAttribute("data-range") === active ? "on" : "";
    });
  }

  function closePops() {
    id("timeDrop").hidden = true;
    id("calPanel").hidden = true;
    id("timePill").setAttribute("aria-expanded", "false");
    if (state.picking) { state.picking = false; syncFilterUI(); }
  }

  function placePop(popEl, anchorEl) {
    popEl.hidden = false;
    var a = anchorEl.getBoundingClientRect();
    popEl.style.left = Math.round(a.left) + "px";
    popEl.style.top = Math.round(a.bottom + 6) + "px";
    var r = popEl.getBoundingClientRect();
    var maxLeft = Math.max(8, window.innerWidth - r.width - 8);
    if (r.left > maxLeft) popEl.style.left = Math.round(maxLeft) + "px";
    if (r.top + r.height > window.innerHeight - 8) {
      popEl.style.top = Math.round(Math.max(8, a.top - r.height - 6)) + "px";
    }
    anchorEl.setAttribute("aria-expanded", "true");
  }

  function applyRange(range, from, to) {
    state.range = range;
    state.from = range === "custom" ? (from || null) : null;
    state.to = range === "custom" ? (to || null) : null;
    closePops();
    syncFilterUI();
    id("chart").innerHTML = '<div class="empty">正在读取账本…</div>';
    load();
  }

  // ---- 双月日历 ----
  function monthCells(year, month) {
    var first = new Date(Date.UTC(year, month, 1));
    var startDow = first.getUTCDay();
    var cells = [];
    for (var i = 0; i < 42; i += 1) {
      var d = new Date(Date.UTC(year, month, 1 - startDow + i));
      cells.push({ k: d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()), day: d.getUTCDate(), out: d.getUTCMonth() !== month });
    }
    return cells;
  }

  function normMonth(m) {
    var y = m.y, mm = m.m;
    while (mm < 0) { mm += 12; y -= 1; }
    while (mm > 11) { mm -= 12; y += 1; }
    return { y: y, m: mm };
  }

  function renderCal() {
    if (!state.calMonth) {
      var t = new Date(Date.now() + tzMinutes() * 60000);
      state.calMonth = normMonth({ y: t.getUTCFullYear(), m: t.getUTCMonth() - 1 });
    }
    state.calMonth = normMonth(state.calMonth);
    var m1 = state.calMonth;
    var m2 = normMonth({ y: m1.m === 11 ? m1.y + 1 : m1.y, m: m1.m === 11 ? 0 : m1.m + 1 });
    var months = [m1, m2];
    id("calTitles").innerHTML = months.map(function (m) { return "<span>" + m.y + "年" + (m.m + 1) + "月</span>"; }).join("");
    var today = todayKey(), from = state.selFrom, to = state.selTo;
    id("calGrids").innerHTML = months.map(function (m) {
      var head = ["日", "一", "二", "三", "四", "五", "六"].map(function (w) { return "<th>" + w + "</th>"; }).join("");
      var cells = monthCells(m.y, m.m);
      var rows = "";
      for (var r = 0; r < 6; r += 1) {
        rows += "<tr>";
        for (var c = 0; c < 7; c += 1) {
          var cell = cells[r * 7 + c];
          var cls = "cal-day";
          if (cell.out) cls += " out";
          if (cell.k > today) cls += " future";
          if (from && to && cell.k >= from && cell.k <= to) cls += " inrange";
          if ((from && cell.k === from) || (to && cell.k === to)) cls += " edge";
          rows += '<td><button type="button" class="' + cls + '" data-day="' + cell.k + '">' + cell.day + "</button></td>";
        }
        rows += "</tr>";
      }
      return '<div class="cal-month"><table><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>";
    }).join("");
  }

  function pickDay(key) {
    if (!key || key > todayKey()) return;
    if (!state.selFrom || (state.selFrom && state.selTo)) {
      state.selFrom = key;
      state.selTo = null;
      id("calHint").textContent = "再选一个结束日期";
      renderCal();
      return;
    }
    if (key >= state.selFrom) state.selTo = key;
    else state.selFrom = key;
    applyRange("custom", state.selFrom, state.selTo || state.selFrom);
  }

  id("timePill").addEventListener("click", function (e) {
    e.stopPropagation();
    if (!id("timeDrop").hidden) { closePops(); return; }
    closePops();
    placePop(id("timeDrop"), id("timePill"));
  });

  id("timeDrop").addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[data-range]") : null;
    if (!b) return;
    e.stopPropagation();
    var v = b.getAttribute("data-range");
    if (v === "custom") {
      closePops();
      state.picking = true;
      state.selFrom = state.from || null;
      state.selTo = state.to || null;
      syncFilterUI();
      id("calHint").textContent = (state.selFrom && state.selTo)
        ? ("已选 " + state.selFrom + " ~ " + state.selTo)
        : "在右侧选择起始与结束日期";
      renderCal();
      placePop(id("calPanel"), id("timePill"));
      return;
    }
    applyRange(v);
  });

  id("calSide").addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[data-range]") : null;
    if (!b) return;
    e.stopPropagation();
    var v = b.getAttribute("data-range");
    if (v === "custom") return;
    applyRange(v);
  });

  id("calGrids").addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[data-day]") : null;
    if (!b) return;
    e.stopPropagation();
    pickDay(b.getAttribute("data-day"));
  });

  id("calPrev").addEventListener("click", function (e) {
    e.stopPropagation();
    renderCal();
    state.calMonth = normMonth({ y: state.calMonth.m === 0 ? state.calMonth.y - 1 : state.calMonth.y, m: state.calMonth.m === 0 ? 11 : state.calMonth.m - 1 });
    renderCal();
  });

  id("calNext").addEventListener("click", function (e) {
    e.stopPropagation();
    state.calMonth = normMonth({ y: state.calMonth.m === 11 ? state.calMonth.y + 1 : state.calMonth.y, m: state.calMonth.m === 11 ? 0 : state.calMonth.m + 1 });
    renderCal();
  });

  id("resetBtn").addEventListener("click", function (e) {
    e.stopPropagation();
    state.selFrom = null;
    state.selTo = null;
    applyRange("30d");
  });

  // 键盘可达（P1-06）：时间维度 pill 是 div[role=button][tabindex=0]，Enter / Space 复用同一 click 分支
  // （currentTarget.click()），保证开/关语义与鼠标完全一致。
  function pillKeyToActivate(e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault(); // Space 默认会滚动页面
    if (e.currentTarget && typeof e.currentTarget.click === "function") e.currentTarget.click();
  }
  id("timePill").addEventListener("keydown", pillKeyToActivate);

  // 页打开时若侧边栏切换了时区，这里自动重算（两路：同源广播即时 + 3 秒轮询兜底）
  var lastTzSeen = null;

  function reloadForTz(tz, reason) {
    if (typeof tz === "number" && tz === lastTzSeen) return;
    if (typeof tz === "number") lastTzSeen = tz;
    state.data = null;
    id("chart").innerHTML = '<div class="empty">时区已切换，正在按新时区重算…</div>';
    load();
  }

  try {
    if (typeof BroadcastChannel === "function") {
      var tzChannel = new BroadcastChannel(TZ_CHANNEL);
      tzChannel.onmessage = function (ev) {
        var d = ev && ev.data;
        if (!d || d.type !== "tz-changed") return;
        reloadForTz(typeof d.tzMinutes === "number" ? d.tzMinutes : null, "broadcast");
      };
    }
  } catch (e) {}

  async function pollTz() {
    try {
      var json = await apiGet("/api/config");
      if (!json) return;
      var tz = typeof json.timezoneOffsetMinutes === "number" ? json.timezoneOffsetMinutes : null;
      if (lastTzSeen === null) { lastTzSeen = tz; return; }
      if (tz !== lastTzSeen) reloadForTz(tz, "poll");
    } catch (e) {}
  }
  setInterval(function () { if (!document.hidden) pollTz(); }, 3000);
  // 详情页原先只在打开时取一次数据，「更新于」会停在打开那一刻；
  // 改为可见时每分钟重取，让数据与时间戳按同一节奏前进（隐藏时不跑，避免无意义请求）。
  setInterval(function () { if (!document.hidden) load(); }, 60000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      load(); // 回到该标签页立即补一次，避免看到过期数字
      apiGet("/api/config").then(function (j) {
        if (j && typeof j.timezoneOffsetMinutes === "number") {
          if (lastTzSeen === null) lastTzSeen = j.timezoneOffsetMinutes;
          else if (j.timezoneOffsetMinutes !== lastTzSeen) { lastTzSeen = j.timezoneOffsetMinutes; load(); }
        }
        if (j && typeof j.apiKeyMasked === "string") applyKeyName(j.apiKeyMasked);
      }).catch(function () {});
    }
  });

  // CSV 字段转义：防公式注入（= + - @ 开头前置单引号）+ RFC4180 引号转义
  function csvField(v) {
    var s = String(v === null || v === undefined ? "" : v);
    if (/^[=+\\-@\\t\\r]/.test(s)) s = "'" + s;
    if (/[",\\n\\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ---------------------------------------------------------------- 导出 CSV

  var EXPORT_MODAL_MS = 5000; // 导出成功弹窗自动收起时长

  function buildCsv() {
    var d = state.data;
    if (!d) return "";
    var tz = Number.isFinite(Number(d.tzMinutes)) ? Number(d.tzMinutes) : -new Date().getTimezoneOffset();
    var rows = [];
    rows.push(["区间", rangeLabel()].map(csvField).join(","));
    rows.push(["时区", tzLabel(tz), "校准系数", d.calibration].map(csvField).join(","));
    rows.push(["生成时间", new Date().toISOString()].map(csvField).join(","));
    rows.push("");
    rows.push(["时间", "模型", "请求次数", "缓存命中Tokens", "缓存未命中Tokens", "输出Tokens", "Tokens合计", "命中金额", "未命中金额", "输出金额", "合计金额(元)"].map(csvField).join(","));
    (d.buckets || []).forEach(function (b) {
      Object.keys(b.byModel || {}).forEach(function (mid) {
        var bm = b.byModel[mid];
        rows.push([labelOf(b.t, d.bucketMs, tz), mid, bm.requests, bm.hit, bm.miss, bm.output, bm.tokens, bm.costHit, bm.costMiss, bm.costOut, bm.cost].map(csvField).join(","));
      });
    });
    rows.push("");
    rows.push(["合计", "", d.totals.requests, d.totals.hit, d.totals.miss, d.totals.output, d.totals.tokens, "", "", "", d.totals.cost].map(csvField).join(","));
    return rows.join("\\r\\n");
  }

  function syncExportBtn() {
    var b = id("exportBtn");
    if (b) b.hidden = !(state.data && state.data.totals && state.data.totals.requests > 0);
  }

  var exporting = false;
  function exportErrorText(code) {
    if (code === "invalid_dir") return "导出失败：目标目录无效";
    if (code === "empty_csv") return "导出失败：没有可写入的数据";
    if (code === "too_large") return "导出失败：数据量超过 8MB 上限";
    if (code === "invalid_range") return "导出失败：筛选区间参数无效";
    if (code === "write_failed") return "导出失败：无法写入该目录（检查权限或磁盘）";
    return "导出失败：" + (code || "未知错误");
  }

  function exportCsv() {
    if (exporting) return;
    var csv = buildCsv();
    if (!csv) { showError("暂无可导出的数据"); return; }
    var btn = id("exportBtn");
    exporting = true;
    if (btn) btn.disabled = true;

    hostRequest("resource.pick", { mode: "directory" })
      .then(function (res) {
        if (!res.ok) {
          if (res.timeout) return { cancelled: true }; // 超时当作取消，不打扰
          showError("导出失败：" + res.error);
          return { cancelled: true };
        }
        var list = res.payload && Array.isArray(res.payload.resources) ? res.payload.resources : [];
        var dir = list.length && list[0] && typeof list[0].path === "string" ? list[0].path : "";
        if (!dir) return { cancelled: true }; // 用户取消选择：静默返回
        return apiPostRaw("/api/export", {
          dir: dir,
          csv: csv,
          rangeKey: state.range,
          from: state.from || "",
          to: state.to || "",
          tz: tzMinutes(),
        });
      })
      .then(function (out) {
        if (!out || out.cancelled) return;
        // 后端对入参错误返回 4xx、写失败返回 5xx；这里必须读 body 里的 error/message，
        // 否则状态码一变就会变成「静默失败」。body 缺失（如 5xx 空体）也当作失败处理。
        if (!out.ok || !out.body || out.body.ok !== true) {
          var code = (out.body && out.body.error) || "write_failed";
          var msg = out.body && out.body.message;
          showError(exportErrorText(code) + (msg ? "（" + msg + "）" : ""));
          return;
        }
        // 文件已落盘：弹窗给出回执
        id("dot").className = "dot ok";
        clearError();
        openModal({
          icon: "ok",
          title: "导出成功",
          text: "CSV 已写入你选择的目录：",
          lines: [{ label: "文件名", value: out.body.name || "CSV 文件" }],
          okText: "知道了",
          autoCloseMs: EXPORT_MODAL_MS,
        });
      })
      .catch(function (e) {
        showError("导出失败：" + (e && e.message ? e.message : String(e)));
      })
      .then(function () {
        exporting = false;
        if (btn) btn.disabled = false;
      });
  }

  id("exportBtn").addEventListener("click", exportCsv);

  // ---------------------------------------------------------------- 导入官方数据（同步）
  // 在 iframe 内本地读文件（不走宿主能力、不上传）；zip 与 CSV 都在这里转成 base64/文本 POST 给本机路由。
  var SYNC_MAX_BYTES = 24 * 1024 * 1024;

  function fmtd(v) { var n = Number(v); return isFinite(n) ? n.toFixed(4) : "--"; }

  // 字节 → base64（分块避开 apply 参数上限）
  function bytesToBase64(bytes) {
    var s = "";
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  // 官方数据覆盖到的时刻（北京时间）
  function coveredLabel(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return "--";
    var d = new Date(n + 8 * 3600 * 1000);
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
      " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
  }

  // 渲染同步面板；data 为 null 时隐藏。
  function renderSync(data) {
    var box = id("syncPanel");
    if (!box) return;
    if (!data) { box.hidden = true; box.innerHTML = ""; return; }
    var t = data.totals || {};
    var granLabel = data.granularity === "hour" ? "按小时" : (data.granularity === "mixed" ? "按小时+按日" : "按日");
    var h = '<div class="rq-head"><b>官方数据同步</b> · ' +
      (data.from ? esc(data.from) + " ~ " + esc(data.to) + "（北京时间）" : "") +
      (data.fileName ? " · " + esc(data.fileName) : "") +
      " · 共 " + fmtInt(data.days) + " 天 · 粒度 " + granLabel +
      (data.hourCount ? "（" + fmtInt(data.hourCount) + " 个整点）" : "") +
      " · 本次导入 " + fmtInt(data.rowCount) + " 行" +
      (data.otherCurrency ? "（另忽略非 CNY " + fmtInt(data.otherCurrency) + " 行）" : "") + '</div>';
    h += '<div class="rq-totals">' +
      '<div><em>官方消费合计</em><b>¥' + fmtd(t.cost) + '</b></div>' +
      '<div><em>请求次数</em><b>' + fmtInt(t.requests) + '</b></div>' +
      '<div><em>Tokens</em><b>' + fmtInt(t.tokens) + '</b></div>' +
      '</div>';
    var rows = data.dayRows || [];
    if (rows.length) {
      h += '<table class="rq-table"><thead><tr><th>日期</th><th>消费(CNY)</th><th>请求</th><th>Tokens</th><th>型号</th></tr></thead><tbody>';
      rows.slice().reverse().forEach(function (r) {
        h += '<tr><td>' + esc(r.d) + (r.costKnown ? "" : "（金额缺）") + (r.hourCovered ? "（按小时汇总）" : "") + '</td>' +
          '<td>' + fmtd(r.cost) + '</td>' +
          '<td>' + fmtInt(r.requests) + '</td>' +
          '<td>' + fmtInt(r.tokens) + '</td>' +
          '<td>' + esc((r.models || []).map(function (m) { return m.id; }).join(" ")) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    var hrows = data.hourRows || [];
    if (hrows.length) {
      h += '<div class="rq-sub">最近的逐小时明细（北京时间，官方导出的整点桶）</div>';
      h += '<table class="rq-table"><thead><tr><th>时段</th><th>消费(CNY)</th><th>请求</th><th>Tokens</th></tr></thead><tbody>';
      hrows.slice().reverse().forEach(function (r) {
        h += '<tr><td>' + esc(r.h) + '</td>' +
          '<td>' + fmtd(r.cost) + '</td>' +
          '<td>' + fmtInt(r.requests) + '</td>' +
          '<td>' + fmtInt(r.tokens) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    h += '<div class="rq-concl">· 已同步的这 ' + fmtInt(data.days) + ' 天以官方数据为准（' + granLabel + '）；本机账本落在官方覆盖范围内的记录不再重复计数。同一天只按一种粒度计数（小时包优先），重复导入同一区间不会重复累加。</div>';
    h += '<div class="rq-fold">官方数据覆盖到 ' + esc(coveredLabel(data.coveredUntil)) + '（北京时间）；其后的本机新用量仍按本机账本累计。</div>';
    box.innerHTML = h;
    box.hidden = false;
    reportHeight();
  }

  function syncErrorText(code) {
    if (code === "empty") return "没有收到文件内容";
    if (code === "bad_file") return "文件无法解析（需官方导出的 zip 或 cost/amount CSV）";
    if (code === "bad_csv") return "CSV 解析失败";
    return code || "未知错误";
  }

  var syncing = false;
  function onFileChosen(file) {
    if (!file) return;
    if (file.size > SYNC_MAX_BYTES) { showError("导入失败：文件超过 24MB 上限"); return; }
    if (syncing) return;
    syncing = true;
    var isZip = /\.zip$/i.test(file.name || "");
    var read = isZip ? file.arrayBuffer() : file.text();
    read.then(function (buf) {
      var body = isZip
        ? { content: bytesToBase64(new Uint8Array(buf)), encoding: "base64" }
        : { content: String(buf), encoding: "utf8" };
      body.fileName = file.name || "";
      body.tz = tzMinutes();
      return apiPost("/api/sync", body);
    }).then(function (out) {
      if (!out || out.ok !== true || !out.data) {
        showError("同步失败：" + syncErrorText(out && out.error) + (out && out.message ? "（" + out.message + "）" : ""));
        return;
      }
      clearError();
      renderSync(out.data);
      load(); // 同步会改动累计与今日消费额，立即重取一次
    }).catch(function (e) {
      showError("同步失败：" + (e && e.message ? e.message : String(e)));
    }).then(function () { syncing = false; });
  }

  if (id("syncBtn")) id("syncBtn").addEventListener("click", function () { if (id("syncFile")) id("syncFile").click(); });
  if (id("syncFile")) id("syncFile").addEventListener("change", function (e) {
    var f = e.target && e.target.files && e.target.files[0] ? e.target.files[0] : null;
    onFileChosen(f);
    e.target.value = ""; // 允许再次选同一个文件
  });
  apiGet("/api/sync").then(function (j) {
    if (j && j.ok && j.data) renderSync(j.data);
  }).catch(function () {});

  document.addEventListener("click", function () { closePops(); });
  HPU.bindModal();
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closePops(); closeModal(); } });

  id("metricSeg").addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("button[data-metric]") : null;
    if (!btn) return;
    var v = btn.getAttribute("data-metric");
    if (v === state.metric) return;
    state.metric = v;
    Array.prototype.forEach.call(this.querySelectorAll("button"), function (b) {
      b.className = b === btn ? "on" : "";
    });
    render();
  });

  id("refreshBtn").addEventListener("click", load);
  window.addEventListener("resize", reportHeight);

  // 只保留页脚展示用的脱敏 Key 文案（API Key 筛选控件已移除：本机账本不记 Key，两个选项行为相同）。
  function applyKeyName(name) {
    if (typeof name !== "string" || !name) return;
    state.keyName = name;
    if (state.data) render();
  }

  sendReady();
  syncFilterUI();
  apiGet("/api/config").then(function (j) {
    if (j && typeof j.apiKeyMasked === "string") applyKeyName(j.apiKeyMasked);
    if (j && typeof j.timezoneOffsetMinutes === "number") lastTzSeen = j.timezoneOffsetMinutes;
  }).catch(function () {});
  load();
})();
</script>
</body>
</html>`;

export default function (app, ctx) {
  app.get('/page', (c) => {
    return c.html(PAGE_HTML);
  });
}
