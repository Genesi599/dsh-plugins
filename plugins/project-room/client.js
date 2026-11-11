/**
 * dsh-project-room · Client 半
 *
 * 做两件事：
 *   1. 接管侧栏浏览区（`sidebar.workspaces`，priority -2）：把平铺的会话列表改成
 *      「项目分组 + 成员芯片 + 每组今日运行时长 + 搜索 + 折叠/置顶」。
 *      分组依据 = 会话标题里的分隔符（默认 ' · '，「项目 · 成员」→ 项目「项目」）。
 *   2. 一个项目房间浮层（`shell.overlay`）：公共看板 / 任务线分列 / 向成员投递消息。
 *
 * 数据来源全部是 DSH 原生 + 本插件自己的 Host 半端点：
 *   - 会话与运行状态：slot props 的 `useSessions` / `useWorkspaces`（原生 `running`、`updatedAt`）
 *   - 看板/任务/待办/投递：`/project-room/*`（见 index.js）
 * 不读任何其它插件的 DOM 或私有文件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-project-room',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SEP = ' · ';
    const STYLE_ID = 'project-room-style';
    const API = '/project-room';
    /** 标题里没有分隔符的会话归到这个名字下（默认不显示，见 showLoose）。 */
    const LOOSE_GROUP = '未分组';
    /** 默认项目管理者名；用户可在侧栏齿轮里改（localStorage: projectRoom.managerName）。 */
    const DEFAULT_MANAGER = 'Yat2';

    // ───────────────────────── 小工具 ─────────────────────────

    function projectOfTitle(title) {
      const text = String(title || '');
      const at = text.lastIndexOf(SEP);
      if (at <= 0) return null;
      const project = text.slice(0, at).trim();
      const member = text.slice(at + SEP.length).trim();
      if (!project || !member) return null;
      return { project, member };
    }

    function formatDuration(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      if (hh > 0) return `${hh}h${String(mm).padStart(2, '0')}m`;
      if (mm > 0) return `${mm}m${String(ss).padStart(2, '0')}s`;
      return `${ss}s`;
    }

    /**
     * 会话「最后一次活动」时间（毫秒）。
     * ⚠️ 不能用 session.updatedAt：DSH 的 sessions 投影没有这个字段
     * （全仓 `session.updatedAt || 0` 都是防御写法，实测恒 0）——
     * 这正是用户两次报「侧边栏分身还是没有计时」的根因。
     * 键与 hub-desktop-ui 共用 `hub.lastActive`，两边互相补。
     */
    /**
     * 「距上次活动 / X 小时前运行」这类相对时长是否显示（用户令 2026-11-09：
     * 「在设置里加上 agent 多少多少小时前运行这个显示的开关」）。
     * 默认开；关掉后只显示运行中时长，空闲行不再出现相对时间。
     */
    const SHOW_IDLE_AGO_KEY = 'projectRoom.showIdleAgo';
    let showIdleAgo = (() => {
      try {
        const raw = localStorage.getItem(SHOW_IDLE_AGO_KEY);
        return raw === null ? true : raw === '1';
      } catch { return true; }
    })();
    function setShowIdleAgo(on) {
      showIdleAgo = Boolean(on);
      try { localStorage.setItem(SHOW_IDLE_AGO_KEY, showIdleAgo ? '1' : '0'); } catch { /* 存不了就本次生效 */ }
    }

    const LAST_ACTIVE_KEY = 'hub.lastActive';
    const lastActiveTimes = (() => {
      try { return JSON.parse(localStorage.getItem(LAST_ACTIVE_KEY) || '{}') || {}; } catch { return {}; }
    })();
    function markLastActive(id, at) {
      const key = String(id || '');
      if (!key) return;
      lastActiveTimes[key] = Number(at) || Date.now();
      try { localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify(lastActiveTimes)); } catch { /* 存储不可用 */ }
    }
    function lastActiveOf(id) {
      return Number(lastActiveTimes[String(id || '')]) || 0;
    }

    function relTime(ts) {
      if (!ts) return '';
      const diff = Date.now() - ts;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
      return `${Math.floor(diff / 86400000)} 天前`;
    }

    function dayKey() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function hashHue(text) {
      let sum = 0;
      for (let i = 0; i < String(text).length; i += 1) sum = (sum * 31 + String(text).charCodeAt(i)) % 360;
      return sum;
    }

    /** 成员芯片的「头像」：名字首字符 + 由名字推导的稳定色相。 */
    function memberGlyph(name) {
      const text = String(name || '?').trim();
      return text ? Array.from(text)[0] : '?';
    }

    /**
     * 成员排序权重（越小越前）：
     *   0 = Yat2（项目管理者，用户要求它始终排第一）
     *   1 = 运行中
     *   2 = 其它
     */
    /**
     * 项目管理者的名字（默认 Yat2，可在侧栏齿轮里改，存 localStorage）。
     * 排序、新建项目默认成员、房间成员归属都读它。
     * 注意边界：hub-desktop-ui 里还硬编码着 MANAGER_NAMES = ['Yat2','Hermes'] 用于
     * 注入管理者协议——改这里的名字**不会**改变那边认谁是管理者。
     */
    function managerName() {
      try {
        const raw = window.localStorage.getItem('projectRoom.managerName');
        const value = raw ? String(raw).trim() : '';
        return value || DEFAULT_MANAGER;
      } catch { return DEFAULT_MANAGER; }
    }

    /**
     * 任务线排序：最近活跃的排最前；活跃时间相同按 tasks.json 定义顺序兜底。
     *
     * 为什么单独抽出来：排序规则要能被测试直接跑（test/lane-order.test.mjs 切片真源码），
     * 也避免把「显示顺序」的逻辑散在 JSX 里。纯函数——不改入参、不读全局。
     *
     * @param {Array<{task: object, index: number, lastAt: number}>} entries
     *   index = 该线在 tasks.json 里的位置（顺序兜底用）；lastAt = 该线最近活跃时间(ms)。
     */
    function orderLanesByActivity(entries) {
      return entries.slice().sort(
        (a, b) => ((Number(b.lastAt) || 0) - (Number(a.lastAt) || 0)) || (a.index - b.index),
      );
    }

    /**
     * 极简 Markdown → React 元素（不引第三方库，够黑板用）：
     * 标题 #~####、无序列表 -/*、行内 **粗体** 与 `代码`、其余按段落。
     */
    function renderMarkdown(text) {
      const lines = String(text || '').split('\n');
      const out = [];
      let listBuffer = [];
      const flushList = () => {
        if (!listBuffer.length) return;
        out.push(h('ul', { key: `ul-${out.length}`, className: 'pr-md-ul' }, listBuffer));
        listBuffer = [];
      };
      const inline = (line, key) => {
        const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
        const parts = [];
        let last = 0;
        let match;
        let index = 0;
        while ((match = regex.exec(line)) !== null) {
          if (match.index > last) parts.push(line.slice(last, match.index));
          const token = match[0];
          if (token.startsWith('**')) parts.push(h('strong', { key: `${key}-b${index++}` }, token.slice(2, -2)));
          else parts.push(h('code', { key: `${key}-c${index++}`, className: 'pr-md-code' }, token.slice(1, -1)));
          last = match.index + token.length;
        }
        if (last < line.length) parts.push(line.slice(last));
        return parts.length ? parts : [line];
      };
      lines.forEach((raw, lineIndex) => {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { flushList(); return; }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          flushList();
          const level = Math.min(heading[1].length + 2, 6);
          out.push(h(`h${level}`, { key: `h-${lineIndex}`, className: 'pr-md-h' }, ...inline(heading[2], `h${lineIndex}`)));
          return;
        }
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          listBuffer.push(h('li', { key: `li-${lineIndex}` }, ...inline(bullet[1], `li${lineIndex}`)));
          return;
        }
        flushList();
        out.push(h('p', { key: `p-${lineIndex}`, className: 'pr-md-p' }, ...inline(line, `p${lineIndex}`)));
      });
      flushList();
      return out;
    }

    function memberRank(member) {
      const name = String((member && (member.base || member.name)) || '').trim();
      if (name && name.toLowerCase() === managerName().toLowerCase()) return 0;
      return member && member.running ? 1 : 2;
    }

    function loadJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    }

    function saveJson(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额满了就放弃持久化 */ }
    }

    /** 插件上下文（apply 时赋值），用来取宿主 Client 服务。 */
    let clientCtx = null;

    /**
     * 打开一个会话。
     * 正确通道是宿主 Client 服务 `uiWorkspace.openSession(id)`——不是 slot props
     * （`sidebar.workspaces` 只给 useWorkspaces / useSessions）。
     * 早期版本错用了 props.openSession 并在失败时退回「打开项目房间」，
     * 结果点任何芯片都弹出公共看板。
     */
    function openSessionById(id) {
      if (!id) return false;
      try {
        const svc = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null;
        if (svc && typeof svc.openSession === 'function') {
          svc.openSession(id);
          return true;
        }
      } catch (error) {
        console.error('[project-room] openSession failed', error);
      }
      return false;
    }

    /** 当前打开的会话 id（宿主写在会话内容区的 data 属性上） */
    function currentSessionId() {
      try {
        const el = document.querySelector('[data-conversation-content]');
        return el ? (el.getAttribute('data-conversation-session') || '') : '';
      } catch { return ''; }
    }

    /**
     * 量出「对话内容区」在屏幕上的位置，让房间页正好占住这一块
     * （侧栏、顶栏都保留），而不是盖住整个窗口。
     * 量不到就退回到「从左栏后面开始」。
     */
    function conversationBox() {
      try {
        const el = document.querySelector('[data-conversation-content]');
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 120 && rect.height > 120) {
            return { left: Math.round(rect.left), top: Math.round(rect.top) };
          }
        }
      } catch { /* 量不到走兜底 */ }
      return { left: 264, top: 0 };
    }

    // ───────────────────── 房间打开总线（侧栏 → 浮层） ─────────────────────

    const roomBus = {
      current: null,
      listeners: new Set(),
      /** 侧栏每次渲染都会刷新这里，房间浮层据此拿到「本项目成员」。 */
      sessionIndex: new Map(),
      open(project) {
        this.current = project;
        for (const fn of this.listeners) { try { fn(project); } catch { /* ignore */ } }
      },
      close() {
        this.current = null;
        for (const fn of this.listeners) { try { fn(null); } catch { /* ignore */ } }
      },
      subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      },
    };

    // ───────────────────────── 样式 ─────────────────────────

    // 视觉基准 = AI-Agent-Hub 现有侧栏（HubWorkspaces）：同样的行高、间距、圆角、芯片网格。
    // 数值来自 hub-desktop-ui 的实测样式（.hub-proj / .hub-chip 等），照搬以保证观感一致。
    const CSS = `
.pr-root {
  display: flex; flex-direction: column;
  flex: 1 1 auto; min-height: 0; height: 100%;
  overflow-y: auto; overflow-x: hidden;
  padding: 0 4px 8px; box-sizing: border-box;
}
.pr-search { display: flex; align-items: center; gap: 4px; padding: 0 6px 6px; flex: 0 0 auto; }
.pr-search input {
  flex: 1; min-width: 0; height: 22px; box-sizing: border-box; padding: 0 6px;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-size: 11px; outline: none;
}
.pr-head { display: flex; align-items: center; gap: 6px; padding: 2px 6px 4px; flex: 0 0 auto; }
.pr-head-title { font-size: 11.5px; letter-spacing: 0.04em; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.pr-head-count { font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .75; margin-left: auto; }
/* 「未分组」那一行：折叠按钮 + 清理按钮 */
.pr-loose-row { display: flex; gap: 4px; align-items: center; padding: 0 6px 6px; flex: 0 0 auto; }
.pr-loose-toggle {
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 10px; line-height: 1.6; cursor: pointer; flex: 0 0 auto;
}
.pr-loose-toggle:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.pr-chip-badge {
  flex: 0 0 auto; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 9px; line-height: 1; font-variant-numeric: tabular-nums;
}
.pr-chip-elapsed { flex: 0 0 auto; font-size: 9px; line-height: 1; font-variant-numeric: tabular-nums; color: var(--dsw-alias-state-success-primary); }
/* 分身子行：树状（├ / └ 竖线缩进） */
.pr-chip-clones { display: flex; flex-direction: column; gap: 1px; margin-top: 1px; padding-left: 0; }
.pr-clone-row {
  display: flex; align-items: center; gap: 3px;
  font-size: 9.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  cursor: pointer; border-radius: 3px; padding: 0;
}
.pr-clone-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-primary); }
.pr-tree-rail { flex: 0 0 auto; width: 7px; color: var(--dsw-alias-border-l2, #4a4a4a); font-size: 9px; line-height: 1.5; }
.pr-clone-dot { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-label-secondary); }
.pr-clone-dot.on { background: var(--dsw-alias-state-success-primary, #4ade80); box-shadow: none; }
/* 同理：分身子行名不再 ellipsis，长任务名完整显示（行高会自动撑开）。 */
.pr-clone-name { min-width: 0; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
.pr-clone-elapsed {
  flex: 0 0 auto; margin-left: 3px; font-size: 9px; line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-state-success-primary);
}
.pr-clone-elapsed.idle, .pr-chip-elapsed.idle { color: var(--dsw-alias-label-secondary); }
.pr-menu {
  position: fixed; z-index: 1000; min-width: 168px; padding: 4px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); box-shadow: 0 12px 32px rgba(0,0,0,.45);
  font-size: 12px;
}
.pr-menu-item {
  display: block; width: 100%; text-align: left; padding: 5px 8px; border: none; border-radius: 5px;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer;
}
.pr-menu-item:hover { background: var(--dsw-alias-bg-layer-1); }
.pr-menu-msg { padding: 4px 8px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.pr-modal { position: fixed; inset: 0; z-index: 1001; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.pr-modal-box { width: min(420px, 88vw); padding: 14px; border-radius: 10px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); }
.pr-modal-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.pr-modal-input { width: 100%; box-sizing: border-box; height: 30px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12.5px; outline: none; }
.pr-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
/* 头部「+ 新项目」按钮 */
.pr-new-btn {
  flex: 0 0 auto; height: 18px; padding: 0 6px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 1; cursor: pointer;
}
.pr-new-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
/* 房间关闭按钮：显式带文字，避免全屏遮罩下只剩一个小图标找不着 */
.pr-close-btn {
  flex: 0 0 auto; height: 22px; padding: 0 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); font-size: 11.5px; line-height: 1; cursor: pointer;
}
.pr-close-btn:hover { border-color: var(--dsw-alias-brand-primary); }
/* 一页三段布局 */
/* 房间主体：左 1/3 看板、右 2/3 任务线分列 */
.pr-room-body {
  flex: 1; min-height: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); grid-template-rows: minmax(0, 1fr);
  gap: 12px; align-items: stretch;
}
.pr-room-body > .pr-section { margin-bottom: 0; min-height: 0; }
.pr-board-section { display: flex; flex-direction: column; min-height: 0; }
.pr-tasks-section { display: flex; flex-direction: column; min-height: 0; }
    /* 2026-11-09 用户报「群聊视图下面还是有好多空白」：原来这里写死 height/max-height: 56vh，而房间是 100vh → 下方约半个视口永远是空的。这批 vh 兜底是早先为绕开「任务线滚不动」的父级 flex 断点加的，真根因（.pr-lane-msg 的 overflow:hidden）已在 cc84ac7 修掉，兜底就该还原成自适应。 */
    .pr-tasks-section .pr-lanes { flex: 1 1 auto; min-height: 100px; height: auto; max-height: none; overflow-x: auto; overflow-y: hidden; align-items: stretch; }
    .pr-tasks-section .pr-lane-body { flex: 1 1 auto; min-height: 100px; height: auto; max-height: none; overflow-y: auto; }
    .pr-board-section .pr-md-view { flex: 1 1 auto; min-height: 120px; height: auto; max-height: none; overflow-y: auto; }
    .pr-board-section .pr-board-edit { flex: 1 1 auto; min-height: 120px; height: auto; max-height: none; }
/* 滚轮各自独立：看板区与每条线的消息区都 contain，滚到底不传递给外层；外层整体不可滚 */
.pr-board-section .pr-md-view { overscroll-behavior: contain; }
.pr-tasks-section .pr-lane-body { overscroll-behavior: contain; }
.pr-board-section .pr-board-edit { overscroll-behavior: contain; }
.pr-section { margin-bottom: 16px; }
.pr-section:last-child { margin-bottom: 4px; }
.pr-section-title {
  font-size: 11px; font-weight: 700; letter-spacing: .06em;
  color: var(--dsw-alias-label-secondary); text-transform: uppercase;
  margin-bottom: 6px;
}
.pr-loose-msg { font-size: 10px; color: var(--dsw-alias-label-secondary); padding: 0 6px 6px; line-height: 1.5; flex: 0 0 auto; }

/* 运行中快捷栏（对齐 AI-Agent-Hub）：两段竖排 —— 上「运行中」、下「完成未读」 */
.pr-runbar { display: flex; flex-direction: column; gap: 4px; padding: 2px 4px 6px; flex: 0 0 auto; min-width: 0; }
/* 2026-11-11 用户令「快捷栏正在运行和完成未读的分开放」：
   每段 = 一行小标题（色点/✓ + 文案 + 计数）+ 可折行的 pill 区，段间用极细线分隔。 */
.pr-runbar-sec { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pr-runbar-sec + .pr-runbar-sec {
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding-top: 3px;
}
.pr-runbar-sec-title {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  padding: 0 2px; font-size: 9px; line-height: 1.4;
  color: var(--dsw-alias-label-secondary); letter-spacing: .03em;
}
.pr-runbar-sec[data-kind="done"] .pr-runbar-sec-title { color: #d97757; }
.pr-runbar-sec-dot {
  width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto;
  background: var(--dsw-alias-state-success-primary);
}
.pr-runbar-sec-check {
  width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: #d97757; color: #fff;
  font-size: 8px; font-weight: 700; line-height: 1;
}
.pr-runbar-sec-label { flex: 0 0 auto; white-space: nowrap; }
.pr-runbar-sec-count {
  flex: 0 0 auto; font-variant-numeric: tabular-nums; opacity: .75;
}
.pr-runbar-sec-body { display: flex; flex-wrap: wrap; gap: 3px; min-width: 0; }
/* 快捷栏 pill 也显示分身：每个 pill 变成「按钮 + 树状子行」的竖排小单元，
   子行样式与侧栏芯片的 pr-clone-row / pr-tree-rail 完全一致。 */
.pr-run-wrap { display: inline-flex; flex-direction: column; gap: 1px; align-items: flex-start; }
.pr-run-clones { display: flex; flex-direction: column; gap: 1px; padding-left: 6px; margin: 0 0 1px; }
.pr-run-clones .pr-clone-row { font-size: 9px; line-height: 1.4; }
.pr-readall {
  /* 2026-11-11：一键已读搬进「完成未读」区的小标题里，靠右对齐 */
  flex: 0 0 auto; margin: 0 0 0 auto; padding: 1px 6px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: #d97757; font-size: 9.5px; line-height: 1.4;
  white-space: nowrap; cursor: pointer;
}
.pr-readall:hover { background: var(--dsw-alias-bg-layer-2); }
.pr-run-pill {
  display: inline-flex; align-items: center; gap: 4px;
  flex: 0 0 auto; max-width: 100%; min-width: 0; overflow: hidden;
  min-height: 20px; padding: 2px 7px 2px 3px; border-radius: 11px;
  border: 1px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11.5px; line-height: 1.2; white-space: nowrap; cursor: pointer;
}
.pr-run-pill:hover { background: var(--dsw-alias-bg-layer-1); }
.pr-run-pill[data-active="1"] {
  border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.pr-run-avatar { width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; line-height: 1; }
.pr-run-project { display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto; min-width: 0; }
.pr-run-project-dot { width: 6px; height: 6px; border-radius: 2px; flex: 0 0 auto; }
.pr-run-project-name { font-size: 9px; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 2026-11-09 用户令「标题要显示全」：快捷栏 pill 名字原来 nowrap+ellipsis 会被吃掉，改为可换行。 */
.pr-run-name { min-width: 0; flex: 0 1 auto; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
.pr-run-badge {
  flex: 0 0 auto; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 9px; line-height: 1; font-variant-numeric: tabular-nums;
}
.pr-run-done { display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto; font-size: 9px; line-height: 1; color: var(--dsw-alias-brand-primary); }
.pr-run-check {
  width: 10px; height: 10px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: #d97757; color: #fff; font-size: 8px; font-weight: 700; line-height: 1;
}
.pr-run-elapsed { flex: 0 0 auto; font-size: 9px; line-height: 1; font-variant-numeric: tabular-nums; color: var(--dsw-alias-state-success-primary); }

/* 项目行：22px 紧凑行高 + 顶部细线，读起来像「项目」而不是一行会话 */
.pr-proj {
  display: flex; align-items: center; gap: 6px;
  height: 22px; min-height: 22px; padding: 0 6px;
  margin-top: 6px; border-radius: 6px;
  font-size: 12px; font-weight: 600;
  box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1);
  cursor: pointer; overflow: hidden;
}
.pr-proj:first-of-type { margin-top: 0; }
.pr-proj:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06)); }
.pr-dot { width: 6px; height: 6px; border-radius: 2px; flex: 0 0 auto; }
.pr-proj-name { flex: 0 1 auto; max-width: 100%; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-spacer { flex: 1 1 auto; min-width: 4px; }
.pr-meta { font-size: 10px; font-weight: 500; color: var(--dsw-alias-label-secondary); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.pr-icon-btn {
  width: 18px; height: 18px; flex: 0 0 auto; border: none; padding: 0; border-radius: 5px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 10px; line-height: 1;
}
.pr-icon-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
/* 图钉：默认隐藏，悬停显形；已置顶常显 */
.pr-pin { opacity: 0; transition: opacity 120ms ease; }
.pr-proj:hover .pr-pin, .pr-pin[data-pinned="1"] { opacity: 1; color: var(--dsw-alias-brand-primary); }

/* 成员芯片网格 */
.pr-grid { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 6px 4px 18px; }
/* 2026-11-09 用户报「头像又单独放一行」：真因不是 pr-chip-head（已 revert 且与本文件 249ee81 完全一致），
   而是 .pr-chip 的 min-width: 0 + flex: 0 1 auto —— chip 作为 .pr-grid 的 flex item 可以被压到
   **比内容还窄**，一旦宽度不够，chip 内部的 flex-wrap: wrap 就把头像和名字拆成两行。
   修法：min-width: min-content（不压到内容以下）+ flex: 0 0 auto（不参与收缩），
   放不下时由 .pr-grid 把**整个 chip** 换到下一行，chip 内部始终一行。max-width:100% 仍兜住超宽情况。 */
.pr-chip {
  /* 2026-11-09：改成 block 容器，本体行(.pr-chip-head)与分身树(.pr-chip-clones)各占一行，
     两者背景互不影响 —— 布局已在 dsh/cordis-notes/shots/chip-layout-probe.html + headless Chrome 验证过。
     上次失败的原因是 chip 仍为 inline-flex，包裹层变成 flex item 被 wrap 挤开；改成 block 后不会。 */
  display: block;
  max-width: 100%; min-width: min-content; flex: 0 0 auto;
  padding: 0; border-radius: 11px;
  border: 1px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11.5px; line-height: 1.2;
  cursor: pointer; box-sizing: border-box; overflow-wrap: anywhere;
}
/* 本体那一行（头像 + 名字 + badge + 圆点 + 时长）：单独成盒，选中背景只作用在它上面 */
.pr-chip-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 3px 5px;
  max-width: 100%; min-width: 0;
  padding: 3px 7px 3px 2px; border-radius: 11px;
  border: 1px solid transparent; box-sizing: border-box;
}
/* 2026-11-09 用户令「hover 预选也要单独高亮本体或分身，不要高亮整体」：
   原来 .pr-chip:hover 给**整块**（含分身子行）加底色 —— 与 active 一样是盒子套错了。
   改成给 .pr-chip-head 自身的 :hover（鼠标真在本体行上才亮），分身行仍由 .pr-clone-row:hover 负责；
   整块 chip 不再有任何统一 hover 底色。 */
.pr-chip:hover:not([data-active="1"]) { background: transparent; border-color: transparent; }
.pr-chip-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06)); border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
/* 2026-11-09 用户令「单独高亮本体像快捷栏那样就行」：与 .pr-run-pill[data-active=1] 完全同一套
   —— 细边框(border-l1) + 底色(bg-layer-2) + 主色文字，不要主色强调条（那是上一版我加的，太重）。
   hover 已用 :not([data-active="1"]) 降级，所以选中与悬停仍能区分。 */
/* 2026-11-09：选中背景只作用在本体那一行（.pr-chip-head），不碰分身子行。 */
.pr-chip[data-active="1"] { border-color: transparent; background: transparent; }
.pr-chip[data-active="1"] .pr-chip-head {
  border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
/* 2026-11-09 用户两次报「还是没有单独高亮本体」：原来 active 与 :hover 用**同一个底色**，
   视觉上分不清「选中」和「鼠标停在这儿」。active 加左侧强调条 + 主色描边 + 名字加粗，
   hover 降级为只描边不填色，两者一眼可分。 */
.pr-chip[data-active="1"] .pr-chip-name { color: var(--dsw-alias-label-primary); font-weight: 600; }
/* 2026-11-09 用户报「侧边栏的分身怎么没有选中效果」：分身子行原来只有 hover、没有选中态。
   与 .pr-chip[data-active="1"] 同一套视觉（底色 + 主色文字 + 左侧强调条）。 */
.pr-clone-row[data-active="1"] {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.pr-clone-row[data-active="1"] .pr-clone-name { color: var(--dsw-alias-label-primary); font-weight: 600; }
/* 2026-11-09 用户令「标题要显示全」：DSH 原生顶部会话标题栏把
   「应用开发 · DSH工程师｜讲解已启用插件各自作用」截成「…｜讲解...」。
   这里放开标题链上的 max-width / ellipsis，让它完整显示；只作用于会话标题栏，
   不碰侧栏与消息区。 */
[data-slot="conversation.session.header"] span,
[data-slot="conversation.session.header"] div {
  max-width: none !important;
  text-overflow: clip !important;
  overflow: visible !important;
  white-space: nowrap;
}
[data-slot="conversation.session.header"] { max-width: none !important; }
.pr-avatar {
  width: 16px; height: 16px; border-radius: 50%; display: inline-flex;
  align-items: center; justify-content: center; flex: 0 0 auto; line-height: 1;
}
.pr-chip-name { min-width: 0; flex: 0 1 auto; max-width: 100%; white-space: normal; word-break: break-word; overflow-wrap: anywhere; line-height: 1.2; }
@keyframes pr-pulse {
  0% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }
  60% { transform: scale(1.45); opacity: .55; box-shadow: 0 0 0 4px transparent; }
  100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 transparent; }
}
.pr-running-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-success-primary); animation: pr-pulse 1.4s ease-in-out infinite; }
.pr-empty { padding: 10px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center; }

/* 房间浮层 */
.pr-overlay { position: fixed; z-index: 900; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l1); }
.pr-panel { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); }
.pr-panel-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.pr-panel-title { font-size: 13px; font-weight: 700; }/* 2026-11-10 用户令「群聊页字体太大」：14px→13px，与分区标题/正文一起收一档 */
.pr-tabs { display: flex; gap: 2px; margin-left: 10px; }
.pr-tab { padding: 3px 10px; border-radius: 6px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
.pr-tab.on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.pr-panel-body { flex: 1; min-height: 0; overflow: hidden; padding: 12px 14px; display: flex; flex-direction: column; }
.pr-panel-foot { border-top: 1px solid var(--dsw-alias-border-l1); padding: 8px 14px; display: flex; gap: 8px; align-items: flex-end; }
.pr-textarea { flex: 1; min-height: 34px; max-height: 120px; resize: vertical; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; outline: none; }
.pr-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; white-space: nowrap; }
.pr-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.pr-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #08111a; font-weight: 600; }
.pr-btn:disabled { opacity: .5; cursor: default; }
.pr-board { width: 100%; min-height: 200px; resize: vertical; padding: 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; outline: none; }
.pr-todo { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); font-size: 12.5px; }
.pr-todo input[type=checkbox] { flex: 0 0 auto; }
.pr-todo-text { flex: 1; min-width: 0; }
.pr-todo.done .pr-todo-text { text-decoration: line-through; opacity: .55; }
/* 任务线分列：每列一个成员，横向滚动，列内是各自最近的消息气泡 */
.pr-lanes { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; align-items: stretch; }
/* 列宽自适应（2026-11-09 用户令「任务线宽度要自适应，不要只有两个任务线右边还空这么多」）：
   原来是 flex: 0 0 232px（定宽、永不伸缩）→ 只有 2 条线时右边空掉一大片。
   改成「232px 只是基准，可增长」：
     · 列少（2~3 条）→ 各列按比例吃满 .pr-lanes 的宽度，右侧不留空白；
     · 列多（基准之和 > 容器）→ flex-shrink 被 min-width 夹住，列不窄于可读宽度，
       超出部分交给 .pr-lanes 的 overflow-x 横向滚动（不裁切、不重叠）。
   ⚠️ 本规则只碰宽度；overflow / 高度相关属性属主诉（压扁/滚不动）修复范围，勿在此改。 */
.pr-lane {
  flex: 1 1 232px; min-width: 232px; max-width: none; display: flex; flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
}
.pr-lane-head {
  display: flex; align-items: flex-start; gap: 5px; padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 11.5px; font-weight: 600;/* 2026-11-09 用户令：lane 标题完整显示 */
}
/* ⚠️ 2026-11-10 补回上面这条规则的收尾花括号：58ca983 改 lane 标题换行时把块尾的 } 弄丢了，
   浏览器（Chrome 120+ 支持 CSS 嵌套）会把 .pr-lane-name 之后的**全部规则**当成
   .pr-lane-head 的嵌套规则（& .pr-lane-name …）→ 28 条规则失效，其中 .pr-md-view /
   .pr-md-h 一失效，看板正文就掉回宿主 14px、标题掉回浏览器默认 ≈16.4px（用户报「群聊页字体太大」）。 */
.pr-lane-name { min-width: 0; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
.pr-lane-archive {
  margin-left: auto; flex: 0 0 auto; height: 18px; padding: 0 6px; border-radius: 5px;
  border: 1px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 1; cursor: pointer;
}
.pr-lane-archive:hover {
  border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.pr-lane-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.pr-lane-sub {
  padding: 0 8px 4px; font-size: 9.5px; color: var(--dsw-alias-label-secondary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pr-lane-body { flex: 1; min-height: 90px; max-height: 210px; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 5px; }
.pr-lane-msg {
  font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 4px 6px;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  white-space: pre-wrap; word-break: break-word;
}
.pr-lane-msg-user {
  border-left: 2px solid var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
}
.pr-lane-msg-agent { color: var(--dsw-alias-label-secondary); }
/* 看板：渲染视图（纵向滚动）+ 编辑切换 */
.pr-board-section { display: flex; flex-direction: column; min-height: 0; }
.pr-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.pr-board-toggle { height: 22px; padding: 0 9px; font-size: 11px; }
.pr-board-count {
  margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.pr-md-view {
  flex: 1; min-height: 120px; max-height: 42vh; overflow-y: auto;
  padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 1.55;
  word-break: break-word;
}
.pr-md-h { margin: 6px 0 4px; font-size: 12.5px; font-weight: 700; color: var(--dsw-alias-label-primary); }
.pr-md-h:first-child { margin-top: 0; }
.pr-md-p { margin: 2px 0; color: var(--dsw-alias-label-primary); white-space: pre-wrap; }
.pr-md-ul { margin: 3px 0; padding-left: 16px; }
.pr-md-ul li { margin: 1px 0; }
.pr-md-code {
  padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2);
  font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.pr-board-edit { min-height: 200px; max-height: 42vh; }
.pr-board-actions { display: flex; gap: 8px; margin-top: 6px; align-items: center; }
/* 任务线列：消息完整显示 + 列内上下滚动 */
.pr-lane-body { max-height: 300px; overflow-y: auto; }
/* ⚠️ 关键（2026-11-09 根因）：原规则里的 overflow:hidden（给 -webkit-line-clamp 用）只被
   -webkit-line-clamp: unset + display: block 覆盖了外观，overflow 仍然生效。
   而 .pr-lane-body 是 display:flex; flex-direction:column 的滚动容器：flex 子项的
   min-height:auto 只在其 overflow 为 visible 时才等于内容高度；一旦子项自身 overflow:hidden，
   min-height 就解析为 0 → 每条消息被压扁到几像素、全部挤进可视区 →
   scrollHeight 永远等于 clientHeight → 既压扁又不滚。这里必须把 overflow 显式改回 visible，
   再加 flex:0 0 auto 双保险。 */
.pr-lane-msg {
  -webkit-line-clamp: unset;
  display: block;
  overflow: visible;
  flex: 0 0 auto;
  /* 2026-11-11 用户令「任务线卡片正文要显示全，不要省略号」：
     这里原来（aea43437）是 white-space:nowrap + text-overflow:ellipsis + overflow:hidden，
     每条消息被压成一行、末尾挂「…」。改成按内容换行完整显示；overflow 必须回到 visible，
     否则又会踩上面那条 2026-11-09 的坑（flex 子项 min-height 解析成 0 → 压扁不滚）。 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-overflow: clip;
}
.pr-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 6px 0; }
.pr-err { font-size: 11.5px; color: #f87171; padding: 4px 0; }
.pr-send-row { display: flex; gap: 6px; align-items: center; width: 100%; }
.pr-select { max-width: 200px; height: 30px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; }
`;

    function ensureStyle() {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        style.dataset.plugin = 'project-room';
        document.head.appendChild(style);
      }
      if (style.textContent !== CSS) style.textContent = CSS;
      return style;
    }

    /**
 * 从一条会话消息里提取「一句要点」当卡片摘要。
 *
 * 为什么不是盲截断（2026-11-10 分诊纠偏）：直接把前 N 字塞进去，等于把
 * 「### 建议顺手改」「**你问的**」「--- 分隔线」这些格式噪音也搬进任务线卡片。
 * 这里按结构剥：代码块/表格/引用/分隔线/标题符号/固定尾块全部丢掉，
 * 只留第一条真正有信息的正文句子——不保留原文副本（分诊 2026-11-10：存与渲染两端都只留摘要）。
 */
function summarizeMessage(raw) {
  let text = String(raw || '');
  if (!text.trim()) return '';
  // 去掉围栏代码块、行内代码、表格行、引用行、纯分隔线
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ');
  // 逐行挑第一句有内容的
  const lines = text.split(/\r?\n/);
  const NOISE = /^(#{1,6}\s*|\*\*你问的\*\*|\*\*答\*\*|\*\*本轮结果\*\*|你问的|答[：:]|本轮结果[：:]|[-*+]\s+|\d+[.、]\s*)/;
  /* 前导符号噪音（2026-11-11）：模型经常先吐一个 "." 再吐正文，实测 assistant/message 原文形如
     ".## 做完了：…" → 老规则只认行首 # 号，被这个 "." 挡住后整行"##"原样进卡片。
     这里只剥**符号**（不含数字/文字），并按叠加情况剥到不动为止。 */
  const LEAD_SYMBOL = /^[.。，,、;；:：·•…\-*+#>]+\s*/;
  /* 有可见字符才算有内容：纯标点/纯符号（"."、"..."、"…"、"——"）在卡片里只会渲染成一条
     没有文字的灰条，6 条连着看起来就是"骨架屏加载中"（2026-11-11 用户贴图报的就是这个）。 */
  const VISIBLE = /[\p{L}\p{N}]/u;
  for (const line of lines) {
    let s = line.trim();
    if (!s) continue;
    s = s.replace(NOISE, '');
    for (let i = 0; i < 3; i += 1) s = s.replace(LEAD_SYMBOL, '');
    s = s.replace(/\*\*/g, '').trim();
    if (!s || s.length < 4) continue;
    if (!VISIBLE.test(s)) continue;
    // 单行压平（2026-11-11 用户令「任务线卡片正文要显示全，不要省略号」：
    // 原「超 80 字按句读断开、断不了就截 78 字 + …」已删——存进卡片的就是完整一句正文）。
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }
  return '';
}

// ───────────────────────── 侧栏 ─────────────────────────

    function ProjectSidebar(props) {
      const workspaces = props.useWorkspaces((s) => s);
      const sessions = props.useSessions((s) => s);
      const [query, setQuery] = React.useState('');
      const [closed, setClosed] = React.useState(() => loadJson('projectRoom.closed', {}));
      const [pinned, setPinned] = React.useState(() => loadJson('projectRoom.pinned', []));
      const [showLoose, setShowLoose] = React.useState(() => Boolean(loadJson('projectRoom.showLoose', false)));
      const [clearArmed, setClearArmed] = React.useState(false);
      const [clearMsg, setClearMsg] = React.useState('');
      const [menu, setMenu] = React.useState(null);        // { id, name, x, y }
      // 点空白处关闭右键菜单（菜单自身 onMouseDown 已阻止冒泡）
      React.useEffect(() => {
        if (!menu) return undefined;
        const onDown = () => { setMenu(null); setMenuMsg(''); };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
      }, [menu]);
      const [renaming, setRenaming] = React.useState(null); // { id, value }
      const [newProject, setNewProject] = React.useState(null); // { name, member, busy, msg }
      const [settings, setSettings] = React.useState(null); // { manager, msg } 或 null
      const [menuMsg, setMenuMsg] = React.useState('');
      const [room, setRoom] = React.useState(roomBus.current);
      const [tick, setTick] = React.useState(Date.now());
      const [avatars, setAvatars] = React.useState({});
      const [cursorSessionId, setCursorSessionId] = React.useState('');
    // 2026-11-09：手动点击后 3s 内不让宿主属性覆盖 cursor（否则点分身会被 paint 回本体）
    const manualPickUntilRef = React.useRef(0);
    // 2026-11-09 用户报「快捷栏高亮分身之后，本体的高亮要延迟好几秒才消失」：
    // 点击只做了 setCursorSessionId（React 异步重渲染），而 DOM 直改的 paint() 定义在下面的 effect 里，
    // 点不到 → 本体 pill 要等 React 渲染完才灭。这里把 paint 暴露出来，点击时同一帧直接改 DOM。
    const paintRef = React.useRef(null);

      React.useEffect(() => roomBus.subscribe(setRoom), []);

      // 当前打开的会话（用于芯片高亮）：宿主写在会话内容区的 data 属性上。
      // ⚠️ 2026-11-09 用户两次反馈「切换对话后侧栏选中要过好几秒」：
      // 第一版是 setInterval(read, 3000)（最坏延迟 3 秒）→ 换 MutationObserver 仍不够快，
      // 因为真正的瓶颈是**React 全量重渲染侧栏**（195 个会话、多项目、多个 useMemo），
      // 一次 setState 触发的重渲染本身就要几百毫秒甚至更久。
      // 所以这里改成「双层」：
      //   ① 直接改 DOM 的 data-active（绕过 React，同一帧生效，视觉零延迟）；
      //   ② 同时 setState，让 React 树与 DOM 一致（下次渲染不会闪回）。
      // 观察器补 childList:true —— 切换会话时宿主可能整块替换内容区节点而不是改属性。
      React.useEffect(() => {
        const paint = (id) => {
          try {
            const val = String(id || '');
            for (const node of document.querySelectorAll('.pr-chip[data-session-id]')) {
              node.setAttribute('data-active', node.getAttribute('data-session-id') === val ? '1' : '0');
            }
            for (const node of document.querySelectorAll('.pr-run-pill[data-session-ids]')) {
              const ids = String(node.getAttribute('data-session-ids') || '').split(',');
              node.setAttribute('data-active', ids.includes(val) ? '1' : '0');
            }
        // 2026-11-09：分身子行也要跟着切选中态（用户报『侧栏分身没有选中效果』）
        for (const node of document.querySelectorAll('.pr-clone-row[data-session-id]')) {
          node.setAttribute('data-active', node.getAttribute('data-session-id') === val ? '1' : '0');
        }
          } catch { /* 改不动就交给 React */ }
        };
        paintRef.current = paint;
    let lastId = null;
    const read = () => {
      try {
        // 2026-11-09：手动点击后 3s 内不让宿主属性覆盖（否则点分身会被 paint 回本体，
        // 表现为「侧边栏没有单独高亮本体」——其实是一直亮在本体上）。
        if (Date.now() < manualPickUntilRef.current) return;
        const el = document.querySelector('[data-conversation-content]');
        const id = el ? (el.getAttribute('data-conversation-session') || '') : '';
        if (id === lastId) return;
        lastId = id;
        paint(id);              // ① 先让 DOM 立刻变（用户看到的就是这一下）
        setCursorSessionId(id); // ② React 跟上
      } catch { /* 拿不到就不高亮 */ }
    };
        read();
        let observer = null;
        try {
          if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body) {
            observer = new MutationObserver(read);
            observer.observe(document.body, {
              attributes: true,
              attributeFilter: ['data-conversation-session'],
              childList: true,      // 节点被整块替换时也要抓到
              subtree: true,
            });
          }
        } catch { observer = null; }
        // 兜底：observer 不可用 / DOM 整体替换时，2 秒重读一次（正常路径由观察器即时驱动）
        const timer = setInterval(read, 2000);
        return () => {
          if (observer) { try { observer.disconnect(); } catch { /* ignore */ } }
          clearInterval(timer);
        };
      }, []);

      // 头像表（可选增强：有就显示自定义 emoji，没有就退回名字首字符色块）
      React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          try {
            const res = await fetch(`${API}/avatars`);
            const data = await res.json();
            if (!cancelled && data && data.ok && data.avatars) setAvatars(data.avatars);
          } catch { /* 没有头像表就用 fallback */ }
        };
        load();
        const timer = setInterval(load, 60000);   // 一分钟刷新一次，改了头像表不用重启
        return () => { cancelled = true; clearInterval(timer); };

      }, []);
      // ── 幽灵会话「事后隐藏」（2026-11-10 用户令：白名单改事后隐藏）──────────────
      // 背景：曾经用「磁盘活会话白名单」全量过滤（每 120s 拉 /project-room/alive，
      // 不在白名单里的会话直接不显示）。它确实能藏住「前端快照有、磁盘目录没了」的幽灵
      // （归档必报 no such session，DSH 又没有删除 API），但代价是**新建会话要等下一次
      // 轮询才认识** —— 分诊分身只活 30 秒，正好卡在两次轮询之间，侧栏从来没显示过它。
      //
      // 用户 2026-11-10 明确选了「事后隐藏」：默认**不过滤任何会话**，只有真的点归档且
      // 失败时，才把那个 id 记进 localStorage 的隐藏集，下次渲染跳过它。
      // 好处：新会话零延迟显示；幽灵删一次之后就消失。
      const HIDDEN_KEY = 'project-room:hidden-sessions';
      const bareId = (v) => String(v || '').replace(/^session-/, '').toLowerCase();
      const [hiddenIds, setHiddenIds] = React.useState(() => {
        try {
          const raw = window.localStorage.getItem(HIDDEN_KEY);
          const arr = raw ? JSON.parse(raw) : [];
          return new Set(Array.isArray(arr) ? arr.map(bareId) : []);
        } catch (error) { return new Set(); }
      });
      const hideSession = React.useCallback((id) => {
        const bare = bareId(id);
        if (!bare) return;
        setHiddenIds((prev) => {
          if (prev.has(bare)) return prev;
          const next = new Set(prev);
          next.add(bare);
          try {
            window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
          } catch (error) { /* 存不下也不影响本次隐藏 */ }
          return next;
        });
      }, []);
      const unhideAll = React.useCallback(() => {
        setHiddenIds(new Set());
        try { window.localStorage.removeItem(HIDDEN_KEY); } catch (error) { /* ignore */ }
      }, []);

      // 1s 心跳：驱动「今日运行时长」与相对时间
      React.useEffect(() => {
        const timer = setInterval(() => setTick(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);

      const byId = (sessions && sessions.byId) || {};
      const archived = new Set((workspaces && workspaces.archivedSessionIds) || []);

      // 会话 → (项目, 成员) 归组；无法解析标题的会话单独归入「未分组」
      const groups = React.useMemo(() => {
        const map = new Map();
        for (const [id, session] of Object.entries(byId)) {
          if (!session || session.blank) continue;
          if (archived.has(String(id))) continue;
          // 2026-11-10（用户令）：白名单改「事后隐藏」——只跳过**归档失败过**的会话，
          // 不再用磁盘白名单全量过滤（那样会让新建会话因轮询延迟而整段生命期不可见）。
          if (hiddenIds.has(bareId(id))) continue;
          const parsed = projectOfTitle(session.displayTitle || session.title);
          const project = parsed ? parsed.project : LOOSE_GROUP;
          const member = parsed ? parsed.member : (session.displayTitle || session.title || String(id).slice(-6));
      // 2026-11-09 用户报「这两个副手是哪儿来的？删掉」：这是 2026-10 早期概念留下的历史会话
      // （标题「<项目> · <成员>｜副手」，早已不用于新分身）。DSH 没有删除会话的 API，
      // 所以这里在**渲染层**把它们滤掉——不再出现在侧栏/快捷栏，也不再占用 +N 计数。
      if (/｜副手$/.test(String(member || '').trim())) continue;
          if (!map.has(project)) map.set(project, []);
          map.get(project).push({
            id,
            name: member,
            project,
            /** 分身名（父名｜标签）→ base 用于快捷栏聚合 */
            base: String(member).split('｜')[0].trim() || member,
            isClone: String(member).includes('｜'),
            running: Boolean(session.running),
            // 真数据源：会话自带 updatedAt（若有）→ 本地 lastActive 记录
        updatedAt: (session.updatedAt || 0) || lastActiveOf(id),
          });
        }
        return map;
      }, [byId, archived, hiddenIds]);

      // 空闲时长补全（2026-11-09）：对还没有 lastActive 的会话拉 /hub/session-events?limit=1
    // 取最后一条事件的 time。分身（标题带｜）优先——用户最常盯的就是分身行。
    const [, setLastActiveTick] = React.useState(0);
    React.useEffect(() => {
      let cancelled = false;
      const ids = Object.keys(byId)
        .filter((id) => !lastActiveOf(id))
        .sort((a, b) => {
          const isClone = (x) => (String((byId[x] && (byId[x].displayTitle || byId[x].title)) || '').includes('｜') ? 1 : 0);
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
    // 今日运行时长累计（localStorage 持久，按项目与日期分桶）
      // ⚠️ groupsRef 必须先声明再被下面的 effect 使用（hub-desktop-ui 曾因 TDZ 整块侧栏回退）
      const groupsRef = React.useRef(groups);
      groupsRef.current = groups;

      // 运行态账本：runStart 记每个会话本轮 시작时刻；未读记「跑完还没看」的会话
      const runStartRef = React.useRef(new Map());
    // 2026-11-09 用户报「侧边栏的运行计时怎么老是莫名其妙重置」：
    // 原来「这一拍 running=false」就立刻删 runStart → DSH 的 running 投影抖动时会
    // 下一拍又 true 再 set(Date.now()) → 计时从 0 重来。这里记「首次见到 false 的时刻」，
    // 连续 >3s 都没恢复才真正删除。
    const runFalseSinceRef = React.useRef(new Map());
      const prevRunningRef = React.useRef(new Set());
      const [unread, setUnread] = React.useState(() => loadJson('projectRoom.unread', {}));

      React.useEffect(() => {
        const day = dayKey();
        const timer = setInterval(() => {
          let changed = false;
          const runningNow = new Set();
          for (const [project, members] of groupsRef.current) {
            let runningCount = 0;
            for (const member of members) {
              if (member.running) {
                runningCount += 1;
                runningNow.add(member.id);
                if (!runStartRef.current.has(member.id)) runStartRef.current.set(member.id, Date.now());
                runFalseSinceRef.current.delete(member.id);
              } else {
                const falseSince = runFalseSinceRef.current.get(member.id);
                if (!falseSince) {
                  runFalseSinceRef.current.set(member.id, Date.now());
                } else if (Date.now() - falseSince > 3000) {
                  runStartRef.current.delete(member.id);
                  runFalseSinceRef.current.delete(member.id);
                }
              }
            }
            if (!runningCount) continue;
            const key = `projectRoom.runTotal.${project}.${day}`;
            const prev = Number(loadJson(key, 0) || 0);
            saveJson(key, prev + runningCount * 1000);
            changed = true;
          }
          // running → false 的会话记成「完成未读」（当前正看着的那个不算）
          const prevRunning = prevRunningRef.current;
          const finished = [...prevRunning].filter((id) => !runningNow.has(id));
          if (finished.length) {
            const current = currentSessionId();
            const next = { ...loadJson('projectRoom.unread', {}) };
            let touched = false;
            for (const id of finished) {
              if (current && String(current) === String(id)) continue;   // 正在看，直接算已读
              next[id] = { at: Date.now() };
              touched = true;
            }
            if (touched) {
              saveJson('projectRoom.unread', next);
              setUnread(next);
              changed = true;
            }
          }
          prevRunningRef.current = runningNow;
          if (changed) setTick(Date.now());
        }, 1000);
        return () => clearInterval(timer);
      }, []);

      // 把「项目 → 成员」快照交给房间浮层（浮层没有 slot props，只能这样拿）
      React.useEffect(() => {
        roomBus.sessionIndex = groups;
      }, [groups]);

      const projectNames = React.useMemo(() => {
        const names = Array.from(groups.keys());
        const pinnedList = pinned.filter((name) => names.includes(name));
        const rest = names.filter((name) => !pinnedList.includes(name));
        rest.sort((a, b) => {
          const ra = (groups.get(a) || []).some((m) => m.running) ? 1 : 0;
          const rb = (groups.get(b) || []).some((m) => m.running) ? 1 : 0;
          if (ra !== rb) return rb - ra;
          const ta = Math.max(0, ...(groups.get(a) || []).map((m) => m.updatedAt));
          const tb = Math.max(0, ...(groups.get(b) || []).map((m) => m.updatedAt));
          return tb - ta;
        });
        return [...pinnedList, ...rest];
      }, [groups, pinned]);

      // 「未分组」= 标题里没有分隔符的会话（历史测试/一次性对话）。
      // 默认不显示，避免一大坨散落会话把项目列表挤下去；需要时点头部按钮展开。
      const looseAll = groups.get(LOOSE_GROUP) || [];
      // 2026-11-10（用户令）：白名单改「事后隐藏」后，groups 里已经按 hiddenIds 过滤过了，
      // 这里不再二次过滤（否则又回到「新建会话要等白名单」的老问题）。
      const looseMembers = looseAll;
      const shownProjects = React.useMemo(
        () => projectNames.filter((name) => showLoose || name !== LOOSE_GROUP),
        [projectNames, showLoose],
      );

      const q = query.trim().toLowerCase();
      const visible = shownProjects.filter((name) => {
        if (!q) return true;
        if (name.toLowerCase().includes(q)) return true;
        return (groups.get(name) || []).some((m) => m.name.toLowerCase().includes(q));
      });

      const totalSessions = Array.from(groups.values()).reduce((acc, list) => acc + list.length, 0);

      // ── 运行中快捷栏（对齐 AI-Agent-Hub 侧栏）：按「项目 + 父名」聚合，分身折成 +N ──
      const unreadMap = unread && typeof unread === 'object' ? unread : {};
      const runGroups = React.useMemo(() => {
        const all = [];
        for (const [project, members] of groups) {
          for (const member of members) {
            // 分身一律不进快捷栏：它只在本体芯片的树里显示（避免同一个会话出现两处）
            // 分身允许进快捷栏：归到父组的 clones，在 pill 下方以树状子行显示（与侧栏芯片一致）
            const isUnread = !member.running && unreadMap[member.id];
            if (!member.running && !isUnread) continue;
            all.push({ ...member, done: !member.running });
          }
        }
        const buckets = new Map();
        for (const item of all) {
          // 分身且有父会话 → 归父组；否则自成一组
          let key = `${item.project}\u0000${item.base}`;
          let groupName = item.base;
          if (item.isClone) {
            const hasParent = (groups.get(item.project) || []).some((m) => !m.isClone && m.base === item.base);
            if (!hasParent) { key = `${item.project}\u0000${item.name}`; groupName = item.name; }
          }
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = { key, project: item.project, name: groupName, running: [], done: [], clones: [] };
            buckets.set(key, bucket);
          }
          if (item.done) bucket.done.push(item); else bucket.running.push(item);
          if (item.isClone) bucket.clones.push(item);
        }
        return [...buckets.values()].map((bucket) => {
          const members = [...bucket.running, ...bucket.done];
          const openTarget = members.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
          return {
            ...bucket,
            members,
            openTarget,
            mode: bucket.running.length ? 'running' : 'done',
            extra: bucket.clones.length,
          };
        }).sort((a, b) => {
          if (a.mode !== b.mode) return a.mode === 'done' ? -1 : 1;   // 完成未读置顶
          return (b.openTarget?.updatedAt || 0) - (a.openTarget?.updatedAt || 0);
        });
      }, [groups, unreadMap]);

      // 2026-11-11 用户令「快捷栏正在运行和完成未读的分开放」：
      // 原来两种 pill 混在一个 flex 行里（完成未读还置顶排最前），用户扫一眼分不清谁在跑。
      // 现在拆成两个区、各带标题；渲染顺序按用户第二次要求 = **完成未读在上、运行中在下**。
      const runningGroups = runGroups.filter((group) => group.mode === 'running');
      const doneUnreadGroups = runGroups.filter((group) => group.mode === 'done');
      // 完成未读的组数（决定是否显示「全部已读」按钮）
      const doneGroups = doneUnreadGroups.length;

      const setPin = (name) => {
        const next = pinned.includes(name) ? pinned.filter((n) => n !== name) : [...pinned, name];
        setPinned(next);
        saveJson('projectRoom.pinned', next);
      };

      const toggleClosed = (name) => {
        const next = { ...closed, [name]: !closed[name] };
        setClosed(next);
        saveJson('projectRoom.closed', next);
      };

      /**
       * 渲染一个「运行中/完成未读」快捷 pill：一个父名一个 pill，分身折成 +N 小标签。
       * 对齐 AI-Agent-Hub 侧栏快捷栏：emoji 头像 + 项目色点与名 + agent 名 + 绿点/✓ + 时长。
       */
      const renderRunPill = (group) => {
        const target = group.openTarget;
        if (!target) return null;
      // 2026-11-09 用户令「本体和分身选中分开」：pill 只在**当前打开的是本体**时高亮，
      // 打开分身时只让分身行高亮（原来用 group.members.some，含分身 → 两个都亮）。
      const bodyIds = group.members.filter((m) => !m.isClone).map((m) => String(m.id));
      const isCurrent = Boolean(cursorSessionId) && bodyIds.includes(String(cursorSessionId));
      const done = group.mode === 'done';
      // 2026-11-11 修「本体没有运行、快捷栏还在显示计时，而侧边栏正常」（用户截图）：
      // 这个 pill 代表的是**本体**——名字取 group.name（本体名）、点击开本体、data-session-ids
      // 也只有本体。所以绿点与已运行时长必须来自**本体自己的 running**。
      // 原实现取 `group.running` 里最近活跃的那个成员：分身还在跑时，那一项就是分身，
      // 于是分身的已运行时长被画到本体 pill 上（截图里 pill 的 2m29s 与分身子行的 2m29s
      // 完全相等，而侧栏本体芯片没有时长 = 本体当时是空闲的）。
      // 侧栏一直是对的：本体芯片按 m.running 判、分身行按 c.running 判，两条各算各的。
      // 分身的运行状态由下面 .pr-run-clones 子行自己显示，信息不丢。
      // 孤儿分身组（本体已归档/改名，group.name 就是分身名）没有本体可参照 → 仍用组内运行成员。
      const bodyMemberOfGroup = (() => {
        const list = (groups && typeof groups.get === 'function') ? (groups.get(group.project) || []) : [];
        return list.find((m) => !m.isClone && m.name === group.name) || null;
      })();
      const runMember = (bodyMemberOfGroup ? [bodyMemberOfGroup] : (group.running.length ? group.running : group.members))
        .filter((m) => m && m.running)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      const bodyRunning = Boolean(runMember);
        const startedAt = runMember ? runStartRef.current.get(runMember.id) : undefined;
        const elapsed = !done && bodyRunning && startedAt ? formatDuration(tick - startedAt) : '';
        const emoji = avatars && typeof avatars[group.name] === 'string' ? avatars[group.name].trim() : '';
        const hue = hashHue(group.project || group.name);
    return h('div', { className: 'pr-run-wrap', key: 'wrap-' + group.key }, h('button', {
          key: `run-${group.key}`,
          type: 'button',
          className: 'pr-run-pill',
          'data-mode': group.mode,
                // 2026-11-09 用户令「本体和分身选中分开」：pill 的 data-active 只看**本体**，
                // 原来放全组成员 → 点分身时 pill（代表本体）也一起高亮。
                'data-session-ids': group.members.filter((mb) => !mb.isClone).map((mb) => String(mb.id)).join(','),
          title: `${group.project ? group.project + ' · ' : ''}${group.name}`
            // 2026-11-11：不再对空闲的本体谎称「运行中」——本体没跑时 pill 只报「分身运行中」。
            + (done ? ' · 完成待查看'
              : (bodyRunning ? (elapsed ? ` · 运行中 ${elapsed}` : ' · 运行中') : ' · 本体空闲（分身运行中）'))
            + (group.extra ? `（含 ${group.extra} 个分身）` : ''),
          onClick: (event) => {
            event.stopPropagation();
            // 点开即清该组的未读
            if (done) {
              const next = { ...unreadMap };
              for (const member of group.members) delete next[member.id];
              saveJson('projectRoom.unread', next);
              setUnread(next);
            }
              // 打开会话前先关掉房间：否则房间盖在对话区上，用户看不到刚切过去的会话
              roomBus.close();
    // 2026-11-09 用户两次报「快捷栏还是点不了本体，还是会跳到分身」的真因：
    // 原实现 openSessionById(group.parentId || target.id)，而 target = 组内最近活跃成员
    // —— 父会话冷/归档/改名时 parentId 为空，就落到最近活跃的**分身**上。
    // 现在显式现查本体：同项目 + 同成员名 + 不是分身；查不到就只提示、不跳（绝不打开分身）。
    const projMembers = (groups && typeof groups.get === 'function') ? (groups.get(group.project) || []) : [];
    const bodyMember = projMembers.find((x) => !x.isClone && x.name === group.name);
    if (!bodyMember) {
      setNotice(`找不到「${group.name}」的本体会话（可能已归档或改名）——不跳转，避免误开分身`);
      return;
    }
              // 2026-11-09 用户报「在快捷栏选本体的时候高亮怎么没变」：pill 的 onClick 只 openSessionById，
              // 没有像芯片/分身行那样 setCursorSessionId + paintRef，所以点了 pill 高亮不动。这里补齐。
              if (paintRef.current) paintRef.current(String(bodyMember.id));
              setCursorSessionId(String(bodyMember.id));
              manualPickUntilRef.current = Date.now() + 3000;
    openSessionById(bodyMember.id);
          },
        },
        h('span', {
          className: 'pr-run-avatar',
          style: emoji
            ? { fontSize: '12px', fontWeight: 600, color: 'inherit', background: 'transparent' }
            : { fontSize: '9px', fontWeight: 600, color: '#fff', background: `hsl(${hue} 40% 40%)` },
        }, emoji || (String(group.name).trim()[0] || '·').toUpperCase()),
        group.project
          ? h('span', { className: 'pr-run-project', title: `所属项目：${group.project}` },
            h('span', { className: 'pr-run-project-dot', style: { background: `hsl(${hue} 45% 50%)` } }),
            h('span', { className: 'pr-run-project-name', style: { color: `hsl(${hue} 50% 68%)` } }, group.project),
          )
          : null,
        h('span', { className: 'pr-run-name' }, group.name),
        group.extra > 0 ? h('span', { className: 'pr-run-badge', title: `${group.extra} 个分身` }, `+${group.extra}`) : null,
        done
          ? h('span', { className: 'pr-run-done', title: '已完成，点开查看' }, h('span', { className: 'pr-run-check' }, '✓'), '完成')
          // 2026-11-11：绿点也只跟本体走——本体空闲、只剩分身在跑时不给本体挂绿点
          // （分身子行自己有 pr-clone-dot.on，不丢状态）。
          : (bodyRunning ? h('span', { className: 'pr-running-dot', title: '运行中' }) : null),
        elapsed ? h('span', { className: 'pr-run-elapsed' }, elapsed) : null,
    ),
    group.clones && group.clones.length
      ? h('div', { className: 'pr-run-clones' },
        group.clones.map((clone, index) => h('div', {
          className: 'pr-clone-row',
              'data-active': String(cursorSessionId || '') === String(clone.id) ? '1' : '0',
              'data-session-id': String(clone.id),
          key: `run-clone-${clone.id}`,
          title: clone.name,
          onClick: (event) => {
            event.stopPropagation();
            roomBus.close();
            if (paintRef.current) paintRef.current(String(clone.id));   // 同一帧先改 DOM，别等 React
                      setCursorSessionId(String(clone.id));
            manualPickUntilRef.current = Date.now() + 3000;
            openSessionById(clone.id);
          },
        },
        h('span', { className: 'pr-tree-rail' },
          index === group.clones.length - 1 ? '└' : '├'),
        h('span', {
          className: `pr-clone-dot${clone.running ? ' on' : ''}`,
        }),
            h('span', { className: 'pr-clone-name' },
              String(clone.name).split('｜').pop()),
            // 2026-11-09 用户三次报「快捷栏的分身还是没有显示运行时间」：这里（快捷栏 pill 的分身树子行）
            // 之前**只有 ├/└ + 圆点 + 名字**，根本没有时长渲染。上次改的是侧栏芯片那条路径，不是这条。
            (() => {
              const cStarted = runStartRef.current.get(clone.id);
              const cElapsed = clone.running && cStarted ? formatDuration(tick - cStarted) : '';
              const cLast = clone.updatedAt || 0;
              if (!cElapsed && (!cLast || !showIdleAgo)) return null;
              return h('span', {
                className: clone.running ? 'pr-clone-elapsed' : 'pr-clone-elapsed idle',
                title: clone.running ? `已运行 ${cElapsed}` : '距上次活动',
              }, clone.running && cElapsed ? cElapsed : relTime(cLast));
            })(),
        )))
      : null,
    );
      };

      const archiveLoose = async () => {
        const list = groups.get(LOOSE_GROUP) || [];
        if (!list.length) { setClearMsg('没有未分组的会话'); return; }
        if (!clearArmed) {
          // 两段式确认：桌面端 window.confirm 可能被静默拦掉，改用按钮自身状态
          setClearArmed(true);
          setClearMsg(`再点一次「确认清理」→ 归档 ${list.length} 个（4 秒后自动取消）`);
          setTimeout(() => { setClearArmed(false); setClearMsg(''); }, 4000);
          return;
        }
        setClearArmed(false);
        setClearMsg(`正在归档 ${list.length} 个…`);
        try {
          const res = await fetch(`${API}/archive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: list.map((m) => m.id) }),
          });
          const data = await res.json();
          if (data && data.ok) {
            // 2026-11-10（用户令「事后隐藏」）：归档失败 = 磁盘上根本没这个会话（幽灵）。
            // 既然删不掉，就记进隐藏集，下次渲染跳过它。
            const failedList = Array.isArray(data.failed) ? data.failed : [];
            for (const f of failedList) hideSession(f && f.id);
            const failNote = failedList.length
              ? `，失败 ${failedList.length}（${String((failedList[0] && failedList[0].error) || '').slice(0, 60)}；已隐藏）`
              : '';
            setClearMsg(`已归档 ${data.archived}/${data.total}${failNote}`);
            console.log('[project-room] archive result', data);
          } else {
            setClearMsg(`失败：${(data && data.error) || '未知'}`);
          }
        } catch (error) {
          setClearMsg(`失败：${String((error && error.message) || error)}`);
        }
      };

      /** 右键菜单：改名 / 归档 / 复制 sessionId / 复制标题 */
      const renderMenu = () => {
        if (!menu) return null;
        const close = () => { setMenu(null); setMenuMsg(''); };
        const copy = async (text, label) => {
          try {
            await navigator.clipboard.writeText(text);
            setMenuMsg(`已复制${label}`);
          } catch {
            setMenuMsg('复制失败（剪贴板不可用）');
          }
        };
        return h('div', {
          className: 'pr-menu',
          onMouseDown: (event) => event.stopPropagation(),
          style: { left: `${menu.x}px`, top: `${menu.y}px` },
          onClick: (event) => event.stopPropagation(),
          onContextMenu: (event) => { event.preventDefault(); event.stopPropagation(); },
        },
        h('button', { className: 'pr-menu-item', onClick: () => { setRenaming({ id: menu.id, value: menu.name }); close(); } }, '改名…'),
        h('button', {
          className: 'pr-menu-item',
          onClick: async () => {
            setMenuMsg('归档中…');
            try {
              const res = await fetch(`${API}/archive`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: [menu.id] }),
              });
              const data = await res.json();
              const okArchived = Boolean(data && data.ok && data.archived);
              if (okArchived) {
                setMenuMsg('已归档');
              } else {
                // 2026-11-10（用户令「事后隐藏」）：单个归档失败 = 幽灵会话，记进隐藏集。
                hideSession(menu.id);
                const reason = (data && data.failed && data.failed[0] && data.failed[0].error)
                  || (data && data.error) || '未知';
                setMenuMsg(`失败：${reason}（已隐藏）`.slice(0, 90));
              }
            } catch (error) {
              hideSession(menu.id);
              setMenuMsg(`失败：${String((error && error.message) || error)}（已隐藏）`.slice(0, 90));
            }
          },
        }, '归档这个会话'),
        h('button', { className: 'pr-menu-item', onClick: () => { copy(menu.id, ' sessionId'); } }, '复制 sessionId'),
        h('button', { className: 'pr-menu-item', onClick: () => { copy(menu.name, '标题'); } }, '复制标题'),
        h('button', { className: 'pr-menu-item', onClick: close }, '关闭'),
        menuMsg ? h('div', { className: 'pr-menu-msg' }, menuMsg) : null,
        );
      };

      /** 设置：项目管理者名称（默认 Yat2，存 localStorage） */
      const renderSettings = () => {
        if (!settings) return null;
        const save = () => {
          const name = String(settings.manager || '').trim();
          if (!name) { setSettings({ ...settings, msg: '名称不能为空' }); return; }
          try { window.localStorage.setItem('projectRoom.managerName', name); } catch { /* 存不了就本次生效 */ }
          setSettings(null);
        };
        return h('div', { className: 'pr-modal', onClick: () => setSettings(null) },
          h('div', { className: 'pr-modal-box', onClick: (event) => event.stopPropagation() },
            h('div', { className: 'pr-modal-title' }, '设置'),
            h('div', { className: 'pr-hint' }, '项目管理者名称（排序时永远排第一、新建项目的默认成员名）'),
            h('input', {
              className: 'pr-modal-input',
              value: settings.manager || '',
              autoFocus: true,
              placeholder: DEFAULT_MANAGER,
              onChange: (event) => setSettings({ ...settings, manager: event.target.value, msg: '' }),
              onKeyDown: (event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setSettings(null); },
            }),
            h('div', { className: 'pr-hint', style: { marginTop: '6px' } },
              '注意：这只影响本插件的排序与默认名。若要让「管理者协议注入」也认这个名字，'
              + '还需要改 hub-desktop-ui 里的 MANAGER_NAMES（那是另一个插件的硬编码）。'),
            settings.msg ? h('div', { className: 'pr-err' }, settings.msg) : null,
      // 2026-11-10（用户令「事后隐藏」）：归档失败过的会话被记进 localStorage 隐藏集，
      // 这里提供恢复入口，免得误隐藏之后找不回来。
      h('div', { className: 'pr-hint', style: { marginTop: '10px' } },
        `已隐藏的会话：${hiddenIds.size} 个`),
      h('button', {
        type: 'button',
        disabled: hiddenIds.size === 0,
        style: {
          marginTop: '4px', padding: '4px 10px', borderRadius: '6px', fontSize: '11px',
          border: '1px solid var(--dsw-alias-border-secondary, #3a3a42)',
          background: 'transparent', color: 'inherit',
          cursor: hiddenIds.size === 0 ? 'default' : 'pointer',
          opacity: hiddenIds.size === 0 ? 0.45 : 1,
        },
        onClick: () => { unhideAll(); setSettings({ ...settings, msg: '已恢复全部隐藏的会话' }); },
      }, '恢复全部隐藏的会话'),
      h('div', { className: 'pr-hint', style: { fontSize: '10px' } },
        '（这些是归档时报 no such session 的幽灵会话，磁盘上已不存在；恢复后会重新出现在侧栏）'),
      h('div', { className: 'pr-hint', style: { marginTop: '10px' } }, '显示'),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer', padding: '3px 0' } },
        h('input', {
          type: 'checkbox',
          checked: showIdleAgo,
          onChange: (event) => {
            setShowIdleAgo(event.target.checked);
            setSettings({ ...settings });   // 触发重渲染
          },
        }),
        h('span', null, '显示「多久前运行 / 距上次活动」'),
      ),
      h('div', { className: 'pr-hint', style: { fontSize: '10px' } },
        '关闭后空闲项不再显示相对时间，运行中仍显示本轮已运行时长。'),
            h('div', { className: 'pr-modal-actions' },
              h('button', { className: 'pr-btn', onClick: () => setSettings(null) }, '取消'),
              h('button', { className: 'pr-btn primary', onClick: save }, '保存'),
            ),
          ),
        );
      };

      /** 新建项目弹窗：建会话 → 按「项目 · 成员」命名 → 初始化看板 */
      const renderNewProject = () => {
        if (!newProject) return null;
        const submit = async () => {
          const project = String(newProject.name || '').trim();
          const member = String(newProject.member || managerName()).trim() || managerName();
          if (!project) return;
          setNewProject({ ...newProject, busy: true, msg: '创建中…' });
          try {
            const svc = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null;
            if (!svc) { setNewProject({ ...newProject, busy: false, msg: 'uiWorkspace 不可用' }); return; }
            const items = (workspaces && workspaces.items) || [];
            const workspaceId = items.length ? items[0].workspaceId : undefined;
            let sessionId = '';
            if (typeof svc.connectWorkspace === 'function' && workspaceId !== undefined) {
              const raw = await svc.connectWorkspace(workspaceId, { agentPreset: 'cordis' });
              sessionId = typeof raw === 'string' ? raw : ((raw && (raw.sessionId || raw.id)) || '');
            }
            if (!sessionId && typeof svc.startSession === 'function') {
              svc.startSession(workspaceId, { agentPreset: 'cordis' });
            }
            if (sessionId) {
              await fetch(`${API}/rename`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, title: `${project} · ${member}` }),
              });
            }
            // 初始化房间看板（不存在则建模板）
            try { await fetch(`${API}/board?project=${encodeURIComponent(project)}`, { method: 'POST' }); } catch { /* 看板可选 */ }
            setNewProject(null);
          } catch (error) {
            setNewProject({ ...newProject, busy: false, msg: `失败：${String((error && error.message) || error)}` });
          }
        };
        return h('div', { className: 'pr-modal', onClick: () => (newProject.busy ? null : setNewProject(null)) },
          h('div', { className: 'pr-modal-box', onClick: (event) => event.stopPropagation() },
            h('div', { className: 'pr-modal-title' }, '新建项目'),
            h('input', {
              className: 'pr-modal-input',
              placeholder: '项目名，例如 骨骼微环境',
              value: newProject.name || '',
              autoFocus: true,
              onChange: (event) => setNewProject({ ...newProject, name: event.target.value, msg: '' }),
              onKeyDown: (event) => { if (event.key === 'Enter') submit(); if (event.key === 'Escape') setNewProject(null); },
            }),
            h('div', { style: { height: '8px' } }),
            h('input', {
              className: 'pr-modal-input',
              placeholder: `成员的 agent 名（默认 ${managerName()}）`,
              value: newProject.member || '',
              onChange: (event) => setNewProject({ ...newProject, member: event.target.value, msg: '' }),
              onKeyDown: (event) => { if (event.key === 'Enter') submit(); if (event.key === 'Escape') setNewProject(null); },
            }),
            h('div', { style: { marginTop: '6px', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' } },
              `创建后会话标题为「${String(newProject.name || '项目名').trim()} · ${String(newProject.member || 'Yat2').trim() || 'Yat2'}」`),
            newProject.msg ? h('div', { className: 'pr-hint' }, newProject.msg) : null,
            h('div', { className: 'pr-modal-actions' },
              h('button', { className: 'pr-btn', onClick: () => setNewProject(null), disabled: newProject.busy }, '取消'),
              h('button', { className: 'pr-btn primary', onClick: submit, disabled: newProject.busy }, newProject.busy ? '创建中…' : '创建'),
            ),
          ),
        );
      };

      /** 改名弹窗（双击芯片或右键「改名…」触发） */
      const renderRename = () => {
        if (!renaming) return null;
        const submit = async () => {
          const title = String(renaming.value || '').trim();
          if (!title) return;
          try {
            const res = await fetch(`${API}/rename`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: renaming.id, title }),
            });
            const data = await res.json();
            if (data && data.ok) { setRenaming(null); return; }
            setMenuMsg(`改名失败：${(data && data.error) || '未知'}`);
          } catch (error) {
            setMenuMsg(`改名失败：${String((error && error.message) || error)}`);
          }
        };
        return h('div', { className: 'pr-modal', onClick: () => setRenaming(null) },
          h('div', { className: 'pr-modal-box', onClick: (event) => event.stopPropagation() },
            h('div', { className: 'pr-modal-title' }, '改会话标题'),
            h('input', {
              className: 'pr-modal-input',
              value: renaming.value,
              autoFocus: true,
              onChange: (event) => setRenaming({ ...renaming, value: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') submit();
                if (event.key === 'Escape') setRenaming(null);
              },
            }),
            h('div', { className: 'pr-modal-actions' },
              h('button', { className: 'pr-btn', onClick: () => setRenaming(null) }, '取消'),
              h('button', { className: 'pr-btn primary', onClick: submit }, '保存'),
            ),
          ),
        );
      };

      return h('div', { className: 'pr-root' },
        renderMenu(),
        renderRename(),
        renderNewProject(),
        renderSettings(),
        h('div', { className: 'pr-runbar' },
          // ── 区①：完成未读（2026-11-11 用户令：这一区排在运行中前面；一键已读只清这一区）──
          doneUnreadGroups.length
            ? h('div', { className: 'pr-runbar-sec', 'data-kind': 'done' },
              h('div', { className: 'pr-runbar-sec-title' },
                h('span', { className: 'pr-runbar-sec-check' }, '✓'),
                h('span', { className: 'pr-runbar-sec-label' }, '完成未读'),
                h('span', { className: 'pr-runbar-sec-count' }, String(doneUnreadGroups.length)),
                h('button', {
                  className: 'pr-readall',
                  title: `全部已读（清掉 ${doneGroups} 个完成待查看）`,
                  onClick: (event) => {
                    event.stopPropagation();
                    saveJson('projectRoom.unread', {});
                    setUnread({});
                  },
                }, '全部已读'),
              ),
              h('div', { className: 'pr-runbar-sec-body' }, doneUnreadGroups.map(renderRunPill)),
            )
            : null,
          // ── 区②：运行中 ──
          runningGroups.length
            ? h('div', { className: 'pr-runbar-sec', 'data-kind': 'running' },
              h('div', { className: 'pr-runbar-sec-title' },
                h('span', { className: 'pr-runbar-sec-dot', title: '有 agent 正在运行' }),
                h('span', { className: 'pr-runbar-sec-label' }, '运行中'),
                h('span', { className: 'pr-runbar-sec-count' }, String(runningGroups.length)),
              ),
              h('div', { className: 'pr-runbar-sec-body' }, runningGroups.map(renderRunPill)),
            )
            : null,
        ),
        h('div', { className: 'pr-head' },
          h('span', { className: 'pr-head-title' }, 'Projects'),
          h('span', { className: 'pr-head-count' }, `${shownProjects.length} 项目 · ${totalSessions} agent`),
          h('button', { className: 'pr-new-btn', title: '新建项目（会按「项目 · 成员」命名新会话）', onClick: () => setNewProject({ name: '', member: managerName(), busy: false, msg: '' }) }, '+ 新项目'),
          h('button', { className: 'pr-new-btn', title: '设置项目管理者名称', onClick: () => setSettings({ manager: managerName(), msg: '' }) }, '⚙'),
        ),
        looseMembers.length
          ? h('div', { className: 'pr-loose-row' },
            h('button', {
              className: 'pr-loose-toggle',
              title: showLoose ? '隐藏标题里没有分隔符的会话' : `显示 ${looseMembers.length} 个标题里没有分隔符的会话（多为历史测试）`,
              onClick: () => {
                const next = !showLoose;
                setShowLoose(next);
                saveJson('projectRoom.showLoose', next);
              },
            }, `${showLoose ? '▾' : '▸'} 未分组 ${looseMembers.length}`),
            h('button', {
              className: 'pr-loose-toggle',
              title: '把这些没有项目前缀的会话归档（可恢复）',
              onClick: archiveLoose,
            }, clearArmed ? '确认清理' : '清理'),
            clearMsg ? h('span', { className: 'pr-loose-msg' }, clearMsg) : null,
          )
          : null,
        h('div', { className: 'pr-search' },
          h('input', {
            type: 'text',
            value: query,
            placeholder: '搜索项目 / agent',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Escape') setQuery(''); },
          }),
          query
            ? h('button', { className: 'pr-icon-btn', title: '清空搜索', onClick: () => setQuery('') }, '×')
            : null,
        ),
        visible.length === 0
          ? h('div', { className: 'pr-empty' }, q ? '没有匹配的项目或 agent' : '还没有会话')
          : visible.map((name, index) => {
            const members = groups.get(name) || [];
            const isClosed = !q && Boolean(closed[name]);
            const isPinned = pinned.includes(name);
            const latest = Math.max(0, ...members.map((m) => m.updatedAt));
            const anyRunning = members.some((m) => m.running);
            const day = dayKey();
            const runTotal = Number(loadJson(`projectRoom.runTotal.${name}.${day}`, 0) || 0);
            return h('section', {
              key: name,
              style: index > 0
                ? { borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: '6px', paddingTop: '6px', marginBottom: '4px' }
                : { marginBottom: '4px' },
            },
            h('div', {
              className: `pr-proj${room === name ? ' open' : ''}`,
              title: `${name} · 点击进入项目房间`,
              onClick: () => roomBus.open(name),
            },
            h('span', { className: 'pr-dot', style: { background: `hsl(${hashHue(name)} 45% 50%)` } }),
            h('span', { className: 'pr-proj-name', style: { color: `hsl(${hashHue(name)} 50% 68%)` } }, name),
            h('span', { className: 'pr-spacer' }),
            anyRunning ? h('span', { className: 'pr-meta', title: '有 agent 正在运行', style: { color: 'var(--dsw-alias-brand-primary)' } }, '●') : null,
            runTotal > 0
              ? h('span', { className: 'pr-meta', title: '今日该项目所有 agent 累计运行时长' }, `今日运行 ${formatDuration(runTotal)}`)
              : null,
            latest ? h('span', { className: 'pr-meta' }, relTime(latest)) : null,
            h('button', {
              className: 'pr-icon-btn pr-pin',
              'data-pinned': isPinned ? '1' : '0',
              title: isPinned ? '取消置顶' : '置顶到项目列表顶部',
              onClick: (event) => { event.stopPropagation(); setPin(name); },
            }, isPinned ? '★' : '☆'),
            h('button', {
              className: 'pr-icon-btn',
              title: isClosed ? '展开' : '折叠',
              onClick: (event) => { event.stopPropagation(); toggleClosed(name); },
            }, isClosed ? '▸' : '▾'),
            ),
            isClosed ? null : h('div', { className: 'pr-grid' },
                // ⚠️ 有本体的分身不单独出芯片：它只在下面本体的树里显示。
                // 否则一个分身会同时占「自己的芯片」和「本体芯片的 └─ 子行」两处（用户两次报的重复）。
                members
                  .slice()
                  .filter((m) => {
                    if (!m.isClone) return true;
                    return !members.some((other) => !other.isClone && other.base === m.base);
                  })
                  // 排序：**Yat2 永远排第一**（用户令：它是项目管理者），其后运行中优先，
                  // 同档内按最近活跃倒序。
                  .sort((a, b) => (memberRank(a) - memberRank(b)) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
                  .map((m) => {
                    const emoji = avatars && typeof avatars[m.name] === 'string' ? avatars[m.name].trim() : '';
                    const initial = (String(m.name || '·').trim()[0] || '·').toUpperCase();
                    const startedAt = runStartRef.current.get(m.id);
                    const elapsed = m.running && startedAt ? formatDuration(tick - startedAt) : '';
                    // 该 agent 的分身（同名不同项目不算；这里按「项目 + base 名」聚合）
                    const cloneList = m.isClone ? [] : members.filter((x) => x.isClone && x.base === m.base && x.id !== m.id);
                    return h('button', {
                      key: m.id,
                      type: 'button',
                      className: 'pr-chip',
                        'data-session-id': m.id,
                      'data-active': String(cursorSessionId || '') === String(m.id) ? '1' : '0',
                      title: `${m.name} · ${m.running ? '运行中' : '空闲'}${elapsed ? ' ' + elapsed : ''}${m.updatedAt ? ' · ' + relTime(m.updatedAt) : ''}`,
                      onContextMenu: (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMenu({ id: m.id, name: m.name, x: event.clientX, y: event.clientY });
                      },
                      onDoubleClick: (event) => {
                        event.stopPropagation();
                        setRenaming({ id: m.id, value: m.name });
                      },
                      onClick: (event) => {
                        event.stopPropagation();
                        // 点成员 = 要看这个对话：先关房间，否则房间会盖住对话区
                        roomBus.close();
                      // 2026-11-09 用户报「侧边栏还是没有单独高亮本体」：openSessionById 之后依赖宿主回写
                      // data-conversation-session 才更新 cursor；分身点击时它有时不回写 → 本体芯片一直亮。
                      // 这里点击即认账，不依赖宿主。
                      if (paintRef.current) paintRef.current(String(m.id));   // 同一帧先改 DOM，别等 React
                      setCursorSessionId(String(m.id));
                      manualPickUntilRef.current = Date.now() + 3000;
                        if (!openSessionById(m.id)) {
                          console.warn('[project-room] uiWorkspace.openSession 不可用，无法打开会话');
                        }
                      },
                    },
                    // 本体那一行单独成盒，选中背景只作用在它上面（布局已在隔离 HTML + headless Chrome 验证）
                    h('span', { className: 'pr-chip-head' },
                      h('span', {
                        className: 'pr-avatar',
                      style: emoji
                        ? { fontSize: '12px', fontWeight: 600, color: 'inherit', background: 'transparent' }
                        : { fontSize: '9px', fontWeight: 600, color: '#fff', background: `hsl(${hashHue(m.name)} 40% 40%)` },
                    }, emoji || initial),
                    h('span', { className: 'pr-chip-name' }, m.name),
                    cloneList.length
                      ? h('span', { className: 'pr-chip-badge', title: `${cloneList.length} 个分身 · 见下方子行，点哪个开哪个的独立对话（分列视图已于 2026-11-09 取消）` }, `+${cloneList.length}`)
                      : null,
                    m.running ? h('span', { className: 'pr-running-dot', title: '运行中' }) : null,
              // 2026-11-09：空闲也显示（原实现 elapsed 为空就 null）。运行中=已运行，空闲=距上次活动。
              (() => {
                const mLast = m.updatedAt || 0;
                  if (!elapsed && (!mLast || !showIdleAgo)) return null;
                return h('span', {
                  className: elapsed ? 'pr-chip-elapsed' : 'pr-chip-elapsed idle',
                  title: elapsed ? `已运行 ${elapsed}` : '距上次活动',
                }, elapsed || relTime(mLast));
              })(),
                    ),
                    cloneList.length
                      ? h('div', { className: 'pr-chip-clones' },
                        cloneList.slice().sort((a, b) => (memberRank(a) - memberRank(b)) || ((b.updatedAt || 0) - (a.updatedAt || 0))).map((c, cloneIndex, arr) => h('div', {
                          key: c.id,
                          className: 'pr-clone-row',
              'data-active': String(cursorSessionId || '') === String(c.id) ? '1' : '0',
              'data-session-id': String(c.id),
                          title: `${c.name} · ${c.running ? '运行中' : '空闲'}`,
                          onClick: (event) => {
                            event.stopPropagation();
                            roomBus.close();
                            if (paintRef.current) paintRef.current(String(c.id));   // 同一帧先改 DOM，别等 React
                      setCursorSessionId(String(c.id));
                            manualPickUntilRef.current = Date.now() + 3000;
                            openSessionById(c.id);
                          },
                        },
            h('span', { className: 'pr-tree-rail' }, cloneIndex < arr.length - 1 ? '├' : '└'),
            h('span', { className: `pr-clone-dot${c.running ? ' on' : ''}` }),
            h('span', { className: 'pr-clone-name' }, c.name.split('｜').pop() || c.name),
            // 2026-11-09 用户两次报「分身还是没有显示计时」：这里原来**没有任何时长渲染**。
            // 口径与本体芯片一致：运行中=已运行时长（绿），空闲=距上次活动（次要色）。
            (() => {
              const startedAt = runStartRef.current.get(c.id);
              const cElapsed = c.running && startedAt ? formatDuration(tick - startedAt) : '';
              const cLast = c.updatedAt || 0;
              if (!cElapsed && (!cLast || !showIdleAgo)) return null;
              return h('span', {
                className: c.running ? 'pr-clone-elapsed' : 'pr-clone-elapsed idle',
                title: c.running ? `已运行 ${cElapsed}` : '距上次活动',
              }, c.running && cElapsed ? cElapsed : relTime(cLast));
            })(),
                        )),
                      )
                      : null,
                    );
                  }),
            ),
            );
          }),
      );
    }

    // ───────────────────────── 房间浮层 ─────────────────────────

    function ProjectRoom() {
      const [project, setProject] = React.useState(roomBus.current);
      const [board, setBoard] = React.useState('');
      const [boardDirty, setBoardDirty] = React.useState(false);
      const [boardEditing, setBoardEditing] = React.useState(false);
      const [tasks, setTasks] = React.useState(null);
      // 2026-11-12：任务线不绑成员 → 卡片消息按 routing（eventId → 线 id）归线。
      // /hub/tasks 的 routing 是顶层字段，setTasks 只存 tasks 数组，所以单独存一份。
      const [routingMap, setRoutingMap] = React.useState({});
      const [archiving, setArchiving] = React.useState(null);   // { taskId, armed } 两段式确认
      const [taskTick, setTaskTick] = React.useState(0);        // 加一即重拉 tasks.json
      const [members, setMembers] = React.useState([]);
      // 任务线分列：每个成员一列，列内显示该会话最近的消息流。
      // 事件源用 Host 的 /hub/session-events（由 hub-desktop-ui 提供）；取不到就降级为提示。
      const [lanes, setLanes] = React.useState({});   // { [sessionId]: { events, loading, error } }
      const [target, setTarget] = React.useState('');
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');

      React.useEffect(() => roomBus.subscribe((next) => {
        setProject(next);
        setError('');
        setNotice('');
        setBoardDirty(false);
      }), []);

      // Esc 关闭房间：全屏/半屏遮罩最怕"关不掉"，键盘退路必须有
      React.useEffect(() => {
        if (!project) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') roomBus.close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [project]);

      // 打开项目时拉看板/任务/待办
      React.useEffect(() => {
        if (!project) return;
        let cancelled = false;
        (async () => {
          try {
            const [b, t] = await Promise.all([
              fetch(`${API}/board?project=${encodeURIComponent(project)}`).then((r) => r.json()),
              fetch(`${API}/tasks?project=${encodeURIComponent(project)}`).then((r) => r.json()),
            ]);
            if (cancelled) return;
            setBoard((b && b.board) || '');
            setTasks(t && t.tasks);
            setRoutingMap((t && t.routing && typeof t.routing === 'object') ? t.routing : {});
          } catch (err) {
            if (!cancelled) setError(`读取房间失败：${String(err && err.message || err)}`);
          }
        })();
        return () => { cancelled = true; };
      }, [project, taskTick]);

      // 成员列表：读侧栏同步过来的快照（房间浮层拿不到 slot props）
      React.useEffect(() => {
        if (!project) return undefined;
        const collect = () => {
          const groups = roomBus.sessionIndex;
          const list = groups && groups.get ? (groups.get(project) || []) : [];
          setMembers(list.map((m) => ({ id: m.id, name: m.name, running: m.running })));
        };
        collect();
        const timer = setInterval(collect, 2000);
        return () => clearInterval(timer);
      }, [project]);


      // 投递目标：默认选管理者（Yat2），并按项目记住上次选的人 ——
      // 用户反馈「每次都要让我选」，原实现 target 初始是 ''、select 停在「选择成员…」。
      React.useEffect(() => {
        if (!members.length) { setTarget(''); return; }
        const saved = loadJson(`projectRoom.target.${project}`, '');
        const pick = members.find((m) => m.id === saved)
          || members.find((m) => m.name === managerName())
          || members[0];
        setTarget((cur) => (cur && members.some((m) => m.id === cur) ? cur : (pick ? pick.id : '')));
      }, [project, members]);

      /** 选目标时同时记住，下次打开房间直接用它。 */
      const pickTarget = (id) => {
        setTarget(id);
        saveJson(`projectRoom.target.${project}`, id);
      };
      // 按「任务线」拉消息（用户澄清：分列是按任务分，不是按 agent 分）。
      // 一条线一列：列内合并该线各成员的会话消息，按时间排序取最后几条。
      // 只收 user/message 与 assistant/message 的文本（工具/step/思考不进气泡）。
      // limit 取 60：实测 60 条事件里 assistant/message 只有 2 条，取 12 会显示成「暂无消息」。
      React.useEffect(() => {
        if (!project) return undefined;
        let cancelled = false;
        const load = async () => {
          const list = roomBus.sessionIndex && roomBus.sessionIndex.get
            ? (roomBus.sessionIndex.get(project) || [])
            : [];
          const sessionOf = (name) => list.find((m) => m.name === name);
          // 加载**全部** active 线（不截断）：渲染阶段要按「最近活跃」重排后再取前 8 列。
          // 加载时就截 8，会让 tasks.json 里第 9 条以后的线永远拿不到 lastAt、永远排不上来
          //（2026-11-11 用户令「最近活跃的任务线排最前」）。
          const taskList = Array.isArray(tasks) ? tasks
            : (tasks && Array.isArray(tasks.tasks) ? tasks.tasks : []);
          const activeTasks = taskList
            .filter((task) => String(task.status || '').toLowerCase() !== 'archived');
          const next = {};
          // 2026-11-12 用户令「任务线不用绑定成员，以任务目标为标准」：
          // 卡片消息**只按 routing.json 归线**（eventId → 任务线 id），不再按成员会话聚合。
          // 每个 agent 处理消息时自己判断它属于哪条线（写 routing），这里只负责按归属渲染。
          // 旧实现按 task.members 找会话、再做「共享成员跨列去重」——成员不再绑定后那条路必然全空，
          // 于是卡片只剩一行空态提示。整段已换成 routing 驱动。
          const routing = routingMap && typeof routingMap === 'object' ? routingMap : {};
          const laneKeys = new Set(activeTasks.map((task, index) => String(task.id || `task-${index}`)));
          const laneOfEvent = (event, sessionId) => {
            if (!event) return '';
            const rawKey = routing[event.id] !== undefined
              ? routing[event.id]
              : routing[`${sessionId}:${event.seq}`];
            const key = rawKey === undefined || rawKey === null ? '' : String(rawKey);
            if (!key || key === '_none' || key === '_hidden') return '';
            return laneKeys.has(key) ? key : '';
          };
          const buckets = new Map();
          for (const key of laneKeys) buckets.set(key, []);
          for (const session of list) {
            try {
              const res = await fetch(`/hub/session-events?session=${encodeURIComponent(session.id)}&limit=60`);
              const data = await res.json();
              const events = Array.isArray(data && data.events) ? data.events : [];
              for (const event of events) {
                if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue;
                const laneKey = laneOfEvent(event, session.id);
                if (!laneKey) continue;
                const content = event.data && event.data.message && event.data.message.content;
                const text = Array.isArray(content)
                  ? content.filter((part) => part && part.type === 'text').map((part) => part.text || '').join('\n')
                  : '';
                const value = String(text || '').trim();
                if (!value) continue;
                // 卡片是进度视图，只放一句摘要要点（2026-11-10 分诊定调）。
                const summary = summarizeMessage(value);
                // 空摘要（内容只有 "." / 纯代码块 / 纯表格）不进卡片（2026-11-11 修骨架屏）。
                if (!summary) continue;
                buckets.get(laneKey).push({
                  seq: event.seq,
                  time: event.time || 0,
                  role: event.type === 'user/message' ? 'user' : 'agent',
                  from: session.name,
                  text: summary,
                });
              }
            } catch { /* 单个会话失败不影响整列 */ }
          }
          // 过渡期兼容：老项目 tasks.json 里还写着 members、又完全没有 routing 记录时，
          // 退回按成员会话收集（新模型只走 routing，这条只在「老数据还没迁」时生效）。
          if (Object.keys(routing).length === 0) {
            // 跨线去重：共享成员的消息只归「第一条」包含它的线（保持旧行为，避免同一条消息
            // 在每条含该成员的线里重复出现）。
            const claimedMembers = new Set();
            for (const [index, task] of activeTasks.entries()) {
              const key = String(task.id || `task-${index}`);
              if ((buckets.get(key) || []).length > 0) continue;
              const names = Array.isArray(task.members) ? task.members : [];
              for (const name of names) {
                const member = sessionOf(name);
                if (!member) continue;
                if (claimedMembers.has(member.id)) continue;
                claimedMembers.add(member.id);
                try {
                  const res = await fetch(`/hub/session-events?session=${encodeURIComponent(member.id)}&limit=60`);
                  const data = await res.json();
                  const events = Array.isArray(data && data.events) ? data.events : [];
                  for (const event of events) {
                    if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue;
                    const content = event.data && event.data.message && event.data.message.content;
                    const text = Array.isArray(content)
                      ? content.filter((part) => part && part.type === 'text').map((part) => part.text || '').join('\n')
                      : '';
                    const value = String(text || '').trim();
                    if (!value) continue;
                    const summary = summarizeMessage(value);
                    if (!summary) continue;
                    buckets.get(key).push({
                      seq: event.seq, time: event.time || 0,
                      role: event.type === 'user/message' ? 'user' : 'agent',
                      from: member.name, text: summary,
                    });
                  }
                } catch { /* 单个成员失败不影响整列 */ }
              }
            }
          }
          for (const [index, task] of activeTasks.entries()) {
            const key = String(task.id || `task-${index}`);
            const collected = (buckets.get(key) || []).slice()
              .sort((a, b) => (a.time || 0) - (b.time || 0));
            // 最近活跃时间 = 该线已归线消息里最大时间；空线记 0（排在最后）。
            const lastAt = collected.length ? (collected[collected.length - 1].time || 0) : 0;
            next[key] = { messages: collected.slice(-6), lastAt };
          }
          if (!cancelled) setLanes(next);
        };
        load();
        const timer = setInterval(load, 30000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [project, tasks, routingMap]);

      if (!project) return null;

      const saveBoard = async () => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const res = await fetch(`${API}/board?project=${encodeURIComponent(project)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: board }),
          });
          const data = await res.json();
          if (data && data.ok) { setNotice('看板已保存到 board.md'); setBoardDirty(false); }
          else setError(`保存失败：${(data && data.error) || '未知'}`);
        } catch (err) {
          setError(`保存失败：${String(err && err.message || err)}`);
        } finally { setBusy(false); }
      };

      /** 归档/恢复一条任务线：改 tasks.json 的 status，成功后重拉。 */
      /** 归档/恢复一条任务线：改 tasks.json 的 status，成功后重拉。 */
      const setTaskStatus = async (taskId, status) => {
        try {
          const res = await fetch(`${API}/task-status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project, taskId, status }),
          });
          // 不能直接 res.json()：端点未加载时 DSH 会返回空体，json() 会抛
          // "Unexpected end of JSON input"，用户只看到一句看不懂的错。
          const raw = await res.text();
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
          if (!data || !data.ok) {
            const reason = (data && data.error)
              || (raw && raw.slice(0, 80))
              || `HTTP ${res.status} 且响应为空 —— 多半是这个端点还没加载，需要重启 DSH`;
            setError(`改任务线失败：${reason}`);
            return;
          }
          setArchiving(null);
          setTaskTick((n) => n + 1);   // 触发重拉，归档后该列立即消失
        } catch (error) {
          setError(`改任务线失败：${String((error && error.message) || error)}`);
        }
      };


      const send = async () => {
        if (!target || !draft.trim()) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const res = await fetch(`${API}/prompt`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target, text: draft }),
          });
          const data = await res.json();
          if (data && data.ok) {
            setNotice(`已投递给 ${target.slice(-8)}`);
            setDraft('');
          } else {
            setError(`投递失败：${(data && data.error) || '未知'}`);
          }
        } catch (err) {
          setError(`投递失败：${String(err && err.message || err)}`);
        } finally { setBusy(false); }
      };

      // 活跃任务线（按任务分列用；archived 的不显示，最多 8 列）。
      // 排序（2026-11-11 用户令「任务线排序要按活跃时间排，把最近活跃的任务线排在最前面」）：
      // 按每条线的 lastAt 降序，活跃时间相同按 tasks.json 定义顺序兜底；
      // **排序之后再截 8 列**——否则最近活跃但排在 tasks.json 第 9 位的线永远看不到。
      // 只影响显示顺序，不改 tasks.json、不影响归线、不影响归档。
      const activeTaskEntries = orderLanesByActivity(
        (tasks && Array.isArray(tasks.tasks) ? tasks.tasks : [])
          .filter((task) => String(task.status || '').toLowerCase() !== 'archived')
          .map((task, index) => ({
            task,
            index,
            lastAt: (lanes[task.id || `task-${index}`] || {}).lastAt || 0,
          })),
      ).slice(0, 8);
      const activeTasks = activeTaskEntries.map((entry) => entry.task);
      const activeTaskCount = activeTasks.length;
      // 一页展示三段（看板 / 任务 / 待办），不再用 tab 切换（用户要求整合到一页）
      const body = h('div', { className: 'pr-room-body' },
        h('section', { className: 'pr-section pr-board-section' },
          h('div', { className: 'pr-section-head' },
            h('div', { className: 'pr-section-title' }, '公共看板'),
            h('span', { className: 'pr-board-count', title: 'board.md 字符数（含空白）' }, `${board.length.toLocaleString()} 字`),
            h('button', {
              className: 'pr-btn pr-board-toggle',
              onClick: () => setBoardEditing((value) => !value),
              title: boardEditing ? '切到渲染视图' : '切到编辑（直接改 board.md）',
            }, boardEditing ? '完成' : '编辑'),
          ),
          boardEditing
            ? h('div', null,
              h('div', { className: 'pr-hint' }, 'board.md 原文 —— 这里的改动会写回同一份文件。'),
              h('textarea', {
                className: 'pr-board pr-board-edit',
                value: board,
                spellCheck: false,
                onChange: (event) => { setBoard(event.target.value); setBoardDirty(true); },
              }),
              h('div', { className: 'pr-board-actions' },
                h('button', { className: 'pr-btn primary', onClick: saveBoard, disabled: busy || !boardDirty }, '保存看板'),
                boardDirty ? h('span', { className: 'pr-hint' }, '有未保存改动') : null,
              ),
            )
            : h('div', { className: 'pr-md-view' },
              board && board.trim() ? renderMarkdown(board) : h('div', { className: 'pr-hint' }, '（看板还是空的）'),
            ),
        ),
        h('section', { className: 'pr-section pr-tasks-section' },
          h('div', { className: 'pr-section-title' }, `任务线分列 · ${activeTaskCount}`),
          activeTaskCount === 0
            ? h('div', { className: 'pr-hint' }, '这个项目当前没有活跃任务线（tasks.json 里 status 均为 archived）。')
            : h('div', { className: 'pr-lanes' },
              activeTaskEntries.map((entry) => {
                const task = entry.task;
                // key 必须按 tasks.json 里的**原始位置**取：排序后下标会漂，任务线卡片会串内容
                const key = task.id || `task-${entry.index}`;
                const lane = lanes[key] || {};
                const state = String(task.status || '').toLowerCase();
                const tone = state.includes('block') ? 'var(--dsw-alias-state-warning-primary, #c9a227)' : 'var(--dsw-alias-brand-primary)';
                return h('div', { className: 'pr-lane', key },
                  h('div', { className: 'pr-lane-head', title: `${task.title || ''} · ${(task.members || []).join('、')}` },
                    h('span', { className: 'pr-lane-dot', style: { background: tone } }),
                    h('span', { className: 'pr-lane-name' }, task.title || '(未命名任务)'),
                    h('button', {
                      className: 'pr-lane-archive',
                      title: '归档这条任务线（归档后从这里消失，可在 tasks.json 恢复）',
                      onClick: (event) => {
                        event.stopPropagation();
                        if (archiving && archiving.taskId === key && archiving.armed) {
                          setTaskStatus(key, 'archived');
                          return;
                        }
                        setArchiving({ taskId: key, armed: true });
                        setTimeout(() => {
                          setArchiving((cur) => (cur && cur.taskId === key ? null : cur));
                        }, 4000);
                      },
                    }, archiving && archiving.taskId === key && archiving.armed ? '确认归档?' : '⋯'),
                  ),
                  // 2026-11-12：任务线不绑成员 → 没有成员行就不渲染，不再显示「无成员」
                  ((task.members || []).length
                    ? h('div', { className: 'pr-lane-sub' }, (task.members || []).join('、'))
                    : null),
                  h('div', { className: 'pr-lane-body' },
                    lane.note
                      ? h('div', { className: 'pr-hint' }, lane.note)
                      : (lane.messages && lane.messages.length)
                        ? lane.messages.map((msg, msgIndex) => h('div', {
                          className: `pr-lane-msg pr-lane-msg-${msg.role}`,
                          key: `${key}-${msg.seq || msgIndex}`,
                          title: `${msg.from ? msg.from + '：' : ''}${msg.text}`,
                        }, msg.text))
                        : h('div', { className: 'pr-hint' }, lane.messages ? '暂无消息' : '加载中…'),
                  ),
                );
              }),
            ),
        ),
      );

        const box = conversationBox();
        return h('div', {
          className: 'pr-overlay',
          style: {
            position: 'fixed', zIndex: 900,
            left: `${box.left}px`, top: `${box.top}px`, right: 0, bottom: 0,
            display: 'flex', flexDirection: 'column',
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        h('div', { className: 'pr-panel', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'pr-panel-head' },
            h('span', { className: 'pr-panel-title' }, `#${project}`),
            h('div', { style: { flex: 1 } }),
              h('button', { className: 'pr-close-btn', title: '关闭房间（Esc）', onClick: () => roomBus.close() }, '✕ 关闭'),
          ),
          h('div', { className: 'pr-panel-body' },
            error ? h('div', { className: 'pr-err' }, error) : null,
            notice ? h('div', { className: 'pr-hint' }, notice) : null,
            body,
          ),
          h('div', { className: 'pr-panel-foot' },
            h('div', { className: 'pr-send-row' },
              h('select', {
                className: 'pr-select',
                value: target,
              onChange: (event) => pickTarget(event.target.value),
              },
                h('option', { value: '' }, members.length ? '切换收件人…' : '（暂无成员）'),
              members.map((m) => h('option', { key: m.id, value: m.id }, `${m.name}${m.running ? ' ●' : ''}`)),
              ),
              h('textarea', {
                className: 'pr-textarea',
                value: draft,
                placeholder: '给这个成员发一条消息（唤醒会话，走原生 prompt）',
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                // 回车直接发送（Shift+Enter 换行）—— 用户要求「回车发送」
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
                },
              }),
              h('button', { className: 'pr-btn primary', disabled: busy || !target || !draft.trim(), onClick: send }, '投递'),
            ),
          ),
        ),
      );
    }

    // ───────────────────────── 插件入口 ─────────────────────────

    return {
      inject: ['slots'],
      // 测试钩子：让 smoke.mjs 能直接驱动房间页渲染（生产运行不读）
      // summarizeMessage 一并暴露：卡片摘要的「空摘要→灰条」回归要能直接断言（2026-11-11）。
      __test: { roomBus, conversationBox, summarizeMessage },
      apply(ctx) {
        clientCtx = ctx;
        // ⚠️ 必须先注入样式表再注册组件：这里曾经漏调 ensureStyle()，
        // 结果整份 CSS（浮层定位 / 侧栏滚动 / 项目行布局）全都没生效，界面错乱。
        const style = ensureStyle();
        ctx.effect(() => () => {
          try { style?.remove(); } catch { /* ignore */ }
        }, 'project-room: stylesheet');

        const mount = (key, options, component) => {
          try {
            ctx.slots.inject(key, () => ctx.slots.register({ name: key, ...options }, component));
          } catch (error) {
            console.error(`[project-room] mount ${key} failed`, error);
          }
        };

        // priority -2：低于本机既有侧栏插件（-1），确保本插件接管时更优先；
        // 想换回别的侧栏，卸掉本插件即可。
        mount('sidebar.workspaces', { priority: -2 }, ProjectSidebar);
        mount('shell.overlay', { id: 'project-room-page', order: 92 }, ProjectRoom);

        console.log('[project-room] client 半已挂载');
      },
    };
  },
});
