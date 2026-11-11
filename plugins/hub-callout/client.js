/**
 * dsh-hub-callout — 浏览器半（out-of-tree Cordis client plugin）。
 *
 * 目标：在 DSH 里复刻 Hermes 桌面端的 alert 卡片（apps/desktop/src/components/assistant-ui/embeds/alert.tsx，
 * commit c8713ee631）：
 *   容器 = 1px 细边框 + 8px 圆角 + muted/25 底 + 8px/12px 内边距；
 *   标题行 = 16px 图标 + 13px/600 彩色标签（Note / Tip / Important / Warning / Caution / 原文）；
 *   正文 = 原文类型走 .book-quote（Times New Roman、0.95rem、行高 1.7）。
 *
 * 为什么走 DOM 后处理：DSH 的 markdown 是 @deepseek-ai/dsh-client-ui-primitives 里的
 * direct mdast→React 渲染器，blockquote 分支硬编码、没有语法插件注册点；客户端插件也拿不到
 * 块级渲染席位。所以这里只在**已定稿**的消息上做最小改写：
 *   - 摘掉首段里的 `[!TYPE]` 标记（只改承载标记的那个文本节点，不动元素结构）；
 *   - 在引用块最前面插入一行标题（图标 + 标签）；
 *   - 流式中（[data-streaming]）一律跳过，定稿后由属性监听补扫。
 */

window.__ModuleLoader__.load({
  id: 'dsh-hub-callout',
  factory(require) {
    /** 样式层 style 元素 id（插件停用即移除）。 */
    const STYLE_ID = 'hub-callout-style';

    /** tabler 风格图标，stroke=currentColor，随标题行取色。 */
    const ICONS = {
      info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11 12h1.5v4"/></svg>',
      zap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
      alertCircle: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
      alertTriangle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.4 3.6 2.3 17.1a1.9 1.9 0 0 0 1.6 2.9h16.2a1.9 1.9 0 0 0 1.6-2.9L13.6 3.6a1.9 1.9 0 0 0-3.2 0z"/></svg>',
      book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4v16H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M19 16H7a2 2 0 0 0-2 2"/><path d="M9 8h6"/></svg>',
    };

    /** 与 Hermes ALERT_STYLES 一一对应的类型表（label 文案保持一致）。 */
    const TYPES = {
      book: { label: '原文', icon: ICONS.book },
      caution: { label: 'Caution', icon: ICONS.alertTriangle },
      important: { label: 'Important', icon: ICONS.alertCircle },
      note: { label: 'Note', icon: ICONS.info },
      tip: { label: 'Tip', icon: ICONS.zap },
      warning: { label: 'Warning', icon: ICONS.alertTriangle },
    };

    /** 段首标记（与 Hermes MARKER_RE 一致：只吃掉标记本身，标题文字留在正文里）。 */
    const MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|BOOK)\]\s*\n?/i;

    /** 复刻 Hermes alert 卡片；暗色用 -400、亮色用 -600，与 Tailwind 取值一致。
     *  选择器写成 `blockquote[data-hub-callout]`（0,2,1）压过 DSH 的 `.markdown blockquote`
     *  （0,1,1：border-left 2px + padding-left 14px），否则会留一条灰色竖线。 */
    const CSS = `
blockquote[data-hub-callout] {
  margin: 8px 0;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28));
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28));
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #808080) 25%, transparent);
}
blockquote[data-hub-callout] > *:first-child { margin-top: 0; }
blockquote[data-hub-callout] > *:last-child { margin-bottom: 0; }
blockquote[data-hub-callout] > p { margin: 0 0 0.6em; }

.hub-callout__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--hub-accent);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.hub-callout__head svg {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 原文（BOOK）：与 Hermes .book-quote 完全一致 */
blockquote.hub-callout--book {
  font-family: "Times New Roman", "Liberation Serif", Georgia, serif;
  font-size: 0.95rem;
  line-height: 1.7;
}

blockquote.hub-callout--note { --hub-accent: #2563eb; }
blockquote.hub-callout--tip { --hub-accent: #059669; }
blockquote.hub-callout--important { --hub-accent: #7c3aed; }
blockquote.hub-callout--warning { --hub-accent: #d97706; }
blockquote.hub-callout--caution { --hub-accent: #e11d48; }
blockquote.hub-callout--book { --hub-accent: #57534e; }

@media (prefers-color-scheme: dark) {
  blockquote.hub-callout--note { --hub-accent: #60a5fa; }
  blockquote.hub-callout--tip { --hub-accent: #34d399; }
  blockquote.hub-callout--important { --hub-accent: #a78bfa; }
  blockquote.hub-callout--warning { --hub-accent: #fbbf24; }
  blockquote.hub-callout--caution { --hub-accent: #fb7185; }
  blockquote.hub-callout--book { --hub-accent: #d6d3d1; }
}
.dark blockquote.hub-callout--note,
[data-theme="dark"] blockquote.hub-callout--note { --hub-accent: #60a5fa; }
.dark blockquote.hub-callout--tip,
[data-theme="dark"] blockquote.hub-callout--tip { --hub-accent: #34d399; }
.dark blockquote.hub-callout--important,
[data-theme="dark"] blockquote.hub-callout--important { --hub-accent: #a78bfa; }
.dark blockquote.hub-callout--warning,
[data-theme="dark"] blockquote.hub-callout--warning { --hub-accent: #fbbf24; }
.dark blockquote.hub-callout--caution,
[data-theme="dark"] blockquote.hub-callout--caution { --hub-accent: #fb7185; }
.dark blockquote.hub-callout--book,
[data-theme="dark"] blockquote.hub-callout--book { --hub-accent: #d6d3d1; }
`;

    /**
     * 摘掉段首的 `[!TYPE]` 标记：只改承载标记的那个文本节点，不动元素结构。
     * @param {Element} paragraph 首个段落。
     * @returns {string|null} 命中的类型（小写），没命中返回 null。
     */
    function stripMarker(paragraph) {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        const value = node.nodeValue || '';
        const match = MARKER.exec(value);
        if (match) {
          node.nodeValue = value.replace(MARKER, '');
          return match[1].toLowerCase();
        }
        node = walker.nextNode();
      }
      return null;
    }

    /**
     * 把一段 blockquote 升级成 Hermes 同款 alert 卡片。
     * 已经是卡片、正在流式、或者在输入框里的，直接跳过。
     * @param {Element} el 候选 blockquote 元素。
     */
    function upgrade(el) {
      if (!el || !el.isConnected) return;
      if (el.getAttribute('data-hub-callout')) return;
      if (el.closest('[data-streaming]')) return;
      if (el.closest('form, textarea, [contenteditable="true"]')) return;

      const first = el.firstElementChild;
      if (!first || first.tagName !== 'P') return;

      // 先看命中类型（不改 DOM），避免把非 alert 的引用块动到
      const probe = (first.textContent || '').match(MARKER);
      if (!probe) return;

      const type = stripMarker(first);
      const meta = TYPES[type];
      if (!meta) return;

      // 标记独占一段时，整段摘掉它，避免留下空行
      if (!(first.textContent || '').trim() && first.children.length === 0) {
        first.setAttribute('data-hub-marker', '');
        first.style.display = 'none';
      }

      const head = document.createElement('div');
      head.className = 'hub-callout__head';
      head.innerHTML = `${meta.icon}<span>${meta.label}</span>`;
      el.insertBefore(head, el.firstChild);

      el.classList.add('hub-callout', `hub-callout--${type}`);
      el.setAttribute('data-hub-callout', type);
    }

    /** 对一棵子树里所有 blockquote 尝试升级。 */
    function scanTree(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.tagName === 'BLOCKQUOTE') upgrade(node);
      const inner = node.querySelectorAll('blockquote');
      for (let i = 0; i < inner.length; i += 1) upgrade(inner[i]);
    }

    /** 撤销所有改写（插件停用时）。 */
    function reset() {
      const marked = document.querySelectorAll('blockquote[data-hub-callout]');
      for (let i = 0; i < marked.length; i += 1) {
        const el = marked[i];
        el.removeAttribute('data-hub-callout');
        el.classList.remove('hub-callout');
        for (const type of Object.keys(TYPES)) el.classList.remove(`hub-callout--${type}`);
        const head = el.querySelector(':scope > .hub-callout__head');
        if (head) head.remove();
        const marker = el.querySelector(':scope > [data-hub-marker]');
        if (marker) {
          marker.removeAttribute('data-hub-marker');
          marker.style.display = '';
        }
      }
    }

    return {
      inject: [],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = CSS;
          document.head.appendChild(style);

          const observer = new MutationObserver((records) => {
            for (let i = 0; i < records.length; i += 1) {
              const record = records[i];
              if (record.type === 'childList') {
                for (let j = 0; j < record.addedNodes.length; j += 1) scanTree(record.addedNodes[j]);
              } else if (record.type === 'attributes') {
                // 流式结束（data-streaming 被摘掉）时补扫整棵子树。
                const target = record.target;
                if (!(target instanceof Element)) continue;
                if (target.hasAttribute('data-streaming')) continue;
                scanTree(target);
              } else if (record.type === 'characterData') {
                const parent = record.target.parentElement;
                const box = parent && parent.closest('blockquote');
                if (box) upgrade(box);
              }
            }
          });

          observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['data-streaming'],
          });

          // 首屏已有的消息（插件晚于消息挂载时）
          scanTree(document.body);

          return () => {
            observer.disconnect();
            reset();
            style.remove();
          };
        });
      },
    };
  },
});