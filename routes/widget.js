// 侧边栏 widget 页面路由
// 挂载路径：/api/plugins/deepseek-balance/widget
// 返回一个自包含的 HTML 页面，零构建、零外部依赖。
//
// 安全边界：
//   · 页面运行在宿主注入的 iframe 内，仅通过 postMessage 与宿主通信，
//     消息只含固定跳转 URL 与提示文案，不含 API Key 等任何敏感数据；
//   · 所有动态值先做数值化或 HTML 转义再进入 DOM，页面不做原始 HTML 注入；
//   · 宿主样式表链接只接受 http/https 协议的 URL。
//
// 稳定性：
//   · 轮询支持失败退避、页面隐藏时暂停、可见时立即补一次；
//   · 卡片节点静态构建，刷新只更新文本，避免整块重绘造成的闪烁；
//   · 失败时保留上一次成功的数据并标注「更新失败」，而不是把面板清空；
//   · 每次更新后上报真实内容高度，避免固定高度把卡片裁掉。
//
// 口径：
//   · 「可用余额」= total_balance，构成（充值/赠送）在小字里拆解；
//   · 「累计消费金额」= 自有资金净支出 = 累计充值 − 累计退款 − 当前充值余额。

// 共享层用带时间戳的动态 import 载入：插件重装时绕开 ESM 模块缓存。
// 否则会出现「routes 已更新、lib 还是旧版」的错位（实测会导致面板脚本抛错、连 ready 都发不出）。
const SHARED = await import('../lib/ui-shared.js?v=' + Date.now());
const SHARED_CSS = SHARED.SHARED_CSS;
const SHARED_JS = SHARED.SHARED_JS;
const SHARED_MODAL_HTML = SHARED.SHARED_MODAL_HTML;
// 高峰窗口整点与刻度规则（单一源：lib/holidays.js），渲染时注入为准内联常量，避免两处各写一份
const { TICK_GRID_HOURS } = await import('../lib/holidays.js?v=' + Date.now());

const WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' http: https:; img-src 'self' data: http: https:; font-src 'self' data: http: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>用量信息</title>
<style>
${SHARED_CSS}
  /* 侧栏自身附加变量：共享层已给出公共变量，这里只补侧栏独有的 */
  :root {
    --sky: #0ea5e9;
    --green: rgb(34, 197, 94);
    --panel-bg: rgb(245, 246, 247);
    --grid: rgba(0, 0, 0, 0.09);
    --focus: rgba(76, 125, 255, 0.40);
    --peak: #b4232b;
    /* 红卡文字用更深的红：明模式下对浅红底达到正文 AA（≥4.5:1） */
    --danger-text: #b4232b;
    --modal-max: 258px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --sky: #38bdf8;
      --green: #4ade80;
      --panel-bg: rgb(38, 40, 44);
      --grid: rgba(255, 255, 255, 0.11);
      --focus: rgba(88, 150, 255, 0.45);
      --peak: #dd6d77;
      --danger-text: #ff6b6f;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: transparent; }
  body {
    color: var(--text-primary);
    -webkit-font-smoothing: antialiased;
    font-size: 13px;
    line-height: 1.5;
  }
  /* 字重口径：全局只用 Medium（500），层级靠字号/颜色区分，避免单字重下出现伪粗体 */
  .widget {
    position: relative;
    padding: 10px 14px 12px;
    user-select: none;
  }
  #content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  button:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  button:disabled { opacity: 0.55; cursor: default; }

  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .title-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--text-tertiary);
    flex: none; transition: background-color .2s ease;
  }
  .dot.ok { background: var(--success); }
  .dot.err { background: var(--danger); }
  .title { font-weight: 500; font-size: 12.5px; letter-spacing: 0.3px; color: var(--text-secondary); }
  .stamp { font-size: 10px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stamp.err { color: var(--danger); }

  /* 标题下的说明行（对齐平台样式） */
  .tz-note {
    display: flex; align-items: center; gap: 4px;
    font-size: 11px; color: var(--text-tertiary);
    margin: -2px 0 10px; line-height: 1.4;
  }
  .tz-note .info {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; flex: none; cursor: help; border-radius: 50%;
    color: var(--text-tertiary); transition: color .15s ease;
  }
  .tz-note .info:hover { color: var(--text-secondary); }
  /* 通用说明图标（赠送余额有效期等） */
  .info {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; flex: none; cursor: help; border-radius: 50%;
    color: var(--text-tertiary); transition: color .15s ease;
  }
  .info:hover { color: var(--text-secondary); }
  .info[hidden] { display: none; }
  .notice {
    display: none;
    font-size: 11px; color: var(--text-secondary);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-card));
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: 7px; padding: 5px 9px; line-height: 1.45;
    user-select: text; /* 文本可选中复制（如无法自动打开的链接） */
  }
  .notice.on { display: block; }
  .notice.warn {
    color: var(--danger-text);
    background: color-mix(in srgb, var(--danger) 10%, var(--bg-card));
    border-color: color-mix(in srgb, var(--danger) 30%, transparent);
  }

  .refresh-btn {
    border: 1px solid var(--border); background: transparent; color: var(--text-secondary);
    border-radius: 6px; width: 24px; height: 24px; flex: none;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    transition: color .15s ease, border-color .15s ease;
  }
  .header-actions { display: flex; align-items: center; gap: 6px; flex: none; }
  .text-btn {
    border: 0; background: transparent; color: var(--text-secondary); font-size: 11px;
    padding: 3px 5px; border-radius: 6px; cursor: pointer;
  }
  .text-btn:hover { color: var(--accent); }
  .refresh-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .refresh-btn.spinning svg { animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* 官方卡片结构：card + 标签行 + 金额行 */
  .card {
    flex: 0 0 auto;
    max-width: 100%;
    min-height: 95px;
    background: var(--panel-bg);
    border-radius: 12px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .card-inner { display: flex; flex-direction: column; gap: 8px; }
  .card.is-action { transition: background-color .15s ease; }
  .card.is-action:hover { background: color-mix(in srgb, var(--panel-bg) 90%, var(--accent) 10%); }
  /* 光标收窄（1.14.48）：本卡整卡可点（单击刷新 / 双击官方用量），但作者要求**只有**
     「去设置」「去充值」两个真控件显示手掌 ⇒ 卡体（含金额 / 标签 / 拆分行 / ? 等非控件子元素）一律 default。
     真控件各自显式声明手掌：.recharge-btn（本文件上方）与 #settingLink（.alert-hint .link 处）。
     注：.is-action 目前仅本卡使用；这里仍用 id 显式声明，避免将来被其它卡复用时误伤。
     不动：hover 底色（.card.is-action:hover）、单击/双击、键盘等价、? 与拆分行提示。 */
  #balanceCard { cursor: default; }
  /* 迷你图表卡：固定高度，宽高比接近 2:1，不再抽高铺满侧栏 */
  .card-chart { justify-content: flex-start; }
  .chart-wrap { height: 108px; }
  .chart-wrap svg { display: block; }
  /* 今日消费额卡：一行结构（标签 13px（已含单位 (CNY)，半角括号）+ 金额 13px + 行尾 ?）。
     金额在本卡作用域覆盖为 13px（与标签同号），并把行高也对齐为 1.5（与标签的继承值一致）——
     仅改字号时墨迹/基线差 0.23px、盒顶差 2.27px；行高对齐后盒顶/墨迹/基线均 0.00px。
     括号用半角：比全角窄 10px，把这部分宽度让给金额（全角括号在卡内实测内宽 181px 下会把四位数挤成省略号）。
     .amount 加 margin-left: 4px（与其它卡 .amount-unit 的 4px 同一尺度）：半角 ) 的右留白只有 0.11px，
     两墨迹几乎相接（实测两侧留白均为负：半角 ) 右留白 −0.059、¥ 左留白 −1.000，不加边距时墨迹间距 −1.06px，真的交叠）；
     4px 硬边距把墨迹间距抬到实测 2.94px（盒间隙 4.00px），且不依赖字体留白的正负（保险做法优先于紧凑）。
     标签 flex:0 0 auto 永不收缩（不会被截断）；金额 flex:0 1 auto + min-width:0，超宽时
     由 .amount-value 自带的 overflow:hidden / text-overflow:ellipsis 干净收尾，? flex:0 0 auto 不被挤压。
     对齐：本行与 .amount 内层均 center；? 靠行尾最右、垂直居中。 */
  .today-row { flex-wrap: nowrap; gap: 0; align-items: center; }
  .today-row .card-label { flex: 0 0 auto; }
  .today-row .amount { flex: 0 1 auto; min-width: 0; margin-left: 4px; align-items: center; }
  .today-row .amount-value { font-size: 13px; line-height: 1.5; min-width: 0; }
  .today-row .info { flex: 0 0 auto; margin-left: auto; align-self: center; }

  .card-row { display: flex; align-items: baseline; min-width: 0; }
  .card-label {
    font-weight: 500; font-size: 13px; letter-spacing: 0.3px; color: var(--text-secondary);
    white-space: nowrap;
  }
  .card-note { font-size: 10px; color: var(--text-tertiary); margin-left: 6px; white-space: nowrap; }
  .alert-hint { font-size: 10px; color: var(--green); white-space: nowrap; margin-left: 6px; }
  .alert-hint .link {
    text-decoration: underline; cursor: pointer;
    /* 元素由 span 改为 button（键盘可达），外观逐像素保持一致：清掉按钮默认边框/底色/内边距与字体尺寸 */
    border: 0; background: transparent; padding: 0; margin: 0;
    font: inherit; color: inherit; -webkit-appearance: none; appearance: none;
  }
  /* 光标收窄（1.14.48）：显式声明手掌，不依赖祖先类命中（卡体 #balanceCard 已是 default） */
  #settingLink { cursor: pointer; }
  .balance-breakdown {
    font-size: 11px; color: var(--text-tertiary); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums;
  }

  .amount-wrap { display: flex; align-items: center; justify-content: space-between; min-width: 0; width: 100%; }
  /* 官方金额结构：value + unit 分开 */
  .amount { display: inline-flex; align-items: baseline; white-space: nowrap; min-width: 0; }
  .amount-value {
    font-size: 26px; font-weight: 500; letter-spacing: -0.2px;
    font-variant-numeric: tabular-nums; line-height: 1.15; color: var(--text-primary);
    overflow: hidden; text-overflow: ellipsis;
  }
  .amount-value.is-text { font-size: 15px; font-weight: 500; color: var(--text-tertiary); }
  .amount-unit {
    font-size: 13px; font-weight: 500; color: var(--text-tertiary); margin-left: 4px;
  }
  .plain-value {
    font-size: 26px; font-weight: 500; letter-spacing: -0.2px; font-variant-numeric: tabular-nums;
    line-height: 1.2; color: var(--text-primary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* 自绘提示框：替掉原生 title，位置夹在面板内不溢出 */
  /* 层级：提示必须画在浮层之上（作者报「提示与弹窗不在一个图层」）。z-index 200 高于
     .menu(30) / .pop-layer(40) / modal(90) / 居中提示(120)。
     #tip 是 .widget（position:relative, z-index:auto ⇒ 非层叠上下文）的子节点，
     其 z-index 在根层叠上下文里比较，故无需移到根级。 */
  .tip {
    position: absolute; z-index: 200; max-width: min(232px, calc(100% - 20px));
    background: rgba(26, 28, 32, 0.94); color: #fff;
    font-size: 11px; font-weight: 500; line-height: 1.45;
    padding: 6px 9px; border-radius: 7px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.20);
    pointer-events: none; opacity: 0; transform: none;
    transition: opacity .12s ease;
    white-space: pre-line; word-break: break-word; text-align: left;
  }
  /* 入场用一次性动画（位移只发生在“出现”时）；隐藏只淡出、不再位移 ⇒ 移出时不会“上飘一闪” */
  .tip.on { opacity: 1; animation: tipIn .12s ease-out; }
  @keyframes tipIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
  /* reduced-motion 统一在共享层 lib/ui-shared.js 处理 */
  /* 更多菜单（选择时区）：行高字体沿用上一版，宽度由内容决定 */
  .menu {
    position: absolute; z-index: 30;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 9px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.13);
    overflow: hidden;
  }
  .menu[hidden] { display: none; }
  .menu-title {
    font-size: 10.5px; color: var(--text-tertiary);
    background: var(--panel-bg); padding: 5px 9px;
    border-bottom: 1px solid var(--border);
  }
  .menu-item {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    width: 100%; border: 0; background: transparent; cursor: pointer;
    font-size: 12px; line-height: 1.35; color: var(--text-primary);
    padding: 6px 9px; text-align: left; white-space: nowrap;
  }
  .menu-item + .menu-item { border-top: 1px solid var(--border); }
  .menu-item:hover { background: color-mix(in srgb, var(--panel-bg) 78%, var(--accent) 8%); }
  .menu-item .menu-check { display: none; color: var(--success); }
  .menu-item.on .menu-check { display: inline-flex; }
  .menu-item .menu-check svg { width: 11px; height: 11px; }

  /* 提示框在元素下方 → 箭头在顶部（向上指）；翻到上方时箭头换到底部 */
  .tip::after {
    content: ""; position: absolute; left: var(--arrow-x, 50%); margin-left: -4px;
    width: 0; height: 0; bottom: 100%;
    border-left: 4px solid transparent; border-right: 4px solid transparent;
    border-bottom: 5px solid rgba(26, 28, 32, 0.94);
  }
  .tip.above::after {
    bottom: auto; top: 100%; border-bottom: none;
    border-top: 5px solid rgba(26, 28, 32, 0.94);
  }
  /* 柱状图颜色写死为调试时的亮蓝，不跟随宿主主题的 --accent */
  .dsb-bar { fill: #4c7dff; }
  @media (prefers-color-scheme: dark) { .dsb-bar { fill: #5b8dff; } }

  .recharge-btn {
    background: var(--sky); color: #fff; border: none; border-radius: 14px;
    font-size: 12px; height: 29px; padding: 0 14px;
    display: inline-flex; align-items: center;
    cursor: pointer; white-space: nowrap; transition: opacity .15s ease;
    flex: none; margin-left: 6px;
  }
  .recharge-btn:hover:not(:disabled) { opacity: 0.85; }

  .box { display: none; border-radius: 9px; padding: 8px 12px; font-size: 12px; margin-bottom: 8px; line-height: 1.5; }
  .err-box {
    background: color-mix(in srgb, var(--danger) 8%, var(--bg-card));
    border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
    color: var(--danger-text);
    /* 错误文本可选中复制（.widget 整体是 user-select:none） */
    user-select: text;
  }
  .err-box .setup-hint { margin-top: 3px; font-size: 11px; opacity: 0.85; }
  /* 常驻红框：余额低于阈值就在流内显示，恢复/关闭预警才隐藏 */
  /* 双类选择器：避免被共享层的 .box 基础样式压掉。
     默认隐藏，只有带 .on 才显示 —— 面板切回来时不会先闪一下红框（默认可见 + JS 隐藏会造成闪烁） */
  .box.alert-box {
    display: none;
    align-items: center; flex-wrap: nowrap; gap: 8px;
    background: color-mix(in srgb, var(--danger) 12%, var(--bg-card));
    border: 1px solid color-mix(in srgb, var(--danger) 38%, transparent);
    color: var(--danger-text); font-weight: 500;
  }
  .box.alert-box.on { display: flex; }
  .alert-box .alert-text { flex: 1 1 auto; min-width: 0; }
  /* 浮层卡右上角删除（×）：红窗与事件卡共用同一套样式（同尺寸/同圆圈/同 hover）；
     颜色用**显式中性色**（--text-secondary）—— 红窗 × 与事件卡 × 完全同色，与其它说明提示的 UI 风格统一。 */
  .pop-close {
    flex: 0 0 auto; margin-left: auto; align-self: center;
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; padding: 0;
    border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
    border-radius: 50%;
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: var(--text-secondary);
    font: inherit; font-size: 13px; line-height: 1;
    cursor: pointer; opacity: 0.9;
    transition: opacity .15s ease, background-color .15s ease, border-color .15s ease;
  }
  .pop-close:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor 22%, transparent);
    border-color: color-mix(in srgb, currentColor 65%, transparent);
  }
  .pop-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  .event-box {
    background: color-mix(in srgb, var(--sky) 10%, var(--bg-card));
    border: 1px solid color-mix(in srgb, var(--sky) 32%, transparent);
    color: var(--text-primary); font-weight: 500;
  }
  /* 事件提示默认隐藏，带 .on 才显示（可见性一律用 class 控制，不写内联 display） */
  .box.event-box.on { display: block; }
  /* 标题行：标题 + 右上角删除（×） */
  .event-box .event-head { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px; }
  .event-box .event-head .event-title { flex: 1 1 auto; min-width: 0; }
  .event-box .event-title { color: var(--sky); }
  .event-box .event-note { color: var(--text-tertiary); font-size: 11px; }

  /* ---------- 通知区（时区 / 预警 / 事件 / 错误四条共用）-----------
     **整体浮层定位**（absolute；top:38px / z-index:40 / 外层 pointer-events:none、子卡 auto）：
     显隐不改变 #content 位置、不推挤独立卡片；代价是会遮住金额 —— 作者明确取舍：遮拦比位移更不扰人
     （见 CHANGELOG 1.14.43）。空态高度为 0（卡片默认 display:none），不占位；模态与 .tip 仍走绝对/固定定位。
     四条共用同一套 .pop-card 样式，仅语气色/内容不同。
     **为什么仍保留 hover 抑制（muteHoverUntilMove）**：浮层显隐会改变光标下方的元素 ——
     显＝盖住下面的卡片、隐＝露出的卡片正好在鼠标下，都会触发「幽灵 hover」（弹提示 / 亮底色），
     与它是否占位无关，故抑制不可去掉。 */
  .pop-layer {
    position: absolute; left: 0; right: 0; top: 38px; z-index: 40;
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 0 10px; pointer-events: none;
  }
  .pop-layer > * { margin: 0; pointer-events: auto; }
  /* 瞬时 toast 仍保持绝对定位（在已浮层化的 .pop-layer 内）：不占层内流，
     避免它把同层的常驻卡推动 —— 与「整层浮层」口径一致。 */
  /* 层序：常驻卡（预警/错误/事件）恒在瞬时 toast 之上 —— 红窗优先要真成立
     （#notice 是定位元素，若不显式压制会绘制在无定位的 alertBox 之上）。 */
  #notice {
    position: absolute; left: 0; right: 0; top: 0; margin: 0 auto; z-index: 1;
  }
  .pop-layer > .box { z-index: 2; }
  /* 迷你图空态：与既有小字一致（字号沿用 11px，不新造） */
  .chart-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-tertiary); font-size: 11px; }
  .pop-card {
    width: max-content; max-width: min(240px, 100%);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.20);
    animation: popIn .16s ease-out;
  }
  @keyframes popIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

  /* 弹窗样式见共享层 lib/ui-shared.js */
</style>
</head>
<body>
  <div class="widget">
    <div class="header">
      <div class="title-row">
        <span class="dot" id="dot"></span>
        <span class="title">用量信息</span>
        <span class="stamp" id="stamp" aria-live="polite"></span>
      </div>
      <div class="header-actions">
        <button class="text-btn" id="pageBtn" type="button" data-tip="打开用量详情页（标签页）">详情</button>
        <button class="refresh-btn" id="refreshBtn" type="button" data-tip="立即刷新余额与用量" aria-label="刷新">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
        <button class="refresh-btn" id="moreBtn" type="button" data-tip="切换时区" aria-label="更多" aria-haspopup="true" aria-expanded="false">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
        </button>
      </div>
    </div>

    <div class="tz-note">
      <span id="tzText">所有日期均按 GMT+8 时间显示。</span>
      <span class="info" id="tzInfo" data-tip="时区变更后，数据可能会同步更新" role="img" aria-label="说明">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.3 2.3c-.7.3-1 .8-1 1.5v.5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>
      </span>
    </div>
    <div class="pop-layer" id="popLayer">
      <div class="box alert-box pop-card" id="alertBox"></div>
      <div class="box err-box pop-card" id="errBox"></div>
      <div class="notice pop-card" id="notice" aria-live="polite"></div>
      <div class="box event-box pop-card" id="eventBox"></div>
    </div>

    <div id="content">
      <div class="card is-action" id="balanceCard" data-usage-layout-card="true" data-tip="单击刷新，双击查看官方用量" tabindex="0" aria-label="余额卡：回车刷新，Shift+回车查看官方用量">
        <div class="card-inner">
          <div class="card-row" data-usage-layout-row="true">
            <span class="card-label">可用余额</span>
            <span class="alert-hint" id="alertHint"><span id="alertHintText">余额预警已开启</span> <button class="link" id="settingLink" type="button">去设置</button></span>
          </div>
          <div class="card-row" data-usage-layout-row="true">
            <div class="amount-wrap">
              <span class="amount"><span class="amount-value" id="balanceValue" data-usage-layout-font="value">--</span><span class="amount-unit" id="balanceUnit" data-usage-layout-font="unit">CNY</span></span>
              <button class="recharge-btn" id="rechargeBtn" type="button">去充值</button>
            </div>
          </div>
          <div class="card-row" id="breakdownRow" data-usage-layout-row="true" data-tip="可用余额 = 充值 + 赠送；赠送优先扣减" tabindex="0" aria-label="余额构成：可用余额 = 充值余额 + 赠送余额；赠送余额优先扣减">
            <span class="balance-breakdown" id="balanceBreakdown"></span>
            <span class="info" id="grantInfo" data-tip="赠送余额有有效期，到期会自动从余额中扣除；具体到期时间可在平台账单页查看。" aria-label="赠送余额有有效期，到期会自动从余额中扣除；具体到期时间可在平台账单页查看" tabindex="0" hidden>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.3 2.3c-.7.3-1 .8-1 1.5v.5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>
            </span>
          </div>
        </div>
      </div>
      <div class="card" data-usage-layout-card="true">
        <div class="card-inner">
          <div class="card-row" data-usage-layout-row="true">
            <span class="card-label">累计消费金额</span>
            <span class="card-note" id="costNote" data-tip="充值 − 退款 − 当前充值余额" tabindex="0" aria-label="累计消费金额口径：充值 − 退款 − 当前充值余额（自有资金净支出）">自有资金</span>
          </div>
          <div class="card-row" data-usage-layout-row="true">
            <div class="amount-wrap">
              <span class="amount"><span class="amount-value" id="costValue" data-usage-layout-font="value">--</span><span class="amount-unit" id="costUnit" data-usage-layout-font="unit">CNY</span></span>
            </div>
          </div>
        </div>
      </div>
      <div class="card" data-usage-layout-card="true">
        <div class="card-inner">
          <div class="card-row" data-usage-layout-row="true"><span class="card-label">API请求次数</span></div>
          <div class="card-row" data-usage-layout-row="true"><div class="amount-wrap"><span class="plain-value" id="reqValue">--</span></div></div>
        </div>
      </div>
      <div class="card" data-usage-layout-card="true">
        <div class="card-inner">
          <div class="card-row" data-usage-layout-row="true"><span class="card-label">Tokens</span></div>
          <div class="card-row" data-usage-layout-row="true"><div class="amount-wrap"><span class="plain-value" id="tokensValue">--</span></div></div>
        </div>
      </div>
      <div class="card card-chart" id="usageCard" data-usage-layout-card="true">
        <div class="card-inner">
          <div class="card-row today-row" data-usage-layout-row="true">
            <span class="card-label">今日消费额(CNY)</span>
            <span class="amount"><span class="amount-value" id="todayCostValue" data-usage-layout-font="value">--</span></span>
            <span class="info" id="peakInfo" data-tip="空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。" role="img" aria-label="今日消费额与高峰口径：空闲时段单价为高峰时段的一半；北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰" tabindex="0">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.3 2.3c-.7.3-1 .8-1 1.5v.5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>
            </span>
          </div>
          <div class="chart-wrap" id="usageChart"></div>
        </div>
      </div>
    </div>

    <div class="menu" id="tzMenu" role="menu" hidden>
      <div class="menu-title">选择时区</div>
      <button class="menu-item" type="button" role="menuitem" data-tz="-1"><span class="menu-label">跟随本机</span><span class="menu-check" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span></button>
      <button class="menu-item" type="button" role="menuitem" data-tz="0"><span class="menu-label">UTC+0</span><span class="menu-check" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span></button>
    </div>

    <div class="tip" id="tip" role="tooltip" aria-hidden="true"></div>
  </div>
${SHARED_MODAL_HTML}

<script>${SHARED_JS}</script>
<script>
(function () {
  "use strict";

  // ------------------------------------------------------------ 宿主通信

  // 共享层（lib/ui-shared.js 已注入）：宿主通信、转义、时区标签、弹窗
  var id = HPU.id, qs = HPU.qs, pad2 = HPU.pad2, genId = HPU.genId, post = HPU.post;
  var getHostOrigin = HPU.getHostOrigin, getPluginId = HPU.getPluginId, getSurfaceSession = HPU.getSurfaceSession;
  var escapeHtml = HPU.esc, sendReady = HPU.sendReady, tzLabel = HPU.tzLabel;
  var hostRequest = HPU.hostRequest, externalOpen = HPU.externalOpen;
  var openModal = HPU.openModal, closeModal = HPU.closeModal, openNotice = HPU.openNotice;

  // 未捕获错误兜底：在面板内显示可读提示，而不是白屏让宿主判成「加载失败」。
  // typeof 防御：若共享层与面板脚本出现版本错位，降级成「无兜底」而不是直接报错。
  if (typeof HPU.installErrorTraps === "function") {
    HPU.installErrorTraps(function (msg) {
      try { reportClientError(msg, "面板遇到异常，可把这行提示反馈给作者"); } catch (e) { /* 展示失败不再抛 */ }
    });
  }
  // 切到插件的用量详情页（宿主的 legacy 方言，tab 形如 plugin:<pluginId>）
  function openUsagePage() {
    var pluginId = getPluginId();
    if (!pluginId) return;
    post({ type: "navigate-tab", payload: { tab: "plugin:" + pluginId } });
  }

  // 宿主没有授权 toast.show（服务端能力白名单里没有它），所以提示语改为面板内展示
  var noticeTimer = null;
  function toast(message, type, duration) {
    if (!el.notice) return;
    el.notice.textContent = String(message === null || message === undefined ? "" : message);
    el.notice.className = "notice pop-card" + (type === "warning" ? " warn" : "") + " on";
    muteHoverUntilMove();
    if (noticeTimer) clearTimeout(noticeTimer);
    var ms = (typeof duration === "number" && duration > 0) ? duration : 4000;
    noticeTimer = setTimeout(function () {
      el.notice.className = "notice pop-card" + (type === "warning" ? " warn" : "");
      el.notice.textContent = "";
      muteHoverUntilMove();
      reportHeight();
    }, ms);
    reportHeight();
  }

  // 打开外部链接；宿主缺 external.open 能力时，用既有 notice 给出**可复制**的完整链接（不静默）。
  function openExternal(url) {
    externalOpen(url, function (u) {
      toast("无法自动打开链接，请手动复制：" + u, "warning", 15000);
    });
  }

  // 弹窗实现见共享层：openModal / closeModal（上方别名）

  // 宿主样式表：只接受 http/https，避免通过查询参数注入异常 URL
  HPU.injectHostCss();

  // ------------------------------------------------------------ 工具

  var SYMBOLS = { CNY: "¥", USD: "$" };
  var TZ_CHANNEL = "hana-plugin:deepseek-balance";
  var BOOT_RETRY_ATTEMPTS = 3;
  var BOOT_RETRY_DELAY_MS = 900;
  // X 轴基础网格（每 3 小时一个整点，由 lib/holidays.js 单一源注入）。
  // 高峰整点由服务端下发的 dayPeakMask 额外补标并按掩码上色 —— 前端不复刻高峰规则、也不需要节假日表。
  var TICK_GRID_HOURS = ${JSON.stringify(TICK_GRID_HOURS)};

  function symbolOf(currency) { return SYMBOLS[currency] || ""; }
  function fixed2(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }
  var NL = String.fromCharCode(10);
  // 金额两位小数（避免 18.529999）
  function money2(v) {
    var n = Number(v);
    return "¥" + (isFinite(n) ? n.toFixed(2) : "0.00");
  }
  // 迷你柱的双口径提示：**token 估算为主**，余额差为旁证；
  // 余额差样本不足或低于分辨率下限（官方余额两位小数）时不给百分比，改显示「分辨率不足」
  function barTipText(b) {
    var tokenCost = Number(b && b.cost) || 0;
    var hasBal = b && b.balanceCost !== null && b.balanceCost !== undefined && isFinite(Number(b.balanceCost));
    var hasDev = b && b.balanceDeviationPct !== null && b.balanceDeviationPct !== undefined && isFinite(Number(b.balanceDeviationPct));
    var l1 = money2(tokenCost) + "（token 估算）";
    var l2 = hasBal ? (money2(b.balanceCost) + "（余额差·旁证）") : "—（余额差）";
    var l3 = (b && b.balanceInsufficient)
      ? "偏离 分辨率不足"
      : (hasDev ? ("偏离 " + Number(b.balanceDeviationPct).toFixed(1) + "%") : "偏离 —");
    return l1 + NL + l2 + NL + l3;
  }
  function fmtMoney(v, currency) {
    var n = Number(v);
    return isFinite(n) ? symbolOf(currency) + fixed2(n) : "--";
  }
  function fmtInt(v) {
    var n = Number(v);
    if (v === null || v === undefined || !isFinite(n)) return "--";
    return String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  }
  function clockText(d) {
    // 「更新于」统一按北京时间显示（与高峰价判定同一基准），不受本机时区影响
    var t = new Date(d.getTime() + 8 * 3600 * 1000);
    return pad2(t.getUTCHours()) + ":" + pad2(t.getUTCMinutes());
  }
  // -1 是「跟随本机」哨兵值，不能当成有效偏移
  function effectiveTz() {
    return (state.tzMin >= -720 && state.tzMin <= 840 && state.tzMin !== -1)
      ? state.tzMin
      : -new Date().getTimezoneOffset();
  }

  // ------------------------------------------------------------ 元素与状态

  var el = {
    widget: document.querySelector(".widget"),
    dot: id("dot"),
    refreshBtn: id("refreshBtn"),
    stamp: id("stamp"),
    notice: id("notice"),
    pageBtn: id("pageBtn"),
    moreBtn: id("moreBtn"),
    tzMenu: id("tzMenu"),
    tip: id("tip"),
    errBox: id("errBox"),
    alertBox: id("alertBox"),
    alertHint: id("alertHint"),
    alertHintText: id("alertHintText"),
    settingLink: id("settingLink"),
    eventBox: id("eventBox"),
    balanceCard: id("balanceCard"),
    balanceValue: id("balanceValue"),
    balanceUnit: id("balanceUnit"),
    breakdownRow: id("breakdownRow"),
    balanceBreakdown: id("balanceBreakdown"),
    grantInfo: id("grantInfo"),
    rechargeBtn: id("rechargeBtn"),
    costValue: id("costValue"),
    costUnit: id("costUnit"),
    costNote: id("costNote"),
    reqValue: id("reqValue"),
    tokensValue: id("tokensValue"),
    usageChart: id("usageChart"),
    todayCostValue: id("todayCostValue"),
    peakInfo: id("peakInfo"),
  };

  var state = {
    refreshSeconds: 60,
    lastSuccessAt: 0,
    alertThreshold: 0,
    eventPromptEnabled: true,
    alertNotify: true,
    currency: "CNY",
    timer: null,
    watchTimer: null,
    inFlight: false,
    failCount: 0,
    bootAttempts: 0,
    bootTimer: null,
    lastRequestCount: -1,
    lastUsage: null,
    lastBalance: null,
    today: null,
    statsFailCount: 0,
    tzMin: -1,
    fillTimer: null,
    miniTimer: null,
    tipMuted: false,
    tipHiddenAt: 0,
  };

  // ------------------------------------------------------------ 网络

  var API_TIMEOUT_MS = 15000; // 单次接口请求上限：路由层挂住时不让面板一直转
  var STATS_FAIL_HINT_AFTER = 3; // fetchStats 连续失败达到此数 → 迷你图位置显示「统计暂不可用」

  // 给 fetch 加超时：超时触发 abort，调用方按「读取失败 + 退避重试」处理
  function withApiTimeout(opt) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    if (!ctrl) return opt;
    opt.signal = ctrl.signal;
    setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }, API_TIMEOUT_MS);
    return opt;
  }

  // 插件 API 统一走共享层的 HPU.api（路径规范化 + surface session 注入都在那里），
  // 面板不再自拼 /api/plugins/{id}/，也不再手动传 session 头。
  function apiFetch(path) {
    // 加时间戳防止宿主/浏览器缓存余额与用量响应，避免显示过期数字
    var sep = path.indexOf("?") >= 0 ? "&" : "?";
    try {
      return HPU.api.fetch(path + sep + "_t=" + Date.now(), withApiTimeout({ method: "GET" }));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  function apiPost(path, body) {
    var req;
    try {
      req = HPU.api.fetch(path, withApiTimeout({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }));
    } catch (e) {
      return Promise.reject(e);
    }
    return req.then(function (res) {
      return res.json().catch(function () { return null; });
    });
  }
  function readJson(res) { return res.json().catch(function () { return null; }); }

  // ------------------------------------------------------------ 界面更新

  // 面板高度回到「贴合内容」：不强制铺满侧栏，剩余的空白交给侧栏本身
  function reportHeight() {
    if (!el.widget) return;
    if (state.fillTimer) return;
    state.fillTimer = setTimeout(function () {
      state.fillTimer = null;
      var h = Math.ceil(el.widget.getBoundingClientRect().height) + 2;
      if (h > 0) {
        post({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { height: h } });
      }
    }, 120);
  }
  function setDot(kind) {
    el.dot.className = "dot" + (kind === "ok" ? " ok" : kind === "err" ? " err" : "");
  }
  function setStamp(text, isError) {
    el.stamp.textContent = text || "";
    el.stamp.className = "stamp" + (isError ? " err" : "");
  }
  function setBusy(busy) {
    // 只让「刷新」自己表达忙碌：旋转 + 置灰。
    // 「去充值」与刷新无因果关系，一旦跟着置灰，半透明落在白卡片上会表现为「变白后回初始」的闪烁。
    el.refreshBtn.disabled = !!busy;
    el.refreshBtn.classList[busy ? "add" : "remove"]("spinning");
  }
  // 面板内异常回传：把 iframe 里未捕获的错误落到与路由同一条日志渠道（POST /api/client-error），
  // 并给一个短错误码（便于口头描述）。回传失败不阻塞展示。
  function reportClientError(message, hint) {
    var code = "E" + Date.now().toString(36).slice(-5).toUpperCase();
    try {
      apiPost("/api/client-error", { code: code, message: String(message === undefined || message === null ? "" : message) })
        .catch(function () { /* 回传失败不阻塞 */ });
    } catch (e) { /* HPU.api 不可用时忽略 */ }
    showError(message + "（错误码 " + code + "）", hint);
    return code;
  }
  // 浮层防御：**只有框、没有内容**时给兜底文案并经 /api/client-error 留痕（落 diagnostics.log）。
  // 覆盖 alertBox / eventBox / errBox 三处（在显示前调用）；有内容时原样不动。
  function guardPopup(el, which, fallback) {
    if (!el) return;
    if ((el.textContent || "").replace(/\s+/g, "")) return; // 有内容 → 不动
    el.textContent = fallback;
    try {
      apiPost("/api/client-error", { code: "POPUP_EMPTY:" + which, message: "popup shown with empty content: " + which })
        .catch(function () { /* 留痕失败不阻塞 */ });
    } catch (e) { /* 忽略 */ }
  }
  function showError(message, hint) {
    var wasVisible = el.errBox.style.display === "block";
    el.errBox.innerHTML = escapeHtml(message) +
      (hint ? '<div class="setup-hint">' + escapeHtml(hint) + '</div>' : "");
    guardPopup(el.errBox, "errBox", "发生未知错误，请查看插件诊断日志。");
    el.errBox.style.display = "block";
    if (!wasVisible) muteHoverUntilMove();
    reportHeight();
  }
  // 预警提示行：阈值>0 才显示；推送关闭时如实标注，避免「以为预警开着却收不到」
  function renderAlertHint() {
    if (!el.alertHint) return;
    el.alertHint.style.display = state.alertThreshold > 0 ? "" : "none";
    if (el.alertHintText) {
      el.alertHintText.textContent = state.alertNotify ? "余额预警已开启" : "余额预警已开启（推送已关闭）";
    }
  }
  function clearError() {
    var wasVisible = el.errBox.style.display === "block";
    el.errBox.style.display = "none";
    el.errBox.innerHTML = "";
    if (wasVisible) muteHoverUntilMove();
    reportHeight();
  }
  function hideAlert() {
    // 浮层收起会**露出**它原本遮住的元素：鼠标若正停在该处，露出的卡片会收到 mouseenter
    // （幽灵 hover：弹提示/hover 底色）。因此仅在真的从“可见”收起时短暂抑制 hover。
    var wasShown = el.alertBox.classList.contains("on");
    el.alertBox.classList.remove("on");
    if (wasShown) muteHoverUntilMove();
    reportHeight();
  }

  // 浮层显隐会改变光标下方的元素（显：浮层盖住卡片；隐：露出的卡片正好在鼠标下）→ 幽灵 hover。
  // 同一病因会点亮多种表现：
  //   卡片提示框（data-tip）、卡片 hover 底色与手型光标、卡内按钮/图标/链接的 hover。
  // 与其逐个打补丁，直接让浏览器认定「鼠标不在内容上」：临时关掉 #content 的指针事件，
  // 上述表现会同时归零。这类被动悬停只有 mouseenter、没有 mousemove，
  // 因此等一次真实 mousemove 再恢复即可；任何点击之前都必有一次 mousemove，不会误伤点击。
  function muteHoverUntilMove() {
    state.tipMuted = true;
    hideTip();
    var content = document.getElementById("content");
    if (content) content.style.pointerEvents = "none";
    var release = function () {
      state.tipMuted = false;
      if (content) content.style.pointerEvents = "";
      window.removeEventListener("mousemove", release, true);
    };
    window.addEventListener("mousemove", release, true);
    setTimeout(release, 1500); // 兜底：久未移动也恢复
  }
  function hideEvent() {
    if (!el.eventBox.classList.contains("on")) { el.eventBox.innerHTML = ""; return; }
    // 可见性用 class 控制，不写内联 display（避免压掉样式表）；收起时抑制一次 hover 派生表现
    el.eventBox.classList.remove("on");
    el.eventBox.innerHTML = "";
    muteHoverUntilMove();
    reportHeight();
  }

  // 关闭事件提示：本地立即收起，同时清掉服务端待处理事件（否则下次刷新会重新弹出）。无自动消失计时器。
  function dismissEvent() {
    hideEvent();
    apiPost("/api/event/resolve", { action: "dismiss" }).catch(function () {
      toast("操作失败，请重试", "warning");
    });
  }

  // 官方价格页型号变动：完全本地检测（零模型调用）。同一变动只提示一次，看过即记。
  var PRICE_ACK_KEY = "deepseek_balance_price_ack";
  function showPriceChange(change) {
    if (!change || !change.at) return;
    var acked = 0;
    try { acked = Number(localStorage.getItem(PRICE_ACK_KEY)) || 0; } catch (e) { acked = 0; }
    if (change.at <= acked) return;
    try { localStorage.setItem(PRICE_ACK_KEY, String(change.at)); } catch (e) { /* 存不下就每次都提示 */ }
    var parts = [];
    if (change.added && change.added.length) parts.push("新增 " + change.added.join("、"));
    if (change.removed && change.removed.length) parts.push("移除 " + change.removed.join("、"));
    if (!parts.length) return;
    toast("官方价格页型号有变动：" + parts.join("；") + "（已自动采用新价格）", "warning", 8000);
  }

  function updateCards(balance, usage) {
    var heightBefore = el.widget ? el.widget.getBoundingClientRect().height : 0;
    var currency = balance.currency || "CNY";
    var sym = symbolOf(currency);
    state.currency = currency;

    el.balanceValue.textContent = fmtMoney(balance.totalBalance, currency);
    el.balanceUnit.textContent = currency;
    renderAlertHint();

    var granted = Number(balance.grantedBalance) || 0;
    if (granted > 0) {
      el.balanceBreakdown.textContent =
        "充值 " + sym + fixed2(balance.toppedUpBalance) + " · 赠送 " + sym + fixed2(granted);
      el.breakdownRow.style.display = "";
      if (el.grantInfo) el.grantInfo.hidden = false;
    } else {
      el.breakdownRow.style.display = "none";
      if (el.grantInfo) el.grantInfo.hidden = true;
    }

    var own = balance.ownSpend;
    var hasOwn = typeof own === "number" && isFinite(own);
    if (hasOwn && own < 0) own = 0;
    if (!hasOwn) {
      el.costValue.textContent = "未配置充值额";
      el.costValue.className = "amount-value is-text";
      el.costUnit.style.display = "none";
      el.costNote.style.display = "none";
    } else {
      el.costValue.textContent = fmtMoney(own, currency);
      el.costValue.className = "amount-value";
      el.costUnit.textContent = currency;
      el.costUnit.style.display = "";
      var refunded = Number(balance.totalRefunded) || 0;
      el.costNote.textContent = refunded > 0 ? "自有资金 · 已退 " + sym + fixed2(refunded) : "自有资金";
      el.costNote.style.display = "";
    }

    el.reqValue.textContent = fmtInt(usage ? usage.requestCount : null);
    el.tokensValue.textContent = fmtInt(usage ? usage.totalTokens : null);
    scheduleMiniChart();
    // 卡片内容变化（拆分行/自有资金状态等）会引起高度变化，光标可能落到别的元素上 → 抑制一次 hover 派生表现
    if (el.widget && Math.abs(el.widget.getBoundingClientRect().height - heightBefore) > 0.5) muteHoverUntilMove();
    reportHeight();
  }

  // ------------------------------------------------------------ 余额事件提示
  //
  // 充值/退款/赠金现在都在服务端**自动入账**，这里只给一条信息性提示（不再需要确认金额/类型）。
  // 保留「忽略」：用它主动清掉这条提示（调用 /api/event/resolve，只清状态、不改累计数）。
  // 自动修正文案遵循现有习惯：「增量 + 结果」。

  function renderEvent(ev, balance) {
    if (!state.eventPromptEnabled || !ev || typeof ev.type !== "string" || !ev.type) {
      hideEvent();
      return;
    }
    var amount = Number(ev.amount) || 0;
    var sym = symbolOf(state.currency) || "¥";
    var title = "";
    var note = "";

    if (ev.type === "recharge") {
      var totalRecharged = Number(balance && balance.totalRecharged);
      title = "已自动修正：充值 " + sym + fixed2(amount) +
        (isFinite(totalRecharged) ? "（累计 " + sym + fixed2(totalRecharged) + "）" : "");
      note = "金额由余额变化反推，可能比实际充值略少；可在插件设置里直接校正累计充值总额。";
    } else if (ev.type === "refund") {
      var totalRefunded = Number(balance && balance.totalRefunded);
      title = "已自动修正：退款 " + sym + fixed2(amount) +
        (isFinite(totalRefunded) ? "（累计 " + sym + fixed2(totalRefunded) + "）" : "");
      note = "充值余额下降，已按推断计入累计退款；可在插件设置里直接校正。";
    } else {
      title = "赠送到账 " + sym + fixed2(amount);
      // 赠金累计值插件不追踪（官方接口不提供），**不伪造累计**；只如实说明本条的记录范围。
      note = "仅记录本次到账（插件不追踪赠金累计）；赠送余额优先扣减、有有效期，明细见平台账单页；不影响自有资金口径。";
    }

    // 充值按整元吸附：残差 > 0 时如实标注（官方只充正整数，差额来自窗口内消费）。
    if (ev.type === "recharge" && Number(ev.snapResidual) > 0) {
      note = "金额按整元吸附，窗口内消费约 ¥" + fixed2(ev.snapResidual) + "。" + (note ? " " + note : "");
    }
    // 累计值写入失败（设置存储暂时不可用）：服务端不会推进基线，下次轮询会自动重试；
    // 这里把这一状态如实告知，避免用户误以为已经入账。
    if (ev.persistFailed) {
      note = "累计值暂未落盘（设置存储不可用），将自动重试，无需手动处理。" + (note ? " " + note : "");
    }

    var wasVisible = el.eventBox.classList.contains("on");
    el.eventBox.innerHTML =
      '<div class="event-head">' +
        '<div class="event-title">' + escapeHtml(title) + '</div>' +
        '<button class="pop-close" id="eventClose" type="button" aria-label="关闭" data-tip="关闭">×</button>' +
      '</div>' +
      '<div class="event-note">' + escapeHtml(note) + '</div>';
    guardPopup(el.eventBox, "eventBox", "余额变动提示内容为空，请检查配置。");
    el.eventBox.classList.add("on");
    if (!wasVisible) muteHoverUntilMove();
    reportHeight();

    var closeBtn = id("eventClose");
    if (closeBtn) { bindTipNode(closeBtn); closeBtn.addEventListener("click", function (e) { e.stopPropagation(); dismissEvent(); }); }
  }

  // ------------------------------------------------------------ 余额预警

  // 余额预警：常驻状态指示 —— 余额低于阈值就一直红着，余额恢复/关闭预警才隐藏。
  // 提示语带「×」：用户删掉后当天不再显示（次日若仍处于低余额会重新出现）。
  // 不做自动消失、不走自动冷却；重复提醒交给服务端推送（余额预警工具 / 微信推送）。
  var ALERT_MUTE_KEY = "deepseek_balance_alert_muted_on";

  // 按**展示时区**取「今天是哪天」（沿用 effectiveTz()，含 -1 跟随本机）——
  // 原实现用浏览器本地日，切到别的展示时区后「今天已静默」的边界会与本机日错开。
  function todayKey() {
    var d = new Date(Date.now() + effectiveTz() * 60000);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function alertMutedToday() {
    try { return localStorage.getItem(ALERT_MUTE_KEY) === todayKey(); } catch (e) { return false; }
  }

  function clearAlertMute() {
    try { localStorage.removeItem(ALERT_MUTE_KEY); } catch (e) { /* 忽略 */ }
  }

  function dismissAlertToday() {
    try { localStorage.setItem(ALERT_MUTE_KEY, todayKey()); } catch (e) { /* 存不下就至少本次隐藏 */ }
    muteHoverUntilMove();
    hideAlert();
  }

  function checkAlert(total) {
    if (state.alertThreshold <= 0) { hideAlert(); return; }
    var value = Number(total);
    if (!isFinite(value) || value >= state.alertThreshold) {
      // 余额回到阈值以上：本轮预警结束，清掉「已删除」标记 —— 下次再跌破会重新提示
      clearAlertMute();
      hideAlert();
      return;
    }
    // 用户删过且条件未重新成立：本轮不再显示
    if (alertMutedToday()) { hideAlert(); return; }

    var wasVisible = el.alertBox.classList.contains("on");
    var sym = symbolOf(state.currency) || "¥";
    el.alertBox.textContent = "";
    var text = document.createElement("span");
    text.className = "alert-text";
    text.textContent = "DeepSeek API 可用余额不足 " + sym + state.alertThreshold + "，请及时充值！";
    var close = document.createElement("button");
    close.type = "button";
    close.className = "pop-close";
    close.setAttribute("aria-label", "今天不再提示");
    // 自绘 .tip（与「自有资金」同一套：单例、120ms 悬停意图、同箭头机制）——**不再用原生 title**
    // （原生 tooltip 出现慢、先出空框再补字，且与插件自绘提示完全不同套）。aria-label 保留给读屏。
    close.setAttribute("data-tip", "今天不再提示");
    close.textContent = "×";
    close.addEventListener("click", dismissAlertToday);
    bindTipNode(close);
    el.alertBox.appendChild(text);
    el.alertBox.appendChild(close);
    guardPopup(el.alertBox, "alertBox", "余额预警：请检查配置（阈值或余额不可用）。");
    // 用 class 控制可见性（默认 display:none，带 .on 才显示）：
    // 既避免内联样式压掉 flex，也避免面板重挂载时先闪一下红框
    el.alertBox.classList.add("on");
    // 预警框出现会改变光标下方的元素，正在显示的卡片提示位置已失效
    hideTip();
    if (!wasVisible) muteHoverUntilMove();
    reportHeight();
  }

  // ------------------------------------------------------------ 数据获取

  async function fetchUsage() {
    try {
      var res = await apiFetch("/api/usage");
      var json = await readJson(res);
      if (json && json.ok && json.data) {
        return { requestCount: json.data.requestCount, totalTokens: json.data.totalTokens };
      }
    } catch (e) {}
    return state.lastUsage || { requestCount: null, totalTokens: null };
  }

  async function fetchStats(range) {
    try {
      var res = await apiFetch("/api/stats?range=" + encodeURIComponent(range) + "&tz=" + encodeURIComponent(String(effectiveTz())));
      var json = await readJson(res);
      if (json && json.ok && json.data) return json.data;
    } catch (e) {}
    return null;
  }

  function fail(message, hint) {
    state.failCount += 1;
    // 首次加载（还没有任何成功数据）失败时先静默重连几次：
    // 插件刚更新后宿主侧的面板凭证可能瞬时不可用，通常重试一次就好
    if (!state.lastBalance && state.lastUsage === null && state.bootAttempts < BOOT_RETRY_ATTEMPTS) {
      state.bootAttempts += 1;
      setDot("");
      setStamp("重新连接 " + state.bootAttempts + "/" + BOOT_RETRY_ATTEMPTS, false);
      if (state.bootTimer) clearTimeout(state.bootTimer);
      state.bootTimer = setTimeout(callData, BOOT_RETRY_DELAY_MS * state.bootAttempts);
      return;
    }
    setDot("err");
    if (state.lastUsage || state.lastBalance) {
      showError(message, hint ? hint + "，当前显示的是上次成功获取的数据" : "当前显示的是上次成功获取的数据");
      setStamp("更新失败 " + clockText(new Date()), true);
    } else {
      showError(message, hint);
      setStamp("获取失败", true);
    }
  }

  async function callData() {
    // 配置读取是本地接口（不出网、不花额度、不占上游配额），因此**不做节流**：
    // 每次取数前都同步一次，保证改完设置后任何刷新节奏都能立即生效。
    try { await reloadConfigQuietly(); } catch (e) { /* 配置读不到就按当前值继续 */ }
    if (state.inFlight) return;
    state.inFlight = true;
    setBusy(true);
    try {
      var res = await apiFetch("/api/balance");
      var json = await readJson(res);

      if (!json || typeof json !== "object") {
        throw new Error("HTTP " + res.status);
      }

      var data = json.ok ? json.data : null;
      if (data && typeof data.totalBalance === "number") {
        // 用量与统计并行拉取，少一次串行等待
        var both = await Promise.all([fetchUsage(), fetchStats("today")]);
        var usage = both[0];
        var stats = both[1];
        if (stats) { state.today = stats; state.statsFailCount = 0; }
        else { state.statsFailCount += 1; }
        state.lastBalance = data;
        state.lastUsage = usage;
        state.failCount = 0;
        state.bootAttempts = 0;
        state.lastSuccessAt = HPU.monoNow();
        state.lastRequestCount = Number.isFinite(Number(usage.requestCount)) ? Number(usage.requestCount) : -1;
        clearError();
        updateCards(data, usage);
        renderEvent(data.event, data);
        checkAlert(data.totalBalance);
        showPriceChange(data.priceChange);
        setDot("ok");
        setStamp("更新于 " + clockText(new Date()), false);
        return;
      }

      if (json.error === "not_configured") {
        hideEvent();
        hideAlert();
        showError("尚未配置 API Key", "请到「设置 → 插件 → DeepSeek API 可用余额」填写 DeepSeek API Key");
        setDot("err");
        setStamp("未配置", true);
        return;
      }

      fail(json.message || json.error || ("请求失败（HTTP " + res.status + "）"), "");
    } catch (err) {
      fail("请求出错：" + (err && err.message ? err.message : String(err)), "");
    } finally {
      state.inFlight = false;
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ 轮询调度

  // 定时间隔与看门狗判定都交给共享层的 HPU.Sched（纯函数，有单测覆盖）。
  // tick 用 try/finally：无论刷新是否成功都排下一次，避免一次异常就永久停摆。
  function scheduleNext() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    var delay = HPU.Sched.computeNextDelay({
      refreshSeconds: state.refreshSeconds,
      failCount: state.failCount,
      hidden: document.hidden,
    });
    if (!(delay > 0)) return;
    state.timer = setTimeout(tick, delay);
  }

  async function tick() {
    try {
      await callData();
    } catch (e) {
      // callData 内部已兜底；这里只防未预期异常打断定时链
    } finally {
      scheduleNext();
    }
  }

  // 设置改动后不必重开面板：心跳里周期性重读本地配置（毫秒级），间隔变化立即生效
  async function reloadConfigQuietly() {
    try {
      var res = await apiFetch("/api/config");
      var json = await readJson(res);
      if (!json || typeof json !== "object") return;
      var next = Number(json.refreshIntervalSeconds);
      if (Number.isFinite(next) && next >= 0 && next !== state.refreshSeconds) {
        state.refreshSeconds = next;
        updateTzNote();
        scheduleNext();
      }
      // 预警相关必须一起热更新：否则改阈值 / 关预警要重开面板才生效（实测踩过这个坑）
      var alertChanged = false;
      if (typeof json.alertThreshold === "number" && json.alertThreshold >= 0 && json.alertThreshold !== state.alertThreshold) {
        state.alertThreshold = json.alertThreshold;
        alertChanged = true;
      }
      state.eventPromptEnabled = json.eventPromptEnabled !== false;
      if (typeof json.alertNotify === "boolean") state.alertNotify = json.alertNotify;
      renderAlertHint();
      if (typeof json.peakRuleText === "string" && json.peakRuleText && el.peakInfo) {
        el.peakInfo.setAttribute("data-tip", json.peakRuleText);
      }
      if (alertChanged) {
        clearAlertMute();
        // 用最近一次已知余额立即重判（余额未知就先隐藏，等下次取数）
        var last = state.lastBalance ? Number(state.lastBalance.totalBalance) : NaN;
        if (isFinite(last)) checkAlert(last);
        else hideAlert();
      }
      // 展示时区也可能被别处改（侧栏拉起的设置页）
      if (typeof json.timezoneOffsetMinutes === "number" && json.timezoneOffsetMinutes !== state.tzMin) {
        state.tzMin = json.timezoneOffsetMinutes;
        updateTzNote();
        scheduleMiniChart();
      }
    } catch (e) {}
  }

  async function watchUsage() {
    if (state.inFlight || state.failCount > 0) return;
    try {
      var res = await apiFetch("/api/usage");
      var json = await readJson(res);
      if (json && json.ok && json.data && typeof json.data.requestCount === "number") {
        if (state.lastRequestCount >= 0 && json.data.requestCount !== state.lastRequestCount) {
          callData();
        }
      }
    } catch (e) {}
  }

  // 看门狗：不假设定时器一定准时（宿主节流、iframe 挂起都会让它失准）。
  // 超过容忍上限（2 个刷新周期，下限 2 分钟）就强制补一次。
  function watchdog() {
    if (state.inFlight || state.failCount > 0) return;
    if (HPU.Sched.shouldWatchdog({
      refreshSeconds: state.refreshSeconds,
      lastSuccessAt: state.lastSuccessAt,
      now: HPU.monoNow(),
    })) callData();
  }

  var HEARTBEAT_MS = 12000;
  var CONFIG_CHECK_EVERY_BEATS = 5; // 每 5 拍（约 60 秒）检查一次配置变化

  function setupTimers() {
    if (state.watchTimer) { clearInterval(state.watchTimer); state.watchTimer = null; }
    // 12 秒心跳：本机用量变化即时触发刷新、看门狗兜底、周期性感知配置变化。
    // 这三件都不出网（/api/config、/api/usage 都是本地接口），因此不随窗口可见性暂停。
    var beats = 0;
    state.watchTimer = setInterval(function () {
      beats += 1;
      watchUsage();
      watchdog();
      if (beats % CONFIG_CHECK_EVERY_BEATS === 0) reloadConfigQuietly();
    }, HEARTBEAT_MS);
    scheduleNext();
  }

  // ------------------------------------------------------------ 交互绑定

  // ------------------------------------------------------------ 自绘提示框

  // 提示框隐藏只淡出（无位移），且“淡出中”不允许被重定位（见 renderTip）。本常量与 CSS 的 .12s 对齐。
  var TIP_FADE_MS = 120;
  // 悬停意图：进入锚点后先等这么久才真正弹提示；期间如果移出（hideTip）就取消。
  // 这样“快速掠过”不再闪一个提示（作者报的现象），而“刻意悬停”只是晚 120ms，体感不变。
  var TIP_SHOW_DELAY = 120;
  var tipShowTimer = null;
  var tipPendingAnchor = null;

  function cancelTipShow() {
    if (tipShowTimer) { clearTimeout(tipShowTimer); tipShowTimer = null; }
    tipPendingAnchor = null;
  }

  // 悬停意图闸门：不直接显示，先挂一个延迟；hideTip（移出/掠过/抑制）会取消它。
  function showTip(anchor) {
    // 收起预警框后抑制一次：避免布局位移把鼠标“送到”卡片上造成的误提示
    if (state.tipMuted) return;
    var text = anchor && anchor.getAttribute ? anchor.getAttribute("data-tip") : "";
    if (!text || !el.tip || !el.widget) return;
    if (tipShowTimer && tipPendingAnchor === anchor) return;   // 同一锚点已在等待，不重置计时
    cancelTipShow();
    tipPendingAnchor = anchor;
    tipShowTimer = setTimeout(function () {
      tipShowTimer = null;
      var a = tipPendingAnchor;
      tipPendingAnchor = null;
      renderTip(a);
    }, TIP_SHOW_DELAY);
  }

  // 真正把提示框画到锚点上。
  function renderTip(anchor) {
    if (state.tipMuted) return;
    var text = anchor && anchor.getAttribute ? anchor.getAttribute("data-tip") : "";
    if (!text || !el.tip || !el.widget) return;
    // 提示框是**单例元素**：若它正在淡出（刚被 hideTip 且仍在过渡时长内），
    // 直接改几何会让“正在淡出的那一帧”可见地跳到新锚点（小尾巴跳到上一个卡片）。
    // 先以“禁用过渡”的方式把透明度归 0（此时不可见），再改几何，最后恢复过渡淡入。
    // 判定用时间（不与 getComputedStyle 挂钩），在任何引擎下都确定。
    var fading = !el.tip.classList.contains("on") && state.tipHiddenAt > 0 && (Date.now() - state.tipHiddenAt) <= TIP_FADE_MS;
    if (fading) { el.tip.style.transition = "none"; el.tip.style.opacity = "0"; }
    el.tip.textContent = text;
    el.tip.style.left = "0px";
    el.tip.style.top = "0px";
    var wr = el.widget.getBoundingClientRect();
    var ar = anchor.getBoundingClientRect();
    var tw = el.tip.offsetWidth;
    var th = el.tip.offsetHeight;
    var anchorCenter = ar.left - wr.left + ar.width / 2;
    var left = anchorCenter - tw / 2;
    left = Math.max(6, Math.min(left, wr.width - tw - 6));
    // 方向：卡片内沿用旧规则（朝卡片外侧）；浮层卡内（预警 × / 事件 ×）**已回退为朝下**（1.14.45）——
    // 与 'other' 同义，保留 containerKind 分类只为将来区分容器种类（作者原话的「下方」指图层，非空间位置）。
    // 旧规则只认 .card，浮层卡的锚点命中不到 ⇒ 原本被放到下方、落到弹窗下沿之外（作者报）。
    // 选择逻辑抽成纯函数 HPU.chooseTipAbove（含两条兜底：上方不足翻下 / 下方超界翻上）。
    var card = anchor.closest ? anchor.closest(".card") : null;
    var popup = (!card && anchor.closest) ? anchor.closest(".box") : null;
    var anchorTop = ar.top - wr.top;
    var anchorBottom = ar.bottom - wr.top;
    var containerMid = 0;
    if (card) {
      var cr = card.getBoundingClientRect();
      containerMid = cr.top - wr.top + cr.height / 2;
    }
    var above = HPU.chooseTipAbove({
      anchorMid: anchorTop + ar.height / 2,
      anchorTop: anchorTop,
      anchorBottom: anchorBottom,
      containerMid: containerMid,
      containerKind: card ? "card" : (popup ? "popup" : "other"),
      tipHeight: th,
      panelHeight: wr.height,
    });
    var top = above ? (anchorTop - th - 7) : (anchorBottom + 7);
    top = Math.max(4, Math.min(top, wr.height - th - 4));
    el.tip.style.left = Math.round(left) + "px";
    el.tip.style.top = Math.round(top) + "px";
    // 小箭头始终指向被悬停元素的中心
    var arrowX = Math.round(Math.max(9, Math.min(anchorCenter - left, tw - 9)));
    el.tip.style.setProperty("--arrow-x", arrowX + "px");
    el.tip.className = "tip on" + (above ? " above" : "");
    el.tip.setAttribute("aria-hidden", "false");
    state.tipHiddenAt = 0;   // 已重新显现，不再处于淡出
    if (fading) {
      // 强制提交“不可见 + 新几何”这一帧，再恢复过渡（从 0 淡入）
      void el.tip.offsetWidth;
      el.tip.style.transition = "";
      el.tip.style.opacity = "";
    }
  }

  function hideTip() {
    cancelTipShow();   // 移出/掠过/抑制 → 取消尚未真正显示的提示
    if (!el.tip) return;
    // 必须保留方向类 above：基类 .tip::after 是 bottom: 100%（箭头落在提示框上边，
    // 因为“默认显示在锚点下方”时箭头才在上边）。若在这里回落成 className = "tip"，
    // 箭头会瞬间从下边翻到上边框（与悬停态关于提示框中线上下镜像）——淡出的 120ms 里肉眼可见；
    // 提示框恰好落在两卡之间的间隙时，它的上边框就贴着上方那张卡的边框。
    el.tip.className = el.tip.classList.contains("above") ? "tip above" : "tip";
    el.tip.setAttribute("aria-hidden", "true");
    // 记录隐藏时刻：用于判断下一次 renderTip 是否正处在淡出过程中（与 CSS 的 .12s 过渡对齐）
    state.tipHiddenAt = Date.now();
  }

  // 卡片内的操作元素（按钮/链接）不承载外层卡片的提示，
  // 否则悬停「去充值」「去设置」会弹出「单击刷新，双击查看官方用量」这种不对症的话。
  function bindTipExclusions() {
    var nodes = document.querySelectorAll("[data-tip] button, [data-tip] .link, [data-tip] a");
    Array.prototype.forEach.call(nodes, function (node) {
      node.addEventListener("mouseenter", hideTip);
      node.addEventListener("mouseleave", function (e) {
        // 只在“指针仍留在该锚点内”时恢复锚点提示：
        // 若指针是经此按钮/链接**直接离开锚点**（relatedTarget 在锚点之外或为 null），
        // 不重建提示——否则会以“外层卡片”为锚点重显一帧，小尾巴跳到卡片位置（作者报的“一闪”）。
        var anchor = node.closest ? node.closest("[data-tip]") : null;
        var to = e && e.relatedTarget;
        if (anchor && to && anchor.contains(to)) showTip(anchor);
      });
    });
  }

  // 单节点提示绑定：鼠标与键盘（focus/blur）两条路径都挂上。
  // 静态节点由 bindTips 批量绑；**动态创建的节点（如预警 × / 事件 ×）在创建后立即调用本函数**。
  function bindTipNode(node) {
    if (!node) return;
    node.addEventListener("mouseenter", function () { showTip(node); });
    node.addEventListener("mouseleave", hideTip);
    node.addEventListener("focus", function () { showTip(node); });
    node.addEventListener("blur", hideTip);
  }

  function bindTips() {
    var nodes = document.querySelectorAll("[data-tip]");
    Array.prototype.forEach.call(nodes, bindTipNode);
    bindTipExclusions();
    window.addEventListener("scroll", hideTip, true);
  }

  // 迷你柱的双口径提示：柱子是动态生成的，静态 bindTips 抓不到，这里在容器上做事件委托，
  // 复用同一套 showTip/hideTip（不新增提示元素、不与既有 data-tip 冲突）。
  function bindChartTips() {
    if (!el.usageChart) return;
    el.usageChart.addEventListener("mouseover", function (e) {
      var t = e.target;
      var r = (t && t.closest) ? t.closest("[data-tip]") : null;
      if (r) showTip(r); else hideTip();
    });
    el.usageChart.addEventListener("mouseleave", hideTip);
  }

  // ------------------------------------------------------------ 迷你图表

  // 轴刻度：按量级向上取整到 1/2/5 × 10^n，避免出现 0.3522 这种刻度
  function niceCeil(v) {
    var n = Number(v);
    if (!(n > 0)) return 1;
    var exp = Math.pow(10, Math.floor(Math.log(n) / Math.LN10));
    var f = n / exp;
    var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * exp;
  }
  function fmtMiniMoney(v, max) {
    var n = Number(v) || 0;
    if (n === 0) return "¥0";
    if (max >= 10) return "¥" + n.toFixed(0);
    if (max >= 1) return "¥" + n.toFixed(2);
    if (max >= 0.1) return "¥" + n.toFixed(3);
    return "¥" + n.toFixed(4);
  }

  function miniBarsSvg(buckets, width, height, tzMin, peakMask) {
    var tz = Number.isFinite(Number(tzMin)) ? Number(tzMin) : effectiveTz();
    // 高峰刻度掩码：服务端按「北京时间 + 节假日」算好的逐小时布尔数组（单一事实源）。
    // 前端不再复刻高峰规则、也不需要节假日表；掩码按绝对时刻算，切展示时区不会错位。
    var mask = Array.isArray(peakMask) ? peakMask : [];
    var sym = symbolOf(state.currency) || "¥";
    var padTop = 6, padBottom = 13, padLeft = 30, padRight = 6;
    var innerH = Math.max(16, height - padTop - padBottom);
    var innerW = Math.max(20, width - padLeft - padRight);
    var rawMax = 0;
    for (var i = 0; i < buckets.length; i += 1) { var c = Number(buckets[i].cost) || 0; if (c > rawMax) rawMax = c; }
    var max = niceCeil(rawMax); // 自适应纵轴上限（金额）
    var bw = innerW / Math.max(1, buckets.length);
    var barW = Math.max(1.5, Math.min(14, bw * 0.6));
    // 刻度字号自适应：高峰窗口内整点相连，相邻刻度最小间距 = bw；
    // 在保证两位数字不重叠的前提下尽量放大（上限 9，与 Y 轴刻度一致）。
    var tickFont = Math.max(5.5, Math.min(9, Math.round(((bw - 1) / 1.15) * 10) / 10));
    var svg = ['<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">'];
    // 网格线：高度很大时靠刻度而不是柱形比例来读图
    var ticks = 2;
    for (var g = 0; g <= ticks; g += 1) {
      var gy = padTop + innerH - (innerH * g) / ticks;
      svg.push('<line x1="' + padLeft + '" y1="' + gy.toFixed(1) + '" x2="' + width + '" y2="' + gy.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>');
      svg.push('<text x="' + (padLeft - 4) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="var(--text-tertiary)">' + fmtMiniMoney((max * g) / ticks, max) + '</text>');
    }
    for (var k = 0; k < buckets.length; k += 1) {
      var v = Number(buckets[k].cost) || 0;
      var hh = (v / max) * innerH;
      var x = padLeft + k * bw + (bw - barW) / 2;
      var y = padTop + innerH - hh;
      var hour = pad2(new Date(buckets[k].t + tz * 60000).getUTCHours());
      if (v > 0) {
        // 柱子保持原色；双口径提示挂在 rect 上，交给侧栏既有 .tip 机制
        var tipAttr = escapeHtml(barTipText(buckets[k])).split(NL).join("&#10;");
        svg.push('<rect class="dsb-bar" data-tip="' + tipAttr + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(0.8, hh).toFixed(1) + '" rx="1.5"></rect>');
      }
      // X 轴刻度：位置按展示时区（hour），「是否画」= 基础网格 或 命中高峰掩码；
      // 「颜色」只由掩码决定（mask[k] 为 true 时标腺脂红）。因此切到任意展示时区，
      // 被标红的刻度都对应北京的 9-12 / 14-18 —— 前端不再按展示钟点套固定高峰窗口。
      var labelHour = Number(hour);
      var isPeakTick = mask[k] === true;
      if (TICK_GRID_HOURS.indexOf(labelHour) >= 0 || isPeakTick) {
        var tickFill = isPeakTick ? "var(--peak)" : "var(--text-tertiary)";
        svg.push('<text x="' + (padLeft + k * bw + bw / 2).toFixed(1) + '" y="' + (height - 3) + '" text-anchor="middle" font-size="' + tickFont + '" fill="' + tickFill + '">' + hour + '</text>');
      }
    }
    svg.push('</svg>');
    return svg.join('');
  }

  // 用 setTimeout 而不是 rAF：面板隐藏时 rAF 会被节流/暂停，图表尺寸就不会跟着变
  function scheduleMiniChart() {
    if (state.miniTimer) return;
    state.miniTimer = setTimeout(function () {
      state.miniTimer = null;
      renderMiniChart();
    }, 60);
  }

  // 侧栏迷你图固定展示「今日 24 个整点」：接口只返回「零点到此刻」的桶，
  // 这里把缺的整点补成空桶，让 X 轴 0-23 每个整点都能标出（仅小时桶补，其他粒度不补）。
  function fullDayBuckets(d) {
    var buckets = (d && Array.isArray(d.buckets)) ? d.buckets : [];
    var HOUR = 3600000;
    if (!buckets.length || Number(d.bucketMs) !== HOUR) return buckets;
    var start = Number.isFinite(Number(d.since)) ? Number(d.since) : Number(buckets[0].t);
    var byIdx = {};
    for (var i = 0; i < buckets.length; i += 1) {
      byIdx[Math.round((Number(buckets[i].t) - start) / HOUR)] = buckets[i];
    }
    var out = [];
    for (var k = 0; k < 24; k += 1) {
      out.push(byIdx[k] || { t: start + k * HOUR, requests: 0, tokens: 0, cost: 0, peak: false, balanceCost: null, balanceDeviationPct: null, balanceInsufficient: false, byModel: {} });
    }
    return out;
  }

  function renderMiniChart() {
    if (!el.usageChart) return;
    hideTip(); // 重绘前先收起旧提示，避免悬停残留
    var sym = symbolOf(state.currency) || "¥";
    // 统计接口连续失败：用既有空态那一行给出可见信号（复用 .chart-empty：11px、填满固定高度，不新增字号/不改高度）
    if (state.statsFailCount >= STATS_FAIL_HINT_AFTER) {
      el.usageChart.innerHTML = '<div class="chart-empty">统计暂不可用</div>';
      if (el.todayCostValue) el.todayCostValue.textContent = '--';
      return;
    }
    var d = state.today;
    if (!d || !d.buckets || !d.buckets.length) {
      el.usageChart.innerHTML = '<div class="chart-empty">今日暂无记录</div>';
      if (el.todayCostValue) el.todayCostValue.textContent = '--';
      return;
    }
    var w = Math.max(80, Math.round(el.usageChart.clientWidth));
    var h = Math.max(36, Math.round(el.usageChart.clientHeight));
    var tz = Number.isFinite(Number(d.tzMinutes)) ? Number(d.tzMinutes) : effectiveTz();
    el.usageChart.innerHTML = miniBarsSvg(fullDayBuckets(d), w, h, tz, d.dayPeakMask);
    // 今日消费额：官方同步覆盖到当日 → 用官方当日金额（覆盖点之后的本机用量按估算补上）；
    // 未同步/未覆盖 → 沿用「余额差」口径（旁证，样本全缺时显示 --），不拿估算冒充余额差。
    var t = d.totals || {};
    var costValue = null;
    if (t.officialCovered && typeof t.cost === 'number' && isFinite(t.cost)) {
      costValue = t.cost;
    } else if (typeof t.balanceCost === 'number' && isFinite(t.balanceCost)) {
      costValue = t.balanceCost;
    }
    if (el.todayCostValue) el.todayCostValue.textContent = costValue === null ? '--' : sym + fixed2(costValue);
  }

  function updateTzNote() {
    var node = id("tzText");
    if (!node) return;
    var tail = state.refreshSeconds > 0
      ? "数据最多可能有 " + Math.max(1, Math.round(state.refreshSeconds / 60)) + " 分钟延迟。"
      : "数据按需刷新。";
    node.textContent = "所有日期均按 " + tzLabel(effectiveTz()) + " 时间显示，" + tail;
  }

  function renderMenuState() {
    var local = -new Date().getTimezoneOffset();
    var items = document.querySelectorAll("#tzMenu .menu-item");
    Array.prototype.forEach.call(items, function (b) {
      var v = Number(b.getAttribute("data-tz"));
      b.className = "menu-item" + (HPU.tzItemOn(v, state.tzMin, local) ? " on" : "");
      var lbl = b.querySelector(".menu-label");
      if (lbl && v === -1) lbl.textContent = "跟随本机（" + tzLabel(local) + "）";
    });
  }

  function closeMenu() {
    if (!el.tzMenu || el.tzMenu.hidden) return;
    el.tzMenu.hidden = true;
    if (el.moreBtn) el.moreBtn.setAttribute("aria-expanded", "false");
    muteHoverUntilMove();
  }

  function openMenu() {
    if (!el.tzMenu || !el.widget || !el.moreBtn) return;
    renderMenuState();
    el.tzMenu.hidden = false;
    var wr = el.widget.getBoundingClientRect();
    var br = el.moreBtn.getBoundingClientRect();
    var mw = el.tzMenu.offsetWidth;
    var left = br.right - wr.left - mw;
    left = Math.max(6, Math.min(left, wr.width - mw - 6));
    el.tzMenu.style.left = Math.round(left) + "px";
    el.tzMenu.style.top = Math.round(br.bottom - wr.top + 6) + "px";
    el.moreBtn.setAttribute("aria-expanded", "true");
    muteHoverUntilMove();
  }

  async function refreshStatsOnly() {
    var stats = await fetchStats("today");
    if (stats) {
      state.today = stats;
      scheduleMiniChart();
    }
  }

  async function chooseTz(minutes) {
    closeMenu();
    try {
      var json = await apiPost("/api/timezone", { offsetMinutes: minutes });
      if (!json || !json.ok) {
        toast((json && json.message) || "保存时区失败", "warning");
        return;
      }
    } catch (e) {
      toast("保存时区失败", "warning");
      return;
    }
    state.tzMin = minutes;
    updateTzNote();
    renderMenuState();
    // 广播给同源的其他插件面板（用量详情页），让它立刻重算
    try {
      if (typeof BroadcastChannel === "function") {
        var bc = new BroadcastChannel(TZ_CHANNEL);
        bc.postMessage({ type: "tz-changed", tzMinutes: minutes, at: Date.now() });
        bc.close();
      }
    } catch (e) {}
    var tzShown = minutes === -1 ? "跟随本机（" + tzLabel(-new Date().getTimezoneOffset()) + "）" : tzLabel(minutes);
    toast("已切换到 " + tzShown + "，用量数据已按新时区重算", "info");
    await refreshStatsOnly();
  }

  // ------------------------------------------------------------ 余额预警设置弹窗
  // 显示设置入口路径，把「余额预警阈值」做成输入框；「修改」按钮写 /api/config（不新造端点）。
  function openSettingsModal() {
    var inputRef = null;
    var initial = Number(state.alertThreshold) > 0 ? Number(state.alertThreshold) : 0;
    openModal({
      title: "余额预警设置",
      centerTitle: true,
      closable: true,
      okText: "修改",
      // 弹窗关闭后光标下方的元素会变 → 抑制一次 hover 派生表现
      onClose: function () { muteHoverUntilMove(); },
      bodyBuild: function (body) {
        var pathRow = document.createElement("div");
        pathRow.textContent = "实际路径：Hana 设置 → 插件 → DeepSeek API 可用余额";
        body.appendChild(pathRow);
        if (!state.alertNotify) {
          var offRow = document.createElement("div");
          offRow.textContent = "推送已关闭：预警不会主动通知你（可在设置 → 插件里打开「余额不足时允许推送通知」）。";
          body.appendChild(offRow);
        }
        var field = document.createElement("div");
        field.className = "modal-field";
        var lab = document.createElement("label");
        lab.setAttribute("for", "alertThresholdInput");
        lab.textContent = "余额预警阈值";
        var inp = document.createElement("input");
        // type=text + inputmode=decimal：纯输入框、无 spinner；数值语义全靠下方校验
        inp.type = "text";
        inp.id = "alertThresholdInput";
        inp.setAttribute("inputmode", "decimal");
        inp.setAttribute("autocomplete", "off");
        inp.value = String(initial);
        inp.addEventListener("input", function () { sanitizeThresholdInput(inp); });
        field.appendChild(lab);
        field.appendChild(inp);
        body.appendChild(field);
        inputRef = inp;
      },
      onOk: function () { return submitAlertThreshold(inputRef); },
    });
  }

  // 输入时规范：只留数字与小数点、去掉多余小数点、小数最多两位（超两位截断）
  function sanitizeThresholdInput(inp) {
    var raw = String(inp.value === undefined ? "" : inp.value);
    var cleaned = raw.replace(/[^\\d.]/g, "");
    var dot = cleaned.indexOf(".");
    if (dot >= 0) cleaned = cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\\./g, "");
    cleaned = cleaned.replace(/^(\\d*\\.\\d{2})\\d+$/, "$1");
    if (cleaned !== raw) inp.value = cleaned;
  }

  // 提交阈值：返回 true = 关闭弹窗；false = 保持打开（未变动）
  function submitAlertThreshold(input) {
    var raw = input && input.value !== undefined ? String(input.value).trim() : "";
    var v = raw === "" ? 0 : Number(raw);   // 0 或留空 = 不设置阈值
    if (!isFinite(v) || v < 0) v = 0;        // 只接受正数或 0
    v = Math.round(v * 100) / 100;           // 小数最多两位
    var cur = Number(state.alertThreshold) || 0;
    if (Math.abs(v - cur) < 1e-9) {
      // 值未变动：设置弹窗保持打开，只叠一个居中提示浮层
      openNotice({ text: "余额预警阈值未变动，请核对！", tone: "plain", durationMs: 3000 });
      return false;
    }
    // 值变动：写 /api/config（已有端点，不新造），关弹窗后再叠居中提示浮层
    apiPost("/api/config", { alertThreshold: v }).then(function (json) {
      if (!json || !json.ok) { openNotice({ text: "保存失败，请重试", tone: "plain", durationMs: 3000 }); return; }
      var saved = Number(json.alertThreshold);
      state.alertThreshold = isFinite(saved) ? saved : v;
      renderAlertHint();
      // 阈值是用户主动改的 → 重新武装预警
      clearAlertMute();
      var last = state.lastBalance ? Number(state.lastBalance.totalBalance) : NaN;
      if (isFinite(last)) checkAlert(last); else hideAlert();
      openNotice({
        text: state.alertThreshold > 0
          ? ("已将余额预警阈值改为" + fixed2(state.alertThreshold))
          : "已将余额预警阈值改为0.00（不设置阈值，不再提醒）",
        tone: "setting",
        durationMs: 3000,
      });
    }).catch(function () { openNotice({ text: "保存失败，请重试", tone: "plain", durationMs: 3000 }); });
    return true;
  }

  function bindInteractions() {
    // 手动刷新的语义：先把配置同步过来（阈值/间隔/展示时区可能刚被改过），再取数。
  // 否则改完设置点刷新看不到变化，要等下一次周期性热重载（约 60 秒）。
  function refreshNow() {
    return reloadConfigQuietly().then(function () { return callData(); });
  }

  el.refreshBtn.addEventListener("click", refreshNow);
    el.pageBtn.addEventListener("click", openUsagePage);
    el.moreBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (el.tzMenu.hidden) openMenu(); else closeMenu();
    });
    el.tzMenu.addEventListener("click", function (e) {
      var item = e.target && e.target.closest ? e.target.closest(".menu-item") : null;
      if (!item) return;
      e.stopPropagation();
      chooseTz(Number(item.getAttribute("data-tz")));
    });
    document.addEventListener("click", function () {
      if (el.tzMenu && !el.tzMenu.hidden) closeMenu();
    });
    // 事件弹窗的第二种关闭方式：鼠标左键单击弹窗区域外的任意位置
    document.addEventListener("click", function (e) {
      if (!el.eventBox || !el.eventBox.classList.contains("on")) return;
      if (el.eventBox.contains(e.target)) return;
      dismissEvent();
    });
    // Escape 关闭：提示框 / 时区菜单 / 模态弹窗 / 事件弹窗 / 错误框。
    // **不绑预警红窗**：它带「今天不再提示」的显式语义，Escape 会造成歧义；红窗已有可聚焦的 × 按钮，
    // 键盘可达性不受影响（本批明确排除）。
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { hideTip(); closeMenu(); closeModal(); hideEvent(); clearError(); }
    });

    var clickTimer = null;
    el.balanceCard.addEventListener("click", function () {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(function () { refreshNow(); }, 260);
    });
    el.balanceCard.addEventListener("dblclick", function () {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      openExternal("https://platform.deepseek.com/usage");
    });
    // 键盘等价动作（P2 / 已拍板）：聚焦余额卡后 Enter/Space = 刷新，Shift+Enter = 查看官方用量。
    // 复用与 click/dblclick 完全相同的两个函数，保证行为一致；外观/鼠标路径/提示文本不变。
    el.balanceCard.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) { openExternal("https://platform.deepseek.com/usage"); return; }
      refreshNow();
    });
    el.rechargeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openExternal("https://platform.deepseek.com/top_up");
    });
    el.settingLink.addEventListener("click", function (e) {
      e.stopPropagation();
      openSettingsModal();
    });
    HPU.bindModal();

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      tick();
    });
    window.addEventListener("resize", function () {
      reportHeight();
      scheduleMiniChart();
    });
    // 面板宽度变化（侧栏拖宽/变窄）时重算图表尺寸
    if (typeof ResizeObserver === "function" && el.usageChart) {
      var ro = new ResizeObserver(function () { scheduleMiniChart(); });
      ro.observe(el.usageChart);
    }
    window.addEventListener("resize", reportHeight);
  }

  async function loadConfig() {
    try {
      var res = await apiFetch("/api/config");
      var json = await readJson(res);
      if (json && typeof json === "object") {
        if (typeof json.refreshIntervalSeconds === "number" && json.refreshIntervalSeconds >= 0) {
          state.refreshSeconds = json.refreshIntervalSeconds;
        }
        if (typeof json.alertThreshold === "number" && json.alertThreshold >= 0) {
          state.alertThreshold = json.alertThreshold;
        }
        state.eventPromptEnabled = json.eventPromptEnabled !== false;
        if (typeof json.alertNotify === "boolean") state.alertNotify = json.alertNotify;
        if (typeof json.peakRuleText === "string" && json.peakRuleText && el.peakInfo) {
          el.peakInfo.setAttribute("data-tip", json.peakRuleText);
        }
        if (typeof json.timezoneOffsetMinutes === "number") state.tzMin = json.timezoneOffsetMinutes;
      }
    } catch (e) {}
    renderAlertHint();
    updateTzNote();
    renderMenuState();
  }

  // ------------------------------------------------------------ 启动

  bindInteractions();
  bindTips();
  bindChartTips();
  sendReady();
  reportHeight();

  (async function boot() {
    await loadConfig();
    await callData();
    setupTimers();
  })();
})();
</script>
</body>
</html>`;

export default function (app, ctx) {
  app.get('/widget', (c) => {
    return c.html(WIDGET_HTML);
  });
}
