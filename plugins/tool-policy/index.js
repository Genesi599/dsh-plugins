import { realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const name = "ai-agent-hub-tool-policy";

const WEIXIN_SEND = /\bhermes(?:\.exe)?["']?\s+send\b[\s\S]*?(?:--to(?:\s*=\s*|\s+)|-t\s+)["']?weixin(?=[:\s"']|$)/i;
const SOURCE_LABEL = /【对话：\s*[^】\r\n]+\s*】/;
const SHELL_TOOLS = /^(?:pwsh|bash|shell|terminal)$/i;

const FS_WRITE_TOOLS = /^(?:write|edit|multi_edit|str_replace_editor|patch|write_file|apply_patch|todo|workflow)$/i;

// 2026-11-06：PowerShell 里**内联多行 Python + 嵌套引号转义**必挂——实测报
// `ParserError: ... 缺少表达式` / `[exit code: 1]`（session-995bc193「Center the three-block
// chain and rerun」，agent 随后自己改用 write 落 .py 才跑通）。
// memory 里早有「命令行别拼复杂转义 / 复杂断言落 .py」的规则，但从未强制；这里做成硬拦截，
// 直接给出正确写法，免得每次重新踩。
// 2026-11-06：PowerShell 里**内联多行 Python + 嵌套引号转义**必挂——实测报
// `ParserError: ... 缺少表达式` / `[exit code: 1]`（session-995bc193「Center the three-block
// chain and rerun」，agent 随后自己改用 write 落 .py 才跑通）。
// ⚠️ 判据必须只看 `python -c "..."` **引号内部**：整条命令含换行很正常（多行脚本），
//    上一版按整条命令判断会误伤 `python -X utf8 -c "print(1+1)"`（2026-11-06 实测误伤后修正）。
const PWSH_INLINE_PY = /(?:^|[\s;&|(])(?:python(?:\.exe)?|py)\s+(?:-X\s+utf8\s+)?-c\s+(["'])/i;

/** 取 `python -c "<内容>"` 的引号内文本（跳过 \" 转义）；找不到返回 undefined */
export function inlinePythonBody(cmd) {
  const m = PWSH_INLINE_PY.exec(cmd);
  if (!m) return undefined;
  const quote = m[1];
  let i = m.index + m[0].length;
  let body = '';
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === '\\' && cmd[i + 1] === '"') { body += '\\"'; i += 2; continue; }
    if (ch === quote) return body;
    body += ch;
    i += 1;
  }
  return body;   // 没闭合引号：也当作 body 返回，交给下面判据
}

export function inlinePythonGuard(exec, command) {
  if (!exec || !SHELL_TOOLS.test(String(exec.name || ""))) return undefined;
  const cmd = String(command || "");
  if (!cmd) return undefined;
  const body = inlinePythonBody(cmd);
  if (body === undefined) return undefined;
  // 只看引号内部：真换行（内联多行脚本）或字面 \" （给内层引号做转义）→ 必挂
  if (!/\n/.test(body) && !/\\"/.test(body)) return undefined;
  return {
    kind: "deny",
    reason: "[pwsh_inline_python] PowerShell 里内联多行 Python + 嵌套引号转义**必挂**（实测 ParserError「缺少表达式」/[exit code: 1]）。"
      + "正确写法：① 用 write 工具把脚本落成 .py 文件（如 patch_x.py）；② 再 `python -X utf8 patch_x.py` 执行。"
      + "多行逻辑 / 补丁 / 复杂断言一律落文件，不要内联 -c。",
  };
}

// Pre-tool-call special channels migrated from Hermes pre_tool_call hooks.
const DRAWING_INTENT = /(?:figure|plot|heatmap|dotplot|umap|volcano|drawing|作图|fig\s*[A-Za-z0-9]*|savefig|matplotlib|seaborn|drawing_standards_checklist)/i;
const HUMANIZER_INTENT = /(?:report|文档|讲稿|PPT|slide|REPORT\.md|humanizer|AI味|ai味|翻译|邮件正文)/i;
const PPT_INTENT = /(?:\.pptx?\b|Presentation\(|pptx|COM|幻灯片|slides)/i;
const REPORT_INTENT = /(?:project_report|combined|_report_config|REPORT\.md|pages\/|super-switch|category)/i;
const HPC_INTENT = /(?:qsub|PBS|SLURM|sbatch|\.pbs\b|HPC|hpc)/i;

const MEMORY_LIMIT = 22000;

function commandOf(exec) {
  const args = exec?.arguments;
  if (!args || typeof args !== "object") return undefined;
  const values = [];
  for (const key of ["command", "cmd", "script"]) {
    const value = args[key];
    if (Array.isArray(value)) values.push(value.join(" "));
    else if (value != null) values.push(String(value));
  }
  return values.length ? values.join("\n") : undefined;
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") for (const key of Object.keys(value)) collectStrings(value[key], out);
  return out;
}

export function memoryDir() {
  return resolve(process.env.USERPROFILE ?? "", "Documents", "GitHub", "AI-Agent-Hub", "memory");
}

function candidatePaths(exec) {
  const args = exec?.arguments;
  if (!args || typeof args !== "object") return [];
  const out = [];
  for (const key of ["path", "file_path", "target", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) out.push(value);
  }
  for (const text of collectStrings(args)) {
    const matches = text.matchAll(/(?:^|[^\w])([A-Za-z]:[\/][^\s"']+\.md)(?=$|[^\w])/g);
    for (const m of matches) out.push(m[1]);
  }
  return out;
}

export function memoryOverLimit(exec) {
  const root = resolve(memoryDir());
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return undefined;
  }
  const prefix = rootReal.endsWith("\\") ? rootReal : rootReal + "\\";
  const files = new Set();
  for (const raw of candidatePaths(exec)) {
    try {
      const real = realpathSync(resolve(raw));
      if (!real.startsWith(prefix)) continue;
      const rel = real.slice(prefix.length);
      if (rel.includes("\\") || rel.includes("/")) continue;
      if (!rel.toLowerCase().endsWith(".md")) continue;
      files.add(real);
    } catch {
      // non-existent or unreadable target: nothing to measure yet
    }
  }
  for (const file of files) {
    try {
      const size = statSync(file).size;
      if (size > MEMORY_LIMIT) {
        return `${basename(file)} = ${size.toLocaleString()} chars, 超 ${MEMORY_LIMIT.toLocaleString()} 硬上限。Read 单页会截断 → 记忆未完整加载。硬规则：立刻拆专题 .md，在 MEMORY.md 加索引，原文件留指针。`;
      }
    } catch {
      // ignore per-file stat errors
    }
  }
  return undefined;
}
export function preToolCallDecision(exec, command, options = {}) {
  const { shellAsk = true, fsSpecialChannels = true } = options;
  // Weixin source-label is a hard rule independent of permission mode.
  if (SHELL_TOOLS.test(exec?.name ?? "")) {
    if (command && WEIXIN_SEND.test(command) && !SOURCE_LABEL.test(command)) {
      return { kind: "deny", reason: "非 Weixin 专用 Session 主动发微信时，消息首行必须包含真实对话名：`【对话：<当前对话名>】`。" };
    }
    // 内联多行 Python + 转义引号 → 直接拒绝并给正确写法（2026-11-06）
    const inlinePy = inlinePythonGuard(exec, command);
    if (inlinePy) return inlinePy;
    if (!shellAsk) return undefined;
    return { kind: "ask", reason: "shell 命令需要确认后执行（首轮迁移统一要求；只读操作优先使用受沙箱约束的 fs 工具）。" };
  }
  // Pre-tool-call special channels for file-mutation tools (disabled under full access).
  if (fsSpecialChannels && FS_WRITE_TOOLS.test(exec?.name ?? "")) {
    const text = collectStrings(exec?.arguments ?? {}).join(" ");
    const reasons = [];
    if (DRAWING_INTENT.test(text)) reasons.push("作图/绘图相关写入前先读 drawing_standards_checklist.md 并遵循 drawing-yh 规范");
    if (PPT_INTENT.test(text)) reasons.push("PPT 相关操作前先读 preferences_pptx_*.md 的统一文字与版式标准");
    if (REPORT_INTENT.test(text)) reasons.push("网页报告写入前先读 preferences_report_*.md 的三级目录与 combined 结构规则");
    if (HPC_INTENT.test(text)) reasons.push("HPC/PBS 相关命令前先读 environment_hpc_pbs.md 的三条铁律");
    if (reasons.length > 0) {
      return { kind: "ask", reason: `检测到受规范约束的文件写入：${reasons.join("；")}。请先确认已遵守对应规则。` };
    }
  }
  return undefined;
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    shellAsk: rawConfig.shellAsk !== false,
    fsSpecialChannels: rawConfig.fsSpecialChannels !== false,
    memorySizeCheck: rawConfig.memorySizeCheck !== false,
  };

  ctx.on("tools/pre-execute", (exec, next) => {
    if (!exec?.name) return next();
    const decision = preToolCallDecision(exec, commandOf(exec), config);
    if (decision) return decision.kind === "allow" ? next() : decision;
    if (config.shellAsk && SHELL_TOOLS.test(exec.name)) return { kind: "ask", reason: "shell 命令需要确认后执行。" };
    return next();
  }, { prepend: true });

  if (config.memorySizeCheck) {
    ctx.on("tools/post-execute", (exec, _result, next) => {
      const downstream = next();
      if (downstream && typeof downstream.then === "function") {
        return downstream.then((decision) => memoryBlockDecision(exec, decision));
      }
      return memoryBlockDecision(exec, downstream);
    }, { prepend: true });
  }
}

export function memoryBlockDecision(exec, downstream) {
  if (downstream?.kind === "block") return downstream;
  // Memory-size is a WRITE rule: only check mutation tools, never read/grep.
  if (!FS_WRITE_TOOLS.test(exec?.name ?? "")) return downstream;
  const message = memoryOverLimit(exec);
  if (!message) return downstream;
  // feedback 契约是 ContentBlock[]（dsh-tools PostToolDecision；2026-10-28 修复）：
  // 之前传字符串，harness 的 failureMessageFromContent 对它调 content.map →
  // "content.map is not a function"，编辑已落盘却报错，误导 agent 重试造成重复写入。
  return { kind: "block", feedback: [{ type: "text", text: `[memory_size_check] ${message}` }] };
}
