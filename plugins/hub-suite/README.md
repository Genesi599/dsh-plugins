# dsh-hub-suite

AI-Agent-Hub 给 **DeepSeek Harness (DSH)** 做的整套插件，一条命令装齐。

## 前置要求

- **Node.js 18+**（推荐 LTS：<https://nodejs.org>）。装完**重新打开终端**，`node -v` 能打印版本才算就绪。
- 已经装好 DeepSeek Harness，且**至少启动过一次**（这样才有 `~/.dsh/profiles/<名字>/` 的 profile 目录）。

## 一条命令

**在终端里跑**（PowerShell / CMD / Windows Terminal 都行；不需要 cd 到某个目录，也不需要管理员权限）：

```bash
npx dsh-hub-suite            # 首次会问是否下载这个小包（约 12 KB），输 y
```

想先看它要改什么、不改任何文件：

```bash
npx dsh-hub-suite --dry-run
```

它做三件事：

1. 在你的 DSH profile 的 `package.json` 里登记依赖
2. 用该 profile 自己的包管理器安装（有 `pnpm-lock.yaml` 且能调起 pnpm 就用 pnpm，否则 npm）
3. 把包名写进 `dsh.profile.bundles` —— **这一步不能省**，不写进去插件不会被加载

**装完必须重启 DeepSeek Harness**，插件管理器里就能看到整套。

常用参数：

```bash
npx dsh-hub-suite --dry-run                              # 只打印计划，不动任何文件
npx dsh-hub-suite --no-install                           # 只改配置，安装命令你自己跑
npx dsh-hub-suite --profile "~/.dsh/profiles/desktop"    # 指定单个 profile
```

## 装了什么

| 包 | 作用 |
|---|---|
| `dsh-hub-desktop-ui` | 前端主体：暖色深色调色板、紧凑会话侧栏、项目/任务线视图、用量面板入口 |
| `dsh-project-room` | 把会话按项目分组、打开「项目房间」共享看板；快捷栏区分「运行中 / 完成未读」 |
| `dsh-hub-callout` | 把 `> [!NOTE]` / `> [!BOOK]` 这类 GitHub 风格告示渲染成彩色卡片 |
| `dsh-hub-quota-panel` | 侧栏余额 + 当日 token 用量面板（数据真实，失败显式提示） |
| `dsh-hub-reminders` | 会话 hook 注入：把 `hooks/*.py` 的提醒文本注入每一轮（**需自配 `hooksDir`**，见下） |
| `dsh-hub-tool-policy` | 工具调用策略：拦截内联多行 Python、微信转发、来源标签等高风险写法 |
| `dsh-hub-curator` | 经验 curator：每 N 轮让 LLM 判定哪些经验值得沉淀成 memory / skill / hook |
| `dsh-hub-branch` | 会话分支：`branch-list` / `branch-fork` / `branch-pin` / `branch-merge` |

依赖闭包里还会自动带上：`dsh-hub-core`、`dsh-compact-tool`、`dsh-clone-handoff`、`dsh-queue-triage`、`dsh-sync-bridge`、`dsh-desktop-watchdog`、`dsh-agent-tasks`。

## reminders 需要你自己配 hooks 目录

套装里 `reminders` 的 `hooksDir` **故意留空** —— 我们本机的 hooks 目录对你不存在。
不配的后果：插件正常加载、打印一条 warn、**不跑任何 hook**（不会报错）。

要用的话，在 profile 的 `cordis.patch.yml` 里给它加配置：

```yaml
- id: ai-agent-hub-reminders
  config:
    hooksDir: /你的/hooks 目录
```

被允许执行的脚本名单固定在 `plugin.js` 的 `SCRIPT_ALLOWLIST` 里（`session_memory_check.py`、
`anti_hallucination_reminder.py` 等），目录里的其他文件不会被执行。

## 卸载

把 5 个名字从 `dsh.profile.bundles` 里删掉、从 `dependencies` 移除，再跑一次 profile 的安装命令即可。
`dsh-hub-suite` 从不删除你的文件，配置改动前会写 `package.json.bak-suite-*` 备份。

## 常见问题

- **`npx` 报 `command not found`**：Node.js 没装或没进 PATH。装完 Node 要**重开终端**。
- **装完看不到插件**：确认 profile 的 `package.json` 里 `dsh.profile.bundles` 已含那 5 个名字，然后**重启 DSH**（不是刷新页面）。
- **`npm install` 失败**：到 profile 目录里手动跑一次安装看完整报错（安装器会在失败时提示该目录）。
