import { realpathSync, existsSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const name = "ai-agent-hub-reminders";

const SCRIPT_ALLOWLIST = Object.freeze([
  "session_memory_check.py",
  "report_navigation_reminder.py",
  "hpc_parallel_check.py",
  "memory_update_reminder.py",
  "drawing_standards_check.py",
  "drawing_yh_template_required.py",
  "fork_prompt_reminder.py",
  "imitate_figure_reminder.py",
  "image_host_reminder.py",
  "enrichment_term_check.py",
  "humanizer_reminder.py",
  "ppt_standard_check.py",
  "ppt_from_report_check.py",
  "anti_hallucination_reminder.py",
  "answer_format_reminder.py",
  "url_format_reminder.py",
  "media_link_check.py",
  "analysis_method_standards_reminder.py",
  "figure_text_consistency_reminder.py",
  "zotero_first_reminder.py",
  "wiki_write_reminder.py",
  "memory_route_reminder.py",
  "ai_query_reminder.py",
  "figure_split_reminder.py",
  "test_session_cleanup_reminder.py",
  "figure_change_gate_reminder.py",
  "secret_store_reminder.py",
]);

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function directPrompt(messages) {
  const direct = [...messages].reverse().find((message) => message?.source?.kind === "user");
  return direct ? textOf(direct) : "";
}

// Session format v4 only admits producer-owned source kinds: the generic "plugin"
// wrapper was retired (v3 rows are migrated to `plugin:<name>`). Deep-freeze the
// message because the durable append requires an immutable value.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function noticeMessage(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: `plugin:${name}`,
      form: "notice",
      summary,
    },
  });
}

function minimalChildEnv() {
  const names = [
    "SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT",
    "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "LANG", "LC_ALL",
  ];
  const env = Object.fromEntries(names.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  // DSH_* 透传（2026-10-29 修复）：hooks（如 media_link_check.py）靠 DSH_HOME/DSH_SESSION_ID
  // 分流 DSH/Hermes 发图规则；之前最小白名单把它们剥掉，hook 在 DSH 会话里永远判定为 Hermes，
  // 注入 MEDIA:/#media: 这套 DSH 渲染不了的格式。
  for (const [key, value] of Object.entries(process.env)) {
    if (/^DSH_[A-Z0-9_]+$/.test(key)) env[key] = value;
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}

export function resolveAllowedScripts(hooksDir, requested = SCRIPT_ALLOWLIST) {
  const root = realpathSync(resolve(hooksDir));
  const allowed = new Set(SCRIPT_ALLOWLIST);
  return requested.map((filename) => {
    if (basename(filename) !== filename || !allowed.has(filename)) {
      throw new Error(`ai-agent-hub-reminders: script is not allowlisted: ${filename}`);
    }
    const script = realpathSync(join(root, filename));
    const rel = relative(root, script);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`ai-agent-hub-reminders: script escaped hooksDir: ${filename}`);
    }
    return Object.freeze({ filename, script });
  });
}

export function parseHookResponse(stdout) {
  const raw = String(stdout ?? "").trim();
  if (!raw) return undefined;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const context = data?.hookSpecificOutput?.additionalContext ?? data?.context;
  return typeof context === "string" && context.trim() ? context.trim() : undefined;
}

export function runHook(config, script, payload, signal) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.pythonCommand, [script], {
      cwd: config.hooksDir,
      env: minimalChildEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      error ? reject(error) : resolvePromise(value);
    };
    const abort = () => {
      child.kill();
      finish(new Error(`hook aborted: ${script}`));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`hook timed out: ${script}`));
    }, config.timeoutMs);
    if (signal) signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > config.maxBufferBytes) {
        child.kill();
        finish(new Error(`hook output exceeded limit: ${script}`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`hook failed (${code}): ${script}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      finish(undefined, parseHookResponse(Buffer.concat(stdout).toString("utf8")));
    });
    child.stdin.end(payload, "utf8");
  });
}

export function apply(ctx, rawConfig = {}) {
  try {
    return applyInner(ctx, rawConfig)
  } catch (e) {
    try {
      appendFileSync(process.env.TEMP + "/ai-agent-hub-reminders-error.txt",
        new Date().toISOString() + " APPLY-FAIL: " + (e && e.stack || e) + "\n")
    } catch {}
    throw e
  }
}

function applyInner(ctx, rawConfig = {}) {
  const config = {
    hooksDir: rawConfig.hooksDir,
    scripts: rawConfig.scripts ?? SCRIPT_ALLOWLIST,
    pythonCommand: "python",
    timeoutMs: rawConfig.timeoutMs ?? 30000,
    maxBufferBytes: rawConfig.maxBufferBytes ?? 1024 * 1024,
    sessionMemory: rawConfig.sessionMemory !== false,
  };
  // 2026-11-11 可移植性（第三方安装）：hooksDir 缺失 / 不存在 / 无脚本时**不再抛错**。
  // 原实现 `if (!config.hooksDir) throw` + `realpathSync(hooksDir)` 会让任何没配本机 hooks
  // 目录的用户一装就崩；现改为「插件正常加载、只是不跑 hook」，缺失的脚本逐个跳过
  // （部分 hook 缺失也照跑其余）。本机行为不变：hooksDir 存在且 25 个脚本齐全。
  const warn = (msg) => {
    try { ctx.logger?.warn?.(`[ai-agent-hub-reminders] ${msg}`); }
    catch { try { console.warn(`[ai-agent-hub-reminders] ${msg}`); } catch {} }
  };
  if (!config.hooksDir) {
    warn("hooksDir 未配置 —— 提醒 hook 全部跳过（插件本身正常加载）");
    return;
  }
  const hooksRoot = resolve(config.hooksDir);
  if (!existsSync(hooksRoot)) {
    warn(`hooksDir 不存在（${hooksRoot}）—— 提醒 hook 全部跳过`);
    return;
  }
  const present = config.scripts.filter((filename) => existsSync(join(hooksRoot, filename)));
  if (present.length === 0) {
    warn(`hooksDir 下没有任何白名单脚本（${hooksRoot}）—— 提醒 hook 全部跳过`);
    return;
  }
  if (present.length < config.scripts.length) {
    warn(`部分 hook 脚本缺失：应 ${config.scripts.length} 个、缺 ${config.scripts.length - present.length} 个`);
  }
  const scripts = resolveAllowedScripts(config.hooksDir, present);
  const byFilename = new Map(scripts.map((entry) => [entry.filename, entry.script]));

  const runOne = (filename, eventPayload, signal) => {
    const script = byFilename.get(filename);
    if (!script) return Promise.resolve(undefined);
    return runHook(config, script, JSON.stringify(eventPayload), signal);
  };

  // SessionStart-equivalent memory check, injected once per agent on the first model step.
  const sessionMemoryInjected = /* @__PURE__ */ new WeakSet();

  // UserPromptSubmit channel: inject matching reminders into the next model step.
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted) return decision;
    const prompt = directPrompt(messages);
    if (!prompt) return decision;

    const injections = [];
    const summaries = [];
    if (config.sessionMemory && !sessionMemoryInjected.has(agent) && byFilename.has("session_memory_check.py")) {
      sessionMemoryInjected.add(agent);
      try {
        const context = await runOne("session_memory_check.py", { hook_event_name: "SessionStart" }, signal);
        if (context) {
          injections.push(context);
          summaries.push("session-memory");
        }
      } catch (error) {
        console.warn(`ai-agent-hub-reminders: session-memory failed: ${String(error)}`);
      }
    }

    const payload = { hook_event_name: "UserPromptSubmit", prompt, cwd: process.cwd(), _agent_source: "dsh" };
    const settled = await Promise.allSettled(
      scripts
        .filter(({ filename }) => filename !== "session_memory_check.py")
        .map(async ({ filename, script }) => ({ filename, context: await runHook(config, script, JSON.stringify(payload), signal) })),
    );
    for (const result of settled) {
      if (result.status !== "fulfilled" || !result.value.context) continue;
      injections.push(result.value.context);
      summaries.push(result.value.filename.replace(/\.py$/i, ""));
    }
    if (injections.length === 0) return decision;
    return {
      kind: "enter",
      messages: [...decision.messages, noticeMessage(injections.join("\n\n"), summaries.join(", "))],
    };
  }, { prepend: true });
}
