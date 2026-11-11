# quota-panel — 余额与用量面板（DSH bundle）

侧栏底部一行小卡片：`💰 ¥59.24 · 今日 939M`。点开是详情：余额、今日 token（含输入/缓存/输出明细）、
本会话 token、更新时间、最近错误。**失败显示「余额不可用」+ 悬停原因，不消失、不显示 0。**

- 余额：DeepSeek 账号余额（官方 `GET https://api.deepseek.com/user/balance`，与 DeepSeek 后台同一份数据）
- 用量：今日 / 本会话 token（口径 = DSH `tokenUsage` 的四个桶，见下）

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：注册 `GET /hub/quota`，余额 + 用量取数与缓存 |
| `lib/quota-core.js` | 纯逻辑：usage → 桶、今日/本会话汇总、币种挑选（可单测） |
| `client.js` | 浏览器半：`sidebar.footer.action` 座位里的小卡片 + 详情弹层 |
| `cordis.patch.yml` | bundle patch：把宿主行插进组合 |
| `test/core.test.mjs` | 离线单测（12 组，不联网） |

## 数据来源（都实测过，不猜接口）

**余额**（两条路，优先第一条）

1. `ctx.deepseekAccount.getBalance(client)` —— 官方 Host 服务，令牌不出 Host；
   返回 `{status:'ready', value:[{currency,balance}], bonusWallets:[...]}`，充值 + 赠送按币种相加，CNY 优先。
   钱包全为零时**不采信**（可能只是分桶没对上），落到第 2 条核对。
2. `ctx.deepseekAccount.getPlatformSession().token` + `GET https://api.deepseek.com/user/balance`，
   头 `x-dsh-auth-token`（2026-10-21 实测 200，返回 `balance_infos`）。
   **令牌只在 Host 进程内存里流转，不写日志、不进响应、不落盘。**

两条都失败 → `ok:false` + `error`，`balance:null`。绝不返回 0。

**用量**

扫 `$DSH_HOME/sessions/<workspace>/session-<id>/*.zstd`（只取**今天改过**的日志，按 mtime 过滤），
逐个 `sessionController.inspect(id)` 只读持久层（不激活 agent —— 冷会话也能读），
把 `assistant/message.data.usage` 按事件时间累加：

- 今日：`event.time >= 本机零点` 的事件；
- 本会话：该会话**全部**事件；
- `tokens` 优先用 provider 的 `totalTokens`，没给就用 `inputTokens+outputTokens+cacheReadTokens+cacheWriteTokens`。

**口径核对（2026-10-21，Python + zstandard oracle）**：对 89 个真实会话日志逐事件求和，
两种口径给出同一个数 —— `input 31,568,332 + output 1,693,842 + cacheRead 905,811,520 = 939,073,694`，
与 `totalTokens` 之和一致；路由返回的 `today.tokens` / `requests` / `breakdown` 与 oracle **逐字段相等**，
`session.tokens`（如 `session-4375e595` = 1,300,960,278）也与单独求和一致。

## 缓存与延迟

- 两路数据各 60s 缓存（`cacheSeconds: 60`）。
- 用量按「会话文件 mtime + size」增量重算：首次全量约几秒（89 个会话 / 131 MB 解压），之后每轮只重算变过的会话。
- 单次请求最多等用量 2s；没扫完先回 `pending:true`（`today:null`），客户端 2.5s 后重试，最多 8 次。
  全量扫描软预算 25s，超了标 `truncated:true`。
- 失败后 10s 内不重复触发同一路查询（防止客户端每 60s 打爆）。

## 响应形状

```json
{
  "ok": true,
  "balance": { "amount": 59.24, "currency": "CNY" },
  "today": { "tokens": 939073694, "requests": 3413,
             "breakdown": { "input": 31568332, "output": 1693842, "cacheRead": 905811520, "cacheWrite": 0 } },
  "session": { "tokens": 6587607 },
  "updatedAt": "2026-10-21T12:37:14.028Z",
  "pending": false, "stale": false, "truncated": false,
  "source": "account-token", "cacheSeconds": 60
}
```

失败时：`ok:false`、`balance:null`、`error:"余额查询失败：…"`（用量独立，仍照常返回）。
余额失败但有过成功读数时另给 `lastKnownBalance`（详情里显示「上次」），**`balance` 仍是 null**。

## 挂载（本机 desktop profile）

需要一个能装 client 半的**bundle**（`package.json` 带 `dsh.bundle.patch` + `dsh.client`），
装法和 hub-desktop-ui 一致 —— profile `package.json` 里加 `link:` 依赖并进 `bundles` 列表，
再由插件自己的 `cordis.patch.yml` insert 宿主行：

```json
{
  "dependencies": {
    "@ai-agent-hub/dsh-quota-panel": "link:<你的仓库路径>/dsh/plugins/quota-panel"
  },
  "dsh": { "profile": { "bundles": [ "...", "@ai-agent-hub/dsh-quota-panel" ] } }
}
```

已执行（2026-10-21）：

1. `~/.dsh/profiles/desktop/package.json` 备份为 `package.json.bak-quota-panel-20261021`，加依赖 + bundle 项；
2. `node_modules/@ai-agent-hub/dsh-quota-panel` 建符号链接指向本目录（等价于 `pnpm install` 对 `link:` 做的事，
   以后跑 `pnpm install` 也会自动补）；
3. `~/.dsh/profiles/desktop/cordis.patch.yml` **不需要改**——宿主行由本包自带的 `cordis.patch.yml` 插入。

> 只想挂 Host 半、不要客户端卡片时，也可以不用 bundle：在 profile 的 `cordis.patch.yml` 末尾
> `- insert: [{ id: quota-panel, name: ../../../Documents/GitHub/AI-Agent-Hub/dsh/plugins/quota-panel/index.js }]`。
> 但客户端半要靠 `dsh.client` 扫描 bundle，所以卡片必须走上面的 bundle 方式。

**必须重启 DSH**（Host 半是 ESM，进程内改文件/加行都不会重载）。

## 验收

```powershell
# 1) Host 路由（真实余额 + 今日 token）
curl.exe -s "http://127.0.0.1:<GUI端口>/hub/quota?session=<会话id>"
# 2) 语法
node --check dsh/plugins/quota-panel/index.js
node --check dsh/plugins/quota-panel/client.js
# 3) 纯逻辑单测
node dsh/plugins/quota-panel/test/core.test.mjs
```

F5 后的视觉验证点：

1. 侧栏底部（AI-Agent-Hub 那张卡上面）多一行 `💰 ¥xx.xx · 今日 xxxM`，11px、跟随主题深浅色；
2. 点它 → 弹出详情：余额 / 今日 token·请求数 / 输入·缓存·输出明细 / 本会话 token / 更新时间 / 来源 / DeepSeek 用量明细链接；
3. 把侧栏拖窄到 < 190px（或折叠成图标轨）→ 只剩 `💰 ¥xx.xx`；
4. 断开账号（或改坏 token）→ 卡片变红字「余额不可用」，悬停显示原因，点开详情能看到错误原文；**卡片不会消失、也不会显示 0**。

## 回滚

1. profile `package.json` 覆盖回 `package.json.bak-quota-panel-20261021`；
2. 删 `node_modules/@ai-agent-hub/dsh-quota-panel` 符号链接；
3. 重启 DSH。
