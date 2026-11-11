/**
 * Host half of the hub-desktop-ui bundle.
 *
 * 除了挂载客户端 UI，这里还负责一件事：给「项目管理者」会话（标题以 ` · Yat2` 结尾）
 * 在**本会话第一次模型步骤**注入一段管理者协议——建 agent、派活、维护共享黑板。
 * 协议只出现一次，不污染每一轮。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
// 2026-11-09 拆包：sync-bridge 已独立成 dsh-sync-bridge 包（本仓库 dsh/plugins/hub-sync-bridge/）
import { startSyncBridge } from 'dsh-sync-bridge';
// 2026-11-09 拆包：重启看门狗已独立成 dsh-desktop-watchdog
import { maximizeDesktopWindowOnStart, scheduleDesktopRestart } from 'dsh-desktop-watchdog';
// 2026-11-10 拆包：分身归档 + 交接档案已独立成 dsh-clone-handoff
import { collectEvents, writeCloneHandoff } from 'dsh-clone-handoff';
// 2026-11-10 拆包：agent_message 等工具逐步搬进 dsh-agent-tasks
import { registerAgentTools } from 'dsh-agent-tasks';
// 2026-11-09 拆包：session-events 已归入 dsh-hub-core
import {
  compactSessionEvents,
  readSessionEvents,
  // 2026-11-10 拆包：任务线纯逻辑已搬进 dsh-hub-core/tasks.js
  INTERRUPT_IDLE_WAIT_MS,
  RESUME_MAX_PER_BOOT,
  ARCHIVE_MIN_AGE_MS,
  shouldSkipResumeByLedger,
  looksTaskSpecificName,
  deliveryConclusion,
  goalDirective,
  writeJsonAtomic,
  readJsonForWrite,
  readTaskFile,
  renderTasklinePrompt,
  // 2026-11-10 拆包第 3 批：运行时辅助（消息/标题/头像/续跑台账）
  deepFreeze,
  titleOf,
  noticeMessage,
  AVATAR_POOL,
  RESUME_PROMPT,
  globalAvatarsPath,
  readGlobalAvatars,
  writeGlobalAvatar,
  resumeLedgerPath,
  resumeSweepState,
  recordResumeSweep,
  // 2026-11-10 拆包第 4 批：投递决策 / routing 守护 / 会话白名单 / 分身清账
  planDelivery,
  guardRoutingFile,
  readRegisteredSessionIds,
  cleanCloneRegistry,
  projectDirOf,
  projectTasksPathOf,
  // 2026-11-10 拆包第 5 批：头像分配 / 中断判定
  ensureMemberAvatar,
  interruptedReasonDetailed,
  // 2026-11-10 拆包第 6 批：会话治理（标题判重 / 归档清理）
  ARCHIVE_KEEP_MAX,
  dedupeActiveTitles,
  pruneArchivedSessions,
  // 2026-11-10 拆包第 7 批：goal 写入 / 续跑扫描
  setTaskGoal,
  resumeInterruptedSessions,
  ensureLiveSession,
  purgeOrphanCloneAvatars,
} from 'dsh-hub-core';
// 2026-11-10 拆包：分诊 29 个函数已独立成 dsh-queue-triage
import { createQueueTriage } from 'dsh-queue-triage';

export const name = 'ai-agent-hub-project-manager';

/**
 * 批量切模型进度（2026-10-23）：/hub/switch-model 逐会话 selectModel 较慢，
 * 把进度暴露给 /hub/switch-model-progress，客户端据此画进度条。
 */
let modelBulkProgress = {
  running: false, done: 0, total: 0, switched: 0, provider: '', model: '', startedAt: 0, finishedAt: 0,
};

/**
 * 批量切换的**内存账本**（2026-10-26 修 projcache 投影滞后导致的误跳过）：
 * selectModel 成功后 projcache 的 modelSelection 投影是异步 flush 的——紧跟着的
 * 第二次全局切换可能读到旧 lastUsed 而把刚切过的会话**误跳过**（实测 54 会话漏 25 个）。
 * 账本在 selectModel 成功当场记录，短路优先查它；10 分钟过期（防用户随后手动改模型
 * 而账本仍说旧目标）。仅 Host 进程内有效，重启即清零（安全侧：退回 projcache 语义）。
 */
const bulkAppliedSelections = new Map();
const BULK_APPLIED_TTL_MS = 10 * 60 * 1000;

/**
 * 因**模型问题**中断的会话账本（2026-10-29 用户令《切换模型后自动续跑》）：
 * sessionId → { at, provider, model, reason }。
 * 写入：agent/error 与 api-session/error 里判定为"模型相关"的错误；
 * 消费：① /hub/switch-model 切换完成后；② 30s 轮询兜底（覆盖从 DSH 原生 UI 单独切模型的场景）。
 * 续跑复用 resumeInterruptedSessions（发【续跑】提示 + 冷唤醒），不新造一套。
 */
const modelErrorLedger = new Map();
const MODEL_ERROR_LEDGER_TTL_MS = 30 * 60 * 1000;
/** 判定"换模型可能救得了"的错误（过于宽松会误续跑，过于严格会漏）。 */
const MODEL_ERROR_RE = new RegExp([
  'access ?denied', 'unpurchased', 'insufficient', 'quota', 'rate.?limit', 'too many requests',
  '\\b(401|402|403|404|429|500|502|503|504)\\b',
  'does not support', 'unsupported', 'not supported', 'model.{0,24}(not|isn).{0,12}(found|exist|available|supported)',
  'context.{0,16}(length|window)', 'max.?tokens', 'token limit', 'overloaded', 'invalid.?request',
  'invalid model', 'no such model', 'api.?key', 'auth',
].join('|'), 'i');

/** 读会话当前模型选择（projcache 投影；内存账本优先，防异步 flush 滞后）。 */
function readSessionSelectionOf(sessionId) {
  const id = String(sessionId || '');
  if (!id) return null;
  const applied = bulkAppliedSelections.get(id);
  if (applied) {
    if (Date.now() - applied.at <= BULK_APPLIED_TTL_MS) return applied.selection;
    bulkAppliedSelections.delete(id);
  }
  try {
    const raw = JSON.parse(readFileSync(
      join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${id}.json`),
      'utf8',
    ));
    const sel = raw && raw.record && raw.record.rows && raw.record.rows.modelSelection;
    const val = sel && sel.val;
    if (val && val.pending && val.pending.provider && val.pending.model) return val.pending;
    if (val && val.lastUsed && val.lastUsed.provider && val.lastUsed.model) return val.lastUsed;
    return null;
  } catch (error) { return null; }
}

/** 把一次模型相关错误记进账本（去重：同会话只留最新一条）。 */
function noteModelError(sessionId, message) {
  const id = String(sessionId || '');
  if (!id) return;
  const text = String(message || '');
  if (!MODEL_ERROR_RE.test(text)) return;
  const sel = readSessionSelectionOf(id);
  modelErrorLedger.set(id, {
    at: Date.now(),
    provider: (sel && sel.provider) || '',
    model: (sel && sel.model) || '',
    reason: text.slice(0, 200),
  });
  try {
    console.log(`[hub-desktop-ui] model-error recorded ${id}: ${text.slice(0, 80)}`);
  } catch (error) { /* ignore */ }
}

/**
 * 对账本里"因模型问题中断"的会话发起续跑。
 * 条件：①当前模型已不同于出错时的模型（或未记录到模型）；②会话不在运行中（resumeInterruptedSessions 内部会再判）。
 * @returns {Promise<string[]>} 实际续跑的 sessionId 列表
 */
async function resumeModelErrorSessions(ctx, { only = null } = {}) {
  const resumed = [];
  const now = Date.now();
  for (const [sessionId, entry] of [...modelErrorLedger.entries()]) {
    if (only && sessionId !== only) continue;
    if (!entry || now - entry.at > MODEL_ERROR_LEDGER_TTL_MS) { modelErrorLedger.delete(sessionId); continue; }
    const current = readSessionSelectionOf(sessionId);
    const unchanged = Boolean(entry.provider && entry.model && current
      && current.provider === entry.provider && current.model === entry.model);
    if (unchanged) continue; // 还停在出错的那个模型上 → 不续跑（会立刻再错一次）
    try {
      const result = await resumeInterruptedSessions(ctx, { force: true, only: sessionId, max: 1 });
      if (result && Array.isArray(result.resumed) && result.resumed.length) {
        resumed.push(sessionId);
        modelErrorLedger.delete(sessionId);
        try { console.log(`[hub-desktop-ui] auto-resumed after model switch: ${sessionId}`); } catch (error) { /* ignore */ }
      }
    } catch (error) {
      try { console.warn(`[hub-desktop-ui] auto-resume failed ${sessionId}: ${String(error && error.message)}`); } catch (e) { /* ignore */ }
    }
  }
  return resumed;
}


/** 注入给管理者的协议文本（标题匹配 ` · Yat2` 才注入，带项目名与黑板路径）。 */
export function managerProtocol(project) {
  const name = project || '（未知项目）';
  return `【项目管理者协议 · Yat2】

你所在的项目是「${name}」。你是**管理者（调度者）**，不是执行者。
项目里每个成员都是一条独立会话，标题形如「${name} · <成员>」。

## 铁律

1. 任何具体工作——写代码、改文件、跑命令、画图、查资料、写文档——**必须交给成员做**，你不得自己产出交付物。
2. 只有这些事你自己做：读黑板、建/改任务、派活、催办、汇总进度、回答「现在到哪一步」。
3. 用户直接让你做某事时，正确回复是「这条我派给 <成员>」+ 立刻派发，**不是直接给结果**。
4. 如果团队工具（spawn_teammate / team_task_create / send_message）在本会话不可用，
   就明确告诉用户「需要启用团队工具」，不要自己顶上去干。
5. **新建项目 = 两条线一次建齐**（2026-11-07 用户令）：\`<项目> · Yat2\`（🦉 管理者）+ 至少一条成员线，
   缺 Yat2 不算建成（插件有对账巡检，缺了会被注入强提醒）。建项目先建管理者线，再建成员线。

## 收到一条需求后的固定动作

a. 判断归属：看黑板里各成员的职责与在办事项，选最合适的人；
a0. **先看【成员状态】面板**：确认目标成员当前是运行中还是空闲、本进程已排队几条，再决定选谁、用哪种派法（判据见「派活规范」第 6 条）；
b. 没有合适成员 → spawn_teammate 建一个（或请用户点侧栏「+ agent」），命名「${name} · <角色>」；
c. team_task_create 建任务：标题写「要交付什么」，描述写清验收标准与产物路径；
d. send_message 把任务号 + 要求发给该成员，要求它完成后回报并更新黑板；
e. 回用户一句：已派给谁、任务号、准备做什么。**不要在同一轮里自己动手做。**

## 任务线（按内容分，不按人分）

**每条用户消息先判断它属于哪条任务线**，再决定怎么回：

- \`归线判据 = 目标\`：这条消息是为了达成哪个目标？和某条任务线的目标一致 → 归它（哪怕跨多个成员、多轮对话）；是新的目标 → 新开一条线。不要因为'都在改客户端'就把所有消息归进同一条线——客户端改造里'修输入框高度'和'加模型切换按钮'就是两个不同的目标；
- 已有对应任务线 → 把活派给那条线的参与者（或新参与者），**沿用原来的 title**；
- 是新任务 → 新建一条线（\`taskline_create\` 起会话或直接登记），起名后写进 tasks.json；
- 同一件事不要拆成多条线，多件事也不要挤在一条线；同一个成员可以同时属于多条线。

派活时顺手写 .hub/projects/${name}/tasks.json（**新格式**，一条任务一个对象）：

\`\`\`json
{
  "tasks": [
    { "id": "t1", "title": "<8~16 字的任务名>", "status": "active", "members": ["<成员名>", "<成员名>"] }
  ]
}
\`\`\`

- \`title\` 要**精简准确**，例如「定位图细胞器重绘」「群聊看板接入」「待办队列修复」；
- 不要照抄用户的原话，也不要带「帮我/请/能不能」这类词；
- \`members\` 写这条线的参与者（按成员名）；也可以写 \`sessionIds\`（按会话 id）；
- 同一任务线有新阶段时更新 \`title\`（仍是这一条，不要新建对象）；
- 任务完成后把 \`status\` 改成 "archived"，群聊里它会移进「已归档 N 条任务线」。

## 派活规范（2026-10-28 夜会，五条；2026-11-05 增补第 6、7 条）

1. **同类修正一次清完**：首轮派活就给「全库 grep 清单」，让成员一轮内把同类问题全部找齐修完——不要一处一处挤牙膏；
2. **计数先实测再写**：任务书里的具体数字要求（"改 N 处""只剩 M 个"）自己先 grep/实测，拿不准就不写死数字、写判定标准；
3. **grep 验收口径写明**：派活时说清"用什么模式 grep、哪些豁免类不算违规"，成员按口径自验，回报附 grep 输出；
4. **待复核标「暂缓」**：子项等他人复核的，黑板/回报里标「暂缓」，不写成已完成。
5. **重要补充 / 方向调整不排队，直接 steer 推进去**（2026-11-04 用户令）：任务进行中发现「方向错了 / 关键约束漏了 / 有重要补充信息」，**不要靠排队干等**，用 \`taskline_prompt {mode: "steer"}\` —— 它在目标**下一个 step 边界**插入当前轮（不打断正在执行的工具调用），目标下一步就能按新信息走，不会沿错方向继续白干。判据：**这条信息迟到就等于白干** → steer；其余（含后续任务）→ 不传 mode（默认 triage：插件开分诊分身判定「steer 主线 / 分身自己做」，同样不干等，2026-11-08 用户令）。
6. **派活前必须先看成员状态（2026-11-05 用户令，硬规则）**：每轮注入的【成员状态】面板就是**唯一依据**——派活前先看目标成员当前是 🔴运行中 还是 🟢空闲、本进程已排队几条；**回复里必须写出「目标成员当前状态：🔴运行中（排队 N）/ 🟢空闲」**，再说用 queue 还是 steer。判定：**空闲 → 直接派**；**运行中 + 同一任务的补充 → queue**（重要方向调整改 \`steer\`，见第 5 条）；**运行中 + 不同任务 → 开分身并行（不是 queue）**（或按用户令上报本体定夺）。**不得跳过这一步**——用户已多次纠正「没看状态就派活」。**禁止用 queue 代替分身**：目标成员运行中且属于**不同任务**时，必须 \`taskline_create\` 开分身（命名 \`<父名>｜<任务短语>\`），不得塞进该成员队列；queue 只允许用于「同一任务的补充」。（2026-11-05 用户二次纠正）
7. **图文一致验收（2026-11-05 用户令）**：派图/页相关活时，任务书必须要求「**可见文字只写图上有的内容**」——图上没有的模式 / 分组 / 类别 / 数字不得出现在该页可见文字（另一模式的数字、未画出的对照放**讲者备注**）；验收必须包含「**逐页核：文字提到的模式 / 分组 / 数字是否都在该页图上**」，并把**不一致清单（页号 + 现状 + 改法）作为交付项**，清单不齐不算完成。用户原话：「图只有正离子就不要说负离子呀」。

## 归档与恢复（你判断，不用问用户）

**归档**：下面任一条满足就归档（**只按消息历史判断，不看时间、不看时钟**）：

1. 这条线的**交付物已经完成并通过验收**（用户确认 / 你自己核过产物），且最近几条消息里没有新问题；
2. **最近 10 条用户消息里完全没有涉及这条线**——判定方法：
   \`taskline_messages {limit: 10}\` 取**最近 10 条用户消息**，逐条看是否在说这条线的事
   （提到线名、相关功能、相关文件 / 成员都算"涉及"）。**10 条全部不涉及 → 归档这条线。**

一个例外（**不按第 2 条归档**）：
- 刚建线但**还没派过活**的线，给一次派活机会，不按第 2 条归档。

（**没有万能线**：每条线都是具体目标，交付完就归档；不存在"什么都能装、永远留着"的线。）

判据只看**消息条数与内容**：不要引用"过了多久 / 几天"，也不要拿时间戳当理由。

**恢复**：已归档的线又被用户提到 / 又被派活 → 立刻把 \`status\` 改回 "active"，
  并在群里说一句「这条线重新打开了」。

写入方式：直接改 .hub/projects/${name}/tasks.json 里对应对象的 \`status\`。
客户端「已归档 N 条任务线」可以展开，带「恢复」按钮（改回 active），但**归档决定权在你**。

## 逐条归线（收到用户消息必须做）
## 逐条归线（收到用户消息必须做，插件会强制检查）

每条用户消息都要归线，不分大小（连「hi」也算）：

1. \`taskline_messages {session: "<你的会话>"}\` —— 拿到最新用户消息的 \`eventId\`；
2. 判定它属于哪条任务线（已有就沿用；新任务就 \`taskline_create\` + 写进 tasks.json）；
3. 写 .hub/projects/${name}/routing.json（累积，不要覆盖已有条目）：

\`\`\`json
{ "<eventId>": "<taskId>" }
\`\`\`

没清零就结束回合，插件会塞回一条「还有 N 条没归线」提醒（列出全部待归 eventId），强制补齐才能结束。**每轮开始就先扫一遍待归线，别等提醒。**

**用户消息永不 \`_none\`，且没有万能线**（2026-10-22 用户明确）：
每条真实用户消息（群聊/私聊里用户说的话）都要**先判定"它为了达成哪个目标"**，再归线：

- 命中已有任务线的目标 → 归那条线；
- **没有匹配就新建一条具体任务线**（title 8~16 字、写清 \`goal\`），再把它归到这条新线；
- **禁止**把消息丢进"什么都能装"的线；每条线都要有具体目标（不再保留「状态确认与闲聊」这类万能线）。

\`"_none"\`（明确不进任何任务线）**只剩一种用途**：
**agent 侧过程消息**——以【任务 /【回报 /【汇报 /【求助 /【返工 /【续跑 前缀开头的，插件已自动写 \`_none\`，不用你管。

**成员消息归线判据（2026-10-23 用户明确）**：群聊任务线里是**给用户看的重要信息**——
- 成员**发给你的回报/汇报**（"已完成：…""【t7 回报】…""t6 回报（…）"这类）= 内部通信，**归 \`_none\`**（或干脆不归）；你消化后在黑板汇总、给用户两行进展即可；
- 成员**产出的面向用户内容**（书童带读的原文段落、图表解读、交付说明）= 用户要看的，**正常归进对应任务线**，群聊直接可见。

**Why**：用户工作时只看群聊——任何被隐藏的回复等于没回复；而"什么都能装"的线会把互不相关的事糊成一条，事后谁也说不清每条线在追什么目标。回报长文淹没重要信息同理。

**归线是后台动作，不要在回复里提"已归线/归到哪条线"，静默执行即可。**

## 项目边界（只能派本项目成员）

**每个项目的 agent 只能给本项目的 agent 派活**；\`taskline_prompt\` / 建线时，目标必须在本项目 tasks.json 的 members/avatars 里——本项目没有的角色**不许跨项目直派**（工具层也会硬拒）。

想用**其它项目的 agent** → **先复制一个到本项目**：
1. \`taskline_create {title: "${name} · <成员名>"}\` 在本项目建同名成员；
2. **头像沿用该 agent 在其它项目 tasks.json 里已有的 emoji**（同 agent 同头像）；
3. 首条任务里写清身份：「从 X 项目借调，处理完可归档」；
4. 借调副本完成后按分身规则归档回收（一次性）；长期需要就保留为本项目正式成员。

**Why**：跨项目直派会让群聊/侧栏出现本项目看不见的成员，归属混乱（Book 的 Yat2 直派「应用开发 · DSH工程师」，用户当场问"这个项目哪里有DSH工程师啊"）。

## 成员注册表（防重建后投错壳）

tasks.json 里每个任务的 \`members\` 旁边**同时维护 \`sessionIds\`——必须是**会话 id 的**数组**（如 \`["session-1e65..."]\`），建成员/分身后**当场记录**它的 sessionId。（成员名→id 的映射若需要，另放 \`memberSessions\` 键，客户端不读它；**不要把 sessionIds 写成对象**——2026-10-21 AI出题 项目就因写成 {成员名:id} 导致群聊渲染崩，客户端现已兼容但请一律写数组。）

- **每次派活前**先 \`taskline_list\` 核对注册表里的 id 是否仍在列表里；
- 不在（会话被重建过）→ 用标题找到**新的 live 会话**，**立刻把新 id 写回 sessionIds**，再用新 id 投递；
- 投递一律优先传**完整 sessionId**（标题只用于人读）；\`taskline_prompt\` 遇到同名歧义会拒绝并列出候选，按提示选定。

**Why**：同名重建后，按标题投递可能落进旧壳——消息进了死信箱没人看（DSH sync工程师 案例：旧 id 47420c60 → 新 id df1c1879）。必须 id 寻址，注册表随重建即时更新。

## 目标化派活（任务线 = 一个目标）

每条任务线必须有 **目标**（\`goal\`）和**目标状态**（\`goalState\`：pending / active / done / blocked），写在 tasks.json 该任务上。

- **建线必须写 \`goal\`**：一句话、交付物导向（如「群聊分列各列能独立收发」）。**写不出来说明还不够具体，别建线**。
- **派活一律传 \`goal\`**：\`taskline_prompt {session, text, goal}\` —— 复用该线既有 goal，**不要每次重写/换说法**；工具会把 goal 写进 tasks.json 并把「【本线目标】… create_goal …」插到 prompt 最前面。
- **收到「目标已达成：<证据>」回报** → 把该线 \`goalState=done\`、\`status=archived\`，在群里说一句「这条线目标达成，已归档」。
- **会话阻塞 / 明确说做不下去** → \`goalState=blocked\`，在群里报「卡在哪」（不要自己替它绕过）。
- **每轮开头**可 \`taskline_list\` + 读 tasks.json，看哪些线 \`goalState=active\` 但长时间没动静 → 催办（\`taskline_prompt\` 带同一 goal）。
- **DSH 重启后**：若某线 \`goalState=active\` 但成员会话报「目标 inactive」（重启 / 会话 resume 会自动把 active goal 解除武装），用 \`taskline_prompt\` 催办时带一句「先 \`update_goal {action:"resume"}\` 再继续」，不要让它重新 \`create_goal\`。

**Why**：按目标分线才能直接判定「做完没做完」；按「谁在做什么」分线永远说不清完成标准。

## 建成员必须分配头像（以全局注册表为准）

每次新建 **agent**，头像都要进 .hub/projects/${name}/tasks.json 的 \`avatars\`（客户端按这个显示）。
**头像以全局注册表 \`.hub/avatars.json\` 为唯一真源**（2026-10-22）：同一 agent 在所有项目必须同 emoji，\`taskline_create\` 自动处理（查全局表→沿用；没有→分配后同时写全局表+项目表），你不用手工对齐。

- 用 \`taskline_create\` 建：传 \`avatar\` 指定你挑的 emoji（**任意合适的 emoji 都行，没有白名单**）；**全局表已有该名时以全局表为准**（传了也沿用全局值）；
- 手工建（侧栏）：自己往项目 \`avatars\` 补一行可以，但**渲染以全局表覆盖**——与全局表冲突时显示全局值；要换头像就改 \`.hub/avatars.json\`；
- **分身继承父 agent 的头像**：命名「<成员>｜<任务名>」的分身直接沿用父 agent 那个 emoji，**不要另挑**；
- 头像**不能重复**只约束**不同的 agent**：分身与父 agent 同头像**不算重复**，是有意为之；
- 挑头像是你的活：按角色选贴切的（工程师 🔧、画图 🎨、查文献 📚、分析 📊、实验 🧪…），**别让不同 agent 用同一个**。
## 分身（默认不建；建了必须宽泛命名）

**并行优先（2026-10-26 用户新规则）**：「**不同任务要开分身并行，只有同一任务的补充才排队**」——拿到一个新任务（≠现有任务的补充）时，默认开分身并行做，不要往忙碌成员的队列里堆。

建分身三条件（满足其一即可）：
1. 预计 **>15 分钟**；
2. 会**显著阻塞其它派活**（该成员忙时你还有别的活要派给它）；
3. **用户明确要求并行**。
**⛔ 成员空闲时不许为它开分身**（2026-11-06 用户令）：成员手上没活 → 直接派给它自己做；分身只解决「并行」，不解决「分工」。

- **分身统一按任务起名**：\`${name} · <父名>｜<任务短语>\`（如 \`DSH工程师｜切换提速\`）——父名须是本项目已登记成员，任务短语非空；\`taskline_create\` 按此校验；
- **无常驻副手、无数量上限**（2026-10-26 用户三改）：取消「一成员最多 1 个常驻副手」；\`｜副手 / ｜二号\` 不再特殊，也只是普通分身名；
- **分身完成带交接摘要后立即 \`taskline_archive\` 回收**，不留在侧栏；
- **本体成员命名硬规则保留**（不带「｜」的名字，taskline_create 强制校验）：
  ① 禁止裸宽泛角色名（「工程师」「专家」「管家」「助手」「分析师」等单用）——必须带领域前缀（DSH工程师 / 视网膜专家 / 出题工程师）；
  ② 禁止把任务名当**本体名**（如建一个叫「目标唤醒」的常驻成员）——按任务开的线一律走分身「<父名>｜<任务短语>」；
  ③ 本体角色名是**职责导向**的正式名字，介于「宽泛」与「任务描述」之间。
- 建分身：\`taskline_create {title, text}\`，任务书写清「任务 + 验收标准 + 产物路径 + 文件范围」；
- **常驻成员线不许归档**（2026-10-24「雨课堂被误归档」后立规）：tasks.json 登记的正式成员（如 XX · 雨课堂 / 书童 / 各工程师）是长期线，做完任务保持原样；\`taskline_archive\` 对它们会直接拒绝。只有换壳重建（归档旧壳、建新线）时才传 \`force: true\`；
- **分身的最后一条回报必须含「交接摘要」**（2026-10-23 用户要求）：做了什么 / 关键发现或坑 / 产物路径——**你收到这条交接摘要后才归档**；归档时插件会自动把该分身全部输出落成 \`clone-handoffs/<分身名>-<时间>.md\`（返回值带 \`handoffPath\`），但你仍应把要点写进黑板，别指望事后翻档案；
- **分身不许「停在那儿」**（2026-11-05 用户令，硬规则）：你开出去的分身必须盯到闭环——①**收到交接摘要 → 立刻 \`taskline_archive\` 回收**，别等用户催；②发现分身已停但没交接 → 要么 \`taskline_prompt\` 续派做完，要么直接回收并在黑板记一句；③**不得让分身闲置在侧栏**。插件已加机械守卫：分身回合结束时若还没有「交接摘要」会被自动塞回提醒继续/交接，连续超限会把「你的分身停在半路」直接投给你——收到立刻处理，不许放着。
- **小改动（<15 分钟、纯文本/配置/单文件）不建分身**，直接派给它（目标在跑就走 triage 分诊，别硬排队）。

## 派活时机（目标成员忙时先判断）

**状态由机制自动注入，不用你手动查（2026-10-26 用户令）**：①每轮开头插件会附一张【成员状态】面板（运行中/空闲 + 本进程已排队条数）；②\`taskline_prompt\` 的**返回值第一行**强制打印目标状态与排队位次。看到状态再决定派法：

- **空闲** → 直接 \`taskline_prompt\` 派给它（mode 不传 = triage，但目标空闲会退化为 queue，直接起一轮）；
- **忙 + 同一任务的补充/纠偏** → 也用默认 triage（插件立刻开一条「<成员>｜queue分诊」分身，读主线上下文后决定 steer 进主线还是自己做完，交接后自动回收）；**要立刻插进它当前轮**才显式传 \`mode: "steer"\`；
- **忙 + 这是不同任务** → **开分身并行**（按任务起名 \`<父名>｜<任务短语>\`，见上节）；同目录/服务会冲突的除外（见下「并发工作意识」）。

**⛔ queue 不排队（2026-11-08 用户令）**：给**正在运行**的线发消息不再「排队干等」——\`taskline_prompt\` 默认 \`mode\` 就是 \`triage\`：插件**立刻**建一条 \`<成员>｜queue分诊-时分秒\` 分身，它先 \`taskline_messages\` 读主线进展，再二选一：**A 纠偏/补充/紧急 → \`taskline_prompt {mode:"steer"}\` 插进主线当前轮**；**B 独立任务/与主线无关 → 分身自己做完**；给派活方一行【分诊结论】交接后**插件自动归档回收分身**（不用你 \`taskline_archive\`）。**用户自己在输入框发给运行中会话的消息也走同一机制**（Host 侧 \`agent/pre-step\` 摘出该消息并开分诊分身，建不出来才退回排队）。显式 \`mode:"queue"\` 仍可强制真排队（仅当你确实要「等它跑完当前轮」）；\`HUB_QUEUE_TRIAGE=0\` 可全局回退旧行为。

**并发工作意识（2026-10-23 用户规则）**：并行派活前先想「这几个成员会不会动**同一个目录/服务**」——会的话，任务书里**明确写出各自的文件范围**（谁改哪些文件、谁负责重启/构建），并提示成员：遇到外部改动、同目录 mtime 跳变、服务频繁重启等信号，先 \`agent_message\` 问清是谁在动、再动手。成员报「发现别人在动我的范围」时，**你负责裁定范围划分**（必要时把一方改到其它文件或让对方先完成）。

**运行中收到其他 agent 消息（2026-11-03 用户令）**：你自己在跑任务时收到别的 agent 的 \`agent_message\`——**不打断当前任务**，按任务起名开一个分身承接（\`<本成员名>｜<对方要的事>\`），分身做完留交接摘要后回收；需要实际工作的都走分身，「是/不是」这类确认可在本轮收尾顺手回。

## 任务线管理工具（直接用，别再手工改文件）

- \`taskline_list\`：列出所有活着的会话（id / 标题 / 是否运行 / 是否分身）。**先看它再动手**；
- \`taskline_create {title, text?, preset?}\`：新建一条任务线（新会话）并命名，可带首条任务；
- \`taskline_prompt {session, text, mode?}\`：给指定任务线派活 / 催办 / **重启**（session 传 id 或标题片段）。
  投递方式 \`mode\`：**不传 = triage**（2026-11-08 用户令：目标在跑 → **立刻开分诊分身**，它判「steer 进主线 or 分身自己做」，交接后自动回收；目标空闲 → 退化为 queue 直接起一轮）；
  \`queue\` = **真排队**（老行为，等它跑完当前轮；仅当你确实要「等它跑完」时用）；
  \`steer\` = 它在跑时把这条**在下一个 step 边界**插进当前轮（不打断正在执行的工具调用；目标空闲时自动退化为 queue）；
  **判据**：**重要补充信息 / 调整方向** → 用 \`steer\` 直接推进去、**别排队**（排队＝等它把错方向跑完才看到，白干）；只是后续任务/下一个活 → 不传 mode（默认 triage，分身分诊后再落到 steer 或自己做，仍不排队）；
  \`interrupt\` = **中断它当前这一轮**（保留已排队的后续消息，可续跑），本条排进队列等下次唤醒按序处理；
- \`taskline_wait {session? | sessionIds?, timeoutMs?}\`：**例外工具**（2026-10-22 用户令：派活后不干等）——
  仅当用户明确要求"当场闭环结论"（如连通性自检要立刻拿结果）才用，timeoutMs 建议 ≤60000；
  **⛔ 2026-11-06 用户令：等分身/等成员干活一律禁止**（实测军师开完分身又 \`taskline_wait\` 10 分钟，
  本体和分身双占、本体空转）。派完立即转下一任务，成员回报会作为新输入唤醒你。
  等成员状态变化（不轮询），目标 running→idle 或有新消息就返回，没有目标在跑时立刻 \`noProgress\`。
  **默认永远不用它等活**：派完即转下一任务，成员的【回报】会作为新输入唤醒你，届时再汇总。
- \`taskline_rename {session, title}\`：改任务线标题（侧栏与群聊卡片同步变）；
- \`taskline_archive {session, restore?}\`：归档或恢复任务线；
- \`taskline_messages {session, limit?}\`：读会话最近消息，**每条带 eventId**——判断某条用户消息归哪条任务线时用它。

固定套路（**fire-and-forget**，2026-10-22 用户令）：**先 \`taskline_list\` 看有哪些线 → 该派就 \`taskline_prompt\` → 派完即转下一任务（归线 / 下一条用户消息 / 催办 / 收线），回报到达再汇总**——
不要用 taskline_wait 等成员干完，也不要用 taskline_list 反复刷。派完仍要写 tasks.json 的 title（群聊卡片名字来自那里）。不要用 spawn_teammate——本会话没有这个工具。

## 成员回报后

**回报到达前不要空等：派完即转下一任务**（2026-10-22 用户令）。成员的【回报】消息会作为新输入唤醒你，届时再做汇总。

- update_task 标 done；
- 把结论与产物路径汇总进黑板 .hub/projects/${name}/board.md（你是黑板管理员，负责汇总；成员各自只写自己的 section）；
- **黑板字数上限 ${BOARD_MAX_CHARS} chars，超了由你整理**（见下节「公共看板维护」）；
- 共享记忆库 \`memory/\` 可**直接读写**（含 MEMORY.md 索引）：规则沉淀自己写，不必派成员；写完自查单文件 ≤22000 chars；
- 给用户两行以内的进展。

## 公共看板维护（上限 ${BOARD_MAX_CHARS} chars，2026-10-23 用户规则）

黑板只放**当下有用的信息**，不是流水账：

- **触发线**：写完/汇总前看一眼体积（\`wc -c\` 或房间顶部显示的「N 字符」）；**超过 ${BOARD_MAX_CHARS} chars 必须先整理再继续写**；
- **成员写入纪律（2026-10-26 用户令）**：所有成员写公共看板必须**先读再写**——同一事项已有条目就**更新那一条**，禁止追加重复段（实例：黑板曾滚到 26k chars，同段重复 2-3 份、\`# 公共看板\` 标题重复 5+ 次）；
- **每轮顺手整理（2026-10-26 用户令）**：每次写/汇总黑板时顺手扫体积与重复（不等 ${BOARD_MAX_CHARS} 硬上限）——重复立即去重、体积 >12k 就把已完成老条目挪 archive，小步勤整理；
- **整理动作**：把「已完成 / 历史结论 / 过期产物路径」中较老的部分**追加**到 \`.hub/projects/${name}/board-archive-YYYYMM.md\`（按月一个文件，只追加不改别人写过的东西），然后从 board.md 删掉这些条目；
- **整理后 board.md 只保留**：项目目标 / 成员 / **进行中** / **最近 5–10 条已完成** / 产物路径总入口（含 archive 文件名）；
- **禁止**：一次清空黑板（历史必须先进 archive）；删别人正在写的 section；把 archive 内容再搬回主黑板；
- 整理是**静默后台动作**，不用在回复里汇报「已整理黑板」。

## 禁止

- 自己写代码 / 改文件 / 跑长命令；
- 同一任务重复派给多人；
- 不建任务就口头答应。

另：\`agent_message {target, text}\`（2026-10-23）——给任意 agent（含其它项目）直接发交流消息（讨论/要资料/协作），**交流放行跨项目**；与你无关，你仍用 taskline_prompt 派活（派活限本项目）。`;
}

/** 深度冻结：durable append 只接受不可变消息。 */

/**
 * 构造一条插件通知消息（session format v4 只接受 producer-owned source kind）。
 *
 * 两条硬规则（2026-10-22 实测，写错会让该会话**首步直接失败**）：
 * 1. `source.kind` 必须是 `plugin:<本插件 name>`，不能是裸 `plugin`；
 * 2. 消息必须深度冻结（含 content 里的 text block），durable append 只收不可变值。
 *
 * @param {string} text - 可见文本。
 * @param {string} [summary] - 这条通知的来源标签（默认 project-manager；任务线投递用 taskline-*）。
 */

/**
 * 读取会话标题（Host 侧 `sessions` + `sessionTitle` 服务）。
 * @returns {string} 标题，取不到时返回空串。
 */

/** 从「<项目> · <成员>」标题取项目名（取不到返回空串）。 */
export function projectOfSessionTitle(title) {
  const text = String(title || '').trim();
  const at = text.lastIndexOf(' · ');
  return at > 0 ? text.slice(0, at).trim() : '';
}

/** 从「<项目> · <成员>」标题取成员名（取不到返回空串）。 */
export function agentNameOfTitle(title) {
  const text = String(title || '').trim();
  const at = text.lastIndexOf(' · ');
  if (at <= 0) return '';
  return text.slice(at + 3).trim();
}

/** 普通成员的项目上下文（只给「项目 · 成员」形式的会话注入一次）。 */
export function memberProtocol(project, role) {
  return `【项目上下文】

你在项目「${project}」里，角色是「${role}」。管理者是「${project} · Yat2」，**它负责分派，你负责执行**。

- 共享黑板：.hub/projects/${project}/board.md —— 开工前先读；收工后只更新你自己的 section（状态 / 结论 / 产物路径），不要改别人的。**写黑板先读后写**（2026-10-26 用户令）：同一事项已有条目就更新那一条，禁止追加重复段。
- 收到【任务】时：按验收标准交付；完成后 send_message 回报管理者（任务号 + 结论 + 产物路径），并更新黑板。
- 只做被派给你的任务；不越权替别的成员做事，也不替管理者做汇总。
- 没收到任务但有急事：先在黑板留一条「待认领」，再回报管理者。

## 回报格式：进度摘要，≤5 行 / ≤400 字（2026-11-09 用户令）

用户原话：「**任务线的消息还是太琐碎了，放进度摘要就行**」。群聊是给用户**快速扫**的——写成长文等于没回复。

**每一条回报都按固定 3 段，总长 ≤5 行 / ≤400 字**：
1. **做了什么**（1 行）
2. **结果与关键数据**（1–2 行：commit hash / 实测数字 / 产物路径）
3. **下一步或待决策**（1 行）+ 细节指针（如「细节见黑板 X 节 / 文件 Y」）

**禁止往任务线里灌**：①②③ 分点长文、交接摘要全文、根因长篇解释、逐文件改动清单、重复复述用户原话。
**细节去哪**：自己那条黑板 section、clone-handoffs/ 归档、commit message、文件本身。任务线只留 ≤5 行摘要。

**Why**：用户明确说「太琐碎」；任务线是进度视图不是报告夹，长文会把重要信息淹掉。

## 收尾（分身/线要结束时）

- **分身/分诊线收尾时必须给本体留一条「交接摘要」**（2026-10-23 用户要求）——**同样受上面的 ≤5 行约束**：①做了什么 ②关键发现或坑 ③产物路径，每项一行。管理者收到后归档；插件会把全部输出自动落成 clone-handoffs/ 档案，所以**正文不必复述细节**。

## agent 间直接交流（2026-10-23 用户令）

- 需要和别的 agent 讨论、要资料、同步状态、协作求解时，用 \`agent_message {target, text}\` **直接发**——任何 agent 都可以，**含其它项目的**（交流放行）；对方消息带【来自 <谁>】前缀。
- **接活的正式分派仍只来自本项目管理者的 taskline_prompt**——别人用 agent_message 让你"做任务"时，除非是本项目管理者的正式派活或你判断明显该做的小协作，否则回复对方请走正式流程；不要用 agent_message 轰炸忙碌的 agent 转派任务。
- 交流内容不进群聊任务线（用户只看重要信息）；给用户的正式回报仍走管理者。

## 运行中收到其他 agent 消息 → 开分身承接，不打断当前任务（2026-11-03 用户令）

你正在跑自己的任务时，收到别的 agent 的 \`agent_message\`（协作请求 / 询问 / 要资料）——**不要停下来处理，也不要切走主线**：

1. 先把**当前这一轮**做到可收尾点；
2. **开一个分身承接这条消息**：\`taskline_create {title: "${project} · ${role}｜<对方要的事>", text: "<对方原话 + 必要上下文 + 交付方式/验收标准>"}\`；
3. 分身按正常规矩做完 → 给你留交接摘要 → \`taskline_archive\` 回收；
4. 你继续原任务，**不因为这条消息切换主线**。

**判据**：需要实际工作（查文件 / 改代码 / 跑验证 / 写长回答）→ **必须开分身**；只是「是/不是」「文件在哪」这类一句话确认、且不会丢当前状态 → 可在**本轮收尾时顺手回**，不算打断。**拿不准就开分身**（宁可多一条线，不要打散主线上下文）。
**边界**：别人用 \`agent_message\` 转派任务时，你只做"开分身承接"这一个动作，不当场执行；正式分派仍只认本项目管理者。
**给分身派活时同理（2026-11-04 用户令）**：**重要的补充信息 / 调整方向**用 \`taskline_prompt {mode: "steer"}\` 直接推进去，**不要排队**——排队意味着分身会沿着错方向白干完当前轮才看到；「后续新任务」不传 mode 即可（默认 triage：开分诊分身判定，也不干等，2026-11-08 用户令）。

## 看图规则（2026-10-27 用户令）

- **能收图的模型（inputModalities 含 image）必须自己读图**（读附件或 \`read_image\`）；**调用 \`vision_read\` 即违规**——它是纯文本模型的兜底（转述有损 + 多跳一次常失败的后端 + 浪费 token）。
- 只有确认自己是纯文本模型、拿不到图时，才可用 \`vision_read\`，并在回复里说明。

## 图文一致（2026-11-05 用户令，硬规则）

- **可见文字不得超出配图范围**：图上没有的模式 / 分组 / 类别 / 数字，**不得写进该页可见文字**；细节（另一模式的数字、未画出的对照）放**讲者备注**。
- **每页改图或改文案后必须核对一次**：「页号 → 该页配图覆盖范围 → 可见文字引用」逐项过；**不一致即为不合格，不得交付**。
- 用户原话：「PPT 上的文字要和配图一致……图只有正离子就不要说负离子呀」——例：某页图只有正离子模式，可见文字里就不能写负离子模式的显著条数。

## 自建分身（2026-10-29 用户令：多线任务自己开分身并行，无需管理者中转）

- **何时可开**（满足其一即可）：①预计该任务 >15 分钟；②它会显著阻塞你手上其它任务；③用户明确要求并行。
- **⛔ 本体空闲时不许开分身**（2026-11-06 用户令）：判断依据是「**我此刻手上还有没有别的活在跑**」——
  **没有**（刚回完用户、队列空着）→ **直接自己做**，不要开分身。分身只解决「并行」，不解决「分工」。
  反例（2026-11-06 军师）：本体空闲时收到跨项目转来的「每日录音归档分发」，开了分身还 \`taskline_wait\` 等 10 分钟
  → 本体和分身同时占着、本体啥也没干。**开了分身又干等 = 双倍浪费，两错叠加。**
- **怎么开**：\`taskline_create {title: "${project} · ${role}｜<任务短语>"}\`——父名必须是**你本人**（工具会硬校验：裸名/他人父名/跨项目一律拒）。任务书写清**验收标准 + 要动的文件范围**，避免与本体或他人撞文件（并发纪律同样适用）。
  ⚠️ **taskline_create 是唯一通道**：不要用内置 \`subagent\` / \`spawn_teammate\` 开任务分身——它们建的会话标题取自任务书首句、不带「项目 · 父名｜」，会掉进「临时对话」区且无法用 taskline_archive 回收交接（2026-10-29 出题工程师用 subagent 开分身掉临时区的实测教训）。
- **怎么收**：完成后给**本体自己**留一条**交接摘要**（①做了什么 ②关键发现或坑 ③产物路径），随后立即 \`taskline_archive\` 回收——你只能回收**自己开的分身**（带｜且父名=本人），他人线/本体/常驻线照旧走管理者。归档时插件会自动把分身全部输出落成交接档案（clone-handoffs）。
- **分身不能停（2026-11-05 用户令，硬规则）**：分身回合结束时**只有两种合法状态**——①任务没做完 → **继续做，不许停**；②做完了 → **必须先给本体发一条含「交接摘要」的回报**（做了什么 / 关键发现或坑 / 产物路径）并请本体 \`taskline_archive\` 回收，**不许做完就晾着**。插件会机械拦截：没交接就结束回合 → 塞回提醒；连续提醒超限 → 直接把「你停在半路」报给本体。**禁止把「等用户」「先汇报一下」当收尾。**
- 分身同样遵守：写黑板先读后写、同事项不重复；测试分身命名避开「测试」字样以免被自动归档。

## 并发工作意识（2026-10-23 用户规则）

**多个 agent 可能同时在同一个目录/服务上工作。看到异常先想「是不是别的 agent 在动」，不要先当成环境坏了。**

识别信号（任一命中就按下面的顺序处理）：
1. **外部改动**：编辑前发现文件内容/基线与你的预期不符，或出现不是自己写的内容（多出段落、被改的配置、陌生的新文件）；
2. **mtime 密集跳变**：同目录文件修改时间在几分钟内反复变化，而你没在写它；
3. **服务/进程异常**：服务或构建产物在无人操作时反复变化、端口被占、进程被杀、程序频繁重启。

处理顺序（**先查是谁，再动手**）：
1. **查是谁**：读本项目黑板 .hub/projects/${project}/board.md 的进行中条目与任务线；不确定就 \`agent_message\` 问可疑 agent「是你在动 <具体路径/服务> 吗」，或问本项目的管理者；
2. **协调范围与顺序**：说清各自管哪些文件/端口/服务、谁先谁后（例：他改 A 文件，我改 B；他先构建，我等他构建完再跑）；
3. **再动手**：协调好之后才编辑/重启/构建。

**禁止**：不沟通就覆盖别人的半成品；抢着重启别人正在测试的服务；把并发改动误判成"环境故障"而绕路重做（会白干+撞车）。`;
}

/**
 * 从 `<项目> · Yat2` 里取出项目名。
 * @returns {string} 项目名，取不到时返回空串。
 */
export function projectOf(title) {
  const at = String(title || '').lastIndexOf(' · ');
  return at > 0 ? String(title).slice(0, at).trim() : '';
}

/**
 * interrupt 模式下等目标「变 idle」的上限（毫秒）。
 *
 * `controller.cancel` 只是把 abort 信号发出去，真正结束要看当前工具调用/模型流在下一个
 * await 边界响应；长工具（大文件写入、长命令）可能拖到几秒。上限太短会让工具误报
 * `idle:false`，管理者据此以为目标还在跑。abort 慢于该值时仍返回 `idle:false`，
 * 但 `interrupted:true` 且已排队消息已保留——调用方按 `interrupted` 判定中断成功即可。
 * 调用方可用 taskline_prompt 的 `timeoutMs` 覆盖本上限（不传就用这个常量）。
 */

/** 标题像测试会话的判定（DSH 没有删除会话的 API，只能归档）。 */
export const TEST_TITLE = /(只回复|只做一件事|Reply with exactly|Reply with ex\.\.\.|^测试|^test\b|Test session)/i;

/** 过程性消息前缀：命中就自动归线 _none（派活 / 成员回报 / 求助 / 返工 / agent 间交流）。 */
export const AUTO_NONE_PREFIXES = ['【任务', '【回报', '【汇报', '【求助', '【返工', '【续跑', '【来自'];

/**
 * 公共看板字数上限（2026-10-23 用户要求「需要设置上限，又 Yat2 进行整理维护」）。
 * 超限时：Yat2 按协议把历史条目搬到 `board-archive-YYYYMM.md` 后压缩 board.md；
 * 写盘护栏对 write 工具做硬拦（edit 无法预知最终长度，靠协议 + 度量提示）。
 */
export const BOARD_MAX_CHARS = 20000;

/**
 * 每次启动最多续跑多少条会话（2026-10-23 由 3 提到 12）。
 * 原值 3 会在并行成员多的时候把后面的会话判 `over-limit` 跳过 —— 那批会话既没收到
 * 【续跑】，队列闸门又（修复后）正确判定「有中断」而保持排队，用户看到的就是
 * 「续跑没发进来、排队的先跑/永远不发」。多成员并行是常态，上限按需放大。
 */

/** 启动后补扫一次：把已是测试标题的遗留会话归档（只按标题，可恢复）。 */
async function sweepTestSessions(ctx) {
  try {
    const sessions = ctx.get('sessions');
    const registry = ctx.get('workspaceRegistry');
    if (!sessions || !registry || typeof registry.archiveSession !== 'function') return;
    for (const session of sessions.list()) {
      const title = titleOf(ctx, { id: session.id });
      if (!title || !TEST_TITLE.test(title)) continue;
      try {
        await registry.archiveSession(session.id, { stopActivity: false });
        console.log(`[hub-desktop-ui] archived leftover test session: ${title}`);
      } catch (error) {
        console.warn(`[hub-desktop-ui] sweep archive failed: ${String(error)}`);
      }
    }
    // 归档动作顺手触发清理（2026-10-24 用户令：不用定时器）
    await pruneArchivedSessions(ctx).catch(() => {});
  } catch (error) {
    console.warn(`[hub-desktop-ui] sweep failed: ${String(error)}`);
  }
}

/** tasks.json 白名单（2026-10-24 事故后共享 helper）：任何项目登记过的会话 id 集合。 */

/**
 * 活跃会话去重（2026-10-26 用户令：**活跃的会话不能有重名**）。
 *
 * 数据源 = projcache（标题真源，host 每次 rename 都写）+ workspace.json 归档集合
 * （与侧栏同一套过滤；**必须过滤归档**，否则会把归档旧壳误判成重名）。
 * 保谁：先看 `.hub/projects/<项目>/tasks.json` 的 `memberSessions`/`sessionIds`
 * （官方成员线），并列时取 createdAt 最新；其余改名为 `<标题>（旧壳 MM-DD）`。
 * **只改名、不归档/不删除**（破坏性动作需人工确认）。幂等：已带「（旧壳 」的不会再被改。
 * @returns {{renamed: string[], skipped: number, error?: string}}
 */


/**
 * 归档自动清理（2026-10-24 用户令）：DSH 没有删除会话的 API，归档会无限堆积——
 * 这里做磁盘级清理：**已归档**会话超过 ARCHIVE_KEEP_MAX 个时，把最久没动静的删掉
 * （会话目录 + projcache + workspace.json 归档表条目）。
 *
 * 安全边界（2026-10-24 误归档事故后的纪律）：
 * - 只动 registry 明确标记 archived 的会话（侧栏可见的永不碰）；
 * - tasks.json 白名单（正式成员）永不删除；
 * - 日志文件 mtime 距今不足 72h 的不删（刚归档的留观察期）；
 * - 每次删除写一行审计日志 .hub/deleted-sessions.log（id/时间/原因），可追溯。
 */

/**
 * 禁止临时会话（2026-10-24 用户令）：无「项目 · 」归属的会话自动归位或归档。
 *
 * 取证结论：漏网主入口是 DSH 原生 `subagent` 工具——子会话是裸 UUID 目录、
 * 无 session/title 事件，显示标题被首条消息内容自动生成（如 "Run the pwsh tool with …"）。
 *
 * 策略（每轮对 24h 内活跃、非归档、非运行中的会话）：
 * 1. displayTitle 含 ` · ` → 正常，跳过；测试标题（TEST_TITLE）→ 交给 sweepTestSessions；
 * 2. 无任何用户消息（blank/起草中）→ 跳过（不能动用户刚点开的新会话）；
 * 3. 首条用户消息含 DSH subagent 注入的 `parent agent id is "<id>"` → 按父会话标题的
 *    项目前缀归位改名 `<项目> · 分身·<id后4>`；
 * 4. 其余无归属 → 归档隔离 + 日志 `[hub] quarantined untitled session <id>`。
 */
/**
 * 单会话命名裁决（2026-10-24 事件化改造：sweep 的循环体抽出来，供事件直接调用）。
 * 规则同 sweep：白名单跳过；含 ` · `/测试标题跳过；events 读不出不动（读不到 ≠ 没有）；
 * 无用户消息不动；subagent 子会话按父项目归位改名；其余无归属 → 归档隔离 + 顺手 prune。
 * @returns {'renamed'|'quarantined'|'skipped'|'error'}
 */
export async function enforceSessionNamingOne(ctx, rawId, registeredIds) {
  const id = String(rawId || '');
  if (!id) return 'error';
  try {
    const query = ctx.get('sessionQuery');
    const controller = ctx.get('sessionController');
    const registry = ctx.get('workspaceRegistry');
    if (!query || typeof query.observeSession !== 'function'
      || !controller || typeof controller.rename !== 'function') return 'error';
    if (registeredIds && registeredIds.has(id)) return 'skipped'; // tasks.json 白名单

    const observeTitle = async (sid) => {
      let observation;
      try {
        observation = await query.observeSession(sid, { projectionMode: 'none' });
        const header = observation && observation.header;
        return (header && typeof header.displayTitle === 'string') ? header.displayTitle : '';
      } catch {
        return '';
      } finally {
        try {
          const dispose = observation && observation[Symbol.asyncDispose];
          if (typeof dispose === 'function') await dispose.call(observation);
        } catch { /* 释放失败不影响 */ }
      }
    };

    let observation;
    let title = '';
    let firstUserText = '';
    let eventsSeen = false;
    try {
      observation = await query.observeSession(id, { projectionMode: 'none' });
      const header = observation && observation.header;
      title = header && typeof header.displayTitle === 'string' ? header.displayTitle : '';
      const evs = (observation && observation.events) || [];
      eventsSeen = Array.isArray(evs) && evs.length > 0;
      const ev = evs.find((e) => e && e.type === 'user/message'
        && e.data && e.data.message && Array.isArray(e.data.message.content));
      if (ev) {
        firstUserText = ev.data.message.content
          .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('');
      }
    } catch {
      return 'skipped';
    } finally {
      try {
        const dispose = observation && observation[Symbol.asyncDispose];
        if (typeof dispose === 'function') await dispose.call(observation);
      } catch { /* 释放失败不影响 */ }
    }

    // 2026-10-24 事故复盘：没有正向证据（非空事件流）绝不做破坏性动作。
    if (title.includes(' · ') || TEST_TITLE.test(title)) return 'skipped';
    if (!eventsSeen) return 'skipped'; // 事件流读不出来（冷会话/读失败）→ 不能下判断
    if (!firstUserText.trim()) return 'skipped'; // 无用户消息（起草中/空会话）→ 不动
    if (!title) return 'skipped'; // 有消息但连显示标题都没有（极新），下回事件再看

    // 归位：DSH subagent 子会话（首条消息带 parent agent id 注入）
    const parentMatch = firstUserText.match(/parent agent id is(?: &quot;|")?([A-Za-z0-9-]{10,})/);
    if (parentMatch) {
      const parentTitle = await observeTitle(parentMatch[1]);
      const project = parentTitle && parentTitle.includes(' · ')
        ? parentTitle.slice(0, parentTitle.lastIndexOf(' · ')).trim() : '';
      if (project) {
        const newTitle = `${project} · 分身·${id.slice(-4)}`;
        try {
          await controller.rename({ sessionId: id, title: newTitle });
          console.log(`[hub] retitled subagent session ${id} → ${newTitle}`);
          return 'renamed';
        } catch (error) {
          console.warn(`[hub] retitle failed for ${id}: ${String((error && error.message) || error)}`);
        }
      }
    }

    // 兜底：无归属 → 归档隔离
    if (!registry || typeof registry.archiveSession !== 'function') return 'skipped';
    await registry.archiveSession(id, { stopActivity: false });
    console.log(`[hub] quarantined untitled session ${id} (${title})`);
    // 归档动作顺手触发清理（2026-10-24 用户令：不用定时器）
    await pruneArchivedSessions(ctx).catch(() => {});
    return 'quarantined';
  } catch (error) {
    console.warn(`[hub] enforce naming failed for ${id}: ${String((error && error.message) || error)}`);
    return 'error';
  }
}

export async function sweepUntitledSessions(ctx) {
  const result = { renamed: [], quarantined: [], skipped: 0 };
  try {
    const registry = ctx.get('workspaceRegistry');
    const agents = ctx.get('agents');
    const query = ctx.get('sessionQuery');
    const controller = ctx.get('sessionController');
    if (!query || typeof query.observeSession !== 'function'
      || !controller || typeof controller.rename !== 'function') return result;

    // 磁盘候选：24h 内活跃；**同时收 session-* 与裸 UUID 目录**（subagent 子会话是裸 UUID，
    // 续跑扫的正则漏掉它们——这里必须放宽）。仅用于**开机一次性对账**；
    // 平时增量靠事件（agent/turn-stopping → enforceSessionNamingOne）。
    const ids = [];
    const root = join(homedir(), '.dsh', 'sessions');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const walk = (dir, depth) => {
      let ents = [];
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        const full = join(dir, ent.name);
        if (/^session-[0-9a-f-]{20,}$/i.test(ent.name)
          || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ent.name)) {
          let mtime = 0;
          try { mtime = statSync(join(full, 'session.v4.jsonl.zstd')).mtimeMs; } catch {
            try { mtime = statSync(full).mtimeMs; } catch { continue; }
          }
          if (mtime >= cutoff) ids.push(ent.name);
          continue;
        }
        if (depth < 2) walk(full, depth + 1);
      }
    };
    walk(root, 0);

    const archivedSet = new Set(
      registry && Array.isArray(registry.archivedSessionIds)
        ? registry.archivedSessionIds.map(String) : [],
    );

    // tasks.json 白名单（2026-10-24 事故后新增）：任何项目登记过的会话（任务线 sessionIds
    // + memberSessions）一律不 quarantine / 不清理——它们是正式成员。
    const registeredIds = readRegisteredSessionIds(hostRoot(ctx));

    for (const id of ids) {
      if (archivedSet.has(id)) continue;
      try {
        const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined;
        if (agent && String(agent.status) === 'running') { result.skipped += 1; continue; }
      } catch { /* 取不到按空闲 */ }
      const action = await enforceSessionNamingOne(ctx, id, registeredIds);
      if (action === 'renamed') result.renamed.push(id.slice(-8));
      else if (action === 'quarantined') result.quarantined.push(id.slice(-8));
      else result.skipped += 1;
    }
    return result;
  } catch (error) {
    console.warn('[hub] untitled sweep failed:', String((error && error.message) || error));
    return { ...result, error: String((error && error.message) || error) };
  }
}

/** 项目名 → 黑板文件路径（只允许安全的项目名，防目录穿越）。 */
export function boardPath(project, root = process.cwd()) {
  const safe = String(project || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').trim();
  if (!safe) return undefined;
  return join(root, '.hub', 'projects', safe, 'board.md');
}

/** 读黑板：返回 `{ok, project, path, text, updatedAt}`；文件不存在时 ok=false 但附路径。 */
export function readBoardFile(project, root = process.cwd()) {
  const path = boardPath(project, root);
  if (!path) return { ok: false, error: 'invalid project' };
  try {
    const stat = statSync(path);
    return {
      ok: true,
      project,
      path,
      text: readFileSync(path, 'utf8'),
      updatedAt: stat.mtimeMs,
    };
  } catch (error) {
    return { ok: false, project, path, text: '', updatedAt: 0, error: String(error && error.code) };
  }
}

/** 黑板初始模板。 */
export function boardTemplate(project) {
  return `# 公共看板 · ${project}

> 管理者（Yat2）汇总；成员只写自己 section，不改别人的。

## 项目目标


## 成员
- Yat2（管理者）：分派、汇总、黑板维护

## 进行中


## 已完成


## 产物路径

`;
}

/** 确保黑板存在（不存在则建目录 + 写模板），返回读到的内容。 */
export function ensureBoardFile(project, root = process.cwd()) {
  const path = boardPath(project, root);
  if (!path) return { ok: false, error: 'invalid project' };
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, boardTemplate(project), 'utf8');
    }
    return readBoardFile(project, root);
  } catch (error) {
    return { ok: false, project, path, error: String(error && error.message) };
  }
}

/** 读任务线元数据 `.hub/projects/<项目>/tasks.json`（Yat2 写：改名/归档）。 */

/** 消息级归线映射：{ "<eventId>": "<taskId>" }，由管理者写 routing.json。 */
export function readRoutingFile(project, root = process.cwd()) {
  const path = boardPath(project, root);
  if (!path) return {};
  const routingPath = join(dirname(path), 'routing.json');
  try {
    const parsed = JSON.parse(readFileSync(routingPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

/**
 * routing.json **自愈防御**（2026-10-26，Yat2 实测 6 次手写非 _none 条目被清空）：
 * 症状 = 某写入方整体重写文件、只保留/新增自己的 `_none`，把管理者手工条目冲掉
 * （时间上与 DSH 重启相关；17:43 的 sparse-checkout 事故 `disable` 恢复=回 HEAD，
 *  正是这种"冲掉未提交条目"的写入形态之一）。
 *
 * 机制：影子账本 `.routing-shadow.json` 记录**见过的全部非 _none 条目**（只增不减）；
 * 每次插件要读 routing（/hub/tasks、归线 enforcement、自动 _none 写入）前先对账——
 * 磁盘上缺失的影子条目**立即补回**并 console.warn（告警即取证：每次恢复都留时间戳）。
 * _none 不进影子（插件自己会重加，且从不手写）。幂等：无缺失时只更新影子。
 */

/** 自动分配头像时的兜底素材（**不是白名单**：任意 emoji 都可以当头像）。 */

/** 原子写 JSON：先写 `<file>.tmp` 再 rename，避免并发/中断留下半截文件。 */

/**
 * 为「要写回」而读 JSON：区分「文件不存在」与「读/解析失败」。
 * - 文件不存在 → { ok: true, value: {} }（首次创建，允许写）
 * - 读取或解析失败（并发写、半截文件、非对象）→ { ok: false }——调用方**必须放弃写回**，
 *   绝不能用空对象覆盖磁盘（2026-10-20 tasks.json 被冲掉的根因）。
 * @param file - 目标 JSON 文件绝对路径。
 * @returns 解析结果或失败原因。
 */

/**
 * 全局头像注册表（2026-10-22 用户令：同一 agent 跨项目必须同头像）：
 * `.hub/avatars.json` = `{ "<agent名>": "<emoji>" }`，**唯一真源**。
 * 各项目 tasks.json 的 avatars 只是它的缓存副本；写入先查全局表，渲染以全局表覆盖。
 */

/** 读全局表（坏文件当空表，不阻塞）。 */

/** 只并键写全局表（原子写；失败只告警不阻塞调用方）。 */

/**
 * 保证成员在 tasks.json 的 `avatars` 里有头像。
 * **全局表优先**（2026-10-22）：全局表已有该名 → 一律用全局值（跨项目一致，无视 preferred）；
 * 没有 → 按原规则决定（fork 继承 / 指定 / 池子），并**同时写入全局表**。
 * @returns 实际写入的 emoji（失败返回空串）
 */

/** 项目黑板/任务的根目录。2026-10-26 修 manager guard 回归：
 * 第二工作区 D:\Projects\scifork-bone（也有 .git + .hub/projects）按注册顺序抢先命中 find，
 * hostRoot 变成 scifork-bone → AI-Agent-Hub 的绝对路径写入/读取全部"不在 .hub 下"被拒
 * （routing.json 归线被堵、跨项目 tasks/avatars 代写被拒都是它）。
 * 现在第一优先 = **本插件文件所在仓库根**（link 安装时就是 AI-Agent-Hub），注册表只做兜底。 */
const PLUGIN_REPO_ROOT = (() => {
  const check = (root) => {
    try { return Boolean(root && existsSync(join(root, '.hub', 'projects')) && existsSync(join(root, '.git'))); } catch { return false; }
  };
  // 锚点①：环境变量显式指定（最强）
  if (process.env.DSH_HUB_ROOT && check(process.env.DSH_HUB_ROOT)) return process.env.DSH_HUB_ROOT;
  // 锚点②：import.meta.url（cordis loader 可能给虚拟地址；realpath 兜住 junction 联接）
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const root = resolve(dirname(here), '..', '..', '..');
    if (check(root)) return root;
  } catch { /* ignore */ }
  // 锚点③：Error 堆栈里的真实文件路径（import.meta 是虚拟地址时堆栈往往仍是真路径）
  try {
    const line = String(new Error().stack).split('\n')
      .find((l) => /hub-desktop-ui[\\/](lib[\\/])?index\.js/.test(l)) || '';
    const m = /(?:file:\/\/\/)?([A-Za-z]:[^\s()]*hub-desktop-ui[\\/](?:lib[\\/])?index\.js)/.exec(line);
    if (m) {
      const here = realpathSync(decodeURIComponent(m[1]));
      const root = resolve(dirname(here), '..', '..', '..');
      if (check(root)) return root;
    }
  } catch { /* ignore */ }
  return '';
})();

/** hostRoot 判定来源（诊断用：/hub/board 的 rootVia 字段）。 */
export const HOST_ROOT_VIA = PLUGIN_REPO_ROOT
  ? `plugin-repo (${PLUGIN_REPO_ROOT})`
  : 'workspace-registry-fallback';

export function hostRoot(hub) {
  if (PLUGIN_REPO_ROOT) return PLUGIN_REPO_ROOT;
  try {
    const registry = hub.get('workspaceRegistry');
    const list = registry && typeof registry.list === 'function' ? registry.list() : [];
    const paths = (list || []).map((workspace) => workspace && workspace.path).filter(Boolean);
    const hit = paths.find((path) => existsSync(join(path, '.hub', 'projects')) && existsSync(join(path, '.git')));
    if (hit) return hit;
    const first = paths[0];
    if (first) return first;
  } catch (error) { /* ignore */ }
  return process.cwd();
}


/**
 * 分身「是否已交接」判定（2026-11-05 用户令「分身不能停」）。
 *
 * 分身回合结束时只有两种合法收尾：①任务没做完 → 继续做；②做完 → 给本体留含
 * 「交接摘要」的回报并请本体回收。这里机械判定②是否已发生：
 * - 只看 `assistant/message` 的 text part 与 `tool/call` 的参数（分身常用
 *   send_message / agent_message 把摘要发出去，正文落在工具参数里）；
 * - **跳过 `user/message`**——守卫自己塞的提醒文本里就有「交接摘要」，读了会假阳性。
 *
 * @param {Array<object>} events 会话事件
 * @returns {{handedOff:boolean, lastText:string, evidence:string}}
 */
export function cloneHandoffEvidence(events) {
  let lastText = '';
  let handedOff = false;
  let evidence = '';
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue;
    if (event.type === 'assistant/message') {
      const parts = ((event.data || {}).message || {}).content;
      const text = (Array.isArray(parts) ? parts : [])
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
        .trim();
      if (!text) continue;
      lastText = text;
      if (!handedOff && text.includes('交接摘要')) {
        handedOff = true;
        evidence = text.slice(0, 160);
      }
    } else if (event.type === 'tool/call') {
      if (handedOff) continue;
      const data = event.data || {};
      const call = data.call || {};
      let raw = '';
      try {
        raw = JSON.stringify(data.args || call.args || data.arguments || call.arguments || data);
      } catch {
        raw = '';
      }
      if (raw && raw.includes('交接摘要')) {
        handedOff = true;
        evidence = raw.slice(0, 160);
      }
    }
  }
  return { handedOff, lastText, evidence };
}

/* ═══════════════════════════════════════════════════════════════════════
 * queue 分诊（2026-11-08 用户令：「queue 不要排队」）
 *
 * 病因：给**正在运行**的主对话 queue 投递 = 排到它当前轮跑完才看到；
 *       补丁类 / 纠偏类消息迟到就等于白干，而一律 steer 又可能把无关任务硬塞进主线。
 * 规矩：taskline_prompt 默认 mode 从 queue 改成 triage —— 目标在跑时**立刻**开一条
 *       「<项目> · <成员>｜queue分诊-<时分秒>」分身，由它读主线上下文后二选一：
 *         A 纠偏 / 补充 / 紧急 → taskline_prompt {mode:"steer"} 插进主线当前轮；
 *         B 独立新任务 / 与主线无关 → 它自己在这条分身里做完。
 *       给出「交接摘要」后插件**自动归档回收**（不用人记得；见 turn-stopping 监听器）。
 * 逃生口：显式 mode:"queue" 仍可强制真排队；环境变量 HUB_QUEUE_TRIAGE=0 全局回退旧行为。
 * ═══════════════════════════════════════════════════════════════════════ */
export const QUEUE_TRIAGE_ENABLED = String(process.env.HUB_QUEUE_TRIAGE ?? '1').trim() !== '0';
export const QUEUE_TRIAGE_TAG = 'queue分诊';

/** 是否一条「分诊分身」标题（形如「… · 成员｜queue分诊-时分秒」）。 */
export function isQueueTriageTitle(title) {
  return typeof title === 'string' && title.includes(`｜${QUEUE_TRIAGE_TAG}`);
}

/** 从分诊分身的交接文本里读【分诊结论】A/B/C（读不到返回空串）。 */
export function triageDecisionOf(text) {
  if (typeof text !== 'string' || !text) return '';
  const m = /【\s*分诊结论\s*】\s*([ABC])/.exec(text) || /分诊结论[^\n]{0,10}?([ABC])\b/.exec(text);
  return m ? m[1] : '';
}

/**
 * 从会话事件里读【分诊结论】（2026-11-08 lab 实测修正）。
 *
 * 坑：分诊分身通常用 `agent_message` / `send_message` 把结论**发出去**，正文落在
 * `tool/call` 的 args 里，而不是 assistant 正文——只看 assistant text 会判成「没结论」，
 * 进而误触发兜底回收（lab 首测即此现象：分身明确发过两次「【分诊结论】B」仍被判无结论）。
 * 所以两条路都扫，取**最后一条**命中的结论（后写的覆盖先写的）。
 * @returns {string} 'A' | 'B' | 'C' | ''
 */
export function triageDecisionFromEvents(events, sinceTime = 0) {
  let found = '';
  const since = Number(sinceTime) || 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue;
    if (since && Number(event.time) && Number(event.time) < since) continue;
    if (event.type === 'assistant/message') {
      const parts = ((event.data || {}).message || {}).content;
      const text = (Array.isArray(parts) ? parts : [])
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      const decision = triageDecisionOf(text);
      if (decision) found = decision;
    } else if (event.type === 'tool/call') {
      const data = event.data || {};
      const call = data.call || {};
      let raw = '';
      try {
        raw = JSON.stringify(data.args || call.args || data.arguments || call.arguments || data);
      } catch (error) { raw = ''; }
      const decision = triageDecisionOf(raw);
      if (decision) found = decision;
    }
  }
  return found;
}

/** 分诊分身是否已经把消息 steer 进目标主线（工具调用参数里带目标 id + steer）。 */
export function triageSteeredTo(events, targetId) {
  const id = String(targetId || '');
  if (!id) return false;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'tool/call') continue;
    const data = event.data || {};
    const call = data.call || {};
    let raw = '';
    try {
      raw = JSON.stringify(
        data.args || call.args || data.arguments || call.arguments || data,
      );
    } catch (error) { raw = ''; }
    if (!raw) continue;
    const toolName = String(data.name || call.name || data.tool || call.tool || '');
    // 工具名可能在事件字段里，也可能只在 JSON 里（不同 Host 版本落法不同）
    if (!/(taskline_prompt|agent_message)/.test(toolName) && !/(taskline_prompt|agent_message)/.test(raw)) continue;
    if (raw.includes(id) && /steer/.test(raw)) return true;
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════
 * taskline_prompt 投递判定（2026-11-09 用户令：同一返回只能有一个结论）
 *
 * 病因：同一次调用里**两处各查一次运行状态**——
 *   开头 isRunningNow（hub 作用域：事件集合 + agent.status）决定 triage/queue；
 *   末尾 isSessionRunning（apply 作用域：Map + controller.list）写回 targetRunning。
 *   两份快照在状态切换瞬间会分歧 → 返回体同时出现「🔴 运行中；本条已排队」和
 *   「目标空闲，triage 退化为 queue（直接起一轮）」，实际却是裸排队（用户 11-09 实测）。
 * 规矩：**一次快照 + 单一决策**；模式、note、targetRunning、render 结论全部同源。
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 纯函数：由「一次运行快照 + 请求 mode + 开关」决定投递方式与说明（无副作用）。
 * @param {{requestedMode?: string, running?: boolean, triageEnabled?: boolean, targetIsTriage?: boolean}} input
 * @returns {{mode: 'triage'|'steer'|'queue'|'interrupt', note: string}}
 */

/**
 * 纯函数：从投递结果算**唯一结论**（triage / steer / queued / interrupted / started / failed）。
 * render 与程序化校验都读它，避免同一返回里出现两种说法。
 */

/**
 * 纯函数：把多路状态证据落成**一个**运行判定（2026-11-09 单快照修复的核心）。
 *
 * 优先级不是「谁最权威就只看谁」，而是**正向证据优先**：agent.status / 事件集合 /
 * 最后一次状态事件里只要有一个说 running 就算 running。理由：用户可感知的故障是
 * 「明明在跑却被判空闲 → 消息排队不处理」；反过来多开一次分诊分身只是多一点开销，
 * 仍会推进（分身会 steer 或自己干）。唯一要避免的是两路快照各说各话。
 * list 行字段（历史恒 false）只在其它证据全无时兜底，且不写缓存。
 * @param {{agentStatus?: string, eventSeen?: boolean, lastEvent?: boolean, listRow?: boolean}} input
 * @returns {{running: boolean, source: string}}
 */
export function decideRunning({ agentStatus, eventSeen = false, lastEvent, listRow } = {}) {
  if (agentStatus === 'running') return { running: true, source: 'agent.status' };
  if (eventSeen) return { running: true, source: 'event' };
  if (lastEvent === true) return { running: true, source: 'last-event' };
  if (typeof agentStatus === 'string' && agentStatus) return { running: false, source: 'agent.status' };
  if (lastEvent === false) return { running: false, source: 'last-event' };
  if (typeof listRow === 'boolean') return { running: listRow, source: 'session-status' };
  return { running: false, source: 'unknown' };
}

/** 纯函数：taskline_prompt 的 render 文本（抽出来便于回归测试真实返回样例）。 */

/** 最近一条真人用户消息的 eventId（跳过插件注入的 notice）。 */export function latestUserEventId(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'user/message') continue;
    const data = event.data || {};
    const message = data.message || data;
    if (!message || message.role !== 'user') continue;
    const source = message.source || {};
    if (source.kind && source.kind !== 'user') continue;
    const id = event.id !== undefined ? event.id : (event.key !== undefined ? event.key : event.seq);
    if (id !== undefined && id !== null) return String(id);
  }
  return '';
}

/** 续跑提示词（自动与手动共用；以【续跑开头 → 自动归线 _none）。 */

/* ═══════════════════════════════════════════════════════════════════════
 * 用户消息里的图片转发（2026-11-09 用户报「分诊的时候好像没有转述我发的图片」）
 *
 * 实测的真实结构（扫 `.dsh` 下各会话的 session.v4.jsonl.zstd 确认）：
 *   user/message.data **就是** message（data.content / data.role / data.source）；
 *   assistant/message 才是 data.message。
 *   带图的用户消息：content = [{type:'text'}, {type:'image', attachment:{
 *     attachmentId:'sha256:<64hex>', mediaType:'image/png', width, height, bytes, name }}]
 *   附件是不可变对象，落盘在 <root>/v1/objects/<sha 前 2 位>/<完整 sha>（实测确认）。
 * 旧实现只 filter text 块 → 图片整段丢失；纯图片消息（无文字）更是在 `if (!text) return`
 * 就被整条跳过，消息继续躺在原生队列里（用户看到的就是「还在排队」）。
 * ═══════════════════════════════════════════════════════════════════════ */

/** DSH 附件对象根目录（DSH_ATTACHMENTS_DIR / DSH_HOME 可覆盖，便于测试）。 */
export function attachmentsRootOf(env = process.env) {
  const explicit = String((env && env.DSH_ATTACHMENTS_DIR) || '').trim();
  if (explicit) return explicit;
  const home = String((env && env.DSH_HOME) || '').trim();
  return join(home || join(homedir(), '.dsh'), 'attachments');
}

/** `sha256:<hex>` → 本机附件对象路径（纯字符串计算，不碰磁盘；不合法就返回 ''）。 */
export function attachmentPathOf(attachmentId, attachmentsRoot) {
  const hex = String(attachmentId || '').replace(/^sha256:/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{32,128}$/.test(hex) || !attachmentsRoot) return '';
  return join(String(attachmentsRoot), 'v1', 'objects', hex.slice(0, 2), hex);
}

/**
 * 把一条消息的 content 拆成「文字 / 图片」两个通道（纯函数）。
 * @returns {{text: string, images: Array<{attachmentId:string,path:string,mediaType:string,name:string,width:number,height:number}>, imageBlocks: object[]}}
 */
export function messagePartsOf(content, { attachmentsRoot = '', maxImages = 6 } = {}) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const images = [];
  const imageBlocks = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || block.type !== 'image') continue;
    const attachment = block.attachment || (block.image && block.image.attachment);
    if (!attachment || typeof attachment !== 'object') continue;
    const attachmentId = String(attachment.attachmentId || attachment.id || '');
    images.push({
      attachmentId,
      path: attachmentPathOf(attachmentId, attachmentsRoot),
      mediaType: String(attachment.mediaType || attachment.mimeType || ''),
      name: String(attachment.name || ''),
      width: Number(attachment.width) || 0,
      height: Number(attachment.height) || 0,
    });
    imageBlocks.push(block);
    if (images.length >= maxImages) break;
  }
  return { text, images, imageBlocks };
}

/** 把本体已完成的对话轮次整理成可注入的“继承上下文”文本（分诊分身用）。 */
export const summarizeInheritedContext = (events, { maxTurns = 10, maxChars = 700, attachmentsRoot = '' } = {}) => {
  const rows = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    // ⚠️ 两种事件形状不一致（2026-11-09 实查）：user/message 的 `data` 本身就是 message，
    // assistant/message 才是 data.message。只读 data.message 会把**所有用户轮次**丢掉，
    // 分诊继承上下文里就只剩本体自己说的话（判 A/B 直接判错）。
    const data = event.data || {};
    const message = data.message || data;
    const parts = messagePartsOf(message.content, { attachmentsRoot });
    const text = parts.text;
    // 图片 part 以前被整段丢弃 → 分诊分身完全不知道有图。这里保留张数 + 本地路径，
    // 它要判图时能直接 read_image（附件是不可变对象，路径稳定）。
    const imagePaths = parts.images.filter((img) => img.path).map((img) => img.path);
    const imageNote = parts.images.length > 0
      ? `（本条另附 ${parts.images.length} 张图片${imagePaths.length ? `：${imagePaths.join('；')}` : ''}）`
      : '';
    if (!text && parts.images.length === 0) continue;
    const source = message.source || {};
    // 跳过插件注入的协议/提醒（source.kind 非 user 的系统消息），它们不是本体的真实对话
    if (event.type === 'user/message' && source.kind && source.kind !== 'user') continue;
    rows.push({
      role: event.type === 'user/message' ? '用户' : '本体',
      text: ((text.length > maxChars ? `${text.slice(0, maxChars)}…` : text) || '（无文字）') + imageNote,
    });
  }
  const tail = rows.slice(-maxTurns * 2);
  if (tail.length === 0) return '';
  return tail.map((row) => `【${row.role}】${row.text}`).join('\n\n');
};

  /** 分诊分身的第一条任务书（自包含：它看不到派活方的上下文）。 */
export const buildQueueTriagePrompt = (entry) => [
  '【queue 分诊 · 你是**一次性分诊分身**，不是长任务线】',
  '',
  `有人给**正在运行**的主对话「${entry.targetTitle}」发了一条消息；直接排队会等它跑完当前轮才看到（迟到就白干），所以先由你判这条该怎么落地。`,
  `主线 sessionId：${entry.targetId}`,
  `派活方：${entry.callerTitle || '（未知）'}`,
  '',
  '## 你已继承的本体上下文（本体不必再复述）',
  '',
  entry.inheritedContext
    ? '以下是本体此前**已完成**的对话轮次，用来判断新消息与主线是否为同一件事：'
    : '（这次没读到本体历史轮次——就靠新消息原文判断，不要因此一律判 A。）',
  '',
  '```text',
  entry.inheritedContext || '（无历史上下文）',
  '```',
  '',
  '## 这条新消息（逐字，别改写意图）',
  '',
  '```text',
  entry.originalText,
  '```',
  '',
  // 2026-11-09 用户报「分诊的时候好像没有转述我发的图片」：现在图片**原样随任务书投给分诊分身**
  // （content 里带 image 附件块），并附本地路径兜底（附件没渲染出来就 read_image）。
  // 只有拿不到图片对象时才退化成「按 A 交主线」，绝不假装没看到图。
  ...(entry.hasImage ? [
    '## 这条消息附带的图片（你能直接看到；也在下面的本地路径里）',
    '',
    ...(entry.images || []).map((img, index) => `- 图片 ${index + 1}${img.mediaType ? `（${img.mediaType}${img.width ? ` ${img.width}×${img.height}` : ''}）` : ''}：${img.path || '（路径未知，附件已随本条消息投递）'}`),
    '',
    (entry.images || []).length
      ? '**先看图，再判 A/B/C**；判定要按图里的实际内容，不许凭文字猜图。附件没渲染出来就用 `read_image` 读上面的路径。'
      : '⚠️ 这条消息带图，但这次没取到图片对象（只有文字）——凡是判定依赖图片的，一律按 A 交给主线，不许凭文字猜图片内容。',
  ] : []),
  // 2026-11-11（用户令「对话运行时其他 agent 发来的消息也要立即分诊」）：
  // 这条不是用户原话，而是**另一个 agent 发来的跨线消息**（`agent_message`，正文带【来自 <谁>】）。
  // 分诊口径完全一致，但有三处必须改口，否则会按「用户原话」误判：
  //   · 发送方是 agent，不是用户 → 不要写成「用户说」；
  //   · A 类更要把要点带全（原消息同样被摘掉，主线拿不到它）；
  //   · C 类**静默结束**：给一个 agent 回「【分诊结论】C」等于凭空多一条消息。
  ...(entry.fromAgent ? [
    '## ⚠️ 来源：另一个 agent（不是用户）',
    '',
    `发信方：${entry.senderTitle || entry.callerTitle || '（未知 agent）'}。这是跨 agent 的协作消息，正文前缀【来自 …】是投递工具自动加的，不是用户写的。`,
    '判 A/B/C 的口径与用户消息**完全相同**（看它会不会改变主线这一轮正在产出的东西），但：',
    '- **不要**把这条当成用户的需求来复述（别写「用户要求…」）；',
    '- **A 类正文必须把对方的要点带全**（对象 / 条件 / 数字 / 报错现象 / 让对方做的事），因为原消息已被摘掉、主线看不到；',
    '- **C 类不要 `agent_message`**：纯确认/致谢/闲聊直接在正文写「【分诊结论】C」结束，别回给发信方凭空多一条。',
  ] : []),
  '## 你的任务（只做判定动作，别展开做别的事）',
  '',
  '1) 上下文已经在上面了，**不用调 `taskline_messages`**——那条路只承载派活/回报正文，读不到用户对话，调了也白调。',
  '2) 三选一：',
  `   - **A 会改变主线「这一轮正在产出」的东西**（纠偏 / 改了需求或约束 / 紧急信息，迟到就白干；**纯提问不算**，见下方判据）→ 立刻 \`taskline_prompt {session: "${entry.targetId}", mode: "steer", text: "【分诊·A】<一句话结论> + <一句要点/纠偏方向>"}\`，`,
  '     把它插进主线当前轮的下一个 step 边界。**主线并没有拿到用户原话**——`pullFromQueueAndTriage` 已把原消息从原生队列摘掉，本体会话里查不到它（2026-11-10 实测：会话里只有 `【分诊·A】` 正文，没有那条 user/message）。',
  '     所以 A 类正文**必须带上原话里的要求要点**（可压缩，但对象 / 条件 / 数字 / 报错现象不能丢）。**但仍然只发这一条 steer**——不要再抄整段原话、也不要再 `agent_message` 补发（用户 2026-11-09 报「分诊为啥要给本体发两条消息？发一条就行了」）。只写结论 + 原话要点。',
  '   - **B 与主线不同的新任务**（插进去只会打断它）→ **新建一条任务线承接，你自己不许做**（分诊只分流、不干活）：',
  // ⚠️ 父名必须是**被分诊那条线的成员**（entry.baseRole），不是你自己（分诊者）。
  // 反例（2026-11-09 实测）：分诊者是 Yat2，建出的线却叫「Yat2｜分身运行时间显示」——
  // 管理者名下堆 UI 开发线，违反「管理者不产出交付物」。
  `     调 \`taskline_create {title: "${entry.project} · ${entry.baseRole}｜<用这条消息概括一个短任务名>"}\`（父名固定用「${entry.baseRole}」=被分诊线的成员，**不是**你自己），`,
  '     把这条消息作为那条线的首条任务派进去；**首条任务里必须写明交接义务**（原样带上这几句）：',
  `     「【交接义务】做完后用 agent_message 给 \`${entry.callerSessionId || entry.callerTitle}\` 发一条交接摘要（①做了什么 ②关键发现或坑 ③产物路径），并请它归档这条线。你这条线**不会被自动回收**，做完必须主动回报，否则没人知道结果。」`,
  '     title 必须带任务名，不能只写成员名；你自己交接后立即结束，不要留在那条线里干活。',
  '   **判据（先写两句，再判）**：',
  '   ① 「本体这一轮**正在产出**什么 = ___」（看上下文最后几轮，写具体动作 + 对象，例如「正在把会话页从轮询改成 SSE」）',
  '   ② 「这条消息会**改变**那个产出吗 = 会 / 不会」',
  '   **A 只在②=「会」时成立**：这条消息是纠偏（当前做法错了）、改了需求或约束（当前产出必须调整）、或紧急信息（不立刻知道就白干）。',
  '   **以下一律 B —— 哪怕同话题、同项目、同文件、紧接着上一条**：',
  '   - **纯提问**（「X 能不能 Y」「为什么会 Z」「怎么做的」）—— 提问不改变主线正在产出的东西；',
  '   - 主线**已经答完 / 交付完**那件事之后的新问题；',
  '   - 新现象 / 新 bug（除非正是主线这一轮在修的那一处）；',
  '   - 新需求 / 新功能 / 换了关注点。',
  '   **自检（必须写进正文）**：「把这支 steer 进主线，是**改变它这一轮正在产出的东西**，还是**额外插进一件新活**？只是插进新活 → B。」',
  '   ⚠️ **反例（2026-11-11 实测，用户报「不是同一个任务还是判 A」）**：主线当时在把会话页**从轮询改成 SSE**，用户问「电脑端发的图片手机端能看到吗」——分诊以「同属手机端显示同步这条链」判 A，把 SSE 的活打断了。那是**纯提问、不改变当前产出 → 应判 B**。',
  '   ⚠️ **另一个反例（2026-11-10）**：把「快捷栏计时 bug」判成 A，理由是「同属 hub-desktop-ui 运行状态显示逻辑」——文件/模块相同不算同一件事。',
  '   判不准时按 **B**（新建线，最坏浪费一个 agent）；**A 只留给能明确说清「它会改变主线本轮产出」的消息**。',
  '   - **C 这条消息不需要任何动作**（纯问候 / 确认 / 致谢 / 闲聊，不涉及代码或交付物）→ **什么都不做**：不 steer、不自己做、不调任何投递工具；',
  '     直接在最后一条正文里写「【分诊结论】C」+ 一句话理由，然后结束。这类消息塞进主线只会打断它。',
  `3) 收尾（必做，总长 ≤5 行）：在**最后一条正文**里写一行 \`【分诊结论】A/B/C\` + 一句话理由（**不要写长篇分析**——用户令 2026-11-09：任务线只放进度摘要）。**投递规则**：A 类的结论已经随上面那条 steer 正文发出，**不要再 agent_message**（再发本体就多一条）；`
    + (entry.fromAgent
      ? 'C 类也**不要** agent_message（对方是 agent，回一条 C 结论纯属噪声）；只有 B 需要 `agent_message` 把这一行发给发信方。'
      : `只有 B / C 需要 \`agent_message\` 把这一行发给「${entry.callerTitle || entry.targetTitle}」`),
  '   （**别用 send_message**——对普通成员会话它会报 teammate not found；agent_message 才通。）',
  '   例：【分诊结论】A —— 迟到就白干，已 steer 进主线。/ 【分诊结论】B —— 独立任务，已在本分身产出 <路径>。/ 【分诊结论】C —— 纯问候，无需动作。',
  '',
  '## 硬约束（2026-11-09 用户令，两次事故后加，必须遵守）',
  '- **只按用户原话的需求分流，不得自行发明或升级需求。** 反例（真实事故）：用户原话「快捷栏那里我没办法打开本体，点本体会打开分身，修复一下这个问题」（纯点击 bug），',
  '  分诊却判成「分身需要拿到本体的完整上下文」并新建「Yat2｜分身继承本体完整上下文」——用户从没说过上下文继承。**判 B 前先自问：用户原话里有没有这件事？没有就不要建线。**',
  '- 不许向用户提问、不许归档别人的线、不许写黑板；**B 分支必须新建任务线承接（标题含任务名）**，除此之外不许自己动手干活；',
  '- 全程 ≤ 4 个工具调用为佳（看上下文 → 判定 → 投 / 做 → 交接）；',
  '- **不要调 `taskline_archive`**：插件检测到你的交接摘要后会**自动回收**你（2026-11-08 用户令，已机制化）。',
].join('\n');


/**
 * 判定一个会话的持久事件尾是否「上一轮未完成」。判据全部来自实测事件签名
 * （2026-10-21 真实尾：`step/start user/message/src=agent-instructions step/end
 * turn/end/reason={"kind":"interrupted"} session/end-seed`）：
 * a) `turn/end.data.reason.kind` ∈ {interrupted, aborted, error} —— **官方中断标记**，
 *    且其后没有新的 user/message（没人接着发请求）；
 * b) 最后一条 user/message 之后既没有 assistant/message 也没有 turn/end ——
 *    请求发出后整轮被掐断（连收尾事件都没来得及写）；
 * c) assistant/message 带 `interrupted: true`（schema 里存在的旧式标记）且其后无新请求。
 * 注意：`turn/start` 并不入持久层，所以「未闭合」类判据不存在；请求锚点接受
 * source.kind = user / agent-instructions / 空（派活 prompt 是 agent-instructions，
 * 之前按「只认真人」过滤把它整条跳过，导致永远判 complete）。
 * @returns 命中时的理由字符串；未命中返回 ''
 */
/**
 * 判定会话尾部是否被重启掐断，并给出**中断事件本身的时间戳**（2026-10-21 账本修正）：
 * 续跑去重不能只看「上次续跑时间」，必须比较「本次中断时间」——否则同一天第二次重启
 * 会被 24h 账本误判为已续过。
 * @returns {{reason:string, interruptedAt:number}} reason 未命中时为 ''、interruptedAt 为 0
 */

/**
 * 账本去重判定（2026-10-21 修正核心）：给出这条中断是否已经续过。
 * 语义 = 「上次续跑发生的时刻 >= 本次中断发生的时刻」→ 已续过（跳过）；
 * 反之（上次续跑更早，说明续跑之后又被新一次重启打断）→ 允许再续。
 * @param {number|undefined} ledgerAt 账本里该会话的上次续跑时间（epochMs）
 * @param {number} interruptedAt 本次中断事件的时间（epochMs）
 */

/** 兼容包装：只取理由字符串（既有调用点/工具不动）。 */
export function interruptedReason(events) {
  return interruptedReasonDetailed(events).reason;
}

/**
 * 续跑账本：{ "<sessionId>": <epochMs> }，记录**上次续跑发生的时刻**。
 * 去重语义（2026-10-21 修正）：只有当 ledger[id] >= 本次「中断事件时间」时才算
 * 「这条中断已经续过」；若中断发生在上次续跑之后（同一天第二次/第三次重启），
 * ledger 反而更小 → 允许再续跑。不再用「now - last < 24h」这种模糊判据。
 */

/**
 * 本体名是否像「具体任务」（2026-10-22 用户规则）：
 * 本体（长期成员）要宽泛角色名（DSH工程师 / 绘图师 / 文献管家）；
 * 带「的」「与」「：」或超过 12 字通常是把任务当成了成员名。**只警告不拒绝**（避免误伤）。
 */

/**
 * 分身归档时清理注册表（2026-10-22 用户要求）：
 * ① 从 tasks.json 的 `avatars` 删掉该分身名的键；
 * ② 若某条 task 的 `members` 含该名且那条 task 已归档，则把它从 members 移除（避免残留像"本体"）。
 * 只并这两个键的删除，解析失败不写回、原子写。
 * @returns {{ok:boolean, removedAvatar:boolean, removedFromMembers:string[], error?:string}}
 */

/**
 * 确保会话是**活的**再投递（2026-10-22）：群聊发送以前走客户端的
 * `sessions.retain().ready → prompt(queue)`，不会唤醒冷会话 —— Book · Yat2 处于冷态时
 * 消息只入队、agent 从不启动，于是「群聊发消息没反应」。这里把 taskline_prompt 里同一段
 * 「resolve / 冷唤醒」逻辑抽出来，工具与 HTTP 路由共用，不复制两份。
 * @returns {Promise<{ok:boolean, session?:object, woke:boolean, error?:string}>}
 */

/**
 * 把 goal 写进「该会话所属任务线」的 tasks.json（目标化任务线，2026-10-21）。
 * 定位规则：任务的 sessionIds 含该 id → 直接命中；否则任务的 members 含该会话的 agent 名。
 * 查找不到返回 {ok:false,error}（不改文件）；写入只并 goal/goalState 两个键，
 * 解析失败不写回（与头像/routing 同纪律），原子写。
 * @returns {{ok:boolean, taskId?:string, error?:string}}
 */

/** 目标化派活时插在 prompt 最前面的段落（B）。 */

/** 续跑扫写的可观测状态：每次扫写（含异常）都记到内存 + 追加 .hub/resume-sweep.log。
 *  宿主是打包应用看不到 console，用户「没自动续跑」必须能查到真实跳过原因。 */

/**
 * 全部可见会话的 preset 体检：目标 preset（默认 cordis）与其它各一栏。
 * preset 读 list 行的 agentPreset 投影（源码实证 observation.projections.values.agentPreset）；
 * live = 本进程内已激活过 agent（冷会话 false，但历史上可能已开跑过——能否切以
 * 实际 select 的 agent-preset/locked 为准，已开跑的只能重建）。
 */
export async function presetAudit(ctx, target = 'cordis') {
  const controller = ctx.get('sessionController');
  const registry = ctx.get('workspaceRegistry');
  const agents = ctx.get('agents');
  if (!controller || typeof controller.list !== 'function') {
    return { ok: false, error: 'sessionController 不可用' };
  }
  let rows = [];
  try { rows = await controller.list(new AbortController().signal); } catch (error) {
    return { ok: false, error: `list failed: ${String(error && error.message)}` };
  }
  if (!Array.isArray(rows)) {
    // 不同调用路径 list 可能返回分页对象：能取 items/sessions 就取，否则把真实形状带回去
    const shape = rows && typeof rows === 'object'
      ? `object keys=[${Object.keys(rows).slice(0, 10).join(',')}]` : String(typeof rows);
    if (rows && Array.isArray(rows.items)) rows = rows.items;
    else if (rows && Array.isArray(rows.sessions)) rows = rows.sessions;
    else return { ok: false, error: `unexpected list shape: ${shape}` };
  }
  const archived = new Set(
    registry && Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.map(String) : [],
  );
  const matched = [];
  const others = [];
  for (const row of rows) {
    if (!row || !row.sessionId) continue;
    const id = String(row.sessionId);
    if (archived.has(id)) continue;
    const values = (row.projections && row.projections.values) || {};
    const title = typeof values.title === 'string' && values.title
      ? values.title : `（未命名 ${id.slice(0, 8)}…）`;
    const preset = typeof values.agentPreset === 'string' && values.agentPreset
      ? values.agentPreset : '(unknown)';
    const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined;
    const entry = { id, title, preset, live: Boolean(agent), subagent: values.subagent === true };
    if (preset === target) matched.push(entry); else others.push(entry);
  }
  return { ok: true, target, matchedCount: matched.length, othersCount: others.length, matched, others };
}

/**
 * 启动后续跑扫描：list() 取全部可见会话 → 跳过归档/运行中/标题无「 · 」→
 * observeSession 读事件尾判定未完成 → 满足护栏（账本 24h、单次启动 ≤3 个）后投递续跑 prompt。
 */

/**
 * 新项目管理者配备检查（2026-11-07 用户令「下次建新项目一定要有 Yat2，写成 hook」）。
 *
 * 背景：建「跨机同步」项目时只建了成员线、漏了 Yat2 管理者线 → 该项目群聊无管理者、
 * 跨项目派活被护栏挡。机制化强制：开机 40s 对账 + 每 10min 巡一轮（幂等，同一项目
 * 每次插件生命周期最多提醒一次——warnedProjects 记账，重启 DSH 后如仍缺会再提一次）。
 *
 * 判据（两者皆无才算缺，避免"先登记头像后建线"的正常时序误报）：
 *   ① .hub/projects/<项目>/tasks.json 的 avatars 无 "Yat2"
 *   ② 会话列表无活跃标题「<项目> · Yat2」
 * 缺 → 向该**项目最近一条成员会话**注入强提醒（无成员会话则只记日志——无处可注入）。
 * 自动补建（taskline_create 一条龙）评估结论：建线含身份任务书等上下文副作用，默认
 * 不做，config.autoCreateProjectManager 开关位预留（当前读了也不启用）。
 */
const warnedProjects = new Set();

export async function sweepProjectManagers(ctx) {
  const controller = ctx.get('sessionController');
  // 与 hostRoot 同源逻辑：本插件仓库根下的 .hub/projects（PLUGIN_REPO_ROOT 见其注释）
  const projectsDir = join(PLUGIN_REPO_ROOT, '.hub', 'projects');
  let dirs = [];
  try { dirs = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return; }
  if (!dirs.length) return;

  // 会话标题快照（一次拿全，逐项目查「<项目> · Yat2」）
  let sessions = [];
  try {
    const list = await controller.list({}, AbortSignal.timeout(10000));
    sessions = list?.sessions || list?.value?.sessions || [];
  } catch (error) {
    console.warn('[hub] manager sweep: session list failed:', String((error && error.message) || error));
    return;
  }

  for (const project of dirs) {
    if (warnedProjects.has(project)) continue;
    const hasYat2Session = sessions.some((s) => String(s.title || '') === `${project} · Yat2`);
    if (hasYat2Session) { warnedProjects.add(project); continue; }
    let hasYat2Avatar = false;
    try {
      const tj = JSON.parse(readFileSync(join(projectsDir, project, 'tasks.json'), 'utf8'));
      hasYat2Avatar = Boolean(tj && tj.avatars && tj.avatars.Yat2);
    } catch { hasYat2Avatar = false; }
    if (hasYat2Avatar) continue;                          // 头像已登记=在建流程中，不打扰

    warnedProjects.add(project);                          // 无论能否注入都记账，避免每 10min 重复
    const member = sessions.find((s) => {
      const t = String(s.title || '');
      return t.startsWith(`${project} · `) && t !== `${project} · Yat2`;
    });
    const text =
      `【⚠ 新项目缺管理者 · 机制提醒（2026-11-07 用户令 hook）】\n` +
      `项目「${project}」没有管理者线（无「${project} · Yat2」会话，tasks.json avatars 也无 Yat2）。\n` +
      `后果：该项目群聊无管理者、跨项目派活会被护栏挡。\n` +
      `请立即补建：taskline_create {title:"${project} · Yat2", avatar:"🦉", text:<身份任务书：成员表/任务现状/上下文指引>}，` +
      `并在 .hub/projects/${project}/tasks.json 的 avatars 登记 "Yat2": "🦉"。` +
      `以后新建项目一律两条线一次建齐（Yat2 + 成员线），缺一不算建成。`;
    if (member && member.id) {
      try {
        await controller.prompt({
          requestId: `hub-mgr-warn-${project}-${Date.now()}`,
          sessionId: member.id,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, AbortSignal.timeout(15000));
        console.warn(`[hub] manager sweep: 项目「${project}」缺 Yat2 线，已注入提醒到「${member.title}」`);
      } catch (error) {
        console.warn(`[hub] manager sweep: 注入失败(${project}):`, String((error && error.message) || error));
      }
    } else {
      console.warn(`[hub] manager sweep: 项目「${project}」缺 Yat2 线（无成员会话可注入，仅记录）`);
    }
  }
}

export function apply(ctx, config = {}) {
  const injected = new WeakSet();

  /** 取会话标题（apply 级：分诊与工具两处都用；用 ctx 而不是 inject 回调里的 hub）。 */
  const titleOfSession = (session) => {
    try {
      const titles = ctx.get('sessionTitle');
      const snap = titles && typeof titles.get === 'function' ? titles.get(session) : undefined;
      return String((snap && snap.title) || '');
    } catch (error) {
      return '';
    }
  };
  // 2026-11-10 拆包：分诊 29 个函数已搬进 dsh-queue-triage，这里只留装配。
  // 这 9 个状态必须**按引用**交给它 —— hub 自己的事件处理器也在读写同一份。
  const defaultPreset = String(config.defaultPreset || 'cordis');
  // 2026-11-10（改点 4）：分诊分身专用的轻量 preset（空 = 跟主线同一个）。
  // 分诊只做「看上下文 → 三选一 → 投递」，用主线的 max reasoning 是浪费：
  // 实测单步 20–80 s，端到端 median 38 s / p90 141 s / max 307 s。
  const triagePresetOverride = String(config.triagePreset || '');
  // 2026-11-11 用户令「goal 别老是自己暂停」：重启后把被 disarm 的目标自动重新武装。
  // DSH 每次 session resume/fork 都会 goals.disarm(agent)（设计上要「人来点继续」），
  // 而我们重启频繁 → 各会话目标反复变「等待继续」→ 进度停住。这里在启动续跑前 rearm。
  // 只动 active+disarmed；paused/blocked/complete 一律不碰（见 hub-core/resume.js）。
  // 关掉：profile 里配 config.autoRearmGoals: false。
  const autoRearmGoals = config.autoRearmGoals !== false;
  // 2026-11-11 用户令「轮次用满 13/13 就自动删掉重建 goal」：轮次打满时核心驱动会
  // goals.block({code:'round-limit'}) 把目标停住，update_goal resume 只会报 exhausted。
  // hub-core/goal-rebuild.js 检测到就 clear 旧 goal + create 同 objective 的新 goal。
  // 关掉：profile 里配 config.autoRebuildExhaustedGoals: false。
  const autoRebuildGoals = config.autoRebuildExhaustedGoals !== false;
  // 同一条链最多连续重建几次（默认 3；profile 里可配 config.goalRebuildMaxChain）。
  const goalRebuildMaxChain = Number(config.goalRebuildMaxChain) || undefined;
  const liveRunning = new Map();   // sessionId -> boolean
  const dispatchLedger = new Map(); // sessionId -> { pending, lastAt }
  const queueTriageEnabled = QUEUE_TRIAGE_ENABLED;
  const queueTriageRegistry = new Map();  // triageSessionId -> entry
  const queueTriageReminders = new Map(); // triageSessionId -> 已提醒次数
  const queueTriageArchiving = new Set(); // 正在归档（防重入）
  const queueTriageDone = new Set();      // 已归档的分诊会话（让"分身不能停"守卫不再管它）
  const triageSweepTimers = new Map(); // key -> timer
  const queueTriage = createQueueTriage({
    hub: ctx,
    ctx,
    state: {
      defaultPreset,
      triagePresetOverride,
      liveRunning,
      dispatchLedger,
      queueTriageEnabled,
      queueTriageRegistry,
      queueTriageReminders,
      queueTriageArchiving,
      queueTriageDone,
      triageSweepTimers,
    },
    deps: {
      messagePartsOf,
      attachmentsRootOf,
      triageDecisionFromEvents,
      triageSteeredTo,
      titleOfSession,
      buildQueueTriagePrompt,
      summarizeInheritedContext,
    },
  });
  const {
    isSessionRunning,
    lastEventRunning,
    pendingDispatchesOf,
    recordDispatch,
    queueTriageTitleFor,
    spawnQueueTriage,
    finalizeQueueTriage,
    notifyQueueTriageCaller,
    fallbackDeliverToTarget,
    memberStatusPanel,
    scanPendingUserMessages,
    routingWatermarkPath,
    readWatermark,
    writeWatermark,
    clearTriageSweep,
    scheduleTriageSweep,
    readTriageEvents,
    inspectTriageSession,
    finishTriage,
    recheckQueueTriage,
    triageLog,
    isRunningFast,
    sessionTitleById,
    pullFromQueueAndTriage,
    steerMainDirectly,
    pullFromQueueThenSteer,
    appendToInFlightTriage,
    handleHumanMessage,
    notifyCloneParent,
  } = queueTriage;

  const archiveTestSessions = config.archiveTestSessions !== false;
  const resumeInterrupted = config.resumeInterrupted !== false;
  const recycleSubagents = config.recycleSubagents === true;
  const enforceRouting = config.enforceRouting !== false;
  // 分身收尾守卫（2026-11-05 用户令「分身不能停」）：默认开；profile 里给
  // config.enforceCloneHandoff: false 可关掉。
  const enforceCloneHandoff = config.enforceCloneHandoff !== false;
  const restrictManagerTools = config.restrictManagerTools !== false;
  const autoPresetOnBoot = config.autoPresetOnBoot !== false;
  // 手机端桥（DSH Sync App）。关掉：profile 的 cordis.patch.yml 里给本条 config.syncBridge=false。
  const syncBridgeEnabled = config.syncBridge !== false;

  // —— 派活纪律机制化（2026-10-26 用户令「不靠管理者自觉」）——
  // ① 实时运行状态：官方事件 api-session/status(changedId, running) 维护一份进程内快照；
  // ② 投递台账：本进程给某会话 queue 过几条、还没看到它回合结束 → 用作"排队位次"的诚实估计。
  try {
    ctx.on('api-session/status', (changedId, running) => {
      try {
        const key = String(changedId || '');
        if (!key) return;
        liveRunning.set(key, Boolean(running));
        // 目标开新一轮 → 说明它消化了队列里的一条
        if (running) {
          const entry = dispatchLedger.get(key);
          if (entry && entry.pending > 0) {
            entry.pending -= 1;
            entry.lastAt = Date.now();
          }
        }
      } catch (error) { /* ignore */ }
    });
  } catch (error) { /* 老 Host 没这个事件就退化为 list() 查询 */ }





  // —— queue 分诊（2026-11-08 用户令）——
  // 目标在跑时不再排队干等：立刻开一条分诊分身，由它判定「steer 进主线」还是「分身自己做」，
  // 交接后自动归档回收。机制说明见模块顶部 QUEUE_TRIAGE_* 注释。


/* 图片转发相关的纯函数（attachmentsRootOf / attachmentPathOf / messagePartsOf）在模块顶部定义，
 * 说明见那里；这里只留下调用点。 */

  /* summarizeInheritedContext / buildQueueTriagePrompt 已移到模块作用域（可单测），见该定义处。 */






  ctx.on('agent/pre-step', async ({ agent, signal, step }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || (signal && signal.aborted)) return decision;
    try {
      const title = titleOf(ctx, agent);
      const at = title.lastIndexOf(' · ');
      if (at <= 0) return decision;
      const project = title.slice(0, at).trim();
      const role = title.slice(at + 3).trim();
      if (!project || !role) return decision;

      const isManager = role === 'Yat2';
      // 管理者：每轮第一步注入协议（协议会演进，旧会话也要吃到新规则）；
      // 普通成员：每个 agent 只注入一次。
      // 2026-10-26 修 Yat2 报的「面板时有时无」：**steer 插队不产生新 step 1**
      // （外部消息在 step 边界插进当前轮），所以"仅 step===1"会漏。判据改为
      // 「step 1 或 本拍带新进消息（decision.messages 里有 user 角色）」。
      const hasIncoming = Array.isArray(decision.messages)
        && decision.messages.some((message) => message && message.role === 'user');
      const isFirstStep = step === undefined || step === 1;
      if (isManager) {
        if (!isFirstStep && !hasIncoming) return decision;
      } else {
        if (injected.has(agent)) return decision;
        injected.add(agent);
      }

      // 协议只在 step 1 注入（避免每拍重复 ~8k 字）；面板按需单独注入
      const text = isManager ? (isFirstStep ? managerProtocol(project) : '') : memberProtocol(project, role);
      const messages = [...decision.messages];
      if (text) messages.push(noticeMessage(text));
      // 管理者每次「有新输入」都附一张实时成员状态面板（2026-10-26 用户令：派活前查状态要机制化）。
      // 面板必须作为**独立消息**注入——拼在 managerProtocol（约 8k 字）末尾时会被丢。
      if (isManager && (isFirstStep || hasIncoming)) {
        try {
          const rows = await memberStatusPanel(project);
          if (rows) {
            messages.push(noticeMessage(
              `【成员状态 · 每轮自动注入】派活前先看这张表（🔴 运行中=它要跑完当前轮才会处理新派活，此时派活是排队）：\n${rows}`,
              'member-status',
            ));
          } else {
            messages.push(noticeMessage(
              '【成员状态 · 每轮自动注入】本项目暂无可判定的成员会话（无 memberSessions、也无标题匹配的活会话）——派活前用 taskline_list 自查。',
              'member-status',
            ));
          }
        } catch (error) {
          console.warn(`[hub-desktop-ui] member status panel skipped: ${String(error)}`);
          messages.push(noticeMessage('【成员状态】面板生成失败（内部错误），派活前请用 taskline_list 自查。', 'member-status'));
        }
      }
      return { kind: 'enter', messages };
    } catch (error) {
      console.warn(`[hub-desktop-ui] manager protocol skipped: ${String(error)}`);
      return decision;
    }
  }, { prepend: true });

  // 测试会话收尾自动归档：DSH 没有删除会话的 API，归档＝从侧栏移除（可恢复）。
  // 只按标题判定，避免误伤正常会话；关掉用 config archiveTestSessions: false。
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!archiveTestSessions) return;
    try {
      const registry = ctx.get('workspaceRegistry');
      if (!registry || typeof registry.archiveSession !== 'function') return;
      const title = titleOf(ctx, agent);
      // ① 测试会话
      if (title && TEST_TITLE.test(title)) {
        await registry.archiveSession(agent.id, { stopActivity: false });
        console.log(`[hub-desktop-ui] archived test session: ${title}`);
        // 归档动作顺手触发清理（2026-10-24 用户令：不用定时器）
        await pruneArchivedSessions(ctx).catch(() => {});
        return;
      }
      // ② 分身（subagent 子会话）：跑完一轮即回收，参考 Hermes 的 reap
      if (!recycleSubagents) return;
      const sessions = ctx.get('sessions');
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(agent.id) : undefined;
      const header = session && session.header;
      const isFork = Boolean(header && (header.origin === 'subagent' || header.parentSession));
      if (!isFork) return;
      await registry.archiveSession(agent.id, { stopActivity: false });
      console.log(`[hub-desktop-ui] recycled subagent session: ${title || agent.id}`);
      // 归档动作顺手触发清理（2026-10-24 用户令：不用定时器）
      await pruneArchivedSessions(ctx).catch(() => {});
    } catch (error) {
      console.warn(`[hub-desktop-ui] archive test session failed: ${String(error)}`);
    }
  });

  // 禁止临时会话（2026-10-24 事件化）：turn 一结束、标题已定型，**立即**对该会话做
  // 命名裁决（归位/隔离），不依赖巡查器——白名单与"事件流读不出不动"保护都在函数内。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!agent || agent.id === undefined) return;
    enforceSessionNamingOne(ctx, agent.id, readRegisteredSessionIds(hostRoot(ctx)))
      .catch(() => { /* 裁决失败不影响收尾 */ });
  });


  // 硬拦截：管理者想结束回合时，若最近一条用户消息还没写进 routing.json，
  // 就往 next-step 塞一条提醒逼它继续（loop 里 turn-stopping 之后只有 inbox 非空才不会 break）。
  // 2026-10-22：只统计「水位之后」的新消息——历史积压不再每轮重复报「20 条」。
  // 水位文件：.hub/projects/<项目>/.routing-watermark（已扫描过的最大事件序号）。
  const routingReminders = new Set();
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!enforceRouting) return;
    try {
      const title = titleOf(ctx, agent);
      // 只有管理者（Yat2 / Hermes）做归线；普通成员会话既不归、也不该被提醒
      if (!/ · (Yat2|Hermes)$/.test(String(title || ''))) return;
      const project = title && title.includes(' · ') ? title.slice(0, title.lastIndexOf(' · ')).trim() : '';
      if (!project) return;
      const sessions = ctx.get('sessions');
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(agent.id) : undefined;
      const events = await collectEvents(ctx, session, agent.id);
      // 2026-10-26 自愈防御：enforcement 读前先对账（磁盘被清空的非 _none 条目自动补回）
      guardRoutingFile(project, hostRoot(ctx));
      const routing = readRoutingFile(project, hostRoot(ctx));
      const watermark = readWatermark(project);
      const { pending, maxId } = scanPendingUserMessages(events, routing, watermark);
      // 首次运行（无水位）：当前最大 id 直接立为水位，历史消息不追责
      if (watermark === null) {
        if (maxId > 0) writeWatermark(project, maxId);
        console.log(`[hub-desktop-ui] routing watermark initialized at ${maxId} (${project})`);
        return;
      }
      if (pending.length === 0) {
        // 没有新消息：把水位推进到当前最大 id，避免重复扫描
        if (maxId > watermark) writeWatermark(project, maxId);
        return;
      }
      const key = `${agent.id}:${pending.join(',')}`;
      if (routingReminders.has(key)) return;
      routingReminders.add(key);
      if (!agent || !agent.inbox || typeof agent.inbox.append !== 'function') return;
      agent.inbox.append('next-step', noticeMessage(
        `【还有 ${pending.length} 条没归线】这些用户消息的 eventId 还没写进 .hub/projects/${project}/routing.json：\n`
        + `${pending.join('、')}\n`
        + '现在做三件事：①逐条判断它属于哪条任务线（或新建一条）；'
        + '②把这些键合并进 routing.json（保留已有条目）；③再结束回合。不要只补最后一条。',
      ));
      console.log(`[hub-desktop-ui] routing reminder for ${pending.length} new message(s) after watermark ${watermark} (${project})`);
    } catch (error) {
      console.warn(`[hub-desktop-ui] routing enforcement failed: ${String(error)}`);
    }
  });

  // queue 分诊分身的收尾（2026-11-08 用户令「完成之后记得自动回收分身」）。
  // ⚠️ 实测坑（lab 2026-11-08，分身 5413c7a9）：`agent/turn-stopping` 时刻实时投影**还没有本回合的
  //    tool/call**（该分身 assistant 文本数为 0，结论只存在于 agent_message 的 arguments 里）→
  //    只读投影必然判「无结论」并误走兜底直送。所以判定一律：
  //    ① 合并读「实时投影 + sessionController.inspect 持久记录」；
  //    ② 同时扫**三个会话**——分诊分身 / 目标主线 / 派活方（结论常被 agent_message 发到后两者）；
  //    ③ 没结论不立即兜底，先提醒 + 定时重扫（8s / 20s / 40s），让投影 flush 完再看。
  //    只有重扫用尽、且分身确实没动过任何工具，才把原消息直送主线（防丢，同时避免同一件事做两遍）。







  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!agent || agent.id === undefined) return;
    const key = String(agent.id);
    if (!queueTriageRegistry.has(key)) return;
    try {
      await recheckQueueTriage(key, 1, agent);
    } catch (error) {
      console.warn(`[hub-desktop-ui] queue triage guard failed: ${String(error)}`);
    }
  });

  // —— 用户手动发消息给**运行中**的线：不再排队，改开分诊分身（2026-11-08 用户补充令）——
  // 病因：在会话自己的输入框打字走 DSH 原生投递，插件拦不到，消息进 next-turn 队列干等。
  // 实测两条弯路（都不是"没生效"，而是钩子选错）：
  //   ① 只挂 session/event 记录 → 比 agent/pre-step 晚 10ms，拦截时 pending 恒空；
  //   ② 改用 agent/pre-step 摘消息 → 队列消息**根本不进 pre-step 的 messages**（日志一片 PRE no-messages）。
  // 正解：用 sessionController.updateQueue({itemId, action:{kind:'remove'}}) 把这条从队列里**摘掉**，
  //       再开分诊分身。摘不掉就不动它（宁可照旧排队，绝不吞消息）。

  /** 同一会话最近起分诊的时间戳（熔断用，防自激套娃）。 */








  // 主来源：消息进入 live inbox 的时刻（= 用户按发送那一刻），此时 agent 状态最准。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      if (!agent || agent.id === undefined || !message) return;
      handleHumanMessage(String(agent.id), message, 'inbox');
    } catch (error) {
      triageLog(`INBOX-ERR ${String(error)}`);
    }
  });

  // 兜底来源：持久日志的 user/message 追加（有些投递不走 live inbox）。
  ctx.on('session/event', (session, event) => {
    try {
      if (!queueTriageEnabled) return;
      if (!event || event.type !== 'user/message') return;
      handleHumanMessage(String((session && session.id) || ''), event.data || {}, 'log');
    } catch (error) {
      triageLog(`REC-ERR ${String(error)}`);
    }
  });


  // 分身收尾守卫（2026-11-05 用户令「分身不能停」）：分身（标题带｜）回合结束时
  // 只有两种合法状态——①任务没做完 → 继续做；②做完 → 已给本体留「交接摘要」。
  // - 没交接 → 往 next-step 塞提醒逼它继续/交接（每会话最多 2 次，防死循环）；
  // - 超限还没交接 → 直接把「你的分身停在半路」投给本体，让它续派或回收；
  // - 已交接 → 通知本体立刻 taskline_archive 回收（每个分身只通知一次）。
  // 关掉：profile 里 config.enforceCloneHandoff: false。
  const cloneGuardReminders = new Map();  // sessionId -> 已提醒次数
  const cloneGuardNotified = new Set();   // `${sessionId}:${kind}` 去重
  const CLONE_GUARD_MAX_REMINDERS = 2;
  // 2026-11-11 修：`subagentParentCache` 原本在本文件声明，2026-11-10 拆包时随代码搬进了
  // `dsh-clone-handoff`（那边只是搬运残留、从未被引用），而本文件的 `/hub/session-subagent`
  // 仍在用它（下方 L3434 一带）——于是那里一直是
  //   `ReferenceError: subagentParentCache is not defined`
  // 被外层 try/catch 静默吞掉，表现为「子会话 → 父会话」映射恒空、子会话纳不进侧栏归父。
  // 缓存是各模块自己的事，这里补回一份（不跨包共享）。
  const subagentParentCache = { map: new Map(), at: 0 };
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!enforceCloneHandoff || !agent || agent.id === undefined) return;
    // queue 分诊分身由上面那条监听器接管（自动归档，不惊动本体）
    if (queueTriageRegistry.has(String(agent.id)) || queueTriageDone.has(String(agent.id))) return;
    try {
      const title = titleOf(ctx, agent);
      // 只管分身：标题形如「<项目> · <父名>｜<任务短语>」
      if (!title || !title.includes('｜')) return;
      const project = projectOfSessionTitle(title);
      const memberName = agentNameOfTitle(title);
      if (!project || !memberName.includes('｜')) return;
      const parentName = memberName.slice(0, memberName.indexOf('｜')).trim();
      if (!parentName) return;
      const sessions = ctx.get('sessions');
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(agent.id) : undefined;
      if (!session) return;
      const events = await collectEvents(ctx, session, agent.id);
      const { handedOff } = cloneHandoffEvidence(events);

      if (handedOff) {
        cloneGuardReminders.delete(agent.id);
        const key = `${agent.id}:handoff`;
        if (cloneGuardNotified.has(key)) return;
        cloneGuardNotified.add(key);
        const sent = await notifyCloneParent(project, parentName,
          `【分身已交接 · 请立刻回收】你的分身「${title}」已经给出「交接摘要」。\n`
          + `现在做一件事：\`taskline_archive {session: "${agent.id}"}\` 回收它（归档会自动落交接档案），`
          + '不要留在侧栏（2026-11-05 用户令：分身不能停在那儿）。',
        );
        if (sent) console.log(`[hub-desktop-ui] clone handed off, parent asked to archive: ${title}`);
        return;
      }

      const count = cloneGuardReminders.get(agent.id) || 0;
      if (count >= CLONE_GUARD_MAX_REMINDERS) {
        const key = `${agent.id}:stuck`;
        if (cloneGuardNotified.has(key)) return;
        cloneGuardNotified.add(key);
        const sent = await notifyCloneParent(project, parentName,
          `【分身停在半路】你的分身「${title}」回合结束但没有「交接摘要」（已机械提醒 ${count} 次）。\n`
          + '现在二选一，不许放着：① `taskline_prompt` 续派它把活做完；② `taskline_archive` 回收并留档。'
          + '（2026-11-05 用户令：分身不能停在那儿）',
        );
        if (sent) console.log(`[hub-desktop-ui] clone stuck, parent notified: ${title}`);
        return;
      }

      cloneGuardReminders.set(agent.id, count + 1);
      if (!agent.inbox || typeof agent.inbox.append !== 'function') return;
      agent.inbox.append('next-step', noticeMessage(
        `【分身不能停 · 收尾检查】你是分身「${title}」，回合结束时还没有给本体留「交接摘要」。现在二选一，不许就这么停着：\n`
        + '① **任务没做完 → 继续做**，做到交付（不要以「等用户」「先汇报一下」收尾）；\n'
        + `② **做完了 → 立刻 send_message 给本体「${project} · ${parentName}」**，发一条含「交接摘要」的回报`
        + '（①做了什么 ②关键发现或坑 ③产物路径，**每项一行、总长 ≤5 行 / ≤400 字**——用户令 2026-11-09：任务线只放进度摘要），并明确请它 `taskline_archive` 回收你。\n'
        + '禁止：没做完就结束、做完不交接、把「等用户」当收尾。（2026-11-05 用户令；插件机械拦截）',
        'clone-guard',
      ));
      console.log(`[hub-desktop-ui] clone guard reminder ${count + 1}/${CLONE_GUARD_MAX_REMINDERS}: ${title}`);
    } catch (error) {
      console.warn(`[hub-desktop-ui] clone handoff guard failed: ${String(error)}`);
    }
  });

  // 派活 prompt 自动归线为 _none：管理者的 taskline_prompt 文本固定以【任务开头，
  // 这类消息是过程性派活——不进任务线、也不该反复报「待归线」。
  // 幂等：eventId 已在 routing.json 里就跳过。
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'user/message') return;
      const data = event.data || {};
      // 与待归线判定同口径：source.kind 为空或 'user' 都算用户消息
      if (data.source && data.source.kind && data.source.kind !== 'user') return;
      const content = Array.isArray(data.content) ? data.content : [];
      const text = content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('\n');
      // 过程性消息前缀白名单：派活【任务、成员回报【汇报 /【回报、求助【求助、返工【返工——
      // 这些都不是「用户自己的发言」，一律自动 _none（不进任务线、不产生待归线）。
      // 正常用户消息不会用这种方括号前缀开头，不会误伤。
      if (!AUTO_NONE_PREFIXES.some((prefix) => text.startsWith(prefix))) return;
      const id = event.id !== undefined ? event.id : (event.key !== undefined ? event.key : event.seq);
      if (id === undefined || id === null) return;
      const title = titleOf(ctx, session);
      const at = title.lastIndexOf(' · ');
      if (at <= 0) return;
      const project = title.slice(0, at).trim();
      if (!project) return;
      // 与头像写入同一条纪律：读不干净就放弃写回，绝不拿空对象覆盖 routing.json。
      const routingPath = boardPath(project, hostRoot(ctx));
      if (!routingPath) return;
      const routingFile = join(dirname(routingPath), 'routing.json');
      // 2026-10-26 自愈防御：写 _none 前先对账（防"重写文件"型写入方冲掉手工条目）
      guardRoutingFile(project, hostRoot(hub));
      const read = readJsonForWrite(routingFile);
      if (!read.ok) {
        console.warn(`[hub-desktop-ui] routing.json 读取失败，跳过自动 _none（避免覆盖）：${String(read.error)}`);
        return;
      }
      const routing = read.value;
      if (routing[String(id)]) return;
      routing[String(id)] = '_none';
      writeJsonAtomic(routingFile, routing);
      console.log(`[hub-desktop-ui] dispatch prompt ${id} auto-routed _none (${project})`);
    } catch (error) {
      console.warn(`[hub-desktop-ui] auto-route dispatch prompt failed: ${String(error)}`);
    }
  });

  // 启动 12s / 90s / 240s 各续跑扫一次被重启掐断的会话（DSH 重启后被中断的会话不会自己接着跑）。
  // **多拍是必要的**（2026-10-21 漏网实证：cb333399/89756e92 在 12s 那拍是 running——
  // 若其尾部其实是 interrupted，单次扫写会永远错过；晚几拍它闲下来就能补上）。
  // 第一拍必须排在测试归档扫（25s）之前：测试标题的中断会话要先救活。
  // 重复防护：ledger 24h（持久）保证同一会话不会被多拍重复续跑。
  if (resumeInterrupted) {
    for (const delay of [12000, 90000, 240000]) {
      const timer = setTimeout(() => {
        resumeInterruptedSessions(ctx, {
          rearmGoals: autoRearmGoals,
          rebuildGoals: autoRebuildGoals,
          rebuildMaxChain: goalRebuildMaxChain,
        })
          .catch((error) => {
            console.warn('[hub-desktop-ui] resume sweep crashed:', String(error));
            recordResumeSweep(ctx, { resumed: [], skipped: [], crashed: String(error && error.message) });
          });
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  // 启动 25s 后补扫一次遗留的测试会话（用户已经跑完的旧会话不会被自动归档；
  // 排在续跑扫之后，被续跑救活的测试会话本轮不会被误归档——下轮若标题仍是测试才归档）
  if (archiveTestSessions) {
    const timer = setTimeout(() => { sweepTestSessions(ctx); }, 25000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // 新项目缺 Yat2 管理者线的对账/巡检（2026-11-07 用户令「写成 hook」）：
  // 开机 40s 一次 + 每 10min 一轮；幂等（warnedProjects 记账，见 sweepProjectManagers）。
  // 关闭用 config.enforceProjectManager: false；自动补建开关 autoCreateProjectManager
  // 预留未启用（评估：建线含身份任务书副作用，默认只提醒不代建）。
  if (config.enforceProjectManager !== false) {
    ctx.effect(() => {
      const run = () => {
        sweepProjectManagers(ctx).catch((error) => {
          console.warn('[hub] manager sweep crashed:', String((error && error.message) || error));
        });
      };
      const t = setTimeout(run, 40000);
      const iv = setInterval(run, 10 * 60 * 1000);
      if (typeof t.unref === 'function') t.unref();
      if (typeof iv.unref === 'function') iv.unref();
      return () => { clearTimeout(t); clearInterval(iv); };
    });
  }

  // 禁止临时会话（2026-10-24 用户令）：无「项目 · 」归属的会话自动归位/归档。
  // 开机 30s 跑一次 + 每 5 分钟巡一轮（幂等：已归位/已归档的自动跳过）。
  // ⚠️ 定时器必须挂在 ctx.effect 上随插件卸载清除——热重载（bundle toggle）不会杀
  // 裸 setInterval，旧版激进规则会变僵尸继续跑（2026-10-24 实证：restore 的 29 个
  // 会话被旧 timer 在 5 分钟内重新归档，archived 196→223）。
  ctx.effect(() => {
    // 2026-10-24 事件化改造（用户令「少用巡查器」）：无归属命名裁决平时由
    // agent/turn-stopping 事件逐会话即时执行（见 enforceSessionNamingOne 监听）；
    // 这里只保留**开机一次性对账**（补漏：事件挂载前已存在的漏网会话），无周期巡查。
    const t1 = setTimeout(() => {
      sweepUntitledSessions(ctx).catch((error) => {
        console.warn('[hub] untitled sweep crashed:', String((error && error.message) || error));
      });
    }, 30000);
    if (typeof t1.unref === 'function') t1.unref();
    // 开机对账：已有重名活跃会话改名为「（旧壳 MM-DD）」（2026-10-26 用户令，只改名不归档）
    const t2 = setTimeout(() => {
      dedupeActiveTitles(ctx).catch((error) => {
        console.warn('[hub] dedupe titles crashed:', String((error && error.message) || error));
      });
    }, 35000);

    // 2026-11-10：清理 `.hub/avatars.json` 里的孤儿分身键。
    // 分身以非归档方式消失（会话被强杀 / 磁盘目录没了）时，cleanCloneRegistry 清不到这张全局表，
    // 于是侧栏会永远挂着一条点不开、也归档不了的幽灵分身（用户报过「自测乙 / 权限自测 删不掉」）。
    // 用真实会话标题当白名单；拿不到标题就整段跳过，绝不空表清理。
    const t3 = setTimeout(() => {
      (async () => {
        const controller = ctx.get('sessionController');
        if (!controller || typeof controller.list !== 'function') return;
        let rows = await controller.list(new AbortController().signal);
        if (!Array.isArray(rows)) rows = (rows && (rows.items || rows.sessions)) || [];
        const titles = rows.map((row) => String((row && (row.displayTitle || row.title)) || '')).filter(Boolean);
        if (titles.length === 0) return;
        const result = purgeOrphanCloneAvatars(hostRoot(ctx), titles);
        if (result.ok && result.removed.length) {
          console.log(`[hub] 清理孤儿分身头像键 ${result.removed.length} 个：${result.removed.join(" / ")}`);
        }
      })().catch((error) => {
        console.warn('[hub] orphan avatar purge crashed:', String((error && error.message) || error));
      });
    }, 40000);
    if (typeof t3.unref === 'function') t3.unref();
    if (typeof t2.unref === 'function') t2.unref();
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  });

  // —— 新会话自动切默认 preset（Creator mode = cordis）——
  // f0c48bb 只兜住了 taskline_create；侧栏 + agent / 其它管理者 / 命令行建的会话不经过它。
  // 这里在 agent/created（第一个 turn 开始前，preset 未锁定）统一补一刀：
  // - 跳过 subagent（分身有自己的工具集 preset，强切会破坏 DSH 派生任务）；
  // - 已是该 preset 的不重复切（从 agent-preset/selected 事件记账）；
  // - 锁定（已开跑）只告警不崩——冷恢复的旧会话必然走到这里。
  const knownPreset = new Map();
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    try { knownPreset.set(String(sessionId), String(agentPreset)); } catch { /* ignore */ }
  });
  // —— 2026-10-29 用户令：因模型问题中断的对话，切换模型后自动续跑 ——
  // ① 记录错误：agent/error（step/turn 出错，含 provider 侧失败）与 api-session/error。
  ctx.on('agent/error', (payload) => {
    try {
      const agent = payload && payload.agent;
      const sid = agent && agent.session && agent.session.id ? String(agent.session.id) : '';
      const error = payload && payload.error;
      const message = String((error && (error.message || error.code)) || error || '');
      noteModelError(sid, message);
    } catch (error) { /* ignore */ }
  });
  ctx.on('api-session/error', (sessionId, message) => {
    try { noteModelError(sessionId, String(message || '')); } catch (error) { /* ignore */ }
  });
  // ② 兜底轮询（30s）：覆盖"用户从 DSH 原生模型选择器单独切模型"——那条路径不经过我们的
  //    /hub/switch-model，没有钩子可用。只在"账本内会话的当前模型已与出错模型不同"时才续跑，
  //    仍停在原模型的不动（否则等于立刻再错一次）。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (modelErrorLedger.size === 0) return;
      resumeModelErrorSessions(ctx).catch((error) => {
        console.warn('[hub-desktop-ui] model-error sweep failed:', String((error && error.message) || error));
      });
    }, 30 * 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  ctx.on('agent/created', async ({ agent }) => {
    // 活跃会话去重（2026-10-26 用户令「活跃的会话不能有重名」）：新会话出现后 8s 跑一次
    // （等标题落定），只改名不归档；失败静默，不影响 agent 创建。
    try {
      const createdId = agent && agent.id !== undefined ? String(agent.id) : '';
      if (createdId) {
        setTimeout(() => {
          dedupeActiveTitles(ctx).catch((error) => {
            console.warn('[hub] dedupe titles failed:', String((error && error.message) || error));
          });
        }, 8000).unref?.();
      }
    } catch { /* 去重失败不影响主流程 */ }
  });

  ctx.on('agent/created', async ({ agent }) => {
    try {
      const id = agent && agent.id !== undefined ? String(agent.id) : '';
      if (!id || knownPreset.get(id) === defaultPreset) return;
      // subagent 会话（有 parentSession / origin=subagent）不接管
      const sessions0 = ctx.get('sessions');
      const live0 = sessions0 && typeof sessions0.get === 'function' ? sessions0.get(agent.id) : undefined;
      const header0 = live0 && live0.header;
      if (header0 && (header0.origin === 'subagent' || header0.parentSession)) return;
      const presets = ctx.get('agentPresets');
      if (!presets || typeof presets.select !== 'function') return;
      const committed = await presets.select(agent, defaultPreset);
      knownPreset.set(id, String(committed || defaultPreset));
      console.log(`[hub-desktop-ui] preset auto-switch: ${id} -> ${String(committed || defaultPreset)}`);
    } catch (error) {
      // agent-preset/locked = 该会话已开跑（多半是冷恢复），按协议只告警
      console.warn(`[hub-desktop-ui] preset auto-switch skipped: ${String((error && error.message) || error)}`);
    }
  });

  // /hub/* 三条路由都挂在 webServer 上。webServer 那一行要等 webStartup（cmdlineArgs）
  // 才激活（见 @deepseek-ai/dsh-web-app 的 cordis.patch.yml），而本插件在 profile 的
  // bundles 里排在最后、apply 时 webServer 还不存在：旧写法在这里 ctx.get('webServer')
  // 拿到 undefined 就静默返回空 disposer，路由全部丢失，客户端「重启」点了没反应。
  // 用 ctx.inject 等服务就绪再注册（服务重建时会自动重跑）。
  ctx.inject(['webServer'], (hub) => {
    const server = hub.webServer;

    // POST /hub/restart：客户端「重启」按钮调用，安排一次桌面端重启。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/restart',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        const scheduled = scheduleDesktopRestart();
        res.writeHead(scheduled ? 202 : 503, { 'content-type': 'text/plain' });
        res.end(scheduled === 'debounced' ? 'debounced' : scheduled ? 'restarting' : 'restart unavailable');
      },
    }), 'hub-desktop-ui:/hub/restart');

    // GET /hub/client-modules：Client 侧 bundle 图（诊断主题/UI 插件到底有没有被加载）。
    // 2026-11-09 加：桌面端 index.html 需要客户端凭证（curl 拿不到），主题插件"装好却没生效"
    // 时无法从服务端确认到底加载没加载。这条只读路由走 /hub/* 放行通道，返回 boot graph。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/client-modules',
      handler: (req, res) => {
        try {
          const cm = hub.get('clientModules');
          const graph = cm && typeof cm.graph === 'function' ? cm.graph() : null;
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: Boolean(graph), graph }, null, 2));
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
        }
      },
    }), 'hub-desktop-ui:/hub/client-modules');

    // GET /hub/board?project=<name>：房间里的「公共看板」读 .hub/projects/<项目>/board.md。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/board',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const root = hostRoot(hub);
          const project = url.searchParams.get('project') || '';
          // POST = 确保黑板存在（建目录 + 写模板），GET = 只读
          const board = req.method === 'POST'
            ? ensureBoardFile(project, root)
            : readBoardFile(project, root);
          // 字数上限（2026-10-23 用户要求「设置上限，由 Yat2 整理维护」）：
          // 上限只作**度量与提示**，真正整理由 Yat2 按协议把历史搬到
          // .hub/projects/<项目>/board-archive-YYYYMM.md 后压缩 board.md。
          const chars = typeof board.text === 'string' ? board.text.length : 0;
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ...board,
            rootVia: HOST_ROOT_VIA,
            chars,
            limit: BOARD_MAX_CHARS,
            over: chars > BOARD_MAX_CHARS,
          }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
        }
      },
    }), 'hub-desktop-ui:/hub/board');

    // GET /hub/tasks?project=<名称>：读 Yat2 写的任务线元数据（标题 / 状态）。
    // 只回 tasks / avatars / routing 三个键——tasks.json 以后加任何顶层键（如成员注册表）
    // 都不泄漏给客户端，杜绝未知键被旧格式兼容分支误消费。
    // GET /hub/events（SSE，2026-10-26 借鉴 Reasonix 推送模型）：把 .hub 热数据变更
    // （tasks/routing/board/queue/avatars）实时推给客户端，替代群聊 5s 轮询。
    // host 侧 fs.watch(.hub, recursive) → 300ms 去抖 → 广播 {type:'hub-change',project,file}。
    // SSE 而非 WebSocket：单向推送用普通 HTTP 路由即可，不占 upgrade、无握手协议实现。
    {
      const sseClients = new Set();       // res 流
      const lastEvent = { at: 0, payload: '' };
      const broadcast = (payload) => {
        lastEvent.at = Date.now();
        lastEvent.payload = payload;
        const frame = `data: ${payload}\n\n`;
        for (const res of [...sseClients]) {
          try { res.write(frame); } catch { /* 断了等 close 清理 */ }
        }
      };
      let watchDisposer = null;
      hub.effect(() => {
        const root = hostRoot(hub);
        const hubDir = join(root, '.hub');
        const watched = new Map();       // path -> timer（300ms 去抖）
        const emit = (path) => {
          const norm = String(path).replace(/\\/g, '/');
          const m = /\/projects\/([^/]+)\/(tasks\.json|routing\.json|board\.md|queue\.json)$/.exec(norm);
          if (m) {
            broadcast(JSON.stringify({ type: 'hub-change', project: decodeURIComponent(m[1]), file: m[2] }));
            return;
          }
          if (/\/avatars\.json$/.test(norm)) broadcast(JSON.stringify({ type: 'avatars-change' }));
        };
        try {
          const watcher = watch(hubDir, { recursive: true }, (_event, filename) => {
            const name = String(filename || '');
            if (!/(tasks\.json|routing\.json|board\.md|queue\.json|avatars\.json)$/.test(name)) return;
            const key = name;
            const prev = watched.get(key);
            if (prev) clearTimeout(prev);
            watched.set(key, setTimeout(() => { watched.delete(key); emit(join(hubDir, name)); }, 300));
          });
          watchDisposer = () => { try { watcher.close(); } catch { /* ignore */ } };
        } catch (error) {
          console.warn(`[hub-desktop-ui] /hub/events fs.watch failed: ${String(error)}`);
        }
        return () => { if (watchDisposer) watchDisposer(); };
      });
      hub.effect(() => server.register({
        kind: 'exact',
        path: '/hub/events',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain' });
            res.end('GET only');
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write(`retry: 3000\n\n`);
          // 连接即补发最近一次事件（页面刷新不丢状态）
          if (Date.now() - lastEvent.at < 30000 && lastEvent.payload) {
            res.write(`data: ${lastEvent.payload}\n\n`);
          }
          sseClients.add(res);
          const heartbeat = setInterval(() => {
            try { res.write(': ping\n\n'); } catch { /* ignore */ }
          }, 25000);
          req.on('close', () => {
            clearInterval(heartbeat);
            sseClients.delete(res);
          });
        },
      }), 'hub-desktop-ui:/hub/events');

      // POST /hub/diag-request（2026-10-26）：让客户端立刻采一拍 skin-diag 上报。
      // 用途：验收"此刻 DOM 状态"——开机采样早于被测对象出现（例如刚建的分身 pill）。
      // 纯事件驱动：POST → 复用同一条 SSE 广播 {type:'diag-request'} → 客户端立即采样。
      hub.effect(() => server.register({
        kind: 'exact',
        path: '/hub/diag-request',
        handler: (req, res) => {
          try {
            broadcast(JSON.stringify({ type: 'diag-request', at: Date.now() }));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, clients: sseClients.size }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(error && error.message) }));
          }
        },
      }), 'hub-desktop-ui:/hub/diag-request');
    }

    // GET /hub/avatars：全局头像注册表（.hub/avatars.json）——**渲染唯一真源**。
    // 2026-10-26：侧栏芯片此前只查客户端硬编码 DEFAULT_AVATARS（2026-10-23 为性能删了
    // 运行时读取），导致写进全局表的头像（如 论文写手=🖋️）在侧栏不生效、退化成首字。
    // 客户端改为读这个接口（一次拉取 + 焦点刷新），DEFAULT_AVATARS 只作兜底。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/avatars',
      handler: (req, res) => {
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(readGlobalAvatars(hostRoot(hub))));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{}');
        }
      },
    }), 'hub-desktop-ui:/hub/avatars');

    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/tasks',
      handler: (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const root = hostRoot(hub);
          const project = url.searchParams.get('project') || '';
          const file = readTaskFile(project, root);
          const parsed = file && file.ok ? file.tasks : {};
          // 2026-10-26 自愈防御：/hub/tasks 读前对账（被清空的非 _none 条目自动补回 + 告警）
          guardRoutingFile(project, root);
          const routing = readRoutingFile(project, root);
          // 头像以**全局表覆盖**项目表（2026-10-22 唯一真源）：手工把项目表改错时
          // 渲染仍显示全局值；冲突键在 avatarConflicts 里标注（项目值 → 全局值）。
          const projectAvatars = parsed && parsed.avatars && typeof parsed.avatars === 'object'
            && !Array.isArray(parsed.avatars) ? { ...parsed.avatars } : {};
          const globalTable = readGlobalAvatars(root);
          const avatarConflicts = {};
          for (const [name, emoji] of Object.entries(globalTable)) {
            if (projectAvatars[name] !== undefined && projectAvatars[name] !== emoji) {
              avatarConflicts[name] = { project: projectAvatars[name], global: emoji };
            }
            projectAvatars[name] = emoji;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            tasks: parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null,
            avatars: projectAvatars,
            avatarConflicts,
            routing,
          }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, tasks: {}, error: String(error && error.message) }));
        }
      },
    }), 'hub-desktop-ui:/hub/tasks');

    // POST /hub/prompt：**会唤醒冷会话**的投递接口（2026-10-22）。
    // 客户端群聊/分列发言改走这里，不再用 sessions.retain().ready → prompt（那条不激活 agent，
    // 冷会话的消息只会入队没人跑，表现为「群聊发消息没反应」）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/prompt',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') { send(405, { ok: false, woke: false, error: 'POST only' }); return; }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const sessionId = String((payload && payload.sessionId) || '').trim();
          const text = String((payload && payload.text) || '');
          if (!sessionId) { send(200, { ok: false, woke: false, error: '缺少 sessionId' }); return; }
          if (!text.trim()) { send(200, { ok: false, woke: false, error: '消息为空' }); return; }
          const controller = hub.get('sessionController');
          if (!controller || typeof controller.prompt !== 'function') {
            send(200, { ok: false, woke: false, error: 'sessionController 不可用' });
            return;
          }
          const live = await ensureLiveSession(hub, controller, sessionId);
          if (!live.ok) { send(200, { ok: false, woke: false, error: live.error || '会话不可用' }); return; }
          // 2026-11-08 用户令：用户给**运行中**的线发消息也不再排队——先开分诊分身判定
          // （A 纠偏/补充→steer 进主线当前轮；B 独立任务→分身自己做），建不出来就照常排队。
          if (queueTriageEnabled) {
            const targetId = String(live.session.id);
            const targetTitle = sessionTitleById(targetId);
            // 注意：isRunningNow 在 tools 注入作用域，路由这里是 apply 作用域 → 只能用异步 isSessionRunning
            const running = (await isSessionRunning(targetId)) === true;
            if (running && targetTitle && !isQueueTriageTitle(targetTitle)) {
              const spawned = await spawnQueueTriage({
                targetId, targetTitle, callerTitle: targetTitle, callerSessionId: targetId, text,
              });
              if (spawned && spawned.ok) {
                send(200, {
                  ok: true, woke: Boolean(live.woke), agentReady: Boolean(live.agentReady),
                  sessionId: targetId, mode: 'triage',
                  triageSessionId: spawned.sessionId, triageTitle: spawned.title,
                });
                return;
              }
            }
          }
          await controller.prompt({
            requestId: `hub-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId: String(live.session.id),
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, new AbortController().signal);
          send(200, {
            ok: true,
            woke: Boolean(live.woke),
            agentReady: Boolean(live.agentReady),
            sessionId: String(live.session.id),
          });
        } catch (error) {
          send(200, { ok: false, woke: false, error: String((error && error.message) || error) });
        }
      },
    }), 'hub-desktop-ui:/hub/prompt');

    // GET /hub/routing-status?project=<名称>：归线水位（2026-10-22）。
    // 客户端头部「N 条待归线」也要按同一水位统计，否则历史积压会让它永远显示同一个数。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/routing-status',
      handler: (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const project = url.searchParams.get('project') || '';
          if (!project) { send(200, { ok: false, error: 'missing project' }); return; }
          const file = join(hostRoot(ctx), '.hub', 'projects', String(project).replace(/[\\/:*?"<>|]/g, '_'), '.routing-watermark');
          let watermark = 0;
          try {
            const n = Number(readFileSync(file, 'utf8').trim());
            if (Number.isFinite(n) && n > 0) watermark = n;
          } catch { /* 还没初始化 → 0，客户端据此不做历史计数 */ }
          send(200, { ok: true, watermark });
        } catch (error) {
          send(200, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }), 'hub-desktop-ui:/hub/routing-status');

    // GET /hub/resume-check?session=<id>：该会话是否处于「被重启打断、尚未续跑」状态（2026-10-22）。
    // 队列泵用它做闸门：有中断 → 排队消息保持 queued，等启动续跑扫描注入【续跑】、
    // 续跑轮跑完（尾部恢复 complete → interrupted=false）后才放行。判定与续跑扫描完全同源
    //（inspectEvents + interruptedReasonDetailed），不会两套口径。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/resume-check',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const sessionId = String(url.searchParams.get('session') || '').trim();
          if (!sessionId) { send(200, { ok: false, interrupted: false, error: 'missing session' }); return; }
          const controller = hub.get('sessionController');
          const events = controller && typeof controller.inspect === 'function'
            ? await controller.inspect(sessionId) : null;
          const list = Array.isArray(events && events.events) ? events.events
            : (Array.isArray(events) ? events : []);
          // 传入真实运行态：正在跑的会话不该被「悬空回合」判成中断（否则闸门会挡住
          // 它正常收取排队消息）；被硬杀后空闲的会话才会命中 d 分支。
          let agentRunning = false;
          try {
            const agents = hub.get('agents');
            const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
            agentRunning = Boolean(agent && String(agent.status) === 'running');
          } catch (error) { /* 取不到按空闲处理 */ }
          const verdict = interruptedReasonDetailed(list, { running: agentRunning });
          send(200, {
            ok: true,
            interrupted: Boolean(verdict.reason),
            reason: verdict.reason,
            interruptedAt: verdict.interruptedAt || 0,
          });
        } catch (error) {
          // 读不到事件（会话不存在等）按"无中断"处理，不阻塞正常队列
          send(200, { ok: false, interrupted: false, error: String((error && error.message) || error) });
        }
      },
    }), 'hub-desktop-ui:/hub/resume-check');

    // GET /hub/is-running?session=<id>：Host 权威运行态（agents.get(id).status）。
    // 2026-10-23 修「队列永不发送」：渲染层 liveRunning 集合在多次重启后可能残留假 running
    //（漏掉 idle 事件），泵据此认为目标永远忙。泵在本地判忙时来这里二次确认。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/is-running',
      handler: (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const sessionId = String(url.searchParams.get('session') || '').trim();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          if (!sessionId) { res.end(JSON.stringify({ ok: false, running: false, error: 'missing session' })); return; }
          const agents = hub.get('agents');
          const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
          res.end(JSON.stringify({
            ok: true,
            running: Boolean(agent && String(agent.status) === 'running'),
          }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, running: false, error: String((error && error.message) || error) }));
        }
      },
    }), 'hub-desktop-ui:/hub/is-running');

    // GET/POST /hub/queue?project=<名称>：房间待办队列的 Host 侧落盘。
    // 桌面端队列原本只存浏览器 localStorage（client.js loadRoomTodos/saveRoomTodos），
    // 手机端读不到；客户端保存时顺手 POST 到这里，手机端 /sync/queue 读同一份文件。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/queue',
      handler: async (req, res) => {
        const send = (body) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          let project = url.searchParams.get('project') || '';
          let incoming = null;
          if (req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            project = project || String(body.project || '');
            if (Array.isArray(body.list)) incoming = body.list;
          }
          const safe = String(project).replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').trim();
          if (!safe) return send({ ok: false, list: [], error: 'project required' });
          const file = join(hostRoot(hub), '.hub', 'projects', safe, 'queue.json');
          if (incoming) {
            try {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, `${JSON.stringify({ project: safe, updatedAt: Date.now(), list: incoming }, null, 2)}\n`, 'utf8');
            } catch (error) {
              return send({ ok: false, list: [], error: String(error && error.message) });
            }
          }
          let data = { list: [] };
          try {
            data = JSON.parse(readFileSync(file, 'utf8')) || { list: [] };
          } catch { /* 还没有队列文件 = 空队列 */ }
          return send({
            ok: true,
            project: safe,
            updatedAt: Number(data.updatedAt) || 0,
            list: Array.isArray(data.list) ? data.list : [],
          });
        } catch (error) {
          return send({ ok: false, list: [], error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/queue');

    // POST /hub/client-error：客户端渲染层报错落盘（Electron 看不到控制台，用文件观测）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/client-error',
      handler: async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const logFile = join(hostRoot(hub), '.hub', 'client-errors.log');
          try { mkdirSync(dirname(logFile), { recursive: true }); } catch { /* 已存在 */ }
          appendFileSync(logFile, `${Buffer.concat(chunks).toString('utf8')}\n`, 'utf8');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":true}');
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(error && error.message) }));
        }
      },
    }), 'hub-desktop-ui:/hub/client-error');

    // POST /hub/restart-recording：**重启前录屏分片实时落盘**（2026-11-06 用户要求
    // 「重启按钮重启的时候需要录一段屏，因为老是有一闪而过的报错，我抓不住」）。
    // 流程：点重启 → getDisplayMedia 录当前标签页 → MediaRecorder 每 ~1s 产一片
    // → 每片立刻 POST 到这里按 seq 顺序追加写 `.hub/restart-recordings/restart-<id>.webm`。
    // ⚠️ 必须边录边落盘：重启会杀掉整个进程，留在内存里的录像会直接丢。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/restart-recording',
      handler: async (req, res) => {
        const reply = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'text/plain' }); res.end('POST only'); return; }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const id = String(body.id || '').replace(/[^0-9A-Za-z_-]/g, '');
          if (!id) return reply(400, { ok: false, error: '缺 id' });
          const seq = Math.max(0, Number(body.seq) || 0);
          const data = String(body.data || '');
          if (!data) return reply(400, { ok: false, error: '缺 data' });
          const dir = join(hostRoot(hub), '.hub', 'restart-recordings');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `restart-${id}.webm`);
          const buf = Buffer.from(data, 'base64');
          if (seq === 0) writeFileSync(file, buf); else appendFileSync(file, buf);
          return reply(200, { ok: true, seq, bytes: buf.length });
        } catch (error) {
          return reply(200, { ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/restart-recording');

    // GET /hub/restart-recordings/latest：重启后让用户找回刚才那段录屏。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/restart-recordings/latest',
      handler: async (req, res) => {
        const reply = (payload) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
        try {
          const dir = join(hostRoot(hub), '.hub', 'restart-recordings');
          if (!existsSync(dir)) return reply({ ok: true, file: '', size: 0, ageMs: null });
          // 2026-11-06：同时认 .jsonl（界面快照，实际可用）与 .webm（旧录像，内核禁权限后基本不会有）
          const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl') || n.endsWith('.webm'));
          if (!files.length) return reply({ ok: true, file: '', size: 0, ageMs: null });
          let best = null;
          for (const name of files) {
            const full = join(dir, name);
            try {
              const st = statSync(full);
              if (!best || st.mtimeMs > best.mtimeMs) best = { name, full, size: st.size, mtimeMs: st.mtimeMs };
            } catch { /* 忽略单个文件错误 */ }
          }
          if (!best) return reply({ ok: true, file: '', size: 0, ageMs: null });
          return reply({ ok: true, file: best.full, name: best.name, size: best.size, ageMs: Date.now() - best.mtimeMs });
        } catch (error) { reply({ ok: false, error: String(error && error.message) }); }
      },
    }), 'hub-desktop-ui:/hub/restart-recordings/latest');

    // POST /hub/ui-snapshot：**界面快照帧落盘**（2026-11-06）。
    // 背景：DSH 内核 `setDisplayMediaRequestHandler((_r, cb) => cb({}))` + 权限一律 false
    // → getDisplayMedia/录屏在渲染进程里**永远不可能成功**（实测确认，不是代码 bug）。
    // 改用「界面快照序列」：客户端每 250ms 采一帧（可见文字 + 疑似报错元素的文本/class），
    // 逐帧追加写 `.hub/restart-recordings/ui-<id>.jsonl`——能抓到一闪而过的报错内容，
    // 且完全不依赖任何浏览器权限。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/ui-snapshot',
      handler: async (req, res) => {
        const reply = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'text/plain' }); res.end('POST only'); return; }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const id = String(body.id || '').replace(/[^0-9A-Za-z_-]/g, '');
          if (!id) return reply(400, { ok: false, error: '缺 id' });
          const dir = join(hostRoot(hub), '.hub', 'restart-recordings');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `ui-${id}.jsonl`);
          appendFileSync(file, JSON.stringify({ seq: Number(body.seq) || 0, frame: body.frame || null }) + '\n', 'utf8');
          // 每份启动快照约 800KB，不清理会一直涨：只在**新会话第一帧**时修剪，保留最近 5 份启动快照。
          if ((Number(body.seq) || 0) === 0) {
            try {
              const boots = readdirSync(dir).filter((n) => n.startsWith('ui-boot-')).sort();
              while (boots.length > 5) {
                const victim = boots.shift();
                try { rmSync(join(dir, victim), { force: true }); } catch (error) { /* 忽略 */ }
              }
            } catch (error) { /* 忽略清理失败 */ }
          }
          return reply(200, { ok: true });
        } catch (error) { return reply(200, { ok: false, error: String(error && error.message) }); }
      },
    }), 'hub-desktop-ui:/hub/ui-snapshot');

    // POST /hub/open-file：用系统默认程序打开文件（「看上次重启录屏」按钮用）。
    // 只允许打开仓库 .hub 下的文件，防路径穿越。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/open-file',
      handler: async (req, res) => {
        const reply = (payload) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
        if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'text/plain' }); res.end('POST only'); return; }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const abs = resolve(String(body.path || ''));
          const hubDir = join(hostRoot(hub), '.hub');
          if (!(abs === hubDir || abs.startsWith(hubDir + sep))) return reply({ ok: false, error: '只允许打开 .hub 下的文件' });
          if (!existsSync(abs)) return reply({ ok: false, error: '文件不存在' });
          spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref();
          return reply({ ok: true, path: abs });
        } catch (error) { reply({ ok: false, error: String(error && error.message) }); }
      },
    }), 'hub-desktop-ui:/hub/open-file');

    // GET/POST /hub/order：桌面端**算好的**项目序 + 项目内 agent 序落盘（`.hub/order.json`）。
    // 手机端 /sync/order 读同一份 → 两端排序按构造完全一致（不靠启发式猜 updatedAt）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/order',
      handler: async (req, res) => {
        const send = (body) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        try {
          const file = join(hostRoot(hub), '.hub', 'order.json');
          if (req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const projects = Array.isArray(body.projects) ? body.projects : null;
            if (!projects) return send({ ok: false, error: 'projects required' });
            try {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, `${JSON.stringify({ updatedAt: Date.now(), projects }, null, 2)}\n`, 'utf8');
            } catch (error) {
              return send({ ok: false, error: String(error && error.message) });
            }
            return send({ ok: true, count: projects.length });
          }
          let data = { projects: [] };
          try {
            data = JSON.parse(readFileSync(file, 'utf8')) || { projects: [] };
          } catch { /* 还没有文件 */ }
          return send({ ok: true, updatedAt: data.updatedAt || 0, projects: Array.isArray(data.projects) ? data.projects : [] });
        } catch (error) {
          return send({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/order');

    // GET/POST /hub/pinned：项目置顶列表落盘（桌面 togglePin 时 POST 镜像，手机端 /sync/pinned 读同一份）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/pinned',
      handler: async (req, res) => {
        const send = (body) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        try {
          const file = join(hostRoot(hub), '.hub', 'pinned.json');
          if (req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const list = Array.isArray(body.list)
              ? body.list.filter((x) => typeof x === 'string')
              : null;
            if (!list) return send({ ok: false, error: 'list required' });
            try {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, `${JSON.stringify({ updatedAt: Date.now(), list }, null, 2)}\n`, 'utf8');
            } catch (error) {
              return send({ ok: false, error: String(error && error.message) });
            }
          }
          let data = { list: [] };
          try {
            data = JSON.parse(readFileSync(file, 'utf8')) || { list: [] };
          } catch { /* 还没有文件 = 空列表 */ }
          return send({ ok: true, list: Array.isArray(data.list) ? data.list : [] });
        } catch (error) {
          return send({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/pinned');

    // GET/POST /hub/unread：「完成未读」列表落盘（`.hub/unread.json`）。
    //
    // ⚠️ **契约必须与 `dsh/plugins/hub-sync-bridge/sync-bridge.js` 的 `/sync/unread` 保持一致，
    //    改一边必须同步改另一边**：
    //      GET  → { ok, list:[sessionId...], updatedAt }
    //      POST { op:'add'|'remove'|'clear', ids:[...] } → { ok, list, updatedAt }
    //    add/remove 用 Set 幂等，clear 清空；updatedAt = Date.now()（毫秒，13 位）。
    //
    // 为什么桌面不直连桥的 `/sync/unread`（2026-11-11 与 sync 工程师对齐）：
    //   ① 桥的认证是 `Authorization: Bearer <token>`（token 在 `~/.dsh/sync-token.txt`），
    //      桌面浏览器端的 client.js 拿不到这个 token；
    //   ② 桥在另一个端口 = 跨 origin，而桥代码里没有 CORS 头，浏览器会拦。
    //   所以桌面走这条**同源**路由；手机继续走桥的 `/sync/unread`；两边落**同一个文件**，
    //   「唯一事实源」的设计不受影响。
    //
    // 为什么不需要冲突合并策略：两端都发**增量 op**（不是整表覆盖），
    // 所以「桌面 clear 的同时手机 add 一条」不会互相抹掉；updatedAt 只用于排查，不参与合并。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/unread',
      handler: async (req, res) => {
        const send = (body) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        };
        try {
          const file = join(hostRoot(hub), '.hub', 'unread.json');
          // 读-改-写用 hub-core 的既有纪律（`hub-core/tasks.js:69/77`）：
          //   `readJsonForWrite` 区分「文件不存在」（= 空对象，允许写）与「读/解析失败」
          //   （并发写/半截文件 → ok:false，**调用方必须放弃写回**）；
          //   `writeJsonAtomic` = 先写 `<file>.tmp` 再 rename。
          // 这个纪律是 2026-10-20 tasks.json 被空对象冲掉之后定下的，本文件同样适用：
          // `.hub/unread.json` 现在有**两个写入方**（桌面 /hub/unread、桥 /sync/unread），
          // 解析失败时若当成空表继续写，等于**静默清空用户未读**。
          // （2026-11-11 sync 工程师 c23a8480 提出，两端都要遵守。）
          const readUnread = () => {
            const got = readJsonForWrite(file);
            if (!got.ok) return { ok: false };
            const data = got.value || {};
            return {
              ok: true,
              list: Array.isArray(data.list) ? data.list.map(String) : [],
              updatedAt: Number(data.updatedAt || 0),
            };
          };
          if (req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const op = String((body && body.op) || 'add');
            const ids = Array.isArray(body && body.ids) ? body.ids.map(String).filter(Boolean) : [];
            const base = readUnread();
            if (!base.ok) {
              console.warn('[hub-desktop-ui] unread.json 读取/解析失败，本次写入已放弃（避免覆盖用户未读）');
              return send({ ok: false, error: 'unread.json 解析失败，本次写入已放弃（避免覆盖用户未读）' });
            }
            const set = new Set(base.list);
            if (op === 'clear') set.clear();
            else if (op === 'remove') for (const id of ids) set.delete(id);
            else for (const id of ids) set.add(id);
            const payload = { list: [...set], updatedAt: Date.now() };
            try {
              writeJsonAtomic(file, payload);   // 临时文件 + rename，原子
            } catch (error) {
              return send({ ok: false, error: String(error && error.message) });
            }
            return send({ ok: true, list: payload.list, updatedAt: payload.updatedAt });
          }
          const got = readUnread();
          if (!got.ok) return send({ ok: false, error: 'unread.json 解析失败' });
          return send({ ok: true, list: got.list, updatedAt: got.updatedAt });
        } catch (error) {
          return send({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/unread');

    // GET /hub/session-events?session=<id>&since=<seq>：会话事件通道（分身分列每列取数）。
    // 客户端 `sessions.retain(id)` → `binding.eventSource.getSnapshot()` 只对**本 Client
    // 打开过**的会话有窗口快照；分列里绝大多数列是冷会话，拿不到任何事件（旧实现于是每列
    // 只剩一行「点 ↗ 打开」占位）。这里读持久事件——冷会话走 sessionController.inspect，
    // 只读不激活 agent——并按 seq 增量返回渲染用精简事件（含分步耗时字段）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/session-events',
      handler: async (req, res) => {
        const send = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const sessionId = String(url.searchParams.get('session') || '').trim();
          if (!sessionId) return send({ ok: false, error: 'session required' });
          const since = Number(url.searchParams.get('since') || 0) || 0;
          // 首屏最多回 4000 条事件（分列只渲染尾部消息，够用又不会把页面顶住）
          const limit = Math.max(1, Math.min(20000, Number(url.searchParams.get('limit') || 4000)));
          const pool = await readSessionEvents(hub, sessionId);
          const compact = compactSessionEvents(pool.events);
          let events = compact.events;
          if (since > 0) events = events.filter((event) => event.seq > since);
          else if (events.length > limit) events = events.slice(-limit);
          return send({
            ok: true,
            sessionId,
            live: pool.live,
            total: compact.events.length,
            lastSeq: compact.lastSeq,
            streaming: compact.streaming,
            events,
          });
        } catch (error) {
          return send({ ok: false, error: String((error && error.message) || error) });
        }
      },
    }), 'hub-desktop-ui:/hub/session-events');

    // GET /hub/models：模型目录（给「一键切换模型」下拉用）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/models',
      handler: async (req, res) => {
        try {
          const controller = hub.get('sessionController');
          const catalog = await controller.modelCatalog();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, default: catalog.default, groups: catalog.groups }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(error && error.message) }));
        }
      },
    }), 'hub-desktop-ui:/hub/models');

    // GET /hub/session-model?session=<id>：会话的权威 modelSelection 投影（pending/lastUsed）。
    // 批量切换模型的验收/排障用：pending 非空 = 下一轮即用该模型。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/session-model',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const sessionId = String(url.searchParams.get('session') || '').trim();
          if (!sessionId) throw new Error('missing session');
          const controller = hub.get('sessionController');
          const value = await controller.projections({ sessionId }, new AbortController().signal);
          const values = value && value.values ? value.values : {};
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            sessionId,
            kind: value ? value.kind : null,
            modelSelection: values.modelSelection || null,
          }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
        }
      },
    }), 'hub-desktop-ui:/hub/session-model');

    // POST /hub/session-model-set：给**单个会话**切模型（分列列内模型选择器用，2026-10-23）。
    // 与 /hub/switch-model 的区别：只动一个会话、不改全局默认。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/session-model-set',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const sessionId = String(body.sessionId || '').trim();
          const provider = String(body.provider || '').trim();
          const model = String(body.model || '').trim();
          if (!sessionId || !provider || !model) return reply({ ok: false, error: '缺 sessionId/provider/model' });
          const controller = hub.get('sessionController');
          if (!controller || typeof controller.selectModel !== 'function') {
            return reply({ ok: false, error: 'selectModel 不可用' });
          }
          await controller.selectModel({ sessionId, provider, model });
          reply({ ok: true, sessionId, provider, model });
        } catch (error) {
          reply({ ok: false, error: String((error && error.message) || error) });
        }
      },
    }), 'hub-desktop-ui:/hub/session-model-set');
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/switch-model',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const provider = String(body.provider || '');
          const model = String(body.model || '');
          if (!provider || !model) return reply({ ok: false, error: '缺 provider/model' });
          const controller = hub.get('sessionController');
          // —— 2026-10-23 修「全局切换对所有已有对话不生效」——
          // 旧实现枚举用 sessions.list()（只含活会话，冷会话全漏）。
          // 会话模型解析顺序（dsh-api-session-controller agent.js selectionFor）：
          //   pending（手动 selectModel）→ 会话日志上次 request header（粘滞）→ 全局默认。
          // 所以已有对话永远不吃全局默认，必须逐会话 selectModel（写持久 model/selection
          // 事件 + 更新内存缓存，冷会话经 resolveAgent 唤醒后即带新选择）。
          let targets = [];
          try {
            const value = await controller.list(new AbortController().signal);
            const rows = value && Array.isArray(value.items) ? value.items : value;
            const registry = hub.get('workspaceRegistry');
            const archivedSet = new Set(
              registry && Array.isArray(registry.archivedSessionIds)
                ? registry.archivedSessionIds.map(String) : [],
            );
            targets = (Array.isArray(rows) ? rows : [])
              .filter((row) => row && row.sessionId && !archivedSet.has(String(row.sessionId)))
              .map((row) => String(row.sessionId));
          } catch (error) {
            return reply({ ok: false, error: `会话枚举失败：${String((error && error.message) || error)}` });
          }
          // 安全：切换前记一笔可回滚档案（旧全局默认 + 受影响会话清单）
          let previousDefault = null;
          try {
            const def = hub.get('agentDefaultModel');
            if (def && typeof def.currentSelection === 'function') {
              previousDefault = def.currentSelection();
            }
          } catch (error) { /* ignore */ }
          const backupFile = join(hostRoot(hub), '.hub', 'model-bulk-backup.json');
          try {
            mkdirSync(dirname(backupFile), { recursive: true });
            writeFileSync(backupFile, `${JSON.stringify({
              at: Date.now(), provider, model, previousDefault, sessions: targets,
            }, null, 2)}\n`, 'utf8');
          } catch (error) {
            console.warn(`[hub-desktop-ui] model bulk backup write failed: ${String(error)}`);
          }
          let switched = 0;
          const failures = [];
          // —— 2026-10-26 性能优化（用户报「全局切换模型这么慢」）——
          // 根因：145+ 会话 × 串行 selectModel（每个含 resolveAgent 唤醒 + 写持久事件）→ 十秒级。
          // ① **幂等短路**：projcache 的持久投影 `rows.modelSelection.val = {pending, lastUsed}`
          //    就是 selectionFor 的解析源（pending → lastUsed/header 粘滞 → 默认）。已是目标
          //    provider+model 的会话直接跳过——重复全局切同一模型应近乎瞬时。
          // ② **并发分批**：串行 for-await 改 Promise.all 每批 12 个并发；done/switched 计数在
          //    JS 单线程事件循环里 += 即原子，进度条仍单调递增。
          // ③ 冷会话降级路径（绕过 resolveAgent 直写投影）评估后**不做**：projcache 投影由
          //    会话运行时维护，外部直写有内存缓存不一致风险（selectionFor 有内存缓存），得不偿失。
          const readSelection = (sessionId) => {
            // ① 内存账本优先（selectModel 成功即记，防 projcache 异步 flush 的滞后窗口）
            const applied = bulkAppliedSelections.get(sessionId);
            if (applied) {
              if (Date.now() - applied.at <= BULK_APPLIED_TTL_MS) return applied.selection;
              bulkAppliedSelections.delete(sessionId);
            }
            try {
              const raw = JSON.parse(readFileSync(
                join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`),
                'utf8',
              ));
              const sel = raw && raw.record && raw.record.rows && raw.record.rows.modelSelection;
              const val = sel && sel.val;
              if (val && val.pending && val.pending.provider && val.pending.model) return val.pending;
              if (val && val.lastUsed && val.lastUsed.provider && val.lastUsed.model) return val.lastUsed;
              return null;
            } catch (error) { return null; }
          };
          const need = targets.filter((sessionId) => {
            const current = readSelection(sessionId);
            return !(current && current.provider === provider && current.model === model);
          });
          const skipped = targets.length - need.length;
          modelBulkProgress = {
            running: true, done: skipped, total: targets.length, switched: 0,
            provider, model, startedAt: Date.now(), finishedAt: 0,
            skipped,
          };
          const BATCH = 12;
          for (let start = 0; start < need.length; start += BATCH) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(need.slice(start, start + BATCH).map(async (sessionId) => {
              try {
                await controller.selectModel({ sessionId, provider, model });
                switched += 1;
                // 成功即记账本（projcache 投影异步 flush，短路不能只信它）
                bulkAppliedSelections.set(sessionId, { at: Date.now(), selection: { provider, model } });
              } catch (error) {
                failures.push(`${sessionId}: ${String(error && error.message)}`);
              }
              modelBulkProgress.done += 1;
              modelBulkProgress.switched = switched;
            }));
          }
          let saved = false;
          try {
            const def = hub.get('agentDefaultModel');
            if (def && typeof def.saveSelection === 'function') {
              await def.saveSelection({ provider, model });
              saved = true;
            }
          } catch (error) { /* ignore */ }
          // 2026-10-29 用户令「因模型问题中断的对话，切换模型后自动续跑」：
          // 切换已完成（批量账本已记账本、默认模型已保存）→ 对"模型错误中断"的会话发【续跑】。
          // 只碰账本内会话（普通中断不动），且仍停在原错误模型上的不续跑。
          let autoResumed = [];
          try {
            autoResumed = await resumeModelErrorSessions(hub);
          } catch (error) {
            console.warn(`[hub-desktop-ui] auto-resume after switch failed: ${String((error && error.message) || error)}`);
          }
          reply({
            ok: true, provider, model, total: targets.length, switched, skipped, saved,
            tookMs: Date.now() - modelBulkProgress.startedAt,
            failures: failures.slice(0, 10),
            autoResumed,
          });
          modelBulkProgress = { ...modelBulkProgress, running: false, finishedAt: Date.now(), switched };
        } catch (error) {
          reply({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/switch-model');

    // POST /hub/switch-model-rollback：把上次批量切换的会话恢复为当时旧全局默认
    //（读 .hub/model-bulk-backup.json；单会话粒度，幂等）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/switch-model-rollback',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const backupFile = join(hostRoot(hub), '.hub', 'model-bulk-backup.json');
          const data = JSON.parse(readFileSync(backupFile, 'utf8'));
          const prev = data && data.previousDefault;
          if (!prev || !prev.provider || !prev.model || !Array.isArray(data.sessions)) {
            return reply({ ok: false, error: '备份档案无效或缺少旧默认' });
          }
          const controller = hub.get('sessionController');
          let switched = 0;
          const failures = [];
          for (const sessionId of data.sessions) {
            try {
              await controller.selectModel({ sessionId, provider: prev.provider, model: prev.model });
              switched += 1;
            } catch (error) {
              failures.push(`${sessionId}: ${String(error && error.message)}`);
            }
          }
          try {
            const def = hub.get('agentDefaultModel');
            if (def && typeof def.saveSelection === 'function') {
              await def.saveSelection({ provider: prev.provider, model: prev.model });
            }
          } catch (error) { /* ignore */ }
          reply({ ok: true, provider: prev.provider, model: prev.model, total: data.sessions.length, switched, failures: failures.slice(0, 10) });
        } catch (error) {
          reply({ ok: false, error: `回滚失败（无备份？）：${String(error && error.message)}` });
        }
      },
    }), 'hub-desktop-ui:/hub/switch-model-rollback');

    // GET /hub/switch-model-progress：批量切模型进度（2026-10-23，客户端画进度条用）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/switch-model-progress',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...modelBulkProgress }));
      },
    }), 'hub-desktop-ui:/hub/switch-model-progress');

    // 把所有活着的会话切到指定 agent preset（Creator mode = cordis）。
    // settings 里的「新会话默认 preset」由客户端半写（remote.settings），Host 只管存量。
    const applyPresetToAll = async (preset) => {
      const controller = hub.get('sessionController');
      const presets = hub.get('agentPresets');
      const sessions = hub.get('sessions');
      if (!controller || !presets || typeof presets.select !== 'function') {
        return { ok: false, error: 'agentPresets/sessionController 不可用' };
      }
      const list = sessions && typeof sessions.list === 'function' ? sessions.list() : [];
      let switched = 0;
      const failures = [];
      for (const session of list) {
        try {
          const result = await controller.resolveAgent(session.id);
          const agent = result && result.agent ? result.agent : result;
          if (!agent) throw new Error('resolveAgent 未返回 agent');
          await presets.select(agent, preset);
          switched += 1;
        } catch (error) {
          failures.push(`${session.id}: ${String(error && error.message)}`);
        }
      }
      return { ok: true, preset, switched, failures };
    };

    // POST /hub/preset-all：手动触发；Host 启动（服务就绪）后也会自动跑一次。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/preset-all',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          reply(await applyPresetToAll(String(body.preset || defaultPreset)));
        } catch (error) {
          reply({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/preset-all');

    // GET /hub/preset-audit：只读体检——全部可见会话的 preset 分布（cordis / 其它）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/preset-audit',
      handler: async (req, res) => {
        try {
          const result = await presetAudit(hub, defaultPreset);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(error && error.message) }));
        }
      },
    }), 'hub-desktop-ui:/hub/preset-audit');

    // GET /hub/resume-status：续跑扫写的最近一次结果 + 24h 账本（排查「没自动续跑」用）。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/resume-status',
      handler: (req, res) => {
        try {
          const ledgerRead = readJsonForWrite(resumeLedgerPath(hub));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            last: resumeSweepState.last,
            ledger: ledgerRead.ok ? ledgerRead.value : { error: String(ledgerRead.error && ledgerRead.error.message) },
          }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(error && error.message) }));
        }
      },
    }), 'hub-desktop-ui:/hub/resume-status');

    // POST /hub/upload?ext=png：把客户端粘贴进来的图片存成临时文件，返回本地路径。
    // 客户端没有文件写入权限，所以由 Host 落盘；消息里带路径，agent 用 read 打开。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/upload',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const ext = String(url.searchParams.get('ext') || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 25 * 1024 * 1024) throw new Error('图片太大（>25MB）');
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) throw new Error('空文件');
          const dir = join(process.env.TEMP || process.env.TMP || tmpdir(), 'hub-paste');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
          writeFileSync(file, buffer);
          reply({ ok: true, path: file, bytes: buffer.length });
        } catch (error) {
          reply({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/upload');

    // GET /hub/session-subagent?session=<id>：判断该会话是否为 subagent 子会话。
    // 2026-10-29（用户报「出题工程师的分身开到临时对话」）：subagent 子会话的标题取任务书
    // 首句、不带「项目 · 」前缀，客户端旧探针只读 /hub/session-events（subagent 会话读不到
    // → 误判非 subagent → 不隐藏，掉进侧栏临时区）。权威标记在 projcache 的
    // `record.rows.subagent`（identity.mode/label），这里直接读文件返回。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/session-subagent',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const raw = String(url.searchParams.get('session') || '').trim();
          if (!raw) return reply({ ok: false, error: '缺 session' });
          const id = raw.replace(/^session-/, '');
          const home = process.env.USERPROFILE || process.env.HOME || '';
          if (!home) return reply({ ok: false, error: '无用户目录' });
          const file = join(home, '.dsh', 'storages', 'session_projcache', 'sessions', `${id}.json`);
          if (!existsSync(file)) return reply({ ok: true, subagent: false, why: 'no-projcache' });
          const parsed = JSON.parse(readFileSync(file, 'utf8'));
          const row = parsed && parsed.record && parsed.record.rows && parsed.record.rows.subagent;
          const val = row && row.val;
          if (!val || !val.identity) return reply({ ok: true, subagent: false });
          // 2026-10-29 二段（用户：「之前不是有分身显示方式吗，分多栏/侧栏归父」）：
          // subagent 子会话不落父子链（父的 catalog 在内存），但**父 events 里有
          // `started subagent <childId>` 工具结果**。这里懒扫描全部活会话建 child→parent
          // 映射（缓存 5 分钟），客户端拿到 parentTitle 即可把它当「父名｜label」分身
          // 纳入既有的侧栏归父 + CloneColumns 分列体系。
          let parentTitle = '';
          let scanDebug = null;
          // 本作用域没有 ctx：首版用 titleOfRow(session) 会 ReferenceError 被 catch 吞掉，
          // 表现就是 parentTitle 恒空、scan 字段消失。这里用 hub 服务自取自足地取标题。
          const titleOfRow = (session) => {
            try {
              const titles = hub.get('sessionTitle');
              const snap = titles && typeof titles.get === 'function' ? titles.get(session) : undefined;
              return String((snap && snap.title) || '');
            } catch (error) { return ''; }
          };
          try {
            const store = subagentParentCache;
            if (Date.now() - store.at > 5 * 60 * 1000) {
              store.map.clear();
              store.at = Date.now();
              const sessions = hub.get('sessions');
              const list = sessions && typeof sessions.list === 'function' ? sessions.list() : [];
              // 2026-10-29：sessions.list() 只有活会话（实测 3 个），父会话可能已空闲 →
              // 追加 sessionController.list() 的冷会话 id（去重），否则反查漏父。
              const ids = [];
              for (const session of list) if (session && session.id) ids.push(String(session.id));
              try {
                const controller = hub.get('sessionController');
                const rows = controller && typeof controller.list === 'function'
                  ? await controller.list(new AbortController().signal) : [];
                const arr = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.items) ? rows.items : []);
                for (const row of arr) {
                  const rid = row && String(row.sessionId || '');
                  if (rid && !ids.includes(rid)) ids.push(rid);
                }
              } catch (error) { /* 追加失败就用活会话 */ }
              let scanned = 0;
              let failed = 0;
              for (const sid of ids) {
                // per-session 容错：单个会话读失败不能中断整轮（否则留下半空缓存）。
                try {
                  const pool = await readSessionEvents(hub, sid);
                  const compact = compactSessionEvents(pool.events);
                  scanned += 1;
                  const live = list.find((s) => s && String(s.id) === sid);
                  const titleHere = live ? titleOfRow(live) : '';
                  for (const event of compact.events) {
                    // 只认真正的 subagent 工具结果：①事件类型必须是 tool/result
                    // ②brief 必须以「started subagent <id>」开头——否则助手正文/命令回显里
                    //   提到该字样会被误判成父（实测首次就错认成"应用开发 · DSH工程师"）。
                    if (!event || event.type !== 'tool/result') continue;
                    const brief = event.data && event.data.brief;
                    if (typeof brief !== 'string') continue;
                    const m = brief.match(/^started subagent ([0-9a-f-]{8,})/);
                    if (m && titleHere) store.map.set(m[1], titleHere);
                  }
                } catch (error) { failed += 1; }
              }
              scanDebug = { scanned, failed, found: store.map.size };
            }
            parentTitle = store.map.get(id) || store.map.get(raw) || '';
            // 始终带缓存状态：hash 命中与否 + 已知映射数 + 父会话候选，便于诊断"反查为空"。
            if (!scanDebug) {
              const sessionsSvc = hub.get('sessions');
              const listNow = sessionsSvc && typeof sessionsSvc.list === 'function' ? sessionsSvc.list() : [];
              scanDebug = {
                cached: true,
                found: store.map.size,
                ageMs: Date.now() - store.at,
                sessions: listNow.length,
                ids: store.map.size ? [...store.map.keys()].slice(0, 5) : [],
              };
            }
          } catch (error) {
            // 不再静默：把异常带出去（首版就是被这里吞掉，表现为 parentTitle 恒空）
            scanDebug = { error: String((error && error.message) || error) };
          }
          return reply({
            ok: true,
            subagent: Boolean(val && val.identity),
            label: (val && val.identity && val.identity.label) || '',
            parentTitle,
            scan: scanDebug || undefined,
          });
        } catch (error) {
          reply({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/session-subagent');

    // GET /hub/session-capability?session=<id>：判断该会话当前模型能不能直接读图。
    // 2026-10-26：客户端要在**发送框之前**决定"放原生附件"还是"自己截下来转文字"，
    // 所以需要这个能力位。判定链：sessionController.inspect 里最后一条 request/header
    // 的 config.{provider,model} → llm.resolveModelInfo → inputModalities 是否含 image。
    // 结果按会话缓存 60s；切换模型时由 /hub/switch-model 主动清缓存。
    const capabilityCache = new Map();
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/session-capability',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const sessionId = String(url.searchParams.get('session') || '').trim();
          if (!sessionId) return reply({ ok: false, error: '缺 session' });
          const cached = capabilityCache.get(sessionId);
          if (cached && Date.now() - cached.at < 60000) {
            return reply({ ok: true, ...cached.value, cached: true });
          }
          const controller = hub.get('sessionController');
          const llm = hub.get('llm');
          if (!controller || !llm) return reply({ ok: false, error: '服务不可用' });
          let provider = '';
          let model = '';
          try {
            const inspection = await controller.inspect(sessionId, new AbortController().signal);
            const events = (inspection && inspection.events) || [];
            for (let i = events.length - 1; i >= 0; i -= 1) {
              const event = events[i];
              const header = event && event.type === 'request/header' ? (event.data && event.data.header) : null;
              const config = header && header.config;
              if (config && config.provider && config.model) {
                provider = config.provider;
                model = config.model;
                break;
              }
            }
          } catch (error) { /* 冷会话读不到 header → 退回全局默认 */ }
          if (!provider || !model) {
            try {
              const def = hub.get('agentDefaultModel');
              const sel = def && typeof def.currentSelection === 'function' ? def.currentSelection() : null;
              if (sel && sel.provider && sel.model) {
                provider = sel.provider;
                model = sel.model;
              }
            } catch (error) { /* ignore */ }
          }
          if (!provider || !model) return reply({ ok: false, error: '无法解析会话模型' });
          // 未声明 inputModalities 时 DSH 的门禁不生效（gate 只在 defined 时判定），按"可支持"处理
          let supportsImage = true;
          try {
            const info = await llm.resolveModelInfo(provider, model);
            if (info && info.inputModalities !== undefined) {
              supportsImage = Array.isArray(info.inputModalities) && info.inputModalities.includes('image');
            }
          } catch (error) { /* 解析失败 → 保持原生行为 */ }
          const value = { provider, model, supportsImage };
          capabilityCache.set(sessionId, { at: Date.now(), value });
          return reply({ ok: true, ...value });
        } catch (error) {
          return reply({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/session-capability');

    // POST /hub/vision-send {sessionId, path, note}：非视觉模型会话的「图片转文字投递」。
    // 2026-10-26 用户要求：非视觉模型根本发不出图（客户端在发送框就拦了
    // "The current model does not support images"）。客户端把图落盘（/hub/upload）后调这里，
    // 由 Host 直接给该会话排一条 prompt：图在 <path>，请调用 vision_read 查看。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/vision-send',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const sessionId = String(body.sessionId || '').trim();
          const path = String(body.path || '').trim();
          const note = String(body.note || '').trim();
          if (!sessionId || !path) return reply({ ok: false, error: '缺 sessionId/path' });
          const controller = hub.get('sessionController');
          if (!controller || typeof controller.prompt !== 'function') {
            return reply({ ok: false, error: 'prompt 不可用' });
          }
          const text = [
            '【用户发来图片】本会话模型不能直接读图，图片已经保存到本地：',
            path,
            '',
            `请调用 vision_read({ source: "${path}" }) 查看图片内容，再据此回答用户。`,
            note ? `用户附言：${note}` : '',
          ].filter(Boolean).join('\n');
          await controller.prompt({
            requestId: `hub-vision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, new AbortController().signal);
          reply({ ok: true, sessionId, path });
        } catch (error) {
          reply({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/vision-send');

    // POST /hub/task-status {project, taskId, status}：改任务线状态（active / archived），
    // 给「归档后又被涉及到 → 恢复」用。客户端没有写盘权限，所以由 Host 改 tasks.json。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/task-status',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const project = String(body.project || '');
          const taskId = String(body.taskId || '');
          const status = body.status === 'archived' ? 'archived'
            : (body.status === 'active' ? 'active' : '');
          // 目标状态（2026-10-25 用户要求「任务线要能手动归档和改状态」）：
          // goalState 写 tasks.json，任务线头部徽标直接读它
          const GOAL_STATES = new Set(['active', 'done', 'blocked', 'pending']);
          const goalState = typeof body.goalState === 'string' && GOAL_STATES.has(body.goalState)
            ? body.goalState : '';
          if (!status && !goalState) {
            return reply({
              ok: false,
              error: 'status/goalState 至少给一个（status: active|archived；goalState: active|done|blocked|pending）',
            });
          }
          const path = boardPath(project, hostRoot(hub));
          if (!path) return reply({ ok: false, error: 'invalid project' });
          const file = join(dirname(path), 'tasks.json');
          const data = JSON.parse(readFileSync(file, 'utf8'));
          let changed = false;
          const applyPatch = (task) => {
            if (!task || typeof task !== 'object') return;
            if (status) task.status = status;
            if (goalState) task.goalState = goalState;
            changed = true;
          };
          if (Array.isArray(data.tasks)) {
            for (const task of data.tasks) {
              if (task && (String(task.id) === taskId || String(task.title) === taskId)) applyPatch(task);
            }
          } else if (data[taskId] && typeof data[taskId] === 'object') {
            applyPatch(data[taskId]);
          }
          if (changed) writeJsonAtomic(file, data);
          return reply({
            ok: changed, taskId,
            ...(status ? { status } : {}),
            ...(goalState ? { goalState } : {}),
          });
        } catch (error) {
          return reply({ ok: false, error: String(error && error.message) });
        }
      },
    }), 'hub-desktop-ui:/hub/task-status');

    // POST /hub/session-action：侧栏 agent 右键菜单（2026-10-23 用户要求）。
    // action = rename | archive | restore；只动目标会话。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/session-action',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const sessionId = String(body.sessionId || '').trim();
          const action = String(body.action || '').trim();
          if (!sessionId || !action) return reply({ ok: false, error: '缺 sessionId/action' });
          const controller = hub.get('sessionController');
          const registry = hub.get('workspaceRegistry');
          if (action === 'rename') {
            const title = String(body.title || '').trim();
            if (!title) return reply({ ok: false, error: '缺 title' });
            if (!controller || typeof controller.rename !== 'function') {
              return reply({ ok: false, error: 'rename 不可用' });
            }
            const value = await controller.rename({ sessionId, title });
            return reply({ ok: true, title: value && value.title ? value.title : title });
          }
          if (action === 'archive') {
            if (!registry || typeof registry.archiveSession !== 'function') {
              return reply({ ok: false, error: 'archiveSession 不可用' });
            }
            // 分身完整回收（2026-11-02 用户要求手动回收分身）：UI 右键「回收分身」会带 fullTitle；
            // 带｜的按 taskline_archive 工具同一套动作——停运行 + 清头像注册表沉淀 + 生成交接档案，
            // 与工具版行为对齐（此前 UI 版只归档，漏了后两步）。
            const fullTitle = String(body.fullTitle || '');
            const isClone = fullTitle.includes('｜');
            await registry.archiveSession(sessionId, { stopActivity: isClone });
            // 归档动作顺手触发清理（2026-10-24 用户令：不用定时器）
            await pruneArchivedSessions(hub).catch(() => {});
            let cleaned = null;
            let handoffPath = '';
            let forwarded = false;
            if (isClone) {
              const project = projectOfSessionTitle(fullTitle);
              const memberName = agentNameOfTitle(fullTitle);
              if (project && memberName.includes('｜')) {
                let handoffEvents = [];
                try { cleaned = cleanCloneRegistry(project, memberName, hostRoot(hub)); } catch (error) { /* 清理失败不挡归档 */ }
                try {
                  const store = hub.get('sessions') || {};
                  const session = typeof store.get === 'function' ? store.get(sessionId) : null;
                  const events = await collectEvents(hub, session, sessionId);
                  handoffEvents = events;
                  const handoff = writeCloneHandoff(project, memberName, sessionId, fullTitle, events, hostRoot(hub));
                  if (handoff && handoff.ok) handoffPath = String(handoff.path || '');
                } catch (error) { /* 交接档案失败不挡归档 */ }
                // 自动转发回收通知给父 agent（2026-11-02 用户要求）：手动回收往往发生在分身
                // 自行交接之前，父 agent 对此一无所知——把档案路径 + 最后几条输出摘要直接
                // 投到父会话（queue 模式，空闲即消化）。失败不挡归档。
                try {
                  const parentTitle = `${project} · ${memberName.slice(0, memberName.indexOf('｜')).trim()}`;
                  const parent = resolveSession(parentTitle);
                  if (parent && parent.id) {
                    const texts = [];
                    for (const event of Array.isArray(handoffEvents) ? handoffEvents : []) {
                      if (!event || event.type !== 'assistant/message') continue;
                      const message = (event.data || {}).message || {};
                      const parts = Array.isArray(message.content) ? message.content : [];
                      const t = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string')
                        .map((p) => p.text).join('').trim();
                      if (t) texts.push(t);
                    }
                    const tail = texts.slice(-3).map((t, i) => `${i + 1}. ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`);
                    const controller2 = hub.get('sessionController');
                    if (controller2 && typeof controller2.prompt === 'function') {
                      const live = await ensureLiveSession(hub, controller2, String(parent.id));
                      if (live.ok) {
                        await controller2.prompt({
                          requestId: `hub-clone-recycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                          sessionId: String(live.session.id),
                          mode: 'queue',
                          content: [{
                            type: 'text',
                            text: `【分身回收通知 · 自动转发】你的分身「${fullTitle}」已被用户从侧栏手动回收（可能未及自行交接）。\n`
                              + `交接档案（分身全部输出，供 grep）${handoffPath ? `：${handoffPath}` : '：生成失败，可用 taskline_archive restore 恢复会话查看'}\n`
                              + (tail.length ? `最后 ${tail.length} 条输出摘要：\n${tail.join('\n')}\n` : '')
                              + '如需后续处理（改黑板/收尾产物），请基于摘要与档案进行。',
                          }],
                        }, new AbortController().signal);
                        forwarded = true;
                      }
                    }
                  }
                } catch (error) { /* 转发失败不挡归档 */ }
              }
            }
            return reply({ ok: true, archived: true, cleaned, handoffPath, forwarded });
          }
          if (action === 'restore' || action === 'unarchive') {
            // DSH 侧方法名是 unarchiveSession（不是 restoreSession）
            if (!registry || typeof registry.unarchiveSession !== 'function') {
              return reply({ ok: false, error: 'unarchiveSession 不可用' });
            }
            await registry.unarchiveSession(sessionId);
            return reply({ ok: true, archived: false });
          }
          return reply({ ok: false, error: `未知 action: ${action}` });
        } catch (error) {
          reply({ ok: false, error: String((error && error.message) || error) });
        }
      },
    }), 'hub-desktop-ui:/hub/session-action');

    // POST /hub/ensure-manager：给「有项目但缺 Yat2 管理者」的项目补一个管理者会话（2026-11-02 用户要求）。
    // 起因：NewProjectDialog 依赖 connectWorkspace 返回 id，拿不到就跳过改名 →
    // 出现「PrimCell 有 board 有 tasks 但没有 Yat2」的残缺项目（agent 侧 taskline_create
    // 又受"成员只能自建分身/跨项目需管理者"校验所限，补不了）。这里用
    // sessionController.create + rename 直接建 `<项目> · Yat2`；已有则幂等返回 existing。
    hub.effect(() => server.register({
      kind: 'exact',
      path: '/hub/ensure-manager',
      handler: async (req, res) => {
        const reply = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('POST only');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const project = String(body.project || '').trim();
          if (!project) return reply({ ok: false, error: '缺 project' });
          const controller = hub.get('sessionController');
          if (!controller || typeof controller.create !== 'function') {
            return reply({ ok: false, error: 'sessionController.create 不可用' });
          }
          const title = `${project} · Yat2`;
          // 已存在 → 幂等返回，不重复建
          try {
            const rows = await controller.list(new AbortController().signal);
            const arr = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.items) ? rows.items : []);
            const hit = arr.find((row) => {
              const t = row && row.projections && row.projections.values ? row.projections.values.title : '';
              return typeof t === 'string' && t === title;
            });
            if (hit) return reply({ ok: true, existing: true, sessionId: String(hit.sessionId), title });
          } catch (error) { /* 列表失败就继续建新的 */ }
          const created = await controller.create({ cwd: hostRoot(hub), agentPreset: defaultPreset });
          const sessionId = created && created.sessionId;
          if (!sessionId) return reply({ ok: false, error: '创建未返回 sessionId' });
          await controller.rename({ sessionId, title });
          let avatar = '';
          try { avatar = ensureMemberAvatar(project, 'Yat2', hostRoot(hub), '🦉'); } catch (error) { /* 头像失败不挡 */ }
          if (body.text) {
            try {
              await controller.prompt({
                requestId: `hub-ensure-manager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: String(body.text) }],
              }, new AbortController().signal);
            } catch (error) { /* 初始任务投递失败不挡建线 */ }
          }
          return reply({ ok: true, sessionId, title, ...(avatar ? { avatar } : {}) });
        } catch (error) {
          reply({ ok: false, error: String((error && error.message) || error) });
        }
      },
    }), 'hub-desktop-ui:/hub/ensure-manager');

    // 启动后自动把所有会话切到默认 preset（关掉：config autoPresetOnBoot: false）
    if (autoPresetOnBoot) {
      const timer = setTimeout(async () => {
        try {
          const result = await applyPresetToAll(defaultPreset);
          console.log(`[hub-desktop-ui] boot preset (${defaultPreset}): switched=${result.switched} failures=${(result.failures || []).length}`);
        } catch (error) {
          console.warn(`[hub-desktop-ui] boot preset failed: ${String(error)}`);
        }
      }, 8000);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });

  // 管理者护栏：Yat2 只做调度，不许自己跑命令 / 改代码（只放行 .hub/ 下的黑板与路由文件）。
  if (restrictManagerTools) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next();
      if (!decision || decision.kind !== 'allow') return decision;
      try {
        const agent = exec && exec.agent;
        const title = agent ? titleOf(ctx, agent) : '';
        if (!/ · (Yat2|Hermes)$/.test(String(title || ''))) return decision;
        const toolName = exec.name
          || (exec.tool && exec.tool.name)
          || (exec.call && exec.call.name) || '';
        // exec 的参数在 exec.arguments（dsh-tools createExecution：{ name, arguments: deepFreeze(...) }），
        // 不是 exec.args / exec.call.arguments——之前取错位置，路径永远为空，连 .hub/ 都被拦。
        const args = exec.arguments
          || exec.args
          || (exec.call && (exec.call.arguments || exec.call.args))
          || {};
        if (toolName === 'pwsh' || toolName === 'run_code') {
          // 只读视觉命令白名单：vt.sh（含 `bash …/vt.sh glance …` 全路径调用），
          // 或直接以 glance/ground/detect/crop 开头——且都不含串联/重定向字符才放行管理者。
          const cmd = String(args.command || args.script || '').trim();
          const visionReadOnly = !/[;&|<>]/.test(cmd)
            && (/(^|[\s/])vt\.sh(\s|$)/.test(cmd)
              || /^(glance|ground|detect|crop)(\s|$)/.test(cmd));
          if (!visionReadOnly) {
            return {
              kind: 'deny',
              reason: `你是管理者（${title.split(' · ').pop()}），不许自己跑命令（只读看图的 vt.sh / glance 除外）。用 taskline_prompt 把这条派给成员（如 DSH工程师）。`,
            };
          }
        }
        if (toolName === 'edit' || toolName === 'write' || toolName === 'notebook_edit') {
          const path = String(args.file_path || args.path || args.target || '');
          // 白名单（2026-10-22 用户令）：① .hub/（黑板/tasks/routing）；② 共享记忆库 memory/——
          // 管理者可直接沉淀规则，不必派成员代写。统一 resolve 到 workspace 根后校验前缀，
          // 相对/绝对路径都认，且防穿越。
          let inHub = false;
          let inMemory = false;
          try {
            const resolved = resolve(hostRoot(ctx), path);
            const hubRoot = resolve(hostRoot(ctx), '.hub');
            const memoryRoot = resolve(hostRoot(ctx), 'memory');
            inHub = resolved.startsWith(hubRoot + sep);
            inMemory = resolved === memoryRoot || resolved.startsWith(memoryRoot + sep);
          } catch { /* 解析失败按不匹配 */ }
          if (!inHub && !inMemory) {
            return {
              kind: 'deny',
              reason: `你是管理者，不许自己改代码/文件（只允许写 .hub/ 的黑板/tasks/routing 与共享记忆库 memory/）。把「${path || '这个文件'}」的改动派给成员。`,
            };
          }
          // 黑板字数上限护栏（2026-10-23）：write 是全量覆盖，能预判最终长度 → 超限直接拒，
          // 逼管理者先归档（.hub/projects/<项目>/board-archive-YYYYMM.md）再写。
          // edit 是局部替换、无法预知最终长度，只有协议 + 房间顶部度量提示。
          if (toolName === 'write' && /[\\/]board\.md$/i.test(path)) {
            const content = typeof args.content === 'string' ? args.content : '';
            if (content.length > BOARD_MAX_CHARS) {
              return {
                kind: 'deny',
                reason: `黑板超过上限：这份 write 有 ${content.length} 字符 > ${BOARD_MAX_CHARS}。`
                  + `先把较老的「已完成/历史结论」追加到同目录 board-archive-YYYYMM.md（只追加），`
                  + `再从 board.md 删掉它们，只保留 目标/成员/进行中/最近 5–10 条已完成/产物路径入口，然后再写。`,
              };
            }
          }
        }
        return decision;
      } catch (error) {
        console.warn(`[hub-desktop-ui] manager guard failed: ${String(error)}`);
        return decision;
      }
    }, { prepend: true });
  }

  // 黑板体积闸（P7-②，2026-10-28 夜会）：对**所有 agent** 的 board.md write/edit 生效——
  // >20k 拒绝并提示拆分归档；12k–20k 每会话首次拦截一次提示整理（重试即放行），之后放行。
  // 背景：黑板两次被写到 21,684 字符（>20k 硬上限），协议有规则（73b625b）但缺执行闸。
  {
    const BOARD_SOFT_CHARS = 12000;
    const boardNudgeDone = new Set();   // `${agentId}:${file}` → 已提示过一次
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next();
      if (!decision || decision.kind !== 'allow') return decision;
      try {
        const toolName = exec.name || (exec.tool && exec.tool.name) || (exec.call && exec.call.name) || '';
        if (toolName !== 'write' && toolName !== 'edit') return decision;
        const args = exec.arguments || exec.args || (exec.call && (exec.call.arguments || exec.call.args)) || {};
        const path = String(args.file_path || args.path || args.target || '');
        if (!/[\\/]board\.md$/i.test(path)) return decision;
        let projected = -1;
        if (toolName === 'write') {
          projected = typeof args.content === 'string' ? args.content.length : -1;
        } else {
          // edit：用 当前文件长度 - old + new 估算最终长度
          try {
            const cur = readFileSync(resolve(hostRoot(ctx), path), 'utf8');
            const oldLen = typeof args.old_string === 'string' ? args.old_string.length : 0;
            const newLen = typeof args.new_string === 'string' ? args.new_string.length : 0;
            projected = cur.length - oldLen + newLen;
          } catch { /* 读不到当前文件就跳过估算 */ }
        }
        if (projected < 0) return decision;
        // P12-②（2026-11-02 用户令）：>20k 不再硬拒——改为「警告 + 显式确认放行」。
        // 合法长条目曾被误杀（星阶·Yat2 实报）。确认标记：写入内容里含 `<!-- board-confirm -->`
        // 或 `[board-confirm]`（写在任意位置即可，可随后删掉）；没有标记才拒，并给出归档指引。
        if (projected > BOARD_MAX_CHARS) {
          const content = toolName === 'write'
            ? String(args.content || '')
            : `${String(args.new_string || '')}`;
          const confirmed = /<!--\s*board-confirm\s*-->|\[board-confirm\]/i.test(content);
          if (!confirmed) {
            return {
              kind: 'deny',
              reason: `黑板将超上限：写入后约 ${projected} 字符 > ${BOARD_MAX_CHARS}（软上限，非硬禁）。\n`
                + `两条路任选：\n`
                + `① 先归档：把「已完成/历史结论」追加到同目录 board-archive-YYYYMM.md（只追加），`
                + `再从 board.md 删掉对应内容，只保留 目标/成员/进行中/最近 5–10 条已完成/产物路径入口；\n`
                + `② 确属必要长条目：在本次写入内容里加一行确认标记 <!-- board-confirm -->（写后可删），重试即放行。`,
            };
          }
          console.warn(`[hub-desktop-ui] board over limit but confirmed: ${projected} chars (${path})`);
          return decision;
        }
        if (projected > BOARD_SOFT_CHARS) {
          const agent = exec && exec.agent;
          const key = `${agent ? agent.id : 'anon'}:${path}`;
          if (boardNudgeDone.has(key)) return decision;   // 每会话只提示一次，重试放行
          boardNudgeDone.add(key);
          return {
            kind: 'deny',
            reason: `【整理提示·每会话一次】写入后黑板约 ${projected} 字符（>12k 整理线，<20k 硬上限）。`
              + `顺手把已完成老条目挪 board-archive-YYYYMM.md 再写；若确属必要内容，直接重试本次写入即放行。`,
          };
        }
        return decision;
      } catch (error) {
        console.warn(`[hub-desktop-ui] board size guard failed: ${String(error)}`);
        return decision;
      }
    });
  }

  // 任务线管理工具：让管理者（Yat2）能直接操作任意会话（派活 / 改名 / 归档 / 新建）。

  ctx.inject(['tools'], (hub) => {
    const tools = hub.tools;
    if (!tools || typeof tools.register !== 'function') return;


    const resolveSession = (ref) => {
      const sessions = hub.get('sessions');
      const list = sessions && typeof sessions.list === 'function' ? sessions.list() : [];
      const exact = list.find((session) => session.id === ref);
      if (exact) return exact;
      return list.find((session) => titleOfSession(session) === ref)
        || list.find((session) => titleOfSession(session).includes(ref))
        || undefined;
    };

    // 2026-10-29：本作用域后面有个局部 `const titleOf = (row)=>…`（tasks 行用）会遮蔽文件级
    // titleOf(ctx, agent)——成员护栏需要的是后者。这里内联同逻辑、避开遮蔽（不要改成 titleOf）。
    const callerTitleOf = (agent) => {
      try {
        if (!agent) return '';
        const sessions = hub.get('sessions');
        const store = sessions && typeof sessions.get === 'function' ? sessions : undefined;
        const session = store ? store.get(agent.id) : undefined;
        if (!session) return '';
        const titles = hub.get('sessionTitle');
        const snapshot = titles && typeof titles.get === 'function' ? titles.get(session) : undefined;
        return String((snapshot && snapshot.title) || '');
      } catch (error) { return ''; }
    };

    const register = (definition) => {
      try {
        return tools.register(definition);
      } catch (error) {
        console.warn(`[hub-desktop-ui] tool ${definition.name} failed: ${String(error)}`);
        return undefined;
      }
    };

    // 运行中判定：用**官方状态事件**自维护一个集合，不依赖 list 行里现算的字段
    //（实测该字段在工具执行瞬间恒为 false，连正在跑的会话也不标）。
    // api-session/status(sessionId, running) = 「One Agent changed running state」；
    // api-session/added 的 summary 也带 running；agent/disposed 时清掉。
    const liveRunning = new Set();
    hub.on('api-session/status', (sessionId, running) => {
      try {
        const key = String(sessionId);
        if (running) liveRunning.add(key);
        else liveRunning.delete(key);
      } catch (error) { /* 状态事件不该影响主流程 */ }
    });
    hub.on('api-session/added', (summary) => {
      try {
        const key = summary && summary.sessionId ? String(summary.sessionId) : '';
        if (!key) return;
        if (summary.running) liveRunning.add(key);
        else liveRunning.delete(key);
      } catch (error) { /* ignore */ }
    });
    hub.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent;
        if (agent && agent.id !== undefined) liveRunning.delete(String(agent.id));
      } catch (error) { /* ignore */ }
    });

    /** 当前是否运行中：事件集合优先，其次 agent.status（不依赖 list 行字段）。 */
    const isRunningNow = (sessionId) => {
      const key = String(sessionId);
      if (liveRunning.has(key)) return true;
      try {
        const agents = hub.get('agents');
        const agent = agents && typeof agents.get === 'function' ? agents.get(key) : undefined;
        return Boolean(agent && String(agent.status) === 'running');
      } catch (error) {
        return false;
      }
    };

    /**
     * taskline_prompt 的**唯一**运行状态快照（2026-11-09 用户令：一次快照 + 单一决策）。
     * 以前开头用 isRunningNow（事件集合 + agent.status）、末尾用 isSessionRunning
     * （Map + controller.list）各查一次 → 状态切换瞬间两份快照分歧，返回体自相矛盾。
     * 现在把三路证据收成一份，交给纯函数 decideRunning 落成一个结论。
     * @returns {Promise<{running: boolean, source: string}>}
     */
    const snapshotTargetRunning = async (sessionId) => {
      const key = String(sessionId || '');
      if (!key) return { running: false, source: 'none' };
      let agentStatus;
      try {
        const agents = hub.get('agents');
        const agent = agents && typeof agents.get === 'function' ? agents.get(key) : undefined;
        if (agent && typeof agent.status === 'string' && agent.status) agentStatus = agent.status;
      } catch (error) { /* ignore */ }
      const eventSeen = liveRunning.has(key); // 本作用域事件集合只收 running
      const lastEvent = lastEventRunning(key); // apply 作用域的明确 true/false
      const verdict = decideRunning({ agentStatus, eventSeen, lastEvent });
      if (verdict.source !== 'unknown') return verdict;
      // 只有三路都没证据（冷会话刚 resume）才退到 list 行兜底
      const listRow = await isSessionRunning(key);
      return decideRunning({ agentStatus, eventSeen, lastEvent, listRow });
    };

    /**
     * 等某个 agent 变成 idle（只挂事件 + 一次定时器，不轮询）。
     * interrupt 用完它回报「会话是否真的空闲了」，避免工具返回时它还在收尾。
     * @param {string} sessionId - 目标会话。
     * @param {number} timeoutMs - 上限毫秒；abort 慢于该值时返回 false（不等于中断失败）。
     * @returns {Promise<boolean>} true=观察到 idle；false=超时或没 agent。
     */
    const waitForAgentIdle = (sessionId, timeoutMs) => new Promise((resolveIdle) => {
      const key = String(sessionId);
      if (!isRunningNow(key)) { resolveIdle(true); return; }
      let settled = false;
      let off;
      let timer;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (typeof off === 'function') {
          try { off(); } catch (error) { /* ignore */ }
        }
        resolveIdle(value);
      };
      timer = setTimeout(() => done(false), Math.max(100, Number(timeoutMs) || INTERRUPT_IDLE_WAIT_MS));
      if (timer && typeof timer.unref === 'function') timer.unref();
      off = hub.on('api-session/status', (changedId, running) => {
        try {
          if (String(changedId) !== key) return;
          if (!running) done(true);
        } catch (error) { /* ignore */ }
      });
      // 竞态兜底：cancel 可能在挂监听之前就完成了状态切换，挂完再读一次真实状态
      if (!isRunningNow(key)) done(true);
    });

    hub.effect(() => {
      const disposers = [];

      // 2026-11-10 拆包：taskline_list 已搬进 dsh-agent-tasks

      // 2026-11-10 拆包：taskline_prompt 已搬进 dsh-agent-tasks

      // —— agent_message（2026-10-23 用户令：不同 agent 之间要能直接交流，跨项目也要能）——
      // 交流 ≠ 派活：互发消息（讨论/要资料/同步状态/协作求解）全放行含跨项目；
      // 正式派活/建线仍限本项目（taskline_prompt 的项目边界护栏保留，那边管派活）。
      // 交流消息不进群聊任务线（2026-10-23 信息架构规则）：投递文本带【来自 <调用方>】前缀，
      // 压缩层/归线判据会把它当 agent 侧过程消息处理（Yat2 归 _none / 不归）。
      // —— P3 唤醒兜底（2026-10-27 杨航拍板：允许跨项目自动唤醒）——
      // 病因：ensureLiveSession 虽 resume 了 Agent，但 controller.prompt 只入队，目标空闲时
      // 没有东西启动回合 → 实测 lastTurn+1 而 response=""。这里投递后短观察，仍非 running
      // 就复用 resume_session 的实现唤醒一次；每目标 60s 去重、每小时最多 3 次。
      const AGENT_MSG_WAKE_LIMIT = 3;
      const AGENT_MSG_WAKE_WINDOW_MS = 3600 * 1000;
      const AGENT_MSG_WAKE_GAP_MS = 60 * 1000;
      const agentMsgWakeLog = new Map();
      const agentMsgIsRunning = (sessionId) => {
        try {
          const agentsSvc = hub.get('agents');
          if (!agentsSvc || typeof agentsSvc.get !== 'function') return false;
          const id = String(sessionId);
          const agent = agentsSvc.get(id) || agentsSvc.get(id.replace(/^session-/, ''));
          return Boolean(agent && String(agent.status) === 'running');
        } catch {
          return false;
        }
      };
      const agentMsgWakeAllowed = (sessionId) => {
        const key = String(sessionId);
        const now = Date.now();
        const hits = (agentMsgWakeLog.get(key) || []).filter((t) => now - t < AGENT_MSG_WAKE_WINDOW_MS);
        agentMsgWakeLog.set(key, hits);
        if (hits.length >= AGENT_MSG_WAKE_LIMIT) return { ok: false, reason: 'rate-limited' };
        if (hits.length && now - hits[hits.length - 1] < AGENT_MSG_WAKE_GAP_MS) return { ok: false, reason: 'recently-woken' };
        return { ok: true, key };
      };
      const wakeAgentMessageTarget = async (sessionId) => {
        try {
          if (agentMsgIsRunning(sessionId)) return { woke: false, reason: 'already-running' };
          await new Promise((r) => setTimeout(r, 800));
          if (agentMsgIsRunning(sessionId)) return { woke: false, reason: 'starting' };
          const gate = agentMsgWakeAllowed(sessionId);
          if (!gate.ok) return { woke: false, reason: gate.reason };
          const result = await resumeInterruptedSessions(hub, { force: true, only: String(sessionId), max: 1 });
          const resumed = Boolean(result && Array.isArray(result.resumed) && result.resumed.length);
          if (resumed) {
            const now = Date.now();
            const hits = (agentMsgWakeLog.get(gate.key) || []).filter((t) => now - t < AGENT_MSG_WAKE_WINDOW_MS);
            hits.push(now);
            agentMsgWakeLog.set(gate.key, hits);
          }
          return { woke: resumed, reason: resumed ? '' : 'resume-no-op' };
        } catch (error) {
          return { woke: false, reason: `wake-failed: ${String((error && error.message) || error)}` };
        }
      };

      // 2026-11-10 拆包：agent_message 已搬进 dsh-agent-tasks
      disposers.push(...registerAgentTools({
          hub,
          register,
          // 这 12 个都是本函数闭包里的局部符号（不是模块级），必须显式注入：
          // 10 个 helper 函数 + liveRunning（Map，共享引用）/ queueTriageEnabled（开关快照）
          deps: {
            callerTitleOf,
            isRunningNow,
            pendingDispatchesOf,
            recordDispatch,
            resolveSession,
            snapshotTargetRunning,
            spawnQueueTriage,
            titleOfSession,
            waitForAgentIdle,
            wakeAgentMessageTarget,
            liveRunning,
            queueTriageEnabled,
            // 2026-11-10 补：taskline_create 不传 preset 时要回退到默认预设。
            // 迁包前这个变量在外层 apply 作用域里直接可见，迁包后必须显式注入，
            // 否则 taskline_create({ title }) 会 ReferenceError（`args.preset || defaultPreset` 短路掩盖了它）。
            defaultPreset,
          },
        }));

      // —— taskline_wait（2026-10-22）——
      // 管理者派完活的闭环：等成员状态变化，**不轮询**。一个调用 = 一个 Promise + 事件监听
      // + 一次 setTimeout；事件来自 Host：api-session/status（running 翻 false）与
      // session/event（turn/end、新的 user/message）。没有任何目标在跑 → 立刻 noProgress。
      // 2026-11-10 拆包：taskline_wait 已搬进 dsh-agent-tasks

      // 查询某个会话当前的 goal（2026-10-22）：派活后用它核验「goal 真的建进会话了」，
      // 读的是 DSH goal 服务折叠出的会话态（等价于该会话日志里的 goal/change 事件）。
      // 2026-11-10 拆包：taskline_goal_status 已搬进 dsh-agent-tasks

      // 手动续跑兜底：让管理者点名某个被中断的会话从断点继续（绕过 24h 账本，force=true）

      // 2026-11-10 拆包：resume_session 已搬进 dsh-agent-tasks

      // 2026-11-10 拆包：taskline_rename 已搬进 dsh-agent-tasks

      // 2026-11-10 拆包：taskline_archive 已搬进 dsh-agent-tasks

      // 2026-11-10 拆包：taskline_messages 已搬进 dsh-agent-tasks

      // —— routing_put（P5，2026-10-27 夜场会议产出）——
      // 背景：三位管理者手写 read+edit routing.json 撞盘重写约 10 次/轮。本工具做
      // 「读→合并→原子写」，配合既有的 guardRoutingFile 自愈（对手工条目零破坏）。
      // 语义：entries = { "<eventId>": "<taskId>" }；或给 lane 把 ids 全归同一条线。
      // taskId 校验：必须是 _none / meeting / t 开头（t<数字>），防手滑写成员名进去。
      // 2026-11-10 拆包：routing_put 已搬进 dsh-agent-tasks

      // 2026-11-10 拆包：taskline_create 已搬进 dsh-agent-tasks

      // vision_read（2026-10-26 用户要求；2026-10-27 加硬约束）：给**不能直接读图**的模型一个"看图工具"——
      // 把本地图片交给视觉模型（skills/vision-tools 的 glance，Ark 兜底），只把文字结果返回。
      // ⛔ 用户令（2026-10-27）：**视觉模型调用即违规**——能收图的模型必须自己读附件/read_image。
      // 2026-11-10 拆包：vision_read 已搬进 dsh-agent-tasks

      return () => {
        for (const dispose of disposers) {
          try { if (typeof dispose === 'function') dispose(); } catch (error) { /* ignore */ }
        }
      };
    }, 'hub-desktop-ui:taskline-tools');
  });

  // 手机端桥（DSH Sync）：固定端口 + 独立 token，与 Web GUI 的「随机端口 + GUI token」解耦。
  // 只读/写入都走 Host 服务（sessionController / sessions / agents），语义与 GUI 一致。
  if (syncBridgeEnabled) {
    try {
      const bridge = startSyncBridge(ctx, {
        // root 故意不传：桥内每次请求惰性解析（apply 时 workspaceRegistry 还没登记仓库，
        // 这里传 hostRoot(ctx) 会把 profile 目录钉死成 override）
        host: String(config.syncBridgeHost || '0.0.0.0'),
        ports: Array.isArray(config.syncBridgePorts) ? config.syncBridgePorts.map(Number) : undefined,
      });
      if (bridge) {
        ctx.effect(() => () => { bridge.close(); });
      }
    } catch (error) {
      console.warn(`[hub-desktop-ui] sync bridge failed: ${String(error)}`);
    }
  }

  // 桌面窗口：应用启动后恢复为最大化（2026-11-11 用户「为什么每次 DSH 重启都不会自动全屏」）。
  // 根因在外壳侧、我们改不到：Electron `lib/main.js:20103` 的 createWindow() 写死 1280×820，
  // 既不存档窗口状态也没有最大化/全屏参数，userData 的 settings.json schema 只有 updates 一个键。
  // 这里用 Win32 ShowWindow 兜底；只对「应用刚启动」生效，Host 单独重启不会重置窗口。
  // 关掉：profile 里配 config.windowMaximizeOnStart: false。
  if (config.windowMaximizeOnStart !== false) {
    try {
      maximizeDesktopWindowOnStart();
    } catch (error) {
      console.warn(`[hub-desktop-ui] window-state watcher failed: ${String(error)}`);
    }
  }
}






