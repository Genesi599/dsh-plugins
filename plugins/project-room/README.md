# dsh-project-room

> 把 DeepSeek Harness 的侧栏变成「项目」视图，并给每个项目一个房间。

## 它做什么

| 能力 | 说明 |
|---|---|
| **项目分组侧栏** | 会话标题形如 `项目 · 成员` 时自动按项目分组；每组显示成员芯片、今日运行时长、最近活动时间 |
| **运行中快捷栏** | 顶部一行 pill：正在跑的成员一眼看到、一点进去；跑完未读的标记 ✓ 并置顶 |
| **搜索** | 同时匹配项目名与成员名；搜索时自动展开命中的折叠组 |
| **折叠 / 置顶** | 每组可折叠；星标置顶到列表顶部（本地持久化） |
| **成员芯片** | 自定义 emoji 头像（可选）、本轮运行时长、分身 `+N` 徽标与 `● 名 ○ 名` 子行 |
| **右键菜单 / 双击改名** | 右键：改名… / 归档会话 / 复制 sessionId / 复制标题；双击芯片直接改名 |
| **新建项目** | 头部「+ 新项目」→ 建会话并按 `项目 · 成员` 命名，同时初始化房间看板 |
| **项目房间（全屏）** | 点项目名打开：公共看板（可编辑保存）、任务清单、房间待办、向成员会话投递消息 |

## 目录约定

插件只读写自己的一套文件，不碰任何其它插件的私有结构：

```
<root>/projects/<项目名>/
├── board.md      # 公共看板（房间「公共看板」页读写）
├── tasks.json    # 任务清单（只读展示，可选）
└── queue.json    # 房间待办（房间「房间待办」页读写）
<root>/avatars.json # 可选：{ "成员名": "🛠️" }，没有就退回首字符色块
```

`<root>` 默认是 `<Host 进程 cwd>/.dsh-room`，可用插件配置 `rootDir` 改到任意绝对路径。
（注：DSH 桌面端的 Host cwd 通常是 profile 目录，所以实际落在 `~/.dsh/profiles/<profile>/.dsh-room`。）

这些文件都是人能直接编辑的普通 Markdown / JSON——即使不用本插件也能维护。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `rootDir` | `<cwd>/.dsh-room` | 房间数据根目录（绝对路径） |
| `avatarsPath` | 空 | 显式指定头像表 JSON；不给则依次找 `<root>/avatars.json`、`<cwd>/.hub/avatars.json` |

## Host 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| GET / POST | `/project-room/board?project=X` | 读看板；POST 带 `{content}` 覆盖写，不带则缺失时建模板 |
| GET | `/project-room/tasks?project=X` | 读该项目的 `tasks.json` |
| GET / POST | `/project-room/queue?project=X` | 读待办；POST `{list:[...]}` 覆盖写 |
| GET | `/project-room/avatars` | 头像表（缺文件返回 `{}`） |
| POST | `/project-room/prompt` | `{sessionId, text}` → 原生 `sessionController.prompt`（能唤醒冷会话） |
| POST | `/project-room/rename` | `{sessionId, title}` → 原生 `sessionController.rename` |
| POST | `/project-room/archive` | `{sessionIds:[...]}` → 批量归档，回传 `{archived, failed:[{id,error}]}` |
| GET | `/project-room/alive` | 磁盘上真实存在的会话 uuid 白名单（用于过滤前端快照里的幽灵条目） |

项目名允许字母、数字、中文、空格、`.`、`-`、`·`，长度 1–64；其它字符直接拒绝，避免路径穿越。

## 安装

```sh
dsh plugin --profile <profile> add dsh-project-room
```

或在本机用插件管理器安装指向该目录的 bundle。

## 卸载 / 回退

停用或卸载插件后侧栏立刻回到宿主原生会话列表（本插件只在 `sidebar.workspaces` / `shell.overlay` 两个 slot 里注册，不改宿主源码）。
已写入的房间文件保留在 `rootDir` 下，不会自动删除。

## 已知限制

- 分组依赖会话标题里的分隔符（默认 ` · `）。标题没有分隔符的会话归入「未分组」，默认收起。
- 「未分组」里只显示磁盘上真实存在的会话；前端快照里的幽灵条目（磁盘目录已不存在）会被过滤掉——它们无法归档，也永远删不掉。
- 会话 id 在这台机器上存在两种形态（`session-<uuid>` 与纯 `<uuid>`，取决于会话新旧），归档/改名端点会两种都试。

## 开发

```sh
node test/smoke.mjs     # 或用 npm test
```

冒烟测试用桩 React 真跑一次侧栏组件渲染，覆盖：样式是否注入、两个 slot 是否注册、渲染是否抛错、快捷栏/项目行/芯片/分身徽标/分身子行是否存在。**不要只依赖 `node --check`**——语法检查抓不到「useState 被插进别的 useEffect 内部」这类会整块崩溃的问题。

## License

MIT
