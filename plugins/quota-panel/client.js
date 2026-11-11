/**
 * quota-panel 的浏览器半（out-of-tree Cordis client plugin）。
 *
 * 形态：侧栏底部一个小卡片，一行 `💰 ¥60.87 · 今日 921M`；点开是详情弹层
 * （余额 / 今日 token / 本会话 token / 更新时间 / 最近错误）。
 *
 * 铁律：
 *   - 数据只来自 Host 的 `GET /hub/quota`，客户端不做任何估算；
 *   - 查询失败显示「余额不可用」（悬停给原因），**绝不消失、绝不显示 0**；
 *   - 配色只吃 `--dsw-alias-*` 主题变量，亮/暗自动跟随；
 *   - 侧栏收窄时退化为图标 + 余额数字。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hub-quota-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const REFRESH_MS = 60_000;
    /** pending 时的快速重试（Host 首次全量扫会话日志要几秒）。 */
    const RETRY_MS = 2_500;
    const MAX_RETRIES = 8;
    /** 窄到这个宽度以下只显示图标 + 余额。 */
    const NARROW_PX = 190;

    function fmtAmount(value, currency) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return '—';
      const symbol = currency === 'USD' ? '$' : '¥';
      return `${symbol}${amount.toFixed(2)}`;
    }

    function fmtTokens(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      if (n < 1000) return String(Math.round(n));
      if (n < 1e6) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
      if (n < 1e9) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
      return `${(n / 1e9).toFixed(2).replace(/0$/, '')}B`;
    }

    function fmtClock(iso) {
      if (!iso) return '—';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleTimeString('zh-CN', { hour12: false });
    }

    /** 当前打开的会话 id（外壳在会话内容区上挂了 `data-conversation-session`）。 */
    function currentSessionId() {
      const node = document.querySelector('[data-conversation-session]');
      const id = node ? node.getAttribute('data-conversation-session') : '';
      return id && /^session-/.test(id) ? id : '';
    }

    function row(label, value, options = {}) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            padding: '3px 0',
            minWidth: 0,
          },
        },
        h('span', {
          style: {
            flex: '0 0 52px',
            fontSize: '9.5px',
            letterSpacing: '0.02em',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, label),
        h('span', {
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: '11px',
            color: options.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: '1.45',
            overflowWrap: 'anywhere',
          },
        }, value),
      );
    }

    function QuotaCard(props) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [narrow, setNarrow] = React.useState(false);
      // 座位 owner 会传 `wide`（false = 56px 图标轨）。有这个权威信号就不靠量宽度猜；
      // 只在拿不到时退回 ResizeObserver（老外壳 / 单测里都没有这个 prop）。
      const wide = props && typeof props.wide === 'boolean' ? props.wide : null;
      const [popover, setPopover] = React.useState({ left: 12, bottom: 80 });
      const cardRef = React.useRef(null);
      const retryRef = React.useRef(null);
      const retriesRef = React.useRef(0);
      const lastBalanceRef = React.useRef(null);

      const load = React.useCallback(async () => {
        const sessionId = currentSessionId();
        const url = `/hub/quota${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`;
        try {
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          setSnapshot(data);
          if (data && data.balance) lastBalanceRef.current = data.balance;
          setError(data && data.error ? String(data.error) : '');
          if (data && data.pending && retriesRef.current < MAX_RETRIES) {
            retriesRef.current += 1;
            if (retryRef.current) clearTimeout(retryRef.current);
            retryRef.current = setTimeout(() => { load(); }, RETRY_MS);
          } else {
            retriesRef.current = 0;
          }
        } catch (fetchError) {
          // 路由不存在（未重启）/ Host 挂了：明确说不可用，不保留看起来正常的旧数字
          setSnapshot(null);
          setError(String((fetchError && fetchError.message) || fetchError));
        }
      }, []);

      React.useEffect(() => {
        load();
        const timer = setInterval(() => { retriesRef.current = 0; load(); }, REFRESH_MS);
        return () => {
          clearInterval(timer);
          if (retryRef.current) clearTimeout(retryRef.current);
        };
      }, [load]);

      // 侧栏拉宽/收窄（含折叠成图标轨）：按卡片自身宽度决定显示几段文字
      React.useEffect(() => {
        const node = cardRef.current;
        if (!node) return undefined;
        const measure = () => {
          const width = node.getBoundingClientRect().width;
          setNarrow(width > 0 && width < NARROW_PX);
        };
        measure();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure);
          observer.observe(node);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, []);

      // 点外面收起详情
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const node = cardRef.current;
          if (node && event.target instanceof Node && node.contains(event.target)) return;
          setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
      }, [open]);

      const balance = snapshot && snapshot.balance ? snapshot.balance : null;
      const amountText = balance ? fmtAmount(balance.amount, balance.currency) : null;
      // 2026-11-06 修「余额不可用」误报：Host 的 `error` 是「余额失败 + 用量统计中」的合并串，
      // 之前用 `!error` 判定 → 只要今日用量还在扫（pending），明明有余额也显示「不可用」。
      // 正确口径：Host 在余额失败时会把 `balance` 置 null，所以「有 amountText」即余额有效；
      // 余额自身的失败原因单独看 `balanceError`。
      const balanceError = (snapshot && snapshot.balanceError) || null;
      const balanceOk = Boolean(amountText) && !balanceError;
      const today = snapshot && snapshot.today ? snapshot.today : null;
      const sessionTokens = snapshot && snapshot.session ? snapshot.session.tokens : null;
      const pending = Boolean(snapshot && snapshot.pending);
      // 折叠（wide=false）或量出来很窄 → 只留图标 + 金额
      const compact = wide === null ? narrow : !wide;

      const label = (() => {
        if (!balanceOk) return '余额不可用';
        if (pending) return `${amountText} · 统计中…`;
        if (compact) return amountText;
        return `${amountText} · 今日 ${today ? fmtTokens(today.tokens) : '—'}`;
      })();

      const hover = (() => {
        if (!balanceOk) return balanceError || error || '余额查询失败（原因未知）';
        const parts = [`余额 ${amountText} ${balance.currency}`];
        if (today) parts.push(`今日 ${fmtTokens(today.tokens)} token / ${today.requests} 次请求`);
        if (pending) parts.push('今日用量统计中');
        if (snapshot && snapshot.updatedAt) parts.push(`更新 ${fmtClock(snapshot.updatedAt)}`);
        return parts.join(' · ');
      })();

      const openDetails = () => {
        const node = cardRef.current;
        if (node) {
          const rect = node.getBoundingClientRect();
          setPopover({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
            bottom: Math.max(8, window.innerHeight - rect.top + 6),
          });
        }
        setOpen((value) => !value);
        if (!open) load();
      };

      const breakdown = today && today.breakdown ? today.breakdown : null;

      return h(
        'div',
        { ref: cardRef, style: { position: 'relative', minWidth: 0 } },
        h(
          'button',
          {
            type: 'button',
            title: hover,
            'data-hub-quota': balanceOk ? 'ok' : 'error',
            onClick: openDetails,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxSizing: 'border-box',
              minWidth: 0,
              margin: '6px 10px',
              padding: '6px 10px',
              borderRadius: '10px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: balanceOk
                ? 'var(--dsw-alias-label-secondary)'
                : 'var(--dsw-alias-state-error-primary)',
              cursor: 'pointer',
              fontSize: '11px',
              lineHeight: '1.2',
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'left',
              userSelect: 'none',
              overflow: 'hidden',
            },
          },
          h('span', { style: { flex: '0 0 auto', fontSize: '11px' } }, '💰'),
          h('span', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, label),
        ),
        open ? h(
          'div',
          {
            style: {
              position: 'fixed',
              zIndex: 1300,
              left: `${popover.left}px`,
              bottom: `${popover.bottom}px`,
              width: '268px',
              padding: '10px 12px',
              borderRadius: '12px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.42)',
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          row('余额', balanceOk ? `${amountText} ${balance.currency}` : (balanceError || error || '不可用'), { error: !balanceOk }),
          row(
            '今日',
            pending || !today
              ? '统计中…'
              : `${fmtTokens(today.tokens)} token · ${today.requests} 次请求`,
          ),
          breakdown
            ? row('明细', `输入 ${fmtTokens(breakdown.input)} · 缓存 ${fmtTokens(breakdown.cacheRead)} · 输出 ${fmtTokens(breakdown.output)}`)
            : null,
          row('本会话', sessionTokens === null ? '—' : `${fmtTokens(sessionTokens)} token`),
          row('更新', snapshot && snapshot.updatedAt ? fmtClock(snapshot.updatedAt) : '—'),
          snapshot && snapshot.source
            ? row('来源', snapshot.source === 'account-service' ? '账号服务' : '账号令牌直连')
            : null,
          snapshot && snapshot.lastKnownBalance
            ? row('上次', `${fmtAmount(snapshot.lastKnownBalance.amount, snapshot.lastKnownBalance.currency)} @ ${fmtClock(snapshot.lastKnownBalance.at)}`)
            : null,
          error ? row('错误', error, { error: true }) : null,
          h(
            'a',
            {
              href: 'https://platform.deepseek.com/usage',
              target: '_blank',
              rel: 'noreferrer',
              style: {
                display: 'inline-block',
                marginTop: '6px',
                fontSize: '9.5px',
                color: 'var(--dsw-alias-label-secondary)',
                textDecoration: 'none',
                opacity: 0.85,
              },
            },
            'DeepSeek 用量明细 ↗',
          ),
        ) : null,
      );
    }

    return {
      inject: ['slots'],
      apply() {
        // 2026-10-21：侧栏左下角要求「只保留一张卡」，本卡的余额已并入
        // hub-desktop-ui 的 HubStatusCard（读同一个 GET /hub/quota），
        // 因此这里**不再注册 sidebar.footer.action**——Host 侧 /hub/quota 路由保留，
        // QuotaCard 组件也保留（供其它入口复用）。
      },
    };
  },
});
