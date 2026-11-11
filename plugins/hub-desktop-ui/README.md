# hub-desktop-ui — DSH 前端形态插件（out-of-tree bundle）

把 AI-Agent-Hub 自有 Hermes 桌面端的观感搬进 DSH 外壳。**不改 DSH 安装目录**：
以 Cordis bundle 形式装在 profile 里，停用即回退。

> ⚠️ **Host 半的入口是 `lib/index.js`**（package `main` 指向它），它必须 `export * from '../index.js'`。
> 曾经这里是个空 `apply()`，结果 Host 半（管理者协议、测试会话归档、`/hub/restart`）**一行都没执行过**，
> 而客户端半照常工作，导致「Yat2 不知道自己在哪个项目」这类问题看起来像模型不听话。改 Host 代码前先确认这条。

## 当前形态（0.2.0）

| 项 | 实现 | 说明 |
|---|---|---|
| 暖中性暗调 + 陶土主色 | `ctx.theme.overrideTokens(...)`，亮/暗各一套 | `--dsw-alias-bg-*`、`--dsw-alias-border-*`、`--dsw-alias-label-*`、`--dsw-alias-brand-primary`、`--dsw-specific-sidebar-fill` |
| 侧栏更窄、会话列表更紧凑 | 注入一层 CSS（`style#hub-dsh-skin`） | 列宽 252、行高 28、标题 12.5px、区块标签 11.5px、行内按钮悬停显形；锚点只用 `data-slot` |
| 自有品牌标记 | 注册 `sidebar.brand.mark`（`priority: -1`） | 原创新绘 SVG（双翼 + 中心枢纽），展开/折叠共用，尺寸跟随 owner 的 `size` |
| 自有品牌名 | 注册 `sidebar.brand.name`（`priority: -1`） | `AI-Agent-Hub` + 小号 `DSH` 标记，替换 shell 的文字兜底 |
| 侧栏底部状态卡 | 注册 `sidebar.footer.action`（`id: hub-status-card`） | 与官方 `cordis-panel` 并列 |
| 侧栏浏览区（项目行 + 芯片网格） | 注册 `sidebar.workspaces`（`priority: -1`，**替换出厂 WorkspaceBrowser**） | 项目行 = 逻辑项目（不是 workspace）：色块 + 名称 + 最近活动时间；其下是智能体芯片（16px 圆头像 + 名称 + 运行中绿点），两列换行；点击芯片开会话；窄轨模式渲染项目色块 |
| 项目行分隔 | CSS `[data-row-key^="workspace:"]` | 仅在回退到出厂浏览器时生效的兜底样式 |
| 会话改名（建项目的入口） | **双击芯片** → 就地输入 → Enter | 走 `sessions.retain(id, {source:'controllerOperation'})` → `binding.session.rename(title)` → `release()`；改成 `项目 · 智能体` 即刻长出新项目行 |
| 项目房间（群聊） | 注册 `conversation.view`（`id: hub-room`，label `群聊`，order 20） | **是会话窗口里的一个视图**（Chat / Trajectory 之后），不是独立面板。项目行右侧 `群聊` 按钮一键切过去；视图激活时 `html[data-hub-room]` 隐藏会话自带底部输入框 |
| 新建项目（原 New Session） | CSS 改字 + 捕获监听 + `shell.overlay` 弹窗 | 按钮文字变 **New project**；点击弹出命名框 → `connectWorkspace` 建会话并改名 `<项目> · Yat2` |
| 项目管理者协议（Host） | `index.js` 监听 `agent/pre-step` | 会话标题以 ` · Yat2` 结尾时，在**首步**注入一次管理者协议：建人/派活/黑板/汇报；标题经 `ctx.get('sessions')` + `ctx.get('sessionTitle')` 读取 |
| 派活 | 房间头部 `派活` 弹窗 | 选 agent + 写任务 → `binding.session.prompt(['【任务】…'])`，并附带「更新黑板 board.md」要求 |
| 新建 agent（Yat2 建线） | 房间头部 `+ agent` | 输入名字 + 选 preset → 起新会话并改名 `<项目> · <名字>`；「名字 → preset」存 `localStorage["hub.agentPresets"]`，同名跨项目沿用；任务线头部显示绑定 preset |
| 项目行按钮 | 项目行右侧并排 | `群聊`（进入房间）+ `▾/▸`（只折叠/展开，独立按钮）；**整行点击不再有任何行为** |

**项目怎么来的**：会话标题里的 `项目 · 智能体`（同名 ` (2)` 计数先剥掉）——
`星阶 · 管家` 归到「星阶」，芯片显示「管家」。没有这段前缀的会话归到共享项目
`AI-Agent-Hub`（本机只有这一个 workspace，记忆/skill/hook 全共享，项目只是逻辑分组）。
项目管理者（主控）默认叫 **`Yat2`**（`MANAGER_NAMES` 里同时兼容旧的 `Hermes`）。

> **这一版是「阴影级」替换**：`sidebar.workspaces` 是整块 single 座位，出厂占用者同时负责搜索框、拖拽排序、
> 右键菜单、重命名/删除对话框。替换后这些能力随占用者一起消失，当前只保留：
> 项目折叠/展开、点击芯片开会话、双击芯片改名、点项目行开房间、项目区 `+` 新建会话、窄轨展开。
> 搜索、拖拽、右键菜单、删除/归档待补。
> 不满意用 `set_bundle enabled=false` 一条命令退回官方浏览器。

## 群聊房间的数据通路与边界

- 成员：`splitSessionTitle(displayTitle).project === 当前项目`（无前缀的算 `AI-Agent-Hub`）。
- 展示：**一条任务线 = 一个 agent 会话**，各自一张卡片（标题行 + 线程 + 独立输入框），纵向堆叠；
  不把多个 agent 的消息混成一条时间流（Hermes 的房间就是这样分线的）。
- 读消息：`sessions.retain(id, {source:'controllerOperation'})` → `await ref.ready` →
  `ref.binding.eventSource.getSnapshot().entries`，只取 `user/message` / `assistant/message` 的
  `content` 里 `type === 'text'` 的片段（跳过 reasoning / tool-call）。**2.5s 轮询刷新，无流式订阅**。
- 发消息：`binding.session.prompt([{type:'text',text}], 'queue')`，只投给当前选中的 agent。
- 成本：房间打开期间会 retain 所有成员会话（等于替它们打开一次历史），离开房间时 `release()`。
- 未支持：图片/附件、工具步骤、逐条时间、@ 多 agent 广播、消息搜索。

所有贡献都挂在 `ctx.effect` 上：插件停用/卸载时样式、主题层、座位注册一并回收。

> **单座位替换的关键（0.2.1 实测）**：`sidebar.brand.mark` / `.name` 这类 `single` 座位，出厂 occupant 在
> `priority: 0` 注册；再注册必须给**不同的** priority，否则直接抛
> `single slot "…" already has a registration at priority 0 … lowest renders`。
> 本插件用 `priority: -1` 抢到渲染权（数值更低者胜）。

## 安装 / 回退

安装走 `plugin_manager`（`install_bundle`），**不要**手工复制包或改 profile 的 `package.json` / `cordis.patch.yml`：

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

- 落点：`$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles` + `node_modules` 里的 link
- 回退：`plugin_manager action=remove_bundle target=@ai-agent-hub/dsh-client-ui-hub-desktop`，
  或 `set_bundle enabled=false`（保留包、只停用）
- **刷新要求**：浏览器端插件在页面加载时组装（`window.__DSH_BOOT__.entries`），装完/改完要刷新页面
  （改插件代码后，旧页面不会自己换新模块）

> 历史：0.1.0 曾用 `deploy.sh` 直接往 profile 里复制包 + 追加 patch 行。现在这条路已被
> `plugin_manager` 取代，`deploy.sh` 仅作留档，不要再用。

## 边界

- 只注册 Slot / 覆盖主题 token / 注入 CSS，不替换 `root`、`sidebar`、`conversation` 这些整体座位。
- CSS 选择器只用 `data-slot` 语义锚点，不用构建期哈希类名（哈希随版本变）。
- 与 `dsh/plugins/reminders`、`tool-policy` 这类 Host 侧插件是两个体系：那些管工具/钩子，本插件管浏览器端 UI。
