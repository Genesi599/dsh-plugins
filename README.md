# AI-Agent-Hub DSH plugins

DeepSeek Harness (DSH) 插件集合。**本仓库只含插件源码**，不含任何私人记忆、项目记录或本机路径。

## 前置要求

- **Node.js 18+**（推荐装 LTS：<https://nodejs.org>）。装完**重新打开终端**，`node -v` 能打印版本才算就绪。
- 已经装好 DeepSeek Harness，并且至少启动过一次（这样才有 `~/.dsh/profiles/<名字>/` 这个 profile 目录）。

## 安装（一条命令）

**在终端里跑**（PowerShell / CMD / Windows Terminal 都行，不需要 cd 到某个目录，也不需要管理员权限）：

```bash
npx dsh-hub-suite            # 首次会问是否下载这个小包，输 y
```

想先看它要改什么（不改任何文件）：

```bash
npx dsh-hub-suite --dry-run
```

它会做三件事：① 往 profile 的 `package.json` 登记依赖 → ② 用该 profile 自己的包管理器安装 → ③ 把 bundle 名字写进 `dsh.profile.bundles`。

**装完必须重启 DeepSeek Harness**，然后在插件管理器里应能看到整套插件。

## 单独装某个插件

```bash
npm install dsh-hub-reminders        # 换成你要的包名
```

**bundle 类插件**（desktop-ui / project-room / hub-callout / quota-panel / reminders / tool-policy / curator / branch）装完还要把包名加进 profile 的 `dsh.profile.bundles`，否则不会加载。

## 包含的插件

| 目录 | 包名 | 版本 | 说明 |
|---|---|---|---|
| `plugins/hub-desktop-ui` | dsh-hub-desktop-ui | 0.2.11 | AI-Agent-Hub 的 DSH 前端形态插件：紧凑会话侧栏、侧栏底部状态卡与项目/任务线视图。 |
| `plugins/project-room` | dsh-project-room | 0.2.4 | Project rooms for DeepSeek Harness: group sessions into projects, see per-project runtime, and open a room with a shared board, task list, todo queue and message delivery to member sessions. |
| `plugins/hub-callout` | dsh-hub-callout | 0.1.1 | 把消息里的 GitHub admonition 语法（> [!NOTE] / > [!BOOK] 等）渲染成带彩色标题的提示块。 |
| `plugins/quota-panel` | dsh-hub-quota-panel | 0.1.3 | 侧栏余额与用量面板：DeepSeek 账号余额 + 今日/本会话 token 用量（数据真实，失败显式提示）。 |
| `plugins/reminders` | dsh-hub-reminders | 0.1.5 | DSH 会话 hook 注入：按白名单运行仓库 hooks/*.py，并把提醒文本注入每一轮（开工自检 / 测试清理 / 实事求是等） |
| `plugins/tool-policy` | dsh-hub-tool-policy | 0.1.3 | DSH 工具调用策略：拦截内联多行 Python、微信转发、来源标签等高风险写法 |
| `plugins/curator` | dsh-hub-curator | 0.1.3 | DSH 经验 curator：每 N 轮让 LLM 判定哪些经验值得沉淀（memory / skill / hook 三分类） |
| `plugins/branch` | dsh-hub-branch | 0.1.3 | DSH 会话分支：branch-list / branch-fork / branch-pin / branch-merge 四个命令 |
| `plugins/hub-suite` | dsh-hub-suite | 0.1.2 | AI-Agent-Hub 的 DSH 插件套装：一条命令装齐 project-room / hub-desktop-ui / callout / quota-panel / reminders / tool-policy / curator / branch（含依赖闭包）。其他插件包：dsh-hub-core、dsh-compact-tool 等由依赖自动带入。 |

## 结构

- 每个插件是一个独立 npm 包（`package.json` + 入口 + 可选 `cordis.patch.yml`）
- bundle 类插件自带 `cordis.patch.yml`，装进 profile 后由 `dsh.profile.bundles` 登记加载
- 本机专属配置（如 `reminders` 的 hooks 脚本目录）**不在本仓库内**，由使用者自行在 profile 里配置；不配也能装，只是不会跑 hook
