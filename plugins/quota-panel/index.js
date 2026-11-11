/**
 * quota-panel 的 Host 半。
 *
 * 只做两件事：
 *   ① `GET /hub/quota` —— 余额 + 今日/本会话 token 用量；
 *   ② 两路数据的取数与缓存（余额 60s、用量 60s，用量按会话文件 mtime+size 增量重算）。
 *
 * 数据来源（都已实测，不猜接口）：
 *   余额：优先 `ctx.deepseekAccount.getBalance()`（官方 Host 服务，令牌不出 Host），
 *         失败时退回 `getPlatformSession().token` + `GET https://api.deepseek.com/user/balance`
 *         的 `x-dsh-auth-token` 通道（2026-10-21 实测 200，返回 CNY 60.87）。
 *         **令牌只在本进程内存里流转，不写日志、不进响应、不落盘。**
 *   用量：扫 `$DSH_HOME/sessions/* /session-* / *.zstd`（今天改过的才算候选），
 *         逐个 `sessionController.inspect(id)` 只读持久层（不激活 agent），
 *         把 `assistant/message.data.usage` 按事件时间累加——口径见 lib/quota-core.js。
 *
 * 路由注册必须走 `ctx.inject(['webServer'], …)`：apply 阶段 webServer 还没激活
 * （见 dsh/cordis-notes/known-pitfalls.md 第 1 条）。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  addUsage,
  emptyBuckets,
  parseBalanceResponse,
  pickWallet,
  startOfLocalDay,
  summarize,
} from './lib/quota-core.js';
import {
  PRICING_URL,
  costOfBuckets,
  isPeakTime,
  loadPricing,
  pricingCachePath,
} from './lib/pricing.js';
import { emptyLedger, updateLedger } from './lib/balance-ledger.js';

/** 读一个 JSON 文件（读不到/坏了返回 null，不抛）。 */
function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export const name = 'ai-agent-hub-quota-panel';

/** 两路数据的缓存时长（任务要求 60s）。 */
const CACHE_MS = 60_000;
/** 余额请求超时。 */
const BALANCE_TIMEOUT_MS = 8_000;
/** 单次请求最多等用量扫描多久，超时先回 pending（后台继续扫）。 */
const USAGE_WAIT_MS = 2_000;
/** 一轮全量扫描的软预算，超了就先用已算出的部分（并在响应里标 truncated）。 */
const SCAN_BUDGET_MS = 25_000;
// 2026-11-06 修「余额卡一直显示用量统计中 / 花费显示 ?」（实测：主进程持续 40%+ CPU、
// pending 永不结束、inspectTimeouts=0、truncated=false）：
// 根因 = `controller.inspect()` 对**大会话**是同步解压解析，会阻塞事件循环 →
// 连 8s 超时定时器和 25s 预算检查都跑不了 → 整轮扫描永久卡住。
// 对策：①跳过超大日志（>5MB）；②分片扫描（每轮最多 20 个会话），几轮内推进完成。
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_SESSIONS_PER_SCAN = 20;
/** 单会话 inspect 超时：`controller.inspect` 对个别会话会永不 resolve（2026-11-06 实测），
 *  超时即跳过该会话，避免整轮扫描被一条卡死。 */
const INSPECT_TIMEOUT_MS = 8_000;
/** 整轮扫描看门狗：超过它还没结束就判失败并清 inflight，防止永久 pending。 */
const SCAN_WATCHDOG_MS = 90_000;
/** 会话日志扫描的最大目录深度（sessions/<workspace>/<session>/<file>）。 */
const MAX_DEPTH = 3;

const OFFICIAL_BALANCE_URL = 'https://api.deepseek.com/user/balance';

/** 进程内状态（Host 重启即清空，符合「缓存」语义）。 */
const state = {
  dayStart: 0,
  slices: new Map(), // sessionId -> { sessionId, mtimeMs, size, day, all }
  usageAt: 0,
  usageInflight: null,
  usageError: null,
  usageTruncated: false,
  usageRetryAt: 0,
  /** 2026-11-06 diag：inspect 超时被跳过的会话数与 id（最多留 20 条）。 */
  inspectTimeouts: 0,
  inspectTimeoutIds: [],
  balance: null, // { amount, currency, source }
  balanceAt: 0,
  balanceInflight: null,
  balanceError: null,
  balanceRetryAt: 0,
};

function errorText(error) {
  const message = error && error.message ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** DSH 数据目录：优先环境变量，退回 `~/.dsh`。 */
function dshHome() {
  const configured = process.env.DSH_HOME || process.env.DSH_DATA_HOME;
  return configured && String(configured).trim() ? String(configured).trim() : join(homedir(), '.dsh');
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 今天改动过的会话日志（`session.v4.jsonl.zstd` 等）。
 * 只 stat 不读内容——真正的解析交给 sessionController.inspect。
 * @returns {Array<{sessionId: string, mtimeMs: number, size: number}>}
 */
function listChangedSessionLogs(dayStart, now) {
  const root = join(dshHome(), 'sessions');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(zstd|jsonl)$/.test(entry.name)) continue;
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.mtimeMs < dayStart || info.size <= 0) continue;
      // 超大日志跳过：同步解压会阻塞事件循环（见 MAX_LOG_BYTES 注释）
      if (info.size > MAX_LOG_BYTES) continue;
      // 会话 id = 日志所在目录名（`session-<uuid>`）
      const sessionId = basename(full.slice(0, full.length - entry.name.length - 1));
      if (!/^session-/.test(sessionId)) continue;
      found.push({ sessionId, mtimeMs: info.mtimeMs, size: info.size });
    }
  };
  walk(root, 0);
  // 同一会话可能有多个日志文件（版本后缀不同）：保留最新的一份
  const byId = new Map();
  for (const item of found) {
    const previous = byId.get(item.sessionId);
    if (!previous || item.mtimeMs > previous.mtimeMs) byId.set(item.sessionId, item);
  }
  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 只读取一个会话的事件（活会话走内存，冷会话走持久层；不 resume）。 */
async function inspectEvents(ctx, sessionId) {
  const controller = ctx.get('sessionController');
  if (!controller || typeof controller.inspect !== 'function') return null;
  // 2026-11-06 修「余额卡一直显示用量统计中」：`controller.inspect` 对某些会话会
  // **永不 resolve**（既不返回也不抛），导致整轮扫描挂住、usageInflight 永久占位，
  // 之后每次请求都拿同一个卡死的 promise → 永远 pending。这里给单会话加超时，
  // 超时就跳过这条（宁缺不挂），并把跳过数记进 state 供 diag 看。
  const timeoutMs = INSPECT_TIMEOUT_MS;
  let timer = null;
  const TIMEOUT = Symbol('inspect-timeout');
  try {
    const inspection = await Promise.race([
      controller.inspect(sessionId),
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); }),
    ]);
    if (inspection === TIMEOUT) {
      state.inspectTimeouts += 1;
      state.inspectTimeoutIds.push(sessionId);
      if (state.inspectTimeoutIds.length > 20) state.inspectTimeoutIds.shift();
      return [];
    }
    if (!inspection) return [];
    if (Array.isArray(inspection.events)) return inspection.events;
    if (Array.isArray(inspection.entries)) return inspection.entries;
    return [];
  } catch {
    // 会话不存在 / 格式迁移中 / 读盘失败：跳过这条，不编数字
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 事件数组 → 桶（day 只算本机今天；另按**峰谷时段**拆成 dayPeak / dayOff）。
 * 峰谷按事件时间戳判定（官方规则：北京时间工作日 9-12、14-18 为高峰，其余空闲半价），
 * 逐事件归类，绝不用平均价糊成一本账。
 */
function bucketsOf(events, dayStart) {
  const day = emptyBuckets();
  const all = emptyBuckets();
  const dayPeak = emptyBuckets();
  const dayOff = emptyBuckets();
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue;
    const usage = event.data && event.data.usage;
    if (!usage) continue;
    addUsage(all, usage);
    const at = Number(event.time);
    if (at >= dayStart) {
      addUsage(day, usage);
      addUsage(isPeakTime(at) ? dayPeak : dayOff, usage);
    }
  }
  return { day, all, dayPeak, dayOff };
}

/**
 * 刷新用量：只重算 mtime/size 变过的会话，其余复用上一轮结果。
 * 89 个会话全量 ~ 数秒；之后每 60s 只重算正在跑的那几个。
 */
async function refreshUsage(ctx) {
  const startedAt = Date.now();
  const dayStart = startOfLocalDay(Date.now());
  if (state.dayStart !== dayStart) {
    // 跨天：昨天的日桶不能再复用
    state.dayStart = dayStart;
    state.slices.clear();
    state.usageAt = 0;
  }
  const logs = listChangedSessionLogs(dayStart, startedAt);
  state.usageTruncated = false;
  // 分片推进（2026-11-06）：首次 94 个会话全量会卡死，每轮只扫 MAX_SESSIONS_PER_SCAN 个，
  // 用 usageScanIndex 记断点；扫完一轮归零。每片完成都会让 usageAt 更新 → 客户端拿到部分数据。
  const cursor = Number(state.usageScanIndex) || 0;
  const from = cursor >= logs.length ? 0 : cursor;
  const slice = logs.slice(from, from + MAX_SESSIONS_PER_SCAN);
  if (slice.length < logs.length) state.usageTruncated = true;
  for (const log of slice) {
    if (Date.now() - startedAt > SCAN_BUDGET_MS) {
      state.usageTruncated = true;
      break;
    }
    const cached = state.slices.get(log.sessionId);
    if (cached && cached.mtimeMs === log.mtimeMs && cached.size === log.size) continue;
    const events = await inspectEvents(ctx, log.sessionId);
    if (events === null) {
      // sessionController 不在（组合里没这项）：整轮用量的可信度就没了
      throw new Error('sessionController 不可用，无法统计用量');
    }
    const { day, all, dayPeak, dayOff } = bucketsOf(events, dayStart);
    state.slices.set(log.sessionId, { sessionId: log.sessionId, mtimeMs: log.mtimeMs, size: log.size, day, all, dayPeak, dayOff });
  }
  // 推进分片游标：本轮扫到哪、下一轮从哪继续（扫满一轮归零）
  const consumed = from + slice.length;
  state.usageScanIndex = consumed >= logs.length ? 0 : consumed;
  // 清掉昨天留下的、今天没动过的会话（它们今天的日桶必为 0，留着只会占内存）
  const alive = new Set(logs.map((log) => log.sessionId));
  for (const id of [...state.slices.keys()]) {
    if (!alive.has(id) && state.slices.get(id).mtimeMs < dayStart) state.slices.delete(id);
  }
  return state.slices;
}

function startUsageRefresh(ctx) {
  if (state.usageInflight) return state.usageInflight;
  const run = (async () => {
    try {
      await refreshUsage(ctx);
      state.usageAt = Date.now();
      state.usageError = null;
    } catch (error) {
      state.usageError = errorText(error);
      // 失败后 10s 内不重复全量扫描（否则每个请求都触发一轮）
      state.usageAt = 0;
      state.usageRetryAt = Date.now() + 10_000;
    } finally {
      if (state.usageInflight === run) state.usageInflight = null;
    }
  })();
  state.usageInflight = run;
  // 看门狗（2026-11-06）：扫描若因未知原因卡住，90s 后强制收尾，
  // 否则 usageInflight 会永久占位、接口永远回 pending（用户看到「统计中…」不消失）。
  const watchdog = setTimeout(() => {
    if (state.usageInflight !== run) return;
    state.usageInflight = null;
    state.usageAt = 0;
    state.usageError = `扫描超时（>${Math.round(SCAN_WATCHDOG_MS / 1000)}s）`;
    state.usageRetryAt = Date.now() + 60_000;
  }, SCAN_WATCHDOG_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();
  run.finally(() => clearTimeout(watchdog));
  return run;
}

function usageFresh() {
  return state.usageAt > 0 && Date.now() - state.usageAt < CACHE_MS;
}

/** 等用量就绪；超过 waitMs 还没扫完就返回 false（调用方回 pending）。 */
async function ensureUsage(ctx, waitMs) {
  if (usageFresh()) return true;
  if (state.usageRetryAt && Date.now() < state.usageRetryAt && !state.usageInflight) return false;
  const pending = startUsageRefresh(ctx);
  if (waitMs > 0) await Promise.race([pending, sleep(waitMs)]);
  return usageFresh();
}

/** 读余额：官方 Host 服务优先，失败退回账号令牌直连官方端点。 */
async function readBalance(ctx) {
  const service = ctx.get('deepseekAccount');
  if (service && typeof service.getBalance === 'function') {
    try {
      const client = {
        version: '0.2.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
      const result = await service.getBalance(client);
      if (result && result.status === 'ready') {
        const picked = pickWallet(result.value, result.bonusWallets);
        // 钱包全为零时不可信（可能只是 bonus/retail 分桶没对上），退回官方端点核对
        if (picked && picked.nonZero) {
          return { amount: picked.amount, currency: picked.currency, source: 'account-service' };
        }
      }
    } catch {
      // 落到下面的直连通道
    }
  }
  return readBalanceWithToken(ctx);
}

/** 直连官方端点：`x-dsh-auth-token` 用账号登录令牌（实测 200）。 */
async function readBalanceWithToken(ctx) {
  const service = ctx.get('deepseekAccount');
  let token = '';
  if (service && typeof service.getPlatformSession === 'function') {
    const session = await service.getPlatformSession();
    token = session && typeof session.token === 'string' ? session.token : '';
  }
  if (!token) throw new Error('DeepSeek 账号未登录（无可用登录令牌）');
  let response;
  try {
    response = await fetch(OFFICIAL_BALANCE_URL, {
      method: 'GET',
      headers: { 'x-dsh-auth-token': token, accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`余额接口请求失败：${errorText(error)}`);
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const brief = String(text || '').replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`余额接口 HTTP ${response.status}${brief ? `：${brief}` : ''}`);
  }
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('余额接口返回非 JSON');
  }
  const parsed = parseBalanceResponse(payload);
  if (!parsed) throw new Error('余额接口返回里没有可用的余额字段');
  return { amount: parsed.amount, currency: parsed.currency, source: 'account-token' };
}

function startBalanceRefresh(ctx) {
  if (state.balanceInflight) return state.balanceInflight;
  state.balanceInflight = (async () => {
    try {
      state.balance = await readBalance(ctx);
      state.balanceAt = Date.now();
      state.balanceError = null;
    } catch (error) {
      // 失败时保留上一次成功值给详情面板参考，但对外 ok=false + error
      state.balanceError = errorText(error);
      state.balanceRetryAt = Date.now() + 10_000;
    } finally {
      state.balanceInflight = null;
    }
  })();
  return state.balanceInflight;
}

function balanceFresh() {
  return state.balanceAt > 0 && Date.now() - state.balanceAt < CACHE_MS;
}

async function ensureBalance(ctx, waitMs) {
  if (balanceFresh()) return true;
  if (state.balanceRetryAt && Date.now() < state.balanceRetryAt && !state.balanceInflight) return false;
  const pending = startBalanceRefresh(ctx);
  if (waitMs > 0) await Promise.race([pending, sleep(waitMs)]);
  return Boolean(state.balance) && !state.balanceError;
}

/**
 * 组一份响应。返回结构即任务约定的 `{ok, balance, today, session, updatedAt, error?}`，
 * 另有 `pending` / `breakdown` / `source` / `stale` 几个诊断字段。
 */
export async function buildQuota(ctx, { sessionId = '', waitMs = USAGE_WAIT_MS } = {}) {
  const wantSession = String(sessionId || '').trim();
  await ensureBalance(ctx, BALANCE_TIMEOUT_MS);
  const usageReady = await ensureUsage(ctx, waitMs);

  // 当前会话可能不在今天改过的名单里（比如今天没说过话）→ 单独补一次
  if (usageReady && wantSession && !state.slices.has(wantSession)) {
    const events = await inspectEvents(ctx, wantSession);
    if (events && events.length) {
      const dayStart = startOfLocalDay(Date.now());
      const { day, all, dayPeak, dayOff } = bucketsOf(events, dayStart);
      state.slices.set(wantSession, { sessionId: wantSession, mtimeMs: 0, size: 0, day, all, dayPeak, dayOff });
    }
  }

  // ok 的口径：余额这一路**必须**是最近一次读到成功值（有 error 就是 false，
  // 哪怕手里还留着上一次的读数——不能让用户以为那是当前余额）。
  const balanceOk = Boolean(state.balance) && !state.balanceError;
  const usageOk = usageReady && !state.usageError;
  const snapshot = usageReady ? summarize([...state.slices.values()], { sessionId: wantSession }) : null;

  const errors = [];
  if (!balanceOk) errors.push(`余额查询失败：${state.balanceError || '未知原因'}`);
  if (!usageReady) errors.push('用量统计中…');
  else if (state.usageError) errors.push(`用量统计失败：${state.usageError}`);

  const stamps = [state.usageAt, state.balanceAt].filter((value) => value > 0);
  const updatedAt = stamps.length ? new Date(Math.max(...stamps)).toISOString() : new Date().toISOString();

  // 今日花费（2026-10-21 用户要求：卡片显示金额而不是 token 数）：
  // 价格表来自官方页面（每天最多抓一次，缓存 ~/.dsh/quota-panel-pricing.json），
  // 峰谷按每条事件的时间戳分桶后分别计价，绝不用平均价。
  let cost = null;
  let priceSource = null;
  try {
    const priceState = await loadPricing({
      file: pricingCachePath(dshHome()),
      readFileSync,
      writeFileSync,
      now: Date.now(),
    });
    priceSource = priceState.source;
    if (snapshot && priceState.prices) {
      const peakAmount = costOfBuckets(snapshot.peak, priceState.prices, true);
      const offAmount = costOfBuckets(snapshot.off, priceState.prices, false);
      cost = {
        amount: Math.round((peakAmount + offAmount) * 100) / 100,
        amountExact: Math.round((peakAmount + offAmount) * 10_000) / 10_000,
        currency: priceState.prices.currency || 'CNY',
        peakAmount,
        offAmount,
      };
    }
  } catch (error) {
    priceSource = { url: PRICING_URL || '', error: errorText(error) };
  }

  // 余额差值口径（2026-10-21 用户点名「直接拿差值算」）：最权威——就是 DeepSeek 实际扣的钱。
  // 需要「今日基线」：昨天最后一次读数 ≈ 00:00 余额；没有历史就从本次开始统计。
  let spendDelta = null;
  let balanceLedger = null;
  if (balanceOk) {
    try {
      const ledgerFile = join(dshHome(), 'quota-panel-balance.json');
      const prevRead = readJsonSafe(ledgerFile) || emptyLedger();
      const result = updateLedger(prevRead, {
        now: Date.now(),
        amount: state.balance.amount,
        currency: state.balance.currency,
      });
      balanceLedger = result.ledger;
      spendDelta = result.spend;
      if (result.changed) {
        try {
          writeFileSync(ledgerFile, JSON.stringify(result.ledger, null, 2), 'utf8');
        } catch { /* 写失败不影响本次返回 */ }
      }
    } catch (error) {
      spendDelta = null;
      balanceLedger = null;
    }
  }

  // 2026-11-06 用户质疑「不是直接用差值算吗？这么复杂吗」——对，差值口径（spendDelta）
  // 本来就够用（就是 DeepSeek 实际扣的钱），但原来它被写在 `today` 对象里，
  // 而 `today` 依赖用量扫描（snapshot）→ 扫描没完成整个 today 就是 null，**差值白算**，
  // 界面只能显示「今日 ¥?」。现在把花费提到**顶层 cost**，只用余额差值，与扫描彻底解耦。
  const costPayload = (() => {
    const estimateFields = cost
      ? { estimate: cost.amount, estimatePeak: cost.peakAmount, estimateOff: cost.offAmount }
      : { estimate: null, estimatePeak: null, estimateOff: null };
    if (!spendDelta) return null;
    return {
      amount: spendDelta.amount,
      currency: spendDelta.currency,
      // 语义统一为「今日（0:00 起）」；是否全程有采样由 sampledFrom 说明
      basis: 'today-balance-delta',
      baselineAmount: spendDelta.baselineAmount,
      baselineAt: spendDelta.baselineAt ? new Date(spendDelta.baselineAt).toISOString() : '',
      todayWindow: spendDelta.todayWindow,
      sampledFrom: spendDelta.sampledFrom,
      baselineFrom: spendDelta.baselineFrom,
      fromFirstSample: spendDelta.fromFirstSample,
      topUpTotal: spendDelta.topUpTotal,
      ...estimateFields,
    };
  })();

  const body = {
    // 2026-11-06 修「余额不可用」误报（用户连续两次报同一现象，实测 balance.amount=17.93 却被
    // 所有客户端显示成「⚠ 余额不可用」）：原口径要求 balanceOk && snapshot && usageOk——
    // 只要「今日用量还在统计中」（usageReady=false，扫描慢/卡住），整个响应就 ok:false。
    // 正确口径：**ok 只表示余额可用**（余额是主信息，必须优先显示）；用量是否就绪由
    // `pending` + `today:null` 单独表达，客户端据此显示「统计中…」而不是「不可用」。
    ok: balanceOk,
    balance: balanceOk
      ? { amount: state.balance.amount, currency: state.balance.currency }
      : null,
    // 今日花费（余额差值口径）：**不依赖用量扫描**，只要有余额就能给（2026-11-06）
    cost: costPayload,
    today: snapshot
      ? {
        tokens: snapshot.today.tokens,
        requests: snapshot.today.requests,
        breakdown: {
          input: snapshot.today.input,
          output: snapshot.today.output,
          cacheRead: snapshot.today.cacheRead,
          cacheWrite: snapshot.today.cacheWrite,
        },
        // 花费口径（2026-10-21 实测纠偏 + 2026-10-22 用户纠正「要今日 0:00 起」）：
        //   **只把余额差值当「今日花费」**——它是真实扣费；官方单价估算与真实差一个数量级，
        //   只作参考字段。窗口必须是**本地自然日 00:00 → now**（todayWindow），基线用
        //   「今天首个采样」（sampledFrom）；00:00→首个采样之间的花费无法得知，如实标出。
        // 复用顶层 costPayload（同一份差值口径，不再重复计算）
        cost: costPayload,
        // 今日统计窗口（本地自然日）：token/请求数/花费共用同一窗口
        todayWindow: {
          from: new Date(startOfLocalDay(Date.now())).toISOString(),
          to: new Date().toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
        },
        priceSource,
        // 峰谷分桶也回给详情，便于核对手算
        split: {
          peak: snapshot.peak,
          off: snapshot.off,
        },
      }
      : null,
    session: snapshot && snapshot.session ? { tokens: snapshot.session.tokens } : null,
    updatedAt,
    pending: !snapshot,
    stale: !usageFresh() && Boolean(snapshot),
    truncated: Boolean(state.usageTruncated),
    // 2026-11-06 diag：被 inspect 超时跳过的会话（>0 说明有会话读不动，用量偏小是正常的）
    inspectTimeouts: state.inspectTimeouts || 0,
    inspectTimeoutIds: state.inspectTimeoutIds ? state.inspectTimeoutIds.slice(-5) : [],
    cacheSeconds: Math.round(CACHE_MS / 1000),
  };
  if (balanceOk) body.source = state.balance.source;
  if (!balanceOk) {
    // 2026-11-06：余额失败原因单独成字段——`error` 是「余额 + 用量」的合并串，
    // 客户端曾因为 `error` 里出现「用量统计中…」就把有值的余额判成「不可用」。
    body.balanceError = state.balanceError || '未知原因';
  }
  if (!balanceOk && state.balance) {
    // 有历史成功值：给详情面板显示「上次读数」，但 amount 仍为 null（不假装现在是这个数）
    body.lastKnownBalance = { ...state.balance, at: new Date(state.balanceAt).toISOString() };
  }
  if (errors.length) body.error = errors.join('；');
  return body;
}

/** 路由处理函数（导出便于离线测试）。 */
export async function handleQuotaRequest(ctx, req, res) {
  const send = (status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    send(405, { ok: false, error: 'GET only' });
    return;
  }
  let sessionId = '';
  try {
    const url = new URL(req.url || '/hub/quota', 'http://127.0.0.1');
    sessionId = url.searchParams.get('session') || '';
  } catch { /* 坏 URL 就当没传 */ }
  try {
    const body = await buildQuota(ctx, { sessionId });
    send(200, body);
  } catch (error) {
    // 任何未预期异常都要有明确提示，绝不返回 0 或空对象假装正常
    send(200, {
      ok: false,
      balance: null,
      today: null,
      session: null,
      updatedAt: new Date().toISOString(),
      error: `quota 查询失败：${errorText(error)}`,
    });
  }
}

export function apply(ctx) {
  // 服务就绪后再注册（apply 阶段 webServer 还不存在）
  ctx.inject(['webServer'], (hub) => {
    const server = hub.webServer;
    if (!server || typeof server.register !== 'function') return;
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/quota',
      handler: (req, res) => handleQuotaRequest(hub, req, res),
    }), 'quota-panel:/hub/quota');
    // 顺手让页面刷新时能看到一眼数据是不是来自真实会话日志
    console.log('[quota-panel] GET /hub/quota registered');
  });
}

/** 供测试/诊断：清空进程内缓存。 */
export function resetQuotaCache() {
  state.dayStart = 0;
  state.slices.clear();
  state.usageAt = 0;
  state.usageError = null;
  state.usageTruncated = false;
  state.usageRetryAt = 0;
  state.balance = null;
  state.balanceAt = 0;
  state.balanceError = null;
  state.balanceRetryAt = 0;
}
