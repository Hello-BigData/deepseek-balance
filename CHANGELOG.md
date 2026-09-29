# deepseek-balance 变更记录

版本号遵循语义化：功能新增进中位，修复与打磨进末位。

## 1.16.2

**公开面清理（无功能变更）**：仓库里散落的第一人称称呼统一换成「作者」。

- 37 处个人称呼统一替换为「作者」：CHANGELOG 19、`routes/widget.js` 7、`tests/run-all.mjs` 5、`lib/ui-shared.js` 2、`README.md` 2、`lib/holidays.js` 1、`tools/balance-alert.js` 1。
- 涉 CSS 层叠的「父链」（父元素一脉的术语）2 处保持原样；README 「数据与隐私」把出网口径写全：充值按钮经宿主 `openExternal` 打开 `platform.deepseek.com`，不算插件发请求。
- 自检 742 项全绿不变。

## 1.16.1

**仓库准备（无功能变更）**：为公开仓库做卫生与接入文档 —— 自检脚本不再硬编码本机路径、补 `.gitignore`、打包排除 `.git`、新增宿主定时推送（微信等）的接入文档与模板。

- `tests/run-all.mjs` 的宿主通道检查不再写死 `C:/Users/<用户名>/.hanako/server-info.json` 与端口 `27352`：改为 `HANA_SERVER_INFO` / `HANA_SERVER` 环境变量优先，缺省用 `os.homedir()`（可用 `HANA_HOME` 覆盖数据目录）推导，端口从 `server-info.json` 读，读不到才回到 `27352`；跳过提示与注释里也不再出现本机绝对路径。
  **附带的真实发现**：写死的端口 27352 与本机实际端口不符，导致这一整节（11 项宿主通道检查：两面板 200 / 共享层节点 / 弹窗节点次序 / 内联脚本可编译 / `stats` 可用 / 型号价格状态）在本机长期以「宿主服务未运行」被整体跳过。改为读 `server-info.json` 后这 11 项真正跑起来：10 项通过，1 项**暴露断言过窄** —— 已修（见下）。
- 修 `官方价格已生效于已收录型号` 断言：它只认 `priceSource` 含「官方价格页」，但做过**官方账单同步**的型号 `priceSource='official'`（官方数据本身，比价格页更权威），于是被误判。改为两者都算权威来源。
- 自检现在 **742 项**（宿主在运行时；宿主未运行会自动跳过那 11 项），全绿。
- 新增 `.gitignore`：`backups/`、`plugin-data*/`、`*.zip`、`*.tmp`、`*.bak*`、`node_modules/`、`.DS_Store` 等一律不入库；`config.json` / `state.json` / `*.log` 兜底忽略（密钥与运行态）。
- `scripts/release.mjs` 的打包排除项新增 `.git`（仓库初始化后再打包，不会把版本库塞进 zip）。
- 新增 `integrations/wechat-alert.md` 与 `integrations/wechat-alert.cron.json`：**定时任务不在插件包里**，这里给出宿主侧 cron 任务（`0 * * * *`）+ 两步 prompt（工具判定 → `notify` 投递）的可复制模板，含换平台/调参/排错；README 的「配置」节加了入口。
- 自检保持 **742 项**全绿（宿主在运行时含 11 项宿主通道检查；打包守卫新增 `.git` 判据）。

## 1.16.0

**功能：官方导出的粒度是「随区间长度变化」的 —— 短区间给逐小时整点桶，长区间给按日行；本版把两路粒度都吃下，按「天」定权威合并，小时数据接进详情页小时柱状图、高峰金额与侧栏今日消费额。**

### 背景
- 1.15.0 之后又观察到：官方导出**并非**固定按日 —— 导「今天」这样的一两天区间，`cost-*.csv` 的行是**逐小时整点桶**（`start_time_iso` 09:00 → `end_time_iso` 09:30/10:00…），导 30 天才是按日。
- 旧实现把整个 `officialSync` 当「按日」处理且**整体替换**：导入今日小时包会把此前导入的 30 天历史抹掉，且小时金额只能被压成一整天的值（日内起伏全丢、高峰金额算不出）。

### 新增
- **粒度自动判定**（`lib/official-sync.js`）：每行按自身跨度分档 —— `end − start ≤ 2h` 记为**小时桶**（键 = 北京整点起点 `hourStartMs`），否则记为**按日行**；同一份包里两种可共存（`granularity = 'hour' | 'day' | 'mixed'`）。无需用户选，也无需看文件名推断。
- **v2 数据集结构**：`hours[]`（整点桶）+ `days[]`（权威日表，带 `hourCovered`/`hourCount`）+ `imports[]`（最近 20 次导入台账）。v1（仅 `days`）读回时自动迁移，无需清账。
- **「小时包优先」的合并**（`mergeSync`）：某一天只要任一份包里带小时桶，该天就以小时桶求和为准，两侧的同天日行都丢弃；其余天按日行保留（同一天两侧都有日行时新包胜）。判据与导入顺序无关 ⇒ 「日包 ⊕ 小时包」两个方向结果逐字相同，重复导入幂等。于是「导入今日小时包」不再抹掉长区间历史，后导的日包也不会把已有的小时明细顶掉。
- **覆盖末端取包内真实最后一行**（`maxEndMs`）而非「末日 24 点」：按小时导出的末日那格是半截，否则会把官方尚未结算的分钟算成「已覆盖」。
- **详情页**：小时档（今天/昨天/短区间）下官方整点直接注入对应小时桶（柱状图看得出日内起伏）；高峰金额可由官方小时桶按钟点拆出，新增 `totals.peakKnown` / `peakFrom`（`local`/`official`/`mixed`）作为前端唯一判据；脚注与同步面板按 `granularity` 分别说明「按小时 / 按日 / 混合」，面板新增最近 24 格逐小时明细表与导入台账。
- 侧栏今日消费额沿用 `officialCovered → totals.cost`，小时数据自动受益，`widget.js` 无需改动。

### 变更
- 同一整天两种粒度撞上时的消解规则：**小时包优先**（作者 2026-09-28 定）——两份包给同一天的金额会因导出时刻不同而漂（今天实测日包 25.632143 元 vs 小时包 26.484852 元），改由更细的一方说话，且不再取决于哪份后导。
- 小时档下官方值**只进桶、不进总量**（总量由派生日表算），两种粒度绝不对同一天双算。
- `/api/stats` 的「提档到按天」只在窗口内存在**仅按日的官方日**时触发；带小时桶的官方日不再提档（今日/昨日的柱状图保持小时粒度）。
- `cacheKey` 加入同步版本（`importedAt`/天数/小时数），换包后立即失效，不必等 TTL。

### 安全
- 与 1.15.0 同：state 只落数值聚合，无 `user_id` / `api_key` / `api_key_name` / 原始文本；出网域名与 methods 未变。

### 自检
- `tests/run-all.mjs` 新增 [24.9]（小时解析 / buildSync / mergeSync 幂等与对称 / v1 迁移 / 日后到也不夺权 / 历史保留）与 [24.10]（路由：小时包导入 / 重复导入 / `/api/usage` / `/api/stats` 小时桶与 peak 字段 / 后导日包不夺权 / 只导日包才按日），[24.6] 断言 v1 → v2。详见测试输出。

## 1.15.0

**功能：官方导出粒度从「逐小时」变为「按日」+ 新增 zip 包 ⇒ 把「导入官方 CSV 对账」重做为「导入官方数据同步」，官方数据从旁证升级为权威口径；并新增历史基准补正。**

### 背景
- 官方导出已不再提供逐小时 `cost-*.csv`，改为**按日** `cost`/`amount` 两表，且以 `usage_data_<起>_<止>.zip` 打包下发。旧「三方按整点对齐」的口径失去数据基础。
- 重装 Hana 后本机账本从零开始，侧栏「API 请求次数 / Tokens」是历史累计，需要一条**用户可填**的补正通道。

### 新增
- **`lib/official-sync.js`**（新模块，纯函数，仅依赖 `node:zlib`）：zip 中央目录读取 + 解压、CSV 解析（BOM/CRLF/引号/缺列/未知 type）、**北京日聚合**、覆盖窗口计算（`coveredUntil = min(导入时刻, 末日结束)`）、金额整数微元累加、`cost` 表权威金额 vs `amount` 表回推金额（`costSource: 'cost'|'derived'`）。
- **官方日账本为权威口径**：官方覆盖的每一天，请求数 / Tokens / 消费额直接采用官方值；本机账本落在覆盖窗口内的条目被剔除（不重复计数），窗口外仍走本机估算。
- **配置项 `usageBaselineRequests` / `usageBaselineTokens`**（integer，默认 0）：补重装/换机前的历史累计；只在「全部」区间计入，不污染区间口径。
- **侧栏「今日消费额」**：官方同步覆盖到当日时优先用官方金额，未覆盖回退余额差口径。
- 前端支持 `.zip`（读成 base64 → 后端 `node:zlib` 解压）与单个 `.csv`，上限 24MB。

### 变更 / 移除
- `POST/GET /api/reconcile` → **`POST/GET /api/sync`**；详情页「导入官方 CSV 对账」→「导入官方 CSV 同步」；面板改为官方日×型号表 + 覆盖时刻 + 剔除条数。
- 删除 `lib/reconcile.js` 与夹具 `tests/fixtures/cost-2026-09-27.csv`；CSS `.reconcile` → `.sync-panel`。
- 持久化键 `reconcileLast` → **`officialSync`**；只落聚合结果（区间/每日×型号/覆盖时刻/行数），原始 CSV/zip 不落盘。
- 同步成功后失效 `usageCountCache` 与 `statsCacheMap`，侧栏与详情页立即重取。

### 安全
- 聚合结果不含 `user_id` / `api_key` / `api_key_name`；文件名 `sk-` 脱敏；出网域名与 methods 未变（仍只有 `api.deepseek.com`、`api-docs.deepseek.com`）。

### 自检
- 重写第 [24] 节为「官方同步」（包解析 / 北京日聚合 / 侧栏与详情合并 / 安全 / 持久化，含手写 zip 的 stored+deflate 端到端解压）；同步改 `[2]`、`[26.4]` 与今日消费额断言。**679 → 700 项，全绿。**
- 真数据回归：线路上传的 `usage_data_2026-08-30_2026-09-28.zip`（7 天 / 60 行）走 `POST /api/sync` 耗时 14ms，cost=145.3286463、requests=6734、tokens=1831678555，与直接解析逐位一致。

### 副作用修复
- `range=all` 的日桶原先按 **UTC 日界**取整（`Math.floor(minAt/DAY)*DAY`），而前端 `labelOf()` 按**展示时区**格式化标签 ⇒ 日桶标签与桶内数据错开 8 小时，官方日值也会错位一格。现改为 `dayStartOf(minAt)`（与 7d/30d/本月一致），并新增断言把官方日值锤到「标签为同一天」的桶上。

### 补充修复（同日、重载前发现）
- **小时档在官方覆盖区间里柱状图整片空白**：官方只给按日汇总，而 `today` / `yesterday` / `custom(≤ 2 天)` 会落在小时档，官方日值放不进小时桶 ⇒ 有坐标轴、无柱。现规则：**窗口与官方覆盖日相交时粒度提到「按天」**（这几个区间最多从 ≤48 桶降到 ≤2 桶），官方日值直接成为柱子，柱合计 = 总量。未被官方覆盖的短窗口仍按小时（不误伤）。
- **「高峰时段 ¥0（占 0%）」误导**：该数字只能由本机的小时级记录推出，官方日汇总拆不出高峰。现回传 `totals.localCount` / `totals.localSkipped`，当区间全为官方数据时副标题改为「高峰金额：官方按日汇总，不可分」；部分为本机时补「仅本机记录」。
- `/api/stats` 的 `official` 摘要**按窗口过滤**：窗口内没有官方日时整个回 `null`（否则页脚会误报「官方数据已介入」）；另加 `importDays`（导入总天数）与窗口内 `days`。
- 自检 700 → **704 项**，全绿；真 zip 回归：`today` → 1 根柱 ¥24.0541 / 941 请求，`yesterday` → ¥43.385 / 1921，`custom 09-27~09-28` → 2 根柱 ¥67.4391（=43.385+24.0541）。

## 1.14.50

**热修：1.14.49 的发布包结构被压平，包装不上。**

### 事故
- `deepseek-balance-1.14.49.zip`（22 条目）**全部在根级**（`balance.js`、`widget.js`、`balance-samples.js` …），**没有任何目录层级** ⇒ 宿主找不到 `routes/` + `lib/`，**包不可安装**。
- 对照实测（用本仓库自带的中央目录读取器逐条读出）：
  - `1.14.48`（旧脚本，装机可用）：21 条目，顶层为 `lib\`、`routes\`、`scripts\`、`tests\`、`tools\` + 根级文件；
  - `1.14.49`（事故包）：22 条目，顶层**全是根级文件**，`routes/` 与 `lib/` 条目数为 0。

### 根因
- 1.14.49 为做「排除临时/备份文件」把 `Compress-Archive` 的参数从 `-Path "<插件根>\*"`（传**目录/通配**）改成了**显式深层文件清单**（`routes/balance.js`、`lib/pricing.js` …）。而 `Compress-Archive` 对**单个嵌套文件路径**会把条目**平铺**到归档根（只有传目录才保留树）⇒ 目录层级全部丢失。**这是 1.14.49 引入的回归。**
- 附带发现：`Compress-Archive` 写出的条目名用**反斜杠**（`routes\balance.js`）；这是它的历史行为，1.14.35…1.14.48 的可用包都是这种形态（宿主接受），故本次**不改变**该形态，但校验器把 `\` 与 `/` 一律视为分隔符。

### 修法（三平台同一套流程）
1. **暂存目录**：`collectPkgFiles()` 收集（排除项已在此时解决）→ 复制进临时暂存目录，**保留相对路径**；
2. **以暂存目录为 cwd 压缩其顶层条目**：Windows `Compress-Archive -Path <顶层条目>`（传目录才保留树）；macOS/Linux `zip -r -q`（同 cwd），无 `zip` 回退 `python3 -m zipfile`（相对文件清单），两者皆无则明确报错；
3. **结构校验**：打包后读回 zip 中央目录，要求同时存在 `manifest.json` + `routes/*` + `lib/*`，且顶层不得有平铺 `*.js`；**不满足则删掉 zip 并报错**（宁可失败，不交装不了的包）。
- 校验器本身不依赖 `unzip`/`python3`（纯 Node 解析中央目录）；打包临时目录用完即删。

### 自检
- 新增第 [35] 节（5 项，含**真跑打包**的行为级断言：合成树 → 打包 → 读回断言 `routes/a.js` + `lib/b.js` + `manifest.json` 在、排除项不在、无平铺）。**674 → 679 项，全绿。**
- 另以真实产物回归验证：校验器对 `1.14.48`（可用）判 `ok:true`、对 `1.14.49`（事故包）判 `ok:false`。

## 1.14.49

**跨平台补齐 + 可分享打包（作者要上传 GitHub 分享，本机为 Linux）。**

插件**本体**平台无关（`routes/` + `lib/` + `tools/` + `manifest.json` 无盘符、无 shell 调用、无 `process.platform`，文件名全小写）⇒ 运行时 Windows/macOS/Linux 通用；挡路的只有两处开发侧资产。

### 1 `scripts/release.mjs` 跨平台打包
- 打包清单由 node 递归收集（**跨平台共用的唯一事实源**：Windows 与 POSIX 用同一份规则）。
- **平台 → 命令对照表**：

| 平台 | 命令 | 说明 |
|---|---|---|
| Windows (`win32`) | `powershell -NoProfile -Command "Set-Location <插件根>; Compress-Archive -Path <清单> -DestinationPath <zip> -Force"` | 保持 Compress-Archive；传**显式文件清单**（非 `root\*`）⇒ 排除项不入包 |
| macOS/Linux | `zip -r -q <zip> <清单>`（`cwd=插件根`） | 优先；entries 干净（根目录直接是 `manifest.json`） |
| macOS/Linux（无 zip） | `python3 -m zipfile -c <zip> <清单>`（`cwd=插件根`） | 回退 |
| 两者皆无 | —— | **明确报错**并提示安装其一；清单为空同样抛错（拒空包） |

- 回退只在 `err.code === 'ENOENT'`（工具不存在）时发生；工具存在但执行失败**如实抛出**，不掩盖。
- 排除项：`_selfcheck-tmp.mjs`、`*.tmp`、`*.bak*`、`node_modules`、`.DS_Store`（`isPkgExcluded` 导出可单测）。
- 其余步骤（plugin-data 快照、自检、版本读取）保持 `node:os`/`node:path`/`process.execPath`，**未引入平台分支**。

### 2 README 跨平台化
- 自检 / 发布 / `verify-evamt.mjs` / 取证 / 回滚 / 宿主接口，**每处都给 PowerShell 与 bash 两份**；宿主二进制统一用 `$env:HANA` / `"$HANA"` 占位。
- 插件数据目录双形态：Windows `%USERPROFILE%\.hanako\plugin-data\deepseek-balance\`；macOS/Linux `~/.hanako/plugin-data/deepseek-balance/`。

### 3 分享用开篇
- README 在维护文档**之前**新增 `## 简介`：这是什么 / 主要能力 / 平台（单包通用）/ 安装 / 数据与隐私（全本机、不上传、apiKey 不进日志、脱敏）/ 工程指标（零依赖、自检 674 项）/ **截图占位**。

### 3.1 安装说明落地为事实（据 Hana 用户说明书）
- **拖入安装**：`deepseek-balance-<版本>.zip`（或源码文件夹）拖进 **设置 → 插件**；
- **权限**：本插件注册了路由 / 详情页 / 侧栏 Widget（清单 `trust: full-access`）⇒ 必须 **Full-access（全权）**；`Restricted` 安装会 loaded 但面板/路由不生效；
- **装后自检**：状态应为 **`loaded`**（设置 → 插件 可见），面板出现侧栏「可用余额」卡片与「用量详情」页；
- 删除此前的 **TODO / 对冲措辞**；数据目录补 `HANA_HOME` 可覆盖默认 `.hanako/`。

### 4 许可：MIT
- 新增 `LICENSE`：标准 MIT 正文（英文原文逐字，未改写/未缩短），年份 2026，版权人 **`JinXin`**（`Copyright (c) 2026 JinXin`，大小写照此）。
- README 开篇补 `License: MIT（见 LICENSE）`（不写人名）；维护须知标注**版权人已确认**；目录结构表补 `LICENSE` 行。
- 打包会自动包含该文件（排除清单不误伤，已断言）。

### 自检
- 新增第 [34] 节（20 项，含 `collectPkgFiles`/`isPkgExcluded` **行为级**单测、LICENSE 内容/入包断言、开篇安装事实断言）。**654 → 674 项，全绿。**

## 1.14.48

**可用余额卡片：鼠标样式收窄到两个真控件。**

作者要求：卡片**只有**鼠标移入「去设置」文字和「去充值」按钮时才显示手掌。

### 改动
- `routes/widget.js` `.card.is-action` 去掉 `cursor: pointer`（这是整卡连子元素都变手掌的**根因**），改由 `#balanceCard { cursor: default }` 显式声明卡体光标 ⇒ 金额 / 标签 / 拆分行 / `?` / 提示文字一律 default。
  - `.is-action` 目前仅本卡使用；仍用 id 声明，避免将来被其它卡复用时误伤。
- `routes/widget.js` 新增 `#settingLink { cursor: pointer }`（原靠 `.alert-hint .link` 命中，现显式声明）；`.recharge-btn` 本就有 `cursor: pointer`，保留。
- **不改**：hover 底色、单击刷新 / 双击官方用量、键盘等价（Enter / Shift+Enter）、`?` 与拆分行提示。

### 光标来源清单（改后）
| 选择器 | 光标 | 说明 |
|---|---|---|
| `#balanceCard` | default | 卡体（含所有非控件子元素继承此值） |
| `.recharge-btn` | pointer | 去充值（真控件） |
| `#settingLink` / `.alert-hint .link` | pointer | 去设置（真控件） |
| `.info`（`?` 图标） | **help** | 有意保留：开提示的图标语义，非手掌 |
| `button, input, select, textarea`（共享层） | pointer | 真实表单控件 |
| `.refresh-btn` / `.text-btn` / `.menu-item` / `.pop-close` / `.modal-close` / `.modal-btn` | pointer | 均在卡外 |

### 自检
- 新增第 [33] 节（8 项）。**646 → 654 项，全绿。**

## 1.14.47

**清掉整体排查剩下的四条收尾项（注释 / 局部时区 / 桶粒度 / range 与 until 语义）。**

### 1 回退残留的注释矛盾
- `routes/widget.js` 通知区注释去掉与实现相悖的「参与文档流…零覆盖」半句，改为事实：绝对浮层（`top:38px` / `z-index:40` / 外层 `pointer-events:none`、子卡 `auto`），并写明**为什么仍保留 hover 抑制**（浮层显隐会改变光标下的元素：显＝盖住卡片、隐＝露出的卡片正好在鼠标下 → 幽灵 hover）。
- `renderTip` 方向注释：「浮层卡内默认朝上」改为「**已回退为朝下**（与 `'other'` 同义，`containerKind` 仅作容器分类保留）」。
- 全仓扫描：`widget.js` 内已无「零覆盖 / 参与文档流 / 默认朝上」；`lib/ui-shared.js:508` 的「十八批曾让…默认朝上」是**回退理由的历史叙述**（现在时态为「改回与 'other' 一致·朝下」），保留。

### 2 局部时区混用
- `routes/page.js` 型号变动时间戳（`priceChangeLine`）改用 `tzMinutes()`（展示时区，含 `-1` 跟随本机）+ `getUTC*`。
- `routes/widget.js` 预警静默键（`todayKey`）改用 `effectiveTz()` + `getUTC*`。
- 全仓扫描结果：**改 2 处 / 有意保留 5 处** —— `lib/diag-log.js` 本机时区（日志行带显式偏移，已注释）、`page.js` 的 `-new Date().getTimezoneOffset()` 回落哨兵 ×3、`page.js`「更新于」固定北京时间、`widget.js` `clockText` 固定北京时间。

### 3 桶粒度自动升档
- `routes/balance.js`：粒度在「全部」把窗口起点拉回最早记录**之后**才定；跨度超上限时自动升档（小时 → 天 → 周 → 月，月为统一 30 天近似）。桶数恒 ≤ 400，且每个桶的标签就是该桶起点（末桶标签与真实数据时间一致）。
- `routes/page.js`：X 轴标签与图表标题随之适配（周粒度 `M/D`、月粒度 `YYYY/M`；标题「按小时/按天/按周/按月」）。
- 小跨度逐项不变（30d = 30 天桶；2 天 custom = 48 小时桶）。

### 4 未知 range 与 `data.until` 语义
- 未知 `range` 不再静默回落 30d → `400 invalid_range`（响应回显 `range`）；`range` 缺席/空串仍默认 30d。
- `data.until` 改为**真实窗口末端**（yesterday = 今晨 00:00；lastMonth = 本月首日 00:00；custom = to 次日 00:00；滚动区间 = 现在）；「取数时刻」继续由 `fetchedAt` 表达。无前端消费点（已核）。

### 自检
- 新增第 [32] 节（18 项）。**628 → 646 项，全绿。**

## 1.14.46

**整体排查（两路）发现并修复的 11 条。**

### 1 入参「空值当 0」护栏
- 新增 `isStrictNumeric(v)`（只接受有限 number 或非空数字串；`null`/`''`/`[]`/`true` 一律非法）。`Number(null)===0`/`Number('')===0` 曾把空值静默当成 0：`POST /api/timezone {offsetMinutes:null}` → 写成 0（UTC）、`POST /api/config {alertThreshold:null}` → 写成 0（关预警）。
- 覆盖 `POST /api/config.alertThreshold`、`POST /api/timezone.offsetMinutes`、`GET /api/stats?tz=`（空串/非数字 → 400 `invalid_timezone`；缺席才回落）。

### 2 `/api/stats` 缓存键
- 键补上 **`until`**：custom「同 from 不同 to」在 3s TTL 内曾互相污染。

### 3 custom 日期做日历校验
- `parseDay` 回读年月日：`2026-13-45`（原被归一化成 2027-02-13）等 → 400 `invalid_range`。

### 4 Tokens 口径统一
- `/api/usage` 改用共享 `entryTokens()`（与 `/api/stats` 一致；`totalTokens` 缺失时回退 hit+miss+out）。

### 5 详情页补「全部」入口
- 时间维度菜单与日历侧栏补 `data-range="all"`「全部」—— 归档能跨 5000，但此前没有入口。

### 6 归档写盘节流
- 首次播种必须写；发生「宿主滚出」立即写；仅新增条目时按 **30s** 窗口合并写一次；归档日志同样限流 30s。原子写保持。

### 7 state tmp 名唯一化
- 路由与工具的 tmp 名改带 `pid + 随机串`（固定 `.tmp` 名跨进程并发写会互相覆盖）；路由写后回读校验、失败重试一次。

### 8 `evAmt` 幂等
- 只在**入账成功**时附带 `evAmt`（`persistFailed` 重试时不再重复并入同一事件）；`recordBalanceSample` 的变更判定补比 `evAmt`（否则重试并入的 evAmt 不会落盘）。

### 9 `/api/config` 缺键默认
- 改用 `cfgNumberOr`：缺键回落到 manifest 默认（refresh **60** / tz **-1**），而不是 `num(undefined)=0`。

### 10 「红窗优先」要真成立
- `#notice`（定位元素）曾绘制在无定位的 `alertBox` 之上 ⇒ toast 压住红窗。给浮层卡显式层序：`#notice z-index:1`、`.pop-layer > .box z-index:2`。

### 11 工具 `readOnly` 声明
- `tools/balance-alert.js` 去掉 `sessionPermission.readOnly`（它确实写 state.json）；注释说明原因。

### 自检
- 新增第 [31] 节（24 项）。**604 → 628 项，全绿。**

## 1.14.45

**误诊回退 + 真因修复：提示与弹窗不在一个图层。**

### 背景（作者的澄清）
> 「现在的现象是删除标志的提示和图标所在的弹窗**不在一个图层上**，位于弹窗“**下方**”，**不是让你调定位位置，那是对的**。」
⇒ 作者说的“下方”是**图层**上的下方（提示被弹窗盖住），不是空间位置。十八批把它当成空间位置问题去改了方向判定 —— **那是误诊，位置本来就对**。

### 1 回退方向判定（第十八批的改动）
- `lib/ui-shared.js` `chooseTipAbove`：把 `'popup'` 分支改回与 `'other'` 一致（**默认朝下**），使 `.card` 之外的锚点回到十八批之前的位置行为；注释写明「十八批的 popup→above 是误诊，作者确认位置原本正确，故回退」。
- 纯函数结构与 `containerKind` **保留**（把隐式假设显式化）。
- 同步改写 [29] 那 7 条断言（断言名写明「已回退，勿再改回朝上」）。

### 2 真正的修复：层级
- `#tip` 原 `z-index: 20` < `.pop-layer` 的 `40` ⇒ 提示被浮层卡**盖住**。改为 **`z-index: 200`**（高于 `.menu` 30 / `.pop-layer` 40 / `modal` 90 / 居中提示 120）。
- **父链**：`#tip`(absolute, z:200) → `.widget`(position:relative, **z-index:auto ⇒ 非层叠上下文**，无 transform/opacity/filter) → `body`(根) → `html`。因 `.widget` 不构成层叠上下文，`#tip` 的 z-index 在**根层叠上下文**里比较，**无需移到根级**。
- 未引入新层叠副作用：modal 遮罩(90)、居中提示(120)、浮层内红窗优先（alertBox 排最前）**逐一保持**。

### 自检
- 新增第 [30] 节（4 项），改写 [29]（7 项）。**600 → 604 项，全绿**；[13] 提示框 13 条无回归。

## 1.14.44

**修「预警 × 的提示跑到弹窗下方」（第十八批）。**

### 根因（方向规则只认 `.card`）
`routes/widget.js` 的 `renderTip` 方向判定：`var card = anchor.closest(".card")`，只对 `.card` 内的锚点算方向；预警 × 在 `.box.alert-box`（**不是 `.card`**）⇒ `card === null` ⇒ `above` 保持默认 `false` ⇒ 提示被放到**锚点下方**。而预警卡 / 事件卡位于面板**最顶部**（`.pop-layer` `top:38px`）⇒ “下方”落到弹窗下沿之外。事件卡的 × 同理。

### 修法
- 抽出**纯函数** `HPU.chooseTipAbove({anchorMid, containerMid, containerKind, anchorTop, anchorBottom, tipHeight, panelHeight})`：
  - `containerKind === 'popup'`（浮层卡 `.box`，含预警卡 / 事件卡）⇒ **默认朝上**（浮层卡都在面板顶部，“朝上”才是它自己那一侧；浮层内也没有“卡片内数字”要避让）；
  - `'card'` ⇒ 沿用旧规则（`anchorMid < containerMid`）；
  - `'other'` ⇒ 沿用旧默认（朝下）。
  - 含两条兜底：朝上但贴不到面板顶 ⇒ 翻回下方；朝下但超出面板底 ⇒ 翻回上方。末尾贴边 clamp 不变。
- `renderTip` 改用该函数；`.card` 那套行为一字未改。
- `#notice`（toast）仍在 `.pop-layer` 内但非 `.box`，不涉及。

### 自检
- 新增第 [29] 节（7 项：纯函数 5 条 + 接线 2 条）。**593 → 600 项，全绿**；[13] 提示框 13 条 / Escape 边界 / 自绘 `.tip` 无回归。

## 1.14.43

**按作者偏好回退：提示区整体回到浮层（overlay）。**

### 背景（作者的取舍）
「跌破预警红框和已自我修正的提示，还是做回之前的弹窗样式吧，挡金额没关系，主要是现在会占位，把独立卡片往下挤压。」

### 改动
- `.pop-layer` 回到**绝对浮层**：`position:absolute; left:0; right:0; top:38px; z-index:40`（居中、层上 `pointer-events:none`、子卡 `auto`）。四类提示（预警红窗 / 事件卡 / 错误框 / 瞬时 toast）**一律不参与文档流** ⇒ 显隐不改变 `#content` 位置、不推挤独立卡片。
- `#notice`（toast）保持 `absolute`（与整层口径一致）。
- **抑制函数一律保留**（尤其隐藏侧），理由写进注释：浮层化后「内容位移」这个成因消失了，但另一种仍在 —— **浮层收起那一刻，原本被它遮住的卡片正好露在鼠标下**，于是收到 `mouseenter`（幽灵 hover）。这正是当初加 `muteHoverUntilMove()` 的原因，不撤。

### 被放弃的目标 / 保留的抑制
- **放弃**：审计提的「零覆盖」（常驻提示不遮余额卡）—— 作者明确以「遮金额」换「不推挤」。
- **保留**：显隐两侧的 `muteHoverUntilMove()` 抑制（`checkAlert`/`hideAlert`、`renderEvent`/`hideEvent`、`showError`/`clearError`、菜单开/关、设置弹窗 onClose、卡片高度变化、toast 显/隐）。

### 自检
- 把「pop-layer 参与文档流 / 零覆盖」的断言改写为**新不变量**（绝对浮层 + 显隐不改 #content 位置 + 抑制仍在），不留悬空项。**593 项，全绿**；[13] 提示框 13 条 / Escape 边界无回归。

## 1.14.42

**紧急修回归（我上批改动引起）：切到 UTC 后 toast 消失触发余额卡幽灵 hover。**

### 根因（我引起，不是旧账）
第七批为「常驻提示不遮余额卡」把 `.pop-layer` 整体改成**参与文档流**，这条**无差别套到了「4 秒就消失的时区 toast」**上：toast 消失时内容回弹 ⇒ 鼠标被动落到余额卡 ⇒ 卡片 `mouseenter`（弹提示/hover 底色）。这正是当初 `muteHoverUntilMove()`（收起时对 `#content` 临时 `pointer-events:none`）修过的「幽灵 hover」，被这次改动带回来了。

### 修法：按时效分流
- **瞬时 toast（`#notice`）→ 回到浮层定位**（`position:absolute; left:0; right:0; top:0; margin:0 auto`）：不参与文档流 ⇒ 出现/消失**不推内容** ⇒ 不产生幽灵 hover。
- **常驻提示（预警红窗 / 事件卡 / 错误框）→ 保持参与文档流**（`.pop-layer` 仍 `display:flex` 流式），继续靠 `muteHoverUntilMove()` 兜住位移、保持「零覆盖」。
- **抑制补全审计**（显或隐会改 `#content` 位置的路径，两侧都抑制）：`checkAlert`/`hideAlert`、`renderEvent`/`hideEvent`、`showError`/`clearError`、`openMenu`/`closeMenu`、设置弹窗 `onClose`、卡片高度变化（`updateCards`）、toast 显隐（现为浮层定位，抑制为冗余保险）—— 全部覆盖。

### 自检
- 新增第 [28] 节（6 项）。**587 → 593 项，全绿**；[13] 提示框 13 条 / [25] 零覆盖 / Escape 边界全绿无回归。

## 1.14.41

**时区菜单与提示微调（第十五批）。**

### 1 删掉显式的 GMT+8 菜单项
- 菜单由三项（跟随本机 / GMT+8 / UTC+0）改为**两项**：「跟随本机（本机偏移）」与「UTC+0」—— 显式 GMT+8 与「跟随本机」在本机为 GMT+8 时重复。
- 选中判定 `HPU.tzItemOn(dataTz, tzMin, local)`：`-1` 或**存储偏移 == 本机偏移** → 高亮「跟随本机」（选择它写回 `-1`）；其余非本机情形（含 `0` 与遗留的具体偏移）归「UTC+0」，保证**恰有一项高亮**。本机偏移为 0 时，`0` 视为本机 → 高亮「跟随本机」。
- 普通时区行照实显示真实偏移。

### 2 删掉「展示时区 ≠ 本机」的红字警示
- 移除 `#tzWarn` / `.tz-warn` 及显示分支（上一批刚加）；**保留**原有那条普通时区显示行（正常字色、显示当前偏移）。切换逻辑本身不变。
- 同步更新 [26] 的相关断言（不留悬空项）。

### 自检
- 更新第 [26] 节（6 项：菜单恰两项 / 选中判定 / pickTzMinutes / 今日窗口 / 警示已移除）。**587 项，全绿。**

## 1.14.40

**× 提示统一：原生 title → 自绘 .tip（第十四批）。**

### 背景（作者的现场描述）
「跌破预警红窗的删除标志，移入时有『今日不再提醒』的提示，但响应的很慢，会有一段时间的空白显示后才出现字体，而且提示框样式要和其他提示统一，比如自有资金。」

### 真因（已确认）
预警 × 用的是**原生 `title`**（`close.title = "今天不再提示"`）。原生 tooltip 的两个固有毛病正对作者的描述：**出现慢（约 1 秒）**、**先出空框再补字**；且与插件自绘的 `.tip` 完全不是一套。⇒ **不是浮层缺内容**，上一批的「空内容防御」不是这条的真因（防御保留无害，但不能当成已修）。

### 改动
- 预警 ×：删掉原生 `title`，改挂 `data-tip="今天不再提示"`（`aria-label` 保留给读屏）。
- 事件 ×（`#eventClose`）：加 `data-tip="关闭"`（此前无 title），同样走自绘 `.tip`。
- 抽出 `bindTipNode(node)`（鼠标 mouseenter/mouseleave + 键盘 focus/blur 都挂），`bindTips()` 改用它批量绑静态节点；**动态创建的 × 在创建后立即 `bindTipNode(node)`**。
- 二者共用同一个 `.tip` 单例：同 `TIP_SHOW_DELAY=120ms`、同淡入、同样式与箭头（`--arrow-x`）、同移出行为 —— 与「自有资金」完全一致。
- **全仓原生 title 审计**：唯一原生 HTML tooltip 就是预警 ×（已改）；事件 × 原无 title（已加 data-tip）；其余 `title` 均为 CSS 类名 / 局部变量 / 文档 `<title>` / **SVG `<rect><title>`（读屏语义）**，予以保留。

### 自检
- 新增第 [27] 节（7 项）。**580 → 587 项，全绿**；[13] 既有 13 条提示行为断言（箭头不翻面/移出不飘/淡出不被重定位/掠过不弹…）全绿无回归。

## 1.14.39

**时区切换加固（追加；作者刚撞上的「今日 = 昨天」）。**

### 背景（现场事实）
展示时区被切成 `timezoneOffsetMinutes = 0`（UTC）⇒ 侧栏「今日」= **UTC 的今天** = 北京 09-27 ⇒ 卡片显示的是昨天那批数。同一时刻：`tz=0` 窗口（北京）09-27 08:00 ~ 09-28 07:52、token 估算 46.2467 / 余额差 37.52（作者看到的）；`tz=480` 窗口（北京）09-28 00:00 ~ 07:52、5.0533 / 2.96（正确）。

### 改动
- **菜单补回「跟随本机」**：新增 `data-tz="-1"` 项，标签显示本机偏移（如「跟随本机（GMT+8）」）；`-1` 哨兵解析仍走「跟随本机」（`effectiveTz()`）。
- **选中判定单源** `HPU.tzItemOn(dataTz, tzMin)`：`-1` 只在 `tzMin === -1` 时选中；其它项按精确值，且哨兵态不选中任何具体项（避免与本机偏移相同的具体项同时高亮）。
- **偏移 ≠ 本机时醒目提示**：`updateTzNote` 在 `effective !== local` 时显示「当前按 GMT+0 统计（与本机 GMT+8 不同）」（`.tz-warn`，11px、`--danger-text`）；等于本机时隐藏。
- `chooseTz(-1)` 的 toast 文案改为「跟随本机（GMT+X）」。
- 服务端 `resolveTzMinutes` 抽出**纯核心** `pickTzMinutes(rawTz, configTz, localMinutes)`（查询 > 配置 > 本机；`-1` 不当有效偏移），便于单测。

### 自检
- 新增第 [26] 节（6 项）并更新 [11] 一处 toast 断言。**574 → 580 项，全绿。**

## 1.14.38

**四项修复：充值反推 ceil / 标志统一 / 浮层空内容防御 / 用量归档突破宿主 5000。**

### 1 充值反推改「向上取整」（现场真故障：充 5 只入账 4）
- 盘上证据 `dTop 4.07 → booked 4`。根因：`snapRechargeYuan` 用 `Math.round`，4.07 距 4 更近 ⇒ 记 4（少 1）。
- 原理：余额上调只可能来自充值，**消费只会让观测量变小** ⇒ 观测跳变 ≤ 真实充值额 ⇒ 取 **ceil**。
- `snapRechargeYuan(delta) = Math.ceil(delta − 1e-9)`（`1e-9` 防浮点噪声；**不再先 round2**，否则 5.001 会被截成 5.00）。
- 残差语义改为**窗口内消费推测值** = `booked − delta`（≥0）；> 0.2 时 `log('warn', 'recharge window-consumption large …')`，事件提示标注「金额按整元吸附，窗口内消费约 ¥X」。
- 物理边界（不夸大）：真充 6、窗口消费 1.02（观测 4.98）仍会低入 1 元 —— 反推口径无法消除。

### 2 标志（×）统一配色
- `.pop-close` 由 `color: inherit` 改为显式中性色 `var(--text-secondary)` ⇒ 红窗 × 与事件卡 × **完全同色**，与其它说明提示风格统一；尺寸/圆环/hover/focus 共用一套。
- 测试用 color-mix 线性混合计算两处背景下对比度：明 红卡底 5.45:1 / 事件卡底 5.76:1；暗 5.13:1 / 5.08:1，均 ≥4.5。
- 若作者本意是让事件 × 用红窗那支红，改 `.pop-close { color }` 一行即可。

### 3 浮层「只有框、没有内容」的结构性防御
- `guardPopup(el, which, fallback)`：显示前校验 `textContent` 非空，为空则填兜底文案并经 `/api/client-error` 留痕（`popup shown with empty content: <which>` → 落 diagnostics.log）；覆盖 `alertBox`/`eventBox`/`errBox` 三处；有内容时原样不动。
- ⚠ 作者未描述细节、也无真机画面：这是**防御**，不是已确认根因。

### 4 用量归档突破宿主 5000
- 现场：宿主 `usage-ledger.json` 正好 5000 条、最早 `2026-09-24T05:16Z` ⇒ 硬上限 5000，更早被滚出 ⇒ 侧栏「全部」卡在 5000。
- 新增 `plugin-data/<id>/usage-archive.json`（**原子写** tmp+rename）：每次读到宿主账本后按 `requestId` 去重并进归档（首次以当前账本为种子）；只存聚合所需字段，**丢弃** attribution/metadata/sessionPath；上限 **20000**，到顶丢最旧。
- `/api/usage`、`/api/stats`、对账改读「宿主账本 ∪ 归档」⇒ 区间跨过 5000。接口回报 `archive{count,cap,full,oldestAt}`，详情页页脚与「账本容量」并列展示。
- 接不住的：宿主**漏记**的调用本地从无记录 —— 这正是 CSV 对账要显性化的缺口。

### 自检
- 新增第 [25] 节；同步更新 [9.3]/[19.5]/[7] 相关断言。**553 → 574 项，全绿。**

## 1.14.37

**导入官方 CSV 对账（作者点名）：把手工对账变成一条命令。**

### 功能
- 详情页新增「导入官方 CSV 对账」按钮 → 本机 `<input type=file>`（**iframe 内读取、不上传**，限 2MB）→ `POST /api/reconcile` → 就地渲染对账面板。
- 三方按**北京时间整点**对齐：**官方**（CSV）/ **token 估算**（与 `/api/stats` 同一套口径）/ **余额差**（面板采样）。
- 面板：头部（类型/区间/行数）→ 合计三行（官方/估算/余额差 + 差值）→ 逐小时表（默认只列差异 > ¥0.01，其余折叠；CSV 未覆盖标「官方缺」）→ 数据驱动结论。
- 差额显性化：「本机账本少于官方」直指**宿主漏记**（插件不可修，仅告示）；余额差与官方 |差| < ¥0.05 报「一致（两位小数噪声内）」。

### 实现
- 新增 `lib/reconcile.js`（纯函数）：`parseOfficialCsv`（BOM/CRLF/引号/空行/多余列；缺列→bad_csv；只取 CNY 并计数）+ `reconcileRows`（三方对齐、差异阈值、结论）。
- 官方金额按**整数微元**累加，合计与官方**逐位一致**。
- 抽出 `computeEntryCost`（token 估算**唯一口径**），`/api/stats` 与 `/api/reconcile` 共用。
- 路由：`POST /api/reconcile`（限长/校验/错误码 400）、`GET /api/reconcile`（读回摘要）。

### 安全
- CSV 是不可信输入：限长 2MB、字段校验、渲染一律 `esc`/`textContent`；**不显示/不记录 `user_id`**（解析结果不含任何原始标识）；`fileName` 与日志走 `scrub`（`sk-***`）；日志只记行数/区间/摘要；**原始 CSV 不落盘**，`state.reconcileLast` 只存摘要。

### 黄金夹具
- `tests/fixtures/cost-2026-09-27.csv`（源：`usage_analysis/usage-0927/cost-2026-09-27_2026-09-27.csv`，**`user_id` 已掩码**，合计不变）：22 行、合计 **31.97676568** 逐位一致。

### 自检
- 新增第 [24] 节（22 项）；更新 [9.3] 一处（高峰判定移入 computeEntryCost）。**531 → 553 项，全绿。**

## 1.14.36

**清尾（4 条遗留 P2）。**

### 1 详情页极长数值：折行 → 省略号
- `.card .v` 由 `word-break: break-all`（会把数字折断换行）改为 `min-width:0 + white-space:nowrap + overflow:hidden + text-overflow:ellipsis`；`.fstats b`（15px）补同款溢出守卫。字号未变（26px/15px），标签（`.card .k` / `.fstats em`）不加截断。

### 2 侧栏统计失败可见
- `fetchStats` 失败不再静默：`state.statsFailCount` 连续失败达 **3** 次 → 迷你图位置显示「统计暂不可用」（复用既有 `.chart-empty`：11px、填满固定高度，不新增字号/不改高度）；成功一次即清零。

### 3 external.open 缺失时降级
- `HPU.externalOpen(url, onFail)`：宿主缺 `external.open` 能力 / 被拒 / 超时时调用 `onFail(url)`；侧栏 `openExternal()` 用它把「无法自动打开链接，请手动复制：<完整 URL>」显示在既有 notice 上（15s），notice 文本 `user-select:text` 可选中复制。去充值 / 双击余额卡 / Shift+Enter 全部走该降级路径。

### 4 round2/round4 浮点边界
- `lib/pricing.js` 的 `round2/round4` 加「与符号同向的极小量」修正：`2.675→2.68`、`1.005→1.01`、`20.35→20.35`；负数半离零（`-1.005→-1.01`）。限制（与边界相差 <1e-9 仍可能翻向）写进注释。

### 自检
- 新增第 [23] 节（13 项）并更新 [19.6] 一处（externalOpen → openExternal）。**518 → 531 项，全绿。**

## 1.14.35

**紧急热修（线上巡检发现）：路由落盘覆盖工具写的 alertState，导致余额预警每 10 分钟重复推送。**

### 现象（真机 diagnostics.log）
```
06:30:04 [tool] alert entered: pushed once; lastAlertPushAt=… total=8.33
06:40:04 … 07:20:04   ← 每 10 分钟一次，reason 始终 entered_alert
```
而同一时刻 `state.json` 的 `alertState=0`、`lastAlertPushAt=0`。

### 根因
`routes/balance.js` 的 `saveState()` 用 `Object.assign({}, disk, 内存副本)` **整对象合并，方向是内存赢**。路由把启动时读到、并**从不更新**的 `alertState=0/lastAlertPushAt=0` 留在内存里，于是**每次轮询落盘都把工具刚写下的 `alertState=1/lastAlertPushAt` 覆盖回 0** ⇒ 工具下一轮又看到 0 ⇒ 再推。（这是 1.12 批「写前读盘合并」的**不完整修复**：只保护了内存里没有的键。）工具侧（批一 P1-03）本身正确。

### 修法：只写脏键
- 维护 `dirtyKeys`：`stateSet(k, v)` 记录 k 为脏。
- `saveState()` 先读盘 → **只把 dirtyKeys 覆盖到磁盘副本上** → 原子写（tmp+rename）→ 用合并结果刷新内存 → 清空脏集合。
- 目标：**任何键只要不是本进程这次改的，就原样保留磁盘值**（对工具、对其它写者一律成立，不再依赖「谁拥有哪个键」）。工具侧读-合并-写保持不变。

### 证据
- **行为**：工具先写 `alertState=1/lastAlertPushAt=999` → 路由随后落盘一次 → 两键**仍为 1/999**，同时路由自己的 `lastToppedUpBalance` 正常落盘。
- **回归守卫**：断言不再存在内存赢的整对象合并，改为脏键覆盖。
- **语义**：`alertState=1` 在盘上 + 余额仍低 ⇒ 工具 `due=false`、`reason=still_low`；余额恢复 ⇒ 复位 0。

### 自检
- 更新 [7] 一处旧断言（原断言了有缺陷的合并模式），新增第 [22] 节（5 项）。**513 → 518 项，全绿。**

## 1.14.34

**代码卫生 + 文档（收尾）。**

### 1 游离闭合标签
- `routes/widget.js` / `routes/page.js` 各多一个 `</script>`（开 2 闭 3），删除；新增标签配平断言（`<script` 与 `</script>` 数量相等）。

### 2 死代码
- 删 `MAX_AMOUNT`（服务端已有 `MAX_BALANCE_VALUE` 护栏；前端 clamp 只会掩盖真实值）；删死字段 `state.alertTimer`（只被 clearTimeout）/`state.dataTz`/`state.configAt`（写而不读）及其引用；更新 `hideAlert`/`checkAlert` 附近注释：提示区**参与文档流下推**（不再是「绝对定位浮层」）。

### 3 无校验入口
- `POST /api/event/resolve` 明确声明为**无参接口**（显式忽略请求体；注释与 README 写清「只清事件、不改累计值」）。
- `GET /api/stats` 的 `custom` 日期非法时由「静默回落 30d」改为返回 **400 `invalid_range`**（前端本就会传合法日期）。

### 4 导出错误语义统一
- `POST /api/export` 入参类错误 → **400**（`invalid_dir`/`empty_csv`/`too_large`/`invalid_range`），写失败 → **500**（`write_failed`，带 message）。
- 前端改用 `apiPostRaw`（同时拿 HTTP 状态与 body）；非 2xx 也读 body 的 `error`/`message` 显示同样弹窗，body 缺失也按失败处理 ⇒ 不会因状态码变化而静默失败。

### 5 删除装饰性控件
- 详情页移除「API Key」筛选（`#keyPill`/`#keyDrop`/`state.key` 分支）——本机账本不记 Key，两个选项行为完全相同，属误导性控件；页脚那句「本机账本不记录每次请求使用的 Key」保留。

### 6 文档补齐
- README 新增「刷新与缓存时序」（余额/账本/stats 3s、usage 20s、价格成功 12h/失败 10min、样本 30 天/800 条、`usage:list` 8s、心跳 12s、看门狗 2min、隐藏 5min、`diagnostics.log` 512KB 轮转）与「预警投递链」（含「失败必须回报、不许静默」与「如何确认链活着」）；配置表补 `alertNotify`/`eventPromptEnabled`。

### 自检
- 新增第 [21] 节（19 项）。**494 → 513 项，全绿。**

## 1.14.33

**体验打磨（八条 P2）。**

### 1 reduced-motion 覆盖补齐
- 共享层补一条 `@media (prefers-reduced-motion: reduce)`，**逐类收敛**（不用 `*` 通配）：`.modal-card`/`.modal-close`/`.dot`/`.refresh-btn`（含 `.spinning svg`）/`.menu-item`/`.fpill`/`.pop-card`/`.tip.on`；删除两处面板内重复块（单一源）。

### 2 弹窗焦点陷阱
- `openModal` 打开时聚焦首个可聚焦控件（无则聚焦卡片自身）；`bindModal` 加 Tab 环绕（按弹窗内可聚焦元素首尾循环，焦点跑到弹窗外时拉回）；`closeModal` 关闭时把焦点还给触发元素。

### 3 Escape 关闭浮层（有边界）
- 侧栏 Escape 现在同时关闭：提示框 / 时区菜单 / 模态弹窗 / **事件弹窗 / 错误框**。
- **预警红窗不绑 Escape**（它带「今天不再提示」显式语义，Escape 有歧义）；红窗已有可聚焦 × 按钮，键盘可达性不受影响。理由写进代码注释。

### 4 提示区不再遮挡首卡
- `.pop-layer` 由 `position: absolute; top: 38px` 改为**参与文档流**（有卡片时把 `#content` 下推）；模态与 `.tip` 仍走绝对/固定定位。改前事件卡压住首卡标签行约 26px，改后**零覆盖**。

### 5 型号变动不再 8 秒即失
- 保留 8s toast；详情页新增**常驻可复查行**（挨着「价格同步」）显示最近一次变动方向与时间戳，由 `/api/stats` 新增下发的 `priceChange` 驱动；「已阅」ACK 仍只压 toast，不影响该行可复查。

### 6 侧栏迷你图空态
- 无数据时不再留 108px 空白，显示「今日暂无记录」（沿用既有 11px 小字与 tertiary 色，不新造字号）。

### 7 错误文案补「下一步」
- `invalid_key`/`insufficient_balance`/`rate_limited`/`upstream_error`/`fetch_error`/`bad_response` 各自追加动作（核对 Key / 充值 / 稍后重试 / 检查网络 / 到官方状态页确认 / 保留诊断日志），主体措辞不变。

### 8 赠金提示补口径
- 赠金到账提示改为「仅记录本次到账（插件不追踪赠金累计）…」，**不伪造累计**。

### 自检
- 新增第 [20] 节（13 项）并更新两处旧断言（浮层 → 文档流、Escape 集会）。**481 → 494 项，全绿。**

## 1.14.32

**健壮性：上游数值护栏 / 单调时钟 / 价格失败短 TTL / 超时与释放 / 整元吸附。**

### P2-1 上游数值护栏
- `pickBalanceInfo` 的 `readable` 改为只做「字段存在」的形状判断；数值合法性交给新护栏 `isBalanceAmount(v)`（有限、非负、≤ `MAX_BALANCE_VALUE = 1e9`）。越界（负值/NaN/Infinity/1e12）**不进事件判定、不推进基线**，按 `bad_response` 返回并 `log('warn', 'upstream balance out of range ...')`（走 diagnostics）。

### P2-2 单调时钟
- 新增 `lib/mono-clock.js`：`monoNow()`（performance.now → hrtime → Date.now 降级）与 `isFresh(start, ttl, now)`（差值缺/负一律判为不新鲜）。
- 后端余额 3s / 账本 3s / stats 3s / usage 20s / 价格同步 12h 全部改用 `MONO.isFresh`；前端看门狗与 `lastSuccessAt` 改用 `HPU.monoNow()`。⇒ 系统对时/回拨不再让缓存永久不生效或看门狗失灵。

### P2-3 价格同步失败短 TTL
- `lib/price-sync.js` 新增 `PRICE_SYNC_FAIL_TTL_MS = 10min` 与 `priceSyncDue(ok, startMono, nowMono, force)`：失败 10 分钟后可重试，成功才 12h。定时器从 `syncPrices(true)` 改为 `syncPrices(false)`（尊重内部 TTL），stats 补刷也走 `priceSyncDue`。

### P2-4 取数超时与释放
- `fetchBalanceOnce`：对余额取数**显式超时**（`withTimeout` + 向宿主传 `timeoutMs`），瞬时失败（无响应的超时/网络异常）**退避重试一次**（拿到 4xx/5xx 不重试）。
- single-flight 在 finally 释放（成功/异常/超时都释放，避免后续并发轮询挂在同一条已超时的链上）；`withTimeout` 移到模块作用域并导出。
- 导出落盘 `ctx.resources.write` 加 `withTimeout(..., EXPORT_WRITE_TIMEOUT_MS)`。

### P2-5 整元吸附改为「始终吸附 + 残差告警」
- `snapRechargeYuan` 从「残差 ≤ 0.2 才吸附」改为**一律 `Math.round`**（不再留下 2.5 这种不可能出现的充值额）；残差 > `RECHARGE_SNAP_EPS` 时 `log('warn', 'recharge snapped with large residual ...')`。新增 `rechargeResidual()`；事件新增 `snapResidual` 字段，侧栏标注「金额按整元吸附，残差 X 元」。

### 键盘等价动作（已拍板）
- 侧栏余额卡聚焦后：**Enter/Space = 刷新，Shift+Enter = 查看官方用量**（复用与 click/dblclick 完全相同的两个函数）；`aria-label` 补「回车刷新 / Shift+回车查看官方用量」。外观/鼠标路径/提示文本不变。

### 自检
- `tests/run-all.mjs` 新增第 [19] 节（护栏/单调/价格 TTL/超时重试/吸附/键盘共 25 项）。**455 → 481 项，全绿。**

## 1.14.31

**诊断日志落点纠偏：留痕落到插件自己可控、用户可读的地方。**

### 背景（实测结论）
- 宿主的 `ctx.log` 只会被并进**调用方 Agent 的会话记录**（`sessions\*.jsonl`）：把探针搜遍 `~\.hanako` 下近 40 分钟的非会话文件是**零命中**，`~\logs\*.log` 里也查不到 `deepseek-balance:alert`。⇒ P1-09/P1-10 的「可取证」目标没达成：用户故障时根本找不到插件日志。

### 改动
- 新增 `lib/diag-log.js`（路由 / 工具 / client-error 三处**共用**，不各写一份）：单行格式 `<ISO含本地偏移> <级别> [<来源>] <消息>`（来源 ∈ route|tool|client）；**512KB 轮转**为 `diagnostics.1.log`（只留上一份）；写/读**永不抛**；`sk-***` 脱敏 + 限长 2048。
- **双写**：`routes/balance.js` 的 `log()` 与 `tools/balance-alert.js` 的 `tlog()` 在保留 `ctx.log` 的同时写 `<dataDir>/diagnostics.log`；`POST /api/client-error` 以来源 `client` 落同一文件。
- 新增只读读回口 `GET /api/diagnostics?tail=N`（默认 200、上限 500），逐行再脱敏 + 限长，让「取证」变成一条命令。
- 文档纠偏：README 诊断入口 / 面板报错怎么取证 / TOP5 全部改指向 `diagnostics.log` 与 `GET /api/diagnostics`，并写明轮转文件名与位置；说明 `ctx.log` 会进调用方会话记录但**不是给用户看的**。

### 自检
- `tests/run-all.mjs` 新增第 [18] 节（格式化/脱敏/轮转/容错/读回口/E2E 共 17 项）。**438 → 455 项，全绿。**

## 1.14.30

**上线后兜底：预警链留痕 / 面板内异常留痕 / 回滚台账。**

### P1-09 预警链留痕（“断了没人知道”）
- `tools/balance-alert.js` 原来**零日志**（失败只体现为返回 JSON，被 isolated 定时任务的 Agent 消费 → 事后无痕）。新增 `tlog(ctx, level, msg)`，以下路径均入 `ctx.log`（与路由同渠道，前缀 `[deepseek-balance:alert]`）：入口（`alertNotify` 关 / 阈值缺）、上游失败、`not_configured` / `bad_response`、**持久化失败降级到整点桶**、推送状态迁移（`alertState` / `lastAlertPushAt` 写入）、最终 decision。
- `alertNotify=false` 不再无声：`/api/config` 新增返回 `alertNotify`；侧栏预警行显示「余额预警已开启（推送已关闭）」，设置弹窗也加一行说明。
- 工具返回的 `hint` 补写：若 `notify` 投递失败，请回报失败并改走桌面通知（**只改提示词，不改工具契约**）。

### P1-10 面板内异常留痕
- 新增 `POST /api/client-error`：把 `installErrorTraps` 抓到的 iframe 异常落进 `ctx.log('warn', ...)`，与路由同渠道。
- 安全：按**不可信输入**处理 —— 只接受字符串、限长 2048、剥离控制字符、`sk-***` 兜底脱敏、不回显；**绝不读取/记录 apiKey**。
- 错误框**可选中复制**（`.err-box { user-select: text }`）并附短错误码（`E` + base36），侧栏与详情页都接线。
- README 补「面板报错怎么取证」。

### P1-11 回滚台账
- README 补**回滚三步**与 **TOP5 排查手册**。
- `scripts/release.mjs` 在打包**之前**把 `plugin-data\<id>\{state.json,config.json}` 快照到 `backups\plugin-data-<id>-<版本>-<时间戳>\`（每版都有回滚前状态基线）。
- CHANGELOG 补 **1.14.1–1.14.26 区间**说明，并注明自 1.14.27 起每版独立成节。

### 自检
- `tests/run-all.mjs` 新增第 [17] 节（P1-09/10/11 的源码与行为守卫）。**418 → 438 项，全绿。**

## 1.14.29

**体验合规：键盘可达 / 解释不只存在于 hover / 对比度达 AA。**

### P1-06 键盘可达
- **详情页 pills**：`#timePill` / `#keyPill` 是 `div[role=button][tabindex=0]` 但只绑了 click。新增 `pillKeyToActivate`（入 `routes/page.js` 的 keydown 分支：Enter / Space / Spacebar，`preventDefault` 防滚动），内部调 `currentTarget.click()` **复用同一 click 分支**，保证开/关语义与鼠标完全一致。
- **焦点可见**：原焦点样式只覆盖 `button`/`input`，`.fpill` 是 div → Tab 到它无任何指示。新增 `.fpill:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }`（与既有 button 焦点环同风格）。
- **侧栏「去设置」**：由不可聚焦的 `span.link` 改为 `<button class="link" type="button">`（预警开启后它是唯一入口）。`.alert-hint .link` 补齐 `border/background/padding/margin` 归零与 `font: inherit`，**外观逐像素不变**；且它仍在 `[data-tip]` 卡片内，`bindTipExclusions` 的 `[data-tip] button` 选择器仍命中同一条排除 → **鼠标路径与改前一致**。落点：`routes/widget.js`。

### P1-07 关键解释不只存在于 hover
- 把 5 个承载解释的锚点补上 `tabindex="0"`（`#balanceCard` / `#costNote` / `#breakdownRow` / `#grantInfo` / `#peakInfo`）；`bindTips` 本就绑了 `focus`/`blur`（键盘可见），并新增 **Escape 关闭提示**（`hideTip()` 并入既有 Escape 处理）。未新增任何 `data-tip`、未改任何提示文本 → **鼠标路径逐条不变**。
- 三条关键锚点的**可访问名含要点本身**（不再只是“说明”）：`#breakdownRow`（余额构成：可用余额 = 充值 + 赠送）、`#grantInfo`（赠送有效期）、`#peakInfo`（今日消费额与高峰口径）；顺带 `#costNote`（充值 − 退款 − 当前充值余额）。

### P1-08 对比度达 AA（算出来，不靠人眼）
- 做法：**把 muted 灰阶整体提深**（`lib/ui-shared.js`），而非逐条改挂 `--text-secondary` —— 因为 `--text-secondary` 自身在面板底上只有 4.47:1，逐条改会漏且仍不达标；整体提深是单一源、不会漏规则。为保持 secondary>tertiary 的层级，明模式 secondary 一并微调（否则 tertiary 必须比 secondary 更深，层级反转）。
- 数值（WCAG 相对亮度，背景取最浅的 `--panel-bg`）：

| 变量 | 主题 | 改前 | 比值 | 改后 | 比值 |
|---|---|---|---|---|---|
| `--text-tertiary` | 明 | `#9ca3af` on `#f5f6f7` | **2.35:1** | `#666d7a` | **4.81:1** |
| `--text-secondary` | 明 | `#6b7280` on `#f5f6f7` | **4.47:1** | `#57606d` | **5.88:1** |
| `--text-tertiary` | 暗 | `#71767b` on `#26282c` | **3.22:1** | `#8b9198` | **4.64:1** |
| `--peak`（刻度） | 暗 | `#d4606a` on `#26282c` | **3.99:1** | `#dd6d77` | **4.59:1** |
| `--peak`（刻度） | 明 | `#b4232b` on `#f5f6f7` | 6.04:1（已达） | 未改 | 6.04:1 |

- 色相族未换、字号字重未动。新增**从 CSS 变量取值算 WCAG 的断言**（以后改色会自己报警）。

### P1-05 补：刻度着色**对齐计费**（去掉边界红刻度 12/18）
- 作者的决定：刻度着色不再用固定高峰整点表，改为与计费**同一个谓词** —— `buildPeakTickMask` 逐项取 `isPeakAt(整点, 节假日集合)`，与 `bucket.peak` 完全同源，**不再维护第二条平行窗口规则**。
- 红刻度集合由 {9,10,11,12,14,15,16,17,18}（9 个）变为 **{9,10,11,14,15,16,17}（8 个）**；边界整点 12 / 18 归非高峰，与官方「9:00-12:00、14:00-18:00」的右开区间语义一致。
- `PEAK_CLOCK_HOURS` 与 `isPeakTickHour` 已成死代码，**删除**（`lib/holidays.js`；`TICK_GRID_HOURS` 保留）。
- 断言：逐项证明 `mask[i] === isPeakAt(整点)`（GMT+8 与 UTC+0 各 24 项）；GMT+8 红集合 = {9,10,11,14,15,16,17}；UTC+0 红刻度的北京钟点集合与之一致；边界 12/18 归非高峰；非高峰日全天不红。上一批那条「与改前逐项一致」的断言已**更新为新集合**并注明原因（勿当回归修回去）。

### 自检
- `tests/run-all.mjs` 新增/更新第 [15.2] 与 [16] 节（P1-05 同源与集合 + 20 项体验合规）。**395 → 418 项，全绿。**

## 1.14.28

**口径与日历：节假日表跨年失配 / X 轴高峰刻度错位 / 页脚口径自相矛盾。**

### P1-04 节假日表跨年失配（deadline 2027-01-01）
- `lib/holidays.js`：新增 `COVERED_YEARS = [2026]`、`isYearCovered`、`beijingYear`、`holidayCoverage`（返回 `{ covered, year, coveredYears, message }`）。
- 未覆盖年份**不静默**：`/api/stats` 按北京日一次 `log('warn', …)`（`HOLIDAY_WARN_DAY_KEY` 去重），并把 `holidayCoverage` 下发；详情页新增 `#coverageNote` 可见告示，文案写清后果（「相关时段金额可能被高估约 2×」）。落点：`lib/holidays.js`、`routes/balance.js`（coverage 计算 + 下发）、`routes/page.js`（告示位 + 渲染）。
- **方向克制**：不把未覆盖年份改成「全高峰」或「全空闲」——两者都会引入新的系统性错误；保持现行星期规则，只如实告示。理由已写进 `lib/holidays.js` 注释。
- **整表扩展评估结论：不做自动外推**。国务院办公厅通常在上一年末才公布次年安排，属建库时不可知的权威数据；照搬往年/猜调休会制造新的系统性错误。用户可用 `holidayDates` 追加已公布日期（并集，不删除内置项）；正式支持新年份需随插件更新并入。

### P1-05 X 轴高峰刻度错位（切到非 GMT+8）
- 旧行为：刻度位置用**展示时区**算钟点，颜色却套固定 `PEAK_CLOCK_HOURS` → 切 UTC+0 后红刻度落在 UTC 9-18。
- 新行为（单一事实源）：`/api/stats` 在小时分桶时下发 `dayPeakMask`（当天 24 整点，按北京时间 + 节假日算，`lib/holidays.js` 的 `buildPeakTickMask` / `isPeakTickHour`）；侧栏迷你图**只用掩码上色**，不再复刻规则、也不需要节假日数据。刻度位置仍按展示时区，掩码按绝对时刻算 ⇒ 任意展示时区都被标红在北京 9-12 / 14-18。
- 刻度“是否画” = 基础网格（`TICK_GRID_HOURS`，每 3 小时）或 命中掩码；**颜色**只由掩码决定。`bucket.peak`（严格的 `isPeakAt`）保留作计费口径；刻度着色口径含边界整点 12/18，与改前逐项一致。
- 清理：移除 `tickHoursForDay` 及前端注入的 `PEAK_TICK_HOURS` / `TICK_HOURS_PEAK` / `TICK_HOURS_NORMAL`（已被掩码取代）。

### P1-12 / D-01 页脚口径自相矛盾
- `routes/page.js` 页脚删除「本机账本的缓存拆分与官方账单口径不完全一致，实测约低 15%，可在插件设置里调整」——它与 1.14.0 已核对的「逐项一致、校准归 1」直接冲突，会诱导用户改坏已正确的校准系数。改为：「token 口径已与官方账单逐项核对，默认 1，无需调整；一切以官方账单为准」。全文（含 README）不再出现「约低 15%」。

### D-03 价目表措辞
- 「价目表核对于 2026-09-24」→「内置价目表仅为离线兜底，实时价以自动同步（官方价格页）为准」（避免读成硬编码权威）。

### 自检
- `tests/run-all.mjs` 新增第 [15] 节（17 项：P1-04 覆盖告示 + 2026 高峰判定 10 项回归 + P1-05 跨时区掩码 + 措辞 + stats 负载集成）。**379 → 395 项，全绿。**

## 1.14.27

**存储与入账硬化（验收维度二·功能闭环的第一批必修）：掐掉能静默改坏主数据的几条路。**

### P0-01 陈旧 legacy 基线不再被继承
- `routes/balance.js` 曾有**两处** `function stateGet`，后者（同一作用域内覆盖前者）在缺键时无条件回落配置键。已删除第二版，只保留第一版：`有该键则返回；否则仅在没有 dataDir 时回落配置键`。落点：`routes/balance.js:225-229`。
- 一次性迁移清单 `LEGACY_STATE_KEYS` **清空**（原含五个键），并新增 `STALE_BASELINE_KEYS = ['lastToppedUpBalance','lastGrantedBalance']`：这两个键若在配置里，**只记一条 info 日志、绝不回填**。
  - 理由：它们是「上一次测量值」而不是用户设置。`state.json` 丢失后若回填陈旧基线，会与当前真实余额形成一次虚假跳变，被误判成充值/退款并把累计值改坏（本机实测：旧值 25.83 vs 当前 16.37 ⇒ 一笔 ¥9.46 的假退款）。
- `lastEventType / lastEventAmount / lastEventAt` **同样不迁移**：它们只是「待展示的信息性提示」，入账结果早已落在配置的 `totalRecharged/totalRefunded`；state 丢失后重放一条陈旧提示只会造成重复提示，对判定与金额均无影响。

### P1-01 退款判定加「采样间隔守卫」
- 新增 state 键 `lastBalanceCheckAt`（每次成功采样并处理完后写入毫秒时间戳）、常量 `REFUND_GAP_MAX_MS = 30 分钟`。
- **仅退款方向（余额下调）生效**：`now − lastBalanceCheckAt` 缺失或超阈值 → 不判事件、只前移基线，并写 info 日志。
- **充值/赠金（上调）不受影响**：消费只让余额下降，任何长度的窗口里余额上调都只能来自充值，故长窗口下仍无歧义（代码注释已写明这条不对称的依据）。

### P1-02 入账写入失败不再被吞
- `writeConfig` 的 true/false 现在被入账分支检查：**累积值写不进去就不推进充值余额基线**，让下一次轮询看到同一跳变并重试；事件提示新增 `persistFailed` 标记，侧栏显示「累计值暂未落盘（设置存储不可用），将自动重试」。落点：`routes/balance.js:521-575`、`routes/widget.js` 的 `renderEvent`。
- **同源去重守卫**：记录上一次入账的 `lastBookedType/Amount/At/PrevTop/NewTop`；同一跳变（类型 + 吸附后金额相同、间隔 ≤ 15 分钟、**且基线仍停在上次入账前**）判为「上次累计已写、基线没写」的重复，只前移基线不再累加。
  - 额外比对「基线是否停在上次入账前」是必须的：若基线已正常前移，同类型同额度的二次跳变就是**真实的第二笔充值**（例如 15 分钟内真的充了两次 ¥10），不应被误吞。

### P1-03 预警工具与路由统一原子写
- `tools/balance-alert.js` 写 state 改为「先读盘、只合并 `alertState`/`lastAlertPushAt`、临时文件 + rename」。不再整对象覆盖 —— 否则会抹掉路由写的 `balanceSamples`、`lastToppedUpBalance`（正是「每轮被判成首次跌破、反复推送」的成因）。

### 自检
- `tests/run-all.mjs` 新增第 [14] 节：12 项静态守卫 + 22 项**合成数据行为实跑**（用桩 `ctx` 直接驱动 `/api/balance` 与预警工具）。三项与四个场景均已按验收断言覆盖。**345 → 379 项，全绿。**

## 1.14.1 – 1.14.26（区间补记，未逐版留痕）

> 这 26 个版本发布时**没有写进本文件**（本文件当时顶格停在 `## 1.14.0`），因此无法逐版还原。
> 发布快照 `backups/deepseek-balance-<版本>/` 保留了每一版的完整源码，可用于回溯某版本的行为。
> 从可用快照与自检项的归纳看，这一段主要是对 `## 1.14.0` 主特性集的连续打磨与缺陷修复；
> 不排除个别版本有独立改动，但当时未留痕，无法逐版确认。细节以 `## 1.14.0` 小节为准。

| 版本区间 | 内容（归 `## 1.14.0` 主题） | 回溯方式 |
|---|---|---|
| 1.14.1 – 1.14.26 | `## 1.14.0` 的逐版打磨/修复（主辅口径换位、token 口径、侧栏迷你图与今日消费额、通知样式统一、可用性修复、设置弹窗等） | `backups/deepseek-balance-<版本>/` 源码快照 |

**自 1.14.27 起每版独立成节**（1.14.27 / 1.14.28 / 1.14.29 / 1.14.30 … 见上方各节）。

## 1.14.0

**「消费金额」的主辅口径换位：token 估算升为主口径、校准归 1，余额差降为旁证，并重做设置弹窗。**

### 主辅换位：校准归 1（置信度提升）
- 拿到官方 2026-09-27 的逐小时账单（按 `input_cache_hit_tokens` / `input_cache_miss_tokens` / `output_tokens` 三类）后逐小时对账：**本机 token 估算与官方逐字段一致**（00:00 那一行 5861248 / 102094 / 36120 × 空闲价 = 0.36379896，一分不差），因此几天前拟合的 1.13 校准系数反而把准的估算改坏了。
- `manifest.json`：`costCalibration` 默认 **1.13 → 1**，描述改为「通常保持 1；token 估算已与官方账单核对过，不再需要全局拟合系数」。
  - ⚠ 已装机的 `config.json` 里若仍存着 1.13，源码改动不会覆盖它；需在设置里手动改成 1（或删掉该键回落到新默认）。
- 展示「今日消费金额」的地方（侧栏卡片、详情页、CSV 导出）继续走 `totals.cost`，校准为 1 时即纯 token × 单价。

### token 口径审计（对准官方三类）
- 核对 `lib/pricing.js` 的 `entryTokens` 映射：`cache.readTokens → input_cache_hit_tokens`、`input.uncachedTokens → input_cache_miss_tokens`、`output.totalTokens → output_tokens`，**与官方一致**。
- 补一处未雨绸缪：`cache.writeTokens` 也并入「未命中」（写入缓存的新输入在官方口径里同样按未命中计价）。实测本机账本 `cache.writeTokens` 恒为 0，故数值不变；`output.reasoningTokens` 恒为 null 且已含在 `output.totalTokens` 里，不再另加，避免重复计算。
- **新增黄金回归测试**：用官方 00:00 那组数（hit 5861248 / miss 102094 / output 36120）与空闲价（0.02 / 1 / 4 元/百万）断言 `costOf` = 0.36379896（误差 < 1e-8），并验证 `entryTokens` 字段映射与高峰 2 倍关系。

### 侧栏迷你图
- X 轴刻度**按当天类型变化**（`lib/holidays.js` 的 `tickHoursForDay`，单一源注入）：
  - **高峰日**：高峰窗口内整点每个都标（9-12、14-18）+ 非高峰时段每 3 小时（0/3/6/21）；
  - **非高峰日**：全部按每 3 小时（0/3/6/9/12/15/18/21）。
- 配色：**高峰日**把高峰窗口内的整点（9-12、14-18，含边界 12/18）标胭脂红 `#b4232b`，其余原色；**非高峰日全部原色**。高峰「日」判定仍走 `stats` 的 `todayIsPeak`。
- 刻度字号**随桶宽自适应**（`clamp((bw-1)/1.15, 5.5, 9)`）：高峰窗口内整点相连，相邻刻度间距就是桶宽，字号必须跟着缩放才能“尽量放大又不重叠”；接口只返回「零点到此刻」的桶，前端补齐到 24 个整点以便网格刻度（如 21 点）在清晨也能画出。
- 「**今日消费额**」卡片：**一行结构**（标签紧接金额、再紧接单位；`nowrap`、`?` 不可压缩），**金额在本卡作用域覆盖为 13px，与标签同号**（并把行高对齐为 1.5；仅改字号时盒顶差 2.27px，对齐后盒顶/基线/墨迹均 0.00px）；标签 13px、单位 `.amount-unit` 13px、`?` 行尾靠右并垂直居中；对齐用 `align-items: center`（本行与 `.amount` 内层）。**单位间距采用保险做法**：本卡 `.amount-unit { margin-left: 0; }`（由 −5px 改回 0）—— 不再吃掉全角（ 的字形留白，单位盒与金额盒相邻不重叠、两个墨迹各自留在自己盒内 ⇒ **任何字体栈下都不可能重叠**（不依赖字体属性）；代价是墨迹间距回到 ≈8px（净空 ≈7px）。其它卡单位仍 `margin-left: 4px`（视觉间距 ≈11.8px，未改）。实测（宿主 Chromium，13px；240px 与 220px 两档）：墨迹间距 ¥1000.66/¥1000.00 = 9.3px、¥1000.01/¥9.99 = 11.3px、¥99.99 = 10.6px、¥1234.56 = 8.3px、¥10000.00 = 8.7px、¥1234567.89 = 11.4px、¥12345678901.23（省略）= 8.0px，**全部 > 0，无重叠**；盒间隙恒为 0.00。**其它卡数值不受影响**（「可用余额」「累计消费金额」仍 26px）。整行宽度（240px 可用内宽）：¥0.60 = 166.4px、¥1234.56 = 188.4px（余 51.6px）。
- 柱悬停提示改为「主在前」：`token 估算` / `余额差·旁证` / `偏离`；余额差样本不足或 **|余额差| < ¥0.05** 时不给百分比，改显「**分辨率不足**」（官方余额只有两位小数，小额小数差本身就是舍入噪声）。

### 通知样式统一为弹窗（时区 / 事件 / 预警 / 错误四条）
- 新增 `.pop-layer`（`position: absolute; top: 38px; z-index: 40`，落在**头部区域下方**、居中、不占文档流、浮在卡片区之上、`pointer-events: none` 不挡点击）+ `.pop-card`（`width: max-content; max-width: min(240px, 100%)`，小卡片、长文案卡内折行）；**四条提示共用同一套样式与层级**，仅语气色/内容不同。
- **行为一律未变（除事件弹窗的存续期，见下）**：阈值红窗仍**常驻**（无自动消失计时器、余额恢复/关闭预警才隐藏，保留右上 × 与「当天静默」逻辑）；时区提示仍是一次性（沿用现值）；错误框（未配置 / 请求出错）的触发条件、文案、持续行为不变，只改承载与外观 。
- **事件弹窗改为常驻直到被关闭**：它**本来就没有前端计时器**（不是走 `toast` 的 4 秒自动收起通道）；唯一会“自然消失”的是服务端 `pendingEvent()` 的 **30 分钟时间窗**，本次已去掉 ⇒ 与红窗一样常驻，直到点 × 或点弹窗外（调 `/api/event/resolve` 清空，之后不再重弹；下次新事件会重新弹）。触发与状态管理未变，未新增持久化。
- 时区提示的显隐由内联 `style.display` 改为 class（`.notice.on`），可见行为不变；**错误框也纳入浮层**（`.box.err-box.pop-card`），与其它三条纵向堆叠、不可能重叠。
- **弹窗卡片改为不透明实色底**：四张卡的背景混色基色由 `transparent` 换成 `var(--bg-card)`（`background: color-mix(in srgb, <语气色> N%, var(--bg-card))`），保留各自语气色；边框 / 阴影 / 圆角 / 宽度 / 位置 / 行为不变。实测（宿主 Chromium）明/暗两模式 × 5 张卡共 10 例，computed `backgroundColor` **alpha 均 = 1**；文字对比度 明 3.35–14.27:1、暗 4.90–11.18:1（与改前“半透明叠在浅底上”基本一致，未因改实色而变差，故未调整语气色）。
- 实测（宿主 Chromium，258px 面板，四条同屏）：头部底边 = 10 + 24 = **34px**、浮层顶 = **38px** ⇒ 余 4px，**不覆盖头部**（且 38 − 入场动画上偏 4 = 34 = 头部底边，动画首帧也不入头部）；卡片最大宽度 errBox 120.7 / notice 234.6 / alertBox 238.0 / eventBox 238.0，**均 ≤ 240px**（长预警文案折 4 行）；相邻卡片 top ≥ 上一张 bottom ⇒ **无重叠**；浮层 `pointer-events: none`、子项 `auto`，头部三个按钮处 `elementFromPoint` 均为按钮本身（不挡点击）。

### 可用性修复
- **红卡文字对比度达 AA**：新增变量 `--danger-text`（明 `#b4232b` / 暗 `#ff6b6f`），`.notice.warn` / `.err-box` / `.box.alert-box` 的 `color` 改用它（背景/边框/语气不变）。实测对比度：明 **5.74 / 5.89 / 5.59:1**（改前 3.44/3.53/3.35，均低于 AA 4.5）；暗 5.06/5.22/4.90:1（未变）。
- **浮层顺序：红窗优先**：`.pop-layer` 内 DOM 顺序改为 `alertBox → errBox → notice → eventBox`（`#alertBox` 置顶）；其余三类不排序。
- **弹窗显隐不再触发“无鼠标移动”的 hover**：凡浮层显隐会改变光标下方元素的路径，统一调用既有的 `muteHoverUntilMove()`（复用、不自建）——覆盖红窗显示/收起、事件显示/收起、时区提示显示/自动收起、错误框显示/收起、时区菜单开/关、设置弹窗关闭（`onClose`）、以及卡片内容变化引起的位移（高度真变化时才抑制）。实测（真实 widget）：弹窗关闭后未移鼠标则 `tip.on=false`（不弹提示）、`#content pointer-events=none`；真实 `mousemove` 后恢复、再次悬停 `tip.on=true`。
- **事件弹窗 UI 统一 + 关闭方式**：去掉「忽略」按钮；右上角加删除图标，与红窗共用共享类 **`.pop-close`**（同尺寸/同圆圈/同 hover，颜色随卡片语气色 `currentColor`）；两种关闭方式——①点 ×（并调 `/api/event/resolve` 清服务端待处理事件，避免下次刷新重弹）②鼠标左键点弹窗区域外任意位置；**无自动消失计时器、且已去掉服务端 30 分钟时间窗 ⇒ 常驻直到被关闭**。
- **提示框移出不“上飘”**：根因是 `.tip` 的基态 `transform: translateY(-2px)` 与 `.on` 的 `translateY(0)` 差异被 `transition: opacity, transform` 补间——移出时回退基态就向上飘 2px。现改为：基态与动画终态均 `transform: none`、位移只在**入场一次性动画** `tipIn`、过渡仅 `opacity` ⇒ 隐藏时不再位移。实测（定格位置，与过渡是否推进无关）：改后隐藏位移 **0.00px**、改前对照 **−2.00px**；`transitionProperty` 改后 `"opacity"`、改前 `"opacity, transform"`。
- **提示框小尾巴不再跳位**（另一种“一闪”）：真因是 `bindTipExclusions` 给卡内按钮/链接绑的 `mouseleave → showTip(closest('[data-tip]'))`——当指针**直接离开外层卡片**时它也会触发，把提示以**外层卡片**为锚点重显一帧，箭头 `--arrow-x` 跳到卡片中心。改为用 `event.relatedTarget` 判断“指针是否仍在锚点内”，只在回到锚点内时恢复提示；返回卡内时的原有恢复行为保留。实测（真实 widget，逐锚点记录 class/`--arrow-x`）：去充值按钮“离开到卡外 / relatedTarget=null”时提示保持收起（箭头不跳）；“回到卡内”时正常恢复（arrowX=81）；`?` / 柱子 / 整卡等锚点移出后箭头均不变。
- **清理死代码**：删除 `.event-skip` 两条 CSS（「忽略」按钮已移除）。
- **悬停意图延迟：掠过不再闪提示**：`.tip` 是单例元素；指针从「自有资金」掠过卡片间隙落到相邻卡片时，相邻卡片会触发**一次真实的 `showTip`**（实测：`--arrow-x` 由自有资金的 **77px** 变为卡片的 **81px**，`text` 也换成卡片文案），同一可见提示框被重定位 → 叠加随后的 `hideTip` 就是“小尾巴跳到上一张卡片、一闪而逝”。改为 `showTip` **只挂延迟（`TIP_SHOW_DELAY = 120ms`）**、真正渲染在 `renderTip`；延迟内任何 `hideTip`（移出/掠过/抑制）都 `cancelTipShow()` ⇒ **快速掠过不弹**、**刻意悬停只晚 120ms**。实测（真实 widget 逐锚点）：掠过（进入后 40ms 即离开）**9 个锚点全部未弹**；刻意悬停（停留 220ms）正常弹出且箭头值正确。前三次修复（淡出先归 0、`relatedTarget` 闸门、隐藏无位移）均保留（该“先归 0”修复仍保留：`renderTip` 若判定正处淡出（`hideTip` 记 `state.tipHiddenAt`，`Date.now() − tipHiddenAt ≤ TIP_FADE_MS`），会先禁过渡 + `opacity` 归 0 再改几何，最后恢复过渡淡入。）
- **箭头移出不再“翻面”（作者报现象的真因）**：`.tip::after` 的箭头所在边**只由方向类决定** —— 基类 `.tip::after` 是 `bottom: 100%`（箭头在提示框**上边**，用于“提示框在锚点下方”），`.tip.above::after` 是 `top: 100%` + `border-top`（箭头在**下边**，用于“提示框在锚点上方”）。`hideTip` 原先把类名回落成 `tip`（丢掉 `above`）⇒ 箭头**瞬时**从下边翻到上边框（与悬停态关于提示框中线上下镜像）；提示框恰好落在两卡之间的间隙时，它的上边框就贴着上方那张卡的边框（这就是最初“跳到上一个卡片边框”的统一解释）。两变体共用**同一条 x 原点声明**（`left: var(--arrow-x)`，`above` 变体不覆写），移出前后 `--arrow-x` 也不变（77/190 原样）⇒ **不存在左右镜像**，看到的是上下翻面。修复：`hideTip` **保留方向类**（`contains("above") ? "tip above" : "tip"`）。实测（`getComputedStyle(el,'::after')` 静态读数，与过渡是否推进无关）：改前移出瞬间 `borderTop 5→0 / borderBottom 0→5`（翻面），改后 `borderTop=5 / borderBottom=0` 保持不变、`tip above` 保留；非 `above` 锚点本就无变化。

### 设置弹窗重做（点「去设置」弹出的那个）
- 右上角加**关闭（×）**，圆形、1px 描边 + 极浅底色、悬停加深（与侧栏预警的 × 同款）；点外部遮罩、按 Esc 也可关。
- 标题「余额预警设置」**居中**。
- 首行标签「修改路径」→「**实际路径**」，**内容仍是设置入口** `Hana 设置 → 插件 → DeepSeek API 可用余额`（插件名已同步为新名称；不显示磁盘路径）。顺带把「未配置 API Key」提示里的旧插件名一并纠正。
- **删掉「自动刷新」一行**。
- 「预警阈值」→「**余额预警阈值**」，值由只读文本改为**输入框**：宽度仅容三位数（48px）、`type=text` + `inputmode=decimal`（**无 spinner**，纯输入框）；输入时只留数字与小数点、多余小数点与超两位的小数截断；**0 或留空 = 不设置阈值**（写入按 0）。
- 按钮「知道了」→「**修改**」；两条反馈都是**居中提示浮层**（复用共享弹窗体系：**框随字收紧**（`width: fit-content`）、可读字号 12px / 行高 1.5、无按钮、不拦鼠标、叠在设置弹窗之上，3 秒自动收起）：
  - 值未变动 → 浮层「余额预警阈值未变动，请核对！」，设置弹窗**保持打开**；
  - 值变动 → `POST /api/config`（复用已有 `/api/config` 路径，未新造端点）写入，**先关设置弹窗**再浮层「已将余额预警阈值改为XX」（两位小数；为 0 时给出「0.00（不设置阈值，不再提醒）」），保留与「去设置」一致的**绿 + 字重 500**（字号不缩，用统一可读值）；并即时同步界面（`state.alertThreshold` + 重判红框）。
- 共享层新增：弹窗可选能力 `closable`（×）/`centerTitle`/`bodyBuild`/`onOk`（返回 false 则不关闭），以及居中提示浮层 `openNotice/closeNotice`（`#noticeModal`）；`page.js` 的导出成功弹窗不受影响。

### 今日消费额：标签含单位 + 汇总改余额差口径 + 事件小时还原（口径修正）
- **标签改名 + 改半角括号**：「今日消费额」→「**今日消费额(CNY)**」（单位文字从 `.amount-unit` 移进 `.card-label`，本行不再有独立单位元素；括号用半角，比全角窄 10px——全角时标签自然宽 114px，半角 104px）；金额仍只显示 `¥xx.xx`，字号/行高/对齐/`?` 全部未动。为旧结构写的 `.today-row .amount-unit { margin-left: 0 }` 已成死 CSS，删除。
- **宽度守卫换成实测口径（旧尺子用错了）**：旧断言拿 240px 核验，而实测卡内可用宽只有 **181px**（链：iframe 258 → body 241（去 17px 滚动条）→ `.content` 213 → `#usageCard` 213 → `.card-inner` 181，卡内 padding 16px×2）⇒ 全角标签下 ¥1234.56 = 183 > 181，**会被截断**（就是作者看到的现象）；半角 + 4px 后 177 ✓。
- **半角括号的间距回归：`.amount` 加 4px 硬边距（保险做法优先于紧凑）**：半角 `)` 右留白 −0.059、`¥` 左留白 −1.000（**两侧均为负**）⇒ 不加边距时墨迹间距 **−1.06px**（墨迹真的交叠，不只是“相接”；全角时的同口径值未重测，旧扫描法有 ~1px 系统偏差）。给 `.today-row .amount` 加 `margin-left: 4px`（与其它卡 `.amount-unit` 同一尺度）⇒ 实测墨迹间距 **2.94px**（= −0.059 + 4 + −1.000）、盒间隙 **4.00px**。关键是这 4px 是**硬边距**：它是唯一一个不随字体变的项（字体的贡献只有 −1.06px 这一小项），把失稳阈值从“留白略负就交叠”推到“需合计负留白 > 4px 才交叠”。
- 新口径实测（13px，标签 104 + 4px + 金额 + ? 15）：¥0.60/¥9.99 = 155、¥99.99 = 163、¥999.99 = 170、¥1234.56 = 177（余量 4）⇒ **可容纳上限 = 4 位整数（¥9999.99 = 177，余量 4）**；5 位（¥99999.99 = 185）起截断。超界时：标签不收缩（scrollWidth=offsetWidth=104，永不截断）、金额收缩出省略号（`.amount-value` 自带 `overflow:hidden/text-overflow:ellipsis`，干净收尾）、`?` 仍贴行右（距行右 0.00）、行盒高不变（label/value/row 均 19.50）、不换行（row.scrollWidth = clientWidth = 181）。几何：盒顶差 0.00px。
- **汇总金额改用「余额差」口径**：`el.todayCostValue` 不再取 `totals.cost`（token 估算），改取接口新增的 `totals.balanceCost`（各桶余额差之和；样本全缺 → `null` ⇒ 显示 `--`，不拿 token 估算冒充）。与迷你柱的双口径提示同源。
- **事件小时不再整块丢弃（“金额差与官方不准”的根治）**：样本新增按小时的事件金额累计 `evAmt:{recharge,refund,grant}`（由 `recordSample` 用**实际入账额**累加；充值已按整元吸附），`hourlyCosts` 对 `ev` 小时改为 `消费 = 首样本余额 − 末样本余额 + 充值 − 退款 + 赠金`；缺 `evAmt` 的历史样本仍回落 `null`（向后兼容，不臆测）。
- 实测（2026-09-27，冻结快照 22:01 CST，本机样本 25 条）：官方今日（00:00–21:00，cost CSV 与 amount CSV 两条互校一致）合计 **31.97676568**；改前金额差口径合计 **23.88**（13:00/18:00/21:00 三个 `ev` 小时整块丢弃，丢掉的官方值 8.20706176）；改后 **32.14**，残差 **+0.16（+0.51%）**；同区间 token 估算口径合计 **30.78**（本机账本少记请求，见下）。

### 账本口径查清 + evAmt 验证脚本
- **宿主漏记机制定位（A）**：宿主只在响应消息带 `usage` 时记账（两个记账点同构，否则 `return null`）⇒ 被取消/进程退出时在飞、响应无 usage 的调用**一条都不落**，而官方照样计费。实测证据：今日共缺 **14 条**（04:00 −1、13:00 −4、14:00 −4、15:00 −1、20:00 −4，20:00 那 4 条为 `hit 0 / miss ≈39 万/条 / out ≈2.5 千/条`）；账本 requestId 计数器在**每个纪元内连续无缺口**（19/20 纪元零缺口，唯一缺口是容量上限挤掉的最老一段）⇒ 缺失的请求根本没走 `start()`，不是 finish 被丢；ledger 的 `list()` 不过滤、`limit: 100000` ⇒ 不是插件读少了。**插件无法修（不改宿主 bundle），本地也无可判定依据 ⇒ 不做臆测式告警**。
- **账本容量自查（可可靠判定的一类）**：宿主 `maxEntries = 5000`（`Xnt=5e3`），超出即滚掉最老条目（实测账本正好停在 5000 条）⇒ `/api/stats` 新增 `ledger.{entries,maxEntries,truncated,oldestAt}`，详情页页脚在满额时提示「账本容量」。
- **新增 `scripts/verify-evamt.mjs`（B）**：把「事件小时按记账那一刻的实际入账额还原」这条独立路径做成一条命令 —— `--selftest` 跑合成三分支（充值/退款/赠金）、默认读真实样本逐小时对照（入账额/还原值/token 估算/可选官方 CSV）；无 evAmt 样本时打印「暂无 evAmt 样本（等下次真实充值）」而不是报错。README 新增「账本口径与已知缺口」与「evAmt 端到端验证」两节。

### 自检与文档
- 自检 **237 → 345 项**（黄金回归、口径映射、X 轴按日类型刻度与配色、今日消费额行（标签含单位半角括号/卡内实测内宽 181px 口径/拟合边界 4 位整数/超界省略号不挤 ?/4px 硬边距后墨迹间距 2.94px/字号/对齐）、通知统一为弹窗（四条共用、头部下方 top 38px、卡片 ≤240、不透明实色底、错误框纳入、红窗优先、事件弹窗常驻）、**可用性修复**（红卡对比度 `--danger-text`、红窗置顶、浮层显隐统一抑制 hover、事件弹窗 ×/外点关闭无计时器/无时间窗、提示框移出不飘、箭头不跳位（relatedTarget 闸门 + 淡出中不被重定位 + **移出时保留 above、不上下翻面**）、**悬停意图延迟（掠过不弹）**、`.event-skip` / `.event-input` / `.event-ok` 死代码清理、**充值判定门槛 5 → 1 元（退款门槛独立保持 5 元，避免日常消费误记为退款）**、**充值金额按整元吸附（官方只允许充正整数，2.99 → 3）**）、**余额差口径**（事件小时按实际入账额还原 + 缺 `evAmt` 兼容 + `totals.balanceCost` 合计）、**账本口径**（verify-evamt 脚本三分支 + 无样本分支 + 带 evAmt 还原 + 账本容量自查字段）、卡片标题、分辨率下限、设置弹窗、实际路径、输入框、提示浮层等），结果 0 失败。
- 不新增出网域名，不改动 Hana 配置与定时任务。

## 1.13.0

**推送语义改为「跌破即推一次，不再按间隔重推」。**

- 判定：余额跌破阈值那一刻 → `due=true, reason=entered_alert`，推一次并记 `alertState=1`；
  持续低于 → `due=false, reason=still_low`（不再重推）；回升 → 复位为 `0`，下次再跌破仍立即推。
- 移除「未解除则每 alertCooldownMinutes 重推」分支，`still_alerting` 不再出现。
- 配置项 `alertCooldownMinutes`（预警提示间隔）随之退出：不再影响推送节奏，已从设置中移除。
- 语义用七步实跑验证（高于阈值 / 跌破 / 持续低 / 回升 / 再跌破 / 仍低）。
- 自检 234 → 235 项。
## 1.12.0

一轮面向「消费金额」的增强：把余额变动从「等用户确认」改为**自动入账**，并给消费金额补上第二条独立口径（余额差）。

### 充值/赠送/退款不再手动确认
- 检测到余额跳变时**直接采用推断值**：充值 → 累加 `totalRecharged`；退款 → 累加 `totalRefunded`；赠金 → 仅记录。侧栏不再弹确认输入框/按钮，改为一条信息性提示（「增量 + 结果」）：`已自动修正：充值 ¥10.00（累计 ¥60.00）`。
- 事后手工通道保留：仍可在插件设置里直接改 `totalRecharged` / `totalRefunded`。
- `/api/event/resolve` 收缩为「忽略」单一语义（清提示、不改累计数）；`renderEvent()` 只渲染信息提示 + 「忽略」。

### 侧栏卡片
- 「今日用量」→ **「今日消费金额（CNY）」**，数值显示 `¥xx.xx`（两位小数）。
- 标题旁加 `?` 说明图标（复用 `.info` / `data-tip` 机制），提示高峰/空闲时段口径（固定文案，可被 1.12.0 的同步覆盖）。
- 卡内迷你图由「按小时请求次数」改为**按小时消费金额**，Y 轴刻度自适应（¥），并只标**高峰边界点 9/12/14/18**；**高峰日这四个刻度文字全红，非高峰日不红**（柱子保持原色）。
- 鼠标移到卡内迷你柱上弹出三行**双口径提示**（复用侧栏既有 `.tip` 机制）：`¥x.xx（余额差）` / `¥y.yy（token 估算）` / `偏离 z%`；缺样本显示「—」。

### 高峰规则文本（每 12 小时同步时校验）
- `lib/price-sync.js` 新增 `parsePeakRule()`：从官方价格页文本按句提取含「高峰 / 空闲 / 北京时间」的规则句（**先剥掉开头的 `(n)` 序号**），随 `parsePricePage()` 一并返回。
- 展示值默认是内置段 `PEAK_RULE_BUILTIN`；**只有规则真的变了才替换**：
  - 首次同步（`peakRuleExtracted` 还是空）只建基线，不改展示值（首次不算变化）；
  - 后续与基线不同（真变化）→ 同时更新 `peakRuleText` / `peakRuleExtracted` 并记 `peakRuleChangedAt`；
  - 提取失败 → 保持当前展示值（fail-soft，绝不清空）。
- 状态存 `state.json`：`peakRuleText`（展示值）/ `peakRuleExtracted`（上次提取值）/ `peakRuleChangedAt`（真实替换时间戳）。
- **一次性迁移**：历史版本把页面原句（含 `(2)`）直接写进了 `peakRuleText`；加载时若检测到「无真实变化记录」（无 `peakRuleExtracted`，或提取值与展示值一致且无替换时间戳）→ 重置回内置段。

### 高峰标色与节假日
- 新增 `lib/holidays.js`：内置 **2026 年中国法定节假日**（元旦/春节/清明/劳动/端午/中秋/国庆），并附调休上班日清单备核对。
- 高峰判定 = 北京时间周一至周五 && 非节假日 && 9:00-12:00 / 14:00-18:00；**调休上班日仍按周末处理**（官方措辞“不含节假日”指的是放假日）。
- 新增配置项 `holidayDates`（逗号/换行分隔的 `YYYY-MM-DD`），可手工补充；只做并集，不删内置。
- 柱 **保持原色**；改为把**高峰边界点的 X 轴刻度文字**标为**胭脂红** `#b4232b`：刻度只取 **9 / 12 / 14 / 18** 四个高峰边界，颜色按**日级高峰**判定（复用接口返回的 `todayIsPeak`，不在前端重算）——高峰日四个全红；非高峰日（周末/法定节假日）全部原色。
- 高峰判定继续走 `lib/holidays.js` 的 `isPeakAt`（北京时间周一至周五非节假日），柱的 `peak` 标记由服务端算出。

### 侧栏迷你图提示（详情页未改动）
- 双口径悬停提示**只在侧栏卡片迷你图**上：柱子带 `data-tip`，在容器上做事件委托，复用侧栏已有的 `showTip` / `hideTip`（不新增提示元素，也不动「悬停排除按钮/链接」规则）。
- **详情页 `routes/page.js` 不做任何改动，已逐字还原为 1.11.0**（无金额 Y 轴 / 无自建 tip / 无 `data-bartip` / 无图例「今日」）。`balance.js` 的 `/api/stats` 新增字段仅为侧栏保留，详情页不消费。

### 双口径（主：余额差 / 辅：token × 官方价）
- 新增 `lib/balance-samples.js`。`routes/balance.js` 每次成功取到余额时，把 `{t,total}` 写入 `state.json` 的**小时级样本** `balanceSamples`（只保留最近 30 天 + 条数硬上限，只在变化时落盘）。
- 某小时消费 = 该小时末样本 − 上一小时末样本，**只取正数（下降额）**；若该小时内检测到充值/退款/赠金事件，则该小时标为**事件时段，不计差**。
- 辅口径复用现有估算（含高峰倍数与校准系数）；偏离 = `(token 估算 − 余额差) / 余额差 × 100`。

### 自检与文档
- `manifest.json`：新增配置项 `holidayDates`，版本升到 1.12.0；不新增出网域名。
- 自检 **161 → 230 项**（自动入账、卡片改名/提示文案、规则句 fallback 与状态迁移、高峰判定含周末/节假日/补充、双口径与偏离、侧栏迷你柱提示、详情页还原守卫），结果 0 失败。

## 1.11.0

**预警节奏改成「状态变化立即推 + 未解除每 60 分钟重推」**（按你的要求），并查清了投递通道的硬边界。

- **实测边界（两条路都试过、都被拒）**：
  1. 插件总线**没有** `notify.send`（那是宿主内部工具的事件）—— 调用报 `No handler registered`；
  2. `session:send` **不接受 Bridge 会话** —— 宿主报 `path must be an active desktop session under agents/{id}/sessions/*.jsonl`。
  结论：**插件无法自己把消息送进微信**，投递必须由 Agent（宿主官方 notify 能力）完成。
- **因此插件负责「判定 + 节奏」**（`balanceAlert()` 内置状态机）：
  - 余额**刚跌破阈值** → `due=true, reason=entered_alert`（立即推一次）；
  - 预警**未解除** → 每 `alertCooldownMinutes`（默认 60 分钟）`due=true, reason=still_alerting`；
  - 其余时候 `due=false` 并给出原因（`repeat_cooldown` / `recovered` / `normal`）；
  - **恢复后复位**，下次再跌破仍会立即推。
- 状态存在插件自有 `state.json`（`alertState` / `lastAlertPushAt`），重启不丢。
- 工具 `deepseek_balance_alert` 与 `GET /api/notify-due` 都返回这套结果，供定时任务轮询。
- 自检保持 124 项全过；新增机制待下一轮补测试。
- 遗留：`routes/balance.js` 里的两个一次性调研探针（`/api/_sessions`、`/api/_sendprobe`）**已彻底删除**（此前只做了早退失效），实测两路由均返回 404。

## 1.10.0

**余额预警可推到微信（经由 Agent）**：余额低于阈值时，由定时任务把提醒发到微信，微信里那个充值链接可直接点开。

- **先说实测结论**：插件**无法直接推微信** —— 插件总线里没有 `notify.send`（那是宿主内部工具的事件，调用报 `No handler registered`），桥接通道也不对插件开放。
- **因此改为两步走**：
  1. 插件新增工具 `tools/balance-alert.js`（Agent 可调、只读）：读配置的阈值与 Key，查官方余额，返回 `{ due, total, threshold, text }`，`text` 即一条可直接转发的提醒（含 `https://platform.deepseek.com/top_up`）；
  2. 定时任务（建议每小时）调用该工具，若 `due=true` 则用宿主的 `notify` 工具发到微信（`channels:['bridge_owner']`, `bridgePlatforms:['wechat']`）。
- 去重交给**调度频率**（每小时一次）+ `alertNotify` / `alertThreshold` 开关；工具本身无状态，不写任何文件。
- 另增 `GET /api/notify-due`：同样的判定，供网页/脚本查看。
- 配置：`alertNotify`（默认开）。
- 自检 118 → 126 项（判定接口、文案含充值入口、开关、工具存在性、不声明不存在的能力）。

## 1.9.2

## 1.9.2

- **继续修价格页解析（1.9.1 只修了一半）**：真正的结构差异是 —— HTML 去标签后，「百万tokens输入」与「（缓存命中）」被拆成**两行**，而类型判断要求二者在同一行，导致三个价格块一个都没匹配上。现改为把当前行与下一行拼起来判断（同时仍要求出现 tokens，以避开「输出长度」这类字段名）。
- **验证方式改进**：把真实页面抓成本地样本，用解析器直接跑（本地秒级迭代，不必反复装机）；实测解析出的两个型号价与内置表**逐字段一致**。
- 诚实记录：1.9.0 与 1.9.1 期间自动同步一直是失败的（fail-soft 生效，金额未被污染，计价仍用内置表）。

## 1.9.1

- **修 1.9.0 的价格页解析**：HTML 去标签后，型号名后面会跟一个**独立的脚注标记行**（如 `(1)`），原扫描遇到它就停，只认出一个型号 → 与两列价格数量不匹配 → 同步一直失败（fail-soft 生效，金额未被污染，但自动同步形同虚设）。现改为跳过脚注标记继续收集，直到出现 `BASE URL` 这类结构标记才停。
- 失败原因现在**附带上下文片段**（仅价格相关文本，不含原始 HTML），便于日后页面改版时快速定位。
- 自检新增 9 项：价格页两型号正例、与内置表交叉一致、结构异常/表不全的 fail-soft、去标签不返回脚本内容、同步优先级等。

## 1.9.0

**官方价格自动同步**：不再要求用户手工填单价 —— 新模型、改价自动跟上。

- **新增 `lib/price-sync.js`**：抓取官方价格页（`api-docs.deepseek.com/zh-cn/quick_start/pricing/`）→ 去标签提取文本 → 解析出各型号的**空闲时段单价**（命中/未命中/输出）。
- **结构化校验（fail-soft）**：型号数必须等于每行价格个数、**高峰价必须等于空闲价 × 2**（官方页脚明示该口径）、价格必须 > 0。任一不满足 → 返回失败原因，继续使用内置价目表，**绝不用半成品数据**。
  - 附带收益：解析出的两个已知型号价与内置表**完全一致**（已作为交叉校验写进自检）。
- **计价优先级**：配置覆盖表 → **官方价格页（自动同步）** → 内置价目表 → 按族估算 → 未收录。来源会在页面标注。
- **同步时机**：插件加载即后台同步一次（不阻塞请求）+ 每 12 小时定时刷新；过期时在统计请求里后台补刷。
- **可见性**：详情页页脚新增「价格同步」一行 —— 成功时显示同步到的型号数与时间；失败时显示原因（仍照常估算）。
- **网络边界**：`network.allowedHosts` 新增 `api-docs.deepseek.com`（只读 GET）；`maxResponseBytes` 64KB → 512KB（价格页 HTML 较大）。
- 自检 108 → 117 项（新增价格页解析、fail-soft、去标签安全、同步优先级等）。

## 1.8.1

- **修 `routes/balance.js` 的静态 import 隐患**（1.8.0 首次装机后 `/api/stats` 返回 404）：日志为 `route "balance.js" failed to load: The requested module '../lib/pricing.js' does not provide an export named 'resolveModel'`。原因就是 README 维护须知第 1 条描述的 ESM 缓存错位 —— `ui-shared.js` 早已改为带时间戳的动态 import，而 `pricing.js` / `export-csv.js` 仍是静态 import，重装后新路由拿到旧模块。现三个 lib 模块统一改为 `await import('...?v=' + Date.now())`。
  - 教训补充：**本地新进程的单测测不出这类错位**（进程无缓存），只有宿主进程里重装才会暴露。
- 自检改进：`/api/stats` 路由可用性由「读取失败即跳过」改为**断言 HTTP 200**（404/5xx 判 FAIL），仅在「已装版本尚未提供新字段」时才跳过型号守卫 —— 把路由注册失败这类问题从「静默跳过」变成「响亮失败」。
- 自检 108 项。

## 1.8.0

把「型号识别与计价」从硬编码改成可扩展、且**不静默算错**的形态（背景：官方改价/改名/新增型号时，原先未知型号会被静默按 Flash 价估算）。

- **三级计价**（`lib/pricing.js` 新增 `resolveModel`）：
  - `exact` 精确命中 → 确定价；
  - `family` 同族带后缀 → 按族估算（来源会标明）；
  - `unknown` 未收录 → **不臆测价格**（`prices: null`），由调用方决定展示与是否计入金额。
- **未收录型号的处理**：token 照实统计并单独成项，**金额不计入合计**，接口返回 `unpriced{requests,tokens,models}`，详情页顶部提示并可据此补充单价（区分「事实」与「推断」）。
- **价目表改为规则表 `PRICE_RULES` + 别名表 `MODEL_ALIASES`**：改价/改名只改数据不改逻辑；未收录的型号名**原样保留、独立成项**，绝不被合并或丢失。
- **配置升级**：`priceFlash` / `pricePro` 两个固定字段 → 通用**单价覆盖表** `priceOverrides`（每行 `型号或前缀*=命中/未命中/输出`）。首次运行会把旧键的值**平滑迁移**成表里的一行，旧键保留不删以便回滚。
- **校准系数只作用于已收录型号**，避免新模型的偏差被摊进全局校准。
- 自检 96 → 107 项：新增三级计价单测、覆盖表解析/优先级、以及一项**实效守卫** —— 扫描账本内出现过的所有型号，逐个断言「已有单价或已标注未收录」，新模型一出现即在自检中冒头。

## 1.7.2

- **修侧栏「去充值」在刷新时变白闪烁**：`setBusy()` 原先连带把「去充值」也置为 `disabled`，而 `button:disabled { opacity: 0.55 }` 加上 150ms 的 opacity 过渡，在刷新（自动/手动/点击刷新按钮/切回标签页）期间表现为「明显变白后回到初始」。现改为**只让刷新按钮自己表达忙碌**（旋转 + 置灰），刷新期间不再触碰「去充值」。
- 实测依据：刷新期间采样到「去充值」被置为 disabled；按钮底色 `rgb(14,165,233)`、卡片底色 `rgb(245,246,247)`，半透明后视觉上趋白。
- 自检新增 1 项：刷新期间不得禁用「去充值」。

## 1.7.1

- 文档（无代码改动）：维护须知新增第 9 条 —— **带「状态迁移」的版本复核清单**：备份数据目录 → 触发一次业务调用确认迁移产物 → 逐字段核对迁移产物与原配置键 → 核对累计值并抽查两个面板。
- 背景：1.7.0 把 5 个内部状态键从用户配置迁到 `state.json`。实测该迁移正常（`lastToppedUpBalance` 等逐字段一致、累计值未变），但迁移动静小、出错时不易察觉，故把复核动作固化成清单。

## 1.7.0

把三处结构性问题收敛掉（对界面外观无改动）。

- **前端数据通道改用官方同构的 `hana.api`**：两个面板不再自拼 `/api/plugins/{id}/`，也不手动传 surface session 头，统一走共享层里与官方模板同构的 `HPU.api.url/fetch`（含路径规范化：拒绝绝对 URL、目录穿越、前导双斜杠）。宿主改路由前缀或鉴权方式时只需改这一处。
- **内部状态迁出用户配置**：余额基准与待确认事件（`last*` 五项）改存插件自有目录的 `state.json`（`ctx.dataDir`），配置界面不再出现一排「请勿手动修改」。首次运行自动从旧配置键迁移；无 `dataDir` 时回落到旧行为。
- **账本读取成本下降**：`/api/usage` 增加 20 秒计数缓存（侧栏心跳每 12 秒调一次，原先每次都全量扫账本）；`usage:list` 总线调用加 8 秒超时，避免宿主挂住时请求堆积。
- **调度与看门狗判定抽为纯函数**（共享层 `HPU.Sched`）：自检从「代码形态断言」升级为行为断言（可见/隐藏/退避/看门狗/路径规范化）。
- 修正 `costCalibration` 注释里的过期默认值（1.2 → 1.13，与 manifest 一致）。
- 新增 `scripts/release.mjs`（备份 → 打 zip → 自检一条命令）；`lib/` 导出补 JSDoc，可选跑 `tsc --checkJs`。
- 自检 73 → 95 项。

## 1.6.1

对准「更新显示时间」：

- **时间戳统一按北京时间显示**（与高峰价判定同一基准，不受本机时区影响）。侧栏「更新于 / 更新失败」与详情页「更新于」均改为显式计算北京时间（`Date.now() + 8h` 取 UTC 字段），而不是跟随本机时区。
- **详情页不再“只取一次”**：原先只在打开时取数，「更新于」会一直停在打开那一刻；现改为可见时每分钟重取一次（隐藏时不跑），并在回到该标签页时立即补取一次。侧栏本已每分钟刷新，与之一致。
- 背景：本机时区为 UTC+08:00 与北京时间无偏移，所以“不同步”的根因是**刷新节奏**（侧栏隐藏时放宽到 5 分钟、详情页完全不轮询），而不是时区换算。

## 1.6.0

修复「侧边栏展示后不按分钟自动刷新」。

- **默认刷新间隔 300 → 60 秒**（manifest 默认值与 `config` 接口回退值同步调整），新装即每分钟刷新。
- **定时链自愈**：`tick` 改为 `try/finally`，无论单次刷新成功或抛错都排下一次，避免一次异常就把轮询永久打断。
- **配置热重载**：心跳每约 60 秒重读一次本地配置，改「自动刷新间隔」后无需重开面板即可生效（此前只在一开始读一次）。
- **看门狗兜底**：新增 12 秒心跳，若「距上次成功更新」超过 2 个刷新周期（下限 2 分钟）就强制补一次，覆盖宿主 iframe 节流导致的定时器失准。
- **可见性策略调整**：窗口不可见时不再完全停刷，而是把间隔放宽到至少 5 分钟；恢复可见时立即补刷一次。
- 自检新增 8 项（现共 73 项）。

## 1.5.5

- 新增 `README.md`（随发布包分发），记录：功能与口径、配置项说明、**已知现象与判别法**（更新后首次「加载失败」的归属判断）、诊断入口、自检命令、维护须知与目录结构。
- 把两条踩过的坑写进维护须知：跨文件共享必须绕开 ESM 缓存；模板字符串里的正则反斜杠必须写两层。

## 1.5.4

- **可用余额卡片：排除卡内两个操作元素。** 新增 `bindTipExclusions()`，对卡片内的按钮/链接（「去充值」「去设置」）不再弹出外层卡片的提示；鼠标离开它们后恢复卡片的提示。卡片其余区域（含留白与间距）仍全覆盖。
- 自检新增 1 项（现共 65 项）：断言排除逻辑存在且选择器正确。

### 关于「更新插件后侧栏提示加载失败，重试即成功」的排查结论

实测结论：**问题不在插件侧**。

| 实验 | 结果 |
|---|---|
| 重装前取得 ticket，重装后继续用**旧 ticket** 取面板 | **200**（未失效） |
| 重装全过程并发请求面板（38 次，含安装中 10 次） | **全部 200**，无可不可用窗口 |
| 不带 ticket 直取（对照） | 403（说明鉴权本身正常） |
| 服务端日志 | 插件每次加载 7～9ms，无 error |
| 渲染进程日志 | 无插件相关报错（该日志不采插件 iframe 内部 console） |

即：插件路由在重装前、中、后均持续可用，凭证也未失效。该现象出在**宿主「插件更新后刷新已打开面板」的流程**（自刷新首次失败、手动重试成功）。插件侧能做的是把失败变得可读：已加入提前 ready 与未捕获错误兑底（1.5.1+）。

## 1.5.3

- **修复「可用余额」卡片鼠标移入提示覆盖不全**：原先提示错点只挂在卡片的「标签文字」与「金额数字」两处，卡片自身的留白、行距、金额与按钮之间的空档都成了盲区。现改为把 `data-tip` 挂在**卡片根节点**，整张卡任意位置悬停均会触发。
  - 卡片内「充值/赠送拆分」与「赠送有效期 ⓘ」保留各自的专属文案（悬停到它们时显示更具体的那条）。
  - 提示框仍永远贴在卡片外侧（卡片下方或上方），不会压住同卡数字；箭头指向悬停元素中心。

## 1.5.2

**修一个真实的严重问题：插件重装后共享层不生效，导致面板脚本抛错、连 ready 都发不出去**（宿主表现为「加载失败」）。

- 根因：`routes/*.js` 用静态 `import` 引 `lib/ui-shared.js`。插件重装时 routes 会被重新加载，但该静态 import 命中的是**服务进程里已缓存的旧模块**，于是出现「routes 是新版、lib 还是旧版」的错位；新版面板调用旧版没有的方法时抛 `TypeError`，初始化中断，`ready` 发不出。
- 修法一（根治）：改为带时间戳的动态 import —— `await import('../lib/ui-shared.js?v=' + Date.now())`，每次插件重新加载都拿到最新共享层。
- 修法二（防御）：面板侧对新增方法加 `typeof` 判断，版本错位时降级为「无兜底」而不是直接报错。
- 教训记录：**任何被 routes 静态引用的插件内部模块，在重装时都可能拿到旧缓存**；跨文件共享只能靠「动态 import + 缓存击穿」或「渲染时读文件」。

## 1.5.1

针对真机上可能出现的「加载失败 / 重试」做三处加固（纯增益，不改可见行为）：

- **ready 提前发**：宿主以 `ready` 信号判定面板是否加载成功。原先在初始化末尾才发，只要初始化中途抛异常，宿主就会判成加载失败。现在由共享层在执行末尾立即发一次（早于各面板自身逻辑），面板就绪后再发一次。
- **未捕获错误兜底**：两个面板均安装 `error` / `unhandledrejection` 监听，把「白屏 + 宿主报加载失败」变成面板内看得见的一行提示（并写入 console）；过滤 `AbortError` 与网络类失败（这两类已有降级处理），同类错误只报第一条避免刷屏。
- **自检新增宿主通道检查**：`tests/run-all.mjs` 新增第 6 节，直接走 `iframe-ticket` 取 `/page`、`/widget`，断言 HTTP 200、共享层注入、弹窗节点顺序、内联脚本可编译；宿主未运行时自动跳过。

排查依据：渲染进程日志位于 `%USERPROFILE%/.hanako/diagnostics/desktop-launch/renderer.log`，但它只采集主窗口的 console，**插件 iframe 内部的报错不在其中**，因此错误兜底的可见提示尤为重要。

## 1.5.0

本轮为结构重构（对外可见行为不变，接口输出已用固定区间校对过）。

- **抽出共享层 `lib/ui-shared.js`**：把两个面板重复的字体与重置样式、弹窗（样式 + 节点 + 控制逻辑）与 13 个宿主通信/转义/时区工具收进单一源，由 `routes/page.js`、`routes/widget.js` 渲染时注入。
  - 之所以不用静态 `assets/`：实测宿主不对外提供插件 assets 目录（`GET /api/plugins/<id>/assets/*` 返回 403），而新建“只为发静态文件”的自定义路由不符合 SDK 约定，故采用服务端注入。
- **抽出 `lib/pricing.js`**：价目表、模型名归并、高峰判定、token 口径、取整等纯函数；`balance.js` 内只留一层读配置的包装。
- **抽出 `lib/export-csv.js`**：路径校验、区间白名单、文件名生成、CSV 字段转义。
- **新增 `tests/run-all.mjs`**：47 项自检，覆盖模块可加载性、内联脚本语法（模板转义陷阱）、计价格式、导出安全规则与共享层完整性；完整跑一遍约 1 秒。
- **统一时区显示名**：原先侧栏用 `GMT+5:30`、详情页用 `GMT+5.5`，现统一为前者（只影响非整小时时区）。
- 清理配置里 4 个历史版本遗留键（`costOffset`、`rechargePromptEnabled`、`lastRechargeInferred`、`lastRechargeAt`）；清理前已备份 `config.json`。
- 重构验证：核心区域逐字节比对与旧版一致（stats 聚合区、事件确认区 SHA256 完全相同）；接口 `prices`、`calibration` 一致，模型分面 v4-pro 数值未变。

## 1.4.1

- 字体栈补上中文族名 `鸿蒙黑体`。本机安装的字体在 Windows 里注册的族名是中文 `鸿蒙黑体`（英文名 `HarmonyOS Sans SC`），原先只声明英文名，在中文族名生效的场景下会漏掉。
- 实测记录：本机已安装 `HarmonyOS_Sans_SC.ttf`（族名 `HarmonyOS Sans SC` / `鸿蒙黑体`，**字重 400 Regular**）。声明目标是 500 Medium，若想让字重真正落在 Medium 面而非浏览器合成，安装官方 Medium 字面即可自动生效（族名相同，`font-weight: 500` 会直接命中）。

## 1.4.0

- 字体治理：全局字体栈统一为 `HarmonyOS Sans SC Medium → HarmonyOS Sans SC → 鸿蒙黑体 → HarmonyOS Sans → Microsoft YaHei → PingFang SC`，字重统一 500，层级只用字号与颜色区分。
  - 补上表单控件（`input/select/textarea`）的字体与字重继承，此前输入框会掉回浏览器默认字体。
  - 补上 `b/strong` 全局 500 与 `svg text` 显式继承，避免浏览器默认加粗破坏字重层级。
- 命名纠正：侧栏模板常量 `PAGE_HTML` → `WIDGET_HTML`（原名称与详情页混同）。
- 常量提取：导出相关的魔法数字改为具名常量（`HOST_TIMEOUT_MS`、`EXPORT_MODAL_MS`）。
- 新增本变更记录，并随发布包一同分发。

## 1.3.0

- 「去设置」由卡片内一行小字改为弹窗：标题、修改路径、当前预警阈值/提示间隔/自动刷新三项现值。
- 导出成功由页内提示条改为弹窗：绿勾 + 文件名，5 秒自动收起。
- 弹窗支持「知道了」、点遮罩、Esc 三种关闭方式，连点不叠加；`position: fixed` 不影响面板高度上报。
- 修复：弹窗静态节点原先位于 `<script>` 之后，脚本初始化取不到节点导致点击无响应；已移至脚本之前。

## 1.2.3

- 导出成功后给出可见回执：`导出成功：<文件名>`，5 秒自动消失。

## 1.2.2

- 导出改为真实文件落盘：点「导出 CSV」弹出系统目录选择框，文件写入所选目录，命名 `deepseek-usage-<区间>-<年月日-时分秒>.csv`，UTF-8 带 BOM（Excel 直开中文不乱码）。
- 能力声明改为 `resource.write` + `resource.pick`，移除 `clipboard.writeText`。
- 修复：原先用 `ctx.resources.read` 判断文件是否已存在，该操作需 `resource.read` 能力、未声明时静默抛错，检查恒为「不存在」，同名导出会互相覆盖；改为文件名自带秒级时间戳，从构造上不重名。
- 路径校验：只接受绝对路径，区间标识走白名单，文件名完全由服务端生成；CSV 字段做公式注入硬化（前导 `= + - @` 前置单引号）。

## 1.1.0

- 新增导出 CSV（当时经剪贴板落地）：区间/时区/校准系数 + 每个「时间 × 模型」一行 + 合计行。
- 新增按模型细分口径：金额构成（命中/未命中/输出 + 其中高峰占比）。
- 新增赠金有效期提示：赠送余额旁 ⓘ 图标，悬停说明有效期与查看位置。

## 1.0.0

- 侧边栏四张数字卡 + 今日用量迷你图，余额预警，充值/退款/赠金事件确认与一键修正。
- 用量详情页：三张总览卡、按小时/天堆叠柱图、按模型分面、时间维度筛选器、双月日历、API Key 药丸、页脚口径说明。
- 时区切换菜单（侧栏「⋯」）与跨面板联动（BroadcastChannel + 轮询兜底）。
- 性能：账本读取与统计结果短 TTL 缓存，统计跨度上限 400 天/400 桶。
- 安全：模型名与脱敏 key 统一转义，iframe 加 CSP，API Key 不下发前端。
