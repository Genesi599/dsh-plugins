/**
 * ⚠️ DEAD FILE（2026-11-11 核实）：本文件**已无人 import**，也不是发布内容的一部分。
 *
 * 2026-11-09 sync-bridge 已拆成独立包 `dsh-sync-bridge`（本仓库 dsh/plugins/hub-sync-bridge/），
 * `hub-desktop-ui/index.js` 现在 `import { startSyncBridge } from 'dsh-sync-bridge'`。
 * 这份是拆分前的旧副本，且它内部 `import '../../quota-panel/lib/quota-core.js'` 是**跨包越界引用**
 * ——一旦被打进 tarball，第三方装下来就是 ERR_MODULE_NOT_FOUND。
 * 因此已从 package.json 的 `files` 移除（2026-11-11）。确认无人引用后可直接删除本文件。
 */
/**
 * DSH Sync bridge —— 给手机端（DSH Sync App）用的 HTTP 接口。
 *
 * 为什么要在 Host 进程里开独立监听：DSH 自己的 Web GUI 只绑 127.0.0.1、端口每次启动随机
 * （实测 52377 / 64162 两回不同）、还要 GUI 专用 token，手机端没法稳定连。这里另起一个
 * 固定端口 + 自己 token 的服务，复用同一批 Host 服务（sessionController / sessions / agents /
 * workspaceRegistry），语义与 GUI 一致。
 *
 * 认证：`Authorization: Bearer <token>`；token 存 `~/.dsh/sync-token.txt`（首次自动生成）。
 * 传输：明文 HTTP，只允许在可信网络（Tailscale / 内网）使用，不做公网暴露。
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSessionEvents } from './session-events.js';
import { parseBalanceResponse, pickWallet } from '../../quota-panel/lib/quota-core.js';

// 余额监控缓存（/sync/balance 用，与上面 DeepSeek 官方余额缓存区分）：120s 数据 + in-flight 去重
const balanceSnapCache = { data: null, at: 0, inflight: null };

const DEFAULT_PORTS = [8900, 8901, 8902, 8903, 8904];

/** 余额缓存（60s；与桌面 quota-panel 同一双通道：account-service → 官方端点直连）。 */
const balanceCache = { at: 0, value: null, error: null };
const BALANCE_TTL_MS = 60_000;
const BALANCE_TIMEOUT_MS = 8_000;
const OFFICIAL_BALANCE_URL = 'https://api.deepseek.com/user/balance';

async function readBalance(ctx) {
  const service = ctx.get('deepseekAccount');
  if (service && typeof service.getBalance === 'function') {
    try {
      const result = await service.getBalance({
        version: '0.2.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
      if (result && result.status === 'ready') {
        const picked = pickWallet(result.value, result.bonusWallets);
        if (picked && picked.nonZero) {
          return { amount: picked.amount, currency: picked.currency, source: 'account-service' };
        }
      }
    } catch { /* 落到直连通道 */ }
  }
  // 直连官方端点：x-dsh-auth-token 用账号登录令牌（与 quota-panel readBalanceWithToken 同款）
  let token = '';
  if (service && typeof service.getPlatformSession === 'function') {
    const session = await service.getPlatformSession();
    token = session && typeof session.token === 'string' ? session.token : '';
  }
  if (!token) throw new Error('DeepSeek 账号未登录（无可用登录令牌）');
  const response = await fetch(OFFICIAL_BALANCE_URL, {
    headers: { 'x-dsh-auth-token': token, accept: 'application/json' },
    signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`余额接口 HTTP ${response.status}`);
  const picked = parseBalanceResponse(JSON.parse(text));
  if (!picked) throw new Error('余额响应无法解析');
  return picked;
}

/**
 * `$DSH_HOME` 根目录（默认 `~/.dsh`）。测试用 `DSH_SYNC_DSH_HOME` 指到临时目录，
 * 否则跑离线测试会把用户真实会话/projcache 吸进来，断言全乱。
 */
function dshHome() {
  return process.env.DSH_SYNC_DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh');
}

/** token 文件路径（用户可改，改完重启 DSH 生效）。 */
export function tokenPath() {
  return join(dshHome(), 'sync-token.txt');
}

/** 读 token；不存在就生成一个 48 位十六进制并落盘。 */
export function ensureToken() {
  const path = tokenPath();
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      if (text.length >= 16) return { token: text, path, created: false };
    }
  } catch (error) {
    console.warn(`[dsh-sync-bridge] read token failed: ${String(error)}`);
  }
  const token = randomBytes(24).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${token}\n`, 'utf8');
  } catch (error) {
    console.warn(`[dsh-sync-bridge] write token failed: ${String(error)}`);
    return { token: '', path, created: false, error: String(error && error.message) };
  }
  return { token, path, created: true };
}

/** 常量时间比较，避免长度/前缀泄漏。 */
function tokenEquals(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 从请求头取 Bearer token。 */
function bearerOf(req) {
  const raw = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : '';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 读 JSON 请求体（上限 1MB，消息文本够用）。 */
async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** 读原始字节请求体（图片上传用，上限默认 20MB）。 */
async function readRaw(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 成员命名硬校验（2026-10-23 用户令，与 index.js taskline_create 同款）：
 * ① 禁裸宽泛角色名（工程师/专家/管家…单用）；② 禁「｜」具体任务分身（仅 ｜副手/｜二号 放行）；
 * ③ 像具体任务但不违规 → warning 不拒绝。返回 { error } 或 { warning }。
 */
export function validateMemberName(title) {
  const memberName = title.includes(' · ') ? title.slice(title.lastIndexOf(' · ') + 3).trim() : title.trim();
  const BARE_ROLE_WORDS = ['工程师', '专家', '管家', '助手', '成员', '分析师', '设计师', '研究员', 'agent', 'Agent'];
  if (BARE_ROLE_WORDS.includes(memberName)) {
    return { error: `「${memberName}」是裸宽泛角色名，禁止使用——请带领域前缀（如 DSH工程师 / 视网膜专家 / 出题工程师）` };
  }
  if (memberName.includes('｜') && !['副手', '二号'].includes(memberName.split('｜')[1].trim())) {
    return { error: `「${memberName}」带「｜」任务后缀，已停用——要开独立线请给正式角色名（如「PubMed 配置工程师」），不要挂父名造具体任务分身（仅 ｜副手 / ｜二号 常驻副手允许）` };
  }
  return { warning: '' };
}

/** `项目 · 成员` → 项目名。 */
function projectOf(title) {
  const at = String(title || '').lastIndexOf(' · ');
  return at > 0 ? String(title).slice(0, at).trim() : '';
}

/** `项目 · 成员` → 成员名。 */
function memberOf(title) {
  const at = String(title || '').lastIndexOf(' · ');
  return at > 0 ? String(title).slice(at + 3).trim() : String(title || '').trim();
}

function titleOfSession(ctx, session) {
  if (!session) return '';
  try {
    const titles = ctx.get('sessionTitle');
    const snapshot = titles && typeof titles.get === 'function' ? titles.get(session) : undefined;
    return String((snapshot && snapshot.title) || session.title || '');
  } catch {
    return String((session && session.title) || '');
  }
}

/**
 * 冷会话标题/活跃时间回退：读 `~/.dsh/storages/session_projcache/sessions/<id>.json`。
 * 实测结构：`record.rows.title.val` 为标题，
 * `record.rows.sessionListMetadata.val.lastPromptAt` / `timeContext.val.lastMessageTime` 为最近活跃。
 *
 * 2026-10-27 修「lastActivity 恒 0」：会话 id 有两种写法（带/不带 `session-` 前缀，
 * 实测同一个目录里 141 个带前缀 + 8 个不带），原实现只拼 `<id>.json` 一种 → 大量 miss 后
 * 被 catch 吞成 0。现在按候选名逐个试，并把「目录不可读」一次性 warn 出来（此前完全静默）。
 */
let warnedProjectionDir = false;
/** A（2026-10-30）：projcache 读失败的错误码留痕（/sync/health 外显，最多留 30 条）。 */
const projectionCacheLastError = new Map();
function projectionCacheFile(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const bare = id.replace(/^session-/, '');
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions');
  const candidates = [...new Set([`${id}.json`, `session-${bare}.json`, `${bare}.json`])];
  for (const name of candidates) {
    const file = join(dir, name);
    try {
      if (existsSync(file)) return file;
    } catch { /* 继续试下一个 */ }
  }
  if (!warnedProjectionDir) {
    warnedProjectionDir = true;
    console.warn(`[dsh-sync-bridge] projcache miss: dir=${dir} exists=${(() => { try { return existsSync(dir); } catch { return 'error'; } })()} (dshHome=${dshHome()})`);
  }
  return '';
}

function projectionCache(sessionId) {
  const file = projectionCacheFile(sessionId);
  if (!file) return {};
  // A（2026-10-30）：读失败不再静默——记录最后一次错误码供 /sync/health 外显，
  // 并对活跃会话常见的瞬时 EBUSY/EPERM 重试 3 次（5ms 退避）。
  // 背景：29 条活跃会话在 host 进程内读 projcache 恒空（离线同代码全正常），"catch 吞掉"让根因不可见。
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      projectionCacheLastError.delete(file);
      return (parsed && parsed.record && parsed.record.rows) || {};
    } catch (error) {
      lastErr = error;
      const code = (error && (error.code || error.name)) || 'unknown';
      // 只对 I/O 类错误重试；JSON 语法错误重试无意义
      if (!/EBUSY|EPERM|EACCES|EMFILE|ENFILE|EAGAIN/.test(String(code))) break;
      const until = Date.now() + 5 + attempt * 5;
      while (Date.now() < until) { /* 短自旋退避，桥是同步路径 */ }
    }
  }
  if (lastErr) {
    projectionCacheLastError.set(file, String((lastErr && (lastErr.code || lastErr.name)) || lastErr) + ': ' + String((lastErr && lastErr.message) || '').slice(0, 120));
  }
  return {};
}

function titleFromCache(sessionId) {
  const rows = projectionCache(sessionId);
  const val = rows.title && rows.title.val;
  return typeof val === 'string' ? val : '';
}

function activityFromCache(sessionId) {
  const rows = projectionCache(sessionId);
  for (const key of ['sessionListMetadata', 'timeContext']) {
    const row = rows[key];
    const val = row && row.val;
    const stamp = val && (val.lastMessageTime || val.lastPromptAt);
    if (typeof stamp === 'number' && stamp > 0) return stamp;
  }
  const created = rows.identity && rows.identity.val && rows.identity.val.createdAt;
  if (typeof created === 'number' && created > 0) return created;
  // 最后兜底：projcache 文件 mtime（真实时间戳，避免全 0 让排序失效）
  const file = projectionCacheFile(sessionId);
  if (file) {
    try { return Math.round(statSync(file).mtimeMs); } catch { /* ignore */ }
  }
  return 0;
}

/** 上下文压力（2026-10-27，P2）：`contextPressure.val.{pressureTokens,contextWindow}`。 */
function pressureFromCache(sessionId) {
  const rows = projectionCache(sessionId);
  const val = rows.contextPressure && rows.contextPressure.val;
  if (!val) return null;
  const used = Number(val.pressureTokens);
  const win = Number(val.contextWindow);
  if (!Number.isFinite(used) || !Number.isFinite(win) || win <= 0) return null;
  return { pressureTokens: used, contextWindow: win, pressureRatio: Math.round((used / win) * 1000) / 1000 };
}

function isRunning(ctx, sessionId) {
  try {
    const agents = ctx.get('agents');
    if (!agents || typeof agents.get !== 'function') return false;
    // 2026-10-27：id 带/不带 `session-` 前缀两种写法都试
    const agent = agents.get(sessionId) || agents.get(String(sessionId).replace(/^session-/, ''));
    return agent ? String(agent.status) === 'running' : false;
  } catch {
    return false;
  }
}

/**
 * 已归档会话 id（`~/.dsh/storages/workspace.json` → `global.archivedSessionIds`）。
 * 桌面侧栏按它过滤归档会话，手机端要同口径，否则归档的线会重新冒出来。
 */
function archivedSessionIds() {
  try {
    const data = JSON.parse(readFileSync(join(dshHome(), 'storages', 'workspace.json'), 'utf8'));
    const list = data && data.global && data.global.archivedSessionIds;
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}

/** 活会话实时活跃时间：内存 updatedAt → 事件池末尾事件 time（与桌面 GUI updatedAt 同更新时机）。 */
function liveActivity(live) {
  if (!live) return 0;
  const stamped = Number(live.updatedAt || live.time || 0);
  let fromEvents = 0;
  try {
    const events = Array.isArray(live.events) ? live.events
      : (typeof live.snapshotEvents === 'function' ? live.snapshotEvents() : []);
    if (Array.isArray(events) && events.length) {
      // 事件未必严格有序，扫尾部 5 条取最大 time
      let max = 0;
      for (let i = events.length - 1; i >= 0 && i >= events.length - 5; i -= 1) {
        const t = Number(events[i] && events[i].time);
        if (Number.isFinite(t) && t > max) max = t;
      }
      fromEvents = max;
    }
  } catch { /* 事件池读不到就只用 updatedAt */ }
  return Math.max(stamped, fromEvents) || 0;
}

/** 会话行：活会话 + 冷会话（controller.list 投影）合并成统一结构。 */
function listSessions(ctx) {
  const controller = ctx.get('sessionController');
  const sessions = ctx.get('sessions');
  const rows = controller && typeof controller.list === 'function' ? controller.list() : [];
  const items = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sessionId = String((row && row.sessionId) || (row && row.id) || '');
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const live = sessions && typeof sessions.get === 'function'
      // 2026-10-27：会话 id 有带/不带 `session-` 前缀两种写法，两种都试
      ? (sessions.get(sessionId) || sessions.get(String(sessionId).replace(/^session-/, '')))
      : undefined;
    const projected = row && row.projections && row.projections.values ? row.projections.values.title : undefined;
    const title = (live ? titleOfSession(ctx, live) : '')
      || (typeof projected === 'string' ? projected : '')
      || titleFromCache(sessionId)
      || `（未命名 ${sessionId.slice(0, 8)}…）`;
    items.push({
      sessionId,
      title,
      project: projectOf(title),
      member: memberOf(title),
      running: isRunning(ctx, sessionId) || Boolean(row && row.running),
      subagent: Boolean(row && (row.origin === 'subagent' || row.parentSessionId)),
      // 活会话活跃时间三级取：内存 updatedAt → **事件池末尾事件 time**（运行中回合 projcache 不写、
        // updatedAt 可能缺 → 实测 DSH sync工程师运行中 lastActivity=0 被垫底，桌面却排第 2；
        // 桌面 GUI 的 updatedAt 随事件到达更新，事件池末尾 time 与它同时点）→ row 投影 → projcache
        lastActivity: liveActivity(live) || Number((row && (row.lastActivity || row.updatedAt || row.time)) || 0) || activityFromCache(sessionId),
        // P2（2026-10-27；2026-10-28 杨航拍板「压缩，不换线」）：上下文压力，供侧栏/群聊按 ≥70% 提示执行压缩
        ...(pressureFromCache(sessionId) || {}),
    });
  }
  // 没有 controller.list 时退回活会话集合
  if (items.length === 0 && sessions && typeof sessions.list === 'function') {
    for (const session of sessions.list()) {
      const title = titleOfSession(ctx, session) || `（未命名 ${String(session.id).slice(0, 8)}…）`;
      items.push({
        sessionId: String(session.id),
        title,
        project: projectOf(title),
        member: memberOf(title),
        running: isRunning(ctx, session.id),
        subagent: Boolean(session.header && (session.header.origin === 'subagent' || session.header.parentSession)),
        lastActivity: Number(session.updatedAt || session.time || 0),
      });
    }
  }
  // 冷会话底册：DSH 重启后 `controller.list()` 只含「本次启动后碰过」的会话（实测 165 条投影只返回 7 条），
  // 其余会话只剩 projcache 投影。桌面侧栏读的是 GUI 自己的完整会话存储，所以这里必须把 projcache 补齐，
  // 否则手机端项目会缺一大半（2026-10-21 实测：只有「应用开发 / A股每日复盘」两个项目）。
  try {
    const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const sessionId = entry.name.slice(0, -5);
      if (!sessionId || seen.has(sessionId)) continue;
      const rows = projectionCache(sessionId);
      const title = typeof (rows.title && rows.title.val) === 'string' ? rows.title.val : '';
      if (!title) continue;
      seen.add(sessionId);
      items.push({
        sessionId,
        title,
        project: projectOf(title),
        member: memberOf(title),
        running: isRunning(ctx, sessionId),
        // `rows.subagent.val` 几乎所有会话都有（含 inheritedEventCount 之类），
        // 只有 `identity.mode === 'continuable'` 才是真子代理（实测主会话都是 '-'）
        subagent: Boolean(rows.subagent && rows.subagent.val && rows.subagent.val.identity && rows.subagent.val.identity.mode === 'continuable'),
        lastActivity: activityFromCache(sessionId),
        // P2（2026-10-27；2026-10-28 杨航拍板「压缩，不换线」）：上下文压力，供侧栏/群聊按 ≥70% 提示执行压缩
        ...(pressureFromCache(sessionId) || {}),
      });
    }
  } catch { /* 没有 projcache 就只用 controller.list 的结果 */ }
  // 归档过滤与桌面侧栏同口径（否则归档的线会在手机端重新冒出来）
  const archived = archivedSessionIds();
  const visible = items.filter((item) => !archived.has(item.sessionId));
  // 兜底去重（2026-10-23 实测线上 8900 返回每条 ×2，撞崩手机端 LazyRow key）：
  // seen 集合按源码逻辑已去重，但多实例/旧模块加载下仍可能出现重复，这里按 sessionId 再滤一次
  const unique = visible.filter((item, index) => visible.findIndex((row) => row.sessionId === item.sessionId) === index);
  unique.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  return unique;
}

/** 找会话：先按 id，再按标题片段（与 Host 侧 taskline_* 同一口径）。 */
function resolveSession(ctx, key) {
  const needle = String(key || '').trim();
  if (!needle) return undefined;
  const sessions = ctx.get('sessions');
  const store = sessions && typeof sessions.get === 'function' ? sessions : undefined;
  const direct = store ? store.get(needle) : undefined;
  if (direct) return direct;
  const all = store && typeof store.list === 'function' ? store.list() : [];
  const byId = all.find((s) => String(s.id) === needle);
  if (byId) return byId;
  const matched = all.find((s) => titleOfSession(ctx, s).includes(needle));
  return matched;
}

/** 消息池：复用桌面分列同款 `readSessionEvents`（活会话含 `snapshotEvents()` 实时事件——
 * 里面有 reasoning-chunks，思考才能流式；旧实现只认数组形态拿不到 → 回落持久层导致思考空白）。 */
async function readEvents(ctx, session) {
  try {
    const { events } = await readSessionEvents(ctx, session ? session.id : '');
    if (events.length) return events;
  } catch { /* 桌面同款读取不可用就走旧兜底 */ }
  const controller = ctx.get('sessionController');
  const pools = [];
  if (session && Array.isArray(session.events)) pools.push(session.events);
  if (session && session.events && Array.isArray(session.events.entries)) pools.push(session.events.entries);
  if (pools.length === 0 && controller && typeof controller.inspect === 'function') {
    try {
      const info = await controller.inspect(session.id);
      for (const candidate of [info.entries, info.events, info.prefix, info.record && info.record.events]) {
        if (Array.isArray(candidate)) { pools.push(candidate); break; }
      }
    } catch (error) {
      console.warn(`[dsh-sync-bridge] inspect failed: ${String(error)}`);
    }
  }
  return pools[0] || [];
}

/** 事件 → 手机端消息（保留完整文本，不截断；GUI 侧才截 140）。
 *
 * 实测（`~/.dsh/sessions/<id>/session.jsonl.zstd`，2026-10-20 解压核对）：
 * 持久化的 `assistant/message` 是**压缩形态**——`data` 为空，正文在
 * `assistant/chunk`（`chunk.type === 'block-end'` 的 `block.text`）或
 * `text-chunks` / `reasoning-chunks`（`texts` 数组，靠 `sourceEventSeqs` 引用）里。
 * 只读 `data.message` 会漏掉全部 agent 回复，所以这里按 turn/step 重建文本块。
 */
export function scanConversation(events) {
  const items = [];
  const blocks = new Map(); // stepKey -> Map(blockIndex -> {type, text})
  const consumed = new Set(); // 已被 assistant/message 消费的 stepKey
  const steps = []; // 执行过程：思考步 + 工具卡片（手机上展开看 Think / 参数 / 输出 / 报错）
  const openCalls = new Map(); // callId -> step record
  const openQueue = []; // 未完成工具卡片，FIFO 兜底配对
  const llmByKey = new Map(); // stepKey -> 思考步记录（assistant/message 里的 reasoning 回填到它）
  const turnStartAt = new Map(); // turn -> 起始时间（turn/end 算轮次耗时）
  let lastKey = '';
  let lastTurn = 0;
  const stepKey = (turn, step) => `${turn}:${step}`;
  const bucket = (key) => {
    if (!blocks.has(key)) blocks.set(key, new Map());
    return blocks.get(key);
  };
  const append = (key, index, type, text, replace) => {
    const map = bucket(key);
    const prev = map.get(index);
    if (replace) {
      map.set(index, { type, text });
    } else {
      map.set(index, {
        type: prev && prev.type ? prev.type : type,
        text: `${prev ? prev.text : ''}${text}`,
      });
    }
  };
  const textOfStep = (key) => {
    const map = blocks.get(key);
    if (!map) return '';
    return [...map.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .filter(([, block]) => block.type === 'text')
      .map(([, block]) => block.text)
      .join('')
      .trim();
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const data = event.data || {};

    // —— 轮次边界 / 模型重试（2026-10-27 用户报「手机没显示 Analysis completed / Retried model request」）——
    // 桌面原生化渲染的两类行：`turn/end(completed)` → 「Analysis completed」分组标题；
    // `llm/retry` → 「Retried model request (2/5) · 2s」。桥此前完全忽略这些事件类型。
    if (event.type === 'turn/start') {
      if (data.turn !== undefined) lastTurn = Number(data.turn);
      // 跨轮僵尸收口（2026-10-27 用户报「两个思考中」）：新轮开始时把更早轮次还开着的步一律收口——
      // 否则中断/重试轮会留下 running=true 的 llm 步，手机端永久显示「思考中…」。
      for (const row of steps) {
        if (row.running && row.turn !== lastTurn) {
          row.running = false;
          if (row.ms === null) row.ms = Math.max(0, Number(event.time || 0) - (row.start || 0));
        }
      }
      turnStartAt.set(lastTurn, Number(event.time || 0));
      continue;
    }

    if (event.type === 'turn/end') {
      const turn = data.turn === undefined ? lastTurn : Number(data.turn);
      const reason = data.reason || {};
      const kind = String(reason.kind || '');
      const started = turnStartAt.get(turn);
      const ms = started ? Math.max(0, Number(event.time || 0) - started) : null;
      // 该轮所有还开着的步强制收口（中断/重试轮没有 assistant/message 落幕 → 否则永远 running）
      for (const row of steps) {
        if (row.running && row.turn === turn) {
          row.running = false;
          if (row.ms === null) row.ms = Math.max(0, Number(event.time || 0) - (row.start || 0));
        }
      }
      // 只给正常完成/中断的轮次收尾行（error 已由步骤里的 error 行体现）
      const label = kind === 'interrupted' ? 'Stopped' : kind === 'completed' ? 'Analysis completed' : '';
      if (label) {
        steps.push({
          turn,
          key: `turn:${turn}:end:${steps.length}`,
          kind: 'turn',
          name: label,
          icon: kind === 'interrupted' ? '■' : '✓',
          detail: '',
          output: '',
          error: false,
          start: started || Number(event.time || 0),
          ms,
          running: false,
        });
      }
      continue;
    }

    if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
      const turn = data.turn === undefined ? lastTurn : Number(data.turn);
      if (event.type === 'llm/retry') {
        const retry = Number(data.retry || 0);
        const max = Number(data.maxRetries || 0);
        const failure = data.failure || {};
        const message = String(failure.message || failure.code || '').trim();
        steps.push({
          turn,
          key: `retry:${String(data.retryId || steps.length)}`,
          kind: 'retry',
          name: `Retried model request (${retry}/${max})`,
          icon: '↻',
          detail: message.slice(0, 1200),
          output: '',
          error: true,
          start: Number(event.time || 0),
          ms: null,
          running: false,
        });
      }
      continue;
    }

    // —— 执行过程（手机上也要像桌面端那样看到 Think / 工具 / 报错）——
    // 事件形状对齐桌面端 client.js：`step/start` 起一条思考步，`tool/call` 起一条工具卡片，
    // `tool/result` 用 callId 回填耗时/输出/错误（真实事件不带 callId 时按先进先出兜底）。
    if (event.type === 'step/start') {
      if (data.turn !== undefined && data.step !== undefined) lastKey = stepKey(data.turn, data.step);
      const record = {
        turn: data.turn === undefined ? lastTurn : Number(data.turn),
        key: lastKey,
        kind: 'llm',
        name: '思考',
        icon: '✳',
        detail: '',
        output: '',
        error: false,
        start: Number(event.time || 0),
        ms: null,
        running: true,
      };
      steps.push(record);
      llmByKey.set(lastKey, record);
      continue;
    }

    if (event.type === 'step/end') {
      // step 结束：给最后一条还开着的思考步补耗时（桌面端同样以 step 边界计时）
      const open = [...steps].reverse().find((row) => row.kind === 'llm' && row.running);
      if (open && !open.ms) {
        open.ms = Math.max(0, Number(event.time || 0) - open.start);
        open.running = false;
      }
      continue;
    }

    if (event.type === 'tool/call') {
      const call = data.call || {};
      const callId = data.callId || data.callID || call.callId || call.id || '';
      const name = String(data.name || data.toolName || data.tool || call.name || 'tool');
      const argsRaw = data.arguments !== undefined ? data.arguments : data.args;
      const record = {
        turn: data.turn === undefined ? lastTurn : Number(data.turn),
        key: `${lastKey}:t${steps.length}`,
        kind: 'tool',
        name: toolDisplayName(name),
        icon: toolIconOf(name),
        detail: argsBrief(argsRaw),
        output: '',
        error: false,
        start: Number(event.time || 0),
        ms: null,
        running: true,
      };
      steps.push(record);
      if (callId) openCalls.set(callId, record);
      openQueue.push(record);
      continue;
    }

    if (event.type === 'tool/result') {
      const call = data.call || {};
      const callId = data.callId || data.callID || call.callId || call.id || '';
      const message = data.message || {};
      const record = (callId && openCalls.get(callId)) || openQueue.find((row) => row.running) || null;
      if (record) {
        record.ms = Math.max(0, Number(event.time || 0) - record.start);
        record.error = Boolean(message.isError || data.error);
        record.output = typeof data.brief === 'string' && data.brief
          ? data.brief
          : (Array.isArray(message.content) ? message.content : [])
            .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
            .join('\n')
            .trim();
        record.running = false;
        if (callId) openCalls.delete(callId);
        const at = openQueue.indexOf(record);
        if (at >= 0) openQueue.splice(at, 1);
      }
      continue;
    }

    if (event.type === 'assistant/chunk') {
      const chunk = data.chunk || {};
      if (data.turn !== undefined) lastTurn = Number(data.turn);
      if (data.turn !== undefined && data.step !== undefined) lastKey = stepKey(data.turn, data.step);
      if (chunk.type === 'block-end' && chunk.block && typeof chunk.block.text === 'string') {
        // block-end 带整块全文，是权威版本（实测 chunks 与 block-end 并存，直接拼会翻倍）→ 覆盖
        append(lastKey, String(chunk.index === undefined ? 0 : chunk.index), String(chunk.block.type || 'text'), chunk.block.text, true);
      }
      continue;
    }

    if (event.type === 'text-chunks' || event.type === 'reasoning-chunks') {
      if (data.turn !== undefined) lastTurn = Number(data.turn);
      if (data.turn !== undefined && data.step !== undefined) lastKey = stepKey(data.turn, data.step);
      const texts = Array.isArray(data.texts) ? data.texts.join('') : '';
      if (texts) append(lastKey, String(data.index === undefined ? 0 : data.index), event.type === 'text-chunks' ? 'text' : 'reasoning', texts);
      continue;
    }

    if (event.type === 'assistant/message') {
      const direct = data.message || (data.role ? data : undefined);
      let text = '';
      let reasoning = '';
      if (direct && Array.isArray(direct.content)) {
        text = direct.content
          .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
          .trim();
        // 思考正文在这里：实测持久化的 assistant/message.content 里带 {type:'reasoning', text} 块
        // （本会话 205 条 reasoning / 515 tool-call / 91 text），之前只取 text 块所以「思考」永远是空的
        reasoning = direct.content
          .filter((part) => part && part.type === 'reasoning' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n\n')
          .trim();
      }
      const target = llmByKey.get(lastKey);
      if (target && reasoning) target.detail = reasoning;
      if (!text) text = textOfStep(lastKey);
      if (!text) continue;
      consumed.add(lastKey); // 该步已落成完整消息，避免 streaming 预览重复同一段
      items.push({
        seq: items.length,
        eventId: String(event.id || event.key || event.seq || index),
        role: 'agent',
        turn: lastTurn,
        time: Number(event.time || 0),
        text,
      });
      continue;
    }

    if (event.type !== 'user/message') continue;
    const message = data.message || data;
    if (!message || message.role !== 'user') continue;
    const source = message.source || {};
    if (source.kind && source.kind !== 'user') continue; // 插件注入的 notice / 系统快照不进手机端消息流
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (!text) continue;
    items.push({
      seq: items.length,
      eventId: String(event.id || event.key || event.seq || index),
      role: 'user',
      time: Number(event.time || 0),
      text,
    });
  }
  // 流式预览：最后一步还没等到 assistant/message 落幕时，把已到的 text 块给手机端看
  const streaming = lastKey && !consumed.has(lastKey) ? textOfStep(lastKey) : '';

  // 思考步正文：从 reasoning 块取（桌面端 Think 行显示的就是这段）
  const reasoningOf = (key) => {
    const map = blocks.get(key);
    if (!map) return '';
    return [...map.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .filter(([, block]) => block.type === 'reasoning')
      .map(([, block]) => block.text)
      .join('')
      .trim();
  };
  for (const step of steps) {
    if (step.kind === 'llm') {
      // 思考正文**每次都重取** reasoning 块：blocks 随 reasoning-chunks 增长，
      // 这样运行中的思考才是流式增长（之前 `!step.detail` 挡住更新 → 整段一次性出现）
      const reasoning = reasoningOf(step.key);
      if (reasoning) step.detail = reasoning.slice(0, 8000);
      // 该 step 已有完整消息落地 = 这一步结束了
      step.running = !consumed.has(step.key) && step.running;
      if (!step.detail && step.running) step.detail = textOfStep(step.key).slice(0, 8000);
      step.key = undefined;
    }
  }
  // 连续 read 类工具折叠成桌面同款组标题「⌃ Preparing to read files · <首个路径>」
  // （DSH 核心原生渲染：连着读多个文件时归一个可折叠组；手机端不折叠，只加一行组标题，2026-10-27）
  const merged = [];
  for (let i = 0; i < steps.length; i += 1) {
    const row = steps[i];
    if (row.kind === 'tool' && row.icon === '📖') {
      let j = i;
      while (j < steps.length && steps[j].kind === 'tool' && steps[j].icon === '📖') j += 1;
      if (j - i >= 2) {
        merged.push({
          turn: row.turn,
          kind: 'group',
          name: 'Preparing to read files',
          icon: '⌃',
          detail: row.detail,
          output: '',
          error: false,
          start: row.start,
          ms: null,
          running: false,
        });
      }
      for (let k = i; k < j; k += 1) merged.push(steps[k]);
      i = j - 1;
      continue;
    }
    merged.push(row);
  }
  // 只给最近 60 步，避免一次响应过大（手机端只展示当轮/最近几轮）
  return { items, streaming, steps: merged.slice(-60) };
}

/** 工具图标：按名字粗分（与桌面 client.js toolIconOf 同一套规则）。 */
function toolIconOf(name) {
  const key = String(name || '').toLowerCase();
  if (/read|glob|grep|search|list|view|\bcat\b|\bfind\b|\bls\b/.test(key)) return '📖';
  if (/pwsh|powershell|bash|shell|zsh|\bcmd\b|exec|terminal|command/.test(key)) return '⚡';
  if (/edit|write|patch|replace|apply/.test(key)) return '✏️';
  return '🔧';
}

/** 工具显示名（桌面原生化渲染用自然语言，如 read_image → "Read images"；手机端此前显示 "Read_image"）。 */
function toolDisplayName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'Tool';
  const special = {
    read_image: 'Read images',
    vision_read: 'Read images',
    read: 'Read file',
    write: 'Write file',
    edit: 'Edit file',
    grep: 'Search text',
    glob: 'Find files',
    pwsh: 'Run command',
    web_fetch: 'Fetch URL',
    taskline_create: 'Create taskline',
    taskline_prompt: 'Message teammate',
    agent_message: 'Message agent',
    plugin_manager: 'Manage plugins',
    cordis_inspect_query: 'Inspect plugin',
    get_goal: 'Read goal',
    create_goal: 'Create goal',
    update_goal: 'Update goal',
  };
  const hit = special[raw.toLowerCase()];
  if (hit) return hit;
  // 兜底：下划线/连字符转空格 + 每词首字母大写（read_image → Read Image）
  return raw
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** 工具入参摘要：优先取人类可读的键（command / file_path / query…），像桌面端那样显示意图而不是 JSON。 */
function argsBrief(value) {
  const clip = (text) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    // 宿主精简事件会把 arguments 压成 JSON 字符串（client.js 注释实测），解出来再取可读键
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return argsBrief(JSON.parse(trimmed));
      } catch { /* 不是合法 JSON 就按普通字符串 */ }
    }
    return clip(value);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    // 桌面工具行的 `·` 后面显示的是工具调用自带的自然语言 description
    // （实测 tool/call arguments 里带 {"command": "...", "description": "List dsh folder contents"}）——
    // 此前只取 command/file_path → 手机端显示成一长串原始命令，与桌面不一致（2026-10-27 用户贴图）。
    const described = value.description;
    if (typeof described === 'string' && described.trim()) return clip(described.trim());
    const keys = ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'old_string', 'new_string', 'content'];
    const parts = [];
    for (const key of keys) {
      const val = value[key];
      if (typeof val === 'string' && val.trim()) parts.push(val.trim());
    }
    if (parts.length) return clip(parts.join(' · '));
    // 没有已知键就按「key=value」列出来
    const pairs = Object.entries(value)
      .map(([key, val]) => `${key}=${typeof val === 'string' ? val : JSON.stringify(val)}`)
      .join(' ');
    if (pairs.trim()) return clip(pairs);
  }
  try {
    const text = JSON.stringify(value);
    return clip(text);
  } catch {
    return String(value).slice(0, 300);
  }
}

/** 兼容旧签名：只要消息列表。 */
export function toMessages(events) {
  return scanConversation(events).items;
}

/**
 * 启动 bridge。
 * @param {object} ctx cordis 上下文（Host 半）。
 * @param {{root?:string, host?:string, ports?:number[], enabled?:boolean}} options
 * @returns {{close: Function, info: object}|undefined}
 */


/**
 * 余额监控用哪个 python（2026-11-05 修：Hermes venv 的 Scripts 目录已被清空，
 * 写死路径 spawn 直接 ENOENT → 手机「模型与余额」页红字报错）。
 * 按优先级探测，最后退回 PATH 上的 python。
 */
function resolvePythonForBalance() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    // 首选：余额监控工具自管的 venv（与 Hermes 升级解耦，2026-11-04 余额监控工程师确认的规范解释器）
    join(local, 'api-balance-monitor', 'venv', 'Scripts', 'python.exe'),
    join(local, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe'),
    join(local, 'Programs', 'Python', 'Python313', 'python.exe'),
    join(local, 'Programs', 'Python', 'Python312', 'python.exe'),
    join(local, 'hermes', 'hermes-agent', 'venv', 'bin', 'python'),
  ];
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate; } catch { /* 继续试下一个 */ }
  }
  return 'python';
}

/**
 * 从会话事件推导「正在等用户回答」的提问（2026-11-04 用户要求手机也能答）。
 *
 * `ask_user_question` 是一个**工具调用**，所以判定规则：
 * - `tool/call(name=ask_user_question)` 没有配对 `tool/result` → **agent 正在阻塞等你回答**；
 * - 之后出现 `user/message` 且 `source.kind === 'user-question-reply'` 且 callId 相同 → 已回答，剔除。
 *
 * 参数结构与桌面弹窗一致：`{ questions: [{ id, header, question, options:[{label,description}], multi_select }] }`
 * （实测 56 次真实调用确认）。
 */
/**
 * 问题内容指纹（2026-11-09）。
 *
 * **为什么需要**：源码实测（app.asar `askTimed`）——`wait: {callId, timed}` **只在 askTimed 路径**注入，
 * 普通 `ask()` 的 request **没有 wait、拿不到 callId**（旧注释"ask() 会带 wait"是错的，害我排查了 3 轮）。
 * 但 waterfall handler 可以直接 return 一个 `{answers:[{id,selected}]}` 来接管，不需要 callId。
 * 所以改用「会话 id + 问题内容指纹」做匹配键：handler 从 request.questions 算，
 * /sync/answer 从 events 里的 tool/call arguments.questions 算，两边必然一致。
 */
function questionFingerprint(questions) {
  const parts = (Array.isArray(questions) ? questions : []).map(
    (q) => String((q && q.id) || '') + ':' + String((q && q.question) || ''),
  );
  const raw = parts.join('|');
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0;
  return 'fp' + hash.toString(36) + '-' + raw.length;
}

function pendingQuestionsOf(events) {
  const calls = new Map();
  for (const event of events || []) {
    const data = (event && event.data) || {};
    if (event.type === 'tool/call') {
      const name = data.name || (data.call && data.call.name) || '';
      if (name !== 'ask_user_question') continue;
      const callId = String(data.callId || data.id || (data.call && data.call.id) || '');
      if (!callId) continue;
      let args = data.arguments !== undefined ? data.arguments : (data.call && data.call.arguments);
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      calls.set(callId, {
        callId,
        turn: data.turn,
        step: data.step,
        at: Number(event.time || 0),
        questions: args && Array.isArray(args.questions) ? args.questions : [],
        closed: false,
      });
    } else if (event.type === 'tool/result') {
      // 实测结构（2026-11-04 抓真实事件确认）：callId 在 message.toolCallId / message.source.callId，
      // **不在 data.callId** —— 用错字段会导致所有提问都被判成"待回答"（幽灵提问）。
      const message = data.message || {};
      const callId = String(
        data.callId || data.id || message.toolCallId ||
        (message.source && message.source.callId) || '',
      );
      const item = calls.get(callId);
      if (item) item.closed = true;
    } else if (event.type === 'user/message') {
      const message = data.message || data;
      const source = (message && message.source) || {};
      if (source.kind === 'user-question-reply' && source.callId) {
        const item = calls.get(String(source.callId));
        if (item) item.closed = true;
      }
    }
  }
  return [...calls.values()].filter((item) => !item.closed && item.questions.length > 0);
}

/** 取会话当前活着的 root agent（用于 userQuestions.answer；会话没有活 agent 时返回 null）。 */
async function liveAgentOf(ctx, sessionId) {
  const controller = ctx.get('sessionController');
  if (!controller) return null;
  try {
    if (typeof controller.liveAgent === 'function') {
      const live = controller.liveAgent(sessionId);
      if (live) return live;
    }
    if (typeof controller.resolveAgent === 'function') {
      const found = await controller.resolveAgent(sessionId);
      if (found && !found.error && found.agent) return found.agent;
    }
  } catch { /* 会话已结束/无权 → 当作拿不到 */ }
  return null;
}

export function startSyncBridge(ctx, options = {}) {
  // —— 交互提问 waterfall 接管（2026-11-04 用户要求手机也能答）——
  // `phoneWatching`：手机最近在看的会话（只有这些会话的提问才接管，避免抢掉桌面弹窗）；
  // `phoneWaiters`：callId -> waiter，手机提交答案时直接 resolve waterfall；
  // 桌面链路**照常并行**（用户可能就在电脑前），谁先答用谁。
  const phoneWatching = new Map();
  const phoneWaiters = new Map();
  const PHONE_WATCH_MS = 10 * 60 * 1000;
  // ⚠️ `user-questions/request` 是 **agent 作用域的 Cordis waterfall**：注册在根作用域的
  // listener 收不到（2026-11-04 实测：手机提交被拒、phoneWaiters 里没有 callId 即证据）。
  // 正解 = 在该 agent 自己的 `ctx`（`agent.ctx`）上注册，与 `waterfall(scopeTarget(agent, agent), ...)` 同作用域。
  const hookedScopes = new Map();   // sessionId -> dispose
  let releaseUserQuestions = null;

  let questionHookCalls = 0;
  let questionTakeovers = 0;   // 真正进入接管分支（建了 waiter）的次数——与 hookCalls 区分
  // 最近几次 handler 调用的诊断快照（/sync/questions/debug 直接读，不必翻 DSH 日志）
  const questionDiag = [];
  const makeQuestionHandler = (sessionId) => async (request, next) => {
      questionHookCalls += 1;
      try {
        const agent = request && request.agent;
        const reqSessionId = agent && agent.session && agent.session.id ? String(agent.session.id) : sessionId;
        // 实测：ask() 会把 `wait: { callId }` 带进 request（dsh-tool-ask-user → userQuestions.ask）
        const waitCallId = request && request.wait && request.wait.callId ? String(request.wait.callId) : '';
        const askQuestions = request && Array.isArray(request.questions) ? request.questions : [];
        // 主键失败时退回指纹键（普通 ask() 没有 wait.callId，见 questionFingerprint 注释）
        const callId = waitCallId || (reqSessionId && askQuestions.length ? reqSessionId + '|' + questionFingerprint(askQuestions) : '');
        const watchedAt = phoneWatching.get(reqSessionId);
        const fresh = Boolean(watchedAt && Date.now() - watchedAt < PHONE_WATCH_MS);
        // 诊断快照（2026-11-09）：只进内存 ring buffer，/sync/questions/debug 可读。
        // 用来定位「handler 被调用但没接管」的三个条件断点。
        try {
          questionDiag.push({
            at: new Date().toISOString(),
            callId: callId || null,
            reqSessionId: reqSessionId || null,
            waitKeys: request && request.wait ? Object.keys(request.wait) : null,
            agentKeys: agent ? Object.keys(agent) : null,
            agentSessionKeys: agent && agent.session ? Object.keys(agent.session) : null,
            watchedAt: watchedAt || null,
            fresh,
            watchingKeys: Array.from(phoneWatching.keys()),
          });
          if (questionDiag.length > 12) questionDiag.shift();
        } catch (e) { /* 诊断不影响主流程 */ }
        if (!callId || !reqSessionId || !fresh) return await next();
        questionTakeovers += 1;
        // 桌面链路照常并行（用户可能就在电脑前，谁先答用谁）。
        // ⚠️ 别为做实验挂起 desktop：那会让每次提问都干等到 120s 超时才弹桌面
        //（2026-11-09 我试过一次，立刻回滚）。
        //
        // ⚠️⚠️ Cordis 的 `next()` 是**一次性**的（waterfall 内部 `called` 闭包锁，
        // 二次调用直接 throw `next() called multiple times`）——2026-11-09 实测惨案：
        // desktop 已经调过 next()，phone 超时/出错后 catch 分支又调一次 → 提问彻底失败。
        // 所以用 nextCalled 记账：catch 里若 next 已调过，就复用 desktop 那个在飞的 Promise。
        let nextCalled = false;
        const desktop = Promise.resolve().then(() => {
          nextCalled = true;
          return next();
        });
        desktop.catch(() => {});
        // waiter.resolve 收到的就是 AskUserQuestionAnswer（{answers:[{id,selected}]}），
        // waterfall handler 直接 return 它 = 接管成功（不用 callId 也能答）。
        const phone = new Promise((resolve, reject) => {
          const waiter = { resolve, reject };
          phoneWaiters.set(callId, waiter);
          const timer = setTimeout(() => {
            if (phoneWaiters.get(callId) === waiter) {
              phoneWaiters.delete(callId);
              reject(new Error('phone answer timeout'));
            }
          }, 120000);
          if (typeof timer.unref === 'function') timer.unref();
        });
        phone.catch(() => {});
        try {
          return await Promise.race([desktop, phone]);
        } finally {
          phoneWaiters.delete(callId);
        }
      } catch (error) {
        console.warn('[dsh-sync-bridge] question handler failed: ' + String(error && error.message));
        // next 已调过就绝不能再调（Cordis 会抛 next() called multiple times）——
        // 复用在飞的 desktop 结果；它若也失败，才把原始错误抛出去。
        if (nextCalled) {
          try {
            return await desktop;
          } catch {
            throw error;
          }
        }
        return await next();
      }
  };

  /**
   * 注册全局 waterfall 监听（2026-11-04 关键修复）。
   *
   * 之前两次都失败（根作用域注册 / 挂 agent.ctx 注册），根因在 Cordis 的 dispatch 过滤：
   * `hook.global || !filter || filter(agentScope)`。agent-scoped 的 waterfall 用 `scopeTarget(agent, agent)`
   * 做字段过滤，只放行「无 scope tag 的 listener」或「tag 在该 agent 祖先链上」的 listener。
   * **`{ global: true }` 的监听无条件通过**（dispatch 里第一项判断），这是插件接管 agent 作用域事件的唯一正路。
   */
  const hookSessionQuestions = async (sessionId) => {
    const key = String(sessionId || '');
    if (!key) return;
    // 只登记"手机在看哪个会话"；监听本身是全局的，一次注册即可
    hookedScopes.set(key, hookedScopes.get(key) ?? null);
  };

  // 全局注册（`{ global: true }` 是 Cordis dispatch 过滤器的无条件放行通道，见 hookSessionQuestions 注释）
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on(
        'user-questions/request',
        (request, next) => makeQuestionHandler('')(request, next),
        { global: true },
      );
      releaseUserQuestions = typeof off === 'function' ? off : null;
    } catch (error) {
      console.warn('[dsh-sync-bridge] global user-questions listener failed: ' + String(error && error.message));
    }
  }
  // root 惰性解析：apply 时 workspaceRegistry 往往还没登记仓库（实测一次性快照会拿到 profile 目录），
  // 每次请求重选「带 .git + .hub/projects 的 workspace」。
  const rootOverride = options.root;
  const rootOf = () => {
    if (rootOverride) return rootOverride;
    try {
      const registry = ctx.get('workspaceRegistry');
      const list = registry && typeof registry.list === 'function' ? registry.list() : [];
      const paths = (list || []).map((workspace) => workspace && workspace.path).filter(Boolean);
      // 2026-10-28 修：多工作区都带 .hub 时不能取「第一个」（实测 registry 顺序把 scifork-bone
      // 排前面 → 桥读错仓库的 order/pinned/board，手机星阶置顶丢失）。取 .hub 下文件**最近修改**
      // 的工作区 = 当前真正活跃的那个。
      let best = '';
      let bestAt = -1;
      for (const path of paths) {
        const hubDir = join(path, '.hub');
        if (!existsSync(join(path, '.hub', 'projects')) || !existsSync(join(path, '.git'))) continue;
        let at = 0;
        for (const marker of ['order.json', 'pinned.json', 'board.md']) {
          try { at = Math.max(at, statSync(join(hubDir, marker)).mtimeMs); } catch { /* 无此文件 */ }
        }
        if (at > bestAt) { bestAt = at; best = path; }
      }
      if (best) return best;
    } catch { /* registry 不可用就走 cwd */ }
    return process.cwd();
  };
  const host = options.host || '0.0.0.0';
  const ports = Array.isArray(options.ports) && options.ports.length ? options.ports : DEFAULT_PORTS;
  const { token, path } = options.token
    ? { token: String(options.token), path: '(injected)' }
    : ensureToken();

  // —— 会议录音/实时字幕辅助（见下方 /sync/mic/* 路由）——
  // sid 严格白名单（字母数字 . _ -，≤64）防路径穿越；目录固定在 `.hub/mic/`。
  const MIC_EXTS = ['m4a', 'webm', 'ogg', 'wav', 'mp3', 'aac'];
  const micBaseDir = () => join(rootOf(), '.hub', 'mic');
  const micSidOf = (url) => {
    const sid = String(url.searchParams.get('sid') || '').trim();
    return /^[A-Za-z0-9._-]{1,64}$/.test(sid) ? sid : '';
  };
  const micDirOf = (sid) => join(micBaseDir(), sid);

  // 原段自动清理（2026-10-30 初版；2026-11-06 与「日常 · 军师」对齐后重写）。
  //
  // **旧实现的 bug**：条件是 `maxSeq > 0 && textMax >= maxSeq`，而 `maxSeq` 只从根目录
  // `N.wav` 文件名提取 —— 2026-11-06 起调试音频默认不生成，**新目录 maxSeq=0 → 永远不满足
  // 条件 → .hub/mic 无限堆积**（实测 10-30 起的老目录全在）。
  //
  // **新规则（三重条件，安全优先）**：
  //   ① 必须存在 `.archived` 标记（军师每日归档成功才写）—— 归档没跑/失败 = 永不自动删，防数据丢失；
  //   ② 目录 idle > 24h；
  //   ③ 标记里的句数 >= 当前文字句数（`.archived` 是**快照**不是"录音结束"，正在录的会话
  //      标记句数会落后于实际 → 不删，避免删掉进行中的录音）。
  // 懒清理：5 分钟内最多一次，由 /sync/mic/* 请求触发，不额外起定时器。
  let micGcAt = 0;
  const micGc = () => {
    const now = Date.now();
    if (now - micGcAt < 5 * 60 * 1000) return;
    micGcAt = now;
    try {
      const base = micBaseDir();
      if (!existsSync(base)) return;
      for (const name of readdirSync(base)) {
        const dir = join(base, name);
        let dirStat;
        try { dirStat = statSync(dir); } catch { continue; }
        if (!dirStat.isDirectory()) continue;
        let newest = dirStat.mtimeMs;
        let maxSeq = 0;
        let textMax = 0;
        for (const file of readdirSync(dir)) {
          const seq = Number((file.match(/^(\d+)\./) || [])[1]);
          if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
          try { newest = Math.max(newest, statSync(join(dir, file)).mtimeMs); } catch { /* 刚被删 */ }
        }
        const textDir = join(dir, 'text');
        if (existsSync(textDir)) {
          for (const file of readdirSync(textDir)) {
            const seq = Number((file.match(/^(\d+)\.json$/) || [])[1]);
            if (Number.isInteger(seq) && seq > textMax) textMax = seq;
            try { newest = Math.max(newest, statSync(join(textDir, file)).mtimeMs); } catch { /* 刚被删 */ }
          }
        }
        // ① 必须已归档：读 .archived 标记（军师归档成功后写，含句数快照）
        const archivedPath = join(dir, '.archived');
        let archived = null;
        if (existsSync(archivedPath)) {
          try { archived = JSON.parse(readFileSync(archivedPath, 'utf8')); } catch { archived = {}; }
        }
        if (!archived) continue;                       // 没归档过 → 永不删（安全优先）
        if (now - newest <= 24 * 60 * 60 * 1000) continue;   // ② 还在活动窗口内
        // ③ 标记是快照：有比快照更新的内容说明还在录/未归档，不能删
        const archivedSentences = Number(archived.sentences || 0);
        if (textMax > 0 && archivedSentences < textMax) continue;
        rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* 清理失败不影响主流程 */ }
  };

  const routes = {
    'GET /sync/health': ({ url }) => {
      // P10-①（2026-10-31）：?probe=<sessionId> 现场回显 projectionCacheFile 三候选的
      // existsSync / readFileSync 判定——一次定案「活分支 29 条空字段」的进程内读取问题。
      let probe = null;
      const probeId = String((url && url.searchParams.get('probe')) || '').trim();
      if (probeId) {
        const bare = probeId.replace(/^session-/, '');
        const cands = [...new Set([`${probeId}.json`, `session-${bare}.json`, `${bare}.json`])];
        probe = {
          id: probeId,
          dir: join(dshHome(), 'storages', 'session_projcache', 'sessions'),
          dirExists: (() => { try { return existsSync(join(dshHome(), 'storages', 'session_projcache', 'sessions')); } catch (e) { return `err:${e.code || e.name}`; } })(),
          candidates: cands.map((name) => {
            const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', name);
            const out = { name };
            try { out.exists = existsSync(file); } catch (e) { out.exists = `err:${e.code || e.name}`; }
            if (out.exists === true) {
              try {
                const parsed = JSON.parse(readFileSync(file, 'utf8'));
                const rows = parsed && parsed.record && parsed.record.rows;
                out.rows = rows ? Object.keys(rows).length : 0;
                out.contextPressure = Boolean(rows && rows.contextPressure);
                out.title = rows && rows.title && typeof rows.title.val === 'string' ? rows.title.val : '';
              } catch (e) { out.readError = String((e && (e.code || e.name)) || e); }
            }
            return out;
          }),
        };
      }
      return {
        ok: true,
        service: 'dsh-sync-bridge',
        version: 1,
        root: rootOf(),
        // A（2026-10-30）：projcache 读失败留痕——为空 = 无「读失败」记录（注意：existsSync 全 miss 走
        // 无候选路径不进此表，用 ?probe= 判）；有内容 = 这些文件在 host 进程里读不到，带错误码。
        projcacheErrors: projectionCacheLastError.size === 0
          ? []
          : [...projectionCacheLastError.entries()].slice(-5).map(([f, e]) => ({ file: f.split(/[\\/]/).pop(), error: e })),
        projcacheErrorTotal: projectionCacheLastError.size,
        ...(probe ? { probe } : {}),
      };
    },

    // 项目 = .hub/projects 下的目录 ∪ 会话标题前缀；members 给手机端渲染「项目行 + agent 芯片」
    // （头像来自 tasks.json 的 avatars；分身「成员｜任务」继承父 agent 头像，与桌面端同规则）
    'GET /sync/projects': () => {
      const sessions = listSessions(ctx);
      const fromSessions = new Set(sessions.map((s) => s.project).filter(Boolean));
      const fromBoard = new Set();
      try {
        const dir = join(rootOf(), '.hub', 'projects');
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) fromBoard.add(entry.name);
        }
      } catch { /* 没有 .hub 就只用会话前缀 */ }
      const names = [...new Set([...fromBoard, ...fromSessions])].sort((a, b) => a.localeCompare(b, 'zh'));
      // 全员统一头像表（2026-10-23 定稿，与 client.js DEFAULT_AVATARS 同一份）：
      // ① 不再读 tasks.json avatars 单独登记；② 全表 emoji 无重复；③ 无「工程师」宽泛角色。
      const DEFAULT_AVATARS = {
        Yat2: '🦉', Hermes: '🤖', 'QQ机器人管家': '🐧', 'DSH工程师': '🛠️', 'DSH sync工程师': '🌐',
        'Hermes 工程师': '🔨', 'Stelscala 工程师': '🖥️', 'Cashew Local 工程师': '📦',
        '千问语音工程师': '🎤', '余额监控工程师': '💰', 'TW应用工程师': '📱', '出题工程师': '✍️',
        'A股分析师': '📈', '雨课堂': '🎓', '书童': '📖', '秘书': '🗓️', '管家': '🎩', '流程搭档': '🔁',
        '旅游规划师': '🧭', '绘图师': '🎨', '汇报师': '📋', '文献管家': '🗂️', '维基管家': '📚',
        '单细胞师': '🧬', 'B细胞专家': '🔬', '骨髓专家': '🦴', '骨髓衰老研究': '⏳',
        '胸腺专家': '🛡️', '视网膜专家': '👁️', '我': '🧑',
      };
      // 全局头像注册表 `.hub/avatars.json`（桌面端唯一真源，2026-10-22 定稿；2026-10-29 手机端接入）。
      // 硬编码 DEFAULT_AVATARS 只覆盖早期成员，之后新建的（会议主持/网站助手/行程规划师/军师/
      // 流霞/日程管家…）只登记在注册表里 → 手机端全退化成 🤖 兜底（用户贴图实测）。
      const registryAvatars = (() => {
        try {
          const parsed = JSON.parse(readFileSync(join(rootOf(), '.hub', 'avatars.json'), 'utf8')) || {};
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch { return {}; }
      })();
      // 桌面权威顺序（`.hub/order.json`）：项目序 + 项目内 agent 序。
      // 2026-10-29 用户要求「对话页顶部 chips 的 agent 排序也要与桌面一致（最近活跃在前）」——
      // /sync/projects 的 members 直接按桌面 chips 序返回，各页面（群聊页/详情页）自动对齐。
      const desktopOrder = (() => {
        try {
          const parsed = JSON.parse(readFileSync(join(rootOf(), '.hub', 'order.json'), 'utf8')) || {};
          const list = Array.isArray(parsed.projects) ? parsed.projects : [];
          return list.map((project) => ({
            name: String(project && project.name || ''),
            chips: (Array.isArray(project && project.chips) ? project.chips : []).map((chip) => String(chip && chip.label || '')),
          })).filter((project) => project.name);
        } catch { return []; }
      })();
      const chipRankOf = (projectName) => {
        const entry = desktopOrder.find((project) => project.name === projectName);
        const chips = entry ? entry.chips : [];
        return (member) => {
          if (!chips.length) return Number.MAX_SAFE_INTEGER;
          const exact = chips.indexOf(member);
          if (exact >= 0) return exact;
          // 分身（父名｜任务）挂在父名那一档
          const base = member.includes('｜') ? member.split('｜')[0].trim() : member;
          const hit = chips.findIndex((label) => label === base || label.startsWith(`${base}｜`));
          return hit >= 0 ? hit : Number.MAX_SAFE_INTEGER;
        };
      };
      return {
        ok: true,
        items: names.map((name) => {
          const owned = sessions.filter((s) => s.project === name);
          const rank = chipRankOf(name);
          const members = owned.map((s) => {
            // 分身按基名继承父头像；查表顺序：注册表（真源）→ 内置兜底表
            const forkAt = s.member.indexOf('｜');
            const base = (forkAt > 0 ? s.member.slice(0, forkAt).trim() : '') || s.member;
            const avatar = String(
              registryAvatars[s.member] || registryAvatars[base]
              || DEFAULT_AVATARS[s.member] || DEFAULT_AVATARS[base] || '',
            );
            return { member: s.member, sessionId: s.sessionId, running: s.running, avatar };
          }).sort((a, b) => rank(a.member) - rank(b.member));
          return {
            name,
            sessions: owned.length,
            running: owned.filter((s) => s.running).length,
            board: existsSync(join(rootOf(), '.hub', 'projects', name, 'board.md')),
            members,
          };
        }),
      };
    },

    // 房间待办队列：`.hub/projects/<项目>/queue.json`（桌面端 saveRoomTodos 时 POST /hub/queue 落盘，
    // 手机端读同一份；桌面原本只存浏览器 localStorage，手机端读不到）
    'GET /sync/queue': ({ url }) => {
      const project = String(url.searchParams.get('project') || '').trim();
      const safe = project.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').trim();
      const file = join(rootOf(), '.hub', 'projects', safe, 'queue.json');
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) || {};
        return {
          ok: true,
          project: safe,
          updatedAt: Number(data.updatedAt) || 0,
          list: Array.isArray(data.list) ? data.list : [],
        };
      } catch {
        return { ok: true, project: safe, updatedAt: 0, list: [], note: '还没有待办队列' };
      }
    },

    // 桌面端权威顺序（`.hub/order.json`，桌面每次顺序变化 POST /hub/order 落盘）：
    // projects[{name, chips[{label, cloneCount}]}] —— 手机按此排序，与桌面按构造一致
    'GET /sync/order': () => {
      try {
        const file = join(rootOf(), '.hub', 'order.json');
        const data = JSON.parse(readFileSync(file, 'utf8')) || {};
        // 过期保护（2026-10-28）：快照只在变化时 POST → 可能留两天前的旧序（实测星阶已取消置顶
        // 但快照里还排第一）。超 30 分钟视为过期 → 返回空，手机回退 pinned+活跃排序（P1 生效后可靠）。
        const ageMs = Date.now() - Number(data.updatedAt || 0);
        if (!data.updatedAt || ageMs > 30 * 60 * 1000) {
          return { ok: true, updatedAt: 0, projects: [], stale: true };
        }
        return { ok: true, updatedAt: data.updatedAt, projects: Array.isArray(data.projects) ? data.projects : [] };
      } catch {
        return { ok: true, updatedAt: 0, projects: [], note: '桌面还没同步顺序' };
      }
    },

    // 置顶项目列表：`.hub/pinned.json`（桌面 togglePin 时 POST /hub/pinned 落盘）
    'GET /sync/pinned': () => {
      try {
        const file = join(rootOf(), '.hub', 'pinned.json');
        const data = JSON.parse(readFileSync(file, 'utf8')) || {};
        return { ok: true, list: Array.isArray(data.list) ? data.list : [] };
      } catch {
        return { ok: true, list: [], note: '还没有置顶' };
      }
    },

    // 图片（对话里 `[image] C:\...\hub-paste\xxx.png` 行的手机端渲染源）。
    // 安全：仅允许 %TEMP% 与仓库根目录下的图片文件，白名单扩展名，20MB 上限。
    'GET /sync/media': ({ url, res }) => {
      const raw = String(url.searchParams.get('path') || '');
      const exts = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
      const ext = exts[raw.slice(raw.lastIndexOf('.')).toLowerCase()];
      if (!raw || !ext) {
        sendJson(res, 400, { ok: false, error: '不支持的图片类型' });
        return undefined;
      }
      const os = globalThis.process;
      const tempRoot = (os && os.env && (os.env.TEMP || os.env.TMP)) || '';
      const allowed = [tempRoot, rootOf()].filter(Boolean).map((base) => base.toLowerCase());
      const lower = raw.toLowerCase();
      if (!allowed.some((base) => lower.startsWith(String(base).replace(/[\\/]+$/, '') + '\\') || lower.startsWith(String(base).replace(/[\\/]+$/, '') + '/'))) {
        sendJson(res, 403, { ok: false, error: '路径不在允许的目录内' });
        return undefined;
      }
      let stat;
      try {
        stat = statSync(raw);
      } catch {
        sendJson(res, 404, { ok: false, error: '文件不存在' });
        return undefined;
      }
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
        sendJson(res, 400, { ok: false, error: '不是文件或超过 20MB' });
        return undefined;
      }
      res.writeHead(200, { 'content-type': ext, 'content-length': stat.size, 'cache-control': 'no-store' });
      res.end(readFileSync(raw));
      return undefined; // 已写原始响应
    },

    // 图片上传（手机端发送图片）：raw body 存到 %TEMP%\hub-paste\（与桌面粘贴同目录，
    // agent 收到的消息形态与桌面贴图一致：`[图片] <路径>` 行）。
    // 白名单扩展名 + 20MB 上限；保存路径会落在 /sync/media 的白名单目录内，两端都能看。
    'POST /sync/upload': async ({ url, req, res }) => {
      const ext = String(url.searchParams.get('ext') || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
        sendJson(res, 400, { ok: false, error: `不支持的扩展名 ${ext}` });
        return;
      }
      const bytes = await readRaw(req);
      if (!bytes || !bytes.length) {
        sendJson(res, 400, { ok: false, error: '空文件' });
        return;
      }
      try {
        const dir = join(process.env.TEMP || process.env.TMP || '.', 'hub-paste');
        mkdirSync(dir, { recursive: true });
        const name = `paste-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
        const file = join(dir, name);
        writeFileSync(file, bytes);
        sendJson(res, 200, { ok: true, path: file, bytes: bytes.length });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String(error && error.message) });
      }
    },

    // ===== 会议录音 / 实时字幕（2026-10-30 与 DSH工程师协作；App 录音 → 桥落盘 → 电脑转写 → App 拉字幕）=====
    // 分工：桥只管**存储与收发**（不跑 ASR）；电脑侧 worker 轮询拉段、faster-whisper 转写、写
    // `.hub/meetings/mic-YYYYMMDD.md`、再 PUT 回文本；App 拉文本显示实时字幕。
    // 目录：`.hub/mic/<sid>/<seq>.<ext>`（音频）+ `.hub/mic/<sid>/text/<seq>.json`（转写）。
    // 安全：sid/seq/ext 严格白名单（防路径穿越）；Bearer token 与其他 /sync/* 同一套。
    'POST /sync/mic/segments': async ({ url, req, res }) => {
      const sid = micSidOf(url);
      const seq = Number(url.searchParams.get('seq') || 0);
      const ext = String(url.searchParams.get('ext') || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!sid) { sendJson(res, 400, { ok: false, error: 'sid 不合法（字母数字 ._- 且 ≤64）' }); return undefined; }
      if (!Number.isInteger(seq) || seq < 1 || seq > 99999) { sendJson(res, 400, { ok: false, error: 'seq 必须是 1..99999 的整数' }); return undefined; }
      if (!MIC_EXTS.includes(ext)) { sendJson(res, 400, { ok: false, error: `不支持的音频扩展名 ${ext}（允许 ${MIC_EXTS.join('/')}）` }); return undefined; }
      const bytes = await readRaw(req);
      if (!bytes || !bytes.length) { sendJson(res, 400, { ok: false, error: '空音频段' }); return undefined; }
      try {
        const dir = micDirOf(sid);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${seq}.${ext}`);
        writeFileSync(file, bytes);
        sendJson(res, 200, { ok: true, sid, seq, ext, bytes: bytes.length, at: Date.now(), path: file });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String(error && error.message) });
      }
      return undefined;
    },

    // 段列表：电脑侧 worker 的轮询入口（since=上次处理到的 seq）
    'GET /sync/mic/segments': ({ url }) => {
      micGc();
      const sid = micSidOf(url);
      if (!sid) return { ok: false, error: 'sid 不合法' };
      const since = Number(url.searchParams.get('since') || 0);
      const dir = micDirOf(sid);
      if (!existsSync(dir)) return { ok: true, sid, since, maxSeq: 0, segments: [] };
      const segments = [];
      for (const name of readdirSync(dir)) {
        const match = name.match(/^(\d+)\.([a-z0-9]+)$/i);
        if (!match) continue;
        const seq = Number(match[1]);
        if (seq <= since) continue;
        try {
          const stat = statSync(join(dir, name));
          if (!stat.isFile()) continue;
          segments.push({ seq, ext: match[2].toLowerCase(), bytes: stat.size, at: Math.round(stat.mtimeMs) });
        } catch { /* 文件刚被清掉，跳过 */ }
      }
      segments.sort((a, b) => a.seq - b.seq);
      const maxSeq = segments.length ? segments[segments.length - 1].seq : Math.max(0, since);
      return { ok: true, sid, since, maxSeq, segments };
    },

    // 取单个段二进制（worker 下载用；query 形式，避免动态路径与现有精确匹配 dispatcher 冲突）
    'GET /sync/mic/segment': ({ url, res }) => {
      const sid = micSidOf(url);
      const seq = Number(url.searchParams.get('seq') || 0);
      if (!sid || !Number.isInteger(seq) || seq < 1) { sendJson(res, 400, { ok: false, error: 'sid/seq 不合法' }); return undefined; }
      const dir = micDirOf(sid);
      let file = '';
      if (existsSync(dir)) {
        const hit = readdirSync(dir).find((name) => Number((name.match(/^(\d+)\./) || [])[1]) === seq);
        if (hit) file = join(dir, hit);
      }
      if (!file) { sendJson(res, 404, { ok: false, error: `无此音频段 ${sid}/${seq}` }); return undefined; }
      const stat = statSync(file);
      const ext = (file.split('.').pop() || '').toLowerCase();
      const mime = ext === 'm4a' ? 'audio/mp4' : ext === 'webm' ? 'audio/webm' : ext === 'ogg' ? 'audio/ogg' : ext === 'wav' ? 'audio/wav' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'content-length': stat.size, 'cache-control': 'no-store' });
      res.end(readFileSync(file));
      return undefined;
    },

    // 转写文本回写（电脑侧 worker → 桥；sid+seq 幂等，重复 PUT 覆盖同一文件）
    'PUT /sync/mic/text': async ({ url, req }) => {
      const sid = micSidOf(url);
      const seq = Number(url.searchParams.get('seq') || 0);
      if (!sid || !Number.isInteger(seq) || seq < 1 || seq > 99999) return { ok: false, error: 'sid/seq 不合法' };
      const body = await readJson(req);
      const text = String((body && body.text) || '');
      const record = {
        seq,
        text,
        audioSeconds: body && body.audioSeconds != null ? Number(body.audioSeconds) : null,
        inferenceSeconds: body && body.inferenceSeconds != null ? Number(body.inferenceSeconds) : null,
        at: body && body.at != null ? Number(body.at) : Date.now(),
        updatedAt: Date.now(),
      };
      const dir = join(micDirOf(sid), 'text');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${seq}.json`), JSON.stringify(record), 'utf8');
      return { ok: true, sid, seq, bytes: Buffer.byteLength(JSON.stringify(record)) };
    },

    // 字幕拉取（App 用）：只返回 seq > since 的条目 + maxSeq 供下一次 since
    'GET /sync/mic/text': ({ url }) => {
      const sid = micSidOf(url);
      if (!sid) return { ok: false, error: 'sid 不合法' };
      const since = Number(url.searchParams.get('since') || 0);
      const dir = join(micDirOf(sid), 'text');
      const items = [];
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          const match = name.match(/^(\d+)\.json$/);
          if (!match) continue;
          const seq = Number(match[1]);
          if (seq <= since) continue;
          try {
            const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
            if (parsed && typeof parsed === 'object') items.push({ ...parsed, seq });
          } catch { /* 半个 JSON 先跳过 */ }
        }
      }
      items.sort((a, b) => a.seq - b.seq);
      const maxSeq = items.length ? items[items.length - 1].seq : Math.max(0, since);
      return { ok: true, sid, since, maxSeq, items };
    },

    // 会话清单（App 历史页/排障用）：有哪些 sid、各自最新 seq
    'GET /sync/mic/sessions': () => {
      micGc();
      const base = micBaseDir();
      const sessions = [];
      if (existsSync(base)) {
        for (const name of readdirSync(base)) {
          if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) continue;
          const dir = join(base, name);
          try {
            if (!statSync(dir).isDirectory()) continue;
            let maxSeq = 0;
            let textMax = 0;
            for (const file of readdirSync(dir)) {
              const seq = Number((file.match(/^(\d+)\./) || [])[1]);
              if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
            }
            const textDir = join(dir, 'text');
            if (existsSync(textDir)) {
              for (const file of readdirSync(textDir)) {
                const seq = Number((file.match(/^(\d+)\.json$/) || [])[1]);
                if (Number.isInteger(seq) && seq > textMax) textMax = seq;
              }
            }
            sessions.push({ sid: name, maxSeq, textMax, at: Math.round(statSync(dir).mtimeMs) });
          } catch { /* 跳过异常目录 */ }
        }
      }
      sessions.sort((a, b) => b.at - a.at);
      return { ok: true, sessions };
    },

    // 余额监控（2026-10-24 与余额监控工程师对齐方案 A）：spawn Hermes venv python 跑
    // apps/api-balance-monitor/balance_cli.py（stdout 纯 JSON / exit 语义化，单家挂不影响别家）。
    // 桥侧 120s 缓存 + in-flight 去重（Ark 卡要 spawn node+arkcli 3-6s，避免手机下拉和轮询同时等）。
    'GET /sync/balance': async ({ url }) => {
      const force = String(url.searchParams.get('force') || '') === '1';
      const ttlMs = 120 * 1000;
      const now = Date.now();
      if (!force && balanceSnapCache.data && now - balanceSnapCache.at < ttlMs) {
        return { ok: true, ...balanceSnapCache.data, cached: true, cached_age_ms: now - balanceSnapCache.at };
      }
      if (!force && balanceSnapCache.inflight) {
        try { return { ok: true, ...(await balanceSnapCache.inflight), cached: false }; } catch (error) {
          return { ok: false, error: String(error && error.message) };
        }
      }
      balanceSnapCache.inflight = (async () => {
        // 探测可用 python（venv 已损坏时退回系统 Python），见 resolvePythonForBalance
        const py = resolvePythonForBalance();
        const cli = join(rootOf(), 'apps', 'api-balance-monitor', 'balance_cli.py');
        const args = [cli];
        if (force) args.push('--force');
        const result = await new Promise((resolve, reject) => {
          const child = spawn(py, args, { cwd: dirname(cli), windowsHide: true });
          let out = '';
          let err = '';
          const timer = setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            reject(new Error('balance_cli 超时(15s)'));
          }, 15000);
          child.stdout.on('data', (chunk) => { out += String(chunk); });
          child.stderr.on('data', (chunk) => { err += String(chunk); });
          child.on('error', (error) => { clearTimeout(timer); reject(error); });
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0 || !out.trim()) {
              reject(new Error(`balance_cli exit=${code}${err ? `: ${err.trim().slice(0, 300)}` : ''}`));
              return;
            }
            try { resolve(JSON.parse(out)); } catch (error) {
              reject(new Error(`balance_cli 输出不是 JSON: ${out.slice(0, 200)}`));
            }
          });
        });
        return result;
      })();
      try {
        const data = await balanceSnapCache.inflight;
        balanceSnapCache.data = data;
        balanceSnapCache.at = Date.now();
        return { ok: true, ...data, cached: false };
      } catch (error) {
        // 失败时若还有未过期旧快照就降级返回旧值（标注 stale）
        if (balanceSnapCache.data && Date.now() - balanceSnapCache.at < 10 * 60 * 1000) {
          return { ok: true, ...balanceSnapCache.data, cached: true, stale: true, note: String(error && error.message) };
        }
        return { ok: false, error: String(error && error.message) };
      } finally {
        balanceSnapCache.inflight = null;
      }
    },

    // 余额（与桌面 quota-panel 同一双通道 + 60s 缓存；手机端「模型与余额」页）
    'GET /sync/quota': async () => {
      const fresh = Date.now() - balanceCache.at < BALANCE_TTL_MS;
      if (fresh && balanceCache.value) {
        return { ok: true, balance: balanceCache.value, balanceAt: balanceCache.at, cached: true };
      }
      try {
        const balance = await readBalance(ctx);
        balanceCache.at = Date.now();
        balanceCache.value = balance;
        balanceCache.error = null;
        return { ok: true, balance, balanceAt: balanceCache.at, cached: false };
      } catch (error) {
        // 失败但缓存里有旧值：退回旧值（绝不静默给 0，与桌面口径一致）
        if (balanceCache.value) {
          return { ok: true, balance: balanceCache.value, balanceAt: balanceCache.at, cached: true, stale: true };
        }
        return { ok: false, error: String((error && error.message) || error) };
      }
    },

    // 模型目录（/hub/models 同款：controller.modelCatalog）
    'GET /sync/models': async () => {
      const controller = ctx.get('sessionController');
      const catalog = await controller.modelCatalog();
      return { ok: true, default: catalog.default, groups: catalog.groups };
    },

    // 全局切模型（/hub/switch-model 简版：逐会话 selectModel + 写默认 + 备份）
    'POST /sync/switch-model': async ({ body }) => {
      const provider = String(body.provider || '');
      const model = String(body.model || '');
      if (!provider || !model) return { ok: false, error: '缺 provider/model' };
      const controller = ctx.get('sessionController');
      const targets = listSessions(ctx).map((row) => row.sessionId); // 已去重 + 排归档
      // 可回滚档案（与 /hub/switch-model 同款）
      let previousDefault = null;
      try {
        const def = ctx.get('agentDefaultModel');
        if (def && typeof def.currentSelection === 'function') previousDefault = def.currentSelection();
      } catch { /* ignore */ }
      try {
        const backupFile = join(rootOf(), '.hub', 'model-bulk-backup.json');
        mkdirSync(dirname(backupFile), { recursive: true });
        writeFileSync(backupFile, `${JSON.stringify({
          at: Date.now(), provider, model, previousDefault, sessions: targets,
        }, null, 2)}\n`, 'utf8');
      } catch { /* 备份失败不挡切换 */ }
      let switched = 0;
      const failures = [];
      for (const sessionId of targets) {
        try {
          await controller.selectModel({ sessionId, provider, model });
          switched += 1;
        } catch (error) {
          failures.push(`${sessionId}: ${String(error && error.message)}`);
        }
      }
      let saved = false;
      try {
        const def = ctx.get('agentDefaultModel');
        if (def && typeof def.saveSelection === 'function') {
          await def.saveSelection({ provider, model });
          saved = true;
        }
      } catch { /* ignore */ }
      return { ok: true, provider, model, total: targets.length, switched, saved, failures: failures.slice(0, 10) };
    },

    // 任务线：`.hub/projects/<项目>/tasks.json`（Yat2 维护；桌面群聊的「任务线」同源）
    // 返回 { tasks: [{id,title,status,members,avatar}], avatars }，手机端按 status 分「进行中 / 已归档」
    'GET /sync/tasks': ({ url }) => {
      const project = String(url.searchParams.get('project') || '').trim();
      const safe = project.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').trim();
      const file = join(rootOf(), '.hub', 'projects', safe, 'tasks.json');
      let data = {};
      try {
        data = JSON.parse(readFileSync(file, 'utf8')) || {};
      } catch {
        return { ok: true, project, tasks: [], avatars: {}, error: 'ENOENT' };
      }
      const avatars = data.avatars && typeof data.avatars === 'object' && !Array.isArray(data.avatars) ? data.avatars : {};
      const tasks = (Array.isArray(data.tasks) ? data.tasks : []).map((task) => {
        const members = Array.isArray(task.members) ? task.members.map(String) : [];
        const first = members[0] || '';
        const base = first.includes('｜') ? first.split('｜')[0].trim() : first;
        return {
          id: String(task.id || ''),
          title: String(task.title || ''),
          status: String(task.status || 'active'),
          members,
          avatar: String(task.avatar || avatars[first] || (base ? avatars[base] : '') || ''),
        };
      });
      return { ok: true, project, tasks, avatars };
    },

    'GET /sync/sessions': ({ url }) => {
      const project = String(url.searchParams.get('project') || '').trim();
      // 分身（subagent）默认不进手机列表（对齐 GUI 侧栏口径），?all=1 才带出来
      const includeAll = String(url.searchParams.get('all') || '') === '1';
      const every = listSessions(ctx);
      const visible = includeAll ? every : every.filter((row) => !row.subagent);
      const items = project ? visible.filter((s) => s.project === project) : visible;
      return { ok: true, items, total: every.length };
    },

    // since = 上次收到的条数（增量轮询用）
    'GET /sync/messages': async ({ url }) => {
      const key = String(url.searchParams.get('session') || '').trim();
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 200)));
      const since = Number(url.searchParams.get('since') || 0);
      let session = resolveSession(ctx, key);
      if (!session) {
        const controller = ctx.get('sessionController');
        const agentsCtl = controller && controller.agents;
        if (agentsCtl && typeof agentsCtl.resolveAgent === 'function') {
          try {
            const found = await agentsCtl.resolveAgent(key);
            const resumedId = found && found.agent && found.agent.session ? found.agent.session.id : key;
            const live = ctx.get('sessions');
            session = (live && typeof live.get === 'function' ? live.get(resumedId) : undefined) || { id: resumedId };
          } catch { /* 找不到就是找不到 */ }
        }
      }
      if (!session) return { ok: false, error: '找不到这个会话' };
      const events = await readEvents(ctx, session);
      const scan = scanConversation(events);
      const all = scan.items;
      // since 超出总数（会话被压缩/重建，历史回缩）→ 回退给全量尾部，客户端按 total 重置
      const slice = since > 0 && since <= all.length ? all.slice(since) : all.slice(-limit);
      const running = isRunning(ctx, session.id);
      return {
        ok: true,
        sessionId: String(session.id),
        title: titleOfSession(ctx, session) || titleFromCache(String(session.id)),
        running,
        total: all.length,
        items: slice,
        // 执行过程（思考 / 工具 / 报错）：手机上展开「执行过程」看的内容，桌面端同源事件
        steps: scan.steps,
        // agent 正在生成的部分文本（未闭合步骤）；空闲时为空串
        streaming: running ? scan.streaming : '',
      };
    },

    'POST /sync/prompt': async ({ body }) => {
      const controller = ctx.get('sessionController');
      if (!controller || typeof controller.prompt !== 'function') {
        return { ok: false, error: 'sessionController 不可用' };
      }
      const key = String(body.session || body.sessionId || '').trim();
      const text = String(body.text || '').trim();
      if (!key) return { ok: false, error: '缺 session' };
      if (!text) return { ok: false, error: '缺 text' };
      let session = resolveSession(ctx, key);
      if (!session) {
        const agentsCtl = controller.agents;
        if (agentsCtl && typeof agentsCtl.resolveAgent === 'function') {
          try {
            const found = await agentsCtl.resolveAgent(key);
            const resumedId = found && found.agent && found.agent.session ? found.agent.session.id : key;
            const live = ctx.get('sessions');
            session = (live && typeof live.get === 'function' ? live.get(resumedId) : undefined) || { id: resumedId };
          } catch (error) {
            return { ok: false, error: `会话不可用：${String(error && error.message)}` };
          }
        }
      }
      if (!session) return { ok: false, error: '找不到这个会话' };
      try {
        await controller.prompt({
          requestId: `sync-${Date.now()}-${randomBytes(3).toString('hex')}`,
          sessionId: session.id,
          mode: body.mode === 'interrupt' ? 'interrupt' : 'queue',
          content: [{ type: 'text', text }],
        }, new AbortController().signal);
        return { ok: true, sessionId: String(session.id), title: titleOfSession(ctx, session) };
      } catch (error) {
        return { ok: false, error: String(error && error.message) };
      }
    },

    'POST /sync/session': async ({ body }) => {
      const controller = ctx.get('sessionController');
      if (!controller || typeof controller.create !== 'function') {
        return { ok: false, error: 'sessionController 不可用' };
      }
      const title = String(body.title || '').trim();
      if (!title) return { ok: false, error: '缺 title' };
      // 命名硬校验（与 taskline_create 同款，2026-10-23 用户令；实测不加会被手机端绕过）：
      // 禁裸宽泛角色名 + 禁「｜」具体任务分身（仅 ｜副手 / ｜二号 放行）
      const guard = validateMemberName(title);
      if (guard.error) return { ok: false, error: guard.error };
      try {
        const created = await controller.create({
          cwd: String(body.cwd || rootOf()),
          agentPreset: String(body.preset || 'cordis'),
        });
        const sessionId = created && (created.sessionId || (created.session && created.session.id));
        if (!sessionId) return { ok: false, error: '创建未返回 sessionId' };
        await controller.rename({ sessionId, title });
        const text = String(body.text || '').trim();
        if (text) {
          await controller.prompt({
            requestId: `sync-${Date.now()}-${randomBytes(3).toString('hex')}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, new AbortController().signal);
        }
        return { ok: true, sessionId: String(sessionId), title, ...(guard.warning ? { warning: guard.warning } : {}) };
      } catch (error) {
        return { ok: false, error: String(error && error.message) };
      }
    },

    'POST /sync/rename': async ({ body }) => {
      const controller = ctx.get('sessionController');
      const session = resolveSession(ctx, body.session);
      const title = String(body.title || '').trim();
      if (!controller || typeof controller.rename !== 'function') return { ok: false, error: 'sessionController 不可用' };
      if (!session) return { ok: false, error: '找不到这个会话' };
      if (!title) return { ok: false, error: '缺 title' };
      try {
        await controller.rename({ sessionId: session.id, title });
        return { ok: true, sessionId: String(session.id), title };
      } catch (error) {
        return { ok: false, error: String(error && error.message) };
      }
    },

    'POST /sync/archive': async ({ body }) => {
      const registry = ctx.get('workspaceRegistry');
      const session = resolveSession(ctx, body.session);
      if (!registry) return { ok: false, error: 'workspaceRegistry 不可用' };
      if (!session) return { ok: false, error: '找不到这个会话' };
      try {
        if (body.restore) await registry.unarchiveSession(session.id);
        else await registry.archiveSession(session.id, { stopActivity: true });
        return { ok: true, sessionId: String(session.id), archived: !body.restore };
      } catch (error) {
        return { ok: false, error: String(error && error.message) };
      }
    },


    /**
     * 会话的 goal（2026-11-09 用户要求「手机上要能显示 goal」）。
     *
     * 数据源 = 宿主 `goals` 服务：`ctx.get('goals').get(agent)`（与 get_goal 工具同源，
     * 见 app.asar `goalValue()`）；字段与工具输出一致：
     * `{goal:{id,revision,objective,phase,roundsStarted,maxGoalRounds,blockedReason?}, activation}`。
     * goal 绑定在**活 agent** 上，会话结束就取不到 → 返回 `goal:null`（不报错）。
     */
    'GET /sync/goal': async ({ url }) => {
      const key = String(url.searchParams.get('session') || '').trim();
      if (!key) return { ok: false, error: '缺 session' };
      const session = resolveSession(ctx, key) || { id: key };
      const agent = await liveAgentOf(ctx, session.id);
      if (!agent) return { ok: true, sessionId: session.id, goal: null, activation: null, live: false };
      const goals = ctx.get('goals');
      if (!goals || typeof goals.get !== 'function') {
        return { ok: false, error: '宿主未提供 goals 服务' };
      }
      const goal = goals.get(agent);
      if (!goal) return { ok: true, sessionId: session.id, goal: null, activation: null, live: true };
      return {
        ok: true,
        sessionId: session.id,
        live: true,
        goal: {
          id: goal.id,
          revision: goal.revision,
          objective: goal.objective,
          phase: goal.phase,
          roundsStarted: goal.roundsStarted,
          maxGoalRounds: goal.maxGoalRounds,
          blockedReason: goal.blockedReason || null,
        },
        activation: goal.activation || null,
      };
    },
    // 诊断：确认 waterfall 监听是否真的挂上/被调用（0 次 = agent-scoped 请求不走本地 listener）
    'GET /sync/questions/debug': () => ({
      ok: true,
      hooked: [...hookedScopes.keys()],
      watching: [...phoneWatching.keys()],
      waiters: [...phoneWaiters.keys()],
      hookCalls: questionHookCalls,
      takeovers: questionTakeovers,
      diag: questionDiag,
      phoneAnswerEnabled: true,
    }),
    // —— 交互式提问（ask_user_question）：手机端查看并回答（2026-11-04）——
    'GET /sync/questions': async ({ url }) => {
      const key = String(url.searchParams.get('session') || '').trim();
      if (!key) return { ok: false, error: '缺 session' };
      // 与 /sync/messages 同口径：活会话走 resolveSession，已结束的会话把 key 当 id 直接读
      const session = resolveSession(ctx, key) || { id: key };
      // 登记「手机正在看这个会话」→ 该会话的提问才会接管（10 分钟内有效）。
      // ⚠️ 必须显式带 `watch=1` 才登记（2026-11-09 实测踩坑）：原来任何 GET 都登记，
      // 于是脚本/调试/别的客户端"只查一下"也会让桥以为手机在看 → 桌面弹窗被挂起、
      // agent 干等 120s 才回退。只有 App 真正打开会话时才该登记。
      const wantWatch = String(url.searchParams.get('watch') || '') === '1';
      if (wantWatch) {
        phoneWatching.set(String(session.id), Date.now());
      }
      // 关键：在**该 agent 自己的 ctx** 上挂 waterfall 监听（根作用域收不到 agent-scoped 事件）
      await hookSessionQuestions(String(session.id));
      const events = await readEvents(ctx, session);
      const items = pendingQuestionsOf(events).map((item) => ({
        sessionId: session.id,
        callId: item.callId,
        turn: item.turn,
        at: item.at,
        questions: item.questions,
      }));
      return { ok: true, sessionId: session.id, items, count: items.length };
    },
    'POST /sync/answer': async ({ body }) => {
      const sessionId = String(body.sessionId || '').trim();
      const callId = String(body.callId || '').trim();
      const answers = Array.isArray(body.answers) ? body.answers : [];
      if (!sessionId || !callId || answers.length === 0) {
        return { ok: false, error: '缺 sessionId / callId / answers' };
      }
      // ① agent 正在等（waterfall 挂着）→ 直接 resolve，这是手机实时回答的主路径
      const waiter = phoneWaiters.get(callId);
      if (waiter) {
        phoneWaiters.delete(callId);
        waiter.resolve({ answers });
        return { ok: true, accepted: true, path: 'live' };
      }
      // ①b 指纹键匹配（2026-11-09 关键修复）：handler 拿不到 wait.callId 时用的是
      //   `sessionId|questionFingerprint(questions)` 作键；手机只知道 toolCallId，
      //   所以这里从 events 反查这批 questions，算出同一个指纹再去匹配。
      try {
        // 与 GET /sync/questions 完全同口径（resolveSession + readEvents），保证 callId 能对上
        const session = resolveSession(ctx, sessionId) || { id: sessionId };
        const events = await readEvents(ctx, session);
        const pending = pendingQuestionsOf(events).find((p) => p.callId === callId);
        if (pending) {
          const fpKey = sessionId + '|' + questionFingerprint(pending.questions);
          const fpWaiter = phoneWaiters.get(fpKey);
          if (fpWaiter) {
            phoneWaiters.delete(fpKey);
            fpWaiter.resolve({ answers });
            return { ok: true, accepted: true, path: 'live-fp' };
          }
        }
      } catch (error) {
        // 指纹匹配失败不影响后面的补答路径
      }
      // ② 已挂起（continued）→ 走 userQuestions.answer RPC（只能补答，不影响正在等的）
      const agent = await liveAgentOf(ctx, sessionId);
      if (!agent) return { ok: false, error: '会话没有活着的 agent（可能已结束），无法从手机回答' };
      const userQuestions = ctx.get('userQuestions');
      if (!userQuestions || typeof userQuestions.answer !== 'function') {
        return { ok: false, error: '宿主未提供 userQuestions 服务' };
      }
      // 只对「已挂起（continued）」的提问有效：agent 正在阻塞等待时由桌面弹窗回答
      const stillContinued = await userQuestions.answer(agent, callId, { answers });
      if (stillContinued === false) {
        return {
          ok: false,
          error: '这个提问不能从手机补答（agent 还在等桌面回答，或已过期）',
          hint: '请在电脑上回答；如手机端需要实时回答，需要桥接管提问（第二阶段）',
        };
      }
      return { ok: true, accepted: true, continued: stillContinued };
    },
    'GET /sync/board': ({ url }) => {
      const project = String(url.searchParams.get('project') || '').trim();
      const safe = project.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').trim();
      if (!safe) return { ok: false, error: '缺 project' };
      const file = join(rootOf(), '.hub', 'projects', safe, 'board.md');
      try {
        const stat = statSync(file);
        return { ok: true, project: safe, text: readFileSync(file, 'utf8'), updatedAt: stat.mtimeMs };
      } catch (error) {
        return { ok: false, project: safe, error: String(error && error.code) };
      }
    },
  };

  let portIndex = 0;
  let closed = false;
  const info = { host, ports, tokenPath: path, routes: Object.keys(routes), port: 0 };
  let ready;
  const whenReady = new Promise((resolve) => { ready = resolve; });

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const key = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

    // 认证（health 也要 token，避免暴露在扫描器里）
    if (!tokenEquals(bearerOf(req), token)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const route = routes[key];
    if (!route) {
      sendJson(res, 404, { ok: false, error: `no route ${key}`, routes: Object.keys(routes) });
      return;
    }
    try {
      // /sync/upload 与 /sync/mic/segments 是**二进制** raw body，不能预解析成 JSON
      const body = req.method === 'POST' && url.pathname !== '/sync/upload' && url.pathname !== '/sync/mic/segments' ? await readJson(req) : {};
      const payload = await route({ url, body, req, res });
      // route 返回 undefined = 已自行写完原始响应（如 /sync/media 的二进制流）
      if (payload !== undefined) sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String(error && error.message) });
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      try { sendJson(res, 500, { ok: false, error: String(error && error.message) }); } catch { /* 连接已断 */ }
    });
  });

  const listen = (index) => {
    if (index >= ports.length) {
      console.warn(`[dsh-sync-bridge] 没有可用端口（试过 ${ports.join(',')}）`);
      return;
    }
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        console.warn(`[dsh-sync-bridge] 端口 ${ports[index]} 被占用，换下一个`);
        listen(index + 1);
        return;
      }
      console.warn(`[dsh-sync-bridge] listen failed: ${String(error)}`);
    });
    server.listen(ports[index], host, () => {
      const actual = ports[index];
      info.port = actual;
      console.log(`[dsh-sync-bridge] listening on http://${host}:${actual}/sync/*（token 文件：${path}）`);
      ready(actual);
    });
  };
  listen(portIndex);

  return {
    info,
    whenReady,
    close: () => {
      if (closed) return;
      closed = true;
      try { server.close(); } catch { /* 已关 */ }
      try { if (releaseUserQuestions) releaseUserQuestions(); } catch { /* 已注销 */ }
      for (const off of hookedScopes.values()) {
        try { if (typeof off === 'function') off(); } catch { /* 已注销 */ }
      }
      hookedScopes.clear();
    },
  };
}


