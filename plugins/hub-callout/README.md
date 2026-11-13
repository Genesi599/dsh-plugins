# hub-callout

把消息里的 GitHub admonition 语法渲染成 alert 卡片，**视觉对齐 Hermes 桌面端**
（`apps/desktop/src/components/assistant-ui/embeds/alert.tsx`，commit c8713ee631）。

```markdown
> [!NOTE] 可选标题
> 正文……

> [!BOOK] Project Hail Mary · Ch.3
> “And that’s odd?”
```

支持 `NOTE` / `TIP` / `IMPORTANT` / `WARNING` / `CAUTION` / `BOOK`。

## 更新

```sh
# 升到当前主版本范围内的最新版
dsh plugin --profile <profile> update dsh-hub-callout

# 或直接装最新版（含跨主版本）
dsh plugin --profile <profile> add dsh-hub-callout@latest
```

用整套装的话，重跑一次即可按版本范围升级全部插件：

```sh
npx dsh-hub-suite@latest
```

**更新后必须重启 DeepSeek Harness** —— 插件在应用启动时加载。核对版本：

```sh
dsh plugin --profile <profile> list --depth 0
```

## 与 Hermes 的对应关系

| Hermes（alert.tsx） | 这里 |
|---|---|
| `my-2 rounded-lg border border-(--ui-stroke-tertiary) bg-muted/25 px-3 py-2` | `margin:8px 0; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background: bg-layer-2 @25%; padding:8px 12px` |
| 标题行 `mb-1 flex items-center gap-1.5 text-[0.8125rem] font-semibold` | `margin-bottom:4px; gap:6px; font-size:13px; font-weight:600` |
| 图标 `size-4`（tabler Info/Zap/AlertCircle/AlertTriangle/Book） | 同款 tabler 路径内联 SVG，16×16、`stroke:currentColor` |
| 标签文案 `Note / Tip / Important / Warning / Caution / 原文` | 完全一致 |
| 配色 `-600`（亮）/ `-400`（暗） | 同值；暗色走 `prefers-color-scheme` + `.dark` / `[data-theme="dark"]` |
| 原文正文 `.book-quote`：Times New Roman、`0.95rem`、行高 `1.7` | 同值（`[!BOOK]` 卡片整体衬线，标题行仍是 13px 无衬线） |
| 标记 `[!TYPE]` 摘掉、其余文字留在正文 | 同（只改承载标记的文本节点） |

## 为什么是 DOM 后处理

DSH 的 markdown 渲染器是 `@deepseek-ai/dsh-client-ui-primitives` 里的 direct mdast→React 实现
（`lib/types/markdown/render.d.ts`），blockquote 分支硬编码，没有语法插件注册点；客户端插件
也拿不到块级渲染席位。所以插件只在**已定稿**的消息上做事：

- 摘掉首段的 `[!TYPE]` 标记（只改文本节点，不删元素），插入一行标题（图标 + 标签）；
- 选择器用 `blockquote[data-hub-callout]`（0,2,1）压过 DSH 自带 `.markdown blockquote`（0,1,1 的竖线 + 14px 缩进）；
- `[data-streaming]` 期间一律跳过，流式结束后靠属性监听补扫。

停用插件时 `reset()` 会摘掉所有 class/属性、删掉标题行并移除样式层，不留残留。

## 安装

### 整套装（一条命令）

想把 AI-Agent-Hub 这套插件一次装齐（本插件 + 另外 7 个 + 依赖闭包）：

```bash
npx dsh-hub-suite            # 先看它要改什么：npx dsh-hub-suite --dry-run
```

需要 Node.js 18+；它会把依赖写进 DSH profile 的 `package.json`、安装依赖，并把包名登记进 `dsh.profile.bundles`。装完重启 DeepSeek Harness。

```bash
# 在 DSH 里（推荐）
plugin_manager install_bundle  target=<此目录的绝对路径>
```

或手工：复制包到 `$DSH_HOME/profiles/node_modules/@ai-agent-hub/`，再给目标 profile 的
`cordis.patch.yml` 追加 `- insert: [{ id: hub-callout, name: '@ai-agent-hub/dsh-client-ui-hub-callout' }]`，重启生效。