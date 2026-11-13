# dsh-hub-branch

Four slash commands for working with session branches. A branch is a real fork — the
child session inherits the parent's event prefix up to a completed turn and keeps a
`parentSession` relationship — not a copy and not a summary.

| Command | What it does |
|---|---|
| `/branch list` | Prints the branch tree of the current workspace, built from `parentSession` |
| `/branch fork <sessionId> [--atSeq N]` | Forks a child branch, optionally cut at event sequence `N` |
| `/branch pin <sessionId>` | Pins a session **and its whole family** (parent, children, siblings) |
| `/branch merge <childId> [--parent <parentId>]` | Merges a child branch's content back into its parent |

Forking requires a completed turn boundary; asking for one in the middle of a running
turn fails instead of producing a torn history.

## Install

Install just this plugin:

```sh
dsh plugin --profile web add dsh-hub-branch
```

Or install the whole AI-Agent-Hub set — this plugin plus the seven others — with one
command:

```sh
npx dsh-hub-suite            # preview first with: npx dsh-hub-suite --dry-run
```

The suite requires Node.js 18+, writes the dependencies into your DSH profile,
installs them, and registers the bundles in `dsh.profile.bundles`. Restart DeepSeek
Harness afterwards.

## Configuration

No configuration; it registers the four commands above.

## 更新

```sh
# 升到当前主版本范围内的最新版
dsh plugin --profile <profile> update dsh-hub-branch

# 或直接装最新版（含跨主版本）
dsh plugin --profile <profile> add dsh-hub-branch@latest
```

用整套装的话，重跑一次即可按版本范围升级全部插件：

```sh
npx dsh-hub-suite@latest
```

**更新后必须重启 DeepSeek Harness** —— 插件在应用启动时加载。核对版本：

```sh
dsh plugin --profile <profile> list --depth 0
```

## License

MIT
