/**
 * quota-panel 的纯逻辑层（无 IO、无 cordis、无 DOM）。
 *
 * 拆出来的目的：聚合口径（token 桶、余额钱包挑选、今日起点）必须能被测试
 * 直接钉住——这些数字是要给用户看的，口径一错就是「假数字」。
 *
 * 口径依据（2026-10-21 用 Python + zstandard 对 89 个真实会话日志做 oracle 核对）：
 *   单个 `assistant/message.data.usage` 里
 *   `totalTokens === inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，
 *   且 `inputTokens` 是**未命中缓存**的输入（缓存命中单独记在 cacheReadTokens）。
 *   对 2026-10-21 全天逐事件求和，两条口径给出同一个数 921,464,967 —— 见 README。
 */

/** 一轮 token 桶（与 DSH `tokenUsage` 投影的四个桶同名）。 */
export function emptyBuckets() {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

/** 把一个 usage 累进桶（就地修改 target，返回 target）。 */
export function addUsage(target, usage) {
  const b = bucketsFromUsage(usage);
  if (!b) return target;
  target.input += b.input;
  target.output += b.output;
  target.cacheRead += b.cacheRead;
  target.cacheWrite += b.cacheWrite;
  target.tokens += b.tokens;
  target.requests += 1;
  return target;
}

/**
 * 单个 `usage` → 桶。无法解析时返回 null（调用方跳过，绝不按 0 记一次请求）。
 * @param {object|undefined|null} usage TokenUsage（inputTokens/outputTokens/totalTokens/...）
 */
export function bucketsFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  const four = input + output + cacheRead + cacheWrite;
  // 首选 provider 直接给的总数（DeepSeek 的 total_tokens）；没给才用四桶之和。
  const total = Number.isFinite(Number(usage.totalTokens)) ? Number(usage.totalTokens) : four;
  if (!four && !total) return null;
  return { input, output, cacheRead, cacheWrite, tokens: total || four };
}

/** 当日 00:00:00.000（本机时区）的时间戳。 */
export function startOfLocalDay(now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 汇总一天的用量。
 * @param {Array<{day: object, all: object, sessionId: string}>} sessions 每个会话的当日/全量桶
 * @param {{sessionId?: string}} options 当前会话 id（算「本会话」那一格）
 * @returns {{today: object, session: object|null}}
 */
export function summarize(sessions, options = {}) {
  const today = emptyBuckets();
  const peak = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const off = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const list = Array.isArray(sessions) ? sessions : [];
  let current = null;
  for (const entry of list) {
    if (!entry) continue;
    const day = entry.day || {};
    today.input += day.input || 0;
    today.output += day.output || 0;
    today.cacheRead += day.cacheRead || 0;
    today.cacheWrite += day.cacheWrite || 0;
    today.tokens += day.tokens || 0;
    today.requests += day.requests || 0;
    // 峰谷分桶（2026-10-21，计费用）：老快照没有这两个字段，缺失按 0
    for (const [dst, src] of [[peak, entry.dayPeak], [off, entry.dayOff]]) {
      if (!src) continue;
      dst.input += src.input || 0;
      dst.output += src.output || 0;
      dst.cacheRead += src.cacheRead || 0;
      dst.cacheWrite += src.cacheWrite || 0;
    }
    if (options.sessionId && entry.sessionId === options.sessionId) current = entry;
  }
  return {
    today,
    peak,
    off,
    session: current
      ? {
        tokens: (current.all && current.all.tokens) || 0,
        requests: (current.all && current.all.requests) || 0,
      }
      : null,
  };
}

/**
 * 从账号服务的钱包里挑一个展示币种。
 *
 * 规则：把 `value`（充值余额）与 `bonusWallets`（赠送余额）按币种相加；
 * 优先 CNY，其次 USD，最后取任意非零币种；全为零时给 CNY 0（这是真实为零，
 * 不是查询失败——查询失败由调用方返回 null + error）。
 * @returns {{amount: number, currency: string, nonZero: boolean}|null}
 */
export function pickWallet(wallets, bonusWallets) {
  const list = [...(Array.isArray(wallets) ? wallets : []), ...(Array.isArray(bonusWallets) ? bonusWallets : [])];
  if (!list.length) return null;
  const totals = new Map();
  for (const wallet of list) {
    if (!wallet || typeof wallet !== 'object') continue;
    const currency = typeof wallet.currency === 'string' ? wallet.currency : '';
    const amount = Number(wallet.balance);
    if (!currency || !Number.isFinite(amount)) continue;
    totals.set(currency, (totals.get(currency) || 0) + amount);
  }
  if (!totals.size) return null;
  const order = ['CNY', 'USD', ...totals.keys()];
  const nonZero = [...totals.entries()].filter(([, amount]) => Math.abs(amount) > 1e-9);
  const pickedCurrency = nonZero.length
    ? (order.find((currency) => nonZero.some(([key]) => key === currency)) || nonZero[0][0])
    : (totals.has('CNY') ? 'CNY' : [...totals.keys()][0]);
  const amount = Math.round((totals.get(pickedCurrency) || 0) * 100) / 100;
  return { amount, currency: pickedCurrency, nonZero: Math.abs(amount) > 1e-9 };
}

/**
 * 官方 `GET https://api.deepseek.com/user/balance` 的响应 → 一个币种。
 * 响应形如 `{is_available, balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}]}`。
 * 与账号服务口径一致：优先 CNY，其次 USD，全零给 CNY 0。
 * @returns {{amount: number, currency: string}|null} 解析不出来返回 null（上层报错，不静默给 0）
 */
export function parseBalanceResponse(payload) {
  const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : null;
  if (!infos || !infos.length) return null;
  const rows = infos
    .map((info) => ({
      currency: String(info && info.currency ? info.currency : ''),
      amount: Number(info && info.total_balance),
    }))
    .filter((row) => row.currency && Number.isFinite(row.amount));
  if (!rows.length) return null;
  const nonZero = rows.filter((row) => Math.abs(row.amount) > 1e-9);
  const byCurrency = (currency) => rows.find((row) => row.currency === currency);
  // 优先「有余额的 CNY → 有余额的 USD → 任意非零币种」，再退回「CNY 0 / USD 0 / 第一行」。
  // 不能直接按行序找——官方响应里 USD 常常排在 CNY 前面且为 0。
  let hit = null;
  for (const currency of ['CNY', 'USD']) {
    const row = byCurrency(currency);
    if (row && Math.abs(row.amount) > 1e-9) { hit = row; break; }
  }
  if (!hit) hit = nonZero[0] || byCurrency('CNY') || byCurrency('USD') || rows[0];
  return { amount: Math.round(hit.amount * 100) / 100, currency: hit.currency };
}
