# deepseek-balance（Hana 插件）

在 Hana 侧边栏与用量详情页里查看 DeepSeek 余额与本机用量，并可把统计导出成 CSV。

## 简介（第一次看到这个插件的人看这里）

> 本节面向**使用者**；自「口径（重要）」起的后半部分是**工程/维护文档**。

**这是什么**：一个 Hana 客户端插件，把 DeepSeek 账户的**可用余额**与**本机用量**放进 Hana 的侧边栏与用量详情页，并能导入官方导出的账单数据（`cost-*.csv` / `amount-*.csv` / `usage_data_*.zip`）**同步**为权威口径。

**主要能力**

- **余额与构成**：可用余额 = 充值余额 + 赠送余额（赠送优先扣减）；充值/退款/赠金由余额跳变**自动入账**。
- **今日消费额**：侧栏迷你柱图（按小时金额，空闲/高峰双色）。
- **详情页统计与双口径**：按小时/天/周/月的堆叠柱图 + 按模型分面；金额既有 **token 估算**，也有**余额差**旁证，并给出两者偏离。
- **官方数据同步**：导入官方导出的账单（`cost-*.csv` / `amount-*.csv` / `usage_data_*.zip`），按北京日聚合后作为**权威口径**写回侧栏累计与详情页「全部」区间；官方覆盖窗口内的本机记录不再重复计数。
- **历史基准补正**：设置里可填「请求数基准」「Tokens 基准」（整数），把重装/换机后本地账本清零前的历史累计补回来，只计入「全部」区间。
- **低余额预警**：跌破阈值推一次（工具 + 桌面通知，可关）；持续低于不重推，回升后再跌破会重新推。
- **用量归档**：宿主账本有 5000 条硬上限，插件自己接住滚出的记录（上限 20000），「全部」区间可跨过 5000。
- **导出 CSV**：详情页把当前筛选的统计导出到自选目录。

**平台**：**单包通用（Windows / macOS / Linux）**。插件本体平台无关（`routes/`+`lib/`+`tools/`+`manifest.json` 无盘符、无 shell 调用、无 `process.platform`，文件名全小写）；只有开发侧的发布脚本按平台选择打包命令（见「发布」）。

**安装**

1. **拖入安装**：把 `deepseek-balance-<版本>.zip`（或源码文件夹）拖进 **设置 → 插件**。
2. **授予全权信任**：本插件注册了**路由、详情页、侧栏 Widget** 等高级功能（清单已声明 `trust: full-access`）⇒ 必须以 **Full-access（全权）** 方式启用；受限（`Restricted`）安装会显示已装但面板与路由不生效。
3. **装后自检**：在 **设置 → 插件** 里确认状态为 **`loaded`**；面板应出现侧栏「可用余额」卡片与「用量详情」页。

> 装了却不生效？先看 `status` 是否为 `loaded`，再看权限是否为全权 —— `Restricted` 插件的高级功能（routes/hooks）需要全权信任才能生效。

**数据与隐私**

- **全部本机**：余额查询只发往官方 `api.deepseek.com`，不经第三方；用量完全读自本机账本。数据默认在用户主目录的 `.hanako/`（可用 `HANA_HOME` 环境变量覆盖）。
- **不上传**：不向任何第三方上传你的数据（实测：代码里发出的网络请求只到 `api.deepseek.com` 与 `api-docs.deepseek.com`，均官方；充值按钮是让宿主 `openExternal` 打开 `platform.deepseek.com`，属浏览器跳转，不经插件发请求）。
- **API Key**：只存本机配置；`/api/client-error` 与 `GET /api/diagnostics` **都绝不读取、绝不记录 apiKey**，日志写入会做 `sk-***` 脱敏。
- **诊断日志**：只写本机 `plugin-data` 目录，写满 512KB 轮转（只留上一份）。

**工程指标**

- **零依赖**：无 npm 依赖、无构建步骤（只用宿主自带 Node 运行）。
- **自检 742 项**：`tests/run-all.mjs` 一条命令跑完整套（覆盖计价口径、存储硬化、可访问性、官方数据同步、跨平台打包守卫等）；其中 11 项是**宿主通道检查**（需要宿主在运行），宿主没跑会自动跳过。

License: MIT（见 `LICENSE`）

**截图**

> （占位）本仓库暂未包含界面截图。侧栏为四张数字卡 + 今日消费额迷你图；详情页为堆叠柱图 + 按模型分面 + 官方数据同步面板。待作者补图后替换本段。

---

## 功能

- **侧边栏**：可用余额（充值/赠送拆分）、累计消费金额、API 请求次数、Tokens 四张数字卡，外加**今日消费金额迷你图**（按小时金额、X 轴刻度随日类型变化、高峰窗口整点标胭脂红、柱悬停双口径提示）；余额预警、充值/退款/赠金**自动入账**与弹窗提示（充值/赠送/退款的提示**常驻直到被关闭**：点 × 或点弹窗外部）。
- **用量详情页**：总览卡、按小时/天堆叠柱图、按模型分面（含金额构成）、时间维度筛选（今天/昨天/近 7 天/近 30 天/本月/上月/自定义双月日历）、导出 CSV。
- **时区切换**（侧栏「⋯」）：影响图表的日期/时段划分，不影响高峰价判定。

## 口径（重要）

| 项 | 口径 |
|---|---|
| 累计消费金额 | 累计充值 − 累计退款 − 当前充值余额（自有资金净支出） |
| 可用余额 | 官方接口 `total_balance` = 充值余额 + 赠送余额；赠送余额优先扣减且有有效期 |
| 请求次数 / Tokens | 来自 Hana 本机账本，**只覆盖这台机器发出的请求**（别的客户端共用同一个 key 不会计入） |
| 金额估算（主口径） | token × 官方价目表单价 × 高峰倍数 × 校准系数（**默认 1**；已与官方账单逐小时核对，不再需要拟合系数） |
| 高峰时段 | 北京时间周一至周五 9:00-12:00、14:00-18:00，单价 2 倍；**不含中国法定节假日**（已内置 2026 年安排，可用 `holidayDates` 补充）；判定始终按北京时间，与展示时区无关。内置表只覆盖 2026 年：未覆盖年份仍按星期规则计，但详情页会给出「相关时段金额可能高估约 2×」的可见告示（不静默） |
| 充值/退款/赠金 | **自动入账**：充值 → 累计充值；退款 → 累计退款；赠金 → 仅记录。值由余额跳变反推（可能略小），事后可在设置里手工校正。**退款方向带采样间隔守卫**：上次成功采样距今超过 30 分钟（或缺失，升级后首次）时不判退款、只前移基线，避免长窗口里的自有资金消费被误记；充值/赠金为上调，不受此限。累计值写入失败时不推进基线、下次轮询自动重试，事件提示会标注「累计未落盘」；同一跳变在 15 分钟内不会重复入账 |
| 余额差口径（旁证） | `state.json` 的小时级余额样本：某小时消费 = 该小时末样本 − 上一小时末样本，只取正数；该小时内检测到入账事件则视为「事件时段」不计差。**仅作交叉验证**：官方余额只有两位小数，样本不足或 |余额差| < ¥0.05 时不报百分比，显示「分辨率不足」 |
| token 口径（主） | 即上面的「金额估算」；侧栏迷你柱悬停以 token 估算为主、余额差为旁证，并给出**偏离** = `(token 估算 − 余额差) / 余额差 × 100`，任一缺失显示「—」 |

## 配置

| 键 | 说明 |
|---|---|
| `apiKey` | 仅保存在本机，只用于请求官方余额接口；请求次数与 Tokens 来自本机账本，无需配置 |
| `refreshIntervalSeconds` | 侧边栏自动刷新间隔（秒），默认 60，0 表示关闭 |
| `alertThreshold` | 余额预警阈值（元），0 表示关闭预警 |
| `alertNotify` | 「余额不足时允许推送通知」，默认开；关闭后余额预警**不再主动推送**（侧栏会显示「推送已关闭」），侧栏状态与工具判定仍在 |
| `eventPromptEnabled` | 是否在侧栏弹出充值/退款/赠金的信息性提示，默认开；关闭后累计数仍自动维护，只是不弹提示 |
| `costCalibration` | 金额估算校准系数，**默认 1**（token 估算已与官方账单核对，通常无需修改） |
| `timezoneOffsetMinutes` | 展示时区（分钟），-1 表示跟随本机 |
| `priceOverrides` | 单价覆盖表，每行 `型号或前缀*=命中/未命中/输出`；留空用内置价目表 |
| `holidayDates` | 额外节假日（`YYYY-MM-DD`，逗号/换行分隔），在插件内置的 2026 年法定节假日之外补充「按空闲计价」的日子 |
| `totalRecharged` / `totalRefunded` | 累计充值 / 累计退款，可随时手工校正（自动入账的推断值不准确时） |

> **推送语义**：余额**跌破阈值那一刻推一次**，持续低于不再重推，回升后再次跌破会重新推。原先的「预警提示间隔（分钟）」配置项（`alertCooldownMinutes`）已移除：它不再影响推送节奏，也不再出现在设置界面与 `/api/config` 里；`state.json` 里的 `lastAlertPushAt` 仅记录本次跌破的推送时间，不参与节奏计算。
>
> 余额基准与待确认事件等**运行状态不在这里**，它们存在插件自有目录的 `state.json`（`ctx.dataDir`）。旧版本写在配置里的那几个「内部字段」会在首次运行时自动迁移过去。

### 微信（或飞书 / 钉钉 / Telegram / QQ）定时推送：怎么接

插件**推不出微信** —— 插件总线里没有 `notify.send`，桥接通道也不对插件开放。所以这条链拆成两步：**插件只判定**（工具 `deepseek-balance_deepseek_balance_alert` 返回「是否该推 + 一条可直接转发的文本」），**投递交给宿主**（定时任务的 Agent 调 `notify`）。

完整的接入说明（前置条件、cron 表达式、两步 prompt、换平台、排错）见 [`integrations/wechat-alert.md`](integrations/wechat-alert.md)；可直接复制的任务模板见 [`integrations/wechat-alert.cron.json`](integrations/wechat-alert.cron.json)。要点：

- **定时任务不在插件包里**：它是宿主侧的一条自动化（cron `0 * * * *`，每小时采样一次）；装在插件里的是工具，调度与投递都在宿主那边。
- **采样频率 ≠ 推送频率**：工具内部有状态机，只在「跌破阈值那一刻」推一次，持续低于不重推，回升后再跌破重新推 —— 所以每小时跑一次不会刷屏。
- 投递参数：`channels: ["bridge_owner"]` + `bridgePlatforms: ["wechat"]`（换成 `feishu` / `dingtalk` / `telegram` / `qq` 即可改平台，加 `"desktop"` 可同时发桌面通知）。

## 已知现象

### 更新插件后，已打开的面板可能首次显示「加载失败」，点「重试」即恢复

- **属于宿主「插件更新后自动刷新面板」的时序，不是插件问题。**
- 实测依据（2026-09-24）：
  - 重装前取得的 iframe ticket，在重装后继续使用仍返回 **HTTP 200**（凭证未失效）；
  - 重装全程并发请求面板 **38 次全部 200**，其中 10 次落在安装进行中（无不可用窗口）；
  - 同期服务端日志显示插件每次加载 7～9ms，**无 error**。
- **判别法**（1.5.1 之后均适用）：
  - 失败画面**只有「加载失败/重试」、面板内没有任何红字** → 宿主刷新时序，点重试即可；
  - 失败画面**面板内出现一行红字** → 插件问题，请把那一行反馈给作者，可直接定位。
- 该现象已整理成复现报告并在向 Hana 反馈中；在修复前，**请以「点一次重试」作为既定操作**。

## 账本口径与已知缺口（重要）

本插件的用量全部来自宿主账本（总线 `usage:list` → `~/.hanako/usage-ledger.json`），因此**账本有什么、插件就只能看到什么**。两条已经查清的缺口，性质不同：

**1）宿主只在「消息带 usage」时记账 ⇒ 少数请求会整条缺失（插件无法修）**

宿主 bundle（`lib/llm/usage-ledger.ts`，实现在 `Znt(...)`）的记账点只有两个，逻辑相同：

```js
if (t.message?.usage) return ledger.record({ model, usage: t.message.usage, usageContext, costRates });
const err = 取错误文本(t);
if (err) { const d = ledger.start({...}); return ledger.recordError(d.requestId, new Error(err)); }
return null;   // ← 无 usage、又无 error ⇒ 一条都不记
```

即：**响应消息没带 `usage`、又不算错误**的调用（被取消/被停而 usage 块未到达、响应被丢弃、进程退出时的在飞请求等），宿主不会落任何记录；这些调用在官方侧照样计费。

- **实测证据（2026-09-27）**：官方 vs 宿主逐小时比对，今日共缺 **14 条**（04:00 −1、13:00 −4、14:00 −4、15:00 −1、20:00 −4）；20:00 缺的 4 条 token 特征为 `hit 0 / miss ≈39 万/条 / out ≈2.5 千/条`（与同小时已记录的那几条 `subagent/run` 同型）。
- **反证“不是记账后被丢弃”**：账本 `requestId` 的计数器后缀在**每个纪元（= 宿主重启）内连续无缺口**（19/20 个纪元零缺口；唯一缺口是容量上限挤掉的最老一段）。⇒ 缺失的请求**根本没调用过 `start()`**，不是 finish 被丢。
- **反证“不是插件读得少”**：`list()` 不传过滤、`limit: 100000`，4935 条全部返回；插件侧无截断/去重。
- **插件侧无法修**（不改宿主 bundle）；官方导出已从逐小时粒度改为**按日粒度**，因此无法再把漏记定位到具体小时；但按日仍可与官方同步（官方覆盖的日以官方为准），详见下文「官方数据同步」。
- **另一种同样会缺的来源**：同一个 key 在 Hana 之外被别的客户端/脚本用过——官方计费、宿主不记。详情页页脚已声明这条边界（“只覆盖这台机器上发出的请求”）。

**2）宿主账本有 5000 条上限 ⇒ 更早的记录会被滚出（插件可可靠自查，已加提示）**

宿主 `Znt` 默认 `maxEntries = 5000`（`Xnt = 5e3`），超出即 `o.shift()` 丢掉最老的一条。实测本机账本正好停在 5000 条、最早只到几天前。`/api/stats` 会回报 `ledger.{entries,maxEntries,truncated,oldestAt}`，详情页页脚在 `truncated` 时显示「账本容量」一行。这是插件能可靠判定的缺口（计数 + 上限都是可观测的）；**其余类型（如上面的漏记）不做告警**。

## 用量归档（突破宿主 5000 上限）

宿主 `usage-ledger.json` 有**硬上限 5000 条**，超出即丢最旧的 —— 插件的「全部」区间会被卡在 5000。插件改不了宿主，但**自己接住**滚出去的记录：

- 每次读到宿主账本后，按 `requestId` 去重并进 `plugin-data/deepseek-balance/usage-archive.json`（**原子写** tmp+rename；首次以当前账本为种子）；
- `/api/usage`、`/api/stats`、官方数据同步都读「宿主账本 ∪ 归档」，因此区间能**跨过 5000**，「全部」的请求数自归档起持续增长；
- 归档只保留聚合所需字段（`requestId`/`startedAt`/`model`/`usage`），**丢弃** `attribution`/`metadata`/`sessionPath` 等；
- 归档自身也有上限 **20000** 条，到顶丢最旧；到顶时详情页页脚「用量归档」一行会标注；
- 详情页页脚与「账本容量」并列显示归档条数 / 上限 / 最早一条时间。

**它接不住什么**：宿主**漏记**（响应无 `usage` 且非错误）的调用本地从无记录，归档也接不住 —— 这正是「导入官方数据同步」能补上的缺口（官方覆盖的日以官方为准）。

## 导入官方数据同步

详情页「导入官方 CSV 同步」→ 选官方导出的 `usage_data_*.zip`（内含 `cost-*.csv` 与 `amount-*.csv`）或单个 `cost-*.csv` / `amount-*.csv` → 就地出同步面板并把官方数据写为权威口径。文件在**本机 iframe 内读取、不上传**（前端读成 base64 传后端，后端用 `node:zlib` 解压，上限 24MB）。

**官方数据按北京日聚合后回写**：
- **官方日账本最权威**：官方覆盖的每一天，请求数 / Tokens / 消费额直接采用官方值；
- **去重**：本机账本落在官方覆盖窗口内的记录不再重复计数（面板会给出被剔除条数）；
- **缺金额时回推**：只导入了 `amount-*.csv` 而没有 `cost` 表时，金额由 `price × amount` 回推，只在面板标「估算」；
- **金额只认 CNY**：其它币种行忽略并计数。

**看到什么**：头部（区间（北京日）、天数、行数、覆盖到什么时候、文件名）；合计（请求数 / Tokens / 金额）；逐日表（日期 × 型号 × 金额，按金额降序）；本机记录被官方覆盖剔除了几条。

**粒度会跟着官方走**：官方只给「按日」汇总，拆不回小时。所以**只要查询窗口与官方覆盖日相交，图表就按「天」呈现**（今天 / 昨天 / 自定义 1~2 天会从按小时升到按天，官方日值直接成为柱子，柱合计 = 合计值）；没被官方覆盖的短窗口仍按小时。代价：**「高峰时段金额」拆不出来**（它只能由本机小时级记录推出）——这类区间副标题会写「官方按日汇总，不可分」，而不是亮一个误导性的 ¥0；部分本机、部分官方时补「仅本机记录」。

**历史基准补正**：重装或换机后本机账本清零，设置里的「请求数基准」「Tokens 基准」（整数，默认 0）可把清零前的历史累计补回来。它属于「全部」口径，不污染区间（今天/近 7 天…）。**只在「比官方最早导入日还早」的用量上才有意义**：若你导出官方数据时选的起始日已覆盖全部历史，这两项留 0 即可，不影响任何计算。

**持久化**：只把**聚合结果**（区间、每日×型号的请求数/Tokens/金额、覆盖时刻、行数）写进 `state.json` 的 `officialSync`；**原始 CSV / zip 不落盘**，`user_id`、`api_key`、`api_key_name` 不显示、不记录、不进聚合。文件名里的 `sk-` 会脱敏。

**同步后的口径**：侧栏「今日消费额」优先用官方覆盖到当日的金额（未覆盖时回退余额差口径）；详情页「全部」区间把官方日值与本机账本拼接（官方窗口外用本机），基准值也只在「全部」计入。

## evAmt 端到端验证（等下次真实充值）

余额差口径对「事件小时」（充值/退款/赠金）不再整块丢弃，而是用 `消费 = 首样本 − 末样本 + 充值 − 退款 + 赠金` 还原；入账额来自样本上的 `evAmt`，由 `recordSample` 在**记账那一刻**按实际入账额累加（充值已按整元吸附）。它与「事后拿官方值反推」无关，是一条可独立验证的路径。

> **命令怎么读（跨平台）**：下面所有命令都需让宿主二进制以 Node 模式运行 —— Windows 用 `$env:ELECTRON_RUN_AS_NODE="1"`，macOS/Linux 用 `ELECTRON_RUN_AS_NODE=1`。宿主二进制路径统一写作 `$env:HANA`（PowerShell）/ `"$HANA"`（bash）：Windows 通常为 `C:\Program Files\HanaAgent\HanaAgent.exe`，macOS/Linux 用你的安装位置。插件数据目录：Windows `%USERPROFILE%\.hanako\plugin-data\deepseek-balance\`，macOS/Linux `~/.hanako/plugin-data/deepseek-balance/`（默认都在用户主目录的 `.hanako/` 下，可用 `HANA_HOME` 环境变量覆盖）。

```powershell
# Windows PowerShell
# 1) 合成样本验证三分支（充值/退款/赠金）计算正确——随时可跑
$env:ELECTRON_RUN_AS_NODE="1"; & $env:HANA scripts/verify-evamt.mjs --selftest
# 2) 真实数据：逐条列出带 evAmt 的事件小时（首末样本 + 入账额 + 还原值 + token 估算）
$env:ELECTRON_RUN_AS_NODE="1"; & $env:HANA scripts/verify-evamt.mjs
# 3) 附官方对照（传官方 cost CSV）
$env:ELECTRON_RUN_AS_NODE="1"; & $env:HANA scripts/verify-evamt.mjs --official <cost-YYYY-MM-DD_YYYY-MM-DD.csv>
```

```bash
# macOS / Linux（在插件根目录下执行）
# 1) 合成样本验证三分支（充值/退款/赠金）计算正确——随时可跑
ELECTRON_RUN_AS_NODE=1 "$HANA" scripts/verify-evamt.mjs --selftest
# 2) 真实数据：逐条列出带 evAmt 的事件小时（首末样本 + 入账额 + 还原值 + token 估算）
ELECTRON_RUN_AS_NODE=1 "$HANA" scripts/verify-evamt.mjs
# 3) 附官方对照（传官方 cost CSV）
ELECTRON_RUN_AS_NODE=1 "$HANA" scripts/verify-evamt.mjs --official <cost-YYYY-MM-DD_YYYY-MM-DD.csv>
```

可选参数：`--state <path>`（默认 `~/.hanako/plugin-data/deepseek-balance/state.json`）、`--ledger <path>`（默认 `~/.hanako/usage-ledger.json`）、`--tz <minutes>`（默认 480）、`--json`。

**预期输出**：尚无 evAmt 样本时输出「暂无 evAmt 样本（等下次真实充值）」并退出 0（**不是错误**）；有 evAmt 时逐小时给出三行对照（入账额 / 还原值 / token 估算 / 官方对照）。历史样本只带 `ev` 标记、不带 `evAmt`，按实现回落 `null`（不臆测）。

## 自动刷新机制

- 默认每 **60 秒**轮询一次余额（设置里改 `refreshIntervalSeconds`，0 表示关闭）。
- 本机用量每 **12 秒**比对一次，用量数字一变化就立即刷新，不必等满一个周期。
- 窗口不可见时放宽到至少 5 分钟一次，重新可见时立即补刷。
- 看门狗：若「距上次成功更新」超过 2 个刷新周期（下限 2 分钟），强制补一次。
- **时钟健壮性**：缓存 TTL 与看门狗都走**单调时钟**（`performance.now()`）—— 系统对时/回拨不会让缓存永久不生效或看门狗失灵。
- **价格同步节奏**：成功 12 小时刷新一次；**同步失败只等 10 分钟**就重试（不会把重试压到 12 小时后）。
- 改设置后无需重开面板，约 1 分钟内生效。

## 刷新与缓存时序

| 项 | 值 | 说明 |
|---|---|---|
| 余额请求缓存 | 3s | 合并同秒内的并发轮询（single-flight），避免打爆上游 |
| 账本读缓存 | 3s | `/api/stats` 与 `/api/usage` 共用的账本读取 |
| stats 聚合缓存 | 3s | 同一组筛选条件（区间/时区/校准/节假日）复用结果 |
| usage 计数缓存 | 20s | 侧栏心跳每 12s 调一次，计数不需要 12s 级新鲜 |
| 价格同步 | 成功 **12h** / 失败 **10min** | 失败不把重试压到 12 小时后 |
| 余额样本保留 | 30 天 / 最多 800 条 | `state.json` 的小时级样本 |
| `usage:list` 超时 | 8s | 宿主 bus 挂住时不无限等待 |
| 侧栏心跳 | 12s | 本机用量变化即时触发刷新、看门狗兜底、配置变化感知 |
| 看门狗 | 2 个刷新周期（下限 2min） | 定时器失准时强制补一次 |
| 隐藏时暂停 | 至少 5min 一次 | 窗口不可见时放宽；重新可见立即补刷 |
| `diagnostics.log` 轮转 | 512KB → `diagnostics.1.log` | 只保留上一份，永不无限增长 |

> 所有 TTL 与看门狗都用**单调时钟**（`performance.now()`），系统对时/回拨不会让缓存永久不生效。
>
> **「今日」窗口随展示时区平移**：`resolveTzMinutes` / `pickTzMinutes` 决定「今天」的起点（`480` → 北京 **00:00**；`0` → 北京 **08:00** 起，即 UTC 日界）。时区菜单含**两项**：「跟随本机（本机偏移）」与「UTC+0」，当前项有勾选；存储的偏移若等于本机偏移，也高亮「跟随本机」。普通时区行照实显示当前偏移。

## 预警投递链

```
定时任务 → deepseek_balance_alert（只判定） → notify(微信等) → 失败则改走 desktop 通知
                                                     ↓
                                          失败必须回报、不许静默
```

- 插件**不能直接推微信**（总线无 `notify.send`）：工具只负责「是否该推 + 可转发的文本」，投递由定时任务的 Agent 调宿主 `notify` 完成。
- 工具返回 `due=true` 时，Agent 应把 `text` **原文**发给用户；`notify` 失败时必须**如实回报失败并改走桌面通知**，不许静默吞掉。
- **如何确认这条链活着**：查 `plugin-data\deepseek-balance\diagnostics.log`（或 `GET /api/diagnostics`）里的 `[tool] decision: alerting=… due=… reason=…` 行 —— 每条调度都会留一行；`reason=entered_alert` 表示本轮已推过一次，`bucket_*` 表示状态写盘失败已降级为整点桶。
- **状态写入互不覆盖**：路由落盘**只写它自己这次改过的键**（`dirtyKeys`），工具写的 `alertState`/`lastAlertPushAt` 原样保留 —— 否则路由会把工具的状态抹回、导致每轮重复推送（1.14.35 修复）。

## 诊断入口

- **插件自有诊断日志（首选）**：`~/.hanako/plugin-data/deepseek-balance/diagnostics.log`（Windows：`%USERPROFILE%\.hanako\plugin-data\deepseek-balance\diagnostics.log`）
  - 面板异常、工具判定、路由告警都会写到这里；尺寸超 **512KB** 轮转为 `diagnostics.1.log`（只保留上一份）。
  - 不必翻文件：`GET /api/plugins/deepseek-balance/api/diagnostics?tail=200`（本机只读，tail 上限 500）。调用（把 `<宿主地址>` 换成 Hana 的本机地址）—— macOS/Linux `curl -s "<宿主地址>/api/plugins/deepseek-balance/api/diagnostics?tail=200"`；Windows PowerShell `Invoke-RestMethod "<宿主地址>/api/plugins/deepseek-balance/api/diagnostics?tail=200"`。
- 渲染进程日志：`~/.hanako/diagnostics/desktop-launch/renderer.log`（Windows：`%USERPROFILE%\.hanako\diagnostics\desktop-launch\renderer.log`）（只采集主窗口 console，**插件 iframe 内部的报错不在其中**）。
- 宿主服务端日志：`~/.hanako/logs/*.log`（Windows：`%USERPROFILE%\.hanako\logs\*.log`）（含**宿主**加载插件的耗时与 error；**不含插件自己的 `ctx.log` 消息**）。
- 插件诊断：`GET /api/plugins/diagnostics`（查看 status / error / uiHostCapabilities）。
- 说明：插件的 `ctx.log` 会被并进**调用方 Agent 的会话记录**（`sessions\*.jsonl`）—— 那是给 Agent/排查用的，**不是给用户看的**；用户取证请看上面的 `diagnostics.log`。

## 面板报错怎么取证

侧栏/详情页里出现红字或白屏时，按这个顺序取证：

1. **先看面板里那一行红字**：错误框**可选中复制**，且带一个短错误码（形如 `E123AB`）。把「错误码 + 原文」一起反馈，能直接定位。
2. **插件诊断日志**（`~/.hanako/plugin-data/deepseek-balance/diagnostics.log`；Windows：`%USERPROFILE%\.hanako\plugin-data\deepseek-balance\diagnostics.log`）：面板异常会通过 `POST /api/client-error` 写到这里，格式为 `<ISO+08:00> WARN [client] client error [<错误码>] <原文>`。**一条命令读回**：`GET /api/plugins/deepseek-balance/api/diagnostics?tail=200`（本机只读，tail 上限 500）—— macOS/Linux 用 `curl`，Windows PowerShell 用 `Invoke-RestMethod`（均需拼上 `<宿主地址>`）；写满 512KB 会轮转为 `diagnostics.1.log`。
3. **渲染进程日志**（`.hanako\diagnostics\desktop-launch\renderer.log`）：只含主窗口 console，**插件 iframe 内部的报错不在其中**（这正是本插件要自己回传的原因）。
4. **失败画面怎么判**：只有「加载失败 / 重试」、面板内没有任何红字 → 宿主刷新时序，点一次重试；面板内出现红字（含错误码）→ 插件问题，把那一行反馈给作者。

> 安全：`/api/client-error` 与 `GET /api/diagnostics` 都按**不可信输入**处理 —— 写：只接受字符串、限长 2KB、剥离控制字符、`sk-***` 兜底脱敏、不回显；读：逐行再脱敏、tail 上限 500。**两者都绝不读取也绝不记录 apiKey**。

## TOP5 排查手册（现象 → 一步操作 → 判读）

| # | 现象 | 一步操作 | 判读标准 |
|---|---|---|---|
| 1 | 面板加载失败 / 白屏 | 看面板内是否有红字；再看 `diagnostics.log`（或 `GET /api/diagnostics`）里有无 `client error [...]` | 无红字 → 宿主刷新时序，点「重试」即恢复；有红字/错误码 → 插件问题，把该行反馈 |
| 2 | 余额或用量数字停更 | 看「更新于」时间戳与标题左侧状态点（绿=正常/红=失败） | 时间戳不动且点变红 → 上游/网络问题，看 `diagnostics.log` 里 `upstream ...`；点仍绿但数字不动 → 间隔设成了 0（关自动刷新），点刷新 |
| 3 | 预警不再推 / 不确定推没推 | ① 侧栏余额卡是否显示「推送已关闭」；② 查 `diagnostics.log`（或 `GET /api/diagnostics`）里 `[tool]` 来源的 `[deepseek-balance:alert]` | `disabled` → `alertNotify` 关着或阈值 0；`entered_alert` 只出现一次且 `lastAlertPushAt` 有值 → 本轮已推过，持续 low 不重推（设计如此）；`bucket_*` → 状态写盘失败已降级为整点桶 |
| 4 | 金额/用量比官方账单偏小 | 详情页看页脚「账本容量」与顶部「单价未收录」告示 | 有「账本容量」行 → 账本满 5000 条、更早记录被滚出（设计内，「全部」区间会偏小）；有「单价未收录」→ 该型号金额未计入合计，去设置补 `priceOverrides`；都没有 → 可能同 key 在别的客户端用过（本机账本不记）或宿主漏记（见上文「账本口径与已知缺口」）|
| 5 | 导出失败 / 价格同步失败 / 上游报错 | 导出：看弹窗错误文案；价格：详情页页脚「价格同步」一行；上游：看状态点与 `diagnostics.log` | 导出 `write_failed` → 换可写目录；`too_large` → 区间太大；价格同步失败 → 仍用内置价目表（不影响估算，等下次同步）；上游 `invalid_key`/`rate_limited`/`upstream_error` → 按 `diagnostics.log` 与提示处理 |

## 回滚（三步）

1. **备份运行态**：先把 `~/.hanako/plugin-data/deepseek-balance/{state.json,config.json}`（Windows：`%USERPROFILE%\.hanako\plugin-data\deepseek-balance\{state.json,config.json}`）复制一份（回滚后要对照累计值）。
2. **重装上一版**：用 `backups/deepseek-balance-<上一版>.zip` 安装。`scripts/release.mjs` 会在每次打包**之前**自动把当时的 plugin-data 快照到 `backups/plugin-data-<id>-<版本>-<时间戳>/`，可作为「回滚前状态基线」。
3. **复核**：`GET /api/plugins/diagnostics` 确认 `status=loaded`、`error` 为空；再核对 `totalRecharged` / `totalRefunded` / 当前余额未被波及。

## 自检

```powershell
# Windows PowerShell（在插件根目录下执行）
$env:ELECTRON_RUN_AS_NODE="1"; & $env:HANA tests/run-all.mjs
```

```bash
# macOS / Linux
ELECTRON_RUN_AS_NODE=1 "$HANA" tests/run-all.mjs
```

覆盖：模块可加载性、内联脚本语法（模板字符串转义陷阱）、计价口径、导出安全规则、共享层完整性、侧栏轮询自愈（默认间隔/热重载/看门狗）、共享层调度与通道（行为级）、宿主通道加载检查（需宿主在运行）、1.12.0 增强项（自动入账/卡片改名与提示/规则句 fallback 与状态迁移/高峰判定含周末与节假日/侧栏迷你柱双口径提示/详情页还原守卫）、1.14.0 增强项（官方 00:00 行的**黄金回归**、token 口径映射、X 轴按日类型的刻度规则与高峰配色、今日消费额行金额 13px 同号（含行高对齐、顶边差 0.00）与单位间距保险做法（margin 0、不依赖字体）、通知统一为弹窗（四条共用样式/层级、提示区浮层定位（按作者偏好回退，见 1.14.43）、卡片 ≤240、不透明实色底、错误框纳入不重叠、红窗优先、触发未变）、可用性修复（红卡对比度、浮层显隐统一抑制 hover、事件弹窗 ×/外点关闭无计时器/无时间窗、提示框移出不飘与箭头不跳位（relatedTarget 闸门 + 淡出中不被重定位 + 移出保留 above 不上下翻面）、悬停意图延迟（掠过不弹）、`.event-skip` / `.event-input` / `.event-ok` 死代码清理、**充值判定门槛 5 → 1 元（退款门槛独立保持 5 元）**、**充值金额按整元吸附（2.99 → 3）**、今日消费额标签含单位（半角括号 `今日消费额(CNY)`）、宽度守卫按**卡内实测内宽 181px**重定口径（**含 4px 硬边距补偿**：可容纳 4 位整数、余量 4px，超界省略号且不挤 `?`）、汇总改余额差口径（`totals.balanceCost`；样本全缺显示 `--`）、事件小时按实际入账额还原（缺 `evAmt` 回落 `null`））、卡片标题回到 13px、余额差分辨率下限、设置弹窗结构、实际路径标签、输入框规范与无 spinner、提示浮层自适应宽度与可读字号）、已移除配置键的源码守卫（`alertCooldownMinutes` 不再出现在源码与 manifest）、**存储与入账硬化**（`stateGet` 单一化与陈旧基线不回填、退款采样间隔守卫、入账写入失败不推进基线且可重试、同源去重、预警工具原子写且只合并自身键——含 34 项静态守卫 + 合成数据行为实跑）、**口径与日历**（节假日表覆盖年份自报与未覆盖年份告示、2026 高峰判定 10 项回归、X 轴高峰刻度掩码跨时区一致且**着色与计费同源**、页脚口径措辞与价目表兜底说明——含 20 项纯函数/源码守卫 + stats 负载集成）、**体验合规**（详情页 pill 键盘可达与焦点环、「去设置」span→button 且外观/鼠标路径不变、关键提示锚点可聚焦与可访问名含要点、对比度从 CSS 变量算出并不低于 AA——含 20 项）、**上线后兜底**（预警链 ctx.log 留痕与降级留痕、`/api/client-error` 异常回传/限长/脱敏、`alertNotify` 侧栏可见、回滚三步/TOP5/区间台账——含 20 项）、**诊断日志落点纠偏**（插件自有 `diagnostics.log` + 512KB 轮转 + `GET /api/diagnostics` 读回并脱敏；路由/工具/client-error 三处共用 helper——含 17 项）、**健壮性**（上游数值护栏、单调时钟、价格失败短 TTL、取数显式超时+退避重试、整元吸附与残差告警、余额卡键盘等价——含 25 项）、**体验打磨**（reduced-motion 逐类收敛、弹窗焦点陷阱、Escape 边界、提示区零覆盖、型号变动常驻行、迷你图空态、错误文案下一步、赠金口径——含 13 项）、**代码卫生 + 文档**（标签配平、死码清理、无校验入口收紧、导出状态码语义、移除装饰控件、刷新/缓存时序与预警投递链文档——含 19 项）、**紧急热修**（state 只写脏键，路由不再覆盖工具写的 `alertState`/`lastAlertPushAt`——含 5 项）、**清尾**（详情页极长数值省略号、侧栏统计失败可见、`external.open` 降级为可复制链接、`round2/round4` 浮点边界——含 13 项）、**官方数据同步**（zip 中央目录读取 + `node:zlib` 解压、CSV 解析 BOM/CRLF/引号/缺列、北京日聚合、官方日账本权威回写、窗口内本机条目剔除、基准补正、金额微元逐位一致、`sk-` 脱敏与聚合持久化、日桶按展示时区对齐、官方覆盖区间自动提档到「按天」——含 59 项）、**第十二批修复**（充值反推 ceil、× 统一配色、浮层空内容防御、用量归档突破宿主 5000——含 18 项）、**时区加固**（菜单补回「跟随本机」、偏移≠本机醒目提示、今日窗口随 tz 平移——含 6 项）、**× 提示统一**（原生 title → 自绘 `.tip` 单例 + 动态节点绑定——含 7 项）、**toast 回归修复**（瞬时 toast 回浮层定位、常驻提示保持文档流——含 6 项）、**提示区回浮层**（按作者偏好回退：absolute 不推挤独立卡片；位移成因消失但「遮住→露出」的幽灵 hover 仍在，抑制两侧保留——1.14.43）、**× 提示方向/层级**（方向已回退为「默认朝下」——十八批 popup→above 是误诊；真因是 `#tip` z-index 20 低于浮层 40，已提至 200——含 11 项）、**整体排查修复**（入参空值护栏 / 缓存键含 until / custom 日历校验 / Tokens 口径统一 / 详情页「全部」入口 / 归档写盘节流 / state tmp 名唯一 / evAmt 幂等 / config 缺键默认 / 红窗优先层序 / 工具声明——含 24 项）、**清尾**（注释与实现对齐 / 局部时区改按展示时区 / 桶粒度自动升档 / 未知 range 400 与 `data.until` 真实窗口末端——含 18 项）、**余额卡光标收窄**（卡体 default / 两控件显式 pointer / 卡内非控件无 pointer 来源——含 8 项）、**跨平台补齐 + 分享打包 + MIT 许可**（release.mjs 平台分支与排除清单、README 双平台命令与分享用开篇、LICENSE——含 20 项）、**打包结构热修**（1.14.49 平铺事故：暂存目录 + 结构校验——含 5 项）。当前 742 项（宿主在运行时；宿主未跑则跳过其中 11 项宿主通道检查）。

发布（备份源码 + **运行态快照** → 打 zip → 自检一条命令，先把 `manifest.json` 的 `version` 改好）：

```powershell
# Windows PowerShell（在插件根目录下执行）
$env:ELECTRON_RUN_AS_NODE="1"; & $env:HANA scripts/release.mjs
```

```bash
# macOS / Linux
ELECTRON_RUN_AS_NODE=1 "$HANA" scripts/release.mjs
```

> **打包按平台自动选命令**：三平台同一套流程 —— 先把清单（含排除项）复制进**临时暂存目录**，再以暂存目录为 cwd 压缩其顶层条目；Windows 用 PowerShell `Compress-Archive`（传目录才保留树），macOS/Linux 优先 `zip -r`，无 `zip` 回退 `python3 -m zipfile`，两者都没有则**明确报错**（不静默产出空包）。打包后**自动校验目录结构**：zip 内必须同时存在 `manifest.json` + `routes/*` + `lib/*`，且顶层不得出现平铺的 `*.js`；不满足则**删掉该 zip 并报错**。排除项（`_selfcheck-tmp.mjs` / `*.tmp` / `*.bak*` / `node_modules` / `.DS_Store`）两边一致。运行态快照 / 自检 / 版本读取一律用 `node:path` + `process.execPath`，与平台无关。

## 维护须知（改代码前必读）

1. **跨文件共享必须绕开 ESM 缓存**：`routes/*.js` 若用静态 `import` 引用插件内其他模块，插件重装后会拿到**进程里缓存的旧模块**，造成「路由是新版、模块还是旧版」错位，面板脚本会因调用不存在的方法而抛错、连 `ready` 都发不出去（宿主表现为「加载失败」）。统一改为 `await import('../lib/xxx.js?v=' + Date.now())`。
2. 改完先跑 `tests/run-all.mjs`（含内联脚本语法检查），再安装。
3. 安装前把源码备份到 `backups/deepseek-balance-<version>/`，版本号递增；装机后复核 `status=loaded`、`error` 为空、既有配置值未被波及。
4. 面板内的**静态节点必须放在 `<script>` 之前**，否则脚本初始化时取不到节点、监听绑不上。
5. 模板字符串里的正则反斜杠必须写两层（`\\/`），否则会被模板吞掉，导致页面脚本语法错误；**反引号字符会直接终止模板字符串**（注释里也不能出现），本仓库已两次踩到 —— 两者都只能靠内联脚本语法检查发现。
6. **面板的数据请求统一走共享层的 `HPU.api.fetch/url`**（与官方模板同构，内含路径规范化与 surface session 注入）。不要在新代码里自拼 `/api/plugins/{id}/`，也不要手动传 `X-Hana-Plugin-Surface-Session`。
7. **运行状态写 `state.json`（`ctx.dataDir`），不要塞回用户配置**。配置项只放用户真正会改的值，否则设置界面会堆满「内部字段」。
8. 发布用 `scripts/release.mjs`； `lib/*.js` 的导出带 JSDoc，可选跑 `npx -y typescript tsc --noEmit --allowJs --checkJs lib/*.js` 做静态校验。
9. **带「状态迁移」的版本，必须按迁移清单复核**（这是最容易安静丢数据的一步）：
   1. 装前把**插件数据目录一并备份** —— `~/.hanako/plugin-data/deepseek-balance/`（Windows：`%USERPROFILE%\.hanako\plugin-data\deepseek-balance\`）（只备源码不够，迁移读的是这里）；
   2. 装机后触发一次业务调用（如 `GET /api/balance`），确认迁移产物已生成（`state.json`）；
   3. **逐字段核对迁移产物与原配置键一一对应**（例：`state.json:lastToppedUpBalance` ↔ 旧配置 `lastToppedUpBalance`）；
   4. 核对累计值未被波及（`totalRecharged` / `totalRefunded` / 当前余额），并抽查两个面板能正常渲染数据。
   > 旧配置键**保留不删**：它们是 `state.json` 万一丢失时的迁移来源；因为已不在 manifest schema 里，设置界面不会再显示它们。
10. **版权人已确认**：`LICENSE` 首行版权人固定为 **`JinXin`**（大小写照此，勿改写）；MIT 正文其余部分不做改动。

## 目录结构

| 路径 | 作用 |
|---|---|
| `manifest.json` | 清单与配置项定义 |
| `routes/balance.js` | 余额、用量、事件确认、CSV 导出等接口 |
| `routes/widget.js` / `routes/page.js` | 侧边栏面板 / 用量详情页 |
| `lib/pricing.js` | 价目表、模型名归并、高峰判定、token 口径（纯函数，可单测） |
| `lib/holidays.js` | 中国法定节假日表（内置 2026）与高峰判定 `isPeakAt/isPeakDay`（纯函数） |
| `lib/balance-samples.js` | 余额差口径的小时级样本与双口径偏离（纯函数） |
| `lib/export-csv.js` | 导出路径校验、区间白名单、文件名生成、CSV 字段转义（纯函数） |
| `lib/ui-shared.js` | 两面板共用样式与浏览器侧工具（弹窗、宿主通信、错误兜底、`hana.api` 通道、`window.hana` 命名空间、调度纯函数 `Sched`） |
| `lib/diag-log.js` | 插件自有诊断日志（单行格式化/`sk-***` 脱敏/512KB 轮转/读回），路由、工具、client-error 三处共用（纯 node，可单测） |
| `lib/mono-clock.js` | 单调时钟（`monoNow`）与 TTL 新鲜度判定（`isFresh`）：缓存/看门狗不依赖 `Date.now()`，回拨不会永久缓存（纯函数） |
| `lib/official-sync.js` | 官方账单导入与按日聚合（zip 中央目录读取 + `node:zlib` 解压、CSV 解析、北京日聚合、覆盖窗口合并，纯函数）；金额整数微元累加，合计逐位一致 |
| `lib/usage-archive.js` | 用量归档（按 `requestId` 去重、裁剪、上限丢最旧、并集），突破宿主 5000 上限 |
| `scripts/release.mjs` | 发布脚本（备份 → 打 zip → 自检） |
| `tests/run-all.mjs` | 自检脚本 |
| `integrations/wechat-alert.md` / `.cron.json` | 宿主定时推送（微信等）的接入文档与任务模板 —— **定时任务不在插件包内**，它是宿主侧的一条自动化 |
| `.gitignore` | 公开仓库忽略项（源码备份、运行态快照、打包产物、临时文件） |
| `CHANGELOG.md` | 变更记录 |
| `LICENSE` | MIT 许可证（版权人：`JinXin`） |
| `state.json`（运行时生成，不在源码目录） | 插件自有运行状态（余额基准、待确认事件） |
