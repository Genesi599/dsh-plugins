/**
 * dsh-hub-desktop-ui — 浏览器半（out-of-tree Cordis client plugin）。
 *
 * 形态目标：把 AI-Agent-Hub 自有 Hermes 桌面端的观感搬到 DSH 外壳——
 *   ① 暖中性暗调 + 陶土色主色（theme token 覆盖，亮/暗两套）
 *   ② 更窄的侧栏会话列表（只注入一层 CSS，锚点走 data-slot，不用构建期哈希类名）
 *   ③ 自有品牌标记 / 品牌名（单座位用 priority -1 覆盖出厂 occupant）
 *   ④ 侧栏底部状态卡
 *
 * 一切贡献都挂在 ctx.effect 上：插件停用即回收，可回退。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hub-desktop-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 主题层标识（一个 source 一层；重复调用只替换该层）。 */
    const THEME_SOURCE = 'ai-agent-hub/hub-desktop-ui';
    /**
     * 是否覆盖 DSH 的主题配色。2026-11-11 用户令「暖色暗调配色可以不调吗？用默认的不行吗」→ 默认 false，
     * 即使用 DSH 自带配色；把这里改成 true 就恢复下面的暖色暗调 token。
     * 注意：关掉只影响配色，布局/侧栏/项目页/状态卡等功能不受影响。
     */
    const USE_CUSTOM_PALETTE = false;
    /** 形态样式层的 style 元素 id（便于核对与清理）。 */
    const SKIN_STYLE_ID = 'hub-dsh-skin';

    /** 暖中性暗调 + 陶土色主色：亮/暗两套必须成对给出。 */
    const THEME_TOKENS = {
      '--dsw-alias-bg-base': { light: '#f7f5f1', dark: '#141416' },
      '--dsw-alias-bg-layer-1': { light: '#fffdf9', dark: '#1c1c20' },
      '--dsw-alias-bg-layer-2': { light: '#f2efe8', dark: '#24242a' },
      '--dsw-alias-bg-overlay': { light: '#fffdf9', dark: '#212127' },
      '--dsw-alias-border-l1': { light: '#e4e0d6', dark: '#2b2b31' },
      '--dsw-alias-border-l2': { light: '#d3cdc0', dark: '#3a3a42' },
      '--dsw-alias-brand-primary': { light: '#c96442', dark: '#d97757' },
      '--dsw-alias-label-primary': { light: '#26221d', dark: '#ecebe8' },
      '--dsw-alias-label-secondary': { light: '#6f6a61', dark: '#a5a19a' },
      '--dsw-specific-sidebar-fill': { light: '#f1efe9', dark: '#101012' },
      // 2026-10-25 扩展（用户报「皮肤好像没生效」的根因）：DSH 0.2.1 实际用 **417 个**
      // --dsw-* 变量，而 Theme API 只暴露 14 个。只覆盖那 14 个 → 链接/业务主色（蓝）、
      // 三级文字、分层背景、滚动条、焦点环、菜单/输入底色仍是默认色。这里在 overrideTokens
      // 里额外给出这些变量（旧版本 API 会忽略不认识的键，不会报错）。
      '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#c96442', dark: '#d97757' },
      '--dsw-alias-link': { light: '#b4553a', dark: '#e08d70' },
      '--dsw-alias-state-business-primary': { light: '#c96442', dark: '#d97757' },
      '--dsw-alias-label-tertiary': { light: '#8a847a', dark: '#8f8b84' },
      '--dsw-alias-label-caption': { light: '#8a847a', dark: '#8f8b84' },
      '--dsw-alias-border-l3': { light: '#c9c2b4', dark: '#33333b' },
      '--dsw-alias-border-l4': { light: '#bdb5a6', dark: '#3f3f47' },
      '--dsw-alias-bg-layer-3': { light: '#ece8df', dark: '#2a2a30' },
      '--dsw-alias-bg-module-platform': { light: '#f4f1ea', dark: '#18181b' },
      '--dsw-alias-interactive-bg-hover': { light: 'rgba(38,34,29,0.06)', dark: 'rgba(255,255,255,0.06)' },
      '--dsw-alias-interactive-bg-hover-solid': { light: '#e9e4da', dark: '#26262c' },
      '--dsw-alias-markdown-code-block': { light: '#f0ece3', dark: '#1a1a1e' },
      '--dsw-specific-menu': { light: '#fffdf9', dark: '#1c1c20' },
      '--dsw-specific-input-major': { light: '#f7f4ee', dark: '#24242a' },
      '--dsw-focus-ring-color': { light: '#c96442', dark: '#d97757' },
      '--dsw-alias-scrollbar-bg-l2': { light: '#d9d3c6', dark: '#2b2b31' },
      '--dsw-alias-scrollbar-hover-l2': { light: '#c2bbac', dark: '#3a3a42' },
      '--dsw-elevation-stroke-color': { light: '#e4e0d6', dark: '#2b2b31' },
      // 2026-10-26 第二轮（用户报「还是没能应用」：发送按钮等默认蓝残留）：
      // token 通道本身已全部生效（skinAudit A 项全部一致），残留冷色来自**没覆盖到的 token**——
      // ① 发送按钮 `.GRgSLq_primary` 用 `--dsw-alias-button-info-fill`（→static-deepseek-500 蓝）
      //   及整族 button-* 别名；② 大量表面色引用 `--dsw-static-neutral-bluish-*` 蓝灰阶（整体偏冷的来源）。
      // 这里补齐 button 族别名（陶土主色/暖中性）+ 把 00–1000 蓝灰阶整体换成**等亮度暖灰**阶。
      '--dsw-alias-button-info-fill': { light: '#c96442', dark: '#d97757' },
      '--dsw-alias-button-info-hover': { light: '#b4553a', dark: '#e68a66' },
      '--dsw-alias-button-primary-fill': { light: '#c96442', dark: '#d97757' },
      '--dsw-alias-button-primary-hover': { light: '#b4553a', dark: '#e68a66' },
      '--dsw-alias-button-primary-dimmed': { light: '#e9e4da', dark: '#26262c' },
      '--dsw-alias-button-contrast-fill': { light: '#26221d', dark: '#3a3a42' },
      '--dsw-alias-button-floating-fill': { light: '#fffdf9', dark: '#24242a' },
      '--dsw-alias-button-floating-hover': { light: '#f2efe8', dark: '#2e2e35' },
      '--dsw-alias-button-ghost-active-fill': { light: '#e9e4da', dark: '#26262c' },
      '--dsw-alias-button-ghost-active-border': { light: '#d3cdc0', dark: '#3a3a42' },
      '--dsw-alias-button-ghost-active-hover': { light: '#e2ddd2', dark: '#2e2e35' },
      '--dsw-alias-button-elevated-fill': { light: '#fffdf9', dark: '#212127' },
      // 暖化蓝灰阶（等亮度映射：保持明度，把 Hue≈220 的蓝灰移成 Hue≈35 的中性暖灰）
      '--dsw-static-neutral-bluish-00': { light: '#ffffff', dark: '#fffdf9' },
      '--dsw-static-neutral-bluish-50': { light: '#faf8f4', dark: '#f7f5f1' },
      '--dsw-static-neutral-bluish-60': { light: '#f6f3ee', dark: '#f4f1ea' },
      '--dsw-static-neutral-bluish-75': { light: '#f1eee8', dark: '#efebe3' },
      '--dsw-static-neutral-bluish-100': { light: '#ebe8e0', dark: '#e9e5db' },
      '--dsw-static-neutral-bluish-150': { light: '#e9e5db', dark: '#e7e2d7' },
      '--dsw-static-neutral-bluish-200': { light: '#e1dcd1', dark: '#dfd9cd' },
      '--dsw-static-neutral-bluish-300': { light: '#cfcac0', dark: '#cdc7bb' },
      '--dsw-static-neutral-bluish-400': { light: '#aca69b', dark: '#a9a397' },
      '--dsw-static-neutral-bluish-500': { light: '#96908a', dark: '#938d85' },
      '--dsw-static-neutral-bluish-600': { light: '#837d76', dark: '#807a72' },
      '--dsw-static-neutral-bluish-700': { light: '#635e58', dark: '#615c55' },
      '--dsw-static-neutral-bluish-750': { light: '#45413c', dark: '#443f3a' },
      '--dsw-static-neutral-bluish-800': { light: '#37342f', dark: '#35322d' },
      '--dsw-static-neutral-bluish-850': { light: '#2d2b28', dark: '#2b2926' },
      '--dsw-static-neutral-bluish-875': { light: '#242320', dark: '#222019' },
      '--dsw-static-neutral-bluish-900': { light: '#1c1a18', dark: '#1a1815' },
      '--dsw-static-neutral-bluish-950': { light: '#161513', dark: '#141312' },
      '--dsw-static-neutral-bluish-1000': { light: '#121110', dark: '#100f0e' },
    };

    /**
     * 侧栏密度与视觉层：对齐 Hermes 桌面端的紧凑会话列表。
     * 作用域只用语义锚点：[data-slot="sidebar"] / [data-slot="sidebar.workspaces"]。
     */
    const SKIN_CSS = `
/* 侧栏列宽不再写死（2026-10-20）：外壳把侧栏做成 grid 轨道，宽度写在列内节点的
   内联 style 上（ui-layout：computeColumns 夹在 264–420px，拖拽只改轨道）。
   这里原来用 width:252px !important 把内联宽度压掉，结果拖动只挪轨道、内容永远
   252px 宽 —— 芯片因此恒 2 列。列宽交回外壳，最窄本来就是 264px。 */

/* 区块标签（工作区/设置组）：14px -> 11.5px 大写间距。
   ⚠️ 2026-10-23 适配：侧栏内容已被本插件（HubWorkspaces）替换，原生
   [role="treeitem"] / [class*="sectionLabel"] 结构在现版本 DOM 里已不存在
   （自检 selectorHits: treeitem=0 / sectionLabel=0）→ 这类选择器是死规则，
   已改写为本插件自己的类名（.hub-proj / .hub-chip / .hub-head-label）。 */
[data-slot="sidebar.workspaces"] .hub-head-label {
  font-size: 11.5px !important;
  letter-spacing: 0.04em;
}

/* 项目行（本插件的 .hub-proj）：压紧行高 + 分隔线，读起来像「项目」而不是一行会话 */
[data-slot="sidebar.workspaces"] .hub-proj {
  height: 22px !important;
  min-height: 22px !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  margin-top: 6px !important;
  border-radius: 6px !important;
  font-size: 12px !important;
  box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1);
}
[data-slot="sidebar.workspaces"] .hub-proj:first-of-type { margin-top: 0 !important; }

/* 成员芯片（本插件的 .hub-chip）：字号/内边距与项目行同节奏 */
[data-slot="sidebar.workspaces"] .hub-chip {
  font-size: 11.5px !important;
  padding: 2px 6px 2px 2px !important;
  border-radius: 10px !important;
}

/* 侧栏顶部的「New Session」胶囊按钮（2026-11-11 用户问「这个能隐藏吗」）→ 受设置开关控制：
   <html data-hub-hide-new-session> 存在时才隐藏。设置页「侧栏」分区里有一行对应开关。
   出厂结构：<button type="button" class="<hash>_newSession" aria-label="New session">，
   <hash> 随构建变、后缀 _newSession 稳定 → 按子串匹配。
   带 button 标签限定，避免连带命中 _newSessionLabel / _newSessionContent 等内部节点。 */
html[data-hub-hide-new-session] [data-slot="sidebar"] button[class*="_newSession"] { display: none !important; }

/* 侧栏「More」面板列表启动器（2026-11-11 用户：「这个也隐藏吧…在设置里面加一个选项」）→
   受设置开关控制：<html data-hub-hide-more> 存在时才隐藏。
   出厂结构：PanelMoreMenu 的 <button class="<hash>_panelRow" aria-haspopup="menu">（图标 IconAppsAddOutlineRegular）。
   _panelRow 也用在普通面板行上，所以再加 aria-haspopup="menu" 限定，只命中这一个。 */
html[data-hub-hide-more] [data-slot="sidebar"] button[class*="_panelRow"][aria-haspopup="menu"] {
  display: none !important;
}

/* 侧栏缩放（2026-10-25 用户要求「侧边栏网页要能缩放」）：Ctrl+滚轮调
   --hub-sidebar-zoom（0.7–1.8），整列 zoom 缩放、宽度随轨道自适应；
   Ctrl+0 复位 1。变量由 JS 设在 documentElement 上并持久化 localStorage。 */
[data-slot="sidebar"] {
  zoom: var(--hub-sidebar-zoom, 1);
}

/* 切换会话"不闪"（2026-10-27 三修）：②d 在切会话的 MutationObserver 回调里（绘制前）给
   <html> 打 data-hub-stick-switch，贴底成功或兜底 600ms 后撤掉。这段期间隐藏会话内容区——
   用户看到新会话"直接出现在底部"，而不是"先渲染顶部再跳下去"。 */
html[data-hub-stick-switch] [data-conversation-content] {
  visibility: hidden !important;
}

/* 自绘浏览区（项目行 + 芯片网格）的悬停反馈 */
[data-slot="sidebar.workspaces"] .hub-proj:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
}

/* 窄轨（折叠）模式兜底（2026-10-27 用户报「一拖窄就变成竖排乱码」）：
   折叠后侧栏只有 ~48px，外壳靠 data-sidebar-collapsed 标记切换成图标形态，
   但本插件把「New Session」文字用 ::after 改成了「New project」，会在这条窄轨里
   被挤成竖排裁切。这里在折叠态隐藏插件加的文字，只留原生图标。 */
[data-sidebar-collapsed] [data-slot="sidebar"] button[class*="_newSession"]::after {
  content: none !important;
}
[data-sidebar-collapsed] [data-slot="sidebar"] [class*="_newSession"] {
  min-height: 28px !important;
  justify-content: center;
}
/* 折叠态下自绘浏览区退化成色块轨：只隐藏项目名文字（不换行不省略，直接不提），色块保留 */
[data-sidebar-collapsed] [data-slot="sidebar.workspaces"] .hub-proj-name {
  display: none;
}
[data-sidebar-collapsed] [data-slot="sidebar.workspaces"] .hub-proj {
  justify-content: center;  padding: 0 4px !important;
}
/* 项目行图钉：默认隐藏，悬停显形；已置顶的常显（就是置顶状态的轻量标识） */
/* 搜索框（2026-11-01）：侧栏折叠成 48px 图标栏时塞不下输入框，直接隐藏（清空逻辑不受影响） */
[data-sidebar-collapsed] [data-slot="sidebar.workspaces"] .hub-search {
  display: none !important;
}

[data-slot="sidebar.workspaces"] .hub-proj .hub-pin {
  opacity: 0;
  transition: opacity 120ms ease;
}
[data-slot="sidebar.workspaces"] .hub-proj:hover .hub-pin,
[data-slot="sidebar.workspaces"] .hub-proj .hub-pin[data-pinned="1"] {
  opacity: 1;
}
[data-slot="sidebar.workspaces"] .hub-chip:hover {
  background: var(--dsw-alias-bg-layer-2) !important;
  border-color: var(--dsw-alias-border-l2) !important;
}
/* 群聊页打开时：不把任何 agent 芯片标成「当前会话」（会话没变，高亮会误导） */
html[data-hub-room-page] [data-slot="sidebar.workspaces"] .hub-chip[data-active="1"] {
  background: transparent !important;
  border-color: transparent !important;
  color: var(--dsw-alias-label-secondary) !important;
}
/* 运行中：芯片上的绿点脉冲 + 头像轻微呼吸 */
@keyframes hub-pulse {
  0% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }
  60% { transform: scale(1.45); opacity: 0.55; box-shadow: 0 0 0 4px transparent; }
  100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 transparent; }
}
[data-slot="sidebar.workspaces"] .hub-running-dot {
  animation: hub-pulse 1.4s ease-in-out infinite;
}

/* 群聊视图激活时：隐藏会话底部的原生输入框（房间自带总输入框） */
html[data-hub-room] [data-slot="conversation.composer.bar"] {
  display: none !important;
}
/* 速率小字贴的是原生 composer，群聊里输入框本体已隐藏，这行也不该露头 */
html[data-hub-room] .hub-rate-hint {
  display: none !important;
}

/* 2026-11-11 用户令「可以不覆盖吗」：恢复 DSH 出厂的「New Session」按钮，
   下面这段把按钮文字改成「New project」的 CSS 已停用（取消注释即恢复）。
[data-slot="sidebar"] button[class*="_newSession"] * {
  font-size: 0 !important;
}
[data-slot="sidebar"] button[class*="_newSession"]::after {
  content: "New project";
  font-size: 13px;
  letter-spacing: 0.01em;
  margin-left: 6px;
  color: var(--dsw-alias-label-primary);
}
[data-slot="sidebar"] button[class*="_newSession"] svg {
  width: 16px;
  height: 16px;
}
[data-slot="sidebar"] [class*="_newSession"] svg {
  font-size: 13px;
}
*/

/* ── 分身分列（历史特性，2026-11-09 用户令已取消，CloneColumns 不再挂载） ─────────
   下面 [data-hub-clone-cols] 的两条规则原本是「挂上面板时藏掉原生消息区与原生 composer」。
   取消分列后**必须删掉**：钩子一旦被残留（旧页面状态 / 旧点击路径）而面板又不挂载，
   就没人再摘钩子 → html[data-hub-clone-cols] [data-conversation-content]{visibility:hidden}
   会把整个对话正文隐掉（用户看到的就是空白会话）。
   CloneColumns 组件与其 .hub-cc-* 样式保留在文件里，需要恢复时解注释注册即可。 */
/* 2026-11-05 用户令「每列内部不要左右滚动」：分列列内的原生会话体禁止横向滚动。
   原来列内可小幅横滚（原生消息区/子容器带 overflow-x），滚动时整列内容左右漂。
   纵向滚动保留；pre/code/kbd 与 table 不裁（代码块/宽表本身需要各自横滚）。 */
.hub-cc-col [data-conversation-content],
.hub-cc-col [data-conversation-content] *:not(pre):not(code):not(kbd):not(table) {
  overflow-x: hidden !important;
}
.hub-cc-panel {
  position: fixed;
  z-index: 870;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--dsw-alias-bg-base);
}
.hub-cc-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}
.hub-cc-toggle {
  margin-left: auto;
  height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 9.5px;
  cursor: pointer;
}
.hub-cc-toggle:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.hub-cc-rail {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 8px;
  /* 右侧 8px 留白：滚到最右时最后一列不会被边缘截断 */
  padding: 8px 8px 8px 10px;
  overflow-x: auto;
  overflow-y: hidden;
  align-items: stretch;
  /* 横向滚动条常显（细）——列多时这是唯一的拖拽入口 */
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-border-l2) transparent;
  overscroll-behavior-x: contain;
}
.hub-cc-rail::-webkit-scrollbar {
  height: 9px;
}
.hub-cc-rail::-webkit-scrollbar-track {
  background: transparent;
}
.hub-cc-rail::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2);
  border-radius: 5px;
}
.hub-cc-rail::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.hub-cc-col {
  /* 宽度自适应（2026-10-21 用户要求）：平分可用宽度、随窗口缩放自动伸缩；
     只有窄到 min-width 才横向滚动，不再钉死 320px。 */
  flex: 1 1 0;
  min-width: 300px;
  max-width: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.hub-cc-col[data-parent="1"] {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);
}
.hub-cc-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.hub-cc-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 1;
}
.hub-cc-name {
  flex: 1 1 auto;
  min-width: 0;
  /* agent 名完整显示（2026-10-21）：去掉省略号截断，允许换行 */
  white-space: normal;
  word-break: break-word;
  line-height: 1.2;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.hub-cc-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.hub-cc-col[data-running="1"] .hub-cc-dot {
  background: var(--dsw-alias-state-success-primary);
  animation: hub-pulse 1.4s ease-in-out infinite;
}
.hub-cc-dur {
  flex: 0 0 auto;
  font-size: 9px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-state-success-primary);
}
.hub-cc-tps {
  flex: 0 0 auto;
  font-size: 9px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}
/* 分列列内模型选择器（2026-10-23）：输入框右侧内联 pill，形式对齐原生 composer */
.hub-cc-model {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.hub-cc-model-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: 6px;
  padding: 0 5px;
  height: 20px;
  font-size: 10px;
  line-height: 20px;
  cursor: pointer;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hub-cc-model-chip:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.hub-cc-model-caret {
  font-size: 8px;
  opacity: 0.75;
}
.hub-cc-model-menu {
  position: fixed;
  right: auto;
  z-index: 2000;
  width: 232px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 8px 24px rgb(0 0 0 / 28%);
}
.hub-cc-model-item {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  padding: 4px 7px;
  border-radius: 6px;
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hub-cc-model-item:hover { background: var(--dsw-alias-bg-layer-2); }
.hub-cc-model-item.is-active { color: var(--dsw-alias-brand-primary); font-weight: 600; }
/* 提供商分组标题（2026-10-23） */
.hub-cc-model-group {
  padding: 6px 8px 3px;
  font-size: 9px;
  letter-spacing: 0.02em;
  text-transform: none;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
  border-top: 1px solid var(--dsw-alias-border-l1);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hub-cc-model-group:first-child {
  border-top: none;
  margin-top: 0;
  padding-top: 2px;
}
.hub-cc-open {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}
.hub-cc-open:hover {
  background: var(--dsw-alias-bg-layer-2);
}
/* 原生会话体容器：conversation.content（embedded）自带滚动与输入框，这里只给尺寸约束 */
.hub-cc-native {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.hub-cc-native > * {
  min-height: 0;
  min-width: 0;
}
/* 列内输入条：分列期间原生 composer 被 CSS 藏掉，每列自带一个（Enter 发送） */
.hub-cc-composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.hub-cc-composer-row {
  display: flex;
  align-items: flex-end;
  gap: 5px;
}
.hub-cc-input {
  flex: 1 1 auto;
  min-width: 0;
  resize: none;
  height: 24px;
  max-height: 72px;
  padding: 3px 8px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 11.5px;
  line-height: 1.5;
  outline: none;
}
.hub-cc-input:focus {
  border-color: var(--dsw-alias-brand-primary);
}
.hub-cc-input::placeholder {
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.hub-cc-send {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.hub-cc-send:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}
.hub-cc-send:disabled {
  opacity: 0.5;
  cursor: default;
}
.hub-cc-send-error {
  flex: 0 0 auto;
  max-width: 100%;
  padding: 2px 8px 0;
  font-size: 9.5px;
  color: var(--dsw-alias-state-error-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 列内容 = 真实消息流（LaneFeed 自带 flex:1 滚动区），底部不再有占位条：
   取不到事件时由 LaneFeed 的空态文案说明，不再提示「点 ↗ 打开」。 */
.hub-cc-restore {
  position: fixed;
  z-index: 869;
  height: 20px;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.hub-cc-restore:hover {
  background: var(--dsw-alias-bg-layer-2);
}
@media (prefers-reduced-motion: reduce) {
  .hub-cc-col[data-running="1"] .hub-cc-dot { animation: none; }
}
`;

    /** 自有品牌标记：双翼 + 中心枢纽，展开与折叠态共用（尺寸由 owner 给）。 */
    function HubBrandMark(props) {
      const size = (props && props.size) || 22;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 32 32',
          role: 'img',
          'aria-label': 'AI-Agent-Hub',
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('rect', {
          x: 0.5, y: 0.5, width: 31, height: 31, rx: 8.5,
          fill: 'var(--dsw-specific-sidebar-fill, #17191c)',
          stroke: 'var(--dsw-alias-border-l1, #2e2e33)',
        }),
        h('path', {
          d: 'M16 6.4 23.6 10.8v8.8L16 24v-4.1l3.9-2.3v-4.4L16 10.9Z',
          fill: 'var(--dsw-alias-brand-primary, #d97757)',
        }),
        h('path', {
          d: 'M16 6.4 8.4 10.8v8.8L16 24v-4.1l-3.9-2.3v-4.4L16 10.9Z',
          fill: 'var(--dsw-alias-label-secondary, #8f6a5a)',
          opacity: 0.55,
        }),
        h('circle', { cx: 16, cy: 16.6, r: 1.5, fill: 'var(--dsw-alias-label-primary, #f1efe9)' }),
      );
    }

    /** 稳定的项目配色：同一项目永远同一颜色（哈希到色相）。 */
    function projectHue(seed) {
      let hash = 0;
      for (const ch of String(seed)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
      return hash % 360;
    }

    /**
     * 项目色相：**一次分配、永不改色**（2026-10-22 修「蓝绿来回变」）。
     *
     * 旧实现按「当前项目名单排序」整体重算冲突消解，名单一变（会话归档/新建、重名等）
     * 就重排 → 同一个项目在蓝绿间跳。现在改为持久化表：
     *   - `localStorage['hub.project.hues']` 存 `{ "<项目名>": <hue 0-360> }`；
     *   - 已在表里的项目**直接沿用**，绝不再算、绝不因名单变化改色；
     *   - 只有**新出现**的项目才分配：取距离所有已用色相最远的位置（环形距离贪心）；
     *   - 项目暂时消失不清表（回来颜色不变）。
     * 逃生口：想重排整块色板 → `localStorage.removeItem('hub.project.hues')` 后刷新。
     */
    const HUE_STORE_KEY = 'hub.project.hues';
    const hueRegistry = { map: new Map(), store: {}, loaded: false };
    const circularDist = (a, b) => {
      const d = Math.abs(((a - b) % 360 + 360) % 360);
      return Math.min(d, 360 - d);
    };
    function loadHueStore() {
      if (hueRegistry.loaded) return;
      hueRegistry.loaded = true;
      try {
        const raw = localStorage.getItem(HUE_STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [name, hue] of Object.entries(parsed)) {
            const n = Number(hue);
            if (name && Number.isFinite(n)) {
              hueRegistry.store[name] = ((n % 360) + 360) % 360;
              hueRegistry.map.set(name, hueRegistry.store[name]);
            }
          }
        }
      } catch (error) { /* 存储坏了就当空表，重新分配 */ }
    }
    function saveHueStore() {
      try {
        localStorage.setItem(HUE_STORE_KEY, JSON.stringify(hueRegistry.store));
      } catch (error) { /* 写不进去不影响本次显示 */ }
    }
    /** 新项目选色：取距已用色相最远的位置（贪心，间隔优先保证 ≥24°，退到 ≥8° 仍不行再用最远点）。 */
    function pickFreshHue(taken) {
      if (!taken.length) return projectHue(`seed-${Math.random()}`);
      let bestHue = 0;
      let bestGap = -1;
      for (let hue = 0; hue < 360; hue += 2) {
        const gap = Math.min(...taken.map((t) => circularDist(hue, t)));
        if (gap > bestGap) { bestGap = gap; bestHue = hue; }
        if (bestGap >= 72) break;
      }
      // 判据保持"不同项目不撞色"：优先 ≥24°，再退 8°（bestGap 已是最远，直接用它）
      return bestHue;
    }
    /**
     * 登记当前可见的项目名；**只给新项目分配色相**，已有项目一律沿用（不改色）。
     * 这些名单来自会变化的数据源（projectRows / 活会话项目名），所以绝不能在这里重算整表。
     */
    function updateProjectHues(names) {
      loadHueStore();
      const list = [...new Set(names.filter(Boolean))];
      let changed = false;
      for (const name of list) {
        if (hueRegistry.map.has(name)) continue;
        const taken = [...hueRegistry.map.values()];
        const hue = pickFreshHue(taken);
        hueRegistry.store[name] = hue;
        hueRegistry.map.set(name, hue);
        changed = true;
      }
      if (changed) saveHueStore();
    }
    function uniqueHue(seed) {
      loadHueStore();
      const hit = hueRegistry.map.get(String(seed));
      return hit !== undefined ? hit : projectHue(seed);
    }

    /** 插件 apply 时留下的 client 上下文，供组件里取服务。 */
    let clientCtx = null;

    /**
     * 快捷栏「完成未读」注册表（2026-10-24 用户需求）：
     * 会话跑完（running true→false）且不是当前打开的对话 → 记入未读，pill 保留并换成
     * 「✓ 完成」态；用户点开该会话（或它成为当前对话）→ 移出；未读期间再跑 → 清除；
     * 会话归档/消失 → 清除。存 localStorage（`hub.runbar.unread`），DSH 重启不丢。
     * 结构：{ "<sessionId>": { title, at } }
     */
    const RUNBAR_UNREAD_KEY = 'hub.runbar.unread';

    /**
 * 会话「最后一次活动」时间（毫秒）—— 侧栏空闲时长的唯一可靠数据源。
 * 为什么不用 session.updatedAt：DSH 的 sessions 投影里没有这个字段（全代码仅两处
 * `session.updatedAt || 0` 的防御写法，实测恒为 0）。
 * 记录时机：running 由 true 变 false（= 这一轮跑完），或会话打开过。
 */
const LAST_ACTIVE_KEY = 'hub.lastActive';
const lastActiveTimes = (() => {
  try { return JSON.parse(localStorage.getItem(LAST_ACTIVE_KEY) || '{}') || {}; } catch { return {}; }
})();
function markLastActive(id, at) {
  const key = String(id || '');
  if (!key) return;
  lastActiveTimes[key] = Number(at) || Date.now();
  try { localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify(lastActiveTimes)); } catch { /* 存储不可用就算了 */ }
}
function lastActiveOf(id) {
  return Number(lastActiveTimes[String(id || '')]) || 0;
}

function loadRunbarUnread() {
      try {
        const raw = window.localStorage.getItem(RUNBAR_UNREAD_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    function saveRunbarUnread(map) {
      try {
        window.localStorage.setItem(RUNBAR_UNREAD_KEY, JSON.stringify(map));
      } catch (error) {
        console.error('[hub-desktop-ui] save runbar unread failed', error);
      }
    }

    // ── Host 未读同步（2026-11-11 用户报「已读状态手机/桌面不一致」）────────────────
    // 以前桌面存 localStorage `hub.runbar.unread`、手机存自己的 SharedPreferences，各算各的，
    // 天生对不上（而且那个 key 在 LevelDB 里被压缩、手机抠不出来）。
    // 现在 Host 的 `.hub/unread.json` 是**唯一事实源**：
    //   桌面 → 同源 `/hub/unread`（hub-desktop-ui 自己注册的路由）
    //   手机 → 桥的 `/sync/unread`（dsh-sync-bridge）
    // 两边落同一个文件。localStorage 保留为离线缓存，但**以 Host 为准**。
    // 为什么桌面不直连桥：桥要 `Authorization: Bearer <token>`（client 拿不到），
    // 且桥在另一个端口=跨 origin、无 CORS 头。
    const HOST_UNREAD_SYNCED = { ids: new Set(), ready: false };

    /** 把未读变化推给 Host。op = add | remove | clear（增量，不整表覆盖）。 */
    function postHostUnread(op, ids = []) {
      try {
        fetch('/hub/unread', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, ids }),
        }).catch(() => {});
      } catch (error) { /* 网络异常不影响本地显示 */ }
    }

    /**
     * 启动时并入 Host 未读：Host 有的补到本地；本地有而 Host 没有的（离线期间产生的）推回 Host。
     * Host 不可达 → 继续用 localStorage 缓存，不阻塞渲染。
     */
    function syncHostUnreadOnMount(setter) {
      (async () => {
        try {
          const res = await fetch('/hub/unread');
          const data = await res.json();
          if (!data || !data.ok || !Array.isArray(data.list)) return;
          const hostIds = new Set(data.list.map(String));
          const local = loadRunbarUnread() || {};
          const merged = { ...local };
          const now = Date.now();
          for (const id of hostIds) if (!merged[id]) merged[id] = now;
          const localOnly = Object.keys(local).filter((id) => !hostIds.has(id));
          HOST_UNREAD_SYNCED.ids = new Set(hostIds);
          HOST_UNREAD_SYNCED.ready = true;
          if (localOnly.length) postHostUnread('add', localOnly);
          if (Object.keys(merged).length !== Object.keys(local).length) {
            saveRunbarUnread(merged);
            setter(merged);
          }
        } catch (error) { /* Host 不可达 → 用本地缓存 */ }
      })();
    }

    /** 未读表变化后与上次已同步集合求差集，只发增量（add/remove）。 */
    function diffSyncHostUnread(nextMap) {
      const nextIds = new Set(Object.keys(nextMap || {}));
      const prev = HOST_UNREAD_SYNCED.ids;
      const toAdd = [...nextIds].filter((id) => !prev.has(id));
      const toRemove = [...prev].filter((id) => !nextIds.has(id));
      if (toAdd.length) { postHostUnread('add', toAdd); for (const id of toAdd) prev.add(id); }
      if (toRemove.length) { postHostUnread('remove', toRemove); for (const id of toRemove) prev.delete(id); }
    }

    /**
     * 侧栏缩放（2026-10-25 用户要求「侧边栏的网页要能缩放」）：
     * Ctrl/⌘ + 滚轮在侧栏区域调 --hub-sidebar-zoom（0.6–2.0，**步进 0.1** 保证肉眼可见），
     * Ctrl/⌘ + 0 复位 1；值持久化 localStorage。每次变更弹 1.2s 百分比提示，并上报
     * /hub/client-error（kind=sidebar-zoom*）便于取证。0.05 步进实测「看不出来」→ 已加大。
     */
    const SIDEBAR_ZOOM_KEY = 'hub.sidebar.zoom';
    const SIDEBAR_ZOOM_MIN = 0.6;
    const SIDEBAR_ZOOM_MAX = 2;
    const SIDEBAR_ZOOM_STEP = 0.1;

    function clampSidebarZoom(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return 1;
      return Math.min(SIDEBAR_ZOOM_MAX, Math.max(SIDEBAR_ZOOM_MIN, Math.round(n * 100) / 100));
    }

    /** 上报一条缩放事件到 /hub/client-error（诊断通道，失败静默）。 */
    function reportSidebarZoom(kind, payload) {
      try {
        fetch('/hub/client-error', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, at: new Date().toISOString(), ...payload }),
        }).catch(() => {});
      } catch (error) { /* 上报失败不影响 */ }
    }

    /** 缩放变更时在侧栏顶部弹 1.2s 的百分比提示（不加定时巡查，仅一次性 timeout）。 */
    function showSidebarZoomToast(zoom) {
      try {
        let el = document.getElementById('hub-zoom-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'hub-zoom-toast';
          el.style.cssText = 'position:fixed;z-index:4000;left:12px;top:10px;padding:3px 9px;'
            + 'border-radius:9px;background:rgba(20,20,22,.92);color:#ecebe8;font:11px/1.4 system-ui;'
            + 'border:1px solid #2b2b31;pointer-events:none;transition:opacity 160ms';
          document.body.appendChild(el);
        }
        el.textContent = `侧栏 ${Math.round(zoom * 100)}%`;
        el.style.opacity = '1';
        if (showSidebarZoomToast.timer) clearTimeout(showSidebarZoomToast.timer);
        showSidebarZoomToast.timer = setTimeout(() => {
          try { el.style.opacity = '0'; } catch (error) { /* ignore */ }
        }, 1200);
      } catch (error) { /* 提示失败不影响缩放 */ }
    }

    /**
     * 定位**真正可见**的侧栏容器（2026-10-25 实测教训）：
     * `[data-slot="sidebar"]` 只是 0×0 的槽位标记（几何探针：sidebar rect = 0×0，内部芯片
     * 确实随 zoom 缩放——缩的是隐藏树，所以用户「看不出反应」）。这里从侧栏区域实际点位
     * elementFromPoint 反查祖先链里「宽 150–620、高 ≥300」的容器作为缩放目标。
     */
    let sidebarZoomTarget = null;

    /**
     * 2026-10-26 修「拖动侧栏宽度时内容仍被裁（缩放≠1 时）」：
     * 外壳 ui-layout 拖拽时会把列宽以 `<N>px` 内联样式写回**同一个节点**（2026-10-20 注释：
     * 「宽度写在列内节点的内联 style 上」），把我们 applySidebarZoom 写的 calc(100%/zoom)
     * 补偿覆掉 → zoom 1.05 时内容溢出轨道 ~5% 被裁。修法：MutationObserver 盯 style，
     * 发现外壳写了裸 px 且 zoom≠1，就改写成 px/zoom（渲染宽 = 原轨道宽）。
     * 防自触发回环：自己写的值记在 sidebarZoomCompensatedPx，回调里命中即跳过。
     */
    let sidebarZoomObserver = null;
    let sidebarZoomCompensatedPx = null;

    function watchSidebarWidthOverwrite() {
      const target = sidebarZoomTarget;
      if (!target || typeof MutationObserver !== 'function') return;
      if (sidebarZoomObserver) sidebarZoomObserver.disconnect();
      sidebarZoomCompensatedPx = null;
      sidebarZoomObserver = new MutationObserver(() => {
        try {
          // 折叠成窄轨时绝不补偿（否则会把列压成一条，2026-10-27 事故）
          if (document.querySelector('[data-sidebar-collapsed]')) {
            try { target.style.zoom = ''; target.style.width = ''; } catch { /* ignore */ }
            sidebarZoomCompensatedPx = null;
            sidebarZoomObserver.disconnect();
            sidebarZoomObserver = null;
            return;
          }
          const rectW = (() => { try { return target.getBoundingClientRect().width; } catch { return 0; } })();
          if (rectW > 0 && rectW < 72) return;
          const zoom = readSidebarZoom();
          const width = target.style.width;
          if (zoom === 1 || !width || !/px$/.test(width)) return;
          const px = parseFloat(width);
          if (!Number.isFinite(px)) return;
          if (sidebarZoomCompensatedPx !== null
            && Math.abs(px - sidebarZoomCompensatedPx) < 0.51) return; // 自己写的，别再除
          const compensated = px / zoom;
          sidebarZoomCompensatedPx = compensated;
          target.style.width = `${compensated}px`;
        } catch (error) { /* 补偿失败不影响主流程 */ }
      });
      sidebarZoomObserver.observe(target, { attributes: true, attributeFilter: ['style'] });
    }

    function resolveVisibleSidebar() {
      const viewportH = window.innerHeight || 800;
      const points = [[70, 140], [70, Math.round(viewportH * 0.35)], [70, Math.round(viewportH * 0.75)], [130, viewportH - 120]];
      const starts = [];
      for (const [x, y] of points) {
        try {
          const el = document.elementFromPoint(x, y);
          if (el) starts.push(el);
        } catch (error) { /* 点位越界忽略 */ }
      }
      for (const start of starts) {
        let node = start;
        for (let i = 0; node && i < 12; i += 1) {
          const rect = node.getBoundingClientRect();
          if (rect.width >= 150 && rect.width <= 620 && rect.height >= 300
            && node.children && node.children.length > 1) return node;
          node = node.parentElement;
        }
      }
      return document.querySelector('[data-slot="sidebar"]'); // 兜底：原槽位
    }

    function applySidebarZoom(value, options = {}) {
      const before = readSidebarZoom();
      const zoom = clampSidebarZoom(value);
      try {
        document.documentElement.style.setProperty('--hub-sidebar-zoom', String(zoom));
        window.localStorage.setItem(SIDEBAR_ZOOM_KEY, String(zoom));
        // 关键：给**可见容器**挂内联 zoom（CSS 选择器只命中 0×0 槽位标记，不够）
        // ⚠️ 2026-10-25 修「放大后原生按钮被裁」：zoom 放大内容但列宽（grid 轨道 264px）
        // 不变 → 内容超出被 overflow 裁切。这里同时把容器 CSS 宽度设为 calc(100% / zoom)：
        // 渲染后实际宽度仍等于轨道宽，内容按放大后的字号重新排版而不是溢出。
        const target = resolveVisibleSidebar();
        if (target) {
          if (sidebarZoomTarget && sidebarZoomTarget !== target) {
            try {
              sidebarZoomTarget.style.zoom = '';
              sidebarZoomTarget.style.width = '';
            } catch (error) { /* ignore */ }
          }
          // ⚠️ 2026-10-27 事故：折叠成窄轨（~26–56px）时这里仍写 `width: calc(100%/zoom)`，
          // 但此时 100% 基准是个 shrink-to-fit 的父级，算出来只有几 px → 内联宽度把整列压成
          // 一条（实测 w=26 / width=4.818px）。折叠态一律不写补偿，并把脏内联样式清掉。
          const collapsed = document.documentElement.hasAttribute('data-sidebar-collapsed')
            || Boolean(document.querySelector('[data-sidebar-collapsed]'));
          const rectW = (() => { try { return target.getBoundingClientRect().width; } catch { return 0; } })();
          const rail = collapsed || rectW < 72;
          if (rail) {
            try { target.style.zoom = ''; target.style.width = ''; } catch { /* ignore */ }
            if (sidebarZoomObserver) { sidebarZoomObserver.disconnect(); sidebarZoomObserver = null; }
            sidebarZoomCompensatedPx = null;
            sidebarZoomTarget = null;
            return zoom;
          }
          sidebarZoomTarget = target;
          target.style.zoom = String(zoom);
          target.style.width = zoom === 1 ? '' : `calc(100% / ${zoom})`;
          // 2026-10-26：拖拽时外壳会用裸 px 覆写同一节点的 width，盯住并再补偿
          if (zoom === 1) {
            if (sidebarZoomObserver) { sidebarZoomObserver.disconnect(); sidebarZoomObserver = null; }
            sidebarZoomCompensatedPx = null;
          } else {
            watchSidebarWidthOverwrite();
          }
        }
      } catch (error) { /* 设置失败不影响主流程 */ }
      if (options.silent !== true && zoom !== before) {
        showSidebarZoomToast(zoom);
        reportSidebarZoom('sidebar-zoom', {
          from: before, to: zoom, trigger: options.trigger || 'unknown',
          target: (() => {
            try {
              const r = sidebarZoomTarget ? sidebarZoomTarget.getBoundingClientRect() : null;
              return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
            } catch (error) { return null; }
          })(),
        });
      }
      return zoom;
    }

    function readSidebarZoom() {
      try {
        const raw = window.localStorage.getItem(SIDEBAR_ZOOM_KEY);
        return raw === null ? 1 : clampSidebarZoom(raw);
      } catch (error) {
        return 1;
      }
    }

    /**
     * 侧栏忽略名单（2026-10-24 用户令「subagent 会话不进侧栏」）：DSH subagent/child
     * 子会话是内部机制产物，不该出现在侧栏。识别 = 首条用户消息含 DSH 注入标记
     * `parent agent id is`（活会话 header.origin 不可达时的内容侧证据；实测 0f7c7458 等
     * 全带）。名单持久化 localStorage，重启不丢；「清空」归档失败的目标也进这份名单。
     */
    const LOOSE_HIDDEN_KEY = 'hub.loose.hidden';
    const SUBAGENT_MARKER_RE = /parent agent id is/i;

    function loadLooseHidden() {
      try {
        const raw = window.localStorage.getItem(LOOSE_HIDDEN_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch (error) {
        return [];
      }
    }

    function saveLooseHidden(list) {
      try {
        window.localStorage.setItem(LOOSE_HIDDEN_KEY, JSON.stringify([...new Set(list.map(String))]));
      } catch (error) {
        console.error('[hub-desktop-ui] save loose hidden failed', error);
      }
    }

    /** 探测一个会话是否 subagent 子会话。
     * 2026-10-29（用户报「分身开到临时对话」）：subagent 子会话的 events 走
     * /hub/session-events 读不到（live:false total:0）→ 旧逻辑恒判 false → 不隐藏、
     * 掉侧栏临时区。权威标记在 projcache 的 record.rows.subagent，先问 host 新路由；
     * 路由不可用再回退旧的"读首条用户消息找注入标记"判法。 */
    async function probeIsSubagent(id) {
      try {
        const res = await fetch(`/hub/session-subagent?session=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (data && data.ok) return Boolean(data.subagent);
      } catch (error) { /* 回退旧判法 */ }
      try {
        const res = await fetch(`/hub/session-events?session=${encodeURIComponent(id)}&limit=20`);
        const data = await res.json();
        const evs = (data && data.events) || [];
        const first = evs.find((e) => e && e.type === 'user/message' && e.data && e.data.message);
        if (!first) return false;
        const text = (Array.isArray(first.data.message.content) ? first.data.message.content : [])
          .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('');
        return SUBAGENT_MARKER_RE.test(text);
      } catch (error) {
        return null; // 查不到（网络/冷会话）——调用方应允许重试
      }
    }

    /** 2026-10-29：带父信息的 subagent 探测——/hub/session-subagent 返回
     *  {ok, subagent, label, parentTitle}（parentTitle 由 host 懒扫活会话 events 里的
     *  `started subagent <id>` 反查）。返回 null = 查不到（调用方允许重试）。 */
    async function probeSubagentInfo(id) {
      try {
        const res = await fetch(`/hub/session-subagent?session=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (data && data.ok) {
          return {
            subagent: Boolean(data.subagent),
            label: String(data.label || ''),
            parentTitle: String(data.parentTitle || ''),
          };
        }
        return null;
      } catch (error) {
        return null;
      }
    }

    // 快捷栏「完成未读」纯逻辑（2026-10-24）。纯函数、不碰 window/DOM：
    // 输入上一拍 running 快照、当前未读表、byId、当前打开会话 id，输出新快照与更新后
    // 未读表。单测用标记提取本段，不要移出下面两个标记注释。
    // RUNBAR-PURE-START
    function computeRunbarUnread(input) {
      const byId = (input && input.byId) || {};
      const prevRunning = input && input.prevRunning instanceof Set ? input.prevRunning : new Set();
      const unreadIn = (input && input.unread) || {};
      const currentId = input ? (input.currentId || null) : null;
      const archivedIds = input && input.archivedIds instanceof Set ? input.archivedIds : new Set();
      const now = (input && Number(input.now)) || Date.now();
      const nextRunning = new Set();
      const unread = { ...unreadIn };
      let changed = false;
      for (const session of Object.values(byId)) {
        if (!session || session.blank) continue;
        const id = String(session.id);
        if (session.running) {
          nextRunning.add(id);
          // 未读期间再跑 → 回运行态，未读清除（验收情形④）
          if (unread[id]) { delete unread[id]; changed = true; }
        } else if (prevRunning.has(id)) {
          // running true→false 翻转：当前打开的会话不标未读（情形③），其余记入（情形①）
          if (currentId && id === String(currentId)) {
            if (unread[id]) { delete unread[id]; changed = true; }
          } else if (!unread[id]) {
            unread[id] = { title: session.displayTitle || '', at: now };
            changed = true;
          }
        }
      }
      // 会话归档/从 byId 消失 → 未读一并清除
      // 2026-10-28 修「快捷栏一直显示旧壳」：归档的会话**仍留在 byId 里**，只判 !byId[id]
      // 永远清不掉 → 旧壳的「✓完成」pill 常驻。归档集合必须一并判。
      // 另一条更常见成因：重名守卫（index.js L548-551）对同重名旧壳**只改名不归档**，
      // 标题被写成「<标题>（旧壳 MM-DD）」→ 会话仍在 byId 且未归档 → 这里按标题再判一次。
      for (const id of Object.keys(unread)) {
        const title = String((byId[id] && byId[id].displayTitle) || '');
        if (!byId[id] || archivedIds.has(String(id)) || /（旧壳\s/.test(title)) {
          delete unread[id];
          changed = true;
        }
      }
      // 当前打开的会话若还在未读表 → 已读移出（点开即读，验收情形②）
      if (currentId && unread[String(currentId)]) { delete unread[String(currentId)]; changed = true; }
      return { nextRunning, unread, changed };
    }
    /* RUNBAR-PURE-END */

    /** 房间待办队列（按项目存 localStorage）。 */
    function loadRoomTodos(project) {
      try {
        const raw = window.localStorage.getItem(`hub.room.todos.${project}`);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    }

    function saveRoomTodos(project, list) {
      try {
        window.localStorage.setItem(`hub.room.todos.${project}`, JSON.stringify(list));
      } catch (error) {
        console.error('[hub-desktop-ui] save room todos failed', error);
      }
      // 顺手落一份到 Host（.hub/projects/<项目>/queue.json）：手机端 /sync/queue 读同一份，
      // 否则手机端永远看不到房间待办（它读不到桌面浏览器 localStorage）。
      try {
        fetch('/hub/queue', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project, list }),
        }).catch(() => {});
      } catch (error) { /* Host 未起就只留在 localStorage */ }
    }

    // 队列驱动器：不依赖房间是否打开——侧栏常驻组件每 2.5s 调一次。
    const queueInFlight = new Set();
    const queuePrevRunning = new Map();
    const queueFinished = new Set();
    // 中断闸门缓存：target → { at, interrupted }（5s 内复用，见 driveRoomQueues）
    const resumeCheckCache = new Map();
    // 插件（页面）加载时刻：闸门用它判断「是不是还在开机宽限期」——
    // 重启瞬间 Host 路由未就绪时不能 fail-open 把排队消息抢先发进去。
    const appBootAt = Date.now();
    const queueRefs = new Map();

    function roomTodoProjects() {
      const keys = [];
      try {
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (key && key.startsWith('hub.room.todos.')) keys.push(key);
        }
      } catch (error) {
        return [];
      }
      return keys.map((key) => key.slice('hub.room.todos.'.length));
    }

    /**
     * 统一的投递入口（2026-10-22）：走 Host 的 `POST /hub/prompt`。
     * 旧实现用 `sessions.retain(id).ready → binding.session.prompt(text,'queue')`，
     * 那条路**不会唤醒冷会话** —— Book · Yat2 处于冷态时消息只入队、agent 从不启动，
     * 表现为「群聊发消息没反应」。Host 侧会先 resolveAgent 唤醒再 queue 投递。
     * @returns {Promise<{ok:boolean, woke:boolean, error?:string}>} 不抛错，调用方决定怎么提示
     */
    async function hubPrompt(sessionId, text) {
      const body = String(text || '');
      if (!body.trim()) return { ok: false, woke: false, error: '消息为空' };
      try {
        const res = await fetch('/hub/prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: String(sessionId || ''), text: body }),
        });
        const data = await res.json();
        return {
          ok: Boolean(data && data.ok),
          woke: Boolean(data && data.woke),
          error: data && data.error ? String(data.error) : '',
        };
      } catch (error) {
        return { ok: false, woke: false, error: String((error && error.message) || error) };
      }
    }

    async function sendQueueMessage(targetId, text) {
      const r = await hubPrompt(targetId, text);
      if (!r.ok) throw new Error(r.error || '投递失败');
      return true;
    }

    /**
     * 分列列内发言：走同一个 `/hub/prompt`（会唤醒冷会话）；失败抛错，列内显示。
     */
    async function promptSession(sessionId, text) {
      const r = await hubPrompt(sessionId, text);
      if (!r.ok) throw new Error(r.error || '投递失败');
      return true;
    }

    /**
     * 驱动所有项目的待办队列：迁移旧状态、把在飞的那条收口、再放下一条。
     * @param {Record<string, {running?: boolean, displayTitle?: string}>} byId 会话状态表。
     * @param {Set<string>} archivedIds 已归档会话集合（同名旧壳改投用）。
     */
    async function driveRoomQueues(byId, archivedIds) {
      const archivedSet = archivedIds instanceof Set ? archivedIds : new Set(archivedIds || []);
      for (const [id, session] of Object.entries(byId || {})) {
        const running = Boolean(session && session.running);
        const before = queuePrevRunning.get(id);
        if (before === true && running === false) queueFinished.add(id);
        queuePrevRunning.set(id, running);
      }

      for (const project of roomTodoProjects()) {
        let list = loadRoomTodos(project);
        let changed = false;
        // 旧版本留下的 'pending' 条目：当时已经直接发给 Yat2 了，迁移成 done，避免重复投递。
        // 没有 target 的条目同理（早期版本没记目标，无从投递）。
        list = list.map((todo) => {
          const legacy = todo.status === 'pending' || (!todo.target && todo.status !== 'done');
          if (!legacy) return todo;
          changed = true;
          return { ...todo, status: 'done', doneAt: todo.doneAt || todo.ts };
        });

        list = list.map((todo) => {
          if (todo.status !== 'sending') return todo;
          const target = todo.target;
          const idle = !(byId[target] && byId[target].running);
          const done = queueFinished.has(target) || (idle && Date.now() - (todo.sentAt || todo.ts) > 15000);
          if (!done) return todo;
          changed = true;
          return { ...todo, status: 'done', doneAt: Date.now() };
        });

        if (!list.some((todo) => todo.status === 'sending')) {
          const next = list.find((todo) => todo.status === 'queued');
          if (next && !queueInFlight.has(next.id)) {
            // 本地判忙时向 Host 权威二次确认（2026-10-23）：liveRunning 在多次重启后可能
            // 残留假 running（漏 idle 事件）→ 泵永远认为目标忙 → 待办永不发送（Tiddlywiki 案例：
            // UI 一直显示排队、Host 镜像/会话零动静）。Host agents.get(id).status 才是真源。
            let idle = !(byId[next.target] && byId[next.target].running);
            if (!idle) {
              try {
                const res = await fetch(`/hub/is-running?session=${encodeURIComponent(next.target)}`);
                const data = await res.json();
                if (data && data.ok && !data.running) {
                  idle = true;
                  liveRunning.delete(next.target); // 清掉假 running
                }
              } catch (error) { /* Host 不可用时按本地判定 */ }
            }
            // —— 中断闸门（2026-10-22，2026-10-23 修 fail-open）——
            // 重启后被打断的会话尾部是 interrupted：若此刻把 queued 消息发进去，
            // 它会把断点工作当旧上下文、新消息又叠上去。先查 Host（与续跑扫描同源判定），
            // 有中断 → 保持 queued，等【续跑】cue 注入并跑完（尾部恢复 complete →
            // interrupted=false）再发。无中断 → 照旧立即发（不拖慢正常排队）。
            // 结果缓存 5s/目标，避免队列泵每拍都打 Host。
            //
            // ⚠️ 2026-10-23 实测修正：原来 catch 里 `interrupted = false`（放行）——
            // 重启瞬间 Host 的 /hub/resume-check 路由还没挂好，fetch 直接抛错 →
            // 闸门当成「无中断」→ **排队消息抢在【续跑】前面投递**（用户报的现象）。
            // 现在改成：开机 90 秒宽限期内读不到 Host 一律**挂起**（等路由就绪/等续跑），
            // 宽限期外才 fail-open（防止 Host 长期不可用时队列永久卡死）。
            let interrupted = false;
            if (idle) {
              const cached = resumeCheckCache.get(next.target);
              if (cached && Date.now() - cached.at < 5000) {
                interrupted = cached.interrupted;
              } else {
                try {
                  const res = await fetch(`/hub/resume-check?session=${encodeURIComponent(next.target)}`);
                  const data = await res.json();
                  interrupted = Boolean(data && data.interrupted);
                  resumeCheckCache.set(next.target, { at: Date.now(), interrupted });
                } catch (error) {
                  const uptime = Date.now() - appBootAt;
                  // 开机宽限期内 Host 还没就绪 → 保守挂起，别把排队消息抢先发进去
                  interrupted = uptime < 90000;
                  if (interrupted) {
                    console.warn('[hub-desktop-ui] resume-check unreachable during boot grace; holding queue');
                  }
                }
              }
            }
            if (idle && !interrupted) {
              queueInFlight.add(next.id);
              list = list.map((todo) => (todo.id === next.id
                ? { ...todo, status: 'sending', sentAt: Date.now() }
                : todo));
              saveRoomTodos(project, list);
              changed = true;
              try {
                // 投递完整正文（旧数据没有 fullText → 回退到 text）
                await sendQueueMessage(next.target, next.fullText || next.text);
              } catch (error) {
                console.error('[hub-desktop-ui] queue send failed', error);
                window.__queueErr = String((error && error.message) || error);
                // 2026-10-22 修队列死锁（Book·旧壳案例）：目标已归档是**终态错误**——
                // 直接回 queued 会无限重试。先找**同名现役会话**改投（旧壳陷阱的标准解法，
                // 与管理者协议"重建后写回新 id"同一口径）；找不到现役才标 failed 终止。
                const message = String((error && error.message) || error);
                let patched = null;
                if (/已归档/.test(message)) {
                  const staleTitle = byId[next.target] && byId[next.target].displayTitle;
                  const heir = staleTitle
                    ? Object.values(byId).find((s) => s && s.id !== next.target
                      && s.displayTitle === staleTitle && !archivedSet.has(String(s.id)))
                    : undefined;
                  if (heir && !(next.redirects >= 1)) {
                    patched = { target: String(heir.id), status: 'queued', redirects: (next.redirects || 0) + 1 };
                  }
                }
                list = loadRoomTodos(project).map((todo) => (todo.id === next.id
                  ? {
                    ...todo,
                    ...(patched || { status: 'failed', error: message }),
                  }
                  : todo));
              } finally {
                queueInFlight.delete(next.id);
                queueFinished.delete(next.target);
              }
            }
          }
        }

        if (changed) {
          saveRoomTodos(project, list);
          try { window.dispatchEvent(new Event('hub-todos')); } catch (error) { /* ignore */ }
        }
      }
    }

    /** 项目管理者（主控 agent）的名字：新叫 Yat2，兼容旧的 Hermes。 */
    const MANAGER_NAMES = ['Yat2', 'Hermes'];

    /** 粘贴图片：剪贴板里有图片就上传成临时文件，把路径回填进输入框。 */
    function pasteImages(event, applyPaths) {
      const dt = event.clipboardData || event.dataTransfer;
      if (!dt) return;
      // files 与 items 两条路都取：Windows 截图粘贴有时只在 items 里
      // （与全局「非视觉模型发图兜底」的取法保持一致，2026-11-04）
      const files = [];
      for (const file of Array.from(dt.files || [])) {
        if (file && typeof file.type === 'string' && file.type.startsWith('image/')) files.push(file);
      }
      if (files.length === 0 && dt.items) {
        for (const item of Array.from(dt.items)) {
          if (item && item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/')) {
            const file = item.getAsFile && item.getAsFile();
            if (file) files.push(file);
          }
        }
      }
      if (files.length === 0) return;
      event.preventDefault();
      (async () => {
        const paths = [];
        for (const file of files) {
          try {
            const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
            const res = await fetch(`/hub/upload?ext=${encodeURIComponent(ext)}`, { method: 'POST', body: file });
            const data = await res.json();
            if (data && data.ok && data.path) paths.push(data.path);
            else console.error('[hub-desktop-ui] paste upload failed', data);
          } catch (error) {
            console.error('[hub-desktop-ui] paste upload failed', error);
          }
        }
        if (paths.length > 0) applyPaths(paths);
      })();
    }

    /**
     * 默认头像（emoji）；可在 tasks.json 里给成员加 `"avatar": "🎨"` 覆盖。
     * 用户自己用「我」这个 key，同样可覆盖。
     */
    // 全员统一头像表（2026-10-23 定稿，用户三条规定）：
    // ① 唯一权威来源，不再读 tasks.json 单独登记；② 全表 emoji 无重复（不同角色不撞头像）；
    // ③ 不含「工程师」这类宽泛角色。
    const DEFAULT_AVATARS = {
      Yat2: '🦉',
      Hermes: '🤖',
      'QQ机器人管家': '🐧',
      'DSH工程师': '🛠️',
      'DSH sync工程师': '🌐',
      'Hermes 工程师': '🔨',
      'Stelscala 工程师': '🖥️',
      'Cashew Local 工程师': '📦',
      '千问语音工程师': '🎤',
      '余额监控工程师': '💰',
      'TW应用工程师': '📱',
      '出题工程师': '✍️',
      'A股分析师': '📈',
      '雨课堂': '🎓',
      '书童': '📖',
      '秘书': '🗓️',
      '管家': '🎩',
      '流程搭档': '🔁',
      '旅游规划师': '🧭',
      '绘图师': '🎨',
      '汇报师': '📋',
      '文献管家': '🗂️',
      '维基管家': '📚',
      '单细胞师': '🧬',
      'B细胞专家': '🔬',
      '骨髓专家': '🦴',
      '骨髓衰老研究': '⏳',
      '胸腺专家': '🛡️',
      '视网膜专家': '👁️',
      '我': '🧑',
    };

    /** 行内 markdown：**粗体**、`代码`、[文字](链接)。 */
    function renderInline(text, keyPrefix) {
      const source = String(text || '');
      const out = [];
      const re = /(!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      let cursor = 0;
      let match;
      let index = 0;
      while ((match = re.exec(source)) !== null) {
        if (match.index > cursor) out.push(source.slice(cursor, match.index));
        const token = match[0];
        const key = `${keyPrefix}-i${index++}`;
        if (token.startsWith('![')) {
          const alt = token.slice(2, token.indexOf(']'));
          const raw = token.slice(token.indexOf('](') + 2, -1);
          out.push(h('img', {
            key,
            src: /^https?:/i.test(raw) ? raw : `api/file?path=${encodeURIComponent(raw)}`,
            alt,
            style: { maxWidth: '100%', borderRadius: '6px', margin: '4px 0', display: 'block', cursor: 'zoom-in' },
          }));
        } else if (token.startsWith('**')) {
          out.push(h('strong', { key, style: { fontWeight: 600 } }, token.slice(2, -2)));
        } else if (token.startsWith('`')) {
          out.push(h('code', {
            key,
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.92em', padding: '0 4px', borderRadius: '4px',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          }, token.slice(1, -1)));
        } else {
          const label = token.slice(1, token.indexOf(']'));
          const url = token.slice(token.indexOf('](') + 2, -1);
          out.push(h('a', { key, href: url, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary)' } }, label));
        }
        cursor = match.index + token.length;
      }
      if (cursor < source.length) out.push(source.slice(cursor));
      return out.length === 0 ? source : out;
    }

    /**
     * 轻量 markdown 渲染（公共看板 / 群聊消息共用）：
     * 支持 ```代码块```、#~#### 标题、- / 1. 列表、> 引用（含 GFM callout 卡片）、--- 分隔线、:::标签 面板、行内粗体/代码/链接。
     */

    /** GFM callout 类型表：五种标准类型各配图标+主色；未知类型（如 [!BOOK]）走通用兜底。 */
    const CALLOUT_TYPES = {
      NOTE: { icon: 'ℹ️', accent: '#4493f8', name: 'Note' },
      TIP: { icon: '💡', accent: '#3fb950', name: 'Tip' },
      IMPORTANT: { icon: '❗', accent: '#ab7df8', name: 'Important' },
      WARNING: { icon: '⚠️', accent: '#d29922', name: 'Warning' },
      CAUTION: { icon: '⛔', accent: '#f85149', name: 'Caution' },
    };

    function renderMarkdown(text) {
      const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
      const blocks = [];
      let index = 0;
      let blockKey = 0;
      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!trimmed) { index += 1; continue; }
        // 代码块
        if (trimmed.startsWith('```')) {
          const lang = trimmed.slice(3).trim();
          const body = [];
          index += 1;
          while (index < lines.length && !lines[index].trim().startsWith('```')) {
            body.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push(h('pre', {
            key: `b${blockKey++}`,
            style: {
              margin: '6px 0', padding: '8px 10px', borderRadius: '8px', overflowX: 'auto',
              background: 'var(--dsw-alias-bg-layer-2)', fontSize: '11px', lineHeight: 1.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            },
          }, h('code', null, body.join('\n'))));
          if (lang) { /* 语言标记暂不参与高亮 */ }
          continue;
        }
        // :::标签 面板（对齐 Hermes 的「📖 原文」带读渲染）：
        // `:::原文` 开、单独一行 `:::` 闭；未闭合的按普通段落处理（不吞后面的内容）。
        // 体内递归 renderMarkdown——面板里的标题/列表/```代码块``` 照常渲染。
        if (/^:::\S+\s*$/.test(trimmed)) {
          const label = trimmed.slice(3).trim();
          let close = -1;
          for (let j = index + 1; j < lines.length; j += 1) {
            if (lines[j].trim() === ':::') { close = j; break; }
          }
          if (close !== -1) {
            const body = lines.slice(index + 1, close).join('\n');
            const icon = label.includes('原文') ? '📖' : '📎';
            blocks.push(h('div', {
              key: `b${blockKey++}`,
              style: {
                margin: '6px 0', borderRadius: '8px', overflow: 'hidden',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-1)',
              },
            },
            h('div', {
              style: {
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '5px 10px', fontSize: '11px', fontWeight: 600,
                color: 'var(--dsw-alias-label-secondary)',
                borderBottom: '1px solid var(--dsw-alias-border-l1)',
              },
            }, `${icon} ${label}`),
            h('div', { style: { padding: '6px 10px' } }, ...renderMarkdown(body))));
            index = close + 1;
            continue;
          }
          // 没有闭合行：落到下方段落分支，:::原文 按字面文本显示
        }
        // 分隔线
        if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
          blocks.push(h('hr', {
            key: `b${blockKey++}`,
            style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '8px 0' },
          }));
          index += 1;
          continue;
        }
        // 标题
        const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
        if (heading) {
          const level = heading[1].length;
          const size = level === 1 ? 15 : level === 2 ? 13.5 : level === 3 ? 12.5 : 12;
          blocks.push(h('div', {
            key: `b${blockKey++}`,
            style: {
              fontSize: `${size}px`, fontWeight: 600, margin: level <= 2 ? '10px 0 4px' : '8px 0 3px',
              color: 'var(--dsw-alias-label-primary)',
            },
          }, renderInline(heading[2], `b${blockKey}`)));
          index += 1;
          continue;
        }
        // 引用（含 GFM callout：`> [!TYPE]` 渲染成卡片）
        if (trimmed.startsWith('>')) {
          const body = [];
          while (index < lines.length && lines[index].trim().startsWith('>')) {
            body.push(lines[index].trim().replace(/^>\s?/, ''));
            index += 1;
          }
          // callout 判定：引用体首行 `[!TYPE]`（可带自定义标题）。
          // 标准五类各有图标+配色；未知类型（如 [!BOOK]）按通用卡片兜底，标题行显示类型名。
          const marker = /^\[!([\w-]+)\]\s*(.*)$/.exec((body[0] || '').trim());
          if (marker) {
            const type = marker[1].toUpperCase();
            const customTitle = marker[2].trim();
            const contentLines = body.slice(1).join('\n').trim();
            // [!BOOK] 书摘卡片：与 Hermes alert（alert.tsx）+ 会话里的 hub-callout 插件同款——
            // 1px 细边框 + 8px 圆角 + 「📖 原文」13px/600 标题 + 衬线正文（Times 0.95rem/1.7）。
            // 标记行后面的文字（如书名章节）按 Hermes 的规则落进正文，不做标题。
            if (type === 'BOOK') {
              const bookBody = [customTitle, contentLines].filter(Boolean).join('\n\n');
              blocks.push(h('div', {
                key: `b${blockKey++}`,
                style: {
                  margin: '8px 0', borderRadius: '8px', padding: '8px 12px', minWidth: 0,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 25%, transparent)',
                },
              },
              h('div', {
                key: 'head',
                style: {
                  display: 'flex', alignItems: 'center', gap: '6px',
                  marginBottom: bookBody ? '4px' : 0,
                  color: 'var(--dsw-alias-label-secondary)', fontWeight: 600, fontSize: '13px',
                },
              },
              h('span', { key: 'icon' }, '📖'),
              h('span', { key: 'label' }, '原文')),
              bookBody ? h('div', {
                key: 'body',
                style: {
                  fontFamily: "'Times New Roman', 'Liberation Serif', Georgia, serif",
                  fontSize: '0.95rem', lineHeight: 1.7, minWidth: 0,
                },
              }, ...renderMarkdown(bookBody)) : null));
              continue;
            }
            const def = CALLOUT_TYPES[type] || { icon: '🏷️', accent: 'var(--dsw-alias-label-secondary)', name: type };
            blocks.push(h('div', {
              key: `b${blockKey++}`,
              style: {
                margin: '6px 0', borderRadius: '8px', padding: '7px 10px 7px 12px', minWidth: 0,
                borderLeft: `3px solid ${def.accent}`,
                background: `color-mix(in srgb, ${def.accent} 13%, transparent)`,
              },
            },
            h('div', {
              key: 'head',
              style: {
                display: 'flex', alignItems: 'center', gap: '6px',
                marginBottom: contentLines ? '4px' : 0,
                color: def.accent, fontWeight: 600, fontSize: '11px',
              },
            },
            h('span', { key: 'icon' }, def.icon),
            h('span', { key: 'label' }, customTitle || def.name)),
            contentLines ? renderMarkdown(contentLines) : null));
            continue;
          }
          blocks.push(h('blockquote', {
            key: `b${blockKey++}`,
            style: {
              margin: '6px 0', padding: '2px 10px', borderLeft: '2px solid var(--dsw-alias-border-l2)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, renderInline(body.join(' '), `b${blockKey}`)));
          continue;
        }
        // 列表（有序 / 无序）
        const bullet = /^([-*+]|\d+\.)\s+(.*)$/.exec(trimmed);
        if (bullet) {
          const ordered = /\d+\./.test(bullet[1]);
          const items = [];
          while (index < lines.length) {
            const current = /^([-*+]|\d+\.)\s+(.*)$/.exec(lines[index].trim());
            if (!current) break;
            items.push(h('li', { key: `l${items.length}`, style: { marginLeft: ordered ? '16px' : '14px' } },
              renderInline(current[2], `b${blockKey}-${items.length}`)));
            index += 1;
          }
          blocks.push(h(ordered ? 'ol' : 'ul', {
            key: `b${blockKey++}`,
            style: { margin: '4px 0', paddingLeft: '4px', listStyle: ordered ? 'decimal' : 'disc' },
          }, ...items));
          continue;
        }
        // 表格：| a | b |  下一行是 |---|---|
        if (trimmed.includes('|') && index + 1 < lines.length
          && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1].trim())) {
          const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
          const headerCells = splitRow(line);
          index += 2;
          const bodyRows = [];
          while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
            bodyRows.push(splitRow(lines[index]));
            index += 1;
          }
          const cellStyle = {
            border: '1px solid var(--dsw-alias-border-l1)', padding: '3px 7px',
            textAlign: 'left', verticalAlign: 'top',
          };
          blocks.push(h('table', {
            key: `b${blockKey++}`,
            style: { borderCollapse: 'collapse', margin: '6px 0', fontSize: '10.5px', lineHeight: 1.5 },
          },
          h('thead', null, h('tr', null, ...headerCells.map((cell, cellIndex) => h('th', {
            key: `h${cellIndex}`,
            style: { ...cellStyle, background: 'var(--dsw-alias-bg-layer-2)', fontWeight: 600 },
          }, renderInline(cell, `th${blockKey}-${cellIndex}`))))),
          h('tbody', null, ...bodyRows.map((row, rowIndex) => h('tr', { key: `r${rowIndex}` },
            ...row.map((cell, cellIndex) => h('td', {
              key: `c${cellIndex}`,
              style: cellStyle,
            }, renderInline(cell, `td${blockKey}-${rowIndex}-${cellIndex}`))))))));
          continue;
        }
        // 段落（合并到空行为止）
        const paragraph = [];
        while (index < lines.length && lines[index].trim()
          && !lines[index].trim().startsWith('```')
          && !/^(#{1,4})\s/.test(lines[index].trim())
          && !/^([-*+]|\d+\.)\s+/.test(lines[index].trim())
          && !lines[index].trim().startsWith('>')) {
          paragraph.push(lines[index].trim());
          index += 1;
        }
        blocks.push(h('p', {
          key: `b${blockKey++}`,
          style: { margin: '4px 0', lineHeight: 1.6 },
        }, renderInline(paragraph.join(' '), `b${blockKey}`)));
      }
      return blocks;
    }

    /** 头像兜底：先看 tasks.json 的 avatar，再看默认表，最后用首字母。 */
    function avatarOf(name, meta) {
      const key = String(name || '').split('｜')[0].trim();
      const custom = meta && typeof meta.avatar === 'string' ? meta.avatar.trim() : '';
      if (custom) return { emoji: custom };
      const preset = DEFAULT_AVATARS[key] || DEFAULT_AVATARS[name];
      if (preset) return { emoji: preset };
      return { letter: (String(name || '·').trim()[0] || '·').toUpperCase() };
    }

    /** agent 名 → agent preset 的绑定（存在 localStorage，跨项目一致）。 */
    const AGENT_PRESET_KEY = 'hub.agentPresets';
    const PRESET_OPTIONS = ['cordis', 'standard', 'ptc', 'minimal'];
    /** 新建会话/项目一律用 Creator mode（= cordis 预设）。 */
    const DEFAULT_PRESET = 'cordis';

    function loadAgentPresets() {
      try {
        const raw = window.localStorage.getItem(AGENT_PRESET_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    function saveAgentPreset(name, preset) {
      try {
        const map = loadAgentPresets();
        map[name] = preset;
        window.localStorage.setItem(AGENT_PRESET_KEY, JSON.stringify(map));
      } catch (error) {
        console.error('[hub-desktop-ui] save agent preset failed', error);
      }
    }

    /** 取一个客户端服务（拿不到时安静失败）。 */
    function service(name) {
      try {
        return clientCtx ? clientCtx.get(name) : undefined;
      } catch (error) {
        return undefined;
      }
    }

    /**
     * 改会话标题（`ISession.rename` 只能从 binding 拿）：
     * 先 retain 拿引用与 binding，改名后立即 release。
     */
    async function renameSession(id, title) {
      const svc = service('sessions');
      if (!svc || !title) return false;
      let ref;
      try {
        ref = svc.retain(id, { source: 'controllerOperation' });
        const binding = await ref.ready;
        const result = await binding.session.rename(title);
        return Boolean(result && result.ok);
      } catch (error) {
        console.error('[hub-desktop-ui] rename failed', error);
        return false;
      } finally {
        if (ref) ref.release();
      }
    }

    /** 就地改名输入框：Enter 提交、Esc 取消、失焦提交。 */
    function ChipEditor(props) {
      const [value, setValue] = React.useState(props.initial || '');
      const done = React.useRef(false);
      const finish = (commit) => {
        if (done.current) return;
        done.current = true;
        if (commit) props.onCommit(value);
        else props.onCancel();
      };
      return h('input', {
        value,
        autoFocus: true,
        spellCheck: false,
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') finish(true);
          else if (event.key === 'Escape') finish(false);
        },
        onBlur: () => finish(true),
        style: {
          width: '100%',
          height: '22px',
          padding: '0 6px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          fontSize: '11.5px',
          outline: 'none',
        },
      });
    }

    /**
     * 统一时长格式化（芯片运行时长 + 项目行「今日运行」共用）：
     * `<60s` → `12s`；`<60m` → `5m03s`；`>=60m` → `2h30m`（秒省略）；`>=24h` → `1d05h`。
     */
    function formatDuration(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      if (total < 60) return `${total}s`;
      const minutes = Math.floor(total / 60);
      if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
      return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
    }

    /** 单个「智能体芯片」：头像（项目色）+ 名称 + 运行中绿点（旁挂运行时长）；双击改名。
     * 有分身时多一行状态行：`● 任务名 3m12s`（运行中，绿点+时长）/ `○ 任务名`（空闲，暗点），
     * 运行中的排前面；悬停 tooltip 给全量名单。 */
    function AgentChip(props) {
      const { id, title, hint, hue, running, elapsed, active, onOpen, onRename, onContextMenu: onChipContextMenu, onCloneContextMenu, avatar, count, clones } = props;
      const initial = (title.trim()[0] || '·').toUpperCase();
      const chipAvatar = avatarOf(title, { avatar });
      return h(
        'button',
        {
          type: 'button',
          className: 'hub-chip',
          'data-active': active ? '1' : '0',
          title: hint || title,
          // 右键菜单（2026-10-23 用户要求）：改名 / 归档 / 复制 sessionId / 复制标题
          onContextMenu: (event) => {
            if (!onChipContextMenu) return;
            event.preventDefault();
            event.stopPropagation();
            onChipContextMenu({ id, title, x: event.clientX, y: event.clientY });
          },
          onDoubleClick: (event) => {
            event.stopPropagation();
            if (onRename) onRename();
          },
          onClick: (event) => {
            event.stopPropagation();
            onOpen(id);
          },
          style: {
            // 名称完整显示（2026-10-21 杨航令：agent 名不许省略号截断）：
            // 不钉 maxWidth/高度，不 nowrap——长名换行（lineHeight 1.2），芯片宽度按内容自适应，
            // 芯片流 flex-wrap 会把放不下的芯片挤到下一行
            display: 'inline-flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '3px 5px',
            maxWidth: '100%',
            padding: '3px 7px 3px 2px',
            borderRadius: '11px',
            border: '1px solid transparent',
            background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: '11.5px',
            lineHeight: 1.2,
            cursor: 'pointer',
            flex: '0 1 auto',
            minWidth: 0,
            boxSizing: 'border-box',
            overflowWrap: 'anywhere', // 长名/窄栏时按字符换行，永不被父级裁掉
          },
        },
        h(
          'span',
          {
            style: {
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
              fontSize: chipAvatar.emoji ? '12px' : '9px',
              fontWeight: 600,
              color: chipAvatar.emoji ? 'inherit' : '#fff',
              background: chipAvatar.emoji ? 'transparent' : `hsl(${hue} 40% 40%)`,
              lineHeight: 1,
            },
          },
          chipAvatar.emoji || initial,
        ),
        h('span', {
          style: {
            minWidth: 0, flex: '0 1 auto', maxWidth: '100%',
            whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere',
            lineHeight: 1.2,
          },
        }, title),
        // 分身数量徽标：分身不再单独占 chip，改成挂在这里（0 个不显示）
        Number(count) > 0
          ? h('span', {
            // 2026-11-09 取消分列：悬停文案不再说「顶部并列显示」——分列视图已下线，
            // 分身就在本芯片下方作为子行，点谁开谁的独立对话。
            title: `${count} 个分身 · 见下方子行，点哪个开哪个的独立对话`,
            style: {
              flex: '0 0 auto', minWidth: '14px', height: '14px', padding: '0 3px',
              borderRadius: '7px', display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)', font: 'inherit',
              fontSize: '9px', lineHeight: 1, fontVariantNumeric: 'tabular-nums',
            },
          }, String(count))
          : null,
        running
          ? h('span', {
            className: 'hub-running-dot',
            title: '运行中',
            style: {
              width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto',
              background: 'var(--dsw-alias-state-success-primary)',
            },
          })
          : null,
        // 2026-11-09 用户令「我说侧边栏这里」：本体行原来只在 running && elapsed 时显示时长，
        // 空闲就什么都不显示。改成总有值：运行中=已运行时长（绿），空闲=距上次活动（次要色）。
        ((running && elapsed) || updatedAt)
          ? h('span', {
            title: running ? `本轮已运行 ${elapsed || ''}`.trim() : '距上次活动',
            style: {
              flex: '0 0 auto', fontSize: '9px', lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
              color: running ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
            },
          }, running && elapsed ? elapsed : relTime(updatedAt))
          : null,
        // —— 分身状态行（2026-10-21 规则统一：保留，但只列**未归档**分身——
        // 已归档的在数据源头（clonesOf）就被过滤，三处口径同一份名单）：
        // 运行中 `● 名 时长`，空闲 `○ 名` ——
        Array.isArray(clones) && clones.length
          ? h('span', {
            style: {
              flex: '1 1 100%',
              display: 'flex', flexWrap: 'wrap', alignItems: 'center',
              gap: '0 7px', minWidth: 0, paddingTop: '1px',
              fontSize: '9px', lineHeight: 1.3,
              color: 'var(--dsw-alias-label-secondary)',
              fontVariantNumeric: 'tabular-nums',
            },
            title: clones.map((c) => `${c.running ? '●' : '○'} ${c.name}${c.running && c.elapsed ? ` ${c.elapsed}` : '（空闲）'}`).join('\n'),
          },
          ...clones.slice().sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0)).map((c) => h('span', {
            key: c.id,
            title: `${c.name} · ${c.running ? `运行中 ${c.elapsed || ''}`.trim() : '空闲'} · 右键回收`,
            // 右键分身子行 → 回收菜单（2026-11-02 用户要求手动管理分身）
            onContextMenu: (event) => {
              if (!onCloneContextMenu) return;
              event.preventDefault();
              event.stopPropagation();
              onCloneContextMenu({ id: c.id, name: c.name, x: event.clientX, y: event.clientY });
            },
            style: {
              display: 'inline-flex', alignItems: 'center', gap: '3px',
              maxWidth: '100%', minWidth: 0, opacity: c.running ? 1 : 0.65,
              cursor: 'context-menu',
            },
          },
          h('span', {
            style: {
              width: '4px', height: '4px', borderRadius: '50%', flex: '0 0 auto',
              background: c.running
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
            },
          }),
          h('span', {
            style: {
              minWidth: 0, maxWidth: '7em', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, c.name),
          // 2026-11-09 用户令「分身怎么不显示运行时间」：原实现只在 running && elapsed 时显示，
          // 空闲分身什么都不显示 → 用户以为没有。改成总有值：运行中给已运行时长，空闲给距上次活动。
          ((c.running && c.elapsed) || c.updatedAt)
            ? h('span', {
              style: {
                color: c.running ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
                fontVariantNumeric: 'tabular-nums',
              },
              title: c.running ? '已运行' : '距上次活动',
            }, c.running && c.elapsed ? c.elapsed : relTime(c.updatedAt))
            : null,
          )))
          : null,
      );
    }

    /**
     * 侧栏浏览区（替换出厂 WorkspaceBrowser）：项目行 + 芯片网格。
     * 数据只读 workspaces/sessions 快照；点击芯片开会话，点击项目行折叠，
     * 「+」在该项目下起新会话。搜索/拖拽/右键菜单本轮不做。
     */
    /** 相对时间（项目行右侧，和 Hermes 一致）。 */
    function relTime(ms) {
      if (!ms) return '';
      const diff = Date.now() - ms;
      if (diff < 60000) return 'now';
      if (diff < 3600000) return `${Math.round(diff / 60000)}m`;
      if (diff < 86400000) return `${Math.round(diff / 3600000)}h`;
      return `${Math.round(diff / 86400000)}d`;
    }

    /**
     * 从会话标题里切「项目 · 智能体」。
     * 约定同 Hermes：`<项目> · <成员>`，同名会话的 ` (2)` 计数先剥掉；
     * 没有分隔符的会话不算项目成员，作为独立芯片平铺。
     *
     * **严格模式（2026-10-20）**：只有「真像 `项目 · 成员`」的标题才建项目行。
     * 起因：子代理/自动标题会把整段 prompt 当标题（如
     * `你是「骨髓微环境项目 · 工程师」分身（一次性只读盘点任务）…` 被截成
     * `你是「骨髓微环境项目 · 工程`），里面恰好含 ` · `，于是侧栏凭空多出一行
     * 假项目 `你是「骨髓微…` + 芯片 `工程`。句子型标题一律回落到共享项目。
     */
    const TITLE_SENTENCE_CHARS = /[「」『』《》【】（）()[\]{}<>“”‘’"'。，、；;：:！!？?…—\n\r\t]/;
    const TITLE_SENTENCE_PREFIXES = [
      '你是', '请您', '请你', '帮我', '以下', '任务', '需要你', '请以', '分身', '这是', '现在',
    ];

    function splitSessionTitle(raw) {
      const text = String(raw || '').replace(/\s*\(\d+\)\s*$/, '').trim();
      const at = text.lastIndexOf(' · ');
      const onlyOne = at > 0 && text.indexOf(' · ') === at;
      if (onlyOne && text.length <= 60) {
        const project = text.slice(0, at).trim();
        const agent = text.slice(at + 3).trim();
        const agentBase = agent.split('｜')[0].trim();
        const looksLikeName = (part, max) => part.length > 0 && part.length <= max
          && !TITLE_SENTENCE_CHARS.test(part);
        const sentencey = TITLE_SENTENCE_PREFIXES.some((prefix) => (
          text.startsWith(prefix) || agent.startsWith(prefix)
        ));
        if (looksLikeName(project, 24) && looksLikeName(agent, 32)
          && looksLikeName(agentBase, 20) && !sentencey) {
          return { project, agent };
        }
      }
      return { project: null, agent: text || '未命名' };
    }

    /**
     * 分身命名约定 `<成员>｜<任务名>`（`｜` 是全角竖线）。
     * 拆成 { base: 成员名, task: 任务名 }；不是分身（没有 `｜` / 在开头 / 任务名为空）返回 null。
     *
     * 为什么按标题判父子、而不是用 session header：DSH 的 `SessionHeader.origin`
     * 只有 `'subagent'` 一个取值（sessions.create 的 meta 里也只接受这个名字），
     * 而本项目的分身是 `taskline_create` 建的**普通会话**再改名，header 里没有
     * parentSession —— 所以父子关系只能落在标题前缀上。
     */
    const CLONE_SEP = '｜';

    function cloneSplitLabel(label) {
      const text = String(label || '').trim();
      const at = text.indexOf(CLONE_SEP);
      if (at <= 0) return null;
      const task = text.slice(at + CLONE_SEP.length).trim();
      if (!task) return null;
      return { base: text.slice(0, at).trim(), task };
    }

    /**
     * 分身标题的解析（比 splitSessionTitle 宽一格）：分身标题一定是
     * `<项目> · <成员>｜<任务>`，任务名一长，splitSessionTitle 的名字长度上限
     * 就会把它判成「句子」（project=null），分身于是掉进「临时会话」区。
     * 只要成员段里真有 `｜`，这里就按最后一个 ` · ` 无条件切一次。
     * 非分身标题原样返回 splitSessionTitle 的结果（行为不变）。
     */
    function parseCloneTitle(raw) {
      const parsed = splitSessionTitle(raw);
      if (parsed.project) return parsed;
      const text = String(raw || '').replace(/\s*\(\d+\)\s*$/, '').trim();
      const at = text.lastIndexOf(' · ');
      if (at <= 0) return parsed;
      const agent = text.slice(at + 3).trim();
      if (!cloneSplitLabel(agent)) return parsed;
      return { project: text.slice(0, at).trim(), agent };
    }

    /** 当前前台的会话 id（内容区的 data 属性；没开会话时 null）。 */
    function currentConversationId() {
      const body = document.querySelector('[data-conversation-content]');
      return (body && body.getAttribute('data-conversation-session')) || null;
    }

    /** 量「会话内容区」的矩形：分列视图盖这个框，会话头/Chat/Trajectory 标签保持可见。 */
    function measureConversationContent() {
      const el = document.querySelector('[data-conversation-content]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    /** 分列视图的数据桥：HubWorkspaces 每次渲染把 sessions 快照发过来，overlay 订阅。 */
    const cloneColumnsState = { byId: {}, archived: new Set(), openSession: null, listeners: new Set() };

    /** 每列保留的尾部事件数：分列只渲染尾部消息，但要够长才能把 step/tool 配对留全。 */
    const CLONE_COLUMN_EVENTS = 4000;

    /** 分列取数失败上报（同一会话只报一次，别每 1.2s 刷日志）。 */
    const cloneFeedReported = new Set();
    function reportCloneFeedError(id, error) {
      if (cloneFeedReported.has(id)) return;
      cloneFeedReported.add(id);
      try {
        fetch('/hub/client-error', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'clone-feed',
            at: new Date().toISOString(),
            sessionId: id,
            message: String((error && error.message) || error),
          }),
        }).catch(() => {});
      } catch (error) { /* 上报失败就放弃 */ }
    }

    function publishCloneColumns(byId, archived, openSession) {
      cloneColumnsState.byId = byId || {};
      cloneColumnsState.archived = archived || new Set();
      if (typeof openSession === 'function') cloneColumnsState.openSession = openSession;
      for (const fn of cloneColumnsState.listeners) fn();
    }

    /**
     * **唯一**的「未归档分身名单」（2026-10-21 用户要求两处同源，杜绝再次不一致）：
     * 侧栏子行 / 数量徽标 / 分列视图三处都调用本函数。
     * 判定：同项目 + 同成员基名 + 标题带 `｜` + 不在 workspaceRegistry 归档集合里。
     * @returns {Array<{id,name,running,updatedAt}>} 按 updatedAt 升序（与分列列序一致）
     */
    function listUnarchivedClones(byId, archived, parentId) {
      const self = parentId ? byId[parentId] : null;
      if (!self) return [];
      const parsed = parseCloneTitle(self.displayTitle);
      if (cloneSplitLabel(parsed.agent)) return [];   // 自己就是分身 → 没有「子行/分列」
      const base = String(parsed.agent || '').trim();
      if (!base) return [];
      const out = [];
      for (const key of Object.keys(byId)) {
        if (key === parentId) continue;
        const session = byId[key];
        if (!session) continue;
        if (archived.has(key)) continue;              // 已归档 → 两处都不显示
        const info = parseCloneTitle(session.displayTitle);
        if ((info.project || null) !== (parsed.project || null)) continue;
        const clone = cloneSplitLabel(info.agent);
        if (!clone || clone.base !== base) continue;
        out.push({
          id: key,
          base,
          name: clone.task,
          isParent: false,
          running: Boolean(session.running),
          updatedAt: session.updatedAt || 0,
        });
      }
      out.sort((a, b) => (a.updatedAt - b.updatedAt) || String(a.id).localeCompare(String(b.id)));
      return out;
    }

    /**
     * 当前会话要并列展示的列：父 agent 自己 + `listUnarchivedClones` 的同一份名单。
     * 当前会话本身是分身 / 父会话自己被归档 / 没有未归档分身 → 返回 []（整块不渲染）。
     * `列数 N` 由调用方用返回数组的 length 决定，保证与实际渲染列数一致。
     */
    function cloneColumnsFor(currentId, byId, archived) {
      const self = currentId ? byId[currentId] : null;
      if (!self) return [];
      // 父会话自己被归档：不显示分列（它的分身也都该在「已归档」区里）
      if (archived.has(currentId)) return [];
      const clones = listUnarchivedClones(byId, archived, currentId);
      if (!clones.length) return [];
      const base = String(parseCloneTitle(self.displayTitle).agent || '').trim();
      return [{ id: currentId, base, name: base, isParent: true, running: Boolean(self.running) }].concat(clones);
    }

    /**
     * 一条会话的事件窗口 → 任务线消息 + 运行中快照。
     * 群聊 lane 与分身分列共用：step/start→assistant/message 记 LLM 步、tool/call→tool/result
     * 按 callId 配对记工具步；每条 agent 消息拿走「上一条消息之后新增的步骤」。
     * options.tools（分列用）：tool/call 也生成流内「工具卡片」条目（含参数/结果摘要，
     * 结果到达时回填耗时）——群聊不传，保持纯消息流。
     * options.reasoning（分列用）：把该步的思考过程（reasoning 块或 Host 侧附带的
     * data.reasoning）挂到 agent 消息上（item.reasoning）。
     */
    function collectLane(member, entries, options = {}) {
      const items = [];
      let stepStartTime = 0;
      const timeline = { steps: [], claimed: 0, open: new Map(), llm: null, records: [] };
      const toolItems = new Map();   // callId -> 流内工具卡片条目（tool/result 回填耗时/结果）
      // 真实 tool/result 事件**不带 callId**（agent-loop 只写 message），配对靠事件级
      // `sourceEventSeqs: [toolCallSeq]`；这里按 call seq 建两张表兜住
      const stepsByCallSeq = new Map();
      const cardsByCallSeq = new Map();
      const callSeqOf = (event) => {
        const seqs = event && event.sourceEventSeqs;
        if (Array.isArray(seqs) && seqs.length && Number.isFinite(Number(seqs[0]))) return Number(seqs[0]);
        // Host 精简事件把配对信息压成 data.callSeq（原始事件的 sourceEventSeqs 不在精简 payload 里）
        const dataSeq = Number(((event && event.data) || {}).callSeq);
        return Number.isFinite(dataSeq) && dataSeq > 0 ? dataSeq : null;
      };
      const clip = (text, max) => {
        const value = String(text || '').replace(/\s+/g, ' ').trim();
        return value.length > max ? `${value.slice(0, max)}…` : value;
      };
      const briefOfValue = (value, max) => {
        let text = '';
        if (typeof value === 'string') text = value;
        else if (value !== undefined && value !== null) {
          try { text = JSON.stringify(value); } catch { text = String(value); }
        }
        return clip(text, max);
      };
      /** message.content 里的 reasoning 块 → 思考文本（真实日志形态）。 */
      const reasoningFromMessage = (message) => {
        const parts = Array.isArray(message && message.content) ? message.content : [];
        let out = '';
        for (const part of parts) {
          if (part && part.type === 'reasoning' && typeof part.text === 'string') out += part.text;
        }
        return out.trim();
      };
      const attachSteps = (item, steps) => {
        if (!steps.length) return;
        if (!item.stats) item.stats = { ms: null, tokens: null, tps: null, steps: [] };
        for (const step of steps) item.stats.steps.push(step);
        const total = item.stats.steps
          .reduce((sum, step) => sum + (typeof step.ms === 'number' ? step.ms : 0), 0);
        if (total > 0) item.stats.ms = total;
      };
      const endTurn = () => {
        const last = timeline.records[timeline.records.length - 1];
        if (last) attachSteps(last, timeline.steps.slice(timeline.claimed));
        timeline.steps = [];
        timeline.claimed = 0;
        timeline.open.clear();
        timeline.llm = null;
        timeline.records = [];
        stepStartTime = 0;
        blocks.clear();
        blockKey = '';
        stepsByCallSeq.clear();
        cardsByCallSeq.clear();
      };
      // 持久/历史形态的 assistant 正文：不在 assistant/message.data.message 里，而在
      // assistant/chunk 的 block-end 或 text-chunks / reasoning-chunks 里（与 Host 侧
      // compactSessionEvents 同一套重建口径）。按 turn:step 攒块，assistant/message 没正文时兜底。
      const blocks = new Map();
      let blockKey = '';
      const blockOf = (key) => {
        if (!blocks.has(key)) blocks.set(key, new Map());
        return blocks.get(key);
      };
      const blockTextOf = (key) => {
        const map = blocks.get(key);
        if (!map) return '';
        return [...map.entries()]
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .filter(([, block]) => block.type === 'text')
          .map(([, block]) => block.text)
          .join('')
          .trim();
      };
      for (const entry of entries) {
        const event = entry.event;
        const at = (event && event.time) || 0;
        const type = (event && event.type) || '';
        if (type === 'assistant/chunk' || type === 'text-chunks' || type === 'reasoning-chunks') {
          const data = (event && event.data) || {};
          if (data.turn !== undefined && data.step !== undefined) blockKey = `${data.turn}:${data.step}`;
          if (type === 'assistant/chunk') {
            const chunk = data.chunk || {};
            if (chunk.type === 'block-end' && chunk.block && typeof chunk.block.text === 'string') {
              const index = String(chunk.index === undefined ? 0 : chunk.index);
              // block-end 是整块全文（权威版）：覆盖，别和增量 chunk 叠加成双份
              blockOf(blockKey).set(index, { type: String(chunk.block.type || 'text'), text: chunk.block.text });
            }
          } else if (Array.isArray(data.texts) && data.texts.length) {
            const index = String(data.index === undefined ? 0 : data.index);
            const map = blockOf(blockKey);
            const previous = map.get(index);
            map.set(index, {
              type: previous && previous.type ? previous.type : (type === 'text-chunks' ? 'text' : 'reasoning'),
              text: `${previous ? previous.text : ''}${data.texts.join('')}`,
            });
          }
          continue;
        }
        if (type === 'user/message') {
          endTurn();
          stepStartTime = at || stepStartTime;
        } else if (type === 'step/start') {
          // 上一个 step 没等到 assistant/message 就开了新 step：留一步 `?`，不串时间
          if (timeline.llm) timeline.steps.push({ kind: 'llm', name: '思考', ms: null });
          timeline.llm = { start: at };
          stepStartTime = at || stepStartTime;
        } else if (type === 'tool/call') {
          const callId = toolCallIdOf(event);
          const name = toolNameOf(event);
          const step = { kind: 'tool', name, icon: toolIconOf(name), ms: null, start: at };
          timeline.steps.push(step);
          if (callId) timeline.open.set(callId, step);
          const callSeq = Number(event.seq);
          if (Number.isFinite(callSeq)) stepsByCallSeq.set(callSeq, step);
          // 流内工具卡片（分列）：结果未到时先占位（显示「运行中」），tool/result 回填
          if (options.tools) {
            const card = {
              key: `${member.id}:tool:${callId || event.seq || items.length}`,
              kind: 'tool',
              name,
              icon: step.icon,
              // 原始事件是 data.arguments（对象）；Host 精简事件已经压成 data.args（字符串）
              args: (event.data || {}).arguments !== undefined
                ? briefOfValue((event.data || {}).arguments, 300)
                : clip((event.data || {}).args, 300),
              brief: '',
              error: false,
              ms: null,
              time: at,
              role: 'tool',
            };
            items.push(card);
            if (callId) toolItems.set(callId, card);
            if (Number.isFinite(callSeq)) cardsByCallSeq.set(callSeq, card);
          }
        } else if (type === 'tool/result') {
          const callId = toolCallIdOf(event);
          const callSeq = callSeqOf(event);
          const step = (callId ? timeline.open.get(callId) : null)
            || (callSeq !== null ? stepsByCallSeq.get(callSeq) : null)
            || null;
          if (step) {
            step.ms = Math.max(0, at - step.start);
            if (callId) timeline.open.delete(callId);
            if (callSeq !== null) stepsByCallSeq.delete(callSeq);
          }
          if (options.tools) {
            const card = (callId ? toolItems.get(callId) : null)
              || (callSeq !== null ? cardsByCallSeq.get(callSeq) : null)
              // 兜底：Host 旧版没回填 callId/callSeq 时，按先进先出认最早的未完成卡片
              || items.find((it) => it.kind === 'tool' && it.ms === null)
              || null;
            const data = event.data || {};
            const message = data.message;
            if (card) {
              if (callId && toolItems.get(callId) === card) toolItems.delete(callId);
              if (callSeq !== null) cardsByCallSeq.delete(callSeq);
              // FIFO 兜底命中的卡片可能还挂在别的键上，一并摘掉
              for (const [key, value] of [...toolItems.entries()]) if (value === card) toolItems.delete(key);
              for (const [key, value] of [...cardsByCallSeq.entries()]) if (value === card) cardsByCallSeq.delete(key);
              card.ms = step ? step.ms : Math.max(0, at - (card.time || at));
              card.error = Boolean((message && message.isError) || data.error);
              // Host 精简事件直接给 data.brief；原始事件从 message.content 抽
              if (typeof data.brief === 'string' && data.brief) {
                card.brief = clip(data.brief, 500);
              } else {
                const parts = message && Array.isArray(message.content) ? message.content : [];
                card.brief = clip(parts.map((part) => {
                  if (!part) return '';
                  if (part.type === 'text' && typeof part.text === 'string') return part.text;
                  if (part.type === 'image') return '[图片]';
                  return '';
                }).join('\n'), 500);
              }
            }
          }
        }
        // assistant/message 到了就结算这一步 LLM 时间：即使这条消息只有 tool-call、
        // 没正文（eventText 返回 null），也要把 step 时间记下来，别误标成 `?`。
        let llmStep = null;
        if (type === 'assistant/message' && stepStartTime) {
          const start = timeline.llm ? timeline.llm.start : stepStartTime;
          timeline.llm = null;
          const duration = Math.max(0, at - start);
          llmStep = { kind: 'llm', name: '思考', ms: duration > 0 ? duration : null };
          timeline.steps.push(llmStep);
          stepStartTime = 0;
        }
        let parsed = eventText(event);
        // 该事件的来源元数据（user/message 的 source.kind：空/user=真实用户，agent-instructions=程序投递）
        const source0 = (event.data && event.data.message && event.data.message.source) || null;
        // 历史形态兜底：assistant/message 没带正文时，用这一步攒下的 chunk 文本
        if (!parsed && type === 'assistant/message') {
          const fallback = blockTextOf(blockKey);
          if (fallback) {
            parsed = { text: fallback, role: 'agent', time: at };
            // 只清 text 块，别把同一步的 reasoning 一起删掉（思考过程要单独渲染）
            const map = blocks.get(blockKey);
            if (map) {
              for (const [index, block] of [...map.entries()]) {
                if (block.type === 'text') map.delete(index);
              }
            }
          }
        }
        // Host 精简事件：只有思考、没有正文的步骤（工具调用轮常见）
        if (type === 'assistant/reasoning') {
          const reasoning = clip(String(((event.data || {}).reasoning) || ''), 4000);
          if (options.reasoning && reasoning) {
            items.push({
              key: `${member.id}:think:${entry.event.seq ?? items.length}`,
              kind: 'think',
              role: 'think',
              reasoning,
              time: at,
            });
          }
          continue;
        }
        // 原始事件里「只有思考、没有正文」的步骤：也单独出 think 条目（否则思考会被丢掉）
        if (!parsed && type === 'assistant/message' && options.reasoning) {
          let reasoning = reasoningFromMessage(event.data && event.data.message);
          if (!reasoning) reasoning = String((event.data || {}).reasoning || '').trim();
          if (!reasoning && blocks.has(blockKey)) {
            const map = blocks.get(blockKey);
            reasoning = [...map.entries()]
              .filter(([, block]) => block.type === 'reasoning')
              .map(([, block]) => block.text).join('').trim();
            for (const [index, block] of [...map.entries()]) {
              if (block.type === 'reasoning') map.delete(index);
            }
          }
          if (reasoning) {
            items.push({
              key: `${member.id}:think:${entry.event.seq ?? items.length}`,
              kind: 'think',
              role: 'think',
              reasoning: clip(reasoning, 4000),
              time: at,
            });
          }
        }
        if (!parsed) continue;
        let stats = null;
        if (parsed.role === 'agent' && llmStep) {
          const usage = event.data && event.data.usage;
          const tokens = usage ? Number(usage.outputTokens) : NaN;
          const known = Number.isFinite(tokens) && tokens > 0 ? tokens : null;
          const group = timeline.steps.slice(timeline.claimed);
          const total = group.reduce((sum, step) => sum + (typeof step.ms === 'number' ? step.ms : 0), 0);
          stats = {
            // 行首「总耗时」= 这组步骤之和（含工具时间）；t/s 只用本步 LLM 时间算。
            ms: total > 0 ? total : llmStep.ms,
            tokens: known,
            tps: llmStep.ms !== null && known ? Math.round(known / (llmStep.ms / 1000)) : null,
            steps: group,
          };
          timeline.claimed = timeline.steps.length;
        }
        const eventId = event && event.id !== undefined
          ? String(event.id)
          : String((event && event.seq !== undefined) ? event.seq : '');
        const item = {
          key: `${member.id}:${entry.event.seq ?? items.length}`,
          eventId,
          agent: member,
          text: parsed.text,
          role: parsed.role,
          time: parsed.time,
          stats,
          // 2026-10-23 群聊信息架构：agent-instructions（派活/成员回报投递）标记为 instr，
          // 群聊 lane 只显示「真实用户消息 + 管理者摘要」，instr 消息不进 lane。
          // ⚠️ 2026-10-25 修（用户报「这明明不是我说的话，为什么会在任务线里」）：
          // 管理者的派活走 controller.prompt，**没有 source.kind**；只按 kind 判定会把
          // 「【本线目标】…【任务 · t1 续读】…」渲染成用户自己说的话。这里补内容侧判定：
          // 命中派活前缀 / goal 注入模板 → 也算 instr（不进 lane）。
          instr: Boolean(
            (source0 && source0.kind && source0.kind !== 'user')
            || /^\s*【(任务|本线目标|续跑|派活|回报|汇报|求助|返工|重发|来自|占位)/.test(parsed.text || '')
            || /第一件事请调用\s*create_goal|update_goal\s*\{action:"resume"\}/.test(parsed.text || ''),
          ),
        };
        if (options.reasoning && parsed.role === 'agent') {
          let reasoning = reasoningFromMessage(event.data && event.data.message);
          if (!reasoning) reasoning = String((event.data || {}).reasoning || '').trim();
          if (!reasoning && blocks.has(blockKey)) {
            const map = blocks.get(blockKey);
            reasoning = clip([...map.entries()]
              .filter(([, block]) => block.type === 'reasoning')
              .map(([, block]) => block.text).join('').trim(), 4000);
            for (const [index, block] of [...map.entries()]) {
              if (block.type === 'reasoning') map.delete(index);
            }
          }
          if (reasoning) item.reasoning = reasoning;
        }
        items.push(item);
        if (parsed.role === 'agent') timeline.records.push(item);
      }
      // 「运行中」实时快照已随群聊 RunningBlock 一并移除（2026-10-20）：停止后的
      // 每消息分步明细（stats.steps）在 attachSteps 里已经齐了，无需再留尾部快照。
      endTurn();
      return { items };
    }

    /**
     * 分身分列视图（B 半 v2）：当前会话是「有分身的父 agent」时，把会话内容区换成
     * N 列横向布局——第 1 列 = 父 agent 会话本身，后面每列 = 一个分身的会话。
     * 每列 = 列头（头像 + 名字 + 运行绿点 + 本轮时长 + 最近 t/s）+ 消息流
     * （collectLane 读 eventSource 快照，1.5s 轮询；LaneFeed 贴底滚动）+ 底部只读
     * 输入条（v2 再支持直接说话）。列多时横向滚动（每列最小 320px）。
     * 「⇤ 单列」回到原生单列视图（要打字时用），内容区右上角留「分列」小按钮回来。
     */
    function CloneColumns(props) {
      // 原生渲染能力（存在就用原生会话体，不存在则退回自绘渲染）：
      // renderer 只在条目声明了 session 子槽时才注入 SessionProvider / renderFactorySlot。
      const kit = props || {};
      const nativeKit = (typeof kit.renderFactorySlot === 'function' && typeof kit.SessionProvider === 'function')
        ? kit
        : null;
      const [, bump] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        cloneColumnsState.listeners.add(bump);
        return () => { cloneColumnsState.listeners.delete(bump); };
      }, []);
      // 当前会话 id：内容区的 data 属性（外壳自己写的）。
      // 2026-10-23 修「先显示原视图再跳分列」（两轮）：
      // ①800ms 轮询 → MutationObserver（属性变化微任务回调，同帧跟上）；
      // ②残余闪跳的真因 = 原生消息区先挂载、overlay 后一帧才盖。根治：observer 回调
      //   （绘制前微任务）里**同步**挂 data-hub-clone-cols + 重量内容区，配合 CSS
      //   `html[data-hub-clone-cols] [data-conversation-content]{visibility:hidden}`——
      //   原生内容根本不画，overlay 同帧落位。attr 的精确收发仍由下方 effect 兜底。
      const [currentId, setCurrentId] = React.useState(() => currentConversationId());
      // 内容区矩形（唯一声明处）：observer 微任务与 resize/定时重量共用
      const [box, setBox] = React.useState(() => measureConversationContent());
      // collapsed 的 ref 镜像：observer 微任务里要用最新折叠态，不能闭包首帧值
      const collapsedRef = React.useRef({});
      React.useEffect(() => {
        const sync = () => {
          const id = currentConversationId();
          setCurrentId((prev) => (prev === id ? prev : id));
          // 同步预挂/摘 CSS 钩子（绘制前生效；与下方 effect 同一判定口径，含 collapsed）
          try {
            const cols = id
              ? cloneColumnsFor(id, cloneColumnsState.byId || {}, cloneColumnsState.archived || new Set())
              : [];
            const collapsedNow = id ? Boolean(collapsedRef.current[id]) : false;
            if (cols.length && !collapsedNow) document.documentElement.dataset.hubCloneCols = '1';
            else delete document.documentElement.dataset.hubCloneCols;
          } catch (error) { /* 判定失败交给 effect */ }
          // 同步重量内容区（微任务里 getBoundingClientRect 会强制布局，拿得到新框）
          const next = measureConversationContent();
          if (next) {
            setBox((prev) => (prev && prev.left === next.left && prev.top === next.top
              && prev.width === next.width && prev.height === next.height ? prev : next));
          } else {
            requestAnimationFrame(sync); // 元素还没尺寸：下一帧再量
          }
        };
        sync();
        let observer = null;
        try {
          observer = new MutationObserver(sync);
          observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-conversation-session'],
            subtree: true,
          });
        } catch (error) { /* 老环境无 MutationObserver 就只靠轮询 */ }
        const timer = setInterval(sync, 1500);
        return () => {
          if (observer) observer.disconnect();
          clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      const [collapsed, setCollapsed] = React.useState({});
      collapsedRef.current = collapsed; // 每渲染同步，observer 微任务里用最新折叠态
      // ⚠️ columns 必须在任何用到它的 hook 依赖之前算出来：
      // 2026-10-21 修复「分列视图打不开」的真凶——wheel effect 的依赖数组引用
      // `columns.length`，而 columns 原先在其后声明（TDZ），每次渲染都抛
      // "Cannot access 'columns' before initialization"，槽位占位者被判 active:false。
      const byId = cloneColumnsState.byId || {};
      const archived = cloneColumnsState.archived || new Set();
      const columns = cloneColumnsFor(currentId, byId, archived);
      const idsKey = columns.map((col) => col.id).join(',');
      // 横向轨道：列多时既要有滚动条，也要能用普通纵向滚轮翻列。
      // React 的 onWheel 是被动监听（preventDefault 无效），所以用原生监听 + passive:false。
      const railRef = React.useRef(null);
      React.useEffect(() => {
        const el = railRef.current;
        if (!el) return undefined;
        const onWheel = (event) => {
          // 没溢出 / 已经横向滚（触控板横滑）/ 按了 shift（浏览器原生横向）→ 不接管
          if (el.scrollWidth <= el.clientWidth + 1) return;
          if (event.shiftKey) return;
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          // 2026-11-05 用户令「在列内一律不翻列」：只要鼠标在某列里，滚轮**只滚该列**——
          // 列内滚到顶/到底也不再翻到相邻列（上一版是"滚到头就翻列"，用户明确否掉）。
          // 翻列改由：轨道空白处（列间空隙）滚轮 / shift+滚轮 / 拖底部横向滚动条 / 触控板横滑。
          if (event.target && typeof event.target.closest === 'function'
            && event.target.closest('.hub-cc-col')) return;
          el.scrollLeft += event.deltaY;
          event.preventDefault();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, [currentId, Boolean(collapsed[currentId]), columns.length]);
      // 原生会话体需要的 SessionReference：每列 retain 一次，分列面板卸载时统一释放
      const nativeRefs = React.useRef(new Map());
      const retainForColumn = (id) => {
        let ref = nativeRefs.current.get(id);
        if (!ref) {
          const svc = service('sessions');
          if (!svc) return null;
          try {
            ref = svc.retain(id, { source: 'controllerOperation' });
          } catch (error) {
            reportCloneFeedError(id, error);
            return null;
          }
          nativeRefs.current.set(id, ref);
        }
        return ref;
      };
      React.useEffect(() => () => {
        for (const ref of nativeRefs.current.values()) {
          try { ref.release(); } catch (error) { /* 已释放 */ }
        }
        nativeRefs.current.clear();
      }, []);
      // 内容区矩形：覆盖它 = 换掉消息区（+composer），会话头/标签不动
      //（box 的 state 已在上方 observer effect 处声明；这里只保留 resize/定时重量）
      React.useEffect(() => {
        const remeasure = () => {
          const next = measureConversationContent();
          setBox((prev) => (prev && next && prev.left === next.left && prev.top === next.top
            && prev.width === next.width && prev.height === next.height ? prev : next));
        };
        remeasure();
        window.addEventListener('resize', remeasure);
        const timer = setInterval(remeasure, 1200);
        return () => { window.removeEventListener('resize', remeasure); clearInterval(timer); };
        // 2026-10-23：切会话（currentId 变）立即重量一次，不等 1.2s 拍子
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [currentId]);

      const anyRunning = columns.some((col) => col.running);

      // 只在分列展开时藏掉原生 composer（CSS 钩子）
      React.useEffect(() => {
        if (columns.length && !collapsed[currentId]) document.documentElement.dataset.hubCloneCols = '1';
        else delete document.documentElement.dataset.hubCloneCols;
        return () => { delete document.documentElement.dataset.hubCloneCols; };
      }, [columns.length, Boolean(collapsed[currentId])]);

      // 分列列内「模型选择器」（2026-10-23 用户要求）：每列输入框旁显示该会话当前模型，
      // 点开可选任意目录模型 → 走 /hub/session-model-set 只改这一列（不动全局默认）。
      // 原生 composer 的模型选择器在分列模式下被 CSS 藏掉，列内必须自带一个。
      const [modelCatalog, setModelCatalog] = React.useState([]);
      // 按提供商分组的目录（2026-10-23 用户要求：不只列模型名，要按提供商分类）
      const [modelGroups, setModelGroups] = React.useState([]);
      const [colModels, setColModels] = React.useState({});
      const [modelOpenFor, setModelOpenFor] = React.useState('');
      // 菜单用 fixed 定位（2026-10-23）：列容器 overflow 会把 absolute 菜单上下裁掉，
      // 打开时按 chip 的 rect 算左侧与底部，向上弹出并限制高度。
      const [modelMenuPos, setModelMenuPos] = React.useState(null);
      React.useEffect(() => {
        let cancelled = false;
        const loadCatalog = async () => {
          try {
            const res = await fetch('/hub/models');
            const data = await res.json();
            if (cancelled || !data || !data.ok) return;
            const flat = [];
            const groups = [];
            for (const group of (data.groups || [])) {
              const items = (group.models || []).map((item) => ({
                value: `${group.id}/${item.id}`,
                label: item.name || item.id,
                provider: group.id,
                model: item.id,
              }));
              if (items.length === 0) continue;
              groups.push({ id: group.id, name: group.name || group.id, items });
              flat.push(...items);
            }
            setModelCatalog(flat);
            setModelGroups(groups);
          } catch (error) { /* 目录不可用就先空着 */ }
        };
        loadCatalog();
        const loadPerColumn = async () => {
          const ids = idsKey ? idsKey.split(',') : [];
          const next = {};
          for (const id of ids) {
            try {
              const res = await fetch(`/hub/session-model?session=${encodeURIComponent(id)}`);
              const data = await res.json();
              const sel = data && data.ok && data.modelSelection ? data.modelSelection : null;
              const pick = (sel && (sel.pending || sel.next || sel.lastUsed)) || null;
              if (pick && pick.provider && pick.model) next[id] = `${pick.provider}/${pick.model}`;
            } catch (error) { /* 单列失败忽略 */ }
          }
          if (!cancelled) setColModels(next);
        };
        loadPerColumn();
        const timer = setInterval(loadPerColumn, 8000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [idsKey]);
      const applyColumnModel = async (colId, value) => {
        const at = String(value || '').indexOf('/');
        if (at <= 0) return;
        const provider = value.slice(0, at);
        const model = value.slice(at + 1);
        setModelOpenFor('');
        setModelMenuPos(null);
        setColModels((prev) => ({ ...prev, [colId]: value }));
        try {
          await fetch('/hub/session-model-set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: colId, provider, model }),
          });
        } catch (error) {
          console.error('[hub-desktop-ui] set column model failed', error);
        }
      };

      // 本轮时长：与侧栏芯片同一规则（60748a1）——running 由 false→true 记起点
      const [clock, setClock] = React.useState(() => Date.now());      React.useEffect(() => {
        if (!anyRunning) return undefined;
        setClock(Date.now());
        const timer = setInterval(() => setClock(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [anyRunning]);
      const runStart = React.useRef(new Map());
      for (const col of columns) {
        if (col.running) {
          if (!runStart.current.has(col.id)) runStart.current.set(col.id, Date.now());
        } else {
          runStart.current.delete(col.id);
        }
      }

      // 每列取数（2026-10-21 重做）：分列里的会话大多**不是**当前主视图打开的那个，
      // 而客户端 `sessions.retain(id)` 的 eventSource 只对「本 Client 打开过」的会话
      // 有窗口快照——冷会话一条事件也拿不到，旧实现于是每列只剩一行「点 ↗ 打开」占位。
      // 现在每列独立走 Host `/hub/session-events`（读持久事件：活会话取内存、冷会话走
      // sessionController.inspect，不激活 agent），按 seq 增量轮询；运行中 1.2s、空闲 4s。
      // Host 路由不可用（Host 半还没重启）时退回 retain → eventSource。
      const [feeds, setFeeds] = React.useState({});
      const feedBuffers = React.useRef(new Map());
      // 列内输入框：每列一个草稿 + 发送状态（分列期间原生 composer 被 CSS 藏掉）
      const [drafts, setDrafts] = React.useState({});
      const [sendState, setSendState] = React.useState({});
      const sendFromColumn = async (col) => {
        const text = String(drafts[col.id] || '').trim();
        if (!text || (sendState[col.id] || {}).busy) return;
        setDrafts((prev) => ({ ...prev, [col.id]: '' }));
        setSendState((prev) => ({ ...prev, [col.id]: { busy: true, error: null } }));
        try {
          await promptSession(col.id, text);
          // 发出去立刻拉一次增量（把缓冲的 at 清零，下一拍 1.2s 内就取）
          const buf = feedBuffers.current.get(col.id);
          if (buf) buf.at = 0;
          setSendState((prev) => ({ ...prev, [col.id]: { busy: false, error: null } }));
        } catch (error) {
          // 失败把草稿放回去，别让用户白打一串字
          setDrafts((prev) => ({ ...prev, [col.id]: text }));
          setSendState((prev) => ({ ...prev, [col.id]: { busy: false, error: String((error && error.message) || error) } }));
        }
      };
      React.useEffect(() => {
        if (!idsKey) return undefined;
        const ids = idsKey.split(',');
        const buffers = feedBuffers.current;
        for (const id of ids) {
          if (!buffers.has(id)) {
            buffers.set(id, {
              events: [], items: [], lastSeq: 0, total: 0, at: 0, busy: false,
              mode: 'host', hostFails: 0, loading: true, error: null, streaming: '',
            });
          }
        }
        for (const id of [...buffers.keys()]) if (!ids.includes(id)) buffers.delete(id);
        let cancelled = false;
        const refs = new Map();
        const isRunning = (id) => Boolean((cloneColumnsState.byId || {})[id]
          && (cloneColumnsState.byId || {})[id].running);
        const settle = (buf, id) => {
          buf.items = collectLane({ id, running: isRunning(id) },
            buf.events.map((event) => ({ type: 'event', event })), { tools: true, reasoning: true }).items;
          buf.loading = false;
        };
        const publish = () => {
          if (cancelled) return;
          const next = {};
          for (const id of ids) {
            const buf = buffers.get(id);
            if (!buf) continue;
            next[id] = {
              items: buf.items, total: buf.total, loading: buf.loading,
              error: buf.error, mode: buf.mode, streaming: buf.streaming,
            };
          }
          setFeeds(next);
        };
        /** 主路径：Host 持久事件（冷会话也能读到全量历史）。 */
        const pullHost = async (buf, id) => {
          const response = await fetch(`/hub/session-events?session=${encodeURIComponent(id)}&since=${buf.lastSeq}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          if (!body || body.ok !== true) throw new Error(String((body && body.error) || 'session-events 不可用'));
          const lastSeq = Number(body.lastSeq || 0);
          const total = Number(body.total || 0);
          // 持久日志回缩（会话重建/压缩）：这段历史已经不是同一份，清空重取
          if (lastSeq > 0 && lastSeq < buf.lastSeq) {
            buf.events = [];
            buf.items = [];
            buf.lastSeq = 0;
            buf.total = 0;
            buf.loading = true;
            return;
          }
          const fresh = Array.isArray(body.events) ? body.events : [];
          let added = 0;
          const seen = new Set(buf.events.map((event) => event.seq));
          for (const event of fresh) {
            if (!event || typeof event.seq !== 'number' || seen.has(event.seq)) continue;
            seen.add(event.seq);
            buf.events.push(event);
            added += 1;
          }
          if (added > 0) {
            buf.events.sort((a, b) => a.seq - b.seq);
            if (buf.events.length > CLONE_COLUMN_EVENTS) buf.events = buf.events.slice(-CLONE_COLUMN_EVENTS);
            settle(buf, id);
          } else if (buf.loading) {
            settle(buf, id);
          }
          // 游标取「源事件最大 seq」：尾部 chunk 事件不回传，但已经读过了，别反复重取
          buf.lastSeq = Math.max(buf.lastSeq, lastSeq);
          buf.hostFails = 0;
          buf.total = Math.max(total, buf.total);
          buf.streaming = String(body.streaming || '');
          buf.error = null;
        };
        /** 兜底：retain → eventSource 快照（只在 Host 路由不可用时用）。 */
        const pullRetain = async (buf, id) => {
          const svc = service('sessions');
          if (!svc) throw new Error('sessions 服务不可用');
          let ref = refs.get(id);
          if (!ref) {
            ref = svc.retain(id, { source: 'controllerOperation' });
            refs.set(id, ref);
          }
          const binding = await ref.ready;
          const win = binding.eventSource.getSnapshot();
          const entries = (win && win.entries) || [];
          buf.items = collectLane({ id, running: isRunning(id) }, entries, { tools: true, reasoning: true }).items;
          buf.events = [];
          buf.total = entries.length;
          buf.loading = false;
          buf.error = entries.length ? null : 'eventSource 无事件';
        };
        const tick = async () => {
          for (const id of ids) {
            if (cancelled) return;
            const buf = buffers.get(id);
            if (!buf || buf.busy) continue;
            // 运行中的列 1.2s 一跳（实时增长），空闲列 4s 一跳
            const cadence = isRunning(id) ? 1200 : 4000;
            if (Date.now() - buf.at < cadence) continue;
            buf.busy = true;
            buf.at = Date.now();
            try {
              if (buf.mode === 'host') {
                try {
                  await pullHost(buf, id);
                } catch (error) {
                  buf.hostFails += 1;
                  buf.error = String((error && error.message) || error);
                  reportCloneFeedError(id, error);
                  // 连续 3 次拿不到 Host 事件（路由没上线/出错）→ 这一列退回 retain 模式
                  if (buf.hostFails >= 3) {
                    buf.mode = 'retain';
                    await pullRetain(buf, id);
                  }
                }
              } else {
                await pullRetain(buf, id);
              }
            } catch (error) {
              buf.loading = false;
              buf.error = String((error && error.message) || error);
              reportCloneFeedError(id, error);
            } finally {
              buf.busy = false;
            }
          }
          publish();
        };
        tick();
        const timer = setInterval(tick, 1200);
        return () => {
          cancelled = true;
          clearInterval(timer);
          for (const ref of refs.values()) {
            try { ref.release(); } catch (error) { /* 已释放 */ }
          }
          refs.clear();
        };
      }, [idsKey]);

      if (!columns.length || !box) return null;

      // 单列模式（用户点了「⇤ 单列」）：只留一个「分列」小按钮回来
      if (collapsed[currentId]) {
        return h('button', {
          type: 'button',
          className: 'hub-cc-restore',
          style: { left: `${box.left + box.width - 108}px`, top: `${box.top + 6}px` },
          onClick: () => setCollapsed((prev) => ({ ...prev, [currentId]: false })),
        }, `分列 · ${columns.length} 列`);
      }

      const openClone = cloneColumnsState.openSession;
      // 消息条目：agent 带 reasoning 时，先渲染「💭 思考」折叠块（像原生对话的思考区）
      const bubble = (item) => h(
        'div',
        {
          key: item.key,
          style: {
            display: 'flex',
            flexDirection: item.role === 'user' ? 'row-reverse' : 'row',
            marginBottom: '8px',
            opacity: item.streaming ? 0.72 : 1,
          },
        },
        h(
          'div',
          { style: { minWidth: 0, maxWidth: '88%' } },
          item.reasoning ? h(ThinkBlock, { text: item.reasoning }) : null,
          h('div', {
            style: {
              padding: '5px 9px', borderRadius: '9px',
              fontSize: '11.5px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: item.role === 'user' ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-base)',
              border: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-primary)',
            },
          }, renderMarkdown(item.text)),
          item.stats
            ? h(MessageTiming, { stats: item.stats, align: item.role === 'user' ? 'right' : 'left' })
            : null,
        ),
      );
      // 流内条目分发：思考块 / 工具卡片 / 消息气泡（按事件顺序，像原生 flow）
      const renderItem = (item) => {
        if (item.kind === 'think') return h(ThinkBlock, { key: item.key, text: item.reasoning });
        if (item.kind === 'tool') return h(ToolCard, { key: item.key, card: item });
        return bubble(item);
      };

      const renderColumn = (col) => {
        const feed = feeds[col.id] || { items: [] };
        const startedAt = runStart.current.get(col.id);
        const avatar = avatarOf(col.base, {});
        const initial = (col.base.trim()[0] || '·').toUpperCase();
        const hue = uniqueHue(col.base);
        // 列头 t/s：本列最近一条带 stats 的 agent 消息
        const withTps = feed.items.filter((it) => it.role === 'agent' && it.stats && it.stats.tps);
        const lastTps = withTps.length ? withTps[withTps.length - 1].stats.tps : null;
        return h(
          'div',
          {
            key: col.id,
            className: 'hub-cc-col',
            'data-parent': col.isParent ? '1' : '0',
            'data-running': col.running ? '1' : '0',
          },
          h(
            'div',
            { className: 'hub-cc-head' },
            h('span', {
              className: 'hub-cc-avatar',
              title: col.base,
              style: avatar.emoji
                ? undefined
                : { background: `hsl(${hue} 40% 40%)`, color: '#fff', fontSize: '9px', fontWeight: 600 },
            }, avatar.emoji || initial),
            h('span', {
              className: 'hub-cc-name',
              title: col.isParent ? `${col.base}（父会话）` : `${col.base}｜${col.name}`,
            }, col.isParent ? `${col.base} · 本体` : col.name),
            h('span', { className: 'hub-cc-dot', title: col.running ? '运行中' : '空闲' }),
            col.running && startedAt
              ? h('span', { className: 'hub-cc-dur', title: '本轮已运行时长' }, formatDuration(clock - startedAt))
              : null,
            lastTps ? h('span', { className: 'hub-cc-tps', title: '最近一段解码速度' }, `${lastTps} t/s`) : null,
            !col.isParent && openClone
              ? h('button', {
                type: 'button',
                className: 'hub-cc-open',
                title: '切到这个分身的完整会话（原生视图）',
                onClick: () => openClone(col.id),
              }, '↗')
              : null,
          ),
          // 列内容：有渲染 kit 时**直接挂原生会话体**（conversation.content 工厂，embedded 变体，
// 视图固定 chat）——工具卡、思考行、「Deep diving for …」计时、输入框全部与单会话一致；
// 拿不到 kit 时退回自绘渲染（下面 LaneFeed + 自带输入条那条路）。
          (() => {
            if (nativeKit) {
              const nativeRef = retainForColumn(col.id);
              if (nativeRef) {
                return h(NativeColumnBody, {
                  key: `native:${col.id}`,
                  sessionRef: nativeRef,
                  SessionProvider: nativeKit.SessionProvider,
                  renderFactorySlot: nativeKit.renderFactorySlot,
                });
              }
            }
            return null;
          })() || (() => {
            const items = feed.items.slice(-160);
            if (col.running && feed.streaming) {
              items.push({
                key: `${col.id}:streaming`,
                role: 'agent',
                text: feed.streaming,
                streaming: true,
              });
            }
            return h(LaneFeed, {
              items,
              renderItem,
              emptyText: feed.loading ? '正在载入这个会话的历史…' : '（本会话暂无消息）',
            });
          })(),
          // 列内输入条：**两种模式都要有**（2026-10-21 用户要求每列都能直接说话）。
          // 原生 `conversation.content` 工厂只给消息体、不含 composer（composer 属于
          // conversation.input 槽），所以原生模式也必须画这一条。
          (() => {
            const state = sendState[col.id] || {};
            const draft = drafts[col.id] || '';
            return h('div', { className: 'hub-cc-composer' },
              h('div', { className: 'hub-cc-composer-row' },
                h('textarea', {
                className: 'hub-cc-input',
                value: draft,
                rows: 1,
                spellCheck: false,
                placeholder: state.busy ? '发送中…' : `对${col.isParent ? '本体' : ` ${col.name} `}说…（可粘贴图片）`,
                disabled: Boolean(state.busy),
                onChange: (event) => {
                  const el = event.currentTarget;
                  setDrafts((prev) => ({ ...prev, [col.id]: el.value }));
                  // 自增高，最高 3 行
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(72, el.scrollHeight)}px`;
                },
                // 粘贴图片（2026-11-04 用户报「分列输入框没法粘图」）：与群聊房间输入框同款——
                // 剪贴板图片先 POST /hub/upload 落盘，再把 `[图片] <路径>` 追加进本列草稿。
                onPaste: (event) => pasteImages(event, (paths) => {
                  setDrafts((prev) => {
                    const current = prev[col.id] || '';
                    const addition = paths.map((path) => `[图片] ${path}`).join('\n');
                    return {
                      ...prev,
                      [col.id]: `${current}${current && !current.endsWith('\n') ? '\n' : ''}${addition}\n`,
                    };
                  });
                }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    sendFromColumn(col);
                  }
                },
              }),
                // 模型选择器（2026-10-23）：输入框右侧内联 pill，形式对齐原生 composer 的模型选择器
                // （小圆角、只显示短名 + ▾、点开向上弹出列表）；切换只影响本列会话。
                (() => {
                  const value = colModels[col.id] || '';
                  const hit = modelCatalog.find((option) => option.value === value);
                  const label = hit ? hit.label : (value ? value.split('/').pop() : '模型…');
                  const open = modelOpenFor === col.id;
                  return h('div', { className: 'hub-cc-model' },
                    h('button', {
                      type: 'button',
                      className: 'hub-cc-model-chip',
                      title: value ? `当前：${value}（点击切换，只影响本列会话）` : '选择本列会话的模型',
                      onClick: (event) => {
                        if (open) { setModelOpenFor(''); setModelMenuPos(null); return; }
                        const rect = event.currentTarget.getBoundingClientRect();
                        const width = 232;
                        setModelMenuPos({
                          left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
                          bottom: Math.max(8, window.innerHeight - rect.top + 6),
                          maxHeight: Math.max(140, Math.min(360, rect.top - 16)),
                        });
                        setModelOpenFor(col.id);
                      },
                    }, label, h('span', { className: 'hub-cc-model-caret' }, '▾')),
                    open
                      ? h('div', {
                        className: 'hub-cc-model-menu',
                        style: modelMenuPos ? {
                          left: `${modelMenuPos.left}px`,
                          bottom: `${modelMenuPos.bottom}px`,
                          maxHeight: `${modelMenuPos.maxHeight}px`,
                        } : undefined,
                      },
                        // 按提供商分组（2026-10-23 用户要求）：每组一个提供商标题 + 该组模型
                        ...modelGroups.flatMap((group) => [
                          h('div', { key: `g-${group.id}`, className: 'hub-cc-model-group' }, group.name),
                          ...group.items.map((option) => h('button', {
                            key: option.value,
                            type: 'button',
                            className: `hub-cc-model-item${option.value === value ? ' is-active' : ''}`,
                            title: option.value,
                            onClick: () => applyColumnModel(col.id, option.value),
                          }, option.label)),
                        ]),
                      )
                      : null,
                  );
                })(),
                h('button', {
                  type: 'button',
                  className: 'hub-cc-send',
                  disabled: state.busy || !draft.trim(),
                  title: '发送到这个会话（排队：它正在跑就等这轮结束）',
                  onClick: () => sendFromColumn(col),
                }, state.busy ? '…' : '发送'),
              ),
              state.error
                ? h('span', { className: 'hub-cc-send-error', title: state.error }, state.error)
                : null,
            );
          })()
        );
      };

      return h(
        'div',
        {
          className: 'hub-cc-panel',
          style: {
            left: `${box.left}px`, top: `${box.top}px`,
            width: `${box.width}px`, height: `${box.height}px`,
          },
        },
        h(
          'div',
          { className: 'hub-cc-bar' },
          h('span', null, `分身分列 · 1 父会话 + ${columns.length - 1} 个分身`),
          h('span', { style: { opacity: 0.7 } }, '每列独立滚动 · 滚轮横向翻列 · 列内输入框直接说话'),
          h('button', {
            type: 'button',
            className: 'hub-cc-toggle',
            title: '回到原生单列视图（要打字时用），右上角会留「分列」按钮回来',
            onClick: () => setCollapsed((prev) => ({ ...prev, [currentId]: true })),
          }, '⇤ 单列'),
        ),
        h('div', { className: 'hub-cc-rail', ref: railRef }, ...columns.map(renderColumn)),
      );
    }

    /**
 * 算桌面侧栏「项目序 + 每个项目的 chip」，**镜像给 Host 用**（`order.json` / `/sync/order`）。
 *
 * 2026-11-11 新增（sync 侧线报 `.hub/order.json` 冻结在 11-09）：
 * 原心跳写在 `HubWorkspaces` 里，而 `HubWorkspaces` 通过
 * `mount('sidebar.workspaces', { priority: -1 })` 挂载 —— 后被 `project-room` 的
 * `ProjectSidebar`（`mount('sidebar.workspaces', { priority: -2 })`，
 * 见 `project-room/client.js` 的 mount 行）以更高优先级**顶掉**，
 * 于是它根本不渲染、它的 `useEffect` 不执行 → 心跳永不发 → `order.json` 冻结。
 * （`lib/client.js` 原心跳处注释已记载 2026-10-28 同样的症状"order.json 停在两天前"，
 *  那次只加了心跳、没治"组件不渲染"这个根因，所以复发。）
 *
 * ⚠️ 本函数与 `HubWorkspaces` 内那段 projectRows/orderedRows 计算是**等价实现**：
 * 侧栏渲染用后者（不改动，避免动到用户天天看的布局），镜像用前者。
 * 改动任一处必须同步另一处 —— 比对标尺：读最新 `.hub/restart-recordings/ui-boot-*.jsonl`
 * 最后一帧 `frame.text`，按项目名首现位置排序即桌面真实侧栏序，再与 `.hub/order.json` 逐位比。
 */
function computeSidebarOrderForMirror({ byId, archived, looseHidden, pinnedProjects }) {
  // ⚠️ 必须与 HubWorkspaces 里的 `visible` **完全同源同序**：那里保留了
  // `.sort((a,b) => (byId[b].updatedAt||0) - (byId[a].updatedAt||0))`。
  // 虽然 `session.updatedAt` 在 DSH 投影里多数恒为 0（见 lastActiveOf 附近的 2026-11-09 注释），
  // 但**少数刚建的会话确实有值** —— 2026-11-11 实测：漏掉这个 sort 时镜像序与侧栏序
  // 有 2/17 错位（星阶 ↔ 侯彭姣 对调）。别以为它恒等就省掉。
  const visible = Object.keys(byId)
    .filter((id) => byId[id] && !archived.has(id) && !looseHidden.has(String(id)))
    .sort((a, b) => (byId[b].updatedAt || 0) - (byId[a].updatedAt || 0));
  const projects = new Map();
  for (const id of visible) {
    const parsed = parseCloneTitle(byId[id].displayTitle);
    if (!parsed.project) continue;            // 无 `项目 · 成员` 前缀 → 不生成项目行
    if (!projects.has(parsed.project)) projects.set(parsed.project, []);
    projects.get(parsed.project).push({ id, label: parsed.agent, hint: byId[id].displayTitle });
  }
  const isManagerName = (label) => MANAGER_NAMES.includes(String(label || '').trim());
  const managerFirst = (a, b) => (isManagerName(a.label) ? 0 : 1) - (isManagerName(b.label) ? 0 : 1);
  const projectRows = [...projects.entries()].map(([name, members]) => {
    // 分身不单独占 chip：`<成员>｜<任务>` 并进父 agent 的 chip（子行 + 数量徽标）
    const parentByLabel = new Map();
    for (const m of members) if (!cloneSplitLabel(m.label)) parentByLabel.set(m.label, m);
    const chips = [];
    const emitted = new Set();
    for (const m of members) {
      const clone = cloneSplitLabel(m.label);
      if (clone) {
        const parent = parentByLabel.get(clone.base);
        if (!parent) { chips.push({ ...m, cloneCount: 0 }); continue; }
        if (emitted.has(clone.base)) continue;
        emitted.add(clone.base);
        const list = listUnarchivedClones(byId, archived, parent.id);
        chips.push({ ...parent, cloneCount: list.length, clones: list.map((c) => ({ id: c.id, name: c.name })) });
        continue;
      }
      if (emitted.has(m.label)) continue;
      emitted.add(m.label);
      const list = listUnarchivedClones(byId, archived, m.id);
      chips.push({ ...m, cloneCount: list.length, clones: list.map((c) => ({ id: c.id, name: c.name })) });
    }
    return { name, members: [...members].sort(managerFirst), chips: chips.sort(managerFirst) };
  });
  // 置顶优先，其余维持 Object.keys(byId) 原序（sort 稳定）
  const pinnedSet = new Set(pinnedProjects || []);
  return [...projectRows]
    .sort((a, b) => (pinnedSet.has(b.name) ? 1 : 0) - (pinnedSet.has(a.name) ? 1 : 0));
}

/** 读 localStorage 里的项目置顶（与 HubWorkspaces 同一个 key）。 */
function loadPinnedProjectsForMirror() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem('hub.pin.projects') || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch (error) { return []; }
}

/** 读 localStorage 里的「未分类隐藏」集合（复用模块级 `loadLooseHidden`，同一个 key）。 */
function loadLooseHiddenSetForMirror() {
  try { return new Set(loadLooseHidden().map(String)); } catch (error) { return new Set(); }
}

/**
 * 顺序镜像心跳（2026-11-11）：把桌面算好的项目序 + 置顶全量 POST 给 Host，
 * 手机端 `/sync/order` 读同一份 → 两端顺序按构造成立一致。
 *
 * 挂载在 `shell.overlay`（不争 `sidebar.workspaces`，项目-room 顶不掉它），
 * 渲染 `null` 不占视觉位置。**这是"代码在但没跑"的根治**：
 * 只要桌面进程活着，心跳就发，与哪套侧栏在渲染无关。
 */
function OrderMirrorHeartbeat(props) {
  const workspaces = props.useWorkspaces ? props.useWorkspaces((s) => s) : null;
  const sessions = props.useSessions ? props.useSessions((s) => s) : null;
  // 无数据时不发（避免把空序写成"最新"的 order.json，那比过期更误导）
  if (!sessions || !sessions.byId) return null;
  const byId = sessions.byId;
  const archived = new Set((workspaces && workspaces.archivedSessionIds) || []);
  const pinnedProjects = loadPinnedProjectsForMirror();
  const looseHidden = loadLooseHiddenSetForMirror();
  // payload 每次渲染按当前数据重算；字符串按值比较，内容不变 deps 就不变
  const orderPayload = React.useMemo(
    () => JSON.stringify({
      projects: computeSidebarOrderForMirror({ byId, archived, looseHidden, pinnedProjects })
        .map((row) => ({
          name: row.name,
          chips: (row.chips || []).map((chip) => ({ label: chip.label, cloneCount: chip.cloneCount || 0 })),
        })),
    }),
    [byId, workspaces, pinnedProjects.join('\u0000')],
  );
  const pinnedPayload = React.useMemo(
    () => JSON.stringify({ list: pinnedProjects }),
    [pinnedProjects.join('\u0000')],
  );
  React.useEffect(() => {
    const send = () => {
      try {
        fetch('/hub/order', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: orderPayload,
        }).catch(() => {});
        fetch('/hub/pinned', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: pinnedPayload,
        }).catch(() => {});
      } catch (error) { /* Host 未起就下次再发 */ }
    };
    const timer = setTimeout(send, 300);
    const heartbeat = setInterval(send, 60_000);
    return () => { clearTimeout(timer); clearInterval(heartbeat); };
  }, [orderPayload, pinnedPayload]);
  return null;   // 不占视觉位置
}

function HubWorkspaces(props) {
      const workspaces = props.useWorkspaces((s) => s);
      const sessions = props.useSessions((s) => s);
      const [closed, setClosed] = React.useState({});
      const [editingId, setEditingId] = React.useState(null);
      const [clearArmed, setClearArmed] = React.useState(false);
      const [clearMsg, setClearMsg] = React.useState('');
      const clearTimer = React.useRef(null);
      // —— subagent 子会话不进侧栏（2026-10-24 用户令）——
      // 忽略名单（localStorage 持久）。探测 effect 放在 `byId` 声明之后（见下方
      // `untitledProbeKey`）——⚠️ 2026-10-24 事故：把 `Object.keys(byId)` 写在 byId 声明
      // 之前 → 每次渲染 TDZ ReferenceError → HubWorkspaces 整块渲染失败 → 侧栏回退成
      // DSH 原生会话列表（用户报「侧栏变成这样了」）。Hooks 顺序不变、只挪计算位置。
      const [looseHidden, setLooseHidden] = React.useState(() => new Set(loadLooseHidden()));
      const looseProbedRef = React.useRef(new Set());
      // —— 快捷栏「完成未读」（2026-10-24 用户需求）——
      // 未读注册表（localStorage 持久）+ 上一拍 running 快照（检测 true→false 翻转）。
      // 翻转/清除/再跑/归档的全部判定在纯函数 computeRunbarUnread（上方 RUNBAR-PURE 段，可单测）。
      const [runbarUnread, setRunbarUnread] = React.useState(() => loadRunbarUnread());
  // 空闲时长补全后靠这个 tick 触发一次重渲染（lastActiveTimes 是模块级对象，不是 state）
  const [, setLastActiveTick] = React.useState(0);
      const prevRunningRef = React.useRef(new Set());
      // 2026-11-11：启动时以 Host 为准并入未读（手机/桌面共用 `.hub/unread.json`）
      React.useEffect(() => { syncHostUnreadOnMount(setRunbarUnread); }, []);
      React.useEffect(() => {
        // 当前打开的会话（与高亮判定同一来源）
        let cur = null;
        try {
          const el = document.querySelector('[data-conversation-content]');
          cur = el ? el.getAttribute('data-conversation-session') : null;
        } catch (error) { cur = null; }
        const result = computeRunbarUnread({
          byId,
          prevRunning: prevRunningRef.current,
          unread: runbarUnread,
          currentId: cur,
          // 2026-10-28：归档即清未读（旧壳 pill 常驻的根因——归档会话仍在 byId 里）
          archivedIds: new Set((workspaces && workspaces.archivedSessionIds) || []),
        });
        // 2026-11-09：这轮跑完的会话记下时间，给侧栏空闲时长用（session.updatedAt 不可靠）
  for (const id of prevRunningRef.current) {
    if (!result.nextRunning.has(id)) markLastActive(id, Date.now());
  }
  prevRunningRef.current = result.nextRunning;
        if (result.changed) {
          saveRunbarUnread(result.unread);
          setRunbarUnread(result.unread);
          // 2026-11-11：未读变化同步给 Host（增量 add/remove，不做整表覆盖）。
          // 还没完成首次并入（ready=false）时只对齐本地快照，避免把 Host 里已有的项当成"已读"删掉。
          if (HOST_UNREAD_SYNCED.ready) diffSyncHostUnread(result.unread);
          else HOST_UNREAD_SYNCED.ids = new Set(Object.keys(result.unread || {}));
        }
      });
      // 空闲时长补全（2026-11-09）：DSH 的 sessions 投影没有 updatedAt，但 /hub/session-events
  // 每条事件都有 time。对还没有本地记录的会话拉一次 limit=1（= 最后一条），取 time 作为
  // 「最后一次活动」。只补前 80 个、串行、已有记录就跳过，避免 195 个会话把页面拖死。
  React.useEffect(() => {
    let cancelled = false;
    // 2026-11-09 修：原来按 Object.keys 顺序只取前 80 个 → 用户看的会话可能不在其中，
    // 时长永远补不上（这正是「侧边栏还是没有计时」的第二个根因）。改成：
    // 没记录的先行，其中**分身**（标题带「｜」）优先——用户最常盯的就是分身行。
    const ids = Object.keys(byId)
      .filter((id) => !lastActiveOf(id))
      .sort((a, b) => {
        const isClone = (x) => (String((byId[x] && byId[x].displayTitle) || '').includes('｜') ? 1 : 0);
        return isClone(b) - isClone(a);
      })
      .slice(0, 200);
    if (ids.length === 0) return undefined;
    (async () => {
      for (const id of ids) {
        if (cancelled) return;
        try {
          const res = await fetch(`/hub/session-events?session=${encodeURIComponent(id)}&limit=1`);
          const data = await res.json();
          const events = (data && data.events) || [];
          const last = events[events.length - 1];
          if (last && last.time) markLastActive(id, last.time);
        } catch { /* 单个失败跳过 */ }
      }
      if (!cancelled) setLastActiveTick((n2) => n2 + 1);
    })();
    return () => { cancelled = true; };
  }, [byId]);
  const [, bumpRoomPage] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        roomPageState.listeners.add(bumpRoomPage);
        return () => { roomPageState.listeners.delete(bumpRoomPage); };
      }, []);
      // 侧栏宽度自适应（多候选取最大，2026-10-20 重做）：props.wide 是挂载时的静态值，
      // 拖动侧栏后必须靠实测驱动布局。单测 [data-slot="sidebar"] 不行——座位层可能是
      // display:contents（rect 宽 0）、也可能只是个包住固定宽内层 div 的壳，两种情况下
      // 读到的都不是真实可用的横向空间（症状：拖到 400px 芯片仍恒 2 列）。
      // 现在同时测 slot、slot 的首个子元素、它的父级两级、以及我们自己的芯片容器，
      // 取其中最大者；同一个 ResizeObserver 观察全部候选，另有 500ms 兜底重测，
      // 侧栏重挂/节点替换后自动补绑（不需要刷新）。
      const [sidebarWidth, setSidebarWidth] = React.useState(0);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        let raf = 0;
        const seen = new WeakSet();
        const observer = typeof ResizeObserver === 'function'
          ? new ResizeObserver(() => { schedule(); })
          : null;
        const measure = () => {
          // 比窗口 60% 还宽的候选多半是外壳根节点而不是侧栏，丢掉避免列数虚高
          const limit = Math.max(280, window.innerWidth * 0.6);
          const found = [];
          const consider = (label, node) => {
            if (!node || typeof node.getBoundingClientRect !== 'function') return;
            const rect = node.getBoundingClientRect();
            const width = Math.round(rect.width || node.offsetWidth || 0);
            if (!(width > 0) || width > limit) return;
            found.push({ label, node, width });
          };
          const slot = document.querySelector('[data-slot="sidebar"]');
          consider('slot', slot);
          consider('slotFirst', slot && slot.firstElementChild);
          let up = slot;
          for (let i = 1; i <= 2 && up; i += 1) {
            up = up.parentElement;
            consider(`slot^${i}`, up);
          }
          consider('ours', rootRef.current);
          if (observer) {
            for (const item of found) {
              if (seen.has(item.node)) continue;
              seen.add(item.node);
              try { observer.observe(item.node); } catch { /* 不是 Element 就跳过 */ }
            }
          }
          const best = found.reduce((acc, item) => (item.width > acc ? item.width : acc), 0);
          if (best > 0) setSidebarWidth((prev) => (Math.abs(prev - best) >= 1 ? best : prev));
        };
        function schedule() {
          if (raf) return;
          raf = requestAnimationFrame(() => { raf = 0; measure(); });
        }
        schedule();
        const timer = setInterval(measure, 500);   // 兜底：拖拽改的是祖先或内联尺寸、RO 不触发时也能跟上
        window.addEventListener('resize', schedule);
        return () => {
          if (raf) cancelAnimationFrame(raf);
          clearInterval(timer);
          window.removeEventListener('resize', schedule);
          if (observer) observer.disconnect();
        };
      }, []);
      const wide = sidebarWidth > 0 ? sidebarWidth >= 72 : props.wide !== false;
      // 芯片网格列数：窄 1 列、常规 2 列、宽 3 列（拖动侧栏即可看到重排）。
      // 阈值复核（2026-10-20，依据 ui-layout 的 computeColumns / setSidebar）：
      // 外壳把可拖范围夹在 264–420px，所以 <150 的 1 列只在布局过渡态出现，
      // 折叠成 56px 轨道时走下面的轨道模式。320 正好落在可拖范围 36% 处，
      // 320–420 这一段共 100px 给出 3 列，不算偏大，保留。
      const chipColumns = sidebarWidth <= 0 ? 2 : sidebarWidth < 150 ? 1 : sidebarWidth < 320 ? 2 : 3;

      // 2026-10-29 三段（用户令「subagent 分身按既有分身方式显示：侧栏归父 + 分多栏」）：
      // 探到 subagent 且能定位父（/hub/session-subagent 返回 parentTitle）→ 把它的
      // displayTitle 覆写为「<父标题>｜<label截断>」——自动获得「项目 · 父名｜短语」形态，
      // 侧栏芯片归父聚合（+N）、CloneColumns 分列、runbar 聚合全部复用既有逻辑。
      // 无父的 subagent 仍走旧的 loose-hidden 隐藏。
      const [subagentTitles, setSubagentTitles] = React.useState(() => ({}));
      const rawById = (sessions && sessions.byId) || {};
      const byId = Object.keys(subagentTitles).length
        ? Object.fromEntries(Object.entries(rawById).map(([id, session]) => [
          id,
          (subagentTitles[id] && session && !session.blank)
            ? { ...session, displayTitle: subagentTitles[id] }
            : session,
        ]))
        : rawById;
      // subagent 探测（2026-10-24）：**必须在 byId 之后**（TDZ 事故教训——写在前面会让
      // HubWorkspaces 每次渲染抛 ReferenceError、整块侧栏回退成 DSH 原生列表）；
      // 依赖 = 待探测 id 列表键（无依赖会被 nowTick 每秒重渲染取消，45s 只探完 2 个）。
      const untitledProbeKey = Object.keys(byId)
        .filter((id) => {
          const session = byId[id];
          return session && !session.blank
            && !(session.displayTitle || '').includes(' · ')
            && !looseHidden.has(id);
        })
        .sort()
        .join(',');
      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          for (const id of untitledProbeKey ? untitledProbeKey.split(',') : []) {
            if (cancelled) return;
            if (looseProbedRef.current.has(id)) continue;
            looseProbedRef.current.add(id);
            const info = await probeSubagentInfo(id);
            if (!info) { looseProbedRef.current.delete(id); continue; } // 查不到允许下次重试
            if (info.subagent && info.parentTitle) {
              // 2026-10-29：有父的 subagent → 覆写 displayTitle 为「父标题｜label」，
              // 纳入既有分身体系（侧栏归父 +N / CloneColumns 分列 / runbar 聚合），不隐藏。
              const label = String(info.label || '任务').trim().slice(0, 14);
              const title = `${info.parentTitle}｜${label}`;
              if (!cancelled && subagentTitles[id] !== title) {
                setSubagentTitles((prev) => ({ ...prev, [id]: title }));
              }
              console.log(`[hub-desktop-ui] subagent ${id} mapped to clone title: ${title}`);
            } else if (info.subagent) {
              // 无父可认 → 维持旧行为：隐藏（结果回传本体，子会话不占侧栏）
              const next = new Set(loadLooseHidden());
              next.add(id);
              saveLooseHidden([...next]);
              if (!cancelled) setLooseHidden(next);
              console.log(`[hub-desktop-ui] hid subagent session ${id}`);
            }
          }
        })();
        return () => { cancelled = true; };
      }, [untitledProbeKey]);
      const archived = new Set((workspaces && workspaces.archivedSessionIds) || []);
      const items = (workspaces && workspaces.items) || [];
      const firstWorkspaceId = items.length ? items[0].workspaceId : undefined;
      lastWorkspaceId = firstWorkspaceId;

      // agent 的生命周期（新增/停用）归 Yat2 管理，侧栏芯片不提供手动归档入口。

      // 队列驱动器常驻在这里：房间关着也继续推进（一条处理完才发下一条）
      const byIdRef = React.useRef(byId);
      byIdRef.current = byId;
      const archivedRef = React.useRef(archived);
      archivedRef.current = archived;
      React.useEffect(() => {
        const timer = setInterval(() => { driveRoomQueues(byIdRef.current, archivedRef.current); }, 2500);
        return () => clearInterval(timer);
      }, []);

      // 运行时长：1s 一跳；running false→true 时记起始时刻，true→false 时删掉。
      // 同一拍还给每个运行中会话所属的项目累计「今日运行时长」（localStorage 持久，
      // key 带当天日期，跨天自然归零；刷新/重启不丢）。
      const [nowTick, setNowTick] = React.useState(Date.now());
      const runStart = React.useRef(new Map());
      const sessionProject = React.useRef(new Map());
      React.useEffect(() => {
        let lastAt = Date.now();
        const timer = setInterval(() => {
          const now = Date.now();
          const dt = Math.min(2000, now - lastAt);   // 后台节流/休眠后回一次性多补的时长
          lastAt = now;
          const d = new Date();
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          for (const id of runStart.current.keys()) {
            const name = sessionProject.current.get(id);
            if (!name) continue;
            const key = `hub.runTotal.${name}.${day}`;
            try { localStorage.setItem(key, String((Number(localStorage.getItem(key)) || 0) + dt)); } catch { /* 存储不可用就算了 */ }
          }
          setNowTick(now);
        }, 1000);
        return () => clearInterval(timer);
      }, []);
      for (const id of Object.keys(byId)) {
        if (byId[id] && byId[id].running) {
          if (!runStart.current.has(id)) runStart.current.set(id, Date.now());
        } else {
          runStart.current.delete(id);
        }
      }

      const openSession = (id) => {
        // 2026-10-27 十一修（用户："这样切换就不贴底了，还得手动滚"）：
        // 结论——「回切必到底」与「不闪」同时成立的唯一时机，是**在 DSH 换内容之前**就把会话区遮住。
        // 等 MutationObserver 发现 data-conversation-session 变化时，DSH 已经把还原后的位置画出来过一帧了，
        // 那时再隐藏/再拉到底，用户看到的就是"内容闪一下 + 跳一下"。
        // 这里点击时同步打标记（我们的侧栏/快捷栏点击都走 openSession），DSH 渲染前内容即不可见，
        // 之后 ②d 贴底完成再撤标记 → 用户第一眼看到的就在底部，且全程无闪。
        // 2026-10-28 十六修①（用户："遮罩只在再次点击当前对话时生效"= 点当前会话白闪 900ms）：
        // 目标 id 与当前会话相同 → 不会有会话切换 → 打了遮罩没人撤（只能等兜底）= 白闪。
        // 同 id 一律不打遮罩。
        try {
          const currentEl = document.querySelector('[data-conversation-content][data-conversation-session]');
          const currentId = currentEl ? currentEl.getAttribute('data-conversation-session') : '';
          if (String(id) !== String(currentId)) {
            document.documentElement.setAttribute('data-hub-stick-switch', '1');
            // 2026-11-09 用户令「取消分列视图」收尾：这里原本会**同步预挂** data-hub-clone-cols
            // （为了让分列面板同帧落位、不先露一帧原生单视图）。CloneColumns 已不再挂载
            // （见 68da80c 注释掉注册），这个钩子没人摘 → 原生消息区会被 CSS 永久隐藏（空白会话）。
            // 分列取消后该预挂逻辑一并删除，并顺手清掉可能残留的钩子。
            try { delete document.documentElement.dataset.hubCloneCols; } catch (error) { /* ignore */ }
            clearTimeout(openSession.__switchingTimer);
            openSession.__switchingTimer = setTimeout(() => {
              document.documentElement.removeAttribute('data-hub-stick-switch');
            }, 900); // 兜底：900ms 内必显示（②d 贴底成功会提前撤）
          }
        } catch (error) { /* ignore */ }
        // 点 agent 芯片 = 回到会话（群聊是独立面板，要先离开它）
        closeRoomPage();
        const svc = service('uiWorkspace');
        if (svc && typeof svc.openSession === 'function') svc.openSession(id);
      };

      // —— 分身分列（B 半 v2）——
      // 打开父 agent 会话时，会话内容区换成「父 + 各分身」的 N 列聊天正文
      // （CloneColumns，挂在 shell.overlay）。侧栏这边每次渲染把 sessions 快照
      // 发布过去——overlay 拿不到 store props，靠这个桥拿数据。
      React.useEffect(() => {
        publishCloneColumns(byId, archived, openSession);
      });

      const startSession = () => {
        const svc = service('uiWorkspace');
        if (!svc || typeof svc.startSession !== 'function') return;
        // 禁止临时会话（2026-10-24 用户令）：新建会话一律带「项目 · 角色」标题——
        // 记下创建前的会话集合，新会话落地后立刻预命名 `项目 · 新会话`（项目优先取
        // 当前打开会话的项目前缀，退化用第一个项目组；Host 侧 sweepUntitledSessions
        // 兜底归位/归档无归属会话）。
        const before = new Set(Object.keys(byId));
        if (firstWorkspaceId === undefined) svc.startSession();
        else svc.startSession(firstWorkspaceId);
        const projectGuess = (() => {
          try {
            const el = document.querySelector('[data-conversation-content]');
            const cur = el ? byId[el.getAttribute('data-conversation-session')] : null;
            const t = cur && cur.displayTitle;
            if (t && t.includes(' · ')) return t.slice(0, t.lastIndexOf(' · ')).trim();
          } catch (error) { /* 读不到走退化 */ }
          try {
            if (typeof orderedRows !== 'undefined' && orderedRows.length) return orderedRows[0].name;
          } catch (error) { /* 未定义走放弃 */ }
          return '';
        })();
        if (!projectGuess) return;
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          if (tries > 20) { clearInterval(timer); return; }
          const fresh = Object.keys(byId).find((id) => !before.has(id));
          if (!fresh) return;
          clearInterval(timer);
          renameSession(fresh, `${projectGuess} · 新会话`).catch(() => {});
        }, 500);
      };

      /**
       * 直接进某个项目的群聊：找到该项目的主控会话（`… · Hermes`），
       * 先把它在 localStorage 里的 View 偏好写成 `hub-room`，再打开这个会话——
       * 会话装配时会按这个偏好直接落在「群聊」标签上。
       * 该会话已经打开时，先切走再切回，强制按偏好重建。
       */
      const openProjectRoom = (projectName) => {
        // 群聊是独立页面（全屏 overlay），不再塞进某个 agent 的会话视图
        openRoomPage(projectName);
      };
      const isActive = (id) => {
        const session = byId[id];
        return Boolean(session && session.retainedBy && (session.retainedBy.mainView || 0) > 0);
      };

      // 所有可见会话（按最近更新倒序），再按标题前缀归到项目。
      // 没有 `项目 · 智能体` 前缀的会话归到共享的 Hub 项目（本机只有 AI-Agent-Hub 一个 workspace，
      // 记忆/skill/hook 全共享，所以「项目」是逻辑分组，不是 workspace）。
      const visible = Object.keys(byId)
        .filter((id) => byId[id] && !archived.has(id) && !looseHidden.has(String(id)))
        .sort((a, b) => (byId[b].updatedAt || 0) - (byId[a].updatedAt || 0));

      // 认领「新建项目」刚建出来的会话 → 命名 `<项目> · Yat2`（2026-11-02 修：
      // NewProjectDialog 在 startSession 分支拿不到 sessionId，改名被跳过，导致新项目没有管理者）。
      // 用「上一次渲染的 id 集合」做差集精确定位新会话，比"轮询+标题猜测"可靠；
      // 30 秒未认领自动作废（避免用户取消/失败后误改后来的会话）。
      const knownSessionIds = React.useRef(null);
      React.useEffect(() => {
        const claim = newProjectState.claim;
        if (claim && Date.now() - (claim.at || 0) < 30000) {
          const prev = knownSessionIds.current;
          if (prev) {
            const fresh = Object.keys(byId).find((id) => !prev.has(id));
            if (fresh) {
              newProjectState.claim = null;
              renameSession(fresh, `${claim.project} · Yat2`).catch(() => { /* 改名失败就留着未命名会话 */ });
            }
          }
        } else if (claim) {
          newProjectState.claim = null; // 过期作废
        }
        knownSessionIds.current = new Set(Object.keys(byId));
      }, [byId]);

      const hubName = (items[0] && items[0].title) || 'AI-Agent-Hub';
      const projects = new Map();
      const add = (name, entry) => {
        if (!projects.has(name)) projects.set(name, []);
        projects.get(name).push(entry);
      };
      // 没有 `项目 · 智能体` 前缀的会话不属于任何项目：不生成项目行，只放在「未分类」区
      const loose = [];
      for (const id of visible) {
        const parsed = parseCloneTitle(byId[id].displayTitle);
        const entry = { id, label: parsed.agent, hint: byId[id].displayTitle };
        if (parsed.project) add(parsed.project, entry);
        else loose.push(entry);
      }
      // 项目顺序 = 其最活跃成员的顺序（visible 已排好，Map 插入序即最近优先）
      // 成员顺序：管理者（Yat2）永远排首位，其余按最后使用时间从近到远（sort 稳定，保持原时间序）
      const isManagerName = (label) => MANAGER_NAMES.includes(String(label || '').trim());
      const managerFirst = (a, b) => (isManagerName(a.label) ? 0 : 1) - (isManagerName(b.label) ? 0 : 1);
      const projectRows = [...projects.entries()].map(([name, members]) => {
        // —— 分身不单独占 chip（2026-10-20）——
        // 命名约定 `<成员>｜<任务名>`：分身并进父 agent 的 chip（子行 + 数量徽标）。
        // `members` 保持全量（项目「今日运行」按它归账、relTime 也看真实活跃），
        // `chips` 才是画出来的那一行。
        // 子行/徽标/分列三处**同一个函数** listUnarchivedClones（2026-10-21 用户要求同源）。
        const parentByLabel = new Map();
        for (const m of members) if (!cloneSplitLabel(m.label)) parentByLabel.set(m.label, m);
        const chips = [];
        const emitted = new Set();
        for (const m of members) {
          const clone = cloneSplitLabel(m.label);
          if (clone) {
            const parent = parentByLabel.get(clone.base);
            // 父会话已归档 / 不存在：分身退化成普通 chip，避免会话从侧栏彻底消失
            if (!parent) { chips.push({ ...m, cloneCount: 0 }); continue; }
            // 父 chip 的位置 = 它自己或它任一分身最近活跃的那一刻（分身的活跃把父顶上来）
            if (emitted.has(clone.base)) continue;
            emitted.add(clone.base);
            const list = listUnarchivedClones(byId, archived, parent.id);
            chips.push({ ...parent, cloneCount: list.length, clones: list.map((c) => ({ id: c.id, name: c.name })) });
            continue;
          }
          if (emitted.has(m.label)) continue;
          emitted.add(m.label);
          const list = listUnarchivedClones(byId, archived, m.id);
          chips.push({ ...m, cloneCount: list.length, clones: list.map((c) => ({ id: c.id, name: c.name })) });
        }
        return {
          name,
          members: [...members].sort(managerFirst),
          chips: chips.sort(managerFirst),
        };
      });
      // 刷新「会话 → 所属项目」映射（1s tick 累计今日运行时长时按它归账）
      sessionProject.current = new Map();
      for (const row of projectRows) {
        for (const m of row.members) sessionProject.current.set(m.id, row.name);
      }
      // 项目色相注册表：侧栏看到的全量项目名单（变化时自动重算，同一次渲染内口径一致）
      updateProjectHues(projectRows.map((r) => r.name));

      // 芯片头像（2026-10-26 修订，用户报「论文写手没头像」）：**以全局注册表
      // .hub/avatars.json 为唯一真源**（GET /hub/avatars，一次拉取 + 焦点/可见时刷新），
      // DEFAULT_AVATARS 只作兜底；分身按 `｜` 前的基名继承父头像。
      const [globalAvatars, setGlobalAvatars] = React.useState({});
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetch('/hub/avatars')
            .then((res) => res.json())
            .then((value) => { if (alive && value && typeof value === 'object') setGlobalAvatars(value); })
            .catch(() => { /* Host 未起就只用兜底表 */ });
        };
        load();
        const onFocus = () => load();
        window.addEventListener('focus', onFocus);
        // 2026-10-26：SSE avatars-change 事件实时刷新（Host fs.watch .hub/avatars.json）
        const es = (typeof EventSource !== 'undefined') ? new EventSource('/hub/events') : null;
        if (es) {
          es.onmessage = (msg) => {
            try {
              const data = JSON.parse(msg.data);
              if (data && data.type === 'avatars-change') load();
            } catch (error) { /* ignore */ }
          };
        }
        return () => {
          alive = false;
          window.removeEventListener('focus', onFocus);
          if (es) es.close();
        };
      }, []);
      const chipAvatarFor = (_projectName, label) => {
        const base = String(label || '').split('｜')[0].trim();
        return globalAvatars[label]
          || globalAvatars[base]
          || DEFAULT_AVATARS[label]
          || DEFAULT_AVATARS[base]
          || undefined;
      };

      // 项目置顶：localStorage["hub.pin.projects"]（JSON 数组，存项目名）。
      // 排序 = 置顶排最前（多个置顶之间维持原相对顺序，sort 稳定），其余仍按最近活跃。
      const [pinnedProjects, setPinnedProjects] = React.useState(() => {
        try {
          const parsed = JSON.parse(localStorage.getItem('hub.pin.projects') || '[]');
          return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
        } catch { return []; }
      });
      const togglePin = (name) => {
        setPinnedProjects((prev) => {
          const next = prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name];
          try { localStorage.setItem('hub.pin.projects', JSON.stringify(next)); } catch { /* 存不了就只影响本次 */ }
          // 顺手落一份到 Host（.hub/pinned.json）：手机端 /sync/pinned 读同一份，
          // 否则手机端排序永远看不到置顶（它读不到桌面 localStorage）。
          try {
            fetch('/hub/pinned', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ list: next }),
            }).catch(() => {});
          } catch { /* Host 未起就只留在 localStorage */ }
          return next;
        });
      };
      const pinnedSet = new Set(pinnedProjects);
      const orderedRows = [...projectRows]
        .sort((a, b) => (pinnedSet.has(b.name) ? 1 : 0) - (pinnedSet.has(a.name) ? 1 : 0));

      // —— 侧栏搜索框（2026-11-01 用户需求：只搜项目和 agent 名称）——
      // 规则：项目名命中 → 整个项目全量显示；项目名不命中但某 agent 名命中 → 项目保留、只显示命中的 chip；
      // 未分类（loose）区同样按 agent 名过滤。搜索期间强制展开被折叠的项目（否则折叠态看不到命中成员）。
      const [sidebarSearch, setSidebarSearch] = React.useState('');
      const searchQ = String(sidebarSearch || '').trim().toLowerCase();
      const entryMatches = (entry) => String((entry && entry.label) || '').toLowerCase().includes(searchQ);
      const visibleRows = searchQ
        ? orderedRows
            .map((row) => {
              if (String(row.name).toLowerCase().includes(searchQ)) return row;
              const chips = (row.chips || []).filter(entryMatches);
              return chips.length ? { ...row, chips } : null;
            })
            .filter(Boolean)
        : orderedRows;
      const visibleLoose = searchQ ? loose.filter(entryMatches) : loose;

      // ⚠️ 顺序镜像心跳**已搬走**（2026-11-11）：原在这里（HubWorkspaces 组件内），
      // 但本组件 mount 在 `sidebar.workspaces`（priority -1），被 project-room 的
      // ProjectSidebar（priority -2）顶掉后**根本不渲染** → 心跳的 useEffect 不执行
      // → `.hub/order.json` 冻结（2026-10-28 就报过一次「停在两天前」，那次只加心跳没治根因）。
      // 现由模块级的 `OrderMirrorHeartbeat` 承担，mount 在 `shell.overlay`（不争 slot）。
      // **不要再把心跳加回本组件** —— 它随时可能被顶掉。

      // —— 轨道模式（侧栏折叠成 56px）：项目色块，点一下展开 ——
      if (!wide) {
        const squares = orderedRows.length > 0
          ? orderedRows.map((p) => ({ key: p.name, seed: p.name, label: (p.name.trim()[0] || '·').toUpperCase() }))
          : [{ key: '__loose', seed: hubName, label: 'A' }];
        return h(
          'div',
          { ref: rootRef, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', padding: '4px 0' } },
          ...squares.map((s) => {
            const hue = uniqueHue(s.seed);
            return h('button', {
              key: s.key,
              type: 'button',
              title: s.seed,
              onClick: () => { if (props.expandSidebar) props.expandSidebar(); },
              style: {
                width: '24px', height: '24px', borderRadius: '7px', border: 'none', cursor: 'pointer',
                background: `hsl(${hue} 38% 42%)`, color: '#fff', fontSize: '10px', fontWeight: 600,
              },
            }, s.label);
          }),
        );
      }

      const commitRename = async (id, value) => {
        setEditingId(null);
        const title = String(value || '').trim();
        const current = byId[id] && byId[id].displayTitle;
        if (!title || title === current) return;
        await renameSession(id, title);
      };

      // —— 侧栏 agent 右键菜单（2026-10-23 用户要求）——
      // 项目：改名 / 归档·恢复 / 复制 sessionId / 复制标题。
      // fixed 定位（贴在鼠标处），点空白或按 Esc 关闭。
      const [chipMenu, setChipMenu] = React.useState(null); // { id, title, x, y } | null
      React.useEffect(() => {
        if (!chipMenu) return undefined;
        const close = () => setChipMenu(null);
        const onKey = (event) => { if (event.key === 'Escape') close(); };
        window.addEventListener('click', close);
        window.addEventListener('contextmenu', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('click', close);
          window.removeEventListener('contextmenu', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [chipMenu]);
      const sessionAction = async (action, id, extra) => {
        try {
          const res = await fetch('/hub/session-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: id, action, ...(extra || {}) }),
          });
          const data = await res.json();
          if (!data || !data.ok) console.error('[hub-desktop-ui] session action failed', action, data && data.error);
          return Boolean(data && data.ok);
        } catch (error) {
          console.error('[hub-desktop-ui] session action request failed', error);
          return false;
        }
      };
      const copyText = async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (error) {
          console.error('[hub-desktop-ui] clipboard failed', error);
          return false;
        }
      };
      const renderChipMenu = () => {
        if (!chipMenu) return null;
        const archived = chipMenu.archived;
        const itemStyle = {
          display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px',
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary)', fontSize: '11.5px', whiteSpace: 'nowrap',
        };
        const item = (label, onClick, danger) => h('button', {
          key: label,
          type: 'button',
          style: danger ? { ...itemStyle, color: 'var(--dsw-alias-state-error-primary)' } : itemStyle,
          onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)'; },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
          onClick: (event) => {
            event.stopPropagation();
            setChipMenu(null);
            onClick();
          },
        }, label);
        return h('div', {
          style: {
            position: 'fixed',
            left: `${Math.min(chipMenu.x, Math.max(8, window.innerWidth - 210))}px`,
            top: `${Math.min(chipMenu.y, Math.max(8, window.innerHeight - 170))}px`,
            zIndex: 3000, minWidth: '180px', padding: '4px',
            borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)', boxShadow: '0 10px 28px rgb(0 0 0 / 32%)',
          },
          onClick: (event) => event.stopPropagation(),
        },
          h('div', {
            style: {
              padding: '4px 10px 6px', fontSize: '9.5px', color: 'var(--dsw-alias-label-secondary)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: '3px',
              maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, chipMenu.title),
          chipMenu.isClone
            ? h('div', { key: 'clone-items' },
              // —— 分身菜单（2026-11-02）：回收 + 复制；不给改名（改了会破坏「父名｜」结构）
              item('回收分身（归档，可恢复）', async () => {
                await sessionAction('archive', chipMenu.id, chipMenu.fullTitle ? { fullTitle: chipMenu.fullTitle } : null);
              }, true),
              item('复制 sessionId', () => { copyText(chipMenu.id); }),
              item('复制分身名', () => { copyText(chipMenu.title); }),
            )
            : h('div', { key: 'main-items' },
              item('改名…', () => setEditingId(chipMenu.id)),
              item(archived ? '取消归档（恢复到侧栏）' : '归档（从侧栏移除）', async () => {
                await sessionAction(archived ? 'restore' : 'archive', chipMenu.id);
              }, !archived),
              // 创建分身（2026-11-02 用户要求）：只在有项目归属的本体 chip 上提供
              chipMenu.project
                ? item('创建分身…', () => {
                  setSpawnText('');
                  setSpawnPrompt({ project: chipMenu.project, parent: chipMenu.title, x: chipMenu.x, y: chipMenu.y });
                })
                : null,
              item('复制 sessionId', () => { copyText(chipMenu.id); }),
              item('复制标题', () => { copyText(chipMenu.title); }),
            ),
        );
      };

      // —— 手动创建分身（2026-11-02 用户要求：右键 agent → 创建分身…）——
      // 输入任务短语 → startSession 建会话 → 命名 `项目 · 父名｜短语`（与 taskline_create 同一约定）→ 打开它。
      // 任务书由用户进会话后自己说第一句（UI 不代发 prompt）。
      const [spawnPrompt, setSpawnPrompt] = React.useState(null); // {project, parent, x, y} | null
      const [spawnText, setSpawnText] = React.useState('');
      const spawnClone = () => {
        const ctx = spawnPrompt || {};
        const short = String(spawnText || '').trim();
        setSpawnPrompt(null);
        if (!ctx.project || !ctx.parent || !short) return;
        const svc = service('uiWorkspace');
        if (!svc || typeof svc.startSession !== 'function') return;
        const before = new Set(Object.keys(byId));
        if (firstWorkspaceId === undefined) svc.startSession();
        else svc.startSession(firstWorkspaceId);
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          if (tries > 20) { clearInterval(timer); return; }
          const fresh = Object.keys(byId).find((sid) => !before.has(sid));
          if (!fresh) return;
          clearInterval(timer);
          renameSession(fresh, `${ctx.project} · ${ctx.parent}｜${short}`)
            .then(() => { openSession(fresh); })
            .catch(() => {});
        }, 500);
        setSpawnText('');
      };
      const renderSpawnPrompt = () => {
        if (!spawnPrompt) return null;
        const inputStyle = {
          flex: '1', minWidth: '150px', height: '24px', boxSizing: 'border-box',
          padding: '0 7px', borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)', fontSize: '11.5px', outline: 'none',
        };
        return h('div', {
          style: {
            position: 'fixed',
            left: `${Math.min((spawnPrompt.x || 80) + 4, Math.max(8, window.innerWidth - 300))}px`,
            top: `${Math.min((spawnPrompt.y || 80) + 4, Math.max(8, window.innerHeight - 90))}px`,
            zIndex: 3100, padding: '8px', minWidth: '230px',
            borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)', boxShadow: '0 10px 28px rgb(0 0 0 / 32%)',
            display: 'flex', flexDirection: 'column', gap: '6px',
          },
          onClick: (event) => event.stopPropagation(),
        },
        h('div', {
          style: { fontSize: '9.5px', color: 'var(--dsw-alias-label-secondary)' },
        }, `为 ${spawnPrompt.project} · ${spawnPrompt.parent} 创建分身`),
        h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center' } },
          h('input', {
            type: 'text',
            autoFocus: true,
            value: spawnText,
            placeholder: '任务短语（如：切换提速）',
            onChange: (event) => setSpawnText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') spawnClone();
              if (event.key === 'Escape') setSpawnPrompt(null);
            },
            style: inputStyle,
          }),
          h('button', {
            type: 'button',
            onClick: () => spawnClone(),
            style: {
              flex: '0 0 auto', height: '24px', padding: '0 9px', borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
              color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '11px',
            },
          }, '创建'),
        ),
        h('div', {
          style: { fontSize: '9px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.8 },
        }, '命名：项目 · 父名｜短语 · Enter 确认 / Esc 取消'));
      };

      const chipGrid = (entries, hueFor, avatarFor, projectName) => h(
        'div',
        {
          // 2026-10-25 修「拖动侧栏宽度时个别 agent 名显示不全」：
          // 行容器是 flex 项，默认 min-width:auto 会被内容撑出父容器、再被父级 overflow 裁掉；
          // 这里显式允许收缩 + 占满可用宽 + border-box，名字靠换行而不是被裁（不用省略号）。
          style: {
            display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '3px 0 2px 8px',
            minWidth: 0, width: '100%', maxWidth: '100%', boxSizing: 'border-box',
            overflowWrap: 'anywhere',
          },
        },
        ...entries.map((entry) => (editingId === entry.id
          ? h(ChipEditor, {
            key: entry.id,
            initial: byId[entry.id].displayTitle || entry.label,
            onCommit: (value) => { commitRename(entry.id, value); },
            onCancel: () => setEditingId(null),
          })
          : h(AgentChip, {
            key: entry.id,
            id: entry.id,
            title: entry.label,
            hint: entry.hint,
            hue: hueFor(entry),
            avatar: avatarFor ? avatarFor(entry.label) : undefined,
            count: entry.cloneCount || 0,
            // 子行：未归档分身（名称+运行点+时长）——与分列视图同一份名单（clonesOf 已滤归档）
            clones: (entry.clones || []).map((c) => {
              const startedAt = runStart.current.get(c.id);
              const cloneRunning = Boolean(byId[c.id] && byId[c.id].running);
              return {
                ...c,
                running: cloneRunning,
      // 真数据源顺序：会话自带的 updatedAt（若有）→ 本地记录的 lastActive → c.updatedAt
      updatedAt: (byId[c.id] && byId[c.id].updatedAt) || lastActiveOf(c.id) || c.updatedAt || 0,
                elapsed: cloneRunning && startedAt ? formatDuration(nowTick - startedAt) : '',
              };
            }),
            running: Boolean(byId[entry.id].running),
    // 空闲时也显示时长 → 需要会话的 updatedAt（2026-11-09 用户令：本体与分身都显示运行时长）
    updatedAt: (byId[entry.id] && byId[entry.id].updatedAt) || lastActiveOf(entry.id) || 0,
            elapsed: (() => {
              const startedAt = runStart.current.get(entry.id);
              return byId[entry.id].running && startedAt ? formatDuration(nowTick - startedAt) : '';
            })(),
            active: isActive(entry.id),
            onOpen: openSession,
            onRename: () => setEditingId(entry.id),
            // 本体右键：带上所属项目（「创建分身」要用 `项目 · 父名｜短语` 命名）
            onContextMenu: ({ id, title, x, y }) => setChipMenu({
              id, title, x, y, archived: archived.has(String(id)),
              project: projectName || '',
            }),
            // 分身子行右键：isClone 菜单（回收分身）；带完整标题供 host 做完整回收（停运行+清头像+交接档案）
            onCloneContextMenu: ({ id, name, x, y }) => setChipMenu({
              id, title: name, x, y, isClone: true, archived: archived.has(String(id)), project: projectName || '',
              fullTitle: (byId[id] && byId[id].displayTitle) || '',
            }),
          }))),
      );

      const head = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', padding: '2px 6px 6px', gap: '6px' } },
        h('span', {
          className: 'hub-head-label',
          style: {
            fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, 'Projects'),
        h('button', {
          type: 'button',
          title: '新建会话',
          onClick: startSession,
          style: {
            marginLeft: 'auto', width: '18px', height: '18px', borderRadius: '5px', border: 'none',
            cursor: 'pointer', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
            fontSize: '14px', lineHeight: 1,
          },
        }, '+'),
      );

      // 顶部「运行中」快捷栏（2026-10-23 用户要求）：所有正在跑的会话都能一眼看到、一点进去。
      // 2026-10-24 三态化（用户需求「完成未读」）：运行中（绿点+时长）/ 完成未读
      // （品牌色 ✓ 完成，保留待查看）/ 已读移出；当前打开的会话完成时直接移出不标未读。
      const runningSessions = Object.values(byId)
        .filter((session) => session && session.running && !session.blank
          && !looseHidden.has(String(session.id)))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      // 未读 pill：数据取 byId 现势（标题随改名走），不在 byId 的已被 effect 清掉
      // 2026-10-28 双保险：已归档的会话即使残留未读记录也不显示（旧壳 pill 不再常驻）
      const unreadSessions = Object.keys(runbarUnread)
        .filter((id) => byId[id] && !byId[id].blank && !byId[id].running && !archived.has(String(id))
          // 旧壳（重名守卫只改名不归档）不显示未读 pill
          && !/（旧壳\s/.test(String(byId[id].displayTitle || "")))
        .map((id) => byId[id])
        .sort((a, b) => (runbarUnread[String(b.id)].at || 0) - (runbarUnread[String(a.id)].at || 0));
      // —— 快捷栏聚合（2026-10-26 用户要求「分身与本体合并显示」，对齐侧栏芯片口径）——
      // 原来运行栏逐会话渲染 → `DSH工程师` 与 `DSH工程师｜副手` 是两个 pill。
      // 现在按「项目 + 父名」聚合成一个父 pill，右上角 `+N`（N = 在跑/未读的分身数）；
      // 只有分身活跃时仍显示父名 pill（父会话在 byId 里即可认亲）；孤儿分身（父会话
      // 已不存在/已归档）按自身名单独显示，不伪造父。
      const splitCloneName = (displayTitle) => {
        // 2026-11-09：「点本体打开分身」的另一半根因——分身任务名超长或带「（）」等标点时，
        // splitSessionTitle 把它判成"句子"（project=null、full=整串标题），分身于是被当成独立组，
        // pill 显示得像本体、点它却打开分身。这里改用 parseCloneTitle（与侧栏分身子行同一套解析）。
        const parsed = parseCloneTitle(displayTitle || '');
        const full = parsed.agent || displayTitle || '会话';
        const project = parsed.project || '';
        const parts = String(full).split('｜');
        const base = (parts[0] || '').trim() || full;
        return { full, base, project, isClone: parts.length > 1 && base !== full };
      };
      /** 找「项目 · 父名」的父会话 id（非分身）；找不到返回 ''。2026-10-29 快捷栏聚合用。 */
      const parentSessionIdOf = (project, base) => {
        let found = '';
        for (const key of Object.keys(byId)) {
          const s = byId[key];
          if (!s || s.blank) continue;
          if (archived.has(String(key))) continue;
          const n = splitCloneName(s.displayTitle);
          if (!n.isClone && n.base === base && n.project === project) {
            // 同项目同名理论上唯一；若有多条取最近活跃
            const prev = found ? byId[found] : null;
            if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) found = String(key);
          }
        }
        return found;
      };
      /**
       * 找 group 对应的**本体**会话（2026-11-09 用户报「快捷栏点本体却打开分身」）。
       * 只认「同项目 + 同成员名 + 标题不带 ｜」的在册未归档会话；找不到返回 null。
       *
       * 为什么不能只靠 group.parentId：父会话变冷（不在 byId）、已归档或被改名后，
       * parentSessionIdOf 返回 ''，旧代码就退化成「组内最近活跃」——那往往正是分身本身，
       * 于是点本体名字打开的是分身。这里按标题现查一次，且**永不返回分身**。
       */
      const bodySessionOf = (project, name) => {
        const wantProject = project || '';
        const full = wantProject ? `${wantProject} · ${name}` : String(name || '');
        let found = null;
        for (const key of Object.keys(byId)) {
          const s = byId[key];
          if (!s || s.blank) continue;
          if (archived.has(String(key))) continue;
          const n = splitCloneName(s.displayTitle);
          if (n.isClone) continue;                     // 分身永远不是本体
          // 双口径：解析出的「项目 + 成员名」吻合，或**原始标题**恰好等于 `项目 · 成员`
          // （标题里带「｜」但不是分身格式的个别情况，靠标题兜住）
          const rawTitle = String(s.displayTitle || '').replace(/\s*\(\d+\)\s*$/, '').trim();
          const same = (n.base === name && (n.project || '') === wantProject) || rawTitle === full;
          if (!same) continue;
          // 2026-11-09：s.updatedAt 在 DSH 投影里恒为 0，排序失效；改用 lastActiveOf
    if (!found || lastActiveOf(key) > lastActiveOf(found.id || '')) found = s;
        }
        return found;
      };
      const runbarGroups = (() => {
        const groups = new Map();
        const ensure = (project, name) => {
          const key = `${project}\u0000${name}`;
          let group = groups.get(key);
          if (!group) {
            group = { key, project, name, running: [], done: [], cloneCount: 0, parentId: '', cloneMembers: [] };
            groups.set(key, group);
          }
          return group;
        };
        const place = (session, mode) => {
          const n = splitCloneName(session.displayTitle);
          // 分身且父会话仍在 → 归父组；否则（孤儿分身）按自身名单独成组
          const parentId = n.isClone ? parentSessionIdOf(n.project, n.base) : '';
          const group = n.isClone && parentId
            ? ensure(n.project, n.base)
            : ensure(n.project, n.isClone ? n.full : n.base);
          if (parentId) group.parentId = parentId;
          (mode === 'running' ? group.running : group.done).push(session);
          if (n.isClone) {
            group.cloneCount += 1;
            // 2026-10-29 用户令「快捷栏也要像侧栏那样显示分身」：记下分身名/状态，
            // 渲染成子标签（不再只折成 +N 数字）。
            group.cloneMembers.push({
              id: String(session.id),
              name: n.full.slice(n.base.length).replace(/^｜/, '').trim() || n.full,
              running: Boolean(session.running),
              updatedAt: session.updatedAt || 0,
            });
          }
        };
        runningSessions.forEach((session) => place(session, 'running'));
        unreadSessions.forEach((session) => place(session, 'done'));
        return [...groups.values()].map((group) => {
          const members = [...group.running, ...group.done];
          const latestAt = members.reduce((max, m) => Math.max(max, m.updatedAt || 0), 0);
          // 点击目标（2026-11-09 用户令改口径）：pill 主区域（名字/头像）= **打开本体**。
          // 旧规则「有父就开父（进分列）→ 否则组内最近活跃」有两个坑：
          // ①父会话变冷 / 已归档 / 改名后 parentId 解析成 ''，就退化成组内最近活跃 = **分身**
          //   → 用户看到的现象就是「点本体却打开分身」；
          // ②分列视图已按用户要求取消（2026-11-09），旧规则的前提也不存在了。
          // 现在：先认 parentId（校验存在、非空、未归档），再按「项目 · 成员名」现查本体；
          // 两条都拿不到 → openTarget = null，pill 只给提示、**绝不退化成组内成员**。
          const parentSession = group.parentId ? byId[group.parentId] : null;
          const openTarget = (parentSession && !parentSession.blank
            && !archived.has(String(group.parentId)))
            ? parentSession
            : bodySessionOf(group.project, group.name);
          return {
            ...group,
            members,
            mode: group.running.length > 0 ? 'running' : 'done',
            openTarget,
            latestAt,
            extra: Math.max(0, group.cloneCount),
          };
        }).sort((a, b) => {
          // 2026-11-02 用户要求：**「完成未读」的组置顶**（跑完等你读的排最前，提醒优先），
          // 其后是仍在运行的组，同类内按组内最近活跃倒序。
          // 注意 mode 的定义（L3978）：组内还有 running 成员就是 'running'，
          // 所以只有**整组都跑完**才算完成未读，避免把「一半还在跑」的组误置顶。
          if (a.mode !== b.mode) return a.mode === 'done' ? -1 : 1;
          // openTarget 现在只有本体、可能为 null（孤儿分组）→ 排序改用组内最近活跃兜底
          const lastAt = (g) => (g.openTarget && g.openTarget.updatedAt) || g.latestAt || 0;
          return lastAt(b) - lastAt(a);
        });
      })();
      // 当前打开的会话（高亮与未读判定同一来源）
      const runbarCurrentId = (() => {
        try {
          const el = document.querySelector('[data-conversation-content]');
          return el ? el.getAttribute('data-conversation-session') : null;
        } catch (error) { return null; }
      })();
      /** 渲染一个「聚合 pill」：一个父名一个 pill，分身折成 +N。 */
      const renderRunPill = (group) => {
        // openTarget = **本体**（点击只认它）。孤儿分组（本体已归档/改名）没有 openTarget，
        // 下面用组内最近活跃**仅作展示**（名字/时长/高亮），点击不会落到它身上（见 onClick）。
        const session = group.openTarget
          || group.members.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        if (!session) return null;
        const mode = group.mode;
        const name = group.name;
        const project = group.project;
        const hue = uniqueHue(project || name);
        // 头像/运行时长**与侧栏芯片同源**（2026-10-23 用户要求"原样复制一份一模一样的"）：
        // chipAvatarFor 返回的是**字符串 emoji**（不是对象），时长复用芯片那套
        // runStart + nowTick 计算，运行中点沿用 success 色。
        const avatarEmoji = chipAvatarFor(project, name) || '';
        // 时长取「组内在跑的最新成员」（openTarget 不一定是最近活跃的那个——本体常常在歇着）
        const runMember = (group.running.length > 0 ? group.running : group.members)
          .slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        const startedAt = runMember ? runStart.current.get(runMember.id) : undefined;
        const elapsed = mode === 'running' && runMember && runMember.running && startedAt
          ? formatDuration(nowTick - startedAt) : '';
        // 高亮只给**当前打开的会话**（2026-10-23 用户要求「高亮我当前的对话就好了」）：
        // 判定用内容区真实 attribute `data-conversation-session`；聚合组内任一成员是当前会话即高亮。
        const isCurrent = runbarCurrentId
          ? group.members.some((member) => String(member.id) === String(runbarCurrentId))
          : (group.openTarget ? isActive(group.openTarget.id) : false);
        const done = mode === 'done';
        const memberTitles = group.members.map((member) => member.displayTitle || splitCloneName(member.displayTitle).full);
        const pillNode = h('button', {
          key: `run-pill-${group.key}`,
          type: 'button',
          className: 'hub-run-chip',
          'data-active': isCurrent ? '1' : '0',
          'data-mode': mode,
          'data-clones': String(group.extra),
          title: group.openTarget
            ? ((group.extra > 0
              ? `${name}（聚合 ${group.members.length} 个会话：${memberTitles.join(' / ')}）· 点开本体`
              : (session.displayTitle || name))
              + (done ? ' · 完成待查看' : (elapsed ? ` · 运行中 ${elapsed}` : '')))
            // 本体取不到（已归档/改名/分身孤儿组）：只提示，点了不跳——绝不跳到分身
            : `${name}：找不到本体会话（可能已归档或改名），点这里不会跳转`,
          onClick: (event) => {
            event.stopPropagation();
            // 2026-11-09 用户令：pill 主区域（名字/头像/项目色块）= **打开本体**，只认 openTarget。
            // 拿不到本体就什么都不做；旧代码在这里退化到「组内最近活跃」，而那个常常就是分身，
            // 正是「点本体却打开分身」的根因，已删除。
            if (!group.openTarget) return;
            openSession(group.openTarget.id);
          },
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            // 2026-10-27 用户报「运行栏高度不对」：pill 内部换行会把药丸撑成两行，
            // 再被外层裁掉。改为**单行不换行、按内容撑开**；放不下由运行栏整行折行承接
            // （栏本身就是 flex-wrap:wrap，新药丸换到下一行，不会切字）。
            flex: '0 0 auto', maxWidth: '100%', minWidth: 0,
            // 2026-11-04 用户报「快捷栏分身显示还是有问题」（截图：分身子标签/绿点压在父名文字上）：
            // 根因 = maxWidth 100% 把 pill 卡在栏宽，而下面所有子项都是 flex:0 0 auto（不许收缩），
            // 内容总宽超出 pill 盒子时就**溢出画到盒子外**、压到相邻文字上。
            // 兜底加 overflow:hidden —— 宁可裁切也不出界重叠；同时让「名字」可收缩带省略号（见下），
            // 空间不足时先截父名、保住分身标签。
            overflow: 'hidden',
            minHeight: '20px',
            padding: '2px 7px 2px 3px', borderRadius: '11px',
            border: `1px solid ${isCurrent ? 'var(--dsw-alias-border-l1)' : 'transparent'}`,
            background: isCurrent ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: isCurrent ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            font: 'inherit', fontSize: '11.5px', cursor: 'pointer', lineHeight: 1.2,
            whiteSpace: 'nowrap',
          },
        },
          // 头像（与芯片完全一致：emoji 或首字母色底）
          h('span', {
            style: {
              width: '16px', height: '16px', borderRadius: '50%',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              flex: '0 0 auto',
              fontSize: avatarEmoji ? '12px' : '9px',
              fontWeight: 600,
              color: avatarEmoji ? 'inherit' : '#fff',
              background: avatarEmoji ? 'transparent' : `hsl(${hue} 40% 40%)`,
              lineHeight: 1,
            },
          }, avatarEmoji || (name.trim()[0] || '·').toUpperCase()),
          // 项目名（同名 agent 跨项目区分，用户明确要求；2026-10-23 用户令「项目名称带一下颜色」）
          // 色相走既有 uniqueHue（持久表 localStorage['hub.project.hues']，不新算），
          // 颜色公式与**侧栏项目行标题**完全一致 `hsl(hue 50% 68%)` —— 同项目两边同色；
          // 前置一个同 hue 色块（与侧栏项目行 6px/radius 2px 同款），对应首版 7510502 的色相圆点。
          project
            ? h('span', {
              title: `所属项目：${project}`,
              style: {
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                flex: '0 0 auto', minWidth: 0,
              },
            },
              h('span', {
                style: {
                  width: '6px', height: '6px', borderRadius: '2px', flex: '0 0 auto',
                  background: `hsl(${hue} 45% 50%)`,
                },
              }),
              h('span', {
                style: {
                  fontSize: '9px', lineHeight: 1, fontVariantNumeric: 'tabular-nums',
                  color: `hsl(${hue} 50% 68%)`,
                  // 单行不换行（换行会把药丸撑高再被裁，2026-10-27 用户报「运行栏高度不对」）
                  whiteSpace: 'nowrap',
                },
              }, project),
            )
            : null,
          h('span', {
            // 单行不换行（同上：内部换行会让药丸变高被裁）
            // 2026-11-04：名字改成**可收缩 + 省略号**（flex 0 1 auto）——空间不足时先截父名，
            // 把宽度让给后面的分身标签；否则父名和分身标签一起溢出、互相压字（用户截图现象）。
            style: {
              minWidth: 0, whiteSpace: 'nowrap',
              flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, name),
          done
            // 完成未读（2026-10-24）：品牌色 ✓ + 「完成」——与运行态的绿点+时长一眼可分
            ? h('span', {
              title: '已完成，点开查看',
              style: {
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                flex: '0 0 auto', fontSize: '9px', lineHeight: 1,
                color: 'var(--dsw-alias-brand-primary)',
                fontVariantNumeric: 'tabular-nums',
              },
            },
              h('span', {
                style: {
                  width: '10px', height: '10px', borderRadius: '50%', flex: '0 0 auto',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--dsw-alias-brand-primary)', color: '#fff',
                  fontSize: '8px', fontWeight: 700, lineHeight: 1,
                },
              }, '✓'),
              '完成',
            )
            // 运行中绿点 + 时长（与芯片同款）
            : h('span', {
              className: 'hub-running-dot',
              title: '运行中',
              style: {
                width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto',
                background: 'var(--dsw-alias-state-success-primary)',
              },
            }),
          elapsed
            ? h('span', {
              title: '本轮已运行的时长',
              style: {
                flex: '0 0 auto', fontSize: '9px', lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--dsw-alias-state-success-primary)',
              },
            }, elapsed)
            : null,
        );
        // 2026-11-04 用户选方案 B：分身标签**移出 pill**，作为兄弟节点跟在后面
        // （同一行，放不下由外层 flexWrap 换行）——pill 内只留父名+状态，物理上不可能再压字。
        const cloneChips = [
          // 分身子标签（2026-10-29 用户令「快捷栏也像侧栏那样显示分身」）：
          // 侧栏把分身列成父卡片下的子行（名称+运行点+时长），快捷栏原来只折成一个 +N 数字。
          // 现在逐个渲染成小标签（最多 3 个，其余折 +N）：点标签 = **打开它自己那个分身**；
          // 点父 pill 主区域 = 打开本体（2026-11-09 用户令，旧「一律进分列视图」规则作废）。
          ...(group.cloneMembers.length
            ? group.cloneMembers
              .slice()
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
              .slice(0, 3)
              .map((clone) => {
                const cloneStarted = runStart.current.get(clone.id);
                const cloneRunning = Boolean(byId[clone.id] && byId[clone.id].running);
                const cloneElapsed = cloneRunning && cloneStarted ? formatDuration(nowTick - cloneStarted) : '';
                const label = String(clone.name || '').trim() || '分身';
                return h('span', {
                  key: `run-clone-${group.key}-${clone.id}`,
                  className: 'hub-run-clone-chip',
                  title: `${name}｜${label}${cloneRunning ? ' · 运行中' : ''}`,
                  onClick: (event) => {
                    event.stopPropagation();
                    // 2026-11-09 用户令：分身子标签 = 打开**它自己**这个分身（openSession(clone.id)）。
                    // 旧规则（2026-10-29 二改「子标签也不许单独打开分身，统一打开父」）是为
                    // 「点进分列视图」服务的；分列视图已按用户要求取消，该规则前提消失，作废。
                    openSession(clone.id);
                  },
                  style: {
                    display: 'inline-flex', alignItems: 'center', gap: '3px',
                    // 2026-11-04：加左侧间距，与父名拉开（截图里两者紧贴、绿点像压在「基」字上）
                    flex: '0 0 auto', minWidth: 0, maxWidth: '120px',
                    fontSize: '9px', lineHeight: 1,
                    padding: '1px 4px', borderRadius: '7px',
                    color: 'var(--dsw-alias-label-secondary)',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  },
                },
                  cloneRunning
                    ? h('span', {
                      style: {
                        width: '4px', height: '4px', borderRadius: '50%', flex: '0 0 auto',
                        background: 'var(--dsw-alias-state-success-primary)',
                      },
                    })
                    : null,
                  h('span', {
                    style: {
                      minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  }, label),
                  cloneElapsed
                    ? h('span', {
                      style: {
                        flex: '0 0 auto', fontVariantNumeric: 'tabular-nums',
                        color: 'var(--dsw-alias-state-success-primary)',
                      },
                    }, cloneElapsed)
                    : null,
                );
              })
            : []),
          // 超出的分身折成 +N（保留原徽标作为溢出提示）
          group.cloneMembers.length > 3
            ? h('span', {
              className: 'hub-run-clones',
              title: `还有 ${group.cloneMembers.length - 3} 个分身：${group.cloneMembers
                .slice(3).map((clone) => clone.name).join(' / ')}`,
              style: {
                flex: '0 0 auto', fontSize: '9px', lineHeight: 1,
                padding: '1px 4px', borderRadius: '7px',
                color: 'var(--dsw-alias-label-secondary)',
                border: '1px solid var(--dsw-alias-border-l1)',
                fontVariantNumeric: 'tabular-nums',
              },
            }, `+${group.cloneMembers.length - 3}`)
            : null,
        ];
        // 无分身 → 还是原来那个单 pill（DOM 与行为完全不变）
        if (cloneChips.length === 0) return pillNode;
        // 有分身 → 外层包一个 inline-flex 组：pill + 分身标签们
        return h('span', {
          key: `run-group-${group.key}`,
          className: 'hub-run-group',
          'data-clones': String(group.extra),
          style: {
            display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap',
            gap: '3px', flex: '0 0 auto', maxWidth: '100%', minWidth: 0,
          },
        }, pillNode, ...cloneChips);
      };
      const runbarRunningGroups = runbarGroups.filter((group) => group.mode === 'running');
      const runbarDoneGroups = runbarGroups.filter((group) => group.mode === 'done');
      const runbarTotal = runbarGroups.length;
      const runningBar = runbarTotal === 0 ? null : h(
        'div',
        {
          className: 'hub-running-bar',
          style: {
            // 2026-10-27 用户报「运行栏高度不对（上下被切一半）」：
            // 上一版用 overflowX:auto + overflowY:hidden + nowrap，药丸被压成多行又被裁。
            // 回退为**自然换行、不限高**：放不下就折到下一行，栏高随内容自适应，永不裁切。
            display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center',
            padding: '4px 6px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
            marginBottom: '4px',
          },
        },
        h('span', {
          className: 'hub-head-label',
          style: {
            fontSize: '9.5px', letterSpacing: '0.04em', color: 'var(--dsw-alias-label-secondary)',
            flex: '0 0 auto', marginRight: '2px',
          },
        }, `运行中 ${runbarRunningGroups.length}${runbarDoneGroups.length > 0 ? ` · 完成 ${runbarDoneGroups.length}` : ''}`),
        // 2026-10-29 用户要求「快捷栏加一个一键已读按钮」：仅在有「✓完成」pill 时出现，
        // 点一下把未读表清空（等价逐个点开），并立即持久化——完成项 pill 全部消失。
        runbarDoneGroups.length > 0
          ? h('button', {
            type: 'button',
            title: `全部已读（清掉 ${runbarDoneGroups.length} 个完成待查看）`,
            onClick: (event) => {
              event.stopPropagation();
              saveRunbarUnread({});
              setRunbarUnread({});
              // 2026-11-11：一键已读发 `clear`（清整个事实源），不是逐条 remove ——
              // 即使桌面列表比手机旧，也不会漏清；手机侧的一键已读同样是 clear。
              postHostUnread('clear');
              HOST_UNREAD_SYNCED.ids = new Set();
            },
            style: {
              flex: '0 0 auto', marginLeft: '2px', padding: '1px 6px', borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer',
              background: 'transparent', color: 'var(--dsw-alias-brand-primary)',
              fontSize: '9.5px', lineHeight: 1.4, whiteSpace: 'nowrap',
            },
          }, '全部已读')
          : null,
        ...runbarGroups.map((group) => renderRunPill(group)),
      );

      // 搜索框：位于 Projects 标题与项目列表之间（只搜项目名和 agent 名，2026-11-01）
      const searchBar = h(
        'div',
        {
          className: 'hub-search',
          style: {
            display: 'flex', alignItems: 'center', gap: '4px',
            padding: '0 6px 6px',
          },
        },
        h('input', {
          type: 'text',
          value: sidebarSearch,
          placeholder: '搜索项目 / agent',
          // Esc 清空；失焦不清（保留过滤状态，点 × 才清）
          onKeyDown: (event) => {
            if (event.key === 'Escape') setSidebarSearch('');
          },
          onChange: (event) => setSidebarSearch(event.target.value),
          style: {
            flex: '1', minWidth: 0, height: '22px', boxSizing: 'border-box',
            padding: '0 6px', borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: '11px', outline: 'none',
          },
        }),
        searchQ
          ? h('button', {
            type: 'button',
            title: '清空搜索',
            onClick: () => setSidebarSearch(''),
            style: {
              width: '18px', height: '18px', flex: '0 0 auto', border: 'none', padding: 0,
              borderRadius: '5px', background: 'transparent', cursor: 'pointer',
              color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: 1,
            },
          }, '×')
          : null,
      );

      return h(
        'div',
        { ref: rootRef, style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', padding: '0 4px 8px' } },
        runningBar,
        head,
        searchBar,
        renderChipMenu(),
        renderSpawnPrompt(),
        ...visibleRows.map((row, rowIndex) => {
          const hue = uniqueHue(row.name);
          // 搜索期间强制展开（否则折叠项目里的命中成员不可见）
          const isClosed = !searchQ && Boolean(closed[row.name]);
          const pinned = pinnedSet.has(row.name);
          const latest = row.members.reduce((acc, m) => Math.max(acc, byId[m.id].updatedAt || 0), 0);
          // 今日该项目所有 agent 累计运行时长（1s tick 持续累加当日计数；为 0 不显示）
          const d = new Date();
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          let runTotal = 0;
          try { runTotal = Number(localStorage.getItem(`hub.runTotal.${row.name}.${day}`)) || 0; } catch { /* 无存储就不显示 */ }
          const runTotalLabel = runTotal > 0 ? `今日运行 ${formatDuration(runTotal)}` : '';
          return h(
            'section',
            {
              key: row.name,
              // 项目间分隔线（2026-10-23 用户要求）：除第一个项目外，上方一条细线 + 留白
              style: {
                marginBottom: '4px',
                ...(rowIndex > 0
                  ? {
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                    marginTop: '6px',
                    paddingTop: '6px',
                  }
                  : {}),
              },
            },
            h(
              'div',
              {
                className: 'hub-proj',
                'data-room-open': roomPageState.open && roomPageState.project === row.name ? '1' : '0',
                title: `${row.name} · 点击进群聊`,
                onClick: () => openProjectRoom(row.name),
                style: {
                  display: 'flex', alignItems: 'center', gap: '6px', minHeight: '24px',
                  padding: '0 6px', borderRadius: '6px', cursor: 'pointer',
                  color: 'var(--dsw-alias-label-primary)', fontSize: '12px', fontWeight: 600,
                  background: roomPageState.open && roomPageState.project === row.name
                    ? 'var(--dsw-alias-bg-layer-2)'
                    : 'transparent',
                  boxShadow: roomPageState.open && roomPageState.project === row.name
                    ? 'inset 2px 0 0 var(--dsw-alias-brand-primary)'
                    : 'none',
                },
              },
              h('span', {
                className: 'hub-proj-dot',
                style: {
                  width: '6px', height: '6px', borderRadius: '2px', flex: '0 0 auto',
                  background: `hsl(${hue} 45% 50%)`,
                },
              }),
              // 群聊（项目）名称：单行完整显示（不省略、不换行、不缩字号）
              h('span', {
                className: 'hub-proj-name',
                title: `${row.name} · 点击进群聊`,
                style: { flex: '1', minWidth: 0, color: `hsl(${hue} 50% 68%)`, whiteSpace: 'nowrap' },
              }, row.name),
              // 折叠 / 展开（进群聊靠点项目名，不再单独放「群聊」按钮）
              h('button', {
                type: 'button',
                title: isClosed ? '展开' : '折叠',
                onClick: (event) => {
                  event.stopPropagation();
                  setClosed((prev) => ({ ...prev, [row.name]: !prev[row.name] }));
                },
                style: {
                  width: '18px', height: '18px', flex: '0 0 auto', border: 'none', padding: 0,
                  borderRadius: '5px', background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: 'pointer', fontSize: '10px', lineHeight: 1,
                },
              }, isClosed ? '▸' : '▾'),
              runTotalLabel
                ? h('span', {
                  title: '今日该项目所有 agent 累计运行时长',
                  style: { fontSize: '10px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' },
                }, runTotalLabel)
                : null,
              h('span', {
                style: { fontSize: '10px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' },
              }, relTime(latest)),
              // 置顶图钉：悬停显形（已置顶的常显 + 品牌色，即置顶状态的轻量标识）
              h('button', {
                type: 'button',
                className: 'hub-pin',
                'data-pinned': pinned ? '1' : '0',
                title: pinned ? '取消置顶（恢复按活跃排序）' : '置顶到项目列表顶部',
                onClick: (event) => {
                  event.stopPropagation();
                  togglePin(row.name);
                },
                style: {
                  width: '16px', height: '16px', flex: '0 0 auto', border: 'none', padding: 0,
                  borderRadius: '4px', background: 'transparent', cursor: 'pointer',
                  fontSize: '9px', lineHeight: 1,
                  color: pinned ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                },
              }, '📌'),
            ),
            isClosed ? null : chipGrid(row.chips || row.members, () => hue, (label) => chipAvatarFor(row.name, label), row.name),
          );
        }),
        // 搜索无匹配提示（只在有搜索词且项目和未分类都没命中时显示）
        searchQ && visibleRows.length === 0 && visibleLoose.length === 0
          ? h('div', {
            style: {
              padding: '10px 6px', fontSize: '11px',
              color: 'var(--dsw-alias-label-secondary)', textAlign: 'center',
            },
          }, `无匹配「${sidebarSearch.trim()}」`)
          : null,
        visibleLoose.length === 0 ? null : h(
          'section',
          { key: '__loose', className: 'hub-loose-section', style: { marginTop: '4px' } },
          h(
            'div',
            {
              style: {
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '2px 6px 4px', fontSize: '10px',
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7 } },
              searchQ ? `临时会话 · 命中 ${visibleLoose.length}/${loose.length}` : `临时会话（不属于任何项目） · ${loose.length}`),
            h('button', {
              type: 'button',
              title: '归档全部临时会话（归档失败的加入忽略名单，均从侧栏移除）',
              onClick: async (event) => {
                event.stopPropagation();
                // 2026-10-24 用户令「点清空也没用」：去掉两段式确认，单击即生效；
                // 服务不可用不再静默 return；归档失败的目标进忽略名单，保证清得掉。
                const svc = service('uiWorkspace');
                let archivedN = 0;
                let hiddenN = 0;
                const nextHidden = new Set(looseHidden);
                for (const entry of loose) {
                  let done = false;
                  if (svc && typeof svc.archiveSession === 'function') {
                    try {
                      await svc.archiveSession(entry.id, { stopActivity: true });
                      archivedN += 1;
                      done = true;
                    } catch (error) {
                      console.error('[hub-desktop-ui] clear loose archive failed', entry.id, error);
                    }
                  }
                  if (!done) {
                    nextHidden.add(String(entry.id));
                    hiddenN += 1;
                  }
                }
                if (hiddenN > 0) {
                  saveLooseHidden([...nextHidden]);
                  setLooseHidden(nextHidden);
                }
                setClearArmed(false); // 兼容旧状态位
                setClearMsg(`已清空：归档 ${archivedN} 条${hiddenN > 0 ? ` · 忽略 ${hiddenN} 条` : ''}`);
                if (clearTimer.current) clearTimeout(clearTimer.current);
                clearTimer.current = setTimeout(() => setClearMsg(''), 5000);
              },
              style: {
                flex: '0 0 auto', height: '18px', padding: '0 7px', borderRadius: '9px',
                border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer', fontSize: '9.5px',
              },
            }, clearMsg || `清空 ${loose.length}`),
          ),
          chipGrid(visibleLoose, () => uniqueHue('未分类')),
        ),
      );
    }

    /** 量出「会话内容区」的左上角：群聊页与私聊同尺寸，侧栏保持可见。 */
    function measureConversationBox() {
      const pick = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const sidebar = document.querySelector('[data-slot="sidebar"]');
      const sidebarChild = sidebar && sidebar.firstElementChild;
      const sidebarBox = sidebarChild ? sidebarChild.getBoundingClientRect() : null;
      const header = pick('[data-slot="conversation.session.header"]') || pick('[data-slot="conversation.header"]');
      return {
        left: sidebarBox && sidebarBox.width > 0 ? Math.round(sidebarBox.right) : 252,
        top: header ? Math.max(0, Math.round(header.top)) : 52,
      };
    }

    /** RoomPanel 的错误边界：群聊渲染抛错时不许静默消失——上报 /hub/client-error 并在界面显示一行提示。
     *（DSH 的槽位错误边界会吞掉渲染异常且不触发 window.onerror，「点了没反应」就是这么来的。） */
    class RoomPanelBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error: error && error.message ? { message: error.message } : { message: String(error) } }; }
      componentDidCatch(error, info) {
        try {
          fetch('/hub/client-error', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              kind: 'room-render', at: new Date().toISOString(),
              message: String((error && error.message) || error),
              stack: String((error && error.stack) || '').slice(0, 4000),
              componentStack: String((info && info.componentStack) || '').slice(0, 4000),
            }),
          }).catch(() => {});
        } catch { /* 上报失败就放弃 */ }
      }
      render() {
        if (this.state.error) {
          return h('div', {
            style: { padding: '24px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' },
          }, `群聊渲染出错：${this.state.error.message}（堆栈已写入 .hub/client-errors.log，回报 DSH工程师）`);
        }
        return this.props.children;
      }
    }

    /** 群聊独立页：占据会话内容区（不动侧栏），关闭按钮回到当前会话。 */
    function HubRoomPage(props) {

      const [, bump] = React.useReducer((n) => n + 1, 0);
      const [box, setBox] = React.useState(() => measureConversationBox());
      React.useEffect(() => {
        roomPageState.listeners.add(bump);
        return () => { roomPageState.listeners.delete(bump); };
      }, []);
      React.useEffect(() => {
        if (!roomPageState.open) return undefined;
        const remeasure = () => setBox(measureConversationBox());
        remeasure();
        window.addEventListener('resize', remeasure);
        return () => window.removeEventListener('resize', remeasure);
      }, [roomPageState.open]);
      if (!roomPageState.open) return null;
      return h(
        'div',
        {
          style: {
            position: 'fixed', zIndex: 900,
            left: `${box.left}px`, top: `${box.top}px`, right: 0, bottom: 0,
            display: 'flex', flexDirection: 'column', minHeight: 0,
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        h(RoomPanelBoundary, null, h(RoomPanel, { ...props, project: roomPageState.project, onClose: closeRoomPage })),
      );
    }

    /** 新建项目对话框的开关与订阅（侧栏按钮 → 弹窗）。 */
    const newProjectState = { open: false, listeners: new Set(),
      // 待认领的新项目管理者（2026-11-02 修「新建项目没有自动生成 Yat2」）：
      // connectWorkspace 不可用时走 startSession 分支，它**不返回 sessionId** →
      // 原来的改名被 `if (sessionId)` 跳过，新项目就没有 `<项目> · Yat2`。
      // 这里把项目名挂成 claim，交给有 byId 快照的侧栏组件精确认领（差集找新会话后再改名）。
      claim: null };
    /** 最近一次渲染拿到的 workspace id（弹窗没有 hook 时用它兜底）。 */
    let lastWorkspaceId;

    function notifyNewProject() {
      for (const fn of newProjectState.listeners) fn();
    }

    function openNewProject() {
      newProjectState.open = true;
      notifyNewProject();
    }
    function closeNewProject() {
      newProjectState.open = false;
      notifyNewProject();
    }

    function useNewProject() {
      const [, bump] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        newProjectState.listeners.add(bump);
        return () => { newProjectState.listeners.delete(bump); };
      }, []);
      return newProjectState;
    }

    /**
     * 「New project」弹窗：输入项目名 → connectWorkspace 建一个会话 →
     * 立刻改名成 `<项目> · Yat2`，它就成为一个新项目（主控是 Yat2）。
     */
    function NewProjectDialog() {
      const state = useNewProject();
      const [name, setName] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      if (!state.open) return null;

      const submit = async () => {
        const project = name.trim();
        if (!project || busy) return;
        setBusy(true);
        try {
          const svc = service('uiWorkspace');
          if (!svc) return;
          let sessionId;
          if (typeof svc.connectWorkspace === 'function' && lastWorkspaceId !== undefined) {
            const raw = await svc.connectWorkspace(lastWorkspaceId, { agentPreset: DEFAULT_PRESET });
            // 兼容三种返回：字符串 id / { sessionId } / { id }
            sessionId = typeof raw === 'string' ? raw : (raw && (raw.sessionId || raw.id)) || undefined;
          }
          if (!sessionId && typeof svc.startSession === 'function') {
            svc.startSession(lastWorkspaceId, { agentPreset: DEFAULT_PRESET });
          }
          if (sessionId) await renameSession(sessionId, `${project} · Yat2`);
          else newProjectState.claim = { project, at: Date.now() }; // 拿不到 id → 交给侧栏认领（差集定位新会话）
          // 建项目时就把公共黑板初始化好（Host 侧不存在则建目录 + 写模板）
          try {
            await fetch(`/hub/board?project=${encodeURIComponent(project)}`, { method: 'POST' });
          } catch (error) {
            console.warn('[hub-desktop-ui] init board failed', error);
          }
        } catch (error) {
          console.error('[hub-desktop-ui] new project failed', error);
        } finally {
          setBusy(false);
          setName('');
          closeNewProject();
        }
      };

      return h(
        'div',
        {
          style: {
            position: 'fixed', inset: 0, zIndex: 100000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.45)',
          },
          onClick: (event) => { if (event.target === event.currentTarget) closeNewProject(); },
        },
        h(
          'div',
          {
            style: {
              width: '340px', padding: '16px', borderRadius: '12px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              boxShadow: '0 16px 48px rgba(0, 0, 0, 0.45)',
            },
          },
          h('div', {
            style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '10px' },
          }, '新建项目'),
          h('input', {
            autoFocus: true,
            value: name,
            placeholder: '项目名，例如 骨骼微环境',
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit();
              else if (event.key === 'Escape') closeNewProject();
            },
            style: {
              width: '100%', boxSizing: 'border-box', height: '32px', padding: '0 10px',
              borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
              fontSize: '12.5px', outline: 'none',
            },
          }),
          h('div', {
            style: { marginTop: '6px', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' },
          }, `创建后标题为「${name.trim() || '项目名'} · Yat2」`),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
            h('button', {
              type: 'button',
              onClick: closeNewProject,
              style: {
                height: '28px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '12px',
              },
            }, '取消'),
            h('button', {
              type: 'button',
              onClick: submit,
              disabled: busy || !name.trim(),
              style: {
                height: '28px', padding: '0 14px', borderRadius: '8px', border: 'none',
                background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: '12px',
                cursor: busy || !name.trim() ? 'default' : 'pointer',
                opacity: busy || !name.trim() ? 0.5 : 1,
              },
            }, busy ? '创建中…' : '创建'),
          ),
        ),
      );
    }

    /** 从一条 session 事件里抽纯文本（只取 text part，跳过 reasoning/tool-call）。 */
    function eventText(event) {
      if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) return null;
      const data = event.data || {};
      const message = data.message || data;
      // 插件注入的提醒/协议（source.kind = plugin:* 等）不是用户发的消息，不进任务线
      const source = message.source || {};
      if (message.role === 'user' && source.kind && source.kind !== 'user') return null;
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = parts
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      if (!text) return null;
      return { text, role: message.role === 'user' ? 'user' : 'agent', time: event.time || 0 };
    }

    // —— 群聊「每步计时」小工具（数据全部来自事件流，不额外请求） ——

    /** tool/call 与 tool/result 的 callId（以 data.callId 为准，兼容 call 对象内字段）。 */
    function toolCallIdOf(event) {
      const data = (event && event.data) || {};
      const call = data.call || {};
      return data.callId || data.callID || call.callId || call.id || '';
    }

    /** 工具名：data.name 为主，兼容常见别名。 */
    function toolNameOf(event) {
      const data = (event && event.data) || {};
      const call = data.call || {};
      const name = data.name || data.toolName || data.tool || call.name || '';
      return typeof name === 'string' && name ? name : 'tool';
    }

    /** 工具图标：按名字粗分（read/glob/grep → 📖，pwsh/bash → ⚡，edit/write → ✏️，其它 🔧）。 */
    function toolIconOf(name) {
      const key = String(name || '').toLowerCase();
      if (/read|glob|grep|search|list|view|\bcat\b|\bfind\b|\bls\b/.test(key)) return '📖';
      if (/pwsh|powershell|bash|shell|zsh|\bcmd\b|exec|terminal|command/.test(key)) return '⚡';
      if (/edit|write|patch|replace|apply/.test(key)) return '✏️';
      return '🔧';
    }

    /** 耗时格式化：与消息行 `12.3s` 同一口径；未配对/进行中/失败的步骤留 `?`。 */
    function stepSeconds(ms) {
      return typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '?';
    }

    /** 收起态的步骤摘要：`思考 8.1s | 📖 read 1.2s | ⚡ pwsh 2.4s`（工具名过长截断）。 */
    function stepLabel(step) {
      if (step.kind === 'llm') return `思考 ${stepSeconds(step.ms)}`;
      const name = String(step.name || 'tool');
      const short = name.length > 18 ? `${name.slice(0, 18)}…` : name;
      return `${step.icon || '🔧'} ${short} ${stepSeconds(step.ms)}`;
    }

    /**
     * 项目房间 = Hermes 的群聊：同一项目下所有 agent 会话的消息合并成一条流。
     * 数据来自各会话的 eventSource（retain → binding.eventSource），发送走
     * binding.session.prompt(...)，默认投给当前选中的 agent。
     */
    /** 群聊独立页：全屏 overlay（不挂在任何 agent 的会话视图里）。 */
    const ROOM_PAGE_KEY = 'hub-room-page';
    const roomPageState = { project: null, open: false, listeners: new Set() };

    /** 打开群聊页（侧栏项目行 / 顶层入口都走这里）。 */
    function openRoomPage(projectName) {
      roomPageState.project = projectName;
      roomPageState.open = true;
      document.documentElement.dataset.hubRoomPage = '1';
      for (const fn of roomPageState.listeners) fn();
    }

    /** 关闭群聊页。 */
    function closeRoomPage() {
      roomPageState.open = false;
      delete document.documentElement.dataset.hubRoomPage;
      for (const fn of roomPageState.listeners) fn();
    }

    /** 任务线消息区：打开时贴底，用户往上滚后不再强制拉回底部。 */
    function LaneFeed(props) {
      const ref = React.useRef(null);
      const stick = React.useRef(true);
      React.useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (stick.current) el.scrollTop = el.scrollHeight;
      }, [props.items.length]);
      return h(
        'div',
        {
          ref,
          onScroll: (event) => {
            const el = event.currentTarget;
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            stick.current = distance < 48;
          },
          style: {
            flex: '1 1 auto', minHeight: 0,
            // ⚠️ vh 兜底（2026-11-09）：父级 flex 高度链只要有一层算不出来，LaneFeed 就永远不溢出、
            // 表现为「消息挤在一起不能滚」。maxHeight 用 vh 不依赖父级，内容超上限必然滚。
            maxHeight: 'min(62vh, 620px)',
            overflowY: 'auto', overflowX: 'hidden',
            padding: '8px 12px', display: 'flex', flexDirection: 'column',
            fontSize: '12px', lineHeight: 1.6, wordBreak: 'break-word',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
      props.items.length === 0
        ? h('span', {
          style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', flex: '0 0 auto' },
        }, props.emptyText || '还没有消息')
        // ⚠️ 每条消息必须包一层 flex:'0 0 auto'（2026-11-09 用户报「消息被压扁、列不能滚」的真因）：
        // LaneFeed 是 overflow-y:auto 的 flex-column 容器，子项一旦没有 flex-shrink:0，
        // flex 就会把它们压缩到可视区内 → scrollHeight 永远等于 clientHeight → 既压扁又不滚。
        : props.items.map((item, index) => h(
          'div',
          {
            key: (item && (item.key || item.eventId || item.seq)) || `lane-item-${index}`,
            style: { flex: '0 0 auto', minWidth: 0 },
          },
          props.renderItem(item, index),
        )),
    );
    }

    /**
     * 原生会话体的视图选择：固定 Chat（分列不做 Trajectory 标签）。
     * props 来自 conversation.content 工厂的本地槽 kit（renderSlot 绑定在工厂自己的
     * `conversation.session` 上），所以这里能用它、又不越权渲染别人的槽位。
     */
    function FixedChatView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    /**
     * 分列·原生会话体（每列一个）：`SessionProvider` 绑定该会话的 SessionReference，
     * 里面直接渲染原生 `conversation.content` 工厂的 embedded 变体。
     * memo 住：分列面板每 1.2s 轮询会重渲染，但原生树只该在会话引用变化时重建
     * （否则滚动位置/展开状态会被重置）。
     */
    const NativeColumnBody = React.memo(function NativeColumnBody(props) {
      const { sessionRef, SessionProvider, renderFactorySlot } = props;
      return h('div', { className: 'hub-cc-native' },
        h(SessionProvider, { session: sessionRef },
          renderFactorySlot(
            'conversation.content',
            { variant: 'embedded', phase: 'active', hero: false },
            { slots: { views: FixedChatView } },
          )));
    }, (prev, next) => prev.sessionRef === next.sessionRef
      && prev.SessionProvider === next.SessionProvider
      && prev.renderFactorySlot === next.renderFactorySlot);

    /**
     * 分列·思考过程块（collapsible，默认收起）：`💭 思考 · N 字 ▸`，展开看全文。
     * 数据来自该步的 reasoning 块（Host 精简事件附带 data.reasoning）。
     */
    function ThinkBlock(props) {
      const [open, setOpen] = React.useState(false);
      const text = String(props.text || '');
      if (!text) return null;
      return h('div', {
        style: { marginBottom: '3px', minWidth: 0, maxWidth: '100%' },
      },
      h('button', {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        title: open ? '收起思考过程' : '展开思考过程',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          padding: '1px 7px', borderRadius: '7px',
          border: '1px dashed var(--dsw-alias-border-l1)',
          background: 'transparent', color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
          font: 'inherit', fontSize: '9.5px', lineHeight: 1.5, cursor: 'pointer',
        },
      }, `💭 思考 · ${text.length} 字 ${open ? '▾' : '▸'}`),
      open
        ? h('div', {
          style: {
            marginTop: '3px', padding: '4px 8px', borderRadius: '7px',
            border: '1px dashed var(--dsw-alias-border-l1)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: '10.5px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: '180px', overflowY: 'auto',
          },
        }, text)
        : null);
    }

    /**
     * 分列·工具卡片（collapsible，默认收起）：`📖 read · 1.2s ▸`，展开看参数与结果摘要。
     * 结果未到（ms === null 且卡片还在 toolItems 里）显示「运行中」。
     */
    function ToolCard(props) {
      const card = props.card || {};
      const [open, setOpen] = React.useState(false);
      const running = card.ms === null || card.ms === undefined;
      const head = `${card.icon || '🔧'} ${card.name || 'tool'}`;
      // 亚秒工具（read/glob 常 10–80ms）显示 ms，别四舍五入成 0.0s
      const duration = running
        ? '运行中…'
        : (typeof card.ms === 'number'
          ? (card.ms < 1000 ? `${Math.max(1, Math.round(card.ms))}ms` : `${(card.ms / 1000).toFixed(1)}s`)
          : '?');
      return h('div', {
        style: {
          marginBottom: '6px', minWidth: 0, maxWidth: '92%',
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        },
      },
      h('button', {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        title: open ? '收起详情' : '展开参数 / 结果摘要',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          maxWidth: '100%', padding: '2px 8px', borderRadius: '7px',
          border: `1px solid ${card.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)'}`,
          background: 'var(--dsw-alias-bg-layer-1)',
          color: card.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          font: 'inherit', fontSize: '9.5px', lineHeight: 1.5, cursor: 'pointer',
          fontVariantNumeric: 'tabular-nums',
        },
      },
      h('span', {
        style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, head),
      h('span', { style: { flex: '0 0 auto' } }, running ? duration : `${duration} ${open ? '▾' : '▸'}`)),
      open
        ? h('div', {
          style: {
            marginTop: '3px', width: '100%', padding: '4px 8px', borderRadius: '7px',
            border: '1px solid var(--dsw-alias-border-l1)',
            fontSize: '10px', lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)',
            maxHeight: '160px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          },
        },
        card.args ? h('div', { style: { marginBottom: '3px' } }, h('div', { style: { opacity: 0.7, marginBottom: '1px' } }, '参数'), card.args) : null,
        card.brief ? h('div', {}, h('div', { style: { opacity: 0.7, marginBottom: '1px' } }, '结果'), card.brief) : null,
        !card.args && !card.brief ? h('div', { style: { opacity: 0.7 } }, '无参数 / 结果摘要（Host 未升级时只有名称与耗时）') : null)
        : null);
    }

    /**
     * 群聊消息下方的耗时行：`12.3s · ≈233 tok · 118 t/s · 步骤：思考 8.1s | 📖 read 1.2s | ⚡ pwsh 2.4s`。
     * 默认收起成一行（前 3 步 + `…+N`），点一下展开逐步明细（序号 / 名称 / 耗时 / 占比）；
     * 明细区自带 maxHeight + 滚动，不把气泡撑爆，也不触发 LaneFeed 的 sticky 滚动。
     */
    function MessageTiming(props) {
      const stats = props.stats || {};
      const steps = Array.isArray(stats.steps) ? stats.steps : [];
      const [open, setOpen] = React.useState(false);
      const known = steps.reduce((sum, step) => sum + (typeof step.ms === 'number' ? step.ms : 0), 0);
      const pending = steps.filter((step) => typeof step.ms !== 'number').length;
      const base = [];
      if (typeof stats.ms === 'number' && stats.ms > 0) base.push(`${(stats.ms / 1000).toFixed(1)}s`);
      if (stats.tokens) base.push(`≈${stats.tokens} tok`);
      if (stats.tps) base.push(`${stats.tps} t/s`);
      const summary = steps.slice(0, 3).map(stepLabel).join(' | ');
      const more = steps.length > 3 ? ` | …+${steps.length - 3}` : '';
      const alignRight = props.align === 'right';
      const toggle = () => setOpen((value) => !value);
      const clickable = steps.length > 0;
      return h(
        'div',
        {
          style: {
            marginTop: '3px', fontSize: '9.5px', lineHeight: 1.5, minWidth: 0, maxWidth: '100%',
            color: 'var(--dsw-alias-label-secondary)',
            display: 'flex', flexDirection: 'column',
            alignItems: alignRight ? 'flex-end' : 'flex-start',
            textAlign: alignRight ? 'right' : 'left',
          },
        },
        h(
          'div',
          {
            onClick: clickable ? toggle : undefined,
            onKeyDown: clickable
              ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
              }
              : undefined,
            role: clickable ? 'button' : undefined,
            tabIndex: clickable ? 0 : undefined,
            title: clickable ? (open ? '收起分步耗时' : '展开分步耗时') : undefined,
            style: {
              display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
              justifyContent: alignRight ? 'flex-end' : 'flex-start',
              minWidth: 0, cursor: clickable ? 'pointer' : 'default', userSelect: 'none',
            },
          },
          base.length > 0 ? h('span', {}, base.join(' · ')) : null,
          clickable
            ? h('span', {}, `${base.length > 0 ? '· ' : ''}步骤：${summary}${more}`,
              h('span', { style: { marginLeft: '4px' } }, open ? '▾' : '▸'))
            : null,
        ),
        open && clickable
          ? h(
            'div',
            {
              style: {
                marginTop: '4px', width: '100%', maxWidth: '420px', maxHeight: '150px',
                overflowY: 'auto', overflowX: 'hidden', paddingTop: '4px',
                borderTop: '1px dashed var(--dsw-alias-border-l1)',
              },
            },
            h('div', { style: { marginBottom: '2px', opacity: 0.75 } },
              `共 ${(known / 1000).toFixed(1)}s · ${steps.length} 步${pending > 0 ? ` · ${pending} 步未完成` : ''}`),
            steps.map((step, index) => h(
              'div',
              {
                key: `${index}:${step.kind}:${step.name || ''}`,
                style: {
                  display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              h('span', { style: { width: '14px', flex: '0 0 auto', textAlign: 'right', opacity: 0.65 } }, String(index + 1)),
              h('span', { style: { flex: '0 0 auto' } }, step.kind === 'llm' ? '💭' : (step.icon || '🔧')),
              h('span', {
                style: {
                  flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)',
                },
              }, step.kind === 'llm' ? '思考' : String(step.name || 'tool')),
              h('span', {
                style: {
                  flex: '0 0 auto',
                  color: typeof step.ms === 'number'
                    ? 'inherit'
                    : 'var(--dsw-alias-state-warning-primary, #c9a227)',
                },
              }, stepSeconds(step.ms)),
              h('span', { style: { width: '32px', flex: '0 0 auto', textAlign: 'right', opacity: 0.65 } },
                typeof step.ms === 'number' && known > 0 ? `${Math.round((step.ms / known) * 100)}%` : '—'),
            )),
          )
          : null,
      );
    }

    /**
     * 任务线底部的「进行中」块已在 2026-10-20 按用户要求整块移除（群聊不显示实时步骤）；
     * 停止后的每消息分步明细由消息行上的 MessageTiming 接管（保留）。
     */

    function RoomPanel(props) {
      const sessions = props.useSessions((s) => s);
      const workspaces = props.useWorkspaces((s) => s);
      const byId = (sessions && sessions.byId) || {};
      const hubName = (workspaces && workspaces.items && workspaces.items[0] && workspaces.items[0].title) || 'AI-Agent-Hub';
      const projectOf = (session) => splitSessionTitle(session && session.displayTitle).project || hubName;
      const current = props.sessionId ? byId[props.sessionId] : undefined;
      const fallbackProject = React.useMemo(() => {
        const list = Object.values(byId)
          .filter((session) => session && !session.blank)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return list.length > 0 ? (splitSessionTitle(list[0].displayTitle).project || hubName) : null;
      }, [byId, hubName]);
      const project = props.project || (current ? projectOf(current) : fallbackProject);
      const [agent, setAgent] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      const [newAgent, setNewAgent] = React.useState('');
      const [newPreset, setNewPreset] = React.useState(DEFAULT_PRESET);
      const [dispatchOpen, setDispatchOpen] = React.useState(false);
      const [dispatchText, setDispatchText] = React.useState('');
      const [dispatchTarget, setDispatchTarget] = React.useState('');
      const [expanded, setExpanded] = React.useState({});
      const pendingAgent = React.useRef(null);
      const [feed, setFeed] = React.useState([]);
      const [drafts, setDrafts] = React.useState({});
      const [sendingId, setSendingId] = React.useState(null);
      const [roomDraft, setRoomDraft] = React.useState('');
      // 任务线手动归档/改状态（2026-10-25 用户要求）：⋯ 菜单 + 改完立即重拉元数据
      const [laneMenu, setLaneMenu] = React.useState(null); // { key, title, x, y }
      const [metaTick, setMetaTick] = React.useState(0);
      const [roomBusy, setRoomBusy] = React.useState(false);
      const [roomTarget, setRoomTarget] = React.useState('');
      // 投递失败提示（2026-10-22）：Host /hub/prompt 返回的错误要在群聊里看得见
      const [sendError, setSendError] = React.useState(null);
      const refs = React.useRef(new Map());

      // 2026-10-22 修「Book 群聊发消息没反应」第四轮根因：members 必须排除**已归档会话**。
      // Book 有两个同名 "Book · Yat2"（旧壳 02683abe 已归档 + 现役 2b24b8c7），
      // 旧壳排在 lead 选择前面 → 队列全部投给旧壳 → /hub/prompt 拒「已归档」→ 无限重试死循环。
      const archivedIds = new Set((workspaces && workspaces.archivedSessionIds) || []);
      const members = React.useMemo(() => Object.values(byId)
        .filter((session) => session && projectOf(session) === project
          && !archivedIds.has(String(session.id)))
        .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)), [byId, project]);
      // 群聊页也喂一次项目色相注册表（与侧栏同一份全量名单，注册表内部按名单去重重算）
      React.useMemo(() => {
        updateProjectHues(Object.values(byId)
          .filter((session) => session && !session.blank)
          .map((session) => splitSessionTitle(session.displayTitle).project)
          .filter(Boolean));
        return null;
      }, [byId]);
      const memberKey = members.map((member) => member.id).join(',');

      const activeAgent = (agent && byId[agent]) ? agent : (members[0] && members[0].id);

      // 群聊视图激活时隐藏会话底部那条原生输入框（房间自带总输入框），离开时恢复
      React.useEffect(() => {
        document.documentElement.dataset.hubRoom = '1';
        return () => { delete document.documentElement.dataset.hubRoom; };
      }, []);

      // 拉取消息（2026-10-22 重做）：改走 Host `/hub/session-events`（活会话取内存、
      // 冷会话读持久日志，不激活 agent）。旧实现用 retain → eventSource，而 eventSource
      // 只对「本 Client 打开过」的会话有快照——冷成员（如 B细胞清除项目 的汇报师）一条
      // 事件都拿不到，归了线的消息也显示「还没有消息」。按 seq 增量轮询；Host 路由
      // 不可用时退回 retain → eventSource（老行为兜底）。
      React.useEffect(() => {
        if (!project) return undefined;
        let cancelled = false;
        const svc = service('sessions');
        const cursors = new Map(); // memberId -> lastSeq
        const eventsByMember = new Map(); // memberId -> event[]
        const localRefs = new Map();
        const ROOM_FEED_WINDOW = 4000;
        const pullHost = async (member) => {
          const since = cursors.get(member.id) || 0;
          const response = await fetch(`/hub/session-events?session=${encodeURIComponent(member.id)}&since=${since}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          if (!body || body.ok !== true) throw new Error(String((body && body.error) || 'session-events 不可用'));
          const lastSeq = Number(body.lastSeq || 0);
          let list = eventsByMember.get(member.id) || [];
          if (lastSeq > 0 && lastSeq < since) list = []; // 日志回缩（重建/压缩）：清空重取
          const seen = new Set(list.map((event) => event.seq));
          for (const event of (Array.isArray(body.events) ? body.events : [])) {
            if (!event || typeof event.seq !== 'number' || seen.has(event.seq)) continue;
            seen.add(event.seq);
            list.push(event);
          }
          list.sort((a, b) => a.seq - b.seq);
          if (list.length > ROOM_FEED_WINDOW) list = list.slice(-ROOM_FEED_WINDOW);
          eventsByMember.set(member.id, list);
          cursors.set(member.id, Math.max(since, lastSeq));
        };
        const pullRetain = async (member) => {
          if (!svc) return;
          let ref = localRefs.get(member.id);
          if (!ref) {
            ref = svc.retain(member.id, { source: 'controllerOperation' });
            localRefs.set(member.id, ref);
          }
          const binding = await ref.ready;
          const win = binding.eventSource.getSnapshot();
          const entries = (win && win.entries) || [];
          eventsByMember.set(member.id, entries
            .filter((entry) => entry && entry.type === 'event' && entry.event)
            .map((entry) => entry.event));
        };
        const load = async () => {
          const items = [];
          for (const member of members) {
            try {
              await pullHost(member);
            } catch (error) {
              // Host 路由不可用（Host 半未重启）：退回 retain → eventSource
              try { await pullRetain(member); } catch (fallbackError) { /* 该成员本轮跳过 */ }
            }
            const events = eventsByMember.get(member.id) || [];
            const collected = collectLane(member, events.map((event) => ({ type: 'event', event })));
            for (const item of collected.items) items.push(item);
          }
          items.sort((a, b) => (a.time || 0) - (b.time || 0));
          if (!cancelled) setFeed(items.slice(-800));
        };
        load();
        const timer = setInterval(load, 1500);
        return () => {
          cancelled = true;
          clearInterval(timer);
          for (const ref of localRefs.values()) {
            try { ref.release(); } catch (error) { /* ignore */ }
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [project, memberKey]);

      React.useEffect(() => () => {
        for (const ref of refs.current.values()) {
          try { ref.release(); } catch (error) { /* ignore */ }
        }
        refs.current.clear();
      }, []);

      // 群聊投递：走 Host `/hub/prompt`（会唤醒冷会话，2026-10-22）。
      // 失败时把原因写到 sendError，由调用方在群聊里显式提示，不再静默丢消息。
      const sendTo = async (targetId, text) => {
        if (!text.trim()) return false;
        const r = await hubPrompt(targetId, text);
        if (!r.ok) {
          setSendError({ targetId, message: r.error || '投递失败' });
          console.error('[hub-desktop-ui] room send failed', r.error);
          return false;
        }
        setSendError(null);
        return true;
      };

      const back = () => {
        // 群聊是独立页面：优先走 onClose 回到会话；兼容旧的会话内视图。
        if (typeof props.onClose === 'function') { props.onClose(); return; }
        if (typeof props.openView === 'function') props.openView('chat', '');
      };

      // 让 Yat2 新建 agent：起一个新会话，起来后立刻把它改名成 `<项目> · <名字>`。
      // 同时把「agent 名 → preset」记下来：同名 agent 在别的项目里再用同一个 preset。
      const createAgent = () => {
        const name = newAgent.trim();
        if (!name || !project) return;
        saveAgentPreset(name, newPreset);
        pendingAgent.current = { project, name, before: new Set(Object.keys(byId)) };
        setCreating(false);
        setNewAgent('');
        const svc = service('uiWorkspace');
        if (!svc || typeof svc.startSession !== 'function') return;
        const wsId = workspaces && workspaces.items && workspaces.items[0]
          ? workspaces.items[0].workspaceId
          : undefined;
        if (wsId === undefined) svc.startSession(undefined, { agentPreset: newPreset });
        else svc.startSession(wsId, { agentPreset: newPreset });
      };

      React.useEffect(() => {
        const pending = pendingAgent.current;
        if (!pending) return;
        const added = Object.keys(byId).find((id) => !pending.before.has(id));
        if (!added) return;
        pendingAgent.current = null;
        renameSession(added, `${pending.project} · ${pending.name}`);
      }, [byId]);

      const submitLane = async (sessionId, draftKey = sessionId, prefix = '') => {
        const body = (drafts[draftKey] || '').trim();
        const text = prefix ? `${prefix}\n${body}` : body;
        if (!text || !sessionId || sendingId) return;
        setDrafts((prev) => ({ ...prev, [draftKey]: '' }));
        setSendingId(sessionId);
        try { const sent = await sendTo(sessionId, text); addTodo(text, sessionId, sent ? 'done' : 'queued', true); } finally { setSendingId(null); }
      };

      // 房间总输入框：发给管理者时**排队、一条一条来**；发给具体成员/全体则立即发。
      const lead = members.find((member) => MANAGER_NAMES.includes(splitSessionTitle(member.displayTitle).agent)) || members[0];
      const targetId = roomTarget && (roomTarget === 'all' || byId[roomTarget]) ? roomTarget : (lead && lead.id);
      const sendRoom = async () => {
        const text = roomDraft.trim();
        if (!text || roomBusy) return;
        setRoomDraft('');
        if (lead && targetId === lead.id) {
          // 进队列；Yat2 处理完上一条，pump 才发下一条
          addTodo(text, lead.id, 'queued');
          kickQueue();
          return;
        }
        setRoomBusy(true);
        try {
          if (targetId === 'all') {
            for (const member of members) await sendTo(member.id, text);
            addTodo(text, null, 'done', true);
          } else if (targetId) {
            const sent = await sendTo(targetId, text);
            addTodo(text, targetId, sent ? 'done' : 'queued', true);
          }
        } finally {
          setRoomBusy(false);
        }
      };

      // 待办队列：发给 Yat2 的消息排队，一条处理完再发下一条。
      const [todos, setTodos] = React.useState([]);
      React.useEffect(() => {
        const stored = loadRoomTodos(project);
        setTodos(stored);
      }, [project]);

      const addTodo = (text, target, status = 'queued', direct = false) => {
        if (!project || !text.trim()) return;
        // 2026-11-05 用户令「上限设高一点，或者不要有上限」：群聊正文**不再截断**。
        // 历史：原来存 text.slice(0,160)，而队列泵投递用的就是 todo.text → 发给管理者的消息只发出前 160 字符。
        // 现在 text 存完整正文（投递即完整）；待办面板的显示截断交给 CSS
        // （单行 overflow:hidden + text-overflow:ellipsis，完整内容在 title 里）。
        // 兼容旧数据：队列泵仍用 `fullText || text`，老条目有 fullText 就用它。
        const full = text.trim();
        const next = [...loadRoomTodos(project), {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          text: full,
          ts: Date.now(),
          status,
          target: target || null,
          direct,
        }].slice(-20);
        saveRoomTodos(project, next);
        setTodos(next);
      };

      const updateTodo = (id, patch) => {
        if (!project) return;
        const next = loadRoomTodos(project).map((todo) => (todo.id === id ? { ...todo, ...patch } : todo));
        saveRoomTodos(project, next);
        setTodos(next);
      };

      // 队列推进统一交给常驻的 driveRoomQueues（房间关着也会继续）
      const kickQueue = () => { driveRoomQueues(byId, archivedIds); };

      React.useEffect(() => {
        if (!project) return undefined;
        const sync = () => setTodos(loadRoomTodos(project));
        window.addEventListener('hub-todos', sync);
        sync();
        kickQueue();
        return () => window.removeEventListener('hub-todos', sync);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [project]);

      const pendingTodos = todos.filter((todo) => todo.status !== 'done');
      const recentTodos = [...todos].slice(-3);

      // 公共看板：读项目黑板 .hub/projects/<项目>/board.md（Host 侧 /hub/board），可折叠
      const [boardOpen, setBoardOpen] = React.useState(false);
      const [boardText, setBoardText] = React.useState('');
      const [boardAt, setBoardAt] = React.useState(0);
      const [boardErr, setBoardErr] = React.useState('');
      // 黑板字数与上限（2026-10-23）：Host 返回 chars/limit/over，头部直接显示，超限变红提示 Yat2 整理
      const [boardMeta, setBoardMeta] = React.useState({ chars: 0, limit: 20000, over: false });
      // 2026-10-27 修「收起时字数显示 0」：字数是**常显度量**，拉取不能被 boardOpen 挡住。
      // 拆两个 effect：①meta 常拉（进房即拉 + 随 metaTick[SSE hub-change] 刷新，不轮询）；
      // ②全文仅在展开时拉 + 5s 轮询（原逻辑）。/hub/board 很轻，每次 metaTick 多带一份全文
      // 也无所谓，但为省流量 meta 拉取后只在收起态写 setBoardMeta，展开态交给 effect②避免竞态。
      React.useEffect(() => {
        if (!project) return undefined;
        let cancelled = false;
        const loadMeta = async () => {
          try {
            const res = await fetch(`/hub/board?project=${encodeURIComponent(project)}`);
            const data = await res.json();
            if (cancelled || !data || !data.ok) return;
            setBoardMeta({
              chars: Number(data.chars) || 0,
              limit: Number(data.limit) || 20000,
              over: Boolean(data.over),
            });
          } catch (error) { /* ignore */ }
        };
        loadMeta();
        return () => { cancelled = true; };
      }, [project, metaTick]);
      React.useEffect(() => {
        if (!boardOpen || !project) return undefined;
        let cancelled = false;
        const load = async () => {
          try {
            const res = await fetch(`/hub/board?project=${encodeURIComponent(project)}`);
            const data = await res.json();
            if (cancelled) return;
            setBoardText(data && data.ok ? (data.text || '') : '');
            setBoardAt(data && data.updatedAt ? data.updatedAt : 0);
            setBoardErr(data && data.ok ? '' : (data && data.error) || '');
            setBoardMeta({
              chars: Number(data && data.chars) || 0,
              limit: Number(data && data.limit) || 20000,
              over: Boolean(data && data.over),
            });
          } catch (error) {
            if (!cancelled) setBoardErr(String(error && error.message));
          }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [boardOpen, project]);

      // 进房间就确保黑板存在（Host 侧 POST /hub/board：不存在则建目录 + 写模板）
      React.useEffect(() => {
        if (!project) return;
        try {
          fetch(`/hub/board?project=${encodeURIComponent(project)}`, { method: 'POST' }).catch(() => {});
        } catch (error) { /* ignore */ }
      }, [project]);

      const boardPanel = h(
        'div',
        { style: { flex: '0 0 auto', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h(
          'div',
          {
            onClick: () => setBoardOpen((value) => !value),
            title: '项目公共黑板（管理者汇总，成员只写自己的 section）',
            style: {
              display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 16px',
              cursor: 'pointer', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)',
            },
          },
          h('span', null, boardOpen ? '▾' : '▸'),
          h('span', null, '公共看板'),
          // 字数/上限（2026-10-23）：常显度量，超限变红提示 Yat2 该整理了
          h('span', {
            title: boardMeta.over
              ? `已超上限：Yat2 需把较老条目追加到 board-archive-YYYYMM.md 后压缩 board.md`
              : `上限 ${boardMeta.limit} 字符`,
            style: {
              fontSize: '9.5px', fontVariantNumeric: 'tabular-nums',
              color: boardMeta.over
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-secondary)',
              opacity: boardMeta.over ? 1 : 0.7,
            },
          }, `${boardMeta.chars}/${boardMeta.limit} 字符${boardMeta.over ? ' ⚠ 需整理' : ''}`),
          h('span', { style: { marginLeft: 'auto', opacity: 0.7 } },
            boardAt ? `更新于 ${relTime(boardAt)}` : ''),
        ),
        boardOpen
          ? h('div', {
            style: {
              maxHeight: '220px', overflowY: 'auto', padding: '0 16px 8px',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontSize: '11.5px', lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)',
            },
          }, boardText ? renderMarkdown(boardText) : h('span', {
            style: { color: 'var(--dsw-alias-label-secondary)' },
          }, boardErr && boardErr !== 'ENOENT'
            ? `读不到黑板：${boardErr}`
            : `还没有黑板内容（.hub/projects/${project || '<项目>'}/board.md）`))
          : null,
      );

      const todoStrip = h(
        'div',
        {
          style: {
            flex: '0 0 auto', borderBottom: '1px solid var(--dsw-alias-border-l1)',
            padding: '6px 16px 7px', maxHeight: '150px', overflowY: 'auto',
          },
        },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px',
            fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h('span', null, '≡ 待办'),
        h('span', null, pendingTodos.length > 0
          ? `${pendingTodos.length} 条待处理`
          : '没有待处理的消息'),
        h('span', { style: { marginLeft: 'auto', fontSize: '9.5px', opacity: 0.7 } },
          'Yat2 确认并分派后自动划掉'),
        ),
        recentTodos.length === 0
          ? h('div', { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.7 } }, '发一条消息，它就会进这里')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
            ...recentTodos.map((todo) => h(
              'div',
              {
                key: todo.id,
                title: todo.text,
                style: {
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '1px 0', minWidth: 0,
                },
              },
              h('span', {
                style: {
                  width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto',
                  background: todo.status === 'done'
                    ? 'var(--dsw-alias-border-l2)'
                    : 'var(--dsw-alias-brand-primary)',
                },
              }),
              h('span', {
                style: {
                  flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', fontSize: '11.5px',
                  textDecoration: todo.status === 'done' ? 'line-through' : 'none',
                  color: todo.status === 'done'
                    ? 'var(--dsw-alias-label-secondary)'
                    : 'var(--dsw-alias-label-primary)',
                },
              }, todo.text),
              h('span', {
                style: { flex: '0 0 auto', fontSize: '9.5px', color: 'var(--dsw-alias-label-secondary)' },
              }, todo.status === 'done'
                ? (todo.direct ? '已派' : '已归档')
                : todo.status === 'sending'
                  ? '处理中'
                  : '排队'),
              // 删除按钮（2026-10-23 用户令）：每条待办可手动移除——投递失败/误发/孤儿条目
              // 不用等泵自动收口；done 条目也可清出列表。
              h('button', {
                type: 'button',
                title: '删除这条待办',
                onClick: () => {
                  const rest = loadRoomTodos(project).filter((t) => t.id !== todo.id);
                  saveRoomTodos(project, rest);
                  setTodos(rest);
                  if (queueInFlight.has(todo.id)) queueInFlight.delete(todo.id);
                },
                style: {
                  flex: '0 0 auto', width: '16px', height: '16px', lineHeight: 1,
                  borderRadius: '4px', border: 'none', cursor: 'pointer',
                  background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
                  fontSize: '11px', padding: 0,
                },
                onMouseEnter: (e) => { e.currentTarget.style.color = 'var(--dsw-alias-state-error-primary, #d9534f)'; },
                onMouseLeave: (e) => { e.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'; },
              }, '×'),
            )),
          ),
      );

      // 派活：把任务塞给某个 agent，并要求它在黑板里记一笔
      const dispatchTo = dispatchTarget && byId[dispatchTarget] ? dispatchTarget : (lead && lead.id);
      const submitDispatch = async () => {
        const body = dispatchText.trim();
        if (!body || !dispatchTo) return;
        setDispatchOpen(false);
        setDispatchText('');
        const sent = await sendTo(dispatchTo, `【任务】\n${body}\n\n完成后：更新黑板 <workspace>/.hub/projects/${project}/board.md 里属于你的 section，并回报结论与产物路径。`);
        addTodo(`【任务】${body}`, dispatchTo, sent ? 'done' : 'queued', true);
      };

      const [taskMeta, setTaskMeta] = React.useState({});
      // 消息级归线：Yat2 写 routing.json { "<eventId>": "<taskId>" }
      const [routingMap, setRoutingMap] = React.useState({});
      // 归线水位（2026-10-22）：只有 eventId > watermark 的未归线消息才算"待归线"
      const [watermark, setWatermark] = React.useState(0);
      const [archivedOpen, setArchivedOpen] = React.useState(false);

      const header = h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto',
          },
        },
        h('button', {
          type: 'button',
          onClick: back,
          title: '返回会话',
          style: {
            width: '26px', height: '26px', borderRadius: '7px', border: 'none', cursor: 'pointer',
            background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '14px',
          },
        }, '←'),
        h('span', { style: { fontSize: '14px', fontWeight: 600, color: `hsl(${uniqueHue(project || '项目房间')} 55% 65%)` } }, project || '项目房间'),
        h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, `${members.length} 条任务线`),
        (() => {
          // 只算「归线水位之后」的未归线消息（2026-10-22）：历史积压不再让这个数永远卡住
          const pending = feed.filter((item) => {
            if (item.role !== 'user') return false;
            if (item.instr) return false; // 程序投递（派活/回报）不算待归线（2026-10-23）
            if (routingMap[item.eventId] || routingMap[item.key]) return false;
            const numeric = Number(item.eventId);
            if (watermark > 0 && Number.isFinite(numeric) && numeric <= watermark) return false;
            return true;
          }).length;
          return pending > 0
            ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-warning-primary, #c9a227)' } }, `· ${pending} 条待归线`)
            : null;
        })(),
        // 投递失败提示（2026-10-22）：Host /hub/prompt 报错时红字显示，点 × 关掉
        sendError
          ? h('span', {
            title: sendError.message,
            style: {
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px',
              fontSize: '10.5px', color: 'var(--dsw-alias-state-error-primary, #d9534f)',
              maxWidth: '52%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          },
          `投递失败：${String(sendError.message || '').slice(0, 60)}`,
          h('button', {
            type: 'button',
            onClick: () => setSendError(null),
            style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px' },
          }, '×'))
          : null,
        // 成员芯片、「+ agent」、「派活」都已移除：成员看侧栏，建人/派活归 Yat2
      );

      const bubble = (item) => {
        const isUser = item.role === 'user';
        const sender = isUser
          ? '我'
          : (splitSessionTitle(item.agent && item.agent.displayTitle).agent || (item.agent && item.agent.displayTitle) || 'agent');
        const hue = isUser ? 210 : uniqueHue(sender);
        const avatar = avatarOf(sender, {
          avatar: (taskMeta.avatars && taskMeta.avatars[sender]) || (taskMeta[sender] && taskMeta[sender].avatar),
        });
        const initial = (sender.trim()[0] || '·').toUpperCase();
        return h(
          'div',
          {
            key: item.key,
            style: {
              display: 'flex',
              flexDirection: isUser ? 'row-reverse' : 'row',
              alignItems: 'flex-start',
              gap: '8px',
              marginBottom: '12px',
            },
          },
          h('span', {
            title: sender,
            style: {
              width: '22px', height: '22px', borderRadius: '50%', flex: '0 0 auto',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: avatar.emoji ? '15px' : '10px', fontWeight: 600,
              color: avatar.emoji ? 'inherit' : '#fff',
              background: avatar.emoji ? 'transparent' : `hsl(${hue} 42% 42%)`,
              lineHeight: 1,
            },
          }, avatar.emoji || initial),
          h(
            'div',
            { style: { minWidth: 0, maxWidth: 'calc(100% - 34px)' } },
            h('div', {
              style: {
                fontSize: '10.5px', marginBottom: '3px', color: 'var(--dsw-alias-label-secondary)',
                textAlign: isUser ? 'right' : 'left',
              },
            }, sender),
            h('div', {
              style: {
                display: 'inline-block', padding: '6px 10px', borderRadius: '10px',
                fontSize: '12px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: isUser ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-primary)',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
            }, renderMarkdown(item.text)),
            // 群聊线内不渲染 MessageTiming（2026-10-22 用户令：消息下的耗时/token/t/s/步骤行全部去掉，
            // stats 数据保留在 collectLane，分列视图仍用它调试）
          ),
        );
      };

      // 任务线元数据：Yat2 写 .hub/projects/<项目>/tasks.json
      React.useEffect(() => {
        if (!project) return undefined;
        let cancelled = false;
        const load = async () => {
          try {
            const res = await fetch(`/hub/tasks?project=${encodeURIComponent(project)}`);
            const data = await res.json();
            if (cancelled) return;
            // /hub/tasks 只回 {tasks(数组|null), avatars, routing}——taskMeta 保持这个受控形状，
            // 未知顶层键永远进不来（laneDefs 读 raw.tasks，metaOf 旧格式查找自然落空走 {}）
            setTaskMeta(data && typeof data === 'object' ? { tasks: data.tasks || null, avatars: data.avatars || {} } : {});
            setRoutingMap(data && data.routing && typeof data.routing === 'object' ? data.routing : {});
            // 同一轮把归线水位也拉下来（历史积压不计入「待归线」计数）
            try {
              const statusRes = await fetch(`/hub/routing-status?project=${encodeURIComponent(project)}`);
              const status = await statusRes.json();
              if (!cancelled && status && status.ok) setWatermark(Number(status.watermark) || 0);
            } catch (error) { /* 老 Host 没有这条路由时忽略 */ }
          } catch (error) { /* 未重启 Host 时路由不存在，忽略 */ }
        };
        load();
        // 2026-10-26 借鉴 Reasonix：SSE（/hub/events）实时驱动，轮询降为 30s 兜底。
        // Host 侧 fs.watch .hub 变更 → hub-change 事件 → 命中本项目立即重拉。
        const es = (typeof EventSource !== 'undefined') ? new EventSource('/hub/events') : null;
        if (es) {
          es.onmessage = (msg) => {
            try {
              const data = JSON.parse(msg.data);
              if (data && data.type === 'hub-change' && data.project === project) load();
            } catch (error) { /* 非 JSON 忽略 */ }
          };
        }
        const timer = setInterval(load, 30000);
        return () => {
          cancelled = true;
          clearInterval(timer);
          if (es) es.close();
        };
      }, [project, metaTick]);

      // 手动改任务线状态/归档（2026-10-25）：POST /hub/task-status 后立即重拉（metaTick）
      const patchTaskLine = async (taskId, patch) => {
        try {
          const res = await fetch('/hub/task-status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project, taskId: String(taskId), ...patch }),
          });
          const data = await res.json().catch(() => null);
          if (!data || !data.ok) console.warn('[hub-desktop-ui] task patch failed', data);
        } catch (error) {
          console.error('[hub-desktop-ui] task patch request failed', error);
        }
        setMetaTick((n) => n + 1);
      };

      // 任务线菜单：点空白/Esc 关闭（事件驱动，无定时器）
      React.useEffect(() => {
        if (!laneMenu) return undefined;
        const close = () => setLaneMenu(null);
        const onKey = (event) => { if (event.key === 'Escape') close(); };
        window.addEventListener('click', close);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('click', close);
          window.removeEventListener('keydown', onKey);
        };
      }, [laneMenu]);

      // 任务线元数据查找：精确成员名 → 去掉 `｜任务` 后缀的基名 → 会话 id → 完整标题
      const metaOf = (member) => {
        const name = splitSessionTitle(member.displayTitle).agent || member.displayTitle;
        const base = String(name).split('｜')[0].trim();
        const exact = taskMeta[name];
        if (exact && typeof exact === 'object') return exact;
        const byBase = taskMeta[base];
        if (byBase && typeof byBase === 'object') return byBase;
        const byId = taskMeta[member.id];
        if (byId && typeof byId === 'object') return byId;
        const byTitle = taskMeta[String(member.displayTitle || '')];
        if (byTitle && typeof byTitle === 'object') return byTitle;
        return {};
      };
      const isArchivedLane = (member) => metaOf(member).status === 'archived';

      // 运行态闸门 B 的输入：feed 里最新一条**用户消息**的时间。
      // 只要存在比某线最后回复更晚的用户消息，该线就不许亮（详见 renderLane 内 v2 注释）。
      const latestUserMsgTime = feed.reduce((acc, item) => (
        item.role === 'user' && (item.time || 0) > acc ? (item.time || 0) : acc
      ), 0);

      // 任务线 = 任务（Yat2 在 tasks.json 里定义），可横跨多个成员的会话；
      // 旧格式（按成员名逐一登记）仍然兼容：一个成员一条线。
      const renderLane = (lane) => {
        const laneMembers = lane.memberIds.map((id) => byId[id]).filter(Boolean);
        const primary = laneMembers[0] || {};
        const primaryId = primary.id || lane.primaryId;
        // 输入框投递目标永远是管理者（lead）：成员顺序不稳定，直接投 primaryId 会绕过调度；
        // 消息带任务线前缀，Yat2 一眼知道该在哪条线上派发。
        const laneTargetId = (lead && lead.id) || primaryId;
        const agentName = splitSessionTitle(primary.displayTitle).agent || primary.displayTitle || lane.title;
        const lanePrefix = `【任务线：${(lane.title || agentName).split('\n')[0].slice(0, 42)}】`;
        const memberNames = laneMembers.map((m) => splitSessionTitle(m.displayTitle).agent || m.displayTitle);
        const managerName = lead ? (splitSessionTitle(lead.displayTitle).agent || 'Yat2') : 'Yat2';
    // 任务线头部的运行时长（2026-11-09 用户令「本体与分身都显示运行时长」）：
    // 取该线当前正在运行的成员，用 runStart 的 startedAt 算「已运行多久」，并给出「开始于 HH:MM:SS」。
    const runningMember = laneMembers.find((m) => m && m.running);
    const laneStartedAt = runningMember ? runStart.current.get(runningMember.id) : undefined;
    const laneElapsed = laneStartedAt ? formatDuration(nowTick - laneStartedAt) : '';
    const laneStartedText = laneStartedAt ? new Date(laneStartedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        // 归线：routing.json 指定了就走它；没指定的不进任何线（等 Yat2 归线）
        // 每条消息只在一条线里（归属见下方 laneAssignments）
        const items = feed.filter((item) => laneAssignments.get(item.key) === lane.key);
        // —— 群聊信息架构过滤（2026-10-23 用户令，当日二次修正）——
        // 成员回复**可以**进任务线（书童带读等内容产出），但「给 Yat2 的内部回报」不进。
        // 可见 = ①真实用户消息（instr 投递不算）②管理者（lead）的 agent 回复（给用户的摘要）
        // ③成员 agent 回复中**非内部回报**的内容产出（带读原文/图表/交付说明）。
        // 内部回报判据（前 30 字）：含「回报/汇报」、以【任务/【求助/【返工/【续跑/【重发开头、
        // 或以「**已完成**」「完成，」开头的完工汇报。归线的第一道闸在 Yat2 协议
        //（内部回报归 _none），这里是渲染层安全网；分列视图不受此过滤影响。
        const INTERNAL_REPORT = /^(\*\*已完成\*\*|完成[，,]|【(任务|求助|返工|续跑|重发))|回报|汇报/;
        const laneFeedItems = items.filter((item) => {
          if (item.role === 'user') return !item.instr;
          if (item.role !== 'agent') return false;
          if (lead && item.agent && String(item.agent.id) === String(lead.id)) return true;
          return !INTERNAL_REPORT.test(String(item.text || '').slice(0, 30));
        });
        // 运行态（v2，2026-10-22 修「无关线集体亮」）：两个条件都满足才亮——
        //  A：本线最后一条已归线消息是 agent 回复，且该 agent 正在 running；
        //  B（闸门）：feed 里不存在时间更晚的用户消息（无论归没归线）。
        // v1 只看 A，而每条线最后一条几乎都是 Yat2 的回复——用户一发消息 Yat2 开跑，
        // 所有线的 lastRouted.agent 都是 Yat2 → 集体点亮。闸门 B 保证：
        // 新消息未归线 → 全暗；归到 L → 只有 L 亮；跑完 → 熄灭；没人发言 → 旧线不亮。
        const lastRouted = items[items.length - 1];
        const running = Boolean(lastRouted && lastRouted.agent && lastRouted.role === 'agent'
          && byId[lastRouted.agent.id] && byId[lastRouted.agent.id].running
          && (lastRouted.time || 0) >= latestUserMsgTime);
        // 线头时间标签用「本线最后一条消息时间」，没有消息时退回成员会话最近活跃时间
        //（lastTps/withTps 已随 ⚡ 速率行一起删除，2026-10-22；列头的 t/s 仍在分列视图里）
        const updatedAt = items.reduce((acc, item) => Math.max(acc, item.time || 0), 0)
          || laneMembers.reduce((acc, member) => Math.max(acc, member.updatedAt || 0), 0);
        const hue = uniqueHue(lane.title || agentName);
        const laneAvatar = avatarOf(lane.title || agentName, { avatar: lane.avatar });
        const taskTitle = (lane.title || agentName).split('\n')[0].slice(0, 42) || agentName;
        return h(
          'section',
          {
            key: lane.key,
            style: {
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              marginBottom: 0,
              borderRadius: '10px',
              overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              // 每条任务线是一列：并排、等分宽度、撑满可用高度，内部自己滚动
              flex: '1 1 0',
              minWidth: '320px',
              height: '100%',
            },
          },
          // 任务线头：状态点 + 任务标题 + 时间
          h(
            'div',
            {
              style: {
                display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 10px',
                borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto',
              },
            },
            h('span', {
              style: {
                width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto',
                background: running
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-border-l2)',
              },
            }),
            laneAvatar.emoji
              ? h('span', { style: { fontSize: '13px', flex: '0 0 auto' } }, laneAvatar.emoji)
              : null,
            h('span', {
              title: lane.title || primary.displayTitle,
              style: {
                // 任务名完整显示（2026-10-21）：去掉 520px 上限与省略号，允许换行
                flex: '0 1 auto', minWidth: 0,
                whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.25,
                fontSize: '12.5px', fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
              },
            }, taskTitle),
            // 目标状态徽标（2026-10-21 目标化任务线）：done=✓绿 / active=●运行色 / blocked=⚠黄 / pending=○灰
            // hover 显示 goal 全文；没有 goal 的旧线不显示徽标
            (() => {
              const state = String(lane.goalState || '').trim();
              if (!state) return null;
              const preset = {
                done: { icon: '✓', color: '#3fb950', label: '目标已达成' },
                active: { icon: '●', color: 'var(--dsw-alias-brand-primary)', label: '进行中' },
                blocked: { icon: '⚠', color: '#d29922', label: '受阻' },
                pending: { icon: '○', color: 'var(--dsw-alias-label-secondary)', label: '未开始' },
              }[state] || { icon: '○', color: 'var(--dsw-alias-label-secondary)', label: state };
              return h('span', {
                title: `${preset.label}${lane.goal ? `：${lane.goal}` : '（未填目标）'}`,
                style: {
                  flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: '3px',
                  fontSize: '9.5px', lineHeight: 1, padding: '2px 5px', borderRadius: '8px',
                  color: preset.color,
                  border: `1px solid ${preset.color}`,
                  opacity: state === 'done' ? 0.9 : 0.85,
                  whiteSpace: 'nowrap',
                },
              }, `${preset.icon} ${state}`);
            })(),
            // 运行时长：只在有成员在跑时出现；hover 给「已运行 X（开始于 HH:MM:SS）」
            laneElapsed
              ? h('span', {
                title: `已运行 ${laneElapsed}（开始于 ${laneStartedText}）`,
                style: {
                  flex: '0 0 auto', fontSize: '10px', fontVariantNumeric: 'tabular-nums',
                  color: 'var(--dsw-alias-state-success-primary)',
                  display: 'inline-flex', alignItems: 'center', gap: '3px',
                },
              }, '● ', laneElapsed)
              : null,
            h('span', {
              style: {
                flex: '0 0 auto', fontSize: '10px',
                color: 'var(--dsw-alias-label-secondary)',
              },
            }, relTime(updatedAt)),
            // 手动归档 / 改状态（2026-10-25 用户要求）
            h('button', {
              type: 'button',
              className: 'hub-lane-menu-btn',
              title: '任务线操作：改状态 / 归档',
              onClick: (event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setLaneMenu({
                  key: String(lane.key),
                  title: taskTitle,
                  x: rect.right - 150,
                  y: rect.bottom + 4,
                });
              },
              style: {
                flex: '0 0 auto', width: '18px', height: '18px', borderRadius: '6px',
                border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
                fontSize: '11px', lineHeight: 1, padding: 0,
              },
            }, '⋯'),
          ),
          // 参与者一行
          h(
            'div',
            {
              style: {
                display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px 6px',
                fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto',
              },
            },
            h('span', {
              style: {
                width: '14px', height: '14px', borderRadius: '50%', flex: '0 0 auto',
                background: `hsl(${hue} 40% 40%)`, color: '#fff', fontSize: '8px', fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              },
            }, (agentName.trim()[0] || '·').toUpperCase()),
            h('span', {
              style: {
                // 成员名串完整显示（2026-10-21）：去掉省略号截断，允许换行
                minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.2,
              },
            },
              memberNames.length === 0
                ? '（没有参与者）'
                : (memberNames.length === 1 && memberNames[0] === managerName
                  ? `${managerName} · 主控`
                  : `${managerName} 派 · ${memberNames.join(' / ')}`)),
            h('button', {
              type: 'button',
              title: '打开这条线的会话',
              onClick: (event) => { event.stopPropagation(); if (primaryId) openSession(primaryId); },
              style: {
                marginLeft: 'auto', height: '18px', padding: '0 6px', borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '9.5px',
              },
            }, '打开'),
          ),
          // 运行中的线：只留绿点脉冲，不显示速率数字（2026-10-22 用户令：「速率」也不要；
          // ⚡ t/s 行已删，运行判定见上方 v2 闸门）
          // 渲染只取本线最近 60 条（feed 窗口扩到 800 后的 DOM 保底；运行态/updatedAt 仍用全量 items）
          h(LaneFeed, { items: laneFeedItems.slice(-60), renderItem: bubble }),
          h(
            'div',
            {
              style: {
                flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', gap: '6px',
                padding: '7px 8px', borderTop: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-base)',
              },
            },
            h('textarea', {
              value: drafts[lane.key] || '',
              placeholder: `发给 ${managerName}，在「${(lane.title || agentName).split('\n')[0].slice(0, 20)}」线上派发…`,
              onChange: (event) => setDrafts((prev) => ({ ...prev, [lane.key]: event.target.value })),
              onPaste: (event) => pasteImages(event, (paths) => {
                setDrafts((prev) => {
                  const current = prev[lane.key] || '';
                  const addition = paths.map((path) => `[图片] ${path}`).join('\n');
                  return { ...prev, [lane.key]: `${current}${current && !current.endsWith('\n') ? '\n' : ''}${addition}\n` };
                });
              }),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitLane(laneTargetId, lane.key, lanePrefix);
                }
              },
              rows: 1,
              style: {
                flex: '1 1 auto', minHeight: '22px', maxHeight: '90px', resize: 'none',
                border: 'none', outline: 'none', background: 'transparent',
                color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '12px', lineHeight: 1.5,
              },
            }),
            h('button', {
              type: 'button',
              onClick: () => submitLane(laneTargetId, lane.key, lanePrefix),
              disabled: !laneTargetId || sendingId === laneTargetId || !(drafts[lane.key] || '').trim(),
              style: {
                height: '24px', padding: '0 10px', borderRadius: '7px', border: 'none',
                cursor: 'pointer', background: 'var(--dsw-alias-brand-primary)', color: '#fff',
                fontSize: '11.5px',
                opacity: !laneTargetId || sendingId === laneTargetId || !(drafts[lane.key] || '').trim() ? 0.5 : 1,
              },
            }, sendingId === laneTargetId ? '发送中' : '发送'),
          ),
        );
      };

      // 组装任务线定义：新格式 { tasks: [{id,title,status,members[],sessionIds[],avatar}] }，
      // 旧格式 { "<成员名>": {title,status,avatar} } 兼容成一成员一条线。
      // sessionIds 规范是**数组**；但协议曾写成「成员名→id 映射」导致管理者写对象（AI出题 群聊白屏案例），
      // 这里做形状归一：数组原样、对象取 Object.values、单个字符串包一层数组、其它忽略；
      // 且**逐条任务 try/catch**——一条坏数据只丢那一条线，绝不让整个群聊渲染崩。
      const normalizeSessionIds = (value) => {
        if (Array.isArray(value)) return value.filter((x) => typeof x === 'string');
        if (value && typeof value === 'object') return Object.values(value).filter((x) => typeof x === 'string');
        if (typeof value === 'string' && value) return [value];
        return [];
      };
      const laneDefs = (() => {
        const raw = taskMeta || {};
        const list = Array.isArray(raw.tasks) ? raw.tasks : null;
        const nameOf = (member) => splitSessionTitle(member.displayTitle).agent || member.displayTitle;
        if (list) {
          const defs = [];
          list.forEach((task, index) => {
            try {
              const sessionIds = normalizeSessionIds(task && task.sessionIds);
              const names = Array.isArray(task && task.members) ? task.members : [];
              const ids = [];
              for (const member of members) {
                if (sessionIds.includes(member.id)) ids.push(member.id);
                else if (names.includes(nameOf(member))) ids.push(member.id);
              }
              defs.push({
                key: String((task && (task.id || task.title)) || index),
                title: String((task && task.title) || '未命名任务'),
                status: task && task.status === 'archived' ? 'archived' : 'active',
                avatar: task && task.avatar,
                // 目标化任务线（2026-10-21 用户新机制）：目标 + 目标状态，列头显示徽标
                goal: task && typeof task.goal === 'string' ? task.goal : '',
                goalState: task && typeof task.goalState === 'string' ? task.goalState : '',
                memberIds: ids,
                primaryId: ids[0],
              });
            } catch (error) {
              // 单条任务线数据坏了：跳过这条并上报，其余线照常渲染
              try {
                fetch('/hub/client-error', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ kind: 'lane-defs', at: new Date().toISOString(),
                    message: String((error && error.message) || error), taskIndex: index }),
                }).catch(() => {});
              } catch { /* ignore */ }
            }
          });
          return defs.filter((lane) => lane.memberIds.length > 0);
        }
        return members.map((member) => {
          const meta = metaOf(member);
          return {
            key: member.id,
            title: meta.title || nameOf(member),
            status: meta.status === 'archived' ? 'archived' : 'active',
            avatar: meta.avatar,
            goal: typeof meta.goal === 'string' ? meta.goal : '',
            goalState: typeof meta.goalState === 'string' ? meta.goalState : '',
            memberIds: [member.id],
            primaryId: member.id,
          };
        });
      })();

      // 每条消息只属于一条任务线：
      // 用户消息 → routing 优先，否则落到「第一个包含该会话的线」；
      // agent 消息 → 跟随同会话里最近一条用户消息的归属（回答不会出现在别的线）。
      const laneAssignments = (() => {
        const bySession = new Map();
        for (const item of feed) {
          const list = bySession.get(item.agent.id);
          if (list) list.push(item);
          else bySession.set(item.agent.id, [item]);
        }
        const assign = new Map();
        for (const [, list] of bySession) {
          let current = null;
          for (const item of list) {
            const routed = routingMap[item.eventId] || routingMap[item.key];
            if (routed === '_none' || routed === '_hidden') {
              // 明确「不进任务线」（寒暄 / 派活确认 / 进度播报）：
              // 本条不进任何线，也不把它设成 current —— 后面的 agent 回复同样不进线。
              assign.set(item.key, null);
              current = null;
            } else if (routed) {
              assign.set(item.key, routed);
              current = routed;
            } else if (item.role === 'user') {
              // 还没判定归属 → 用户消息本身不进任何任务线（等 Yat2 写 routing 才出现）
              assign.set(item.key, null);
              current = null;
            } else {
              // agent 回复严格跟随「它所回答的那条用户消息」的归线（current = 最近一条
              // 已归线用户消息）。触发消息是 _none / 未归线（如自动 _none 的【任务 prompt）
              // 时 current 为空 → 回复不进任何线（只在侧栏芯片可见）。
              // 旧版「回退到会话所属线」（32847ee）已删：它让同一 agent 的动态出现在
              // 每条含它的线里，等于按 agent 分线。
              assign.set(item.key, current || null);
            }
          }
        }
        return assign;
      })();

      // 空任务线不渲染：active 线若「既没有已归线的消息、routing 里也没有归到它的记录」就不占列
      //（刚建还没消息的线）。**routing 里有过归属的 active 线必显示**——哪怕当前 feed 窗口
      // 恰好没覆盖到它的消息（2026-10-21 回归：status/session-defaults 因 80 条窗口 items=0 被隐藏）。
      const laneItemCount = new Map();
      for (const laneKey of laneAssignments.values()) {
        if (laneKey === null || laneKey === undefined) continue;
        laneItemCount.set(laneKey, (laneItemCount.get(laneKey) || 0) + 1);
      }
      const routingBackedLanes = new Set(
        Object.values(routingMap || {}).filter((v) => v && v !== '_none' && v !== '_hidden'),
      );
      // 每条线的最后活动时间：该线已归线消息里最大 item.time（事件时间，不新造时间戳）；
      // 空线（routing 兜底显示的）记 0，排在最后。
      const laneLastActivity = new Map();
      for (const item of feed) {
        const laneKey = laneAssignments.get(item.key);
        if (laneKey === null || laneKey === undefined) continue;
        const at = Number(item.time) || 0;
        if (at > (laneLastActivity.get(laneKey) || 0)) laneLastActivity.set(laneKey, at);
      }
      const activeLanes = laneDefs
        .filter((lane) => lane.status !== 'archived'
          && ((laneItemCount.get(lane.key) || 0) > 0 || routingBackedLanes.has(lane.key)))
        // 排序：最近有活动的线排最前；时间相同按 tasks.json 定义顺序（laneDefs 顺序稳定）兜底。
        // 只影响显示顺序，不改 tasks.json、不影响归线、不影响归档区。
        .sort((a, b) => {
          const delta = (laneLastActivity.get(b.key) || 0) - (laneLastActivity.get(a.key) || 0);
          if (delta !== 0) return delta;
          const ai = laneDefs.indexOf(a);
          const bi = laneDefs.indexOf(b);
          return ai - bi;
        });
      const archivedLanes = laneDefs.filter((lane) => lane.status === 'archived');
      const lanes = activeLanes.map(renderLane);

      return h(
        'div',
        {
          className: 'hub-room',
          style: {
            display: 'flex', flexDirection: 'column', height: '100%', maxHeight: '100%',
            minHeight: 0, overflow: 'hidden', background: 'var(--dsw-alias-bg-base)',
          },
        },
        header,
        todoStrip,
        boardPanel,
        // 任务线操作菜单（2026-10-25 用户要求「手动归档和改状态」）：fixed 定位，
        // 点空白关闭；改状态写 tasks.json.goalState，归档写 status=archived（在下方
        // 「已归档 N 条任务线」里可恢复）。
        laneMenu ? h('div', {
          style: {
            position: 'fixed',
            left: `${Math.max(8, Math.min(laneMenu.x, window.innerWidth - 190))}px`,
            top: `${Math.max(8, Math.min(laneMenu.y, window.innerHeight - 190))}px`,
            zIndex: 3200, minWidth: '170px', padding: '4px',
            borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)', boxShadow: '0 10px 28px rgb(0 0 0 / 32%)',
          },
          onClick: (event) => event.stopPropagation(),
        },
          h('div', {
            style: {
              padding: '4px 10px 6px', fontSize: '9.5px', color: 'var(--dsw-alias-label-secondary)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: '3px',
              maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, laneMenu.title || laneMenu.key),
          ...[
            ['标记进行中', 'active'],
            ['标记已完成', 'done'],
            ['标记受阻', 'blocked'],
          ].map(([label, goalState]) => h('button', {
            key: goalState,
            type: 'button',
            className: 'hub-lane-menu-item',
            style: {
              display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px',
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'var(--dsw-alias-label-primary)', fontSize: '11.5px', whiteSpace: 'nowrap',
            },
            onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)'; },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
            onClick: (event) => {
              event.stopPropagation();
              setLaneMenu(null);
              patchTaskLine(laneMenu.key, { goalState });
            },
          }, label)),
          h('button', {
            type: 'button',
            className: 'hub-lane-menu-item',
            style: {
              display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px',
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'var(--dsw-alias-state-error-primary)', fontSize: '11.5px', whiteSpace: 'nowrap',
              borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: '3px',
            },
            onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)'; },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
            onClick: (event) => {
              event.stopPropagation();
              setLaneMenu(null);
              patchTaskLine(laneMenu.key, { status: 'archived' });
            },
          }, '归档任务线'),
        ) : null,
        h('div', {
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: '12px 16px',
          },
        },
        h('div', {
          style: {
            display: 'flex', flexDirection: 'row', alignItems: 'stretch',
            gap: '12px', overflowX: 'auto', flex: '1 1 auto', minHeight: 0,
          },
        }, lanes.length === 0
          ? h('div', {
            style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: '40px auto', textAlign: 'center' },
          }, '这个项目还没有任务线')
          : lanes),
        archivedLanes.length === 0 ? null : h(
          'div',
          {
            style: {
              marginTop: '8px', flex: '0 0 auto', padding: '2px 4px',
              fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)',
            },
          },
          h('button', {
            type: 'button',
            onClick: () => setArchivedOpen((open) => !open),
            style: {
              border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
              color: 'var(--dsw-alias-label-secondary)', fontSize: '10.5px',
            },
          }, `已归档 ${archivedLanes.length} 条任务线 ${archivedOpen ? '▾' : '▸'}`),
          archivedOpen ? h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' } },
            ...archivedLanes.map((lane) => h(
              'span',
              {
                key: lane.key,
                style: {
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  padding: '3px 8px', borderRadius: '8px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                },
              },
              h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, lane.title),
              h('button', {
                type: 'button',
                title: '把这条任务线移回进行中',
                onClick: async () => {
                  try {
                    await fetch('/hub/task-status', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ project, taskId: String(lane.key), status: 'active' }),
                    });
                  } catch (error) {
                    console.error('[hub-desktop-ui] restore task failed', error);
                  }
                },
                style: {
                  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
                  background: 'transparent', cursor: 'pointer', fontSize: '9.5px',
                  color: 'var(--dsw-alias-label-secondary)', padding: '0 5px',
                },
              }, '恢复'),
            )),
          ) : null,
        ),
        ),
        h(
          'div',
          {
            className: 'hub-room-footer',
            style: {
              position: 'sticky', bottom: 0, zIndex: 5,
              flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px',
              padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
          h('select', {
            value: targetId === 'all' ? 'all' : (targetId || ''),
            onChange: (event) => setRoomTarget(event.target.value),
            title: '这条消息发给谁',
            style: {
              height: '30px', padding: '0 6px', borderRadius: '8px', cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-primary)', fontSize: '11px', flex: '0 0 auto',
            },
          },
          ...members.map((member) => h('option', {
            key: member.id,
            value: member.id,
          }, splitSessionTitle(member.displayTitle).agent || member.displayTitle)),
          h('option', { value: 'all' }, `全体 (${members.length})`),
          ),
          h('textarea', {
            value: roomDraft,
            placeholder: targetId === 'all'
              ? '对整个项目说，发给全部 agent…（可直接粘贴图片）'
              : `对管理者说（${(lead && (splitSessionTitle(lead.displayTitle).agent || lead.displayTitle)) || '主控'} 会分派给成员）…（可粘贴图片）`,
            onChange: (event) => setRoomDraft(event.target.value),
            onPaste: (event) => pasteImages(event, (paths) => {
              setRoomDraft((current) => {
                const addition = paths.map((path) => `[图片] ${path}`).join('\n');
                return `${current}${current && !current.endsWith('\n') ? '\n' : ''}${addition}\n`;
              });
            }),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendRoom();
              }
            },
            rows: 1,
            style: {
              flex: '1 1 auto', height: '32px', minHeight: '32px', maxHeight: '120px',
              boxSizing: 'border-box', resize: 'none',
              padding: '5px 10px', borderRadius: '8px', font: 'inherit',
              fontSize: '12.5px', lineHeight: '20px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
              outline: 'none',
            },
          }),
          h('button', {
            type: 'button',
            onClick: sendRoom,
            disabled: roomBusy || !roomDraft.trim(),
            style: {
              height: '30px', padding: '0 14px', borderRadius: '8px', border: 'none',
              cursor: roomBusy || !roomDraft.trim() ? 'default' : 'pointer',
              background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: '11.5px',
              opacity: roomBusy || !roomDraft.trim() ? 0.5 : 1,
            },
          }, roomBusy ? '发送中' : '发送'),
        ),
        dispatchOpen
          ? h(
            'div',
            {
              style: {
                position: 'fixed', inset: 0, zIndex: 100001,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              onClick: (event) => { if (event.target === event.currentTarget) setDispatchOpen(false); },
            },
            h(
              'div',
              {
                style: {
                  width: '400px', padding: '16px', borderRadius: '12px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  boxShadow: '0 16px 48px rgba(0, 0, 0, 0.45)',
                },
              },
              h('div', {
                style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '10px' },
              }, '派活'),
              h('select', {
                value: dispatchTo || '',
                onChange: (event) => setDispatchTarget(event.target.value),
                style: {
                  height: '30px', width: '100%', marginBottom: '8px', padding: '0 8px',
                  borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
                  fontSize: '12px',
                },
              }, ...members.map((member) => h('option', {
                key: member.id,
                value: member.id,
              }, splitSessionTitle(member.displayTitle).agent || member.displayTitle))),
              h('textarea', {
                autoFocus: true,
                value: dispatchText,
                placeholder: '任务内容 + 验收标准',
                onChange: (event) => setDispatchText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitDispatch();
                  else if (event.key === 'Escape') setDispatchOpen(false);
                },
                rows: 5,
                style: {
                  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
                  fontSize: '12px', resize: 'vertical', outline: 'none',
                },
              }),
              h('div', {
                style: { marginTop: '6px', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' },
              }, `发出后：该 agent 收到「【任务】…」，并要求更新黑板 board.md`),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
                h('button', {
                  type: 'button',
                  onClick: () => setDispatchOpen(false),
                  style: {
                    height: '28px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '12px',
                  },
                }, '取消'),
                h('button', {
                  type: 'button',
                  onClick: submitDispatch,
                  disabled: !dispatchText.trim() || !dispatchTo,
                  style: {
                    height: '28px', padding: '0 14px', borderRadius: '8px', border: 'none',
                    background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: '12px',
                    cursor: !dispatchText.trim() || !dispatchTo ? 'default' : 'pointer',
                    opacity: !dispatchText.trim() || !dispatchTo ? 0.5 : 1,
                  },
                }, '派发'),
              ),
            ),
          )
          : null,
      );
    }

    function HubBrandName() {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: '6px',
            minWidth: 0,
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h('span', null, 'AI-Agent-Hub'),
        h(
          'span',
          {
            style: {
              fontSize: '9.5px',
              fontWeight: 500,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--dsw-alias-brand-primary)',
            },
          },
          'DSH',
        ),
      );
    }

     /**
      * 运行行尾的实时解码速率（2026-10-21 重写）。
      * - 只用 **sessionStats 投影增量**（decodeTokens / decodeMs 的差分），与底部状态条、
      *   每条消息的 t/s 同一口径；**DOM 字节估算分支已整体删除**（两次翻车：工具卡片
      *   突增 77000 t/s、投影毛刺 143000 t/s——估算/毛刺都不可信，宁可晚一点出真值）。
      * - 合理性闸：结算时长 <200ms 或瞬时速率 >2000 t/s 的样本视为投影口径毛刺丢弃；
      *   展示限幅 1–999。投影重置（换会话/重算，数值变小）只重置基线不采样。
      * - 读数保持显示不淡出；「Deep diving」行消失时随行消失。
      */
    function LiveRateHint(props) {
      const projection = props && typeof props.useProjection === 'function'
        ? props.useProjection('sessionStats')
        : undefined;
      const latest = React.useRef(projection);
      latest.current = projection;

      React.useEffect(() => {
        const TICK_MS = 500;
        let stopped = false;
        let node = null;
        let rate = 0;
        let visible = false;
        let lastTokens = null;
        let lastDecodeMs = null;
        let carryTok = 0;
        let carryMs = 0;

        const hostOf = () => {
          // 2026-11-05 用户报「多个分身时实时速率都挤在一个里面」（截图：三列各自在跑，
          // 底部三个 t/s 读数全堆在第 1 列）：
          // 根因 = 本组件挂在 `conversation.input.dock`（session 作用域槽位），**分列时每列各渲染一个实例**，
          // 但下面用 document.querySelector('[data-chat-running]') **全局**查，三个实例都命中
          // 文档里第一个运行行 → 全往第一列追加 span。
          // 修法：用本槽位的 standardProps.sessionId 定位到**本会话的内容区**，只在里面找运行行。
          const sid = props && props.sessionId ? String(props.sessionId) : '';
          let scope = null;
          if (sid) {
            try {
              const sel = '[data-conversation-content][data-conversation-session="' + (window.CSS && CSS.escape ? CSS.escape(sid) : sid) + '"]';
              scope = document.querySelector(sel);
            } catch (error) { scope = null; }
          }
          if (scope) {
            const row = scope.querySelector('[data-chat-running]');
            if (row) return row.lastElementChild;
          }
          // 内容区里找不到（运行行在外层列容器时）→ 退到本列容器；分列视图里**绝不**退回全局，
          // 否则又会把读数写进别人的列（宁可不显示，也不错位）。
          const colScope = scope ? scope.closest('.hub-cc-col') : null;
          if (colScope) {
            const row = colScope.querySelector('[data-chat-running]');
            if (row) return row.lastElementChild;
            return null;
          }
          if (scope) return null;   // 能定位到本会话内容区但没运行行 → 本列无读数，别污染别列
          const row = document.querySelector('[data-chat-running]');   // 无 sessionId（单列/兜底）保持原行为
          return row ? row.lastElementChild : null;
        };
        const ensureNode = () => {
          const host = hostOf();
          if (!host) {
            if (node) { node.remove(); node = null; }
            return null;
          }
          // React 每秒重渲染这一行，节点可能被带走：不在了就补挂一个
          if (!node || !node.isConnected || node.parentElement !== host) {
            if (node) node.remove();
            node = document.createElement('span');
            node.className = 'hub-rate-hint';
            node.style.cssText = 'margin-left:6px;opacity:0;font-variant-numeric:tabular-nums;transition:opacity 220ms ease;pointer-events:none;';
            host.appendChild(node);
          }
          return node;
        };
        const paint = () => {
          const el = ensureNode();
          if (!el) return;
          el.textContent = visible ? `${rate} t/s` : '';
          el.style.opacity = visible ? '0.72' : '0';
        };

        const tick = () => {
          if (stopped) return;
          const stats = latest.current;
          if (stats && Number.isFinite(stats.decodeTokens) && Number.isFinite(stats.decodeMs)) {
            if (lastDecodeMs === null || stats.decodeMs < lastDecodeMs || stats.decodeTokens < lastTokens) {
              // 首次看到投影，或投影被重置（换会话 / 口径重算，累计值变小）：只重置基线
              lastDecodeMs = stats.decodeMs;
              lastTokens = stats.decodeTokens;
              carryTok = 0;
              carryMs = 0;
            } else if (stats.decodeMs > lastDecodeMs) {
              const dms = stats.decodeMs - lastDecodeMs;
              const dtok = stats.decodeTokens - lastTokens;
              lastDecodeMs = stats.decodeMs;
              lastTokens = stats.decodeTokens;
              // 流式增量累计（2026-10-21 修复「完全不出数」）：投影常以小步增量更新，
              // 单次 dms 常不足 200ms——直接丢样本会永远不出数。改为滚入累计池，
              // 凑够 200ms 再出数；累计的是真实累积计数器的差分，无毛刺风险。
              carryTok += Math.max(0, dtok);
              carryMs += Math.max(0, dms);
              if (carryMs >= 200 && carryTok > 0) {
                const r = carryTok / (carryMs / 1000);
                if (r <= 2000) {
                  rate = Math.max(1, Math.min(999, Math.round(r)));
                  visible = true;
                  paint();
                }
                carryTok = 0;
                carryMs = 0;
              }
            }
          }
          // 已有读数时每拍确认节点还在（React 每秒重渲染那一行会把挂的 span 带走）
          if (visible) {
            const el = ensureNode();
            if (el) {
              el.textContent = `${rate} t/s`;
              el.style.opacity = '0.72';
            }
          }
        };

        const timer = setInterval(tick, TICK_MS);
        tick();
        return () => {
          stopped = true;
          clearInterval(timer);
          if (node) { node.remove(); node = null; }
        };
      }, []);

      return null;
    }

    /** 侧栏底部状态卡（接收座位 ownerProps：wide 表示侧栏是否展开）。 */
    function HubStatusCard(props) {
      const [armed, setArmed] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      // 2026-11-06：重启前录屏（抓一闪而过的报错）时的进行态
      const [recording, setRecording] = React.useState(false);
      // 2026-11-06：**启动期自动抓拍**——页面加载后 12 秒内每 250ms 存一帧界面快照，
      // 专门用来抓「启动时一闪而过的报错」（内核禁屏幕捕获，只能走文本快照）。
      React.useEffect(() => {
        const id = `boot-${Date.now()}`;
        let seq = 0;
        let stopped = false;
        const tick = () => {
          if (stopped || seq >= 48) return;
          const cur = seq++;
          try {
            fetch('/hub/ui-snapshot', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, seq: cur, frame: captureUiFrame() }),
            }).catch(() => {});
          } catch (error) { /* 忽略 */ }
        };
        tick();
        const bootTimer = setInterval(tick, 250);
        return () => { stopped = true; clearInterval(bootTimer); };
      }, []);
      // 2026-10-26：90s 防抖命中时的可见反馈
      const [debounced, setDebounced] = React.useState(false);
      const [modelOptions, setModelOptions] = React.useState([]);
      const [modelValue, setModelValue] = React.useState('');
      const [modelOpen, setModelOpen] = React.useState(false);
      const [modelQuery, setModelQuery] = React.useState('');
      const [modelPopover, setModelPopover] = React.useState({ left: 12, bottom: 60 });
      const modelButtonRef = React.useRef(null);
      const [busy, setBusy] = React.useState(false);
      // 全局切模型进度（2026-10-23 用户要求加进度条）：{done,total,running} | null
      const [progress, setProgress] = React.useState(null);
      const timer = React.useRef(null);

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const res = await fetch('/hub/models');
            const data = await res.json();
            if (cancelled || !data || !data.ok) return;
            const options = [];
            for (const group of data.groups || []) {
              for (const model of group.models || []) {
                options.push({
                  value: `${group.id}/${model.id}`,
                  label: `${group.name} · ${model.name}`,
                  groupName: group.name,
                  modelName: model.name,
                });
              }
            }
            setModelOptions(options);
            if (data.default) setModelValue(`${data.default.provider}/${data.default.model}`);
          } catch (error) { /* Host 未重启时路由不存在，忽略 */ }
        })();
        return () => { cancelled = true; };
      }, []);

      const currentModelLabel = (() => {
        const hit = modelOptions.find((option) => option.value === modelValue);
        return hit ? hit.modelName : (modelOptions.length === 0 ? '模型…' : '选择模型');
      })();

      const toggleModelMenu = () => {
        setModelOpen((open) => {
          if (open) return false;
          setModelQuery('');
          const rect = modelButtonRef.current ? modelButtonRef.current.getBoundingClientRect() : null;
          if (rect) {
            setModelPopover({
              left: Math.max(8, rect.left),
              bottom: Math.max(8, window.innerHeight - rect.top + 6),
            });
          }
          return true;
        });
      };

      const switchModel = async (value) => {
        if (!value || busy) return;
        const at = value.indexOf('/');
        const provider = value.slice(0, at);
        const model = value.slice(at + 1);
        setBusy(true);
        setProgress({ done: 0, total: 0, running: true });
        // 进度轮询（2026-10-23 用户要求）：批量切模型逐会话处理，几十秒内完成，
        // 期间用进度条替代「卡住」的观感。
        const poll = async () => {
          try {
            const res = await fetch('/hub/switch-model-progress');
            const data = await res.json();
            if (data && data.ok) {
              setProgress({
                done: Number(data.done) || 0,
                total: Number(data.total) || 0,
                running: Boolean(data.running),
              });
            }
          } catch (error) { /* 轮询失败忽略 */ }
        };
        const timer = setInterval(poll, 400);
        try {
          await fetch('/hub/switch-model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider, model }),
          });
          await poll();
          setModelValue(value);
          setModelOpen(false);
        } catch (error) {
          console.error('[hub-desktop-ui] switch model failed', error);
        } finally {
          clearInterval(timer);
          setBusy(false);
          setProgress(null);
        }
      };

      /** 界面快照帧：DSH 内核禁掉全部屏幕捕获权限，真录屏不可能——
       *  `setDisplayMediaRequestHandler((_r, cb) => cb({}))` + 权限 handler 一律 false（2026-11-06 实测）。
       *  改采「可见文字 + 疑似报错元素」快照，能抓到一闪而过的报错内容。 */
      const captureUiFrame = () => {
        try {
          const errors = [];
          const sel = '[role="alert"],[class*="error" i],[data-state="error"],[class*="toast" i]';
          for (const el of document.querySelectorAll(sel)) {
            if (errors.length >= 20) break;
            const text = String(el.innerText || el.textContent || '').trim();
            if (!text) continue;
            errors.push({ text: text.slice(0, 400), cls: String(el.className || '').slice(0, 120) });
          }
          return {
            t: Date.now(),
            text: String(document.body ? document.body.innerText : '').slice(0, 8000),
            errors,
          };
        } catch (error) {
          return { t: Date.now(), text: '', errors: [] };
        }
      };

      /** 重启前抓拍 3 秒（覆盖「点重启 → 进程被杀」之间闪过的提示），再触发重启。 */
      const recordThenRestart = async () => {
        const id = `restart-${Date.now()}`;
        let seq = 0;
        setRecording(true);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const cur = seq++;
          try {
            await fetch('/hub/ui-snapshot', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, seq: cur, frame: captureUiFrame() }),
            });
          } catch (error) { /* 抓拍失败不影响重启 */ }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        setRecording(false);
      };

      const restart = () => {
        if (failed) setFailed(false);
        if (recording) return;   // 正在录，别重入
        if (!armed) {
          setArmed(true);
          if (timer.current) clearTimeout(timer.current);
          // 4s 内没再点就撤掉确认态
          timer.current = setTimeout(() => setArmed(false), 4000);
          return;
        }
        if (timer.current) clearTimeout(timer.current);
        setArmed(false);
        // 失败必须看得见：旧代码 catch 掉一切，路由缺失时点了像没反应。
        // 2026-10-26：防抖命中（90s 内已重启过）也要给反馈，否则看着像按钮失灵。
        void (async () => {
          await recordThenRestart();   // 先录屏落盘（失败也不影响重启）
          fetch('/hub/restart', { method: 'POST' })
            .then(async (res) => {
              if (!res.ok) { setFailed(true); return; }
              const body = await res.text();
              if (body === 'debounced') {
                setDebounced(true);
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => setDebounced(false), 4000);
              }
            })
            .catch((error) => {
              console.error('[hub-desktop-ui] restart failed', error);
              setFailed(true);
            });
        })();
      };
      // —— 余额行（2026-10-21 合并进本卡，取代独立的 quota-panel 卡片）——
      // 数据 GET /hub/quota，60s 刷新；失败显示「余额不可用」+ hover 原因，绝不显示 0 冒充。
      const wide = props && props.wide !== undefined ? Boolean(props.wide) : true;
      // 其它插件挂在同一个 footer 槽里的入口（cordis-panel / scifork 等）：CSS 已把它们
      // 视觉隐藏（见 apply() 注入的样式），这里把它们的**文字标签**收进本卡的「⋯」菜单，
      // 点菜单项 = 点原来那个隐藏元素，功能不丢（2026-10-21 单卡合并）。
      const cardRef = React.useRef(null);
      const otherElsRef = React.useRef([]);
      const [otherEntries, setOtherEntries] = React.useState([]);
      const [menuOpen, setMenuOpen] = React.useState(false);
      React.useEffect(() => {
        const read = () => {
          const self = cardRef.current;
          const parent = self && self.parentElement;
          if (!parent) return;
          const els = [...parent.children].filter((el) => el !== self && !el.contains(self));
          otherElsRef.current = els;
          setOtherEntries(els.map((el, index) => {
            const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            return { index, label: text.slice(0, 20) || `入口 ${index + 1}` };
          }));
        };
        read();
        const id = setInterval(read, 1500);
        return () => clearInterval(id);
      }, []);
      const fireOther = (index) => {
        const el = otherElsRef.current[index];
        setMenuOpen(false);
        if (!el) return;
        const button = el.querySelector('button') || el;
        try { button.click(); } catch (error) { console.error('[hub-desktop-ui] footer entry click failed', error); }
      };
      const [quota, setQuota] = React.useState({ loading: true, ok: false });
      const [quotaOpen, setQuotaOpen] = React.useState(false);
      const [quotaPop, setQuotaPop] = React.useState({ left: 12, bottom: 60 });
      const quotaBtnRef = React.useRef(null);
      React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          try {
            const res = await fetch('/hub/quota');
            const data = await res.json();
            if (cancelled) return;
            const amount = data && data.balance ? Number(data.balance.amount) : NaN;
            // 2026-11-06 修「余额不可用」误报（用户报「依旧是余额不可用」）：
            // Host 的 `ok:false` 最常见原因是**今日用量还在统计中**（`usageReady=false` →
            // `error:"用量统计中…"` + `pending:true`），此时 `balance` 完全有效（实测 amount=17.93）。
            // 原来用 `data.ok` 一起判定 → 有余额也走 else 分支显示「⚠ 余额不可用」。
            // 正确口径：**有 balance.amount 就显示余额**；余额自身失败时 Host 会把 balance 置 null。
            if (data && Number.isFinite(amount)) {
              const today = data.today || {};
              // 2026-11-06 用户质疑「不是直接用差值算吗？这么复杂吗」：
              // 对——花费就是**余额差值**（Host 已算好），原来却嵌在 `today` 里，
              // 而 today 依赖用量扫描 → 扫描没完成时花费被一起丢掉，只能显示「今日 ¥?」。
              // Host 现已把差值提到**顶层 `data.cost`**：优先取它，旧 Host 回退 today.cost。
              const costSrc = (data && data.cost) || (today && today.cost) || null;
              const winSrc = (today && today.todayWindow) || (costSrc && costSrc.todayWindow) || null;
              setQuota({
                loading: false, ok: true, amount,
                currency: (data.balance && data.balance.currency) || 'CNY',
                tokens: Number(today.tokens) || 0,
                requests: Number(today.requests) || 0,
                breakdown: today.breakdown || null,
                // 今日花费：**差值口径（真实扣费）**，与用量扫描解耦
                cost: costSrc && Number.isFinite(Number(costSrc.amount)) ? Number(costSrc.amount) : null,
                costBasis: costSrc ? String(costSrc.basis || '') : '',
                costBaselineAt: costSrc ? String(costSrc.baselineAt || '') : '',
                // 今日窗口与采样起点（2026-10-22：口径统一为本地自然日 00:00 → now）
                costWindowFrom: winSrc ? String(winSrc.from || '') : '',
                costWindowTo: winSrc ? String(winSrc.to || '') : '',
                costSampledFrom: costSrc ? String(costSrc.sampledFrom || '') : '',
                costBaselineAmount: costSrc && Number.isFinite(Number(costSrc.baselineAmount))
                  ? Number(costSrc.baselineAmount) : null,
                costDeltaAmount: costSrc && Number.isFinite(Number(costSrc.deltaAmount))
                  ? Number(costSrc.deltaAmount) : null,
                costDeltaBaselineAt: costSrc ? String(costSrc.deltaBaselineAt || '') : '',
                costDeltaNote: costSrc ? String(costSrc.deltaNote || '') : '',
                costPeak: costSrc && Number.isFinite(Number(costSrc.estimatePeak)) ? Number(costSrc.estimatePeak) : null,
                costOff: costSrc && Number.isFinite(Number(costSrc.estimateOff)) ? Number(costSrc.estimateOff) : null,
                costFromFirstSample: Boolean(costSrc && costSrc.fromFirstSample),
                costTopUp: costSrc && Number.isFinite(Number(costSrc.topUpTotal)) ? Number(costSrc.topUpTotal) : 0,
                costEstimate: costSrc && Number.isFinite(Number(costSrc.estimate)) ? Number(costSrc.estimate) : null,
                priceSource: today.priceSource || null,
                updatedAt: data.updatedAt || '',
                error: '',
              });
            } else {
              setQuota({ loading: false, ok: false, error: (data && (data.error || data.reason)) || 'Host /hub/quota 无数据' });
            }
          } catch (error) {
            if (!cancelled) setQuota({ loading: false, ok: false, error: String((error && error.message) || error) });
          }
        };
        load();
        const id = setInterval(load, 60000);
        return () => { cancelled = true; clearInterval(id); };
      }, []);
      const fmtTokens = (n) => {
        const v = Number(n) || 0;
        if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
        if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
        if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
        return String(v);
      };
      // ISO 时间戳 → 北京时间 HH:mm。**显式指定时区**：渲染进程的本地时区不一定是 +08
      //（2026-10-22 实测：直接切 ISO 字符串会显示成 UTC 的 13:37，而用户看到的是 21:37）。
      const hhmm = (iso) => {
        const t = Date.parse(String(iso || ''));
        if (!Number.isFinite(t)) return '';
        try {
          return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(new Date(t));
        } catch {
          const d = new Date(t);
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
      };
      // 卡片行：`💰 ¥余额 · 今日 ¥花费`——口径 = **本地自然日 00:00 起**的余额差值（真实扣费）。
      // 2026-10-22 用户纠正：不许出现「自 hh:mm 起」这类以首次采样为起点的文案。
      const costLabel = quota.cost === null || quota.cost === undefined
        ? '今日 ¥?'
        : `今日 ¥${quota.cost.toFixed(2)}`;
      const balanceLabel = quota.loading
        ? '…'
        : quota.ok
          ? `💰 ¥${quota.amount.toFixed(2)} · ${costLabel}`
          : '⚠ 余额不可用';
      const quotaTitle = quota.loading
        ? '正在读取余额…'
        : quota.ok
          ? `余额 ${quota.currency} ${quota.amount.toFixed(2)}；今日花费（0:00 起）${quota.cost === null
            ? '统计中（用量还在扫描，稍后自动刷新）'
            : `¥${quota.cost.toFixed(2)}`}；今日 ${quota.tokens.toLocaleString()} tokens / ${quota.requests} 次请求。点开看明细`
          : `余额不可用：${quota.error || '未知原因'}`;
      const openQuota = () => {
        setQuotaOpen((open) => {
          if (open) return false;
          const rect = quotaBtnRef.current ? quotaBtnRef.current.getBoundingClientRect() : null;
          if (rect) {
            setQuotaPop({
              left: Math.max(8, rect.left),
              bottom: Math.max(8, window.innerHeight - rect.top + 6),
            });
          }
          return true;
        });
      };
      // 余额明细弹层（点余额那一行展开；折叠态点击图标也走它）
      const quotaPopover = quotaOpen ? h(
        'div',
        {
          style: {
            position: 'fixed', zIndex: 1201, width: '252px',
            left: `${quotaPop.left}px`, bottom: `${quotaPop.bottom}px`,
            display: 'flex', flexDirection: 'column', gap: '4px',
            padding: '10px 12px', borderRadius: '12px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            fontSize: '11px', lineHeight: 1.5,
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
          quota.ok ? `余额 ¥${quota.amount.toFixed(2)}` : '余额不可用'),
        quota.ok
          ? h('div', null,
            `今日花费（0:00 起）${quota.cost === null ? '¥?' : `¥${quota.cost.toFixed(2)}`}`
            + '（余额差值 = 真实扣费）')
          : null,
        quota.ok && quota.costWindowFrom
          ? h('div', { style: { opacity: 0.75, fontSize: '10px' } },
            `统计窗口 今日 ${hhmm(quota.costWindowFrom)} → ${hhmm(quota.costWindowTo) || '现在'}`
            + (quota.costSampledFrom ? `；余额采样自 ${hhmm(quota.costSampledFrom)} 起` : '')
            + (quota.costBaselineAmount !== null ? `（基线 ¥${Number(quota.costBaselineAmount).toFixed(2)}）` : '')
            + (quota.costTopUp > 0 ? `；今日充值 ¥${quota.costTopUp.toFixed(2)} 已还原` : ''))
          : null,
        quota.ok && quota.cost !== null && quota.costSampledFrom && quota.costWindowFrom
          && (Date.parse(quota.costSampledFrom) - Date.parse(quota.costWindowFrom) > 10 * 60 * 1000)
          ? h('div', { style: { opacity: 0.65, fontSize: '10px' } },
            `注：0:00–${hhmm(quota.costSampledFrom)} 之间没有采样，这段花费未计入（以官方平台页为准）`)
          : null,
        quota.ok && quota.cost === null && quota.priceSource
          ? h('div', { style: { opacity: 0.75, fontSize: '10px' } }, '花费暂不可用：读不到余额差值（余额查询失败）')
          : null,
        // 官方平台用量页（今天总额以那里为准；本卡只报采样后的真实扣费）
        h('a', {
          href: 'https://platform.deepseek.com/usage',
          target: '_blank',
          rel: 'noreferrer',
          style: { marginTop: '2px', fontSize: '10px', color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none' },
        }, '官方平台用量明细 ↗'),
        quota.ok
          ? h('div', null, `今日 ${quota.tokens.toLocaleString()} tokens · ${quota.requests.toLocaleString()} 次请求`)
          : h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, quota.error || '未知原因'),
        quota.ok && quota.breakdown
          ? h('div', { style: { opacity: 0.85 } },
            `输入 ${fmtTokens(quota.breakdown.input)} · 输出 ${fmtTokens(quota.breakdown.output)}`
            + ` · 缓存读 ${fmtTokens(quota.breakdown.cacheRead)}`
            + (Number(quota.breakdown.cacheWrite) ? ` · 缓存写 ${fmtTokens(quota.breakdown.cacheWrite)}` : ''))
          : null,
        // 缓存命中率（2026-10-26 借鉴 Reasonix「缓存优先」：先量化再优化）。
        // 口径：inputTokens = 未命中输入（已在 quota-core 验证），命中率 =
        // cacheRead / (cacheRead + input)。hits<1M 命中率高不了多少字，只在有缓存读时显示。
        quota.ok && quota.breakdown && Number(quota.breakdown.cacheRead) > 0
          ? h('div', { style: { marginTop: '2px', fontSize: '10px' } },
            (() => {
              const cr = Number(quota.breakdown.cacheRead) || 0;
              const miss = Number(quota.breakdown.input) || 0;
              const pct = cr + miss > 0 ? Math.round((cr / (cr + miss)) * 1000) / 10 : 0;
              const color = pct >= 80 ? 'var(--dsw-alias-state-success-primary)'
                : pct >= 50 ? 'var(--dsw-alias-state-warn-primary)'
                  : 'var(--dsw-alias-state-error-primary)';
              return [
                h('span', { style: { color, fontWeight: 600 } }, `缓存命中 ${pct}%`),
                `（读 ${fmtTokens(cr)} / 未命中 ${fmtTokens(miss)}）`,
              ];
            })())
          : null,
        // 单价表 + 价格来源（价格必须可追溯，不许只给个数字）
        quota.ok && quota.priceSource
          ? h('div', { style: { marginTop: '2px', opacity: 0.8, fontSize: '10px', lineHeight: 1.45 } },
            quota.priceSource.error
              ? `价格表未取到（${String(quota.priceSource.error).slice(0, 60)}）`
              : `单价（元/百万 tokens，deepseek-flash）：命中 ${quota.priceSource.holidayAware ? '' : ''}`
                + '空闲/高峰 0.02/0.04 · 未命中 1/2 · 输出 4/8',
            quota.priceSource.fetchedAt
              ? h('div', { style: { opacity: 0.75 } },
                `价格表抓取于 ${String(quota.priceSource.fetchedAt).replace('T', ' ').slice(0, 16)}`
                + (Number(quota.priceSource.ageDays) > 0 ? `（${quota.priceSource.ageDays} 天前）` : ''))
              : null,
            h('div', { style: { opacity: 0.7 } },
              '以上是**计价时段**（不是统计起点）：北京时间周一至周五 9-12、14-18 为高峰价，其余时段空闲价（半价）；不含法定节假日表。'))
          : null,
        quota.ok && quota.updatedAt
          ? h('div', { style: { opacity: 0.7 } }, `更新于 ${String(quota.updatedAt).replace('T', ' ').slice(0, 19)}`)
          : null,
        h('div', { style: { opacity: 0.7 } }, '每 60s 自动刷新'),
      ) : null;
      const otherMenu = menuOpen && otherEntries.length ? h(
        'div',
        {
          style: {
            position: 'fixed', zIndex: 1202, minWidth: '150px',
            left: `${quotaPop.left}px`, bottom: `${quotaPop.bottom}px`,
            display: 'flex', flexDirection: 'column',
            padding: '4px', borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          },
        },
        ...otherEntries.map((entry) => h('button', {
          key: entry.index,
          type: 'button',
          onClick: () => fireOther(entry.index),
          style: {
            padding: '6px 10px', border: 'none', borderRadius: '7px', textAlign: 'left',
            background: 'transparent', color: 'var(--dsw-alias-label-primary)',
            cursor: 'pointer', fontSize: '11px',
          },
        }, entry.label)),
      ) : null;
      if (!wide) {
        // 折叠态（56px 图标轨）：**只占一个图标**（2026-10-21 用户要求），点开是同一份余额明细
        return h(
          'div',
          { ref: cardRef, 'data-hub-footer': '1', style: { display: 'contents' } },
          h('button', {
            type: 'button',
            ref: quotaBtnRef,
            className: 'hub-footer-rail-icon',
            title: quotaTitle,
            onClick: openQuota,
            style: {
              width: '28px', height: '28px', margin: '4px auto', padding: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent', cursor: 'pointer', fontSize: '14px',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, quota.ok ? '💰' : '⚠'),
          quotaPopover,
          otherMenu,
        );
      }
      // 单卡两行（2026-10-21）：第一行「状态 + 重启」，第二行「余额 + 模型 + ⋯」。
      // 一行塞四项在 320px 侧栏里必然截断（实测 ¥54. 被切），所以拆两行但仍是一张卡。
      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0,
      };
      return h(
        'div',
        {
          ref: cardRef,
          'data-hub-footer': '1',
          title: 'AI-Agent-Hub DSH 形态插件（out-of-tree Cordis 客户端插件）',
          style: {
            margin: '6px 10px',
            padding: '7px 9px',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            fontSize: '11px',
            lineHeight: '1.3',
            color: 'var(--dsw-alias-label-secondary)',
            userSelect: 'none',
            // 2026-10-25 修「缩放后状态卡显示不全」：侧栏缩放是继承式 zoom，固定 px 上限
            // （模型药丸 maxWidth:150px）会被一起放大而顶出侧栏 → 改百分比 + 允许收缩 + 裁切兜底
            boxSizing: 'border-box',
            maxWidth: '100%',
            minWidth: 0,
            overflow: 'hidden',
          },
        },
        h('div', { style: rowStyle },
          h('span', {
            style: {
              width: '6px', height: '6px', borderRadius: '50%',
              background: 'var(--dsw-alias-state-success-primary)',
              flex: '0 0 auto',
            },
          }),
          h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', flex: '1 1 auto', minWidth: 0 } }, 'AI-Agent-Hub'),
          h('button', {
            type: 'button',
            title: recording
              ? '正在录屏（重启前 6 秒画面会存到 .hub/restart-recordings/）'
              : '重启 DSH（会中断运行中的任务；点两次确认，重启前会自动录屏 6 秒抓报错）',
            onClick: restart,
            style: {
              flex: '0 0 auto', height: '18px', padding: '0 8px', borderRadius: '9px',
              border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
              color: (armed || failed) ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer', fontSize: '9.5px',
            },
          }, recording ? '录制中…' : (failed ? '重启失败' : debounced ? '90秒内已重启' : armed ? '确认重启' : '重启')),
        ),
        h('div', { style: rowStyle },
          // 余额行（并进本卡）：点开看明细；失败态 hover 给原因
          h('button', {
            type: 'button',
            ref: quotaBtnRef,
            title: quotaTitle,
            onClick: openQuota,
            style: {
              flex: '1 1 auto', minWidth: 0, height: '18px', padding: '0 6px',
              borderRadius: '9px', border: '1px solid transparent',
              background: 'transparent', textAlign: 'left',
              color: quota.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-warning-primary, #c9a227)',
              cursor: 'pointer', fontSize: '9.5px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            },
          }, balanceLabel),
          quotaPopover,
        h('button', {
          type: 'button',
          ref: modelButtonRef,
          title: '一键把所有会话切到这个模型',
          onClick: toggleModelMenu,
          style: {
            height: '18px', maxWidth: '52%', minWidth: 0, flex: '0 1 auto', padding: '0 7px',
            borderRadius: '9px', border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
            cursor: modelOptions.length === 0 ? 'default' : 'pointer', fontSize: '9.5px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, modelOptions.length === 0
          ? '模型…'
          // 侧栏窄：去掉 DeepSeek- 前缀再显示，避免只剩 "Deep"（完整名在 hover title 里）
          : `${String(currentModelLabel).replace(/^DeepSeek[- ]/i, '')} ▾`),
        modelOpen ? h(
          'div',
          {
            style: {
              position: 'fixed', zIndex: 1200, width: '240px', maxHeight: '320px',
              display: 'flex', flexDirection: 'column',
              left: `${modelPopover.left}px`, bottom: `${modelPopover.bottom}px`,
              borderRadius: '12px', overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            },
          },
          h('input', {
            autoFocus: true,
            value: modelQuery,
            placeholder: '搜索模型…',
            onChange: (event) => setModelQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Escape') setModelOpen(false); },
            style: {
              height: '30px', padding: '0 10px', border: 'none', outline: 'none',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent', color: 'var(--dsw-alias-label-primary)',
              fontSize: '11.5px', flex: '0 0 auto',
            },
          }),
          // 进度条（2026-10-23）：批量切模型要逐会话处理，过程中显示 done/total
          progress
            ? (() => {
              const total = progress.total || 0;
              const done = Math.min(progress.done || 0, total || Number.MAX_SAFE_INTEGER);
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              return h('div', {
                style: {
                  flex: '0 0 auto', padding: '7px 10px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  display: 'flex', flexDirection: 'column', gap: '4px',
                },
              },
                h('div', {
                  style: {
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: '10px', color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                  h('span', null, '正在应用到所有对话…'),
                  h('span', null, total > 0 ? `${done}/${total}` : '准备中…'),
                ),
                h('div', {
                  style: {
                    height: '4px', borderRadius: '2px', overflow: 'hidden',
                    background: 'var(--dsw-alias-bg-layer-1)',
                  },
                },
                  h('div', {
                    style: {
                      height: '100%', width: `${pct}%`, borderRadius: '2px',
                      background: 'var(--dsw-alias-brand-primary)',
                      transition: 'width 200ms ease',
                    },
                  }),
                ),
              );
            })()
            : null,
          h(
            'div',
            { style: { overflowY: 'auto', padding: '4px 0', flex: '1 1 auto' } },
            ...modelOptions
              .filter((option) => {
                if (!modelQuery.trim()) return true;
                const needle = modelQuery.trim().toLowerCase();
                return option.label.toLowerCase().includes(needle);
              })
              .map((option) => {
                const active = option.value === modelValue;
                return h(
                  'button',
                  {
                    key: option.value,
                    type: 'button',
                    title: option.label,
                    onClick: () => switchModel(option.value),
                    style: {
                      display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
                      padding: '6px 10px', border: 'none', textAlign: 'left',
                      background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
                      fontSize: '11.5px',
                    },
                  },
                  h('span', {
                    style: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' },
                  }, option.groupName),
                  h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, option.modelName),
                  active ? h('span', { style: { flex: '0 0 auto', opacity: 0.8 } }, '✓') : null,
                );
              }),
          ),
        ) : null,
        // 其它插件入口收进这一个菜单（cordis 面板 / 其它页脚项），保持「一张卡」
        otherEntries.length
          ? h('button', {
            type: 'button',
            title: `其它入口：${otherEntries.map((entry) => entry.label).join(' / ')}`,
            onClick: () => {
              const rect = quotaBtnRef.current ? quotaBtnRef.current.getBoundingClientRect() : null;
              if (rect) {
                setQuotaPop({
                  left: Math.max(8, rect.left + rect.width - 150),
                  bottom: Math.max(8, window.innerHeight - rect.top + 6),
                });
              }
              setMenuOpen((open) => !open);
            },
            style: {
              flex: '0 0 auto', height: '18px', width: '20px', padding: 0, borderRadius: '9px',
              border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '11px',
              lineHeight: 1,
            },
          }, '⋯')
          : null,
        ),
        otherMenu,
      );
    }

    /* 2026-11-11 用户：「这个（More）也隐藏吧…在设置里面加一个选项，隐藏或者显示」，
       随后又问「还有 new session 的开关呢」→ 设置页「侧栏」分区里两行开关，各自控制一颗出厂按钮。
       偏好存 localStorage，落到 <html data-hub-…>，隐藏由 SKIN_CSS 里对应的 html[...] 规则执行。
       默认都是隐藏（用户觉得这两颗按钮没用），只有显式存成 '0' 才显示回来。 */
    const SIDEBAR_TOGGLES = [
      {
        key: 'hub.sidebar.hideNewSession',
        attr: 'data-hub-hide-new-session',
        label: '隐藏侧栏「New Session」按钮',
        hint: '收起侧栏顶部的新建会话胶囊按钮',
      },
      {
        key: 'hub.sidebar.hideMore',
        attr: 'data-hub-hide-more',
        label: '隐藏侧栏「More」按钮',
        hint: '收起面板列表下方的 More 启动器，给会话列表腾空间',
      },
    ];
    function readToggle(toggle) {
      try { return window.localStorage.getItem(toggle.key) !== '0'; } catch (error) { return true; }
    }
    function writeToggle(toggle, on) {
      try { window.localStorage.setItem(toggle.key, on ? '1' : '0'); } catch (error) { /* ignore */ }
    }
    function applyToggle(toggle, on) {
      try {
        const root = document.documentElement;
        if (on) root.setAttribute(toggle.attr, '');
        else root.removeAttribute(toggle.attr);
      } catch (error) { /* ignore */ }
    }
    function HubSidebarToggleRow(props) {
      const { label, hint, on, onChange } = props;
      return h('div', {
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        tabIndex: 0,
        onClick: onChange,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onChange(); }
        },
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
          borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer', userSelect: 'none',
        },
      },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } }, label),
          h('span', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } }, hint),
        ),
        h('span', {
          'aria-hidden': 'true',
          style: {
            marginLeft: 'auto', flex: '0 0 40px', width: '40px', height: '22px', borderRadius: '11px',
            background: on ? '#d97757' : 'var(--dsw-alias-border-l2)',
            position: 'relative', transition: 'background .15s ease',
          },
        },
          h('span', {
            style: {
              position: 'absolute', top: '3px', left: on ? '21px' : '3px', width: '16px', height: '16px',
              borderRadius: '50%', background: '#fff', transition: 'left .15s ease',
            },
          }),
        ),
      );
    }
    function HubSidebarSettingsSection() {
      const [state, setState] = React.useState(() => {
        const initial = {};
        for (const toggle of SIDEBAR_TOGGLES) initial[toggle.key] = readToggle(toggle);
        return initial;
      });
      React.useEffect(() => {
        for (const toggle of SIDEBAR_TOGGLES) applyToggle(toggle, state[toggle.key]);
      }, [state]);
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' } },
        h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px', color: 'var(--dsw-alias-label-primary)' } }, '侧栏'),
        ...SIDEBAR_TOGGLES.map((toggle) => h(HubSidebarToggleRow, {
          key: toggle.key,
          label: toggle.label,
          hint: toggle.hint,
          on: state[toggle.key],
          onChange: () => {
            const next = !state[toggle.key];
            writeToggle(toggle, next);
            setState((prev) => ({ ...prev, [toggle.key]: next }));
          },
        })),
      );
    }

    return {
      inject: ['slots', 'theme'],
      apply(ctx) {
        // ⓪-b 侧栏左下角「只留一张卡」（2026-10-21）：把 footer 槽里**非本插件**的占位者
        // （DSH 自带 cordis-panel、其它第三方入口）视觉隐藏；它们的标签已收进本卡「⋯」菜单，
        // 点菜单项会转发 click 到隐藏元素，功能不丢。
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-hub', 'footer-single-card');
          // 用 :has() 兜住「本卡可能被包一层」的情形：只隐藏**不含本卡**的兄弟块。
          style.textContent = [
            '[data-slot="sidebar.footer.action"] > *:not([data-hub-footer="1"]):not(:has([data-hub-footer="1"]))',
            '{ display: none !important; margin: 0 !important; padding: 0 !important; }',
            '[data-slot="sidebar.footer.action"] { gap: 0 !important; padding: 0 2px !important; }',
          ].join(' ');
          document.head.appendChild(style);
          return () => { try { style.remove(); } catch { /* already gone */ } };
        });
        // ⓪ 渲染层报错上报：Electron 看不到控制台，报错 POST 到 Host 落盘 .hub/client-errors.log
        //（群聊打不开这类"点击无反应"问题靠它拿真实堆栈）。
        ctx.effect(() => {
          const report = (kind, payload) => {
            try {
              fetch('/hub/client-error', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  kind, at: new Date().toISOString(), href: String(location.href),
                  message: payload && payload.message,
                  stack: payload && payload.stack,
                }),
              }).catch(() => {});
            } catch { /* 上报失败就放弃 */ }
          };
          const onError = (event) => report('error', {
            message: `${event.message} @${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`,
            stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 4000) : undefined,
          });
          const onRejection = (event) => report('rejection', {
            message: String((event.reason && (event.reason.message || event.reason)) || 'unknown'),
            stack: event.reason && event.reason.stack ? String(event.reason.stack).slice(0, 4000) : undefined,
          });
          window.addEventListener('error', onError);
          window.addEventListener('unhandledrejection', onRejection);
          return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
          };
        });

        // ① 主题层：暖中性暗调 + 陶土色主色（对齐 Hermes 桌面的低饱和观感）
        // 2026-11-11 用户令：默认不覆盖 DSH 配色（USE_CUSTOM_PALETTE=false）→ 用 DSH 自带主题。
        // 想恢复暖色暗调：把文件顶部的 USE_CUSTOM_PALETTE 改成 true。
        if (USE_CUSTOM_PALETTE) ctx.effect(() => ctx.theme.overrideTokens(THEME_SOURCE, THEME_TOKENS));

        // ② 形态样式层：注入 style，卸载时移除
        ctx.effect(() => {
          const existing = document.getElementById(SKIN_STYLE_ID);          const el = existing || document.createElement('style');
          el.id = SKIN_STYLE_ID;
          el.textContent = SKIN_CSS;
          if (!existing) document.head.appendChild(el);
          // 皮肤/侧栏自检（2026-10-23）：多点采样（开机后 2.5/20/45/75 秒）上报
          // 关键诊断到 /hub/client-error —— 开机瞬间没有"运行中"会话，单点采样
          // 会误判运行栏缺失，所以分几拍采。
          try {
            const sample = () => {
              const styleEl = document.getElementById(SKIN_STYLE_ID);
              const root = document.documentElement;
              const body = document.body;
              const read = (name) => getComputedStyle(body).getPropertyValue(name).trim();
              const rootRead = (name) => getComputedStyle(root).getPropertyValue(name).trim();
              const selectors = {
                'sidebar': '[data-slot="sidebar"]',
                'sidebar.workspaces': '[data-slot="sidebar.workspaces"]',
                'hub-proj': '[data-slot="sidebar.workspaces"] .hub-proj',
                'hub-chip': '[data-slot="sidebar.workspaces"] .hub-chip',
                'hub-head-label': '[data-slot="sidebar.workspaces"] .hub-head-label',
                'hub-running-bar': '[data-slot="sidebar.workspaces"] .hub-running-bar',
                'hub-run-chip': '[data-slot="sidebar.workspaces"] .hub-run-chip',
                'legacy-treeitem': '[data-slot="sidebar.workspaces"] [role="treeitem"]',
              };
              const hits = {};
              for (const [k, sel] of Object.entries(selectors)) {
                try { hits[k] = document.querySelectorAll(sel).length; } catch (error) { hits[k] = -1; }
              }
              fetch('/hub/client-error', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  kind: 'skin-diag',
                  at: new Date().toISOString(),
                  hasStyle: Boolean(styleEl),
                  styleLen: styleEl ? styleEl.textContent.length : 0,
                  // 快捷栏三态（2026-10-24）：各模式 pill 数 + 未读注册表（localStorage 原文）
                  runbar: (() => {
                    try {
                      const pills = [...document.querySelectorAll('[data-slot="sidebar.workspaces"] .hub-run-chip')];
                      const modes = { running: 0, done: 0 };
                      let cloneBadges = 0;
                      let cloneSum = 0;
                      const pillTitles = [];
                      for (const pill of pills) {
                        const m = pill.getAttribute('data-mode');
                        if (m === 'done') modes.done += 1;
                        else if (m === 'running') modes.running += 1;
                        // 2026-10-26 分身并父验收：+N 徽标数、N 之和、pill 文本
                        // 2026-11-04 方案 B 后 +N 徽标在 pill 的兄弟节点里（.hub-run-group），
                        // 从父容器找，否则诊断数字恒 0。
                        const badge = (pill.closest('.hub-run-group') || pill).querySelector('.hub-run-clones');
                        if (badge) {
                          cloneBadges += 1;
                          cloneSum += Number(String(badge.textContent || '').replace(/[^0-9]/g, '')) || 0;
                        }
                        pillTitles.push(String(pill.textContent || '').trim().slice(0, 40));
                      }
                      let unreadRaw = '';
                      try { unreadRaw = window.localStorage.getItem('hub.runbar.unread') || ''; } catch (error) { /* ignore */ }
                      // 临时会话区（2026-10-24 验收）：DOM 里 loose 芯片数 + 隐藏名单
                      let looseShown = -1;
                      let hiddenRaw = '';
                      try {
                        looseShown = document.querySelectorAll('.hub-loose-section .hub-chip').length;
                        hiddenRaw = window.localStorage.getItem('hub.loose.hidden') || '';
                      } catch (error) { /* ignore */ }
                      return {
                        ...modes, cloneBadges, cloneSum, pillTitles,
                        // 2026-10-27 修「运行中栏显示不全」的验收探针：
                        // 逐个 run-chip 量 scrollWidth/clientWidth 与其右边界是否超出容器，
                        // clipped>0 即仍被裁（修复后应恒为 0）。
                        runPillClip: (() => {
                          try {
                            const bar = document.querySelector('[data-slot="sidebar.workspaces"] .hub-running-bar');
                            if (!bar) return null;
                            const barRect = bar.getBoundingClientRect();
                            const chips = [...bar.querySelectorAll('.hub-run-chip')];
                            let overflowX = 0;
                            let clipped = 0;
                            let vClip = 0;
                            let maxChipH = 0;
                            for (const chip of chips) {
                              const r = chip.getBoundingClientRect();
                              if (chip.scrollWidth - chip.clientWidth > 1) clipped += 1;
                              if (r.right - barRect.right > 1) overflowX += 1;
                              // 纵向越界（2026-10-27 用户报「运行栏高度不对、上下被切一半」）：
                              // pill 的上/下边界超出运行栏边界即算被裁。
                              if (r.top - barRect.top < -1 || barRect.bottom - r.bottom < -1) vClip += 1;
                              maxChipH = Math.max(maxChipH, Math.round(r.height));
                            }
                            return {
                              chips: chips.length, clipped, overflowX,
                              barWidth: Math.round(barRect.width),
                              barHeight: Math.round(barRect.height),
                              maxChipH, vClip,
                            };
                          } catch (error) { return null; }
                        })(),
                        looseShown, hiddenRaw: hiddenRaw.slice(0, 600), unreadRaw: unreadRaw.slice(0, 500),
                      };
                    } catch (error) { return null; }
                  })(),
                  bodyBg: read('background-color'),
                  bodyColor: read('color'),
                  // 皮肤诊断（2026-10-25 用户反馈「皮肤好像没生效」）：
                  // ① 枚举样式表里所有 --dsw-* 变量（找新版 shell 用了哪些我们没覆盖的）
                  // ② 缩放目标身份（确认没把 zoom 挂到整窗口上）
                  dswVars: (() => {
                    try {
                      const names = new Set();
                      const walkRules = (list) => {
                        for (const rule of list) {
                          if (rule.cssRules) { walkRules(rule.cssRules); continue; }
                          const matches = (rule.cssText || '').match(/--dsw-[a-z0-9-]+/gi);
                          if (matches) for (const m of matches) names.add(m);
                        }
                      };
                      for (const sheet of [...document.styleSheets]) {
                        let rules = null;
                        try { rules = sheet.cssRules; } catch (error) { continue; }
                        if (rules) walkRules(rules);
                      }
                      const all = [...names].sort();
                      const cs = getComputedStyle(document.documentElement);
                      const computed = {};
                      for (const n of all.slice(0, 80)) {
                        const v = cs.getPropertyValue(n).trim();
                        if (v) computed[n] = v;
                      }
                      return { count: all.length, names: all.slice(0, 80), computed };
                    } catch (error) { return null; }
                  })(),
                  // 轮次过程壳探针（2026-10-27 用户报「每轮结束主要内容就被折叠」）：
                  // 数出所有 data-turn-process 折叠头的展开状态 + ②a2 的合成点击数，
                  // 用来区分「没触发重展开」和「展开了又被折回」。
                  turnProcess: (() => {
                    try {
                      const btns = [...document.querySelectorAll('button[data-turn-process]')];
                      const collapsed = btns.filter((b) => b.getAttribute('aria-expanded') === 'false');
                      const expanded = btns.filter((b) => b.getAttribute('aria-expanded') === 'true');
                      const stat = window.__hubTurnExpand || { clicks: 0, lastAt: 0 };
                      return {
                        total: btns.length,
                        collapsed: collapsed.length,
                        expanded: expanded.length,
                        clicks: stat.clicks,
                        passes: stat.passes || 0,
                        retries: stat.retries || 0,
                        lastRemaining: stat.lastRemaining,
                        lastClickAt: stat.lastAt,
                        sampleText: collapsed[0] ? String(collapsed[0].textContent || '').slice(0, 30) : '',
                      };
                    } catch (error) { return null; }
                  })(),
                  // 切换会话自动贴底探针（2026-10-27 用户报「还是没有自动贴底」）
                  switchTrace: (() => { try { return window.__hubSwitchTraces || null; } catch (error) { return null; } })(),
                                    clickProbe: (() => { try { return window.__hubClickProbe || null; } catch (error) { return null; } })(),
                  // 2026-10-27 十二修诊断：dump 侧栏真实结构（属性名统计 + 前 10 行候选），
                  // 用来确认"会话项"到底靠哪个属性/类名标识，避免再猜。
                  sidebarProbe: (() => {
                    try {
                      const root = document.querySelector('[data-slot="sidebar.workspaces"]') || document.querySelector('[data-slot="sidebar"]');
                      if (!root) return null;
                      const attrCount = {};
                      for (const el of root.querySelectorAll('*')) {
                        for (const attr of el.attributes || []) {
                          if (/data-|id$|role$/.test(attr.name)) attrCount[attr.name] = (attrCount[attr.name] || 0) + 1;
                        }
                      }
                      const rows = [];
                      for (const el of root.querySelectorAll('[data-session-id],[data-sessionid],[data-session],[data-row-key],[role="option"],[role="treeitem"]')) {
                        rows.push({
                          tag: el.tagName.toLowerCase(),
                          cls: String(el.className || '').slice(0, 50),
                          attrs: Array.from(el.attributes).map((a) => `${a.name}=${String(a.value).slice(0, 34)}`).slice(0, 6),
                        });
                        if (rows.length >= 10) break;
                      }
                      return { attrs: attrCount, rows };
                    } catch (error) { return null; }
                  })(),
                  scrollBottom: (() => { try { const d = window.__hubScrollDiag || null; return { ...(d || {}), switching: document.documentElement.hasAttribute('data-hub-stick-switch'), stable: (window.__hubSwitchDebug || null) }; } catch (error) { return null; } })(),
                  // 会话标题项目名上色探针（2026-10-26）：有多少标题被染、样本样式
                  headerTint: (() => {
                    try {
                      const root = document.querySelector('[data-slot="conversation.session.header"]');
                      if (!root) return { found: false };
                      // 2026-10-27 二版：检测拆 span（data-hub-proj）而非渐变
                      const all = [...root.querySelectorAll('span, button')]
                        .filter((el) => String(el.textContent || '').includes(' · '));
                      const spans = [...root.querySelectorAll('span[data-hub-proj="1"]')];
                      const sample = spans[0] || null;
                      // 渐变残边自检：不应再有任何 linear-gradient/backgroundClip 遗留
                      const gradientLeft = all.filter((el) => (el.style.backgroundImage || '').includes('linear-gradient')).length;
                      return {
                        found: true,
                        candidates: all.length,
                        tinted: spans.length,
                        gradientLeft,
                        projText: sample ? String(sample.textContent || '').slice(0, 20) : '',
                        projColor: sample ? getComputedStyle(sample).color : '',
                        parentText: sample && sample.parentElement ? String(sample.parentElement.textContent || '').slice(0, 40) : '',
                      };
                    } catch (error) { return null; }
                  })(),
                  // chip 裁切探针（2026-10-25 用户报「拖动侧栏宽度时 agent 名显示不全」）：
                  // 逐个量 scrollWidth/clientWidth，超出>1px 即判被裁，并回报最宽的 3 个
                  chipClipping: (() => {
                    try {
                      const chips = [...document.querySelectorAll('[data-slot="sidebar.workspaces"] .hub-chip')];
                      const clipped = [];
                      for (const chip of chips) {
                        const overflow = chip.scrollWidth - chip.clientWidth;
                        const name = (chip.textContent || '').trim().slice(0, 18);
                        if (overflow > 1) clipped.push({ name, overflow });
                      }
                      clipped.sort((a, b) => b.overflow - a.overflow);
                      return { total: chips.length, clippedCount: clipped.length, worst: clipped.slice(0, 3) };
                    } catch (error) { return null; }
                  })(),
                  zoomTarget: (() => {
                    try {
                      const t = typeof sidebarZoomTarget !== 'undefined' ? sidebarZoomTarget : null;
                      if (!t) return null;
                      const r = t.getBoundingClientRect();
                      return {
                        tag: t.tagName,
                        cls: String(t.className || '').slice(0, 60),
                        slot: t.getAttribute('data-slot') || '',
                        w: Math.round(r.width), h: Math.round(r.height),
                        zoom: t.style.zoom || '', width: t.style.width || '',
                      };
                    } catch (error) { return null; }
                  })(),
                  // 侧栏缩放（2026-10-25）：变量值 + 侧栏实际 zoom + 持久化值
                  sidebarZoom: (() => {
                    try {
                      const sidebar = document.querySelector('[data-slot="sidebar"]');
                      return {
                        cssVar: getComputedStyle(document.documentElement).getPropertyValue('--hub-sidebar-zoom').trim(),
                        computed: sidebar ? getComputedStyle(sidebar).zoom : '',
                        stored: window.localStorage.getItem('hub.sidebar.zoom') || '',
                      };
                    } catch (error) { return null; }
                  })(),
                  tokenBgBase: rootRead('--dsw-alias-bg-base'),
                  tokenBrand: rootRead('--dsw-alias-brand-primary'),
                  tokenSidebarFill: rootRead('--dsw-specific-sidebar-fill'),
                  bodyTokenBrand: read('--dsw-alias-brand-primary'),
                  // 扩展覆盖是否真的生效（2026-10-25）：抽查 3 个界面高频变量
                  extraTokens: (() => {
                    try {
                      const names = ['--dsw-alias-link', '--dsw-alias-state-business-primary',
                        '--dsw-alias-label-tertiary', '--dsw-alias-bg-layer-3', '--dsw-focus-ring-color'];
                      const out = {};
                      const cs = getComputedStyle(document.body);
                      const rootCs = getComputedStyle(document.documentElement);
                      for (const n of names) out[n] = (cs.getPropertyValue(n) || rootCs.getPropertyValue(n) || '').trim();
                      return out;
                    } catch (error) { return null; }
                  })(),
                  expectExtra: {
                    link: THEME_TOKENS['--dsw-alias-link'].dark,
                    business: THEME_TOKENS['--dsw-alias-state-business-primary'].dark,
                    tertiary: THEME_TOKENS['--dsw-alias-label-tertiary'].dark,
                  },
                  expect: {
                    bgBase: THEME_TOKENS['--dsw-alias-bg-base'].dark,
                    brand: THEME_TOKENS['--dsw-alias-brand-primary'].dark,
                    sidebarFill: THEME_TOKENS['--dsw-specific-sidebar-fill'].dark,
                  },
                  // 2026-10-26 皮肤审计三件套（用户报「还是没能应用」：发送按钮等仍是默认冷色）：
                  // A. 全部 THEME_TOKENS 期望 vs 实际（token 通道是否真落地）；
                  // B. 冷色元素扫描——遍历可见元素 computed color/background/border/fill/stroke，
                  //    判定蓝/青（b 明显大于 r）或紫（r、b 都明显高于 g），去重后报属性+值+元素身份，
                  //    直接定位「硬编码冷色绕过 token」的组件（不依赖猜选择器）；
                  // C. SKIN_CSS 死规则——逐条统计命中数，命中 0 的列出（DSH 升级类名漂移）。
                  skinAudit: (() => {
                    try {
                      const bodyCs = getComputedStyle(document.body);
                      const rootCs = getComputedStyle(document.documentElement);
                      const readToken = (n) => (bodyCs.getPropertyValue(n) || rootCs.getPropertyValue(n) || '').trim();
                      const tokens = {};
                      for (const [name, pair] of Object.entries(THEME_TOKENS)) {
                        tokens[name] = { expect: pair.dark, actual: readToken(name) };
                      }
                      const rgb = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(String(c)); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
                      const isCold = (c) => {
                        const v = rgb(c); if (!v) return false;
                        const [r, g, b, a] = v; if (a < 0.15) return false;
                        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                        if (mx - mn < 25) return false; // 近灰不算
                        return (b > r + 20) || (r > g + 20 && b > g + 20); // 蓝/青 或 紫
                      };
                      const seen = new Set(); const cold = [];
                      const all = document.querySelectorAll('button, [role="button"], a, svg, input, span, div, path, rect, circle');
                      for (const el of all) {
                        if (cold.length >= 40) break;
                        let cs; try { cs = getComputedStyle(el); } catch (error) { continue; }
                        for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'fill', 'stroke']) {
                          const value = cs[prop];
                          if (!value || value === 'none' || !isCold(value)) continue;
                          const key = prop + '|' + value;
                          if (seen.has(key)) continue;
                          seen.add(key);
                          let ident = el.tagName.toLowerCase();
                          if (el.id) ident += '#' + el.id;
                          if (el.getAttribute('data-slot')) ident += '[slot=' + el.getAttribute('data-slot') + ']';
                          if (el.getAttribute('data-variant')) ident += '[variant=' + el.getAttribute('data-variant') + ']';
                          if (typeof el.className === 'string' && el.className.trim()) ident += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
                          cold.push({ prop, value, el: ident.slice(0, 90), text: String(el.textContent || '').trim().slice(0, 14) });
                        }
                      }
                      const deadRules = [];
                      const skin = document.getElementById(SKIN_STYLE_ID);
                      if (skin && skin.sheet) {
                        for (const rule of skin.sheet.cssRules) {
                          if (!rule.selectorText) continue;
                          let n = -1;
                          try { n = document.querySelectorAll(rule.selectorText).length; } catch (error) { /* 规则本身无效 */ }
                          if (n === 0) deadRules.push(rule.selectorText.slice(0, 90));
                        }
                      }
                      return { tokens, coldCount: cold.length, cold, deadRules: deadRules.slice(0, 30) };
                    } catch (error) { return { error: String((error && error.message) || error) }; }
                  })(),
                  selectorHits: hits,
                  themeMode: root.getAttribute('data-theme') || root.className || '',
                  // 运行栏项目名取色核对（2026-10-23）：pill 里项目名颜色 vs 侧栏项目标题颜色
                  // 必须逐字一致（同 hue 公式）；顺便记录项目色块颜色。
                  projectColors: (() => {
                    try {
                      const out = [];
                      const chips = [...document.querySelectorAll('[data-slot="sidebar.workspaces"] .hub-run-chip')];
                      for (const chip of chips) {
                        const wrap = chip.querySelector('span[title^="所属项目"]');
                        if (!wrap) continue;
                        const textSpan = wrap.querySelector('span:last-child');
                        const swatch = wrap.querySelector('span:first-child');
                        out.push({
                          project: textSpan ? textSpan.textContent : '',
                          pillNameColor: textSpan ? getComputedStyle(textSpan).color : '',
                          pillSwatchBg: swatch ? getComputedStyle(swatch).backgroundColor : '',
                        });
                      }
                      return out;
                    } catch (error) { return []; }
                  })(),
                  sidebarProjectTitles: (() => {
                    try {
                      return [...document.querySelectorAll('[data-slot="sidebar.workspaces"] .hub-proj')]
                        .map((row) => {
                          const spans = [...row.querySelectorAll('span')];
                          const titleSpan = spans.find((s) => s.textContent && s.textContent.trim().length > 1
                            && !/^\d/.test(s.textContent.trim()));
                          return titleSpan ? {
                            project: titleSpan.textContent.trim(),
                            titleColor: getComputedStyle(titleSpan).color,
                          } : null;
                        })
                        .filter(Boolean);
                    } catch (error) { return []; }
                  })(),
                }),
              }).catch(() => {});
            };
            for (const delay of [2500, 20000, 45000, 75000]) setTimeout(sample, delay);
            // 2026-10-26：**按需采样**——Host POST /hub/diag-request → SSE 广播 diag-request →
            // 客户端立刻采一拍上报。用于验收"此刻 DOM 状态"（开机采样早于被测对象出现，
            // 例如刚建的分身 pill）。无轮询、纯事件驱动。
            let diagEs = null;
            try {
              window.__hubSampleSkinDiag = sample;
              diagEs = (typeof EventSource !== 'undefined') ? new EventSource('/hub/events') : null;
              if (diagEs) {
                diagEs.onmessage = (msg) => {
                  try {
                    const data = JSON.parse(msg.data);
                    if (data && data.type === 'diag-request') sample();
                  } catch (error) { /* ignore */ }
                };
              }
            } catch (error) { /* 按需采样失败不影响皮肤 */ }
          } catch (error) { /* 自检失败不影响皮肤 */ }
          return () => {
            el.remove();
            try { delete window.__hubSampleSkinDiag; } catch (error) { /* ignore */ }
            if (diagEs) { try { diagEs.close(); } catch (error) { /* ignore */ } }
          };
        });

        // ②b 侧栏缩放（2026-10-25 用户要求「侧边栏的网页要能缩放」）：
        // 恢复上次缩放；Ctrl/⌘+滚轮在侧栏上 → ±0.1 步进（0.6–2.0）；Ctrl/⌘+0 复位。
        // 监听挂 window 捕获阶段 + closest 判定（侧栏重渲染无需重绑，纯事件驱动）。
        // 开机跑一次**合成事件自检**（派发 ctrl+wheel → 读回 computed zoom → 还原），
        // 结果上报 /hub/client-error，便于在没有人工操作时也能证明链路通。
        ctx.effect(() => {
          applySidebarZoom(readSidebarZoom(), { silent: true });
          const inSidebar = (target) => {
            try {
              return Boolean(target && typeof target.closest === 'function'
                && target.closest('[data-slot="sidebar"]'));
            } catch (error) {
              return false;
            }
          };
          const onWheel = (event) => {
            if (!(event.ctrlKey || event.metaKey)) return; // 普通滚动不动缩放
            if (!inSidebar(event.target)) return;
            event.preventDefault();
            const delta = event.deltaY > 0 ? -SIDEBAR_ZOOM_STEP : SIDEBAR_ZOOM_STEP;
            applySidebarZoom(readSidebarZoom() + delta, { trigger: 'wheel' });
          };
          const onKeyDown = (event) => {
            if (!(event.ctrlKey || event.metaKey)) return;
            if (event.key === '0') {
              applySidebarZoom(1, { trigger: 'key-reset' });
              event.preventDefault();
              return;
            }
            if (event.key === '=' || event.key === '+') {
              applySidebarZoom(readSidebarZoom() + SIDEBAR_ZOOM_STEP, { trigger: 'key-plus' });
              event.preventDefault();
              return;
            }
            if (event.key === '-') {
              applySidebarZoom(readSidebarZoom() - SIDEBAR_ZOOM_STEP, { trigger: 'key-minus' });
              event.preventDefault();
            }
          };
          window.addEventListener('wheel', onWheel, { passive: false, capture: true });
          window.addEventListener('keydown', onKeyDown, { capture: true });

          // 合成事件自检（一次性，延迟 4s 等侧栏挂载）：验证 handler 真的改到 computed zoom，
          // 并做**几何探针**——在 1.0 / 0.7 / 1.4 三档下量侧栏与内部芯片的实际矩形，
          // 判定 CSS zoom 到底有没有改变布局（用户报「值在变但画面不动」时的关键证据）。
          const selfTest = setTimeout(() => {
            try {
              const sidebar = document.querySelector('[data-slot="sidebar"]');
              if (!sidebar) {
                reportSidebarZoom('sidebar-zoom-selftest', { ok: false, reason: 'no-sidebar' });
                return;
              }
              const before = readSidebarZoom();
              const computedBefore = getComputedStyle(sidebar).zoom;
              sidebar.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100,
              }));
              const after = readSidebarZoom();
              const computedAfter = getComputedStyle(sidebar).zoom;
              applySidebarZoom(before, { silent: true });

              // 几何探针：三档量矩形（侧栏 + 第一个芯片/项目行）
              const measureAt = (zoomValue) => {
                // 走真实的 applySidebarZoom（含可见容器内联 zoom），再量矩形
                applySidebarZoom(zoomValue, { silent: true });
                const slot = document.querySelector('[data-slot="sidebar"]');
                const target = sidebarZoomTarget;
                const child = document.querySelector('[data-slot="sidebar.workspaces"] .hub-chip')
                  || document.querySelector('[data-slot="sidebar.workspaces"] .hub-proj')
                  || (target ? target.querySelector('*') : null);
                const box = slot ? slot.getBoundingClientRect() : null;
                const tbox = target ? target.getBoundingClientRect() : null;
                const cbox = child ? child.getBoundingClientRect() : null;
                const cfont = child ? getComputedStyle(child).fontSize : '';
                return {
                  zoomValue,
                  slot: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
                  target: tbox ? { w: Math.round(tbox.width), h: Math.round(tbox.height) } : null,
                  child: cbox ? { w: Math.round(cbox.width), h: Math.round(cbox.height), font: cfont } : null,
                  targetInlineZoom: target ? (target.style.zoom || '') : '',
                };
              };
              const probes = [measureAt(1), measureAt(0.7), measureAt(1.4)];
              // 裁切探针（2026-10-25 用户报「放大后 New project 按钮显示有问题」）：
              // 在 1.4 档量目标容器右缘 vs 内部最宽子元素右缘，overflow>2px 即判裁切
              const clipProbe = (() => {
                try {
                  applySidebarZoom(1.4, { silent: true });
                  const t = sidebarZoomTarget;
                  if (!t) return null;
                  const tr = t.getBoundingClientRect();
                  let maxRight = tr.right;
                  let worst = '';
                  for (const child of t.querySelectorAll('*')) {
                    const rect = child.getBoundingClientRect();
                    if (!rect.width || !rect.height) continue;
                    if (rect.right > maxRight) {
                      maxRight = rect.right;
                      worst = (child.textContent || '').trim().slice(0, 24);
                    }
                  }
                  return { targetRight: Math.round(tr.right), maxChildRight: Math.round(maxRight), overflowPx: Math.round(maxRight - tr.right), worst };
                } catch (error) { return { error: String(error && error.message) }; }
              })();
              applySidebarZoom(before, { silent: true });
              reportSidebarZoom('sidebar-zoom-selftest', {
                ok: after !== before && computedAfter !== computedBefore,
                before, after, computedBefore, computedAfter,
                restored: readSidebarZoom(),
                probes,
                clipProbe,
                probeWorks: probes[0] && probes[2]
                  ? probes[0].child && probes[2].child
                    && Math.abs(probes[2].child.h - probes[0].child.h) >= 2
                  : null,
              });
            } catch (error) {
              reportSidebarZoom('sidebar-zoom-selftest', { ok: false, reason: String(error && error.message) });
            }
          }, 4000);

          return () => {
            clearTimeout(selfTest);
            window.removeEventListener('wheel', onWheel, { capture: true });
            window.removeEventListener('keydown', onKeyDown, { capture: true });
          };
        });

        // ②c 非视觉模型发图（2026-10-26 用户令「非视觉模型的时候图根本发不出去」）：
        // DSH 在**发送框**就拒绝（"The current model does not support images"），图根本
        // 进不了会话；API 侧也真的不认（glm-5.3 直接 1210 content.type 只允许 text）。
        // 做法：粘贴/拖入时先查该会话模型能力（/hub/session-capability，Host 从
        // request/header 解析）——
        //   支持图像 → 什么都不做，走 DSH 原生附件（视觉模型完全不受影响）；
        //   不支持   → **捕获阶段拦下**，图 POST /hub/upload 落盘，把
        //              `[图片: <路径>]` 写进输入框（用户还能继续打字），agent 收到后
        //              用 vision_read 看图。这样不再出现那条拒绝提示。
        ctx.effect(() => {
          const capability = new Map(); // sessionId -> { at, supportsImage }
          const failedAt = new Map();   // sessionId -> 上次查询失败时间（5s 退避，不永久拉黑）

          const report = (stage, payload) => {
            try {
              fetch('/hub/client-error', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind: 'vision-intercept', stage, at: new Date().toISOString(), ...payload }),
              }).catch(() => {});
            } catch (error) { /* ignore */ }
          };

          const currentSessionId = () => {
            const el = document.querySelector('[data-conversation-session]');
            return el ? el.getAttribute('data-conversation-session') : null;
          };

          const refreshCapability = async (sessionId) => {
            if (!sessionId) return null;
            const fail = failedAt.get(sessionId);
            if (fail && Date.now() - fail < 5000) return null;
            try {
              const res = await fetch(`/hub/session-capability?session=${encodeURIComponent(sessionId)}`);
              const data = await res.json();
              if (data && data.ok) {
                const value = { at: Date.now(), supportsImage: data.supportsImage !== false, model: data.model };
                capability.set(sessionId, value);
                failedAt.delete(sessionId);
                return value;
              }
              failedAt.set(sessionId, Date.now());
            } catch (error) {
              failedAt.set(sessionId, Date.now());
            }
            return null;
          };

          const entryOf = async (sessionId) => {
            if (!sessionId) return null;
            const hit = capability.get(sessionId);
            if (hit && Date.now() - hit.at < 60000) return hit;
            return refreshCapability(sessionId);
          };

          /** 把文本写进当前聚焦的输入框（React 受控组件要用原生 setter + input 事件）。 */
          const insertIntoComposer = (text) => {
            const el = document.activeElement;
            if (!el) return false;
            const tag = (el.tagName || '').toLowerCase();
            try {
              if (tag === 'textarea' || tag === 'input') {
                const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                if (!setter) return false;
                const next = el.value ? `${el.value}${el.value.endsWith('\n') ? '' : '\n'}${text}` : text;
                setter.call(el, next);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.focus();
                return true;
              }
              if (el.isContentEditable) {
                document.execCommand('insertText', false, text);
                return true;
              }
            } catch (error) { /* ignore */ }
            return false;
          };

          const uploadFiles = async (files) => {
            const paths = [];
            for (const file of files) {
              try {
                const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
                const res = await fetch(`/hub/upload?ext=${encodeURIComponent(ext)}`, { method: 'POST', body: file });
                const data = await res.json();
                if (data && data.ok && data.path) paths.push(data.path);
              } catch (error) { /* 单张失败继续 */ }
            }
            return paths;
          };

          // 原生被拒时的兜底暂存（2026-10-26）：能力未知时先放行原生，
          // 若 DSH 弹出「不支持图像」提示，再把这些图转成路径文本投递。
          let stash = []; // [{ file, at }]
          const REFUSAL_RE = /does not support images|不支持图像|switch to a model that does/i;

          /**
           * 自动点掉输入框上挂着的待发图片附件（2026-10-26 用户要求"优雅一点"）。
           * 场景：非视觉模型粘贴 → DSH 把图挂成待发附件但发送时拒绝；我们转成路径后，
           * 那个发不出去的图还挂着，得手动删。这里找它的"移除"按钮替用户点掉。
           * 匹配两级：①aria-label/title 命中 i18n 的 image.remove（移除图片/Remove image）；
           * ②按钮文本是纯 ✕/× 且 40px 内有 <img> 缩略图（附件 chip 的关闭钮）。
           */
          const removePendingImageChips = () => {
            let removed = 0;
            const clicked = [];
            try {
              const nearImg = (btn) => {
                const rect = btn.getBoundingClientRect();
                return [...document.querySelectorAll('img')].some((img) => {
                  const r = img.getBoundingClientRect();
                  if (!r.width || !r.height) return false;
                  const dx = Math.max(rect.left - r.right, r.left - rect.right, 0);
                  const dy = Math.max(rect.top - r.bottom, r.top - rect.bottom, 0);
                  return dx <= 40 && dy <= 20;
                });
              };
              for (const btn of document.querySelectorAll('button, [role="button"]')) {
                if (!btn.isConnected || btn.offsetParent === null) continue;
                const label = `${btn.getAttribute('aria-label') || ''} ${btn.title || ''}`.trim();
                const text = (btn.textContent || '').trim();
                const isRemoveLabel = /移除图片|移除文件|删除图片|删除文件|remove (the )?image|remove (the )?file|移除附件|删除附件/i.test(label);
                const isBareX = /^[✕×x✖]$/i.test(text) && nearImg(btn);
                if (isRemoveLabel || isBareX) {
                  clicked.push(label || '×');
                  btn.click();
                  removed += 1;
                  if (removed >= 6) break;
                }
              }
            } catch (error) { /* ignore */ }
            if (removed) report('chips-removed', { removed, clicked });
            return removed;
          };

          const convertToPaths = async (files, sessionId) => {
            const paths = await uploadFiles(files);
            if (paths.length === 0) {
              report('upload-failed', { sessionId, files: files.length });
              return false;
            }
            const text = paths.map((path) => `[图片: ${path}]`).join('\n');
            const inserted = insertIntoComposer(text);
            report(inserted ? 'inserted' : 'direct-send', { sessionId, paths: paths.length });
            if (inserted) {
              // 路径已进输入框 → 把挂着的原图片附件点掉（否则发送仍会被拒）
              setTimeout(() => removePendingImageChips(), 250);
            }
            if (!inserted) {
              // 拿不到输入框就退化成直接投递（Host 排一条 prompt 给该会话）
              for (const path of paths) {
                try {
                  await fetch('/hub/vision-send', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId, path }),
                  });
                } catch (error) { /* ignore */ }
              }
            }
            return true;
          };

          const handleImageEvent = (event) => {
            const dt = event.clipboardData || event.dataTransfer;
            if (!dt) return;
            // files 与 items 两条路都取（截图粘贴有时只在 items 里）
            const files = [];
            for (const file of Array.from(dt.files || [])) {
              if (file && typeof file.type === 'string' && file.type.startsWith('image/')) files.push(file);
            }
            if (!files.length && dt.items) {
              for (const item of Array.from(dt.items)) {
                if (item && item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/')) {
                  const file = item.getAsFile && item.getAsFile();
                  if (file) files.push(file);
                }
              }
            }
            if (!files.length) return;
            const sessionId = currentSessionId();
            const entry = sessionId ? capability.get(sessionId) : null;
            // 2026-10-26 定稿：**绝不主动拦截**——能力缓存会过期（会话切换模型后旧缓存
            // 还写着"不支持"，视觉模型被误转路径就是这来的）。一律放行原生：
            //   视觉模型 → 原生成图（拒绝提示根本不会出现，兜底不触发）；
            //   非视觉模型 → DSH 弹"不支持图像"提示 → refusalObserver 把暂存图/剪贴板图
            //              转成路径。只多闪一下提示，不会失败。
            stash = files.slice(0, 6).map((file) => ({ file, at: Date.now() }));
            report('pass-native', {
              sessionId,
              cached: entry ? (entry.supportsImage ? 'image' : 'no-image') : 'unknown',
              files: files.length,
            });
            if (sessionId && (!entry || Date.now() - entry.at > 15000)) refreshCapability(sessionId);
          };

          // 记录每一次 paste/drop（诊断：查明 DSH 是否截走了事件 / files 是否为空）
          const observeRawEvent = (event) => {
            const dt = event.clipboardData || event.dataTransfer;
            const n = dt && dt.files ? dt.files.length : -1;
            const ni = dt && dt.items ? dt.items.length : -1;
            report('raw-event', { type: event.type, files: n, items: ni });
          };
          window.addEventListener('paste', observeRawEvent, true);
          window.addEventListener('drop', observeRawEvent, true);

          window.addEventListener('paste', handleImageEvent, true);
          window.addEventListener('drop', handleImageEvent, true);

          /** 从系统剪贴板抢图（拒绝提示出现但没收到 paste 事件时的兜底）。 */
          const clipboardImageFiles = async () => {
            try {
              if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return [];
              const items = await navigator.clipboard.read();
              const files = [];
              for (const item of items || []) {
                const type = (item.types || []).find((t) => String(t).startsWith('image/'));
                if (!type) continue;
                const blob = await item.getType(type);
                const name = `clipboard-${Date.now()}.${String(type).split('/')[1] || 'png'}`;
                files.push(new File([blob], name, { type: String(type) }));
              }
              return files.slice(0, 6);
            } catch (error) {
              report('clipboard-read-failed', { error: String(error && error.message).slice(0, 120) });
              return [];
            }
          };

          // 原生拒绝兜底：出现"不支持图像"提示时转路径——优先用暂存的图，
          // 没有暂存（paste 事件被 DSH 截走）就从剪贴板抢。
          // 2026-10-26 修误伤视觉会话：①只认 toast 形态短文本（<200 字）且不在会话
          // 正文区（聊天消息里出现"不支持图像"字样不再触发）；②视觉会话（确认支持图）
          // 绝不抢；③3 秒冷却防同一条提示重复插两次。
          let recovering = false;
          let lastRecoveryAt = 0;
          const refusalObserver = new MutationObserver((records) => {
            let hit = null;
            for (const record of records) {
              for (const node of record.addedNodes || []) {
                if (!node || node.nodeType !== 1) continue;
                const text = node.textContent || '';
                if (!text || text.length > 200) continue;
                if (!REFUSAL_RE.test(text.slice(0, 400))) continue;
                if (typeof node.closest === 'function'
                  && node.closest('[data-conversation-content], [data-conversation-session]')) continue;
                hit = node;
                break;
              }
              if (hit) break;
            }
            if (!hit || recovering) return;
            if (Date.now() - lastRecoveryAt < 3000) return;
            const sessionId = currentSessionId();
            const entry = sessionId ? capability.get(sessionId) : null;
            if (entry && entry.supportsImage) {
              report('refusal-skipped-vision', { sessionId, model: entry.model });
              return;
            }
            if (stash.length && Date.now() - stash[stash.length - 1].at > 30000) { stash = []; }
            recovering = true;
            lastRecoveryAt = Date.now();
            (async () => {
              try {
                let files = stash.map((item) => item.file);
                stash = [];
                let via = 'stash';
                if (!files.length) {
                  files = await clipboardImageFiles();
                  via = files.length ? 'clipboard' : 'none';
                }
                report('refusal-fallback', {
                  sessionId, files: files.length, via,
                  capability: entry ? 'no-image' : 'unknown',
                });
                if (files.length) await convertToPaths(files, sessionId);
              } finally {
                recovering = false;
              }
            })();
          });
          refusalObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

          // 预热能力位：会话切换 / 点进输入框 / Ctrl+V 按下（比 paste 事件早 ~100ms）触发
          const warm = () => { const id = currentSessionId(); if (id) refreshCapability(id); };
          const onKeydown = (event) => {
            if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'v') warm();
          };
          window.addEventListener('focusin', warm, true);
          window.addEventListener('keydown', onKeydown, true);
          const mo = new MutationObserver(() => warm());
          mo.observe(document.body, { attributes: true, attributeFilter: ['data-conversation-session'], subtree: true });
          warm();

          return () => {
            window.removeEventListener('paste', observeRawEvent, true);
            window.removeEventListener('drop', observeRawEvent, true);
            window.removeEventListener('paste', handleImageEvent, true);
            window.removeEventListener('drop', handleImageEvent, true);
            window.removeEventListener('focusin', warm, true);
            window.removeEventListener('keydown', onKeydown, true);
            mo.disconnect();
            refusalObserver.disconnect();
          };
        });

        // ②e 会话标题里的**项目名上色**（2026-10-26 用户要求；2026-10-27 二版）：
        // DSH 顶部标题是纯文本（.crumbCurrent，children = displayTitle），没有 title slot。
        // 一版用「linear-gradient + background-clip:text」按测量分界上色——**用户否了**
        // （渐变分界处有残边、`color:transparent` 让部分字形渲染出半字白边）。
        // 二版改为**直接字体着色（拆 span）**：把「项目 · 成员」拆成
        // `<span data-hub-proj=1 style="color:hsl(hue 50% 68%)">项目</span>` + 尾部文本节点，
        // 逐字干净、无渐变、无透明色副作用。React 重渲染若把内容还原成纯文本，
        // MutationObserver（200ms 防抖）重新拆一次；tintOne 幂等（结构没变只刷色相）。
        ctx.effect(() => {
          const CACHE = new WeakMap(); // el -> { text }
          // 会话标题头像（2026-11-02 用户要求）：标题前显示 agent 头像 emoji。
          // 与侧栏 chip 同一套来源：/hub/avatars 全局表优先，DEFAULT_AVATARS 兜底；
          // 分身（角色名带「｜」）继承父名头像，与 chipAvatarFor 同规则。
          let avatarTable = {};
          const loadAvatars = () => {
            try {
              fetch('/hub/avatars')
                .then((res) => res.json())
                .then((value) => { if (value && typeof value === 'object') avatarTable = value; })
                .catch(() => { /* 用兜底表 */ });
            } catch (error) { /* ignore */ }
          };
          loadAvatars();
          // 头像可能被用户改（.hub/avatars.json）——窗口重新聚焦时重拉一次，成本极低
          const onFocusAvatars = () => loadAvatars();
          window.addEventListener('focus', onFocusAvatars);
          const avatarForRole = (role) => {
            const base = String(role || '').split('｜')[0].trim();
            return avatarTable[role] || avatarTable[base] || DEFAULT_AVATARS[role] || DEFAULT_AVATARS[base] || '';
          };
          const tintOne = (el) => {
            try {
              // ⚠ 关键（2026-11-02 修「标题前堆出 25 个 🛠️」）：**不能直接用 el.textContent 当基准**。
              // 我们插进去的头像 emoji 也是文本节点，textContent 会把它算进 project →
              // 「🛠️应用开发」→ 下一轮「🛠️🛠️应用开发」→ 幂等永不成立、每轮多粘一个 emoji。
              // 正解：拼「排除自插节点后的原始文本」（hubProj span 的内容要算回去，它是项目名本身）。
              const pureText = () => {
                let out = '';
                for (const node of el.childNodes) {
                  if (node.nodeType === 1 && node.dataset) {
                    if (node.dataset.hubAvatar === '1') continue;           // 我们插的头像，跳过
                    if (node.dataset.hubProj === '1') { out += node.textContent; continue; } // 项目名要还原
                  }
                  out += node.textContent || '';
                }
                return out;
              };
              const text = String(pureText() || '');
              if (!text.includes(' · ') || text.length > 80) return;
              // 只处理叶子元素：若内部还有真实元素子节点（不是我们插的两个标记），说明是容器，
              // 清空它会把 React 管理的节点一起删掉 → 跳过，交给里面的叶子处理。
              for (const node of el.childNodes) {
                if (node.nodeType !== 1 || !node.dataset) continue;
                if (node.dataset.hubAvatar === '1' || node.dataset.hubProj === '1') continue;
                return;
              }
              const barAt = text.indexOf(' · ');
              const project = text.slice(0, barAt).trim();
              if (!project) return;
              const rest = text.slice(barAt); // 含「 · 成员」
              const role = rest.replace(/^\s*·\s*/, '').trim();
              const emoji = avatarForRole(role);
              const hue = uniqueHue(project);
              const color = `hsl(${hue} 50% 68%)`;
              // 幂等：结构已是我们生成的样子（[avatar][proj][「 · 角色」文本]）→ 只刷新色相/头像
              const kids = el.childNodes;
              const projSpan = (kids[0] && kids[0].nodeType === 1 && kids[0].dataset && kids[0].dataset.hubProj === '1')
                ? kids[0]
                : (kids[1] && kids[1].nodeType === 1 && kids[1].dataset && kids[1].dataset.hubProj === '1' ? kids[1] : null);
              if (projSpan) {
                const tail = el.lastChild;
                const avSpan = projSpan.previousSibling;
                const avOk = !emoji
                  ? !(avSpan && avSpan.nodeType === 1 && avSpan.dataset && avSpan.dataset.hubAvatar === '1')
                  : (avSpan && avSpan.nodeType === 1 && avSpan.dataset && avSpan.dataset.hubAvatar === '1'
                    && avSpan.textContent === emoji);
                if (tail && tail.nodeType === 3 && tail.textContent === rest
                  && projSpan.textContent === project && avOk) {
                  projSpan.style.color = color;
                  CACHE.set(el, { text });
                  return;
                }
                // 结构被部分改动 → 落下去整体重拆
              }
              const span = document.createElement('span');
              span.dataset.hubProj = '1';
              span.style.color = color;
              span.textContent = project;
              el.textContent = '';
              if (emoji) {
                const av = document.createElement('span');
                av.dataset.hubAvatar = '1';
                av.textContent = emoji;
                av.style.marginRight = '4px';
                av.style.fontSize = '13px';
                av.style.lineHeight = '1';
                el.appendChild(av);
              }
              el.appendChild(span);
              el.appendChild(document.createTextNode(rest));
              CACHE.set(el, { text });
            } catch (error) { /* ignore */ }
          };
          const tintAll = () => {
            try {
              const root = document.querySelector('[data-slot="conversation.session.header"]') || document.body;
              for (const el of root.querySelectorAll('span, button')) {
                const text = String(el.textContent || '');
                if (!text.includes(' · ') || text.length > 80) continue;
                tintOne(el);
              }
            } catch (error) { /* ignore */ }
          };
          let debounce = null;
          const observer = new MutationObserver(() => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(tintAll, 200);
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          const first = setTimeout(tintAll, 1200);
          return () => {
            if (debounce) clearTimeout(debounce);
            clearTimeout(first);
            observer.disconnect();
            window.removeEventListener('focus', onFocusAvatars);
          };
        });

        // ②a 思考块默认自动展开：reasoning 折叠行（[data-variant="think"]）没有内置
        // 「默认展开」设置，且折叠时 body 是条件渲染、CSS 无解——唯一可行是模拟点击
        // 折叠头。这里用一个常驻 MutationObserver 监听会话流容器（apply 时容器可能
        // 还没挂出来，先轻量轮询找到再 observe），300ms 防抖批量处理；每个折叠行只
        // 点一次（WeakSet 记账），已展开的（带 data-expanded）天然被选择器排除。
        ctx.effect(() => {
          const findFlow = () => document.querySelector('[data-slot="conversation.chat.flow"]');
          let observer = null;
          let debounce = null;
          let poll = null;
          const clicked = new WeakSet();
          const expandAll = (root) => {
            for (const row of root.querySelectorAll('[data-variant="think"]:not([data-expanded])')) {
              if (clicked.has(row)) continue;
              clicked.add(row);
              const header = row.querySelector('[data-disclosure-header]');
              if (header) header.click();
            }
          };
          const schedule = () => {
            if (debounce) return;
            debounce = setTimeout(() => {
              debounce = null;
              const flow = findFlow();
              if (flow) expandAll(flow);
            }, 300);
          };
          const stop = () => {
            if (debounce) { clearTimeout(debounce); debounce = null; }
            if (poll) { clearInterval(poll); poll = null; }
            if (observer) { observer.disconnect(); observer = null; }
          };
          // 会话切换时 flow 容器会被换掉：observe 它的父级更稳；父级也拿不到就先轮询
          const attach = () => {
            const flow = findFlow();
            if (!flow) {
              poll = setInterval(() => {
                const again = findFlow();
                if (again) { clearInterval(poll); poll = null; attach(); }
              }, 1000);
              return;
            }
            const host = flow.parentElement || flow;
            // ②a 思考块（reasoning）：只关心节点增删 → 用本 effect 自己的 schedule（防抖批量点开）
            observer = new MutationObserver(schedule);
            observer.observe(host, { childList: true, subtree: true });
            expandAll(flow);
          };
          attach();
          return stop;
        }, 'hub-desktop-ui: auto-expand reasoning');

        // ②a2 轮次过程壳默认展开：DSH 聊天把每轮的 thinking+工具步骤+正文收进
        // turn-process 折叠壳（「Completed in Ns ⌄」头），原生行为是收到下一条输入
        // 后旧轮全部自动折叠、且无任何设置项——用户反馈「回复结果老是被折叠」即此。
        // 与 ②a 同款常驻 MutationObserver，但记账逻辑不同：原生「下一轮输入自动折回
        // 旧轮」不触发 click 事件，用户手动收起才触发。所以用捕获阶段 click 监听记
        // 「用户手动收起过」（manual WeakSet）——程序自动折回的一律重新点开，用户
        // 手动收起的永不顶回；我们自己的合成 click 用 synthetic 标志排除。
        ctx.effect(() => {
          const findFlow = () => document.querySelector('[data-slot="conversation.chat.flow"]');
          let observer = null;
          let debounce = null;
          let poll = null;
          let synthetic = false;
          const manual = new WeakSet();
          const onUserClick = (event) => {
            if (synthetic) return;
            const btn = event.target && event.target.closest
              ? event.target.closest('button[data-turn-process]')
              : null;
            if (btn && btn.getAttribute('aria-expanded') === 'false') manual.add(btn);
          };
          const expandAll = (root) => {
            let n = 0;
            let remaining = 0;
            for (const btn of root.querySelectorAll(
              'button[data-turn-process][aria-expanded="false"]:not([disabled])',
            )) {
              if (manual.has(btn)) continue;
              remaining += 1;
              synthetic = true;
              try { btn.click(); n += 1; } finally { synthetic = false; }
            }
            // 诊断计数（2026-10-27：用户仍看到折叠，靠它确认是"没触发"还是"触发后被折回"）
            window.__hubTurnExpand = window.__hubTurnExpand || { clicks: 0, passes: 0, lastAt: 0 };
            if (n > 0) {
              window.__hubTurnExpand.clicks += n;
              window.__hubTurnExpand.lastAt = Date.now();
            }
            window.__hubTurnExpand.passes = (window.__hubTurnExpand.passes || 0) + 1;
            window.__hubTurnExpand.lastRemaining = remaining;
            // 2026-10-27 二修：click 确实触发了（诊断见 clicks>0）却仍有折叠——说明点了又被折回
            // （旧轮在"下一轮输入"后被重置为折叠，用户选择的持久键按 turn 身份记，React 重挂后失效）。
            // 加有界重试（每次 600ms、最多 5 轮），期间 aria-expanded 变化也会再次触发，形成自愈；
            // 用户手动收起的仍被 manual WeakSet 挡住，不会被顶开。
            if (remaining > 0 && (window.__hubTurnExpand.retries || 0) < 5) {
              window.__hubTurnExpand.retries = (window.__hubTurnExpand.retries || 0) + 1;
              setTimeout(() => {
                const flow = findFlow();
                if (flow) expandAll(flow);
              }, 600);
            } else if (remaining === 0) {
              window.__hubTurnExpand.retries = 0;
            }
          };
          const schedule = () => {
            if (debounce) return;
            debounce = setTimeout(() => {
              debounce = null;
              const flow = findFlow();
              if (flow) expandAll(flow);
            }, 120);
          };
          // 2026-10-27 三修（用户：能不能默认就不折叠）：DSH 内核没有这个开关（settings 无 fold 键，
          // turnProcessOpen 只认"读者选择"），所以把重展开做成**用户看不见**：
          // 属性变化（DSH 把某轮 aria-expanded 改 false = 折叠）→ 在 MutationObserver 回调里**同步**
          // 重新点开——MO 回调在浏览器绘制前执行，折叠状态来不及上屏，等价于"默认不折叠"；
          // childList 变化（新轮/重挂）仍走 120ms 防抖，避免连续渲染抖动。
          const onMutations = (records) => {
            const attributeOnly = records.every((record) => record.type === 'attributes');
            if (attributeOnly) {
              // 2026-10-27 四修：折叠头可能在 flow 以外（分身列/群聊泳道/其它视图都渲染
              // conversation 内容，diag 实测 collapsed=1 长期不动 = 该按钮不在 flow 里）。
              // 属性变化直接扫全文档（选择器足够特异，成本可忽略）。
              expandAll(document);
              return;
            }
            schedule();
          };
          const stop = () => {
            if (debounce) { clearTimeout(debounce); debounce = null; }
            if (poll) { clearInterval(poll); poll = null; }
            if (observer) { observer.disconnect(); observer = null; }
            document.removeEventListener('click', onUserClick, true);
          };
          // 2026-10-27 四修：观察 **document.body**（不再只盯 flow 父级）——覆盖所有渲染
          // conversation 的容器；flow 可能整个被换掉，body 不会。
          const attach = () => {
            observer = new MutationObserver(onMutations);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['aria-expanded', 'data-open'],
            });
            document.addEventListener('click', onUserClick, true);
            expandAll(document);
          };
          attach();
          return stop;
        }, 'hub-desktop-ui: auto-expand turn-process');

        // ②c 图片点击放大（lightbox）：document 级委托监听，覆盖两类视图——
        //   ① DSH 聊天会话流里渲染的 markdown 图片 / 附件卡片图（原生 conversation）；
        //   ② 本插件群聊任务线 renderInline 渲染的 ![alt](path) 图片。
        // 放大层：半透明黑遮罩 + 视口自适应居中大图；Esc / 点击背景关闭；
        // 滚轮缩放、双击在 1x/2x 间切换（加分项）。不劫持 <a> 内的图和过小的图标。
        ctx.effect(() => {
          const LIGHTBOX_ID = 'hub-image-lightbox';
          const isZoomableImage = (img) => {
            if (!img || img.tagName !== 'IMG') return false;
            if (img.closest(`#${LIGHTBOX_ID}`)) return false;      // 放大层自身的大图
            if (img.closest('a')) return false;                    // 链接内的图：保留链接行为
            const src = String(img.getAttribute('src') || '');
            if (!/^(https?:|blob:|data:image\/|api\/file\?)/i.test(src)) return false;
            // 过滤图标/头像级小图：自然尺寸或渲染尺寸够大才算内容图
            const natural = img.naturalWidth || img.naturalHeight || 0;
            const rendered = img.offsetWidth || img.offsetHeight || 0;
            return natural >= 200 || rendered >= 160;
          };
          let overlay = null;
          const onKey = (event) => {
            if (event.key === 'Escape') { event.stopPropagation(); close(); }
          };
          const close = () => {
            if (overlay) { overlay.remove(); overlay = null; }
            document.removeEventListener('keydown', onKey, true);
          };
          const applyScale = (bigImg, scale) => {
            bigImg.style.transform = `scale(${scale})`;
            bigImg.style.cursor = scale > 1 ? 'zoom-out' : 'zoom-in';
          };
          const open = (img) => {
            close();
            overlay = document.createElement('div');
            overlay.id = LIGHTBOX_ID;
            overlay.style.cssText = [
              'position:fixed', 'inset:0', 'z-index:9999',
              'display:flex', 'align-items:center', 'justify-content:center',
              'background:rgba(0,0,0,0.82)', 'cursor:zoom-out',
            ].join(';');
            const bigImg = document.createElement('img');
            bigImg.src = img.src;
            bigImg.alt = img.alt || '';
            bigImg.style.cssText = [
              'max-width:92vw', 'max-height:92vh',
              'object-fit:contain', 'border-radius:6px',
              'transform-origin:center center', 'transition:transform 80ms ease',
              'cursor:zoom-in', 'user-select:none',
              'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
            ].join(';');
            let scale = 1;
            const clamp = (v) => Math.min(6, Math.max(0.25, v));
            const zoom = (delta) => { scale = clamp(scale * delta); applyScale(bigImg, scale); };
            overlay.addEventListener('wheel', (event) => {
              event.preventDefault();
              zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
            }, { passive: false });
            bigImg.addEventListener('dblclick', (event) => {
              event.stopPropagation();
              scale = scale >= 2 ? 1 : 2;
              applyScale(bigImg, scale);
            });
            bigImg.addEventListener('click', (event) => event.stopPropagation());
            overlay.appendChild(bigImg);
            overlay.addEventListener('click', close);
            document.body.appendChild(overlay);
            document.addEventListener('keydown', onKey, true);
          };
          const onClick = (event) => {
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;
            const img = target.closest('img');
            if (!img || !isZoomableImage(img)) return;
            event.preventDefault();
            event.stopPropagation();
            open(img);
          };
          document.addEventListener('click', onClick, true);
          return () => {
            document.removeEventListener('click', onClick, true);
            close();
          };
        }, 'hub-desktop-ui: image lightbox');

        // ②d 切换会话自动贴底（2026-10-27 用户报「切换 agent 对话不自动显示最下面，
        // 每次都要手动滚下去」）。DSH 原生在切换会话时保留/重置滚动位置到顶部，
        // 这里补一层：会话 id 变化 → 把原生滚动容器拉到底；内容异步加载，故做几次重试，
        // 用户一旦手动往上滚（wheel/触摸/scroll 距底 >48px）立刻停手，不跟用户抢。
        ctx.effect(() => {
          const SCROLL_SEL = '[data-conversation-scroll]';
          const CONTENT_SEL = '[data-conversation-content]';
          let current = null;
          let timers = [];
          let mo = null;
          let userStopped = false;
          // 2026-10-27 二修：记录最近一次"程序化滚动"的元素与时间——scrollTop 赋值也会派发
          // scroll 事件，内容异步撑高时中间态 distance 可能 >48，会被误判成用户上滚而停止贴底。
          const lastProgrammatic = { el: null, at: 0 };

          // 缓存滚动容器：七修的 MO 同步贴底会在每次 DOM 变化时调用，每次都全文档扫描太贵。
          let cachedScrollEl = null;
          const scrollEl = () => {
            if (cachedScrollEl && cachedScrollEl.isConnected
              && cachedScrollEl.scrollHeight > cachedScrollEl.clientHeight + 8) {
              return cachedScrollEl;
            }
            cachedScrollEl = null;
            const content = document.querySelector(CONTENT_SEL);
            if (!content) return null;
            // 2026-10-27 二修（用户：「切换对话还是没有自动贴底」）：不再猜 `[data-conversation-scroll]`
            // （该属性在本版本 DOM 里不存在 → 退化成 content 的 firstChild，经常不是滚动容器）。
            // 改为**按计算样式自动识别**：content 自身 → 后代第一个可滚元素 → 祖先最近的可滚容器。
            const isScrollable = (el) => {
              if (!el || !el.scrollHeight) return false;
              let oy = '';
              try { oy = getComputedStyle(el).overflowY; } catch (error) { return false; }
              return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 8;
            };
            const found = (() => {
              if (isScrollable(content)) return content;
              for (const el of content.querySelectorAll('*')) {
                if (isScrollable(el)) return el;
              }
              let parent = content.parentElement;
              for (let i = 0; parent && i < 5; i += 1) {
                if (isScrollable(parent)) return parent;
                parent = parent.parentElement;
              }
              return null;
            })();
            cachedScrollEl = found;
            return found;
          };

          const toBottom = () => {
            if (userStopped) return;
            const el = scrollEl();
            // 诊断（2026-10-27）：让 diag 看到「找到的滚动容器是谁、拉到底后位置」，
            // 下次再报"没贴底"可直接判定是没找到容器、还是被 userStopped 挡住。
            window.__hubScrollDiag = {
              at: Date.now(),
              userStopped: Boolean(userStopped),
              found: Boolean(el),
              tag: el ? el.tagName.toLowerCase() : '',
              cls: el ? String(el.className || '').slice(0, 60) : '',
              scrollTop: el ? Math.round(el.scrollTop) : -1,
              scrollHeight: el ? el.scrollHeight : -1,
              clientHeight: el ? el.clientHeight : -1,
            };
            if (!el) return;
            lastProgrammatic.el = el;
            lastProgrammatic.at = Date.now();
            el.scrollTop = el.scrollHeight;
            const distance = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
            window.__hubScrollDiag.afterTop = Math.round(el.scrollTop);
            window.__hubScrollDiag.distance = distance;
            // 四修：不再"一贴底就显示"（内容分批挂载会二次顶高 → 仍闪），交给 maybeReveal 判高度稳定
            maybeReveal(el);
          };

          const clearTimers = () => {
            for (const t of timers) clearTimeout(t);
            timers = [];
          };

          const stick = () => {
            clearTimers();
            userStopped = false;
            toBottom();
            // 内容/图片/折叠块异步撑高：多点重试（累计约 1.6s 后放弃）
            for (const delay of [60, 180, 420, 900, 1400, 1800]) {
              timers.push(setTimeout(toBottom, delay));
            }
          };

          const readSession = () => {
            const el = document.querySelector(`${CONTENT_SEL}[data-conversation-session]`)
              || document.querySelector(CONTENT_SEL);
            return el ? (el.getAttribute('data-conversation-session') || '') : '';
          };

          // 2026-10-27 三修（用户：贴底好了但每次切对话"闪一下"，问"能不能直接渲染在底部"）：
          // DSH 内核的初始滚动位置在它自己的组件里（外部改不了），所以做**等效**：
          // 切换发生时在 MutationObserver 回调里（**浏览器绘制前**）给 <html> 打 `data-hub-stick-switch`，
          // CSS 用它把会话内容区 visibility:hidden；等贴底成功（distance≈1）或最多 600ms 兜底后撤标记。
          // 用户看到的就是"新会话直接出现在底部"，没有"顶部闪一下再跳下去"。
          const SWITCH_ATTR = 'data-hub-stick-switch';
          let revealTimer = null;
          const setSwitching = (on) => {
            try {
              if (on) document.documentElement.setAttribute(SWITCH_ATTR, '1');
              else document.documentElement.removeAttribute(SWITCH_ATTR);
            } catch (error) { /* ignore */ }
          };
          const reveal = () => {
            if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
            if (switchAt) {
              // 诊断：记录本次切换的实际黑屏时长（ms），便于按数据调阈值
              window.__hubSwitchDebug = { hiddenMs: Date.now() - switchAt, at: Date.now() };
            }
            switchAt = 0;
            lastHeight = -1;
            stableCount = 0;
            setSwitching(false);
          };
          // 2026-10-27 四修（用户："切换对话还是会闪"）：三修的显示条件太早——新会话内容是
          // **分批挂载**的，第一次贴底时内容还短（distance 天然 =0），一显示后续内容再把高度顶高，
          // 于是又跳一次 → 仍然闪。改为**高度稳定后再显示**：连续两次采样 scrollHeight 不变且
          // distance<=1 才撤隐藏；同时最小隐藏 180ms（避开首帧空白感）、最大 900ms 强制显示。
          let switchAt = 0;
          let lastHeight = -1;
          let stableCount = 0;
          // 2026-10-27 六修（用户："切换太慢了，要黑屏好久才显示"）：五修把"抖动"真凶（空 id）修掉后，
          // 四修那套"高度连续两次稳定 + ≥180ms"就太保守了（叠加 60/180/420… 的重试，最长空窗接近 900ms）。
          // 改为**贴底即显示**：distance<=1 且距切换 ≥60ms（至少跨一帧）→ 两帧后显示；兜底 900→400ms。
          // 内容后续再撑高由 stick() 的重试继续贴底，那时已可见，不会再黑屏。
          function maybeReveal(el) {
            if (!switchAt) return;
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            const elapsed = Date.now() - switchAt;
            if (distance <= 1 && elapsed >= 60) {
              requestAnimationFrame(() => requestAnimationFrame(reveal));
            }
          }
          const armSafetyReveal = () => {
            if (revealTimer) clearTimeout(revealTimer);
            // 2026-10-27 十四修（用户拍板方案②）：兜底同步放宽到 700ms，
            // 否则 400ms 兜底会先于「落稳判据」触发 → 又变成"撤早了"。
            revealTimer = setTimeout(reveal, 900); // 与 HIDE_MAX_MS 一致
          };

          const onAttr = () => {
            const id = readSession();
            // 2026-10-27 五修（关键）：React 重渲染窗口里 readSession 可能读到空串（属性暂缺），
            // 若把它当成"会话变了"→ 隐藏/显示来回抖，**这本身就是闪的来源**
            // （diag 实测 switching 在 True/False 间反复跳）。空 id 一律忽略。
            if (!id) return;
            if (id === current) return;
            current = id;
            // 2026-10-27 十一修（用户："这样切换就不贴底了，还得手动滚"；同时不能再闪）：
            // 事实链：①DSH 原生 ChatReading.restore() 会按会话存档**还原旧滚动位置**；
            // ②等我们收到 data-conversation-session 变化时，DSH 已经把还原位置画过一帧了；
            // ③所以"收到变化后再隐藏再拉底"必然表现为闪/跳。
            // 解法：**遮盖在点击时就打上**（openSession 里同步 setAttribute），这里只负责
            // 贴底 → 撤遮盖。用户第一眼看到的就是底部，全程无可见跳变。
            switchAt = Date.now();
            // 2026-10-28 十六修②（用户："切换还是闪，遮罩只在点当前对话时生效"）：
            // 用户切换常走**原生侧栏/搜索**——不经过我们的 openSession，点击时没人打遮罩。
            // 这里在 MO 回调（**浏览器绘制前**执行）补打遮罩：此刻新会话的第一帧还没画，
            // 遮住后同帧贴底，原生路径也不会露出"还原位置那一帧"。
            setSwitching(true);
            stick();               // 立即贴底 + 重试（内容分批挂载）
            armSafetyReveal();     // 兜底必显示
            // 2026-10-27 十三修（用户："还是闪，闪的是内容区"）：十二修探针证明侧栏**没有**任何
            // session 属性（只有我们自己的 data-active/data-mode 等），靠点击目标识别不可行；
            // 真闪因是**遮罩撤太早**——原实现 2 帧（≈32ms）就 reveal，而 DSH 原生
            // ChatReading.restore() 的落位与内容挂载都在其后 → 撤罩后它再跳一次 = 闪。
            // 改为**逐帧等落稳再撤**：每帧强制贴底，直到「连续 2 帧贴底且高度不变」才 reveal。
            // 2026-10-27 十四修（用户拍板方案②「放宽到 ~150ms 换绝对稳定」）：
            // 在十三修"落稳才撤"之外再加**最小遮罩时长 150ms**——保证跨过 DSH restore、
            // 首屏内容挂载、字体/图片解码这些异步落位窗口，宁可多空白 ~100ms 也不让用户看到跳。
            // 常量集中（2026-10-27 用户拍板 B，便于再调）：
            //   HIDE_STABLE_MS —— 最小遮罩/稳定窗口时长（跨过 restore/挂载/字体图片落位窗口）
            //   HIDE_MAX_MS    —— 撤罩上限（armSafetyReveal 兜底同值），绝不白屏超过它
            const HIDE_STABLE_MS = 150;
            const HIDE_MAX_MS = 900;
            let lastH = -1;
            let stable = 0;
            const settle = () => {
              const el = scrollEl();
              if (!el) { requestAnimationFrame(settle); return; }
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8; // 8px 容差：侧栏 zoom 会引入亚像素高度差，2px 太紧导致永不落稳（实测 hiddenMs=702 全靠上限撤）
              if (atBottom && el.scrollHeight === lastH) stable += 1; else stable = 0;
              lastH = el.scrollHeight;
              const elapsed = Date.now() - switchAt;
              if (elapsed >= HIDE_STABLE_MS && stable >= 2) { reveal(); return; }
              if (elapsed > HIDE_MAX_MS) { reveal(); return; } // 兜底：绝不白屏超过 HIDE_MAX_MS
              toBottom(); // 等待期间持续钉在底部（每帧一次，绘制前完成）
              requestAnimationFrame(settle);
            };
            requestAnimationFrame(settle);
            // 只读探针（不改行为）：切换后 1.2s 逐帧记录滚动几何，便于事后判读
            try {
              const trace = { id, t0: performance.now(), samples: [] };
              window.__hubSwitchTraces = [...(window.__hubSwitchTraces || []).slice(-2), trace];
              const record = () => {
                const el3 = scrollEl();
                if (!el3) return;
                const ms = Math.round(performance.now() - trace.t0);
                if (ms > 1200 || trace.samples.length >= 80) return;
                trace.samples.push([ms, Math.round(el3.scrollTop), el3.scrollHeight, el3.clientHeight]);
                requestAnimationFrame(record);
              };
              requestAnimationFrame(record);
            } catch (error) { /* ignore */ }
          };

          // 用户手动上滚 → 停止自动贴底
          const onUserWheel = () => { userStopped = true; clearTimers(); };
          const onScrollCapture = (event) => {
            const el = event.target;
            if (!el || typeof el.scrollTop !== 'number') return;
            // 我们自己刚赋过 scrollTop 的元素（300ms 内）忽略其 scroll 事件，
            // 否则内容异步撑高的中间态会被误判成"用户上滚"而永久停止贴底。
            if (lastProgrammatic.el === el && Date.now() - lastProgrammatic.at < 300) return;
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (distance > 48) { userStopped = true; }
          };

          current = readSession();
          stick(); // 首次进入也贴底
          mo = new MutationObserver((records) => {
            // 2026-10-27 七修（用户："切换对话又开始闪了"）：六修放宽显示条件后，"显示后内容继续
            // 分批挂载 → 又跳一次"成了可见的闪。根治：**在 MutationObserver 回调里同步贴底**——
            // MO 回调在浏览器绘制前执行，内容一长出来就同帧滚到底，中间位置永远不会上屏；
            // setTimeout 重试退化为兜底（图片/字体等异步撑高）。
            // ⚠ 只在**切换窗口内**（switchAt 有效）做：平时流式输出由 DSH 原生跟随，
            //   否则每次 token 变化都滚动+扫描，既费性能又可能跟用户抢滚动条。
            if (!userStopped && switchAt) {
              for (const record of records) {
                if (record.type === 'childList' || record.type === 'characterData') { toBottom(); break; }
              }
            }
            onAttr();
          });
          mo.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['data-conversation-session'],
          });
          document.addEventListener('wheel', onUserWheel, { passive: true, capture: true });
          document.addEventListener('touchmove', onUserWheel, { passive: true, capture: true });
          document.addEventListener('scroll', onScrollCapture, { passive: true, capture: true });

          // 2026-10-28 十五修（用户："点到对话两侧间隔区/调宽度，对话都消失一下"）：
          // 十二修加的 pointerdown 捕获判定用 `/session|conversation-item|row-key/i` 匹配
          // **属性名和属性值**——属性值只要含 "session" 子串就命中（如 aria-controls/标题引用
          // session id）。点对话两侧间隔区、拖宽度分隔条时，点击链祖先的属性值常含 "session"
          // → 误打 data-hub-stick-switch 遮罩 → 内容隐藏 → 而后续没有会话切换，只能等 900ms
          // 兜底撤罩 = "对话消失一下"。且十二修实测侧栏本无 session 标识属性，这个判定
          // **只有误伤没有收益**——整体删除。遮罩只保留 openSession（我们自己的芯片/快捷栏）
          // 一条路径，那条路径必然伴随真实会话切换。
          const onPointerDown = (event) => {
            try {
              const target = event.target;
              if (!target || typeof target.closest !== 'function') return;
              // 只记诊断（不遮罩）：万一再出问题能看到点击链
              let el = target;
              const chain = [];
              for (let depth = 0; el && depth < 6; depth += 1) {
                const attrs = el.attributes ? Array.from(el.attributes).map((a) => `${a.name}=${String(a.value).slice(0, 40)}`) : [];
                chain.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}[${attrs.join(' ')}]`);
                el = el.parentElement;
              }
              window.__hubClickProbe = { hit: false, chain: chain.slice(0, 4), at: Date.now() };
            } catch (error) { /* ignore */ }
          };
          document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });

          return () => {
            clearTimers();
            if (mo) { mo.disconnect(); mo = null; }
            document.removeEventListener('wheel', onUserWheel, true);
            document.removeEventListener('touchmove', onUserWheel, true);
            document.removeEventListener('scroll', onScrollCapture, true);
          };
        }, 'hub-desktop-ui: auto-scroll to bottom on session switch');

        // ②e 侧栏最小宽度（2026-10-27 第二次实现，用户令「限制侧边栏最小宽度」）。
        // ⚠ 上一版用正则拆 `grid-template-columns`，把后两轨吞掉导致一拖动就布局崩坏
        //   （commit 5020be2 已被 05939d7 撤销）。这次改为**括号感知的解析**：只替换第一轨，
        //   其余轨道原样拼回；解析失败（轨道数/结构异常）就一个字都不改。
        //   折叠轨（第一轨 < 60px）不碰。外壳每次拖动都会重写内联样式，这里盯住 style 再校准。
        ctx.effect(() => {
          const SIDEBAR_MIN = 340;

          /** 把 grid-template-columns 按顶层空格切成轨道（括号内的空格不算）。 */
          const splitTracks = (raw) => {
            const tracks = [];
            let depth = 0;
            let buf = '';
            for (const ch of raw) {
              if (ch === '(') depth += 1;
              else if (ch === ')') depth = Math.max(0, depth - 1);
              if (/\s/.test(ch) && depth === 0) {
                if (buf) { tracks.push(buf); buf = ''; }
                continue;
              }
              buf += ch;
            }
            if (buf) tracks.push(buf);
            return tracks;
          };

          let frame = null;
          let mo = null;
          let reported = 0;

          const locate = () => document.querySelector('[data-slot="sidebar"]')
            ?.closest('[style*="grid-template-columns"]') || null;

          const report = (payload) => {
            if (reported >= 3) return;
            reported += 1;
            try {
              fetch('/hub/client-error', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind: 'sidebar-width-probe', at: new Date().toISOString(), ...payload }),
              }).catch(() => {});
            } catch { /* 上报失败不影响 */ }
          };

          const enforce = () => {
            if (!frame) return;
            const raw = frame.style.gridTemplateColumns;
            if (!raw) return;
            const tracks = splitTracks(raw);
            if (tracks.length < 2) return; // 结构不认识就不动
            const firstPx = parseFloat(tracks[0]);
            if (!Number.isFinite(firstPx)) return;
            if (firstPx < 60) return;            // 折叠轨
            if (firstPx >= SIDEBAR_MIN) return;  // 已够宽
            const next = [`${SIDEBAR_MIN}px`, ...tracks.slice(1)].join(' ');
            frame.style.gridTemplateColumns = next;
            report({ raw, next, firstPx, tracks: tracks.length });
          };

          const attach = () => {
            const found = locate();
            if (!found) return false;
            if (found !== frame) {
              if (mo) { mo.disconnect(); mo = null; }
              frame = found;
              mo = new MutationObserver(() => { unCollapse(); enforce(); });
              mo.observe(frame, { attributes: true, attributeFilter: ['style'] });
            }
            enforce();
            return true;
          };

          // 不要窄轨（2026-10-27 用户令「不要窄轨了」）：检测到外壳切进折叠态就立刻切回展开。
          // 外壳只暴露 layout.toggleSidebar()（client Service `layout`），没有 expand 原语，
          // 所以用「折叠 → toggle 一次」的方式纠偏；带节流，避免和用户点折叠按钮打架打到卡死。
          let lastToggle = 0;
          let toggleTries = 0;
          // DOM 兜底：外壳折叠/展开按钮的 aria-label 在 asar 里实证存在
          // 「Collapse sidebar」/「Show sidebar」/「Hide sidebar」，服务拿不到时点它。
          const clickExpandButton = () => {
            try {
              const btns = [...document.querySelectorAll('button[aria-label],[title]')];
              const hit = btns.find((el) => {
                const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
                return label.includes('sidebar') && (label.includes('show') || label.includes('expand'));
              });
              if (!hit) return false;
              hit.click();
              return true;
            } catch { return false; }
          };
          const unCollapse = () => {
            const collapsed = document.querySelector('[data-sidebar-collapsed]');
            if (!collapsed) { toggleTries = 0; return; }
            if (toggleTries >= 5) return; // 兜底上限，防止极端情况下死循环
            const now = Date.now();
            if (now - lastToggle < 400) return;
            let layout = null;
            try { layout = ctx.layout || (typeof ctx.get === 'function' ? ctx.get('layout') : null); } catch { layout = null; }
            const viaService = Boolean(layout && typeof layout.toggleSidebar === 'function');
            if (!viaService && !clickExpandButton()) return;
            lastToggle = now;
            toggleTries += 1;
            if (viaService) {
              try { layout.toggleSidebar(); } catch { /* 失败就等下一轮 */ }
            }
            report({ action: 'un-collapse', tries: toggleTries, layout: viaService });
            setTimeout(() => { enforce(); }, 120);
          };

          attach();
          unCollapse();
          const timer = setInterval(() => {
            if (!frame || !document.contains(frame)) attach();
            unCollapse();
          }, 1200);
          window.addEventListener('resize', attach);
          // 折叠态是给 documentElement 打 attribute 的，盯它即可第一时间纠偏
          const rootMo = new MutationObserver(() => unCollapse());
          rootMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });

          return () => {
            clearInterval(timer);
            window.removeEventListener('resize', attach);
            if (mo) { mo.disconnect(); mo = null; }
            rootMo.disconnect();
          };
        }, 'hub-desktop-ui: sidebar min width');


        // ②b 开发期诊断曾把读数写进窗口标题，这里恢复一次
        ctx.effect(() => {
          if (/^(HUB|PROBE|SVC)\|/.test(document.title)) document.title = 'DeepSeek Harness';
        });

        // ③ 座位注册：一处挂不上不连累其它处（失败写 console，不抛）
        const mount = (key, options, component) => {
          try {
            ctx.slots.inject(key, () => ctx.slots.register(
              { name: key, ...options },
              component,
            ));
          } catch (error) {
            console.error(`[hub-desktop-ui] mount ${key} failed`, error);
          }
        };

        clientCtx = ctx;

        mount('sidebar.footer.action', { id: 'hub-status-card', order: 50 }, HubStatusCard);
        // 2026-11-11 用户令「不需要品牌标记」：**不再覆盖**侧栏顶部的品牌槽位。
        // 槽位空出来后由 DSH 自己兜底（@deepseek-ai/dsh-client-ui-sidebar 的
        // renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: FishLogo })），
        // 于是侧栏顶部恢复出厂标志；品牌名同理交回 DSH。
        // 想恢复自定义品牌：把下面两行取消注释即可（HubBrandMark / HubBrandName 仍在文件里）。
        // mount('sidebar.brand.mark', { priority: -1 }, HubBrandMark);
        // mount('sidebar.brand.name', { priority: -1 }, HubBrandName);
        // 群聊：全屏 overlay 页面，不再挂在每个 agent 的会话视图里
// ── 群聊布局自诊断（2026-11-09，顶层轮询）──────────────────────────────
// 挂在这里而不是 HubRoomPage 里：那个组件返回 null 时不渲染，若 slot 采用条件挂载，
// effect 可能永远不跑（实测日志里 4 小时无一条 lane-diag，而同页的 skin-diag 每 25s 都在报）。
// 顶层 ctx.effect + setInterval：只要插件加载就一直在探，群聊页一打开 5 秒内就有数据。
ctx.effect(() => {
  let lastSignature = '';
  let sent = 0;
  const tick = () => {
    try {
      if (sent >= 20) return;
      const room = document.querySelector('.hub-room');
      if (!room) return;
      const report = {
        kind: 'lane-diag',
        at: new Date().toISOString(),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        room: { h: room.clientHeight, sh: room.scrollHeight, overflow: getComputedStyle(room).overflow },
        lanes: [],
      };
      const sections = Array.from(room.querySelectorAll('section'));
      for (const sec of sections.slice(0, 6)) {
        const kids = Array.from(sec.children);
        const feed = kids.find((el) => {
          try { const oy = getComputedStyle(el).overflowY; return oy === 'auto' || oy === 'scroll'; } catch { return false; }
        });
        const feedCs = feed ? getComputedStyle(feed) : null;
        const first = feed && feed.children[0];
        const firstCs = first ? getComputedStyle(first) : null;
        report.lanes.push({
          title: (sec.textContent || '').trim().slice(0, 24),
          laneH: sec.clientHeight,
          laneScrollH: sec.scrollHeight,
          laneOverflow: getComputedStyle(sec).overflow,
          laneFlex: getComputedStyle(sec).flex,
          feed: feed ? {
            h: feed.clientHeight, sh: feed.scrollHeight,
            overflowY: feedCs.overflowY, maxH: feedCs.maxHeight, minH: feedCs.minHeight,
            flex: feedCs.flex, display: feedCs.display, flexDirection: feedCs.flexDirection,
            kids: feed.children.length,
          } : null,
          firstChild: first ? {
            h: Math.round(first.getBoundingClientRect().height),
            flex: firstCs.flex, minH: firstCs.minHeight, overflow: firstCs.overflow,
          } : null,
        });
      }
      const signature = JSON.stringify(report.lanes);
      if (signature === lastSignature) return;
      lastSignature = signature;
      sent += 1;
      fetch('/hub/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      }).catch(() => {});
    } catch (error) { /* 诊断失败绝不影响渲染 */ }
  };
  const timer = setInterval(tick, 5000);
  tick();
  return () => clearInterval(timer);
});

        mount('shell.overlay', { id: ROOM_PAGE_KEY, order: 90 }, HubRoomPage);
        // 分身分列：盖住会话内容区（zIndex 870 < 群聊页 900），父 + 各分身聊天正文并排。
        // 声明一个 session 子槽是为了拿到渲染 kit 的 `SessionProvider` + `renderFactorySlot`
        // （renderer 只在条目声明了非 root 子槽时才注入这两个）——拿到后每列直接渲染原生
        // `conversation.content` 工厂，**每列与独立对话完全一致**（工具卡/思考/analysis/Deep diving 速率）。
        // 若该形状被槽位系统拒绝，退回不带子槽的注册（组件自动用自绘渲染兜底）。
        // 注：之前判 inactive 的真因是 CloneColumns 的 TDZ 崩溃（columns 在 hook 依赖后声明），不是子槽。
        // ═══ 2026-11-09 用户令「取消分列」：分身分列视图不再挂载 ═══
        // 原实现：父 + 各分身并排渲染原生 conversation.content（每列一份 SessionProvider）。
        // 代码保留在下方注释块里，需要恢复时把注释去掉即可；CloneColumns 组件本身未删。
        // ctx.slots.inject('shell.overlay', () => {
        //   try {
        //     return ctx.slots.register({
        //       name: 'shell.overlay',
        //       id: 'hub-clone-columns',
        //       order: 95,
        //       children: { 'hub.clone.body': { kind: 'single', scope: 'session' } },
        //     }, CloneColumns);
        //   } catch (error) {
        //     console.error('[hub-desktop-ui] clone-columns session child rejected, fallback renderer', error);
        //     return ctx.slots.register({ name: 'shell.overlay', id: 'hub-clone-columns', order: 95 }, CloneColumns);
        //   }
        // });
        // 整块浏览区：用「项目行 + 芯片网格」替换出厂 WorkspaceBrowser
        // （会接管搜索/拖拽/右键菜单这些出厂能力，本版先做只读浏览 + 开会话）。
        mount('sidebar.workspaces', { priority: -1 }, HubWorkspaces);

        // 2026-11-11：设置页「侧栏」分区（New Session / More 两颗按钮的开关）+ 启动时套用已存偏好
        mount('settings.section', { id: 'hub-sidebar', order: 60, label: () => '侧栏' }, HubSidebarSettingsSection);
        ctx.effect(() => {
          for (const toggle of SIDEBAR_TOGGLES) applyToggle(toggle, readToggle(toggle));
        }, 'hub-desktop-ui: apply sidebar toggle preferences');

        // 2026-11-11 用户令「可以不覆盖吗」：不再拦截出厂的「New Session」按钮，恢复它原本行为。
        // 「New project」弹窗组件仍挂在 overlay 上（NewProjectDialog 自己渲染 null），
        // 需要恢复拦截时把下面 ctx.effect 那段取消注释即可。
        mount('shell.overlay', { id: 'hub-new-project', order: 100 }, NewProjectDialog);
        // 顺序镜像心跳（2026-11-11）：挂 overlay 而不是 sidebar.workspaces ——
        // 后者被 project-room 的 ProjectSidebar（priority -2）顶掉，挂在那儿的组件不渲染，
        // 心跳（含 order.json 镜像）就永远不发（原实现即如此，症状已复发两次：
        // 2026-10-28「order.json 停在两天前」、2026-11-09 起又冻结到 11-11）。
        // 本组件渲染 null，不占视觉位置；与 HubRoomPage / NewProjectDialog 按 id 共存。
        mount('shell.overlay', { id: 'hub-order-mirror', order: 200 }, OrderMirrorHeartbeat);
        // 实时速率：跟在「Deep diving for Ns ···」那一行后面（同排小字，不另起一行）
        mount('conversation.input.dock', { id: 'hub-live-rate', order: 50 }, LiveRateHint);
        // ctx.effect(() => {
        //   const intercept = (event) => {
        //     const target = event.target;
        //     if (!target || typeof target.closest !== 'function') return;
        //     const button = target.closest('[data-slot="sidebar"] [class*="_newSession"]');
        //     if (!button) return;
        //     event.preventDefault();
        //     event.stopPropagation();
        //     openNewProject();
        //   };
        //   document.addEventListener('click', intercept, true);
        //   return () => document.removeEventListener('click', intercept, true);
        // }, 'hub-desktop-ui: new project intercept');
      },
    };
  },
});




















