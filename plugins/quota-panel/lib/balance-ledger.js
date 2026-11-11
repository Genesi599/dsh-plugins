/**
 * 余额快照账本：用**余额差值**算「今日花费」（2026-10-21 用户点名：直接拿差值算）。
 *
 * 口径：DeepSeek 自己扣的钱就是最权威的花费——
 *   spentToday 逐次累加（`上次读数 − 本次读数`，只在余额下降时累加）；
 *   余额上升视为充值：只记 topUps，**不回退**已累计的花费。
 *
 * 跨天基线：昨天最后一次读数 ≈ 今天 00:00 的余额。
 *   没有昨天读数（今天才第一次跑）→ 基线 = 本次读数，并标 `fromFirstSample`
 *   （UI 说明「从 HH:mm 开始统计」，不假装覆盖全天）。
 *   任何异常（负数、非法值）都钳到 0 / 返回 null，绝不显示编出来的数字。
 */

/** 本地日期键 YYYY-MM-DD。 */
export function dayKey(atMs) {
  const d = new Date(Number.isFinite(atMs) ? atMs : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地自然日零点（Asia/Shanghai 本机时区，00:00:00.000）。 */
export function localDayStart(atMs) {
  const d = new Date(Number.isFinite(atMs) ? atMs : Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 新建空账本。 */
export function emptyLedger() {
  return {
    day: '',
    baselineAmount: null,   // 今日起始余额（跨天时来自昨天最后读数）
    baselineAt: 0,
    lastAmount: null,       // 最近一次读数
    lastAt: 0,
    spentToday: 0,          // 今日已花（累积差值）
    topUps: [],             // [{at, amount}] 今日充值记录
  };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * 用一次余额读数更新账本，并给出「今日花费」。
 * @param {object} prev 上一版账本（可为空/损坏，函数内部自愈）
 * @param {{now:number, amount:number, currency?:string}} sample
 * @returns {{ledger:object, spend:object|null, changed:boolean}}
 */
export function updateLedger(prev, sample) {
  const now = Number(sample && sample.now) || Date.now();
  const amount = Number(sample && sample.amount);
  const currency = (sample && sample.currency) || 'CNY';
  const base = prev && typeof prev === 'object' ? prev : emptyLedger();
  // 注意 Number(null) === 0：不能直接 Number() 判空，否则「无基线」会被当成基线 0
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const ledger = {
    day: typeof base.day === 'string' ? base.day : '',
    baselineAmount: num(base.baselineAmount),
    baselineAt: Number(base.baselineAt) || 0,
    lastAmount: num(base.lastAmount),
    lastAt: Number(base.lastAt) || 0,
    spentToday: num(base.spentToday) || 0,
    // 今日首个采样时刻（「今日 0:00 起」的统计实际上从这一刻开始）
    firstSampleAt: Number(base.firstSampleAt) || 0,
    topUps: Array.isArray(base.topUps) ? base.topUps.slice(-20) : [],
  };
  if (amount === null || !Number.isFinite(amount) || amount < 0) {
    return { ledger, spend: null, changed: false };
  }
  const today = dayKey(now);
  let changed = false;
  let fromFirstSample = false;
  // 上一版账本里显式记录的来源（不能读刚构造的 ledger——它还没这个字段）
  let baselineFrom = typeof base.baselineFrom === 'string' ? base.baselineFrom : 'none';

  if (ledger.day !== today) {
    // 跨天：**以今天首个采样为准**建立基线（2026-10-22 用户纠正：统计起点必须是本地自然日，
    // 不是昨夜的最后读数——昨夜 22:08 的读数当基线会把昨晚的花费算进「今日」）。
    // 今天的实际统计窗口 = 首个采样时刻 → 现在；00:00 → 首个采样之间的花费无法知道，
    // 响应里用 sampledFrom 显式标出来，不假装覆盖。
    ledger.day = today;
    ledger.topUps = [];
    ledger.baselineAmount = amount;
    ledger.baselineAt = now;
    ledger.firstSampleAt = now;
    ledger.spentToday = 0;
    fromFirstSample = true;
    baselineFrom = 'today-first-sample';
    changed = true;
  } else if (baselineFrom === 'overnight' || ledger.baselineAmount === null
    || (ledger.baselineAt > 0 && ledger.baselineAt < localDayStart(now))) {
    // 迁移旧账本 / 基线脏了：把基线重置为本次读数，并把采样起点记成现在
    ledger.baselineAmount = amount;
    ledger.baselineAt = now;
    ledger.firstSampleAt = ledger.firstSampleAt || now;
    ledger.spentToday = 0;
    fromFirstSample = true;
    baselineFrom = 'today-first-sample';
    changed = true;
  } else if (ledger.lastAmount !== null) {
    const delta = round2(ledger.lastAmount - amount);
    if (delta > 0) {
      ledger.spentToday = round2(ledger.spentToday + delta);
      changed = true;
    } else if (delta < 0) {
      // 余额变大 = 充值：记录流水，已花金额不回退
      ledger.topUps.push({ at: new Date(now).toISOString(), amount: round2(-delta) });
      changed = true;
    }
  }

  if (ledger.lastAmount !== amount) {
    ledger.lastAmount = amount;
    ledger.lastAt = now;
    changed = true;
  }

  const topUpTotal = round2(ledger.topUps.reduce((sum, item) => sum + (Number(item && item.amount) || 0), 0));
  ledger.baselineFrom = baselineFrom;
  const dayStart = localDayStart(now);
  return {
    ledger,
    changed,
    spend: {
      amount: round2(Math.max(0, ledger.spentToday)),
      baselineAmount: ledger.baselineAmount,
      baselineAt: ledger.baselineAt,
      fromFirstSample,
      // 'today-first-sample' = 今日统计以**今天首个采样**为基线（对应「今日 0:00 起」）
      baselineFrom,
      // 统计窗口：todayWindow 是自然日区间；sampledFrom 是真正开始采样的时刻
      todayWindow: { from: new Date(dayStart).toISOString(), to: new Date(now).toISOString() },
      sampledFrom: ledger.firstSampleAt ? new Date(ledger.firstSampleAt).toISOString() : new Date(now).toISOString(),
      topUpTotal,
      currency,
    },
  };
}
