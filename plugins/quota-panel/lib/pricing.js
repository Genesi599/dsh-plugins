/**
 * DeepSeek 官方单价（用于「今日花费」估算）。
 *
 * 铁律（用户 2026-10-21 明确）：价格**必须从官方价格页抓**，不许把数字硬编码在代码里当唯一来源。
 * 因此本模块：
 *   ① 抓 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`，从页面文本里解析
 *      「缓存命中 / 缓存未命中 / 输出」× 「空闲时段 / 高峰时段」六档单价；
 *   ② 解析结果缓存到 `~/.dsh/quota-panel-pricing.json`，**每天最多抓一次**；
 *   ③ 抓取失败时用上一次成功的缓存（并在响应里带 `ageDays` 让 UI 标注「价格表 N 天前」）；
 *   ④ 完全没有缓存 → 返回 null，UI 显示「今日 ¥?」，**绝不用任何预设数字冒充**。
 *
 * 峰谷时段（官方页面脚注 2 原文）：
 *   北京时间 周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为**高峰时段**；
 *   其余时段（含周末、中国法定节假日全天）为**空闲时段**，空闲价 = 高峰价的一半。
 *   法定节假日清单没有官方 API，这里只按「工作日 + 上述时段」判定（不含节假日表），
 *   响应里如实标注 `holidayAware:false`。
 */

export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
/** 模型档位：deepseek-flash 是本机在用的档（V4.1-Flash-1017 按 Flash 价计费）。 */
export const PRICING_MODEL = 'deepseek-flash';
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** 抓页面文本（不解析 HTML 结构，只取可见文本，抗页面改版）。 */
async function fetchPageText() {
  const res = await fetch(PRICING_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // 去标签 → 解实体 → 压空白；表格里的单元格顺序得以保留
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 在文本里截出「价格」表那一段（从 缓存命中 到 输出 高峰价）。 */
function pricingSection(text) {
  const start = text.indexOf('缓存命中');
  if (start < 0) return '';
  const end = text.indexOf('并发限制', start);
  return text.slice(Math.max(0, start - 220), end > start ? end : start + 1200);
}

/**
 * 从页面文本解析六档单价（人民币 / 百万 tokens）。
 * 表格行顺序（官方页面实测）：每档先「空闲时段 X元 Y元」，再「高峰时段 X元 Y元」，
 * 其中 X = deepseek-flash，Y = deepseek-v4-pro —— 所以取每组第一个数字即 Flash 价。
 * @returns {{hitOff,hitPeak,missOff,missPeak,outOff,outPeak,currency,model,unit}|null}
 */
export function parsePricingText(text) {
  const section = pricingSection(String(text || ''));
  if (!section) return null;
  // 用**完整标签**定位：页面前文有「模型输入和输出的总 token 数」这类句子，
  // 只搜「输出」会命中那句、抓到错档的价（2026-10-21 实测踩坑：outPeak 变成 0.04）。
  const pickTier = (label, from = 0) => {
    const at = section.indexOf(label, from);
    if (at < 0) return null;
    const window = section.slice(at, at + 240);
    // 表格单元格之间可能有 `|`、换行、括号等分隔符，价格在「空闲时段/高峰时段」之后的第一个数字
    const off = window.match(/空闲时段[^\d]{0,12}([0-9]+(?:\.[0-9]+)?)\s*元/);
    const peak = window.match(/高峰时段[^\d]{0,12}([0-9]+(?:\.[0-9]+)?)\s*元/);
    if (!off || !peak) return null;
    return { off: Number(off[1]), peak: Number(peak[1]) };
  };
  const hit = pickTier('缓存命中');
  const miss = pickTier('缓存未命中');
  const out = pickTier('百万tokens输出') || pickTier('输出', Math.max(0, section.lastIndexOf('输出') - 1));
  if (!hit || !miss || !out) return null;
  return {
    model: PRICING_MODEL,
    currency: 'CNY',
    unit: 'per 1M tokens',
    hitOff: hit.off,
    hitPeak: hit.peak,
    missOff: miss.off,
    missPeak: miss.peak,
    outOff: out.off,
    outPeak: out.peak,
  };
}

/**
 * 北京时间的「是否高峰时段」。
 * 高峰：周一至周五 09:00-12:00、14:00-18:00（官方脚注；不含法定节假日表）。
 * @param {number} atMs epoch 毫秒
 */
export function isPeakTime(atMs) {
  const t = Number.isFinite(atMs) ? atMs : Date.now();
  // 用 UTC+8 固定偏移换算（不依赖本机时区设置）
  const beijing = new Date(t + 8 * 60 * 60 * 1000);
  const weekday = beijing.getUTCDay(); // 0 = 周日
  if (weekday === 0 || weekday === 6) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const morning = minutes >= 9 * 60 && minutes < 12 * 60;
  const afternoon = minutes >= 14 * 60 && minutes < 18 * 60;
  return morning || afternoon;
}

/** 缓存文件路径。 */
export function pricingCachePath(dshHomeDir) {
  const home = dshHomeDir || process.env.DSH_HOME || `${process.env.USERPROFILE || process.env.HOME || '.'}/.dsh`;
  return `${home.replace(/[\\/]+$/, '')}/quota-panel-pricing.json`;
}

/**
 * 读缓存文件。
 * @returns {{prices:object, fetchedAt:number}|null}
 */
export function readPricingCache(file, readFileSync) {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const prices = parsed.prices && typeof parsed.prices === 'object' ? parsed.prices : null;
    const fetchedAt = Number(parsed.fetchedAt);
    if (!prices || !Number.isFinite(fetchedAt)) return null;
    return { prices, fetchedAt };
  } catch {
    return null;
  }
}

/**
 * 取价格表：缓存新鲜（<24h）直接用；否则抓官方页面；抓失败退回旧缓存。
 * @param {{file:string, readFileSync:Function, writeFileSync:Function, now?:number, force?:boolean}} io
 * @returns {Promise<{prices:object|null, source:object}>}
 */
export async function loadPricing(io) {
  const now = Number.isFinite(io.now) ? io.now : Date.now();
  const cached = readPricingCache(io.file, io.readFileSync);
  const fresh = cached && now - cached.fetchedAt < DAY_MS;
  if (cached && fresh && !io.force) {
    return {
      prices: cached.prices,
      source: {
        url: PRICING_URL,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
        ageDays: 0,
        cached: true,
        holidayAware: false,
      },
    };
  }
  try {
    const text = await fetchPageText();
    const prices = parsePricingText(text);
    if (!prices) throw new Error('价格表解析失败（页面结构可能变了）');
    const fetchedAt = now;
    try {
      io.writeFileSync(io.file, JSON.stringify({ fetchedAt, prices, source: PRICING_URL }, null, 2), 'utf8');
    } catch { /* 写缓存失败不影响本次计价 */ }
    return {
      prices,
      source: {
        url: PRICING_URL,
        fetchedAt: new Date(fetchedAt).toISOString(),
        ageDays: 0,
        cached: false,
        holidayAware: false,
      },
    };
  } catch (error) {
    if (cached) {
      return {
        prices: cached.prices,
        source: {
          url: PRICING_URL,
          fetchedAt: new Date(cached.fetchedAt).toISOString(),
          ageDays: Math.floor((now - cached.fetchedAt) / DAY_MS),
          cached: true,
          stale: true,
          error: String((error && error.message) || error),
          holidayAware: false,
        },
      };
    }
    return {
      prices: null,
      source: {
        url: PRICING_URL,
        fetchedAt: '',
        ageDays: null,
        cached: false,
        error: String((error && error.message) || error),
        holidayAware: false,
      },
    };
  }
}

/**
 * 按档位计价：buckets 形如 {input, output, cacheRead, cacheWrite}，单位 tokens。
 * 输入分两类：cacheRead 用「缓存命中」价，input（未命中）用「未命中」价；
 * cacheWrite 官方页面未单列，按「未命中输入」价计（保守，不低估）。
 * @returns {number} 金额（元），保留 4 位小数
 */
export function costOfBuckets(buckets, prices, peak) {
  if (!buckets || !prices) return 0;
  const perM = 1_000_000;
  const hit = peak ? prices.hitPeak : prices.hitOff;
  const miss = peak ? prices.missPeak : prices.missOff;
  const out = peak ? prices.outPeak : prices.outOff;
  const amount = ((Number(buckets.cacheRead) || 0) * hit
    + ((Number(buckets.input) || 0) + (Number(buckets.cacheWrite) || 0)) * miss
    + (Number(buckets.output) || 0) * out) / perM;
  return Math.round(amount * 10_000) / 10_000;
}

/** 六档单价的人类可读摘要（详情弹层用）。 */
export function describePrices(prices) {
  if (!prices) return [];
  return [
    `缓存命中输入：空闲 ¥${prices.hitOff}/M · 高峰 ¥${prices.hitPeak}/M`,
    `未命中输入：空闲 ¥${prices.missOff}/M · 高峰 ¥${prices.missPeak}/M`,
    `输出：空闲 ¥${prices.outOff}/M · 高峰 ¥${prices.outPeak}/M`,
  ];
}
