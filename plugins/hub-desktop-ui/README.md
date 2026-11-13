# dsh-hub-desktop-ui

A compact front-end layer for DeepSeek Harness (DSH): a sidebar status card, project and
task-line integration, an in-session group chat room, and a guided new-project dialog.

Installed as a Cordis bundle inside a profile. Removing the bundle restores the stock
shell — nothing is written into the DSH installation directory.

## What you get

**Sidebar status card** — pinned to the bottom of the sidebar: session/project counts,
model in use, and (when the quota panel is installed alongside) today's spend. Includes a
restart action for the desktop app.

**Project and task-line integration** — sessions titled `Project · Member` are grouped by
project. Task lines are projected from each project's `board.md`, so a line's status can be
edited in one place and stays consistent everywhere.

**New-project dialog** — one field: the project name. The member name comes from Settings
(*Sidebar* section), so it only needs to be set once. The resulting session is titled
`<project> · <member>`.

**In-session group chat room** — an overlay view that lists every session of the current
project as its own thread, each with an independent input box. Messages are delivered to
that specific session rather than broadcast.

**Sidebar settings section** — a *Sidebar* section in Settings for member naming and
appearance options.

**Live rate hint** — token/rate feedback attached to the composer.

## Install

Install just this plugin:

```sh
dsh plugin --profile web add dsh-hub-desktop-ui
```

Or install the whole AI-Agent-Hub set — this plugin plus the other seven — with one
command:

```sh
npx dsh-hub-suite            # preview first with: npx dsh-hub-suite --dry-run
```

The suite requires Node.js 18+, writes the dependencies into your DSH profile,
installs them, and registers the bundles in `dsh.profile.bundles`. Restart DeepSeek
Harness afterwards.

### Updating

```sh
dsh plugin --profile web update dsh-hub-desktop-ui   # within the current major range
dsh plugin --profile web add dsh-hub-desktop-ui@latest
```

Restart DSH after updating — client plugins are assembled at page load.

## Companion plugins

`dsh-hub-desktop-ui` works on its own, but two neighbours make the sidebar whole:

| Plugin | What it adds |
|---|---|
| `dsh-project-room` | Renders the project-grouped sidebar itself, and gives each project a room with a shared board, task list, and todo queue |
| `dsh-hub-quota-panel` | Balance and token usage in the status card |

If `dsh-project-room` is installed it renders the project-grouped sidebar, and this
plugin's own workspace browser steps aside. Both can stay enabled — this one supplies the
data endpoints and the status card, the other draws the project view.

## Configuration

Themes and colours are left to DSH. This plugin does not override the palette, so the
appearance follows whatever theme you have selected.

## Removing

```sh
dsh plugin --profile web remove dsh-hub-desktop-ui
```

Then restart DSH.

## License

MIT