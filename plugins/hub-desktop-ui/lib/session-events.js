/**
 * 会话事件池 + 「渲染用精简事件」（Host 半）。
 *
 * 为什么放在 Host 侧：分身分列要求「每一列都显示该会话的完整对话」，但客户端
 * 只能通过 `sessions.retain(id)` → `binding.eventSource.getSnapshot()` 拿事件，
 * 而那条路只有**本 Client 已经打开过**的会话才有窗口快照；冷会话（分列里绝大多数
 * 列）拿不到任何事件，旧实现于是每列只剩一行「点 ↗ 打开」占位。
 *
 * 这里给客户端一条只读的持久事件通道：
 * - 活会话：直接取 Host 内存事件（含本轮正在跑的）；
 * - 冷会话：`sessionController.inspect(id)` 只读持久层，**不激活 agent**。
 *
 * 另外持久日志里的 `assistant/message` 是压缩形态——正文不在 `data.message` 里，
 * 而在 `assistant/chunk` 的 `block-end` / `text-chunks` / `reasoning-chunks` 里
 * （同 `lib/sync-bridge.js` 的 scanConversation，2026-10-20 对真实日志逐条核对过）。
 * 客户端只读 `data.message` 会把 agent 回复整段丢掉，所以这里按 turn:step 重建
 * 文本，只回传渲染真正需要的字段。
 */

/** 一条 message 的 content → {text, reasoning}（真实日志里 reasoning 是 content 里的
 * `{type:'reasoning', text}` 块，2026-10-21 解压 `session.v4.jsonl.zstd` 核对过）。 */
function messageParts(message) {
  const parts = Array.isArray(message && message.content) ? message.content : [];
  let text = '';
  let reasoning = '';
  for (const part of parts) {
    if (!part || typeof part.text !== 'string') continue;
    if (part.type === 'text') text += part.text;
    else if (part.type === 'reasoning') reasoning += part.text;
  }
  return { text: text.trim(), reasoning: reasoning.trim() };
}

/** 数据流里的 `block-end` 文本（兼容数组 / `{chunks}` / `{events}` 三种包法）。 */
function streamText(stream) {
  if (!stream) return '';
  const chunks = Array.isArray(stream)
    ? stream
    : Array.isArray(stream.chunks)
      ? stream.chunks
      : Array.isArray(stream.events)
        ? stream.events
        : [];
  const texts = [];
  for (const chunk of chunks) {
    const block = chunk && chunk.block;
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('').trim();
}

/** 工具名：`data.name` 为主，兼容常见别名（与客户端 toolNameOf 同口径）。 */
function toolNameOf(event) {
  const data = (event && event.data) || {};
  const call = data.call || {};
  const name = data.name || data.toolName || data.tool || call.name || '';
  return typeof name === 'string' && name ? name : 'tool';
}

/** 工具调用 id：`data.callId` 为主，兼容 call 对象内字段。 */
function toolCallIdOf(event) {
  const data = (event && event.data) || {};
  const call = data.call || {};
  return data.callId || data.callID || call.callId || call.id || '';
}

/** 任意值 → 短摘要（对象 JSON 化；超长截断），给工具参数/结果卡片用。 */
function briefOf(value, max) {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value !== undefined && value !== null) {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** tool/result 的 message.content（块数组）→ 纯文本摘要。 */
function resultBrief(message, max) {
  if (!message) return '';
  const parts = Array.isArray(message.content) ? message.content : [];
  const texts = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part.type === 'image') texts.push('[图片]');
  }
  return briefOf(texts.join('\n'), max);
}

/**
 * 原始事件 → 客户端可渲染的精简事件（`user/message` / `assistant/message` /
 * `step/start` / `tool/call` / `tool/result`），其余类型丢弃（工具输出等正文太大，
 * 分列只看消息与分步耗时）。
 * @param {Array<object>} events 原始事件（按 seq 升序；顺序不对这里会排）。
 * @returns {{events: Array<object>, lastSeq: number, streaming: string}}
 */
export function compactSessionEvents(events) {
  const source = Array.isArray(events) ? events.slice() : [];
  source.sort((a, b) => (Number(a && a.seq) || 0) - (Number(b && b.seq) || 0));

  const out = [];
  const blocks = new Map();     // stepKey -> Map(index -> {type, text})
  const consumed = new Set();   // 已被 assistant/message 消费的 stepKey
  const callIdBySeq = new Map(); // tool/call seq -> callId（给不带 callId 的 tool/result 配对）
  let lastKey = '';
  let lastSeq = 0;

  const keyOf = (data) => {
    if (data && data.turn !== undefined && data.step !== undefined) return `${data.turn}:${data.step}`;
    return lastKey;
  };
  const bucketOf = (key) => {
    if (!blocks.has(key)) blocks.set(key, new Map());
    return blocks.get(key);
  };
  const append = (key, index, type, text, replace) => {
    const map = bucketOf(key);
    const previous = map.get(index);
    if (replace) {
      map.set(index, { type, text });
      return;
    }
    map.set(index, {
      type: previous && previous.type ? previous.type : type,
      text: `${previous ? previous.text : ''}${text}`,
    });
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
  const emit = (event, type, data) => {
    const seq = Number(event.seq);
    const entry = { type, seq: Number.isFinite(seq) ? seq : out.length, time: Number(event.time) || 0 };
    if (data !== undefined) entry.data = data;
    out.push(entry);
    if (Number.isFinite(seq) && seq > lastSeq) lastSeq = seq;
  };

  for (const event of source) {
    if (!event || typeof event.type !== 'string') continue;
    const data = event.data || {};
    // lastSeq 记「已读到哪个位置」= 源事件的最大 seq（chunk 事件虽不回传，也算读过）
    const sourceSeq = Number(event.seq);
    if (Number.isFinite(sourceSeq) && sourceSeq > lastSeq) lastSeq = sourceSeq;

    if (event.type === 'assistant/chunk') {
      const chunk = data.chunk || {};
      if (data.turn !== undefined && data.step !== undefined) lastKey = `${data.turn}:${data.step}`;
      if (chunk.type === 'block-end' && chunk.block && typeof chunk.block.text === 'string') {
        // block-end 是整块全文（权威版）：覆盖，避免与增量 chunk 叠加成双份
        append(lastKey, String(chunk.index === undefined ? 0 : chunk.index), String(chunk.block.type || 'text'), chunk.block.text, true);
      }
      continue;
    }

    if (event.type === 'text-chunks' || event.type === 'reasoning-chunks') {
      if (data.turn !== undefined && data.step !== undefined) lastKey = `${data.turn}:${data.step}`;
      const texts = Array.isArray(data.texts) ? data.texts.join('') : '';
      if (texts) append(lastKey, String(data.index === undefined ? 0 : data.index), event.type === 'text-chunks' ? 'text' : 'reasoning', texts, false);
      continue;
    }

    if (event.type === 'user/message') {
      const message = data.message || data;
      const source_ = message.source || {};
      // 插件注入的提醒/协议不是用户发的话，与客户端 eventText 同口径过滤
      if (source_.kind && source_.kind !== 'user') continue;
      const text = messageParts(message).text;
      if (!text) continue;
      emit(event, 'user/message', {
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
      continue;
    }

    if (event.type === 'assistant/message') {
      const direct = data.message;
      const usage = direct && direct.usage ? direct.usage : data.usage;
      const parts = messageParts(direct);
      const key = keyOf(data);
      let text = parts.text;
      if (!text) text = textOfStep(key);
      if (!text) text = streamText(data.stream);
      // 思考过程：优先取 message.content 里的 reasoning 块（真实日志形态），
      // 其次取本步攒下的 chunk 块（读过即清，同一步第二条消息不重复带）
      let reasoning = parts.reasoning;
      const stepMap = blocks.get(key);
      if (!reasoning && stepMap) {
        reasoning = [...stepMap.entries()]
          .filter(([, block]) => block.type === 'reasoning')
          .map(([, block]) => block.text).join('').trim();
      }
      if (stepMap) {
        for (const [index, block] of [...stepMap.entries()]) {
          if (block.type === 'reasoning') stepMap.delete(index);
        }
      }
      reasoning = briefOf(reasoning, 4000);
      if (!text && !reasoning) continue;
      consumed.add(key);
      // 只有思考、没有正文的步骤（工具调用轮常见）：单独发一条 reasoning 事件，
      // 客户端渲染成「💭 思考」折叠块，不伪造空气泡。
      if (!text) {
        emit(event, 'assistant/reasoning', { reasoning });
        continue;
      }
      const outputTokens = usage ? Number(usage.outputTokens) : NaN;
      emit(event, 'assistant/message', {
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        ...(reasoning ? { reasoning } : {}),
        ...(Number.isFinite(outputTokens) && outputTokens > 0 ? { usage: { outputTokens } } : {}),
      });
      continue;
    }

    if (event.type === 'step/start') {
      emit(event, 'step/start');
      continue;
    }

    if (event.type === 'tool/call') {
      // arguments 是对象（agent-loop appendToolCall：{turn,step,callId,name,arguments}）→ 短摘要
      const callId = toolCallIdOf(event);
      const callSeq = Number(event.seq);
      if (Number.isFinite(callSeq) && callId) callIdBySeq.set(callSeq, callId);
      emit(event, 'tool/call', {
        callId,
        name: toolNameOf(event),
        ...(data.arguments !== undefined ? { args: briefOf(data.arguments, 300) } : {}),
      });
      continue;
    }

    if (event.type === 'tool/result') {
      const message = data.message;
      const brief = resultBrief(message, 500);
      // 真实 tool/result 不带 callId（只有 message），配对信息在事件级 sourceEventSeqs
      const seqs = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
      const callSeq = seqs.length ? Number(seqs[0]) : NaN;
      const viaSeq = seqs.length ? callIdBySeq.get(Number(seqs[0])) : undefined;
      emit(event, 'tool/result', {
        callId: toolCallIdOf(event) || viaSeq || '',
        // 精简 payload 里没有事件级 sourceEventSeqs，把配对用的 call seq 压进 data
        ...(Number.isFinite(callSeq) ? { callSeq } : {}),
        ...(brief ? { brief } : {}),
        ...(message && message.isError ? { error: true } : {}),
      });
    }
  }

  // 最后一步还没等到 assistant/message 落幕时，把已到的文本给客户端做「生成中」预览
  const streaming = lastKey && !consumed.has(lastKey) ? textOfStep(lastKey) : '';
  return { events: out, lastSeq, streaming };
}

/**
 * 读一个会话的原始事件池：活会话走内存，冷会话走 `sessionController.inspect`
 * （只读持久层，不 resume agent）。
 * @param {object} ctx Host cordis 上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<{events: Array<object>, live: boolean}>}
 */
export async function readSessionEvents(ctx, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return { events: [], live: false };
  const pools = [];
  const collect = (value) => {
    if (Array.isArray(value)) { pools.push(value); return true; }
    if (value && Array.isArray(value.entries)) { pools.push(value.entries); return true; }
    return false;
  };

  let live = false;
  try {
    const store = ctx.get('sessions');
    const attached = store && typeof store.get === 'function' ? store.get(id) : undefined;
    if (attached) {
      if (!collect(attached.events) && typeof attached.snapshotEvents === 'function') collect(attached.snapshotEvents());
      live = pools.length > 0;
    }
  } catch { /* 拿不到活会话就当冷的处理 */ }

  if (!live) {
    try {
      const controller = ctx.get('sessionController');
      if (controller && typeof controller.inspect === 'function') {
        const info = await controller.inspect(id);
        for (const candidate of [info && info.events, info && info.entries, info && info.prefix, info && info.record && info.record.events]) {
          if (collect(candidate)) break;
        }
      }
    } catch { /* 会话不存在 / 读不到 → 空池 */ }
  }

  return { events: pools[0] || [], live };
}