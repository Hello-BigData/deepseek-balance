// 两个面板共用的样式与浏览器侧工具代码。
//
// 为什么用「导出字符串 + 服务端注入」而不是 assets/ 静态文件：
//   实测宿主不对外提供插件 assets/ 目录（GET /api/plugins/<id>/assets/* 返回 403），
//   而新建「只为发静态文件」的自定义路由不符合 SDK 约定，因此把共享源放在这里，
//   由 routes/page.js 与 routes/widget.js 在渲染 HTML 时插入，保证单一源、零新增路由。
//
// 注意：本文件用模板字符串承载浏览器代码，里面的正则反斜杠必须写两层（\\/），
//       否则会被模板字符串吞掉导致页面脚本语法错误。

// ---------------------------------------------------------------- 共享样式

export const SHARED_CSS = `
  :root {
    color-scheme: light dark;
    --accent: #4c7dff;
    --text-primary: #1f2329;
    --text-secondary: #57606d;
    --text-tertiary: #666d7a;
    --bg-page: #ffffff;
    --bg-card: #ffffff;
    --border: rgba(0, 0, 0, 0.10);
    --danger: #e5484d;
    --success: #30a46c;
    --panel-bg: #f5f6f7;
    --grid: rgba(0, 0, 0, 0.09);
    --focus: rgba(76, 125, 255, 0.40);
    --modal-max: 340px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --text-primary: #e8eaed;
      --text-secondary: #9aa0a6;
      --text-tertiary: #8b9198;
      --bg-page: transparent;
      --bg-card: #1f2124;
      --border: rgba(255, 255, 255, 0.14);
      --danger: #ff6b6f;
      --success: #3ecf8e;
      --panel-bg: #26282c;
      --grid: rgba(255, 255, 255, 0.10);
    }
  }

  /* 全局字体：目标鸿蒙黑体 Medium，逐级兜底；字重统一 500，层级只用字号与颜色 */
  body {
    font-family: "HarmonyOS Sans SC Medium", "HarmonyOS Sans SC", "鸿蒙黑体", "HarmonyOS Sans", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-weight: 500;
  }
  /* 表单控件默认不继承字体，必须显式声明；否则输入框会掉回浏览器默认字体 */
  button, input, select, textarea { font-family: inherit; font-weight: inherit; cursor: pointer; }
  /* 强调元素统一 500：层级只用字号与颜色区分，不用字重 */
  b, strong { font-weight: 500; }
  svg text { font-family: inherit; font-weight: inherit; }

  /* ---------- 弹窗（面板内模态，适配窄宽与深色模式） ---------- */
  .modal { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 12px; }
  .modal[hidden] { display: none; }
  .modal-mask { position: absolute; inset: 0; background: rgba(10, 12, 16, 0.34); }
  .modal-card {
    position: relative; z-index: 1; width: 100%; max-width: var(--modal-max); max-height: calc(100% - 8px); overflow: auto;
    background: var(--bg-card); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 12px; padding: 14px 14px 12px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.26); animation: modalIn .16s ease-out;
  }
  @keyframes modalIn { from { opacity: 0; transform: translateY(4px) scale(.985); } to { opacity: 1; transform: none; } }
  /* 降低动效：逐类收敛（不用 * 通配，避免误伤布局相关属性） */
  @media (prefers-reduced-motion: reduce) {
    .modal-card { animation: none; }
    .modal-close { transition: none; }
    .dot { transition: none; }
    .refresh-btn { transition: none; }
    .refresh-btn.spinning svg { animation: none; }
    .menu-item { transition: none; }
    .fpill { transition: none; }
    .pop-card { animation: none; }
    .tip.on { animation: none; }
  }
  .modal-title { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; margin-bottom: 7px; }
  .modal-title.center { justify-content: center; }
  .modal-title .tick { display: inline-flex; color: var(--success); }
  /* 右上角关闭（×）：仅带 closable 的弹窗显示；圆形、1px 描边 + 极浅底色，悬停加深（与侧栏预警的 × 同款） */
  .modal-close {
    position: absolute; top: 7px; right: 7px; z-index: 2;
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; padding: 0;
    border: 1px solid var(--border); border-radius: 50%;
    background: color-mix(in srgb, var(--text-primary) 6%, transparent);
    color: var(--text-tertiary); font: inherit; font-size: 14px; line-height: 1; cursor: pointer;
    opacity: 0.9;
    transition: opacity .15s ease, color .15s ease, background-color .15s ease, border-color .15s ease;
  }
  .modal-close[hidden] { display: none; }
  .modal-close:hover {
    opacity: 1; color: var(--text-primary);
    background: color-mix(in srgb, var(--text-primary) 14%, transparent);
    border-color: color-mix(in srgb, var(--text-primary) 40%, transparent);
  }
  .modal-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  .modal-body { font-size: 11.5px; line-height: 1.6; color: var(--text-secondary); }
  .modal-body .kv { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .modal-body .kv b { font-weight: 500; color: var(--text-primary); font-variant-numeric: tabular-nums; word-break: break-all; text-align: right; }
  /* 弹窗内表单行（标签 + 输入框） */
  .modal-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 3px 0; }
  .modal-field label { color: var(--text-secondary); }
  .modal-field input {
    width: 48px; height: 26px; padding: 0 4px; cursor: text; text-align: right;
    appearance: none; -webkit-appearance: none;
    font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums;
    border: 1px solid var(--border); border-radius: 6px; background: var(--bg-card); color: var(--text-primary);
  }
  /* 居中提示文字（弹窗内 / 提示浮层共用）：可读字号 */
  .modal-msg { text-align: center; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
  /* 居中提示浮层：复用弹窗体系，无遮罩、不拦鼠标、无按钮；框随字收紧，叠在设置弹窗之上 */
  .modal.modal-notice { z-index: 120; pointer-events: none; }
  .modal-notice .modal-card { width: fit-content; max-width: min(280px, calc(100% - 24px)); padding: 10px 16px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.30); }
  /* 色调：setting = 与「去设置」一致的色与字重（绿 / 500）；字号沿用统一可读值 */
  .modal-notice.tone-setting .modal-msg { color: var(--green, rgb(34, 197, 94)); font-weight: 500; }
  .modal-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
  .modal-btn {
    font: inherit; font-size: 12px; font-weight: 500; padding: 5px 14px; border-radius: 8px;
    cursor: pointer; border: 1px solid transparent; background: var(--accent); color: #fff; transition: filter .15s ease;
  }
  .modal-btn:hover { filter: brightness(1.08); }
  .modal-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
`;

// 弹窗节点结构（两个面板的 HTML 完全相同，由服务端注入）
export const SHARED_MODAL_HTML = `
  <div class="modal" id="modal" hidden>
    <div class="modal-mask" id="modalMask"></div>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <button class="modal-close" id="modalClose" type="button" aria-label="关闭" hidden>&times;</button>
      <div class="modal-title" id="modalTitle"></div>
      <div class="modal-body" id="modalBody"></div>
      <div class="modal-actions">
        <button class="modal-btn" id="modalOk" type="button">知道了</button>
      </div>
    </div>
  </div>
  <div class="modal modal-notice" id="noticeModal" hidden>
    <div class="modal-card" role="status" aria-live="polite">
      <div class="modal-msg" id="noticeText"></div>
    </div>
  </div>`;

// ---------------------------------------------------------------- 共享浏览器代码

export const SHARED_JS = `
window.HPU = (function () {
  "use strict";

  var HOST_TIMEOUT_MS = 180000; // 宿主能力请求最长等待（目录选择框可能开很久）
  var pending = {};

  function id(x) { return document.getElementById(x); }

  function qs(name) {
    try { return new URLSearchParams(location.search).get(name) || ""; } catch (e) { return ""; }
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function genId() { return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }

  function getHostOrigin() { return qs("hana-host-origin") || "*"; }

  function post(msg) {
    try { window.parent.postMessage(msg, getHostOrigin()); } catch (e) { /* 宿主不可达时静默 */ }
  }

  function getPluginId() {
    var m = /^\\/api\\/plugins\\/([^/]+)(?:\\/|$)/.exec(location.pathname || "");
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  function getSurfaceSession() { return qs("pluginSurfaceSession"); }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });
  }

  // 时区显示名：0 显示 UTC+0，其余显示 GMT±H 或 GMT±H:MM（与侧栏保持一致）
  function tzLabel(min) {
    if (min === 0) return "UTC+0";
    var sign = min >= 0 ? "+" : "-";
    var abs = Math.abs(min);
    var h = Math.floor(abs / 60);
    var m = abs % 60;
    return "GMT" + sign + h + (m ? ":" + pad2(m) : "");
  }

  // 同时发新旧两种方言的 ready：新方言走 protocol 校验，旧方言无版本号更耐宿主升级
  function sendReady() {
    post({ protocol: "hana.plugin.ui", version: 1, id: genId(), kind: "event", type: "hana.ready" });
    post({ type: "ready" });
  }

  // 宿主能力请求：按 id 关联响应，超时按取消处理（不打扰用户）
  function hostRequest(type, payload, timeoutMs) {
    return new Promise(function (resolve) {
      var rid = genId();
      var timer = setTimeout(function () {
        delete pending[rid];
        resolve({ ok: false, timeout: true });
      }, timeoutMs || HOST_TIMEOUT_MS);
      pending[rid] = { resolve: resolve, timer: timer };
      post({ protocol: "hana.plugin.ui", version: 1, id: rid, kind: "request", type: type, payload: payload || {} });
    });
  }

  window.addEventListener("message", function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d !== "object" || d.protocol !== "hana.plugin.ui") return;
    if (d.kind !== "response" && d.kind !== "error") return;
    var slot = pending[d.id];
    if (!slot) return;
    delete pending[d.id];
    try { clearTimeout(slot.timer); } catch (e) { /* 清理失败不影响主流程 */ }
    if (d.kind === "error") {
      var msg = d.error && (d.error.message || d.error.code) ? (d.error.message || d.error.code) : "宿主拒绝该操作";
      slot.resolve({ ok: false, error: String(msg) });
      return;
    }
    slot.resolve({ ok: true, payload: d.payload });
  });

  // 打开外部链接。可选 onFail(url) 回调：宿主缺 external.open 能力 / 被拒 / 超时时调用，
  // 让调用方用面板内 notice 兑底（不要静默）。
  function externalOpen(url, onFail) {
    var p = hostRequest("external.open", { url: url });
    if (typeof onFail === "function") {
      p.then(function (res) { if (!res || !res.ok) { try { onFail(url); } catch (e) { /* 忽略 */ } } });
    }
    return p;
  }

  // 最先发 ready：宿主以这个信号判定面板是否加载成功。
  // 放在共享层末尾执行（先于各面板自身逻辑），即使面板脚本初始化中途抛异常，
  // 宿主也不会错误地判成「加载失败」。ready 可重发，面板就绪后会再发一次。
  function sendReadyFirst() {
    try {
      var origin = "*";
      try { origin = qs("hana-host-origin") || "*"; } catch (e) { /* 取不到就用通配 */ }
      window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, id: "ready-" + Date.now(), kind: "event", type: "hana.ready" }, origin);
      window.parent.postMessage({ type: "ready" }, origin);
    } catch (e) { /* 宿主不可达时忽略 */ }
  }

  // 未捕获错误兜底：把「白屏 + 宿主的加载失败」变成面板内看得见的提示。
  // render 由各面板传入（侧栏与详情页的展示位置不同）。
  var fatalReported = false;
  function installErrorTraps(render) {
    function report(kind, detail) {
      try { console.error("[deepseek-balance] " + kind + ": " + detail); } catch (e) { /* 忽略 */ }
      if (fatalReported) return; // 只报第一条，避免连环错误刷屏
      fatalReported = true;
      try { if (typeof render === "function") render(kind + "：" + detail); } catch (e) { /* 展示失败也不能再抛 */ }
    }
    window.addEventListener("error", function (ev) {
      var msg = ev && ev.message ? String(ev.message) : "未知错误";
      if (/ResizeObserver loop/i.test(msg)) return; // 浏览器已知噪音
      report("脚本错误", msg);
    });
    window.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      var name = r && r.name ? String(r.name) : "";
      var text = r && r.message ? String(r.message) : String(r === undefined ? "未知" : r);
      if (name === "AbortError") return; // 请求超时已有降级处理
      if (/Failed to fetch|NetworkError|Load failed/i.test(text)) return; // 网络类失败走面板自己的错误态
      report("异步错误", text);
    });
  }

  // 宿主样式表：只接受 http/https，避免通过查询参数注入异常 URL
  function injectHostCss() {
    var raw = qs("hana-css");
    if (!raw) return;
    var href = "";
    try {
      var u = new URL(raw, location.href);
      if (u.protocol === "http:" || u.protocol === "https:") href = u.href;
    } catch (e) { /* 非法 URL 直接忽略 */ }
    if (!href) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.referrerPolicy = "no-referrer";
    document.head.appendChild(link);
  }

  // ---------------------------------------------------------- 弹窗

  var modalTimer = null;
  var modalOnClose = null;
  var modalOnOk = null;
  var lastFocus = null;

  // 弹窗焦点管理：打开时聚焦首个可聚焦控件（无则聚焦卡片自身）；Tab 在弹窗内循环；
  // 关闭时把焦点还给触发元素（见 closeModal 的 lastFocus 恢复）。
  function modalFocusables(m) {
    var card = m.querySelector(".modal-card");
    if (!card) return [];
    var nodes = card.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(nodes, function (el) {
      return !el.disabled && el.getAttribute("aria-hidden") !== "true" && el.offsetParent !== null;
    });
  }
  function focusFirstInModal(m) {
    var list = modalFocusables(m);
    if (list.length) { try { list[0].focus(); } catch (e) { /* 忽略 */ } return; }
    var card = m.querySelector(".modal-card");
    if (card) { try { card.setAttribute("tabindex", "-1"); card.focus(); } catch (e) { /* 忽略 */ } }
  }

  function closeModal() {
    var m = id("modal");
    if (!m || m.hidden) return;
    m.hidden = true;
    if (modalTimer) { clearTimeout(modalTimer); modalTimer = null; }
    if (lastFocus && typeof lastFocus.focus === "function") { try { lastFocus.focus(); } catch (e) { /* 焦点恢复失败可忽略 */ } }
    lastFocus = null;
    modalOnOk = null;
    var fn = modalOnClose;
    modalOnClose = null;
    if (typeof fn === "function") fn();
  }

  // 底部主按钮：先给 onOk 一次机会；它返回 false 表示“这次不关”（如输入未变动、校验失败）
  function handleModalOk() {
    var fn = modalOnOk;
    if (typeof fn === "function") {
      var keepOpen = false;
      try { keepOpen = fn() === false; } catch (e) { keepOpen = false; }
      if (keepOpen) return;
    }
    closeModal();
  }

  function openModal(opt) {
    var m = id("modal");
    var body = id("modalBody");
    var title = id("modalTitle");
    if (!m || !body || !title) return false;
    var o = opt || {};
    if (!m.hidden) closeModal(); // 先收掉上一个，避免叠加
    if (modalTimer) { clearTimeout(modalTimer); modalTimer = null; }
    modalOnClose = typeof o.onClose === "function" ? o.onClose : null;
    modalOnOk = typeof o.onOk === "function" ? o.onOk : null;
    lastFocus = document.activeElement;

    title.textContent = "";
    title.className = "modal-title" + (o.centerTitle ? " center" : "");
    if (o.icon === "ok") {
      var ic = document.createElement("span");
      ic.className = "tick";
      ic.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6.5 9.4 17 4 11.6"/></svg>';
      title.appendChild(ic);
    }
    var tt = document.createElement("span");
    tt.textContent = o.title || "";
    title.appendChild(tt);

    var closeBtn = id("modalClose");
    if (closeBtn) closeBtn.hidden = !o.closable;

    body.textContent = "";
    if (typeof o.bodyBuild === "function") {
      // 自定义内容：由调用方往 body 里放节点（如带输入框的表单）
      o.bodyBuild(body);
    } else {
      if (o.text) {
        var para = document.createElement("div");
        para.textContent = o.text;
        body.appendChild(para);
      }
      (o.lines || []).forEach(function (row) {
        var line = document.createElement("div");
        line.className = "kv";
        var k = document.createElement("span");
        k.textContent = row && row.label ? row.label : "";
        var v = document.createElement("b");
        v.textContent = row && row.value !== undefined && row.value !== null ? String(row.value) : "";
        line.appendChild(k);
        line.appendChild(v);
        body.appendChild(line);
      });
    }
    id("modalOk").textContent = o.okText || "知道了";
    m.hidden = false;
    focusFirstInModal(m);
    if (typeof o.autoCloseMs === "number" && o.autoCloseMs > 0) {
      modalTimer = setTimeout(function () { modalTimer = null; closeModal(); }, o.autoCloseMs);
    }
    return true;
  }

  function bindModal() {
    var mask = id("modalMask");
    var ok = id("modalOk");
    var closeBtn = id("modalClose");
    if (mask) mask.addEventListener("click", closeModal);
    if (ok) ok.addEventListener("click", handleModalOk);
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    // 焦点陷阱：Tab 在弹窗内循环（Shift+Tab 反向），焦点跑到弹窗外时拉回。
    var modalEl = id("modal");
    if (modalEl) modalEl.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var list = modalFocusables(modalEl);
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      var active = document.activeElement;
      var outside = !modalEl.contains(active);
      if (e.shiftKey) {
        if (outside || active === first) { e.preventDefault(); last.focus(); }
      } else if (outside || active === last) {
        e.preventDefault(); first.focus();
      }
    });
  }

  // ---------------------------------------------------------- 居中提示浮层
  // 复用弹窗体系（同一套 .modal / .modal-card 样式），但无遮罩、无按钮、不拦鼠标，
  // 叠在普通弹窗之上（z-index 更高），默认 3 秒自动收起。
  var noticeTimer = null;

  function closeNotice() {
    var n = id("noticeModal");
    if (!n || n.hidden) return;
    n.hidden = true;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  }

  function openNotice(opt) {
    var n = id("noticeModal");
    var t = id("noticeText");
    if (!n || !t) return false;
    var o = opt || {};
    n.className = "modal modal-notice" + (o.tone === "setting" ? " tone-setting" : "");
    t.textContent = o.text || "";
    n.hidden = false;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    var ms = (typeof o.durationMs === "number" && o.durationMs > 0) ? o.durationMs : 3000;
    noticeTimer = setTimeout(function () { noticeTimer = null; closeNotice(); }, ms);
    return true;
  }

  // ---- 插件 API 通道（与官方模板同构：路径规范化 + surface session 注入）----
  // 浏览器码不直接拼 /api/plugins/{id}/，统一走这里；宿主改路由前缀或鉴权方式时只需改这一处。
  function normalizePluginApiPath(input) {
    var trimmed = typeof input === "string" ? input.trim() : "";
    if (!trimmed) throw new Error("Invalid plugin API path.");
    if (trimmed.indexOf(String.fromCharCode(92)) >= 0 || trimmed.indexOf("#") >= 0 || trimmed.indexOf(String.fromCharCode(0)) >= 0) {
      throw new Error("Invalid plugin API path.");
    }
    if (trimmed.slice(0, 2) === "//") throw new Error("Invalid plugin API path.");
    var colon = trimmed.indexOf(":");
    var slash = trimmed.indexOf("/");
    if (colon >= 0 && (slash < 0 || colon < slash)) throw new Error("Invalid plugin API path.");
    var stripped = trimmed;
    while (stripped.charAt(0) === "/") stripped = stripped.slice(1);
    if (!stripped || stripped.slice(0, 2) === "./" || stripped === "api/plugins" || stripped.slice(0, 12) === "api/plugins/") {
      throw new Error("Invalid plugin API path.");
    }
    var q = stripped.indexOf("?");
    var rawPath = q >= 0 ? stripped.slice(0, q) : stripped;
    var search = q >= 0 ? stripped.slice(q) : "";
    var segments = rawPath.split("/");
    var out = [];
    for (var i = 0; i < segments.length; i += 1) {
      var seg = segments[i];
      if (!seg) throw new Error("Invalid plugin API path.");
      var dec = decodeURIComponent(seg);
      if (dec === "." || dec === ".." || dec.indexOf("/") >= 0 || dec.indexOf(String.fromCharCode(92)) >= 0) {
        throw new Error("Invalid plugin API path.");
      }
      out.push(encodeURIComponent(dec));
    }
    return out.join("/") + search;
  }

  function pluginApiUrl(path) {
    var pid = getPluginId();
    if (!pid) throw new Error("无法识别插件上下文");
    return location.origin + "/api/plugins/" + encodeURIComponent(pid) + "/" + normalizePluginApiPath(path);
  }

  function pluginApiFetch(path, init) {
    var session = getSurfaceSession();
    if (!session) throw new Error("hana.api.fetch 需要 iframe URL 中的 pluginSurfaceSession");
    var headers = new Headers((init && init.headers) || {});
    headers.set("X-Hana-Plugin-Surface-Session", session);
    var opts = init ? Object.assign({}, init) : {};
    opts.headers = headers;
    return fetch(pluginApiUrl(path), opts);
  }

  var api = { url: pluginApiUrl, fetch: pluginApiFetch };

  // 提示框方向的初始选择 + 两条兜底（纯函数，便于单测）。
  // **回退（1.14.45）**：十八批曾让 containerKind==='popup'（浮层卡内锚点）默认朝上，那是对作者原话的
  // 误读 —— 作者说的「下方」是**图层**上的下方（提示被弹窗盖住），不是空间位置；位置本来就对。
  // 故这里把 'popup' 改回与 'other' 一致（默认朝下）；containerKind 保留（把隐式假设显式化）。
  function chooseTipAbove(inp) {
    var o = inp || {};
    var pad = 7;
    var kind = o.containerKind;
    var above;
    if (kind === "card") above = Number(o.anchorMid) < Number(o.containerMid);
    else above = false; // 'popup' 与 'other' 一律沿用旧默认（朝下）
    if (above) {
      // 兜底①：朝上但贴不到面板顶 → 翻回下方
      if ((Number(o.anchorTop) - Number(o.tipHeight) - pad) < 4) above = false;
    } else if ((Number(o.anchorBottom) + pad + Number(o.tipHeight)) > (Number(o.panelHeight) - 4)) {
      // 兜底②：朝下但超出面板底 → 翻回上方
      above = true;
    }
    return above;
  }

  // 时区菜单选中判定（菜单只有两项：跟随本机 / UTC+0）：
  //   · 「跟随本机（-1）」：tzMin === -1，或存储的是**具体偏移且等于本机偏移**（如 480）——选择它即写回 -1；
  //   · 「UTC+0（0）」：其余非本机情形（含 0，以及菜单已无法表达的遗留具体偏移）都归到这一项，
  //     保证**恰有一项高亮**；普通时区行仍照实显示真实偏移。
  // 特殊：本机偏移为 0 时，0 视为「本机」→ 高亮「跟随本机」（显式 UTC 项与本机项重复，同被删的 GMT+8 同理）。
  function tzItemOn(dataTz, tzMin, localMinutes) {
    var v = Number(dataTz);
    var t = Number(tzMin);
    var l = Number(localMinutes);
    if (v === -1) return t === -1 || (Number.isFinite(l) && t === l);
    if (v === 0) return t !== -1 && !(Number.isFinite(l) && t === l);
    return false;
  }

  // 单调时钟：看门狗不能用 Date.now() 差值（墙钟回拨会让差值变负 ⇒ 看门狗失灵）。
  function monoNow() {
    try { if (typeof performance !== "undefined" && performance && typeof performance.now === "function") return performance.now(); } catch (e) { /* 降级 */ }
    return Date.now();
  }

  // ---- 轮询调度决策（纯计算，独立于定时器与 DOM；浏览器侧与自检共用同一份）----
  var Sched = (function () {
    var MIN_MS = 5000;
    var MAX_BACKOFF = 30 * 60 * 1000;
    var HIDDEN_MIN = 5 * 60 * 1000;

    function computeNextDelay(s) {
      var st = s || {};
      var seconds = Number(st.refreshSeconds);
      if (!isFinite(seconds) || seconds <= 0) return 0;
      var base = Math.max(MIN_MS, seconds * 1000);
      if (st.hidden) return Math.max(base, HIDDEN_MIN);
      var failCount = Number(st.failCount) || 0;
      if (failCount > 0) return Math.min(base * Math.pow(2, Math.min(failCount, 5)), MAX_BACKOFF);
      return base;
    }

    function shouldWatchdog(s) {
      var st = s || {};
      var seconds = Number(st.refreshSeconds);
      if (!isFinite(seconds) || seconds <= 0) return false;
      var last = Number(st.lastSuccessAt);
      if (!last || last <= 0) return false;
      var now = Number(st.now) || Date.now();
      return now - last > Math.max(seconds * 2, 120) * 1000;
    }

    return {
      MIN_INTERVAL_MS: MIN_MS,
      MAX_BACKOFF_MS: MAX_BACKOFF,
      HIDDEN_MIN_MS: HIDDEN_MIN,
      computeNextDelay: computeNextDelay,
      shouldWatchdog: shouldWatchdog
    };
  })();

  sendReadyFirst(); // 先报 ready，再让面板去初始化

  // 官方同构的命名空间（可选）：与 Hana 模板生成的浏览器 helper 同名同形，
  // 面板可写 hana.api.fetch(...) / hana.external.open(...) / hana.resources.pick(...)。
  try {
    window.hana = {
      ready: function () { sendReady(); },
      ui: {
        resize: function (size) {
          post({ protocol: "hana.plugin.ui", version: 1, id: genId(), kind: "event", type: "ui.resize", payload: size || {} });
        }
      },
      api: api,
      external: { open: function (url) { externalOpen(url); } },
      // 宿主级 toast：由宿主渲染在整个程序窗口上，不受侧栏 iframe 边界限制
      toast: { show: function (input) { return hostRequest("toast.show", input || {}); } },
      resources: {
        open: function (input) { return hostRequest("resource.open", input || {}); },
        pick: function (input) { return hostRequest("resource.pick", input || {}); },
        requestAccess: function (input) { return hostRequest("resource.requestAccess", input || {}); }
      },
      theme: {
        getSnapshot: function () {
          var p = new URLSearchParams(location.search);
          return { theme: p.get("hana-theme") || undefined, cssUrl: p.get("hana-css") || undefined };
        }
      }
    };
  } catch (e) { /* 命名空间构建失败不影响主流程 */ }

  return {
    api: api, Sched: Sched, monoNow: monoNow, tzItemOn: tzItemOn, chooseTipAbove: chooseTipAbove,
    HOST_TIMEOUT_MS: HOST_TIMEOUT_MS,
    id: id, qs: qs, pad2: pad2, genId: genId, post: post,
    getHostOrigin: getHostOrigin, getPluginId: getPluginId, getSurfaceSession: getSurfaceSession,
    esc: esc, tzLabel: tzLabel, sendReady: sendReady, hostRequest: hostRequest,
    externalOpen: externalOpen, injectHostCss: injectHostCss,
    sendReadyFirst: sendReadyFirst, installErrorTraps: installErrorTraps,
    openModal: openModal, closeModal: closeModal, bindModal: bindModal,
    openNotice: openNotice, closeNotice: closeNotice
  };
})();
`;
