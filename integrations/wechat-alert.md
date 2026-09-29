# 余额预警的定时推送（宿主定时任务）

插件的余额预警**推不出微信**：插件总线里没有 `notify.send`（那是宿主内部工具的事件，插件调用会报 `No handler registered`），桥接通道也不对插件开放。所以这条链拆成两步：

```
宿主定时任务（每小时）→ 插件工具 deepseek-balance_deepseek_balance_alert（只判定）
                      → 宿主的 notify 工具（投递到微信等平台）
                      → 投递失败必须回报，不许静默
```

插件侧只负责「是否该推 + 一条可直接转发的文本」，投递由宿主完成。**定时任务不在插件包里**（它是宿主侧的一条自动化），所以本目录给出可直接复制的模板。

- 任务模板（人读）：本文件
- 任务模板（机读）：[`wechat-alert.cron.json`](./wechat-alert.cron.json)

## 一、前置条件

1. 插件已安装且以 **Full-access（全权）** 方式启用（工具需要 `network.fetch` 与写状态的能力）。
2. 插件设置里：
   - `alertThreshold` = 你想要的下限（元），**必须 > 0**，否则工具直接返回 `reason=no_threshold`，什么都不查；
   - `alertNotify` = 开（默认开）。关掉后工具返回 `reason=disabled`，侧栏显示「余额预警已开启（推送已关闭）」；
   - `apiKey` 已填（否则返回 `ok=false, error=not_configured`）。
3. 宿主侧已配好要投递的平台（微信 Bridge 等）。

## 二、任务定义

| 字段 | 值 |
|---|---|
| 类型 | `cron` |
| 表达式 | `0 * * * *`（每小时整点一次） |
| 运行模式 | `isolated`（独立会话，不污染日常对话） |
| 投递目标 | `channels: ["bridge_owner"]` + `bridgePlatforms: ["wechat"]` |

`prompt`（**建议原样复制**，两步，不做多余的事）：

```
每轮执行两步，不要做多余的事：

1) 调用工具 deepseek-balance_deepseek_balance_alert（无需参数）。它返回 JSON：due / alerting / total / threshold / text。

2) 看 due：
- due === true：调用 notify 工具把返回的 text 原文推送微信。参数：title="DeepSeek 余额预警"，body=<返回的 text>，audience="owner"，channels=["bridge_owner"]，bridgePlatforms=["wechat"]。
- due !== true：不发任何通知，也不发消息解释，本轮直接结束。
```

## 三、怎么建

**方式 A：面板建（推荐）**

1. 打开宿主的「自动化」面板，新建任务；
2. 类型选 **cron**，表达式填 `0 * * * *`；
3. 运行模式选 **isolated**，把上面的 `prompt` 粘进去；
4. 保存并启用；
5. 手动触发一次，确认返回 `due=false`（或真的推送了），并检查任务状态里没有连续错误。

**方式 B：让 Agent 建**

把 [`wechat-alert.cron.json`](./wechat-alert.cron.json) 的内容连同这句话交给 Agent：

> 按这个模板给我建一个每小时跑的定时任务，投递平台是微信。

> 模板里的 `studioId` / `sessionId` / `createdAt` 等本机标识已剥离，**它不是可直接导入的存档**，而是「字段 + 提示词」的参照；落库请用方式 A 或让 Agent 用自动化工具创建。

## 四、推送语义（为什么不会刷屏）

判定与节奏都在插件工具里（`tools/balance-alert.js`），状态写在插件数据目录的 `state.json`（`alertState` / `lastAlertPushAt`）：

- 余额**跌破阈值那一刻**返回 `due=true`（`reason=entered_alert`），推一次；
- **持续低于**返回 `due=false`（`reason=still_low`），不重推；
- **回升到阈值以上**复位（`reason=recovered`），下次再跌破仍立即推；
- 状态写盘失败时降级为「整点桶」（每小时只在前 5 分钟可能推），并在 `diagnostics.log` 留痕。

所以每小时跑一次是安全的：**它只是采样频率，不是推送频率**。想让采样更疏，把 cron 改成 `0 */6 * * *` 之类即可。

## 五、换平台 / 调参

- **换平台**：把 `notify` 调用里的 `bridgePlatforms` 换成 `feishu` / `dingtalk` / `telegram` / `qq`；投递到多个平台就写成数组。
- **换阈值**：改插件设置里的 `alertThreshold`（不用动定时任务）。
- **换频率**：改 cron 表达式。
- **想同时发桌面通知**：在 `channels` 里加 `"desktop"`。

## 六、排错

| 现象 | 先查什么 |
|---|---|
| 任务连续报错 | 手动调一次 `deepseek_balance_alert`，看返回的 `ok` / `error`；再看 `plugin-data/deepseek-balance/diagnostics.log` 里的 `[tool] decision: …` 行 |
| 一直不推 | `alertThreshold` 是否为 0；`alertNotify` 是否被关；余额是不是根本没跌破 |
| 工具返回 `not_configured` | `apiKey` 没填或读不到 |
| 工具返回 `upstream_…` / 超时 | 官方接口不可达；插件只允许访问 `api.deepseek.com` 与 `api-docs.deepseek.com` |
| 每轮都推 | 说明状态写不进 `state.json`（看日志里的 `state persist FAILED`），此时会退化为整点桶 |
