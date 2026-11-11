import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const name = "ai-agent-hub-curator";
export const inject = ["llm"];

/** 调试输出：默认静默，DSH_CURATOR_DEBUG=1 时才打印（之前这里直接调用了未定义的 dbg，每轮抛 ReferenceError）。 */
function dbg(...args) {
  if (process.env.DSH_CURATOR_DEBUG) console.log("[ai-agent-hub-curator]", ...args);
}

const CURATOR_PROMPT = `你是 AI-Agent-Hub 的经验升级 curator。根据下面提供的最近对话摘要，判断是否出现值得长期沉淀的稳定经验。
只沉淀：用户纠正或确认的规则、可复用的根因/踩坑/正确做法、提效方法、新工具/路径/项目约定。
跳过：临时状态、原始日志、一次性路径、可随时重查的事实、未确认推测。
不要读取 transcript、session 日志或凭据；只基于摘要。不要执行任何工具。
输出严格 JSON：{"action":"skip|memory|skill|hook","target":"建议更新的 memory 文件名或 skill 名（skip 时留空）","note":"一句话理由"}。

最近对话摘要：
`;

// Lightweight signal detection mirroring post_turn_curator.py patterns.
const USER_SIGNAL = /(你.{0,8}(错了|不对|搞错|误解)|不是这样|纠正|应当是|实际是|以后|下次|始终|一律|统一|默认|必须|不要|别再|规则|约定|偏好|记一下|记住|写进记忆|新路径|新目录|装了|启用.{0,8}(工具|插件)|新工具|新模型|新依赖|提效|减少重复|自动化|可复用|踩坑|教训|根因|问题在于|正确做法)/i;

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function collectRecentEvents(session, recentTurns, maxChars) {
  const events = session?.events ?? [];
  const parts = [];
  let chars = 0;
  for (let i = events.length - 1; i >= 0 && parts.length < recentTurns * 4 && chars < maxChars; i--) {
    const event = events[i];
    const type = event?.type;
    let text = "";
    if (type === "user/message" || type === "assistant/message") {
      const data = event.data ?? {};
      // session.events carries the raw message shape; the history API wraps it in {message}.
      text = textOf(data.message ?? data);
    } else continue;
    if (!text.trim()) continue;
    parts.unshift(`[${type}] ${text}`);
    chars += text.length;
  }
  return parts.join("\n").slice(-maxChars);
}

async function streamText(ctx, provider, model, prompt, maxTokens, signal) {
  const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  const options = { provider, model, messages, maxTokens, purpose: "curator", ...(signal ? { signal } : {}) };
  const chunks = [];
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk);
  // chunks are MessageChunk; aggregate text blocks
  const text = chunks
    .map((chunk) => (chunk?.type === "text" ? chunk.text : ""))
    .join("");
  return text || "";
}

export function parseAction(text) {
  const cleaned = String(text ?? "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const pick = (re) => {
    const m = cleaned.match(re);
    return m ? m[1].trim() : "";
  };
  try {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const data = JSON.parse(cleaned.slice(start, end + 1));
      const action = String(data.action || "skip").toLowerCase();
      if (["skip", "memory", "skill", "hook"].includes(action)) {
        return { action, target: String(data.target || ""), note: String(data.note || "") };
      }
    }
  } catch {
    // fall through to regex recovery
  }
  const action = pick(/"action"\s*:\s*"([^"]+)"/).toLowerCase();
  if (["skip", "memory", "skill", "hook"].includes(action)) {
    return {
      action,
      target: pick(/"target"\s*:\s*"([^"]*)"/),
      note: pick(/"note"\s*:\s*"([^"]*)"/),
    };
  }
  return { action: "skip", target: "", note: "unparseable model output" };
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    suggestionsFile: rawConfig.suggestionsFile ?? resolve(process.env.USERPROFILE ?? "", "Documents", "GitHub", "AI-Agent-Hub", "memory", "curator_suggestions.md"),
    intervalTurns: rawConfig.intervalTurns ?? 5,
    minIntervalMs: rawConfig.minIntervalMs ?? 60_000,
    recentTurns: rawConfig.recentTurns ?? 3,
    maxChars: rawConfig.maxChars ?? 5000,
    maxTokens: rawConfig.maxTokens ?? 800,
    signalThreshold: rawConfig.signalThreshold !== false,
    runCurator: rawConfig.runCurator !== false,
    curatorProvider: rawConfig.curatorProvider ?? "",
    curatorModel: rawConfig.curatorModel ?? "",
  };
  const lastRun = /* @__PURE__ */ new Map();

  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    // Detached: never block the event path.
    setImmediate(() => {
      runCurator(ctx, config, session, lastRun).catch((error) => {
        console.warn(`ai-agent-hub-curator: ${String(error)}`);
      });
    });
  });
}

async function runCurator(ctx, config, session, lastRun) {
  if (!session) { dbg("no session"); return; }
  const now = Date.now();
  const previous = lastRun.get(session.id);
  const events = session.events ?? [];
  const turnCount = events.filter((event) => event?.type === "turn/start").length;
  if (previous && turnCount - previous.turns < config.intervalTurns && now - previous.time < config.minIntervalMs) return;
  lastRun.set(session.id, { turns: turnCount, time: now });

  const digest = collectRecentEvents(session, config.recentTurns, config.maxChars);
  if (!digest.trim()) { dbg("empty digest"); return; }

  if (config.signalThreshold && !USER_SIGNAL.test(digest)) return;

  const models = session.models ?? {};
  const provider = config.curatorProvider || models?.provider;
  const model = config.curatorModel || models?.model;
  const verdict = { action: "skip", target: "", note: "no model route" };
  if (provider && model && config.runCurator && ctx.llm) {
    const output = await streamText(ctx, provider, model, CURATOR_PROMPT + digest, config.maxTokens);
    Object.assign(verdict, parseAction(output));
  } else if (config.signalThreshold) {
    verdict.note = "signal detected but no LLM route; skipped";
  }

  const record = { turn: turnCount, ts: new Date().toISOString(), ...verdict };
  try {
    session.append("curator/review", { ...record, digestLength: digest.length });
  } catch (error) {
    // append of a plugin event type is best-effort; never fail the turn.
    console.warn(`ai-agent-hub-curator: append curator/review failed: ${String(error)}`);
  }
  if (verdict.action !== "skip" && verdict.note && verdict.note !== "no model route" && verdict.note !== "signal detected but no LLM route; skipped") {
    try {
      mkdirSync(resolve(config.suggestionsFile, ".."), { recursive: true });
      appendFileSync(config.suggestionsFile, `\n## ${new Date().toISOString()}  turn#${turnCount}  [${verdict.action}] ${verdict.target}\n${verdict.note}\n`, "utf8");
    } catch (error) {
      console.warn(`ai-agent-hub-curator: append suggestions failed: ${String(error)}`);
    }
  }
}
