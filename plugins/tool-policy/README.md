# dsh-hub-tool-policy

Blocks risky tool-call shapes before they reach the shell or the filesystem. It is a
host-side policy layer, not a sandbox: it inspects the arguments of a tool call and
refuses the ones you have declared out of bounds.

Rules currently implemented:

- **inline multi-line Python** — `python -c "…"` spanning several statements, which is
  where quoting errors and silent partial execution live; write a file and run it.
- **WeChat forwarding** — reposts of other people's messages without a source label.
- **source labels** — content copied from an external source must carry where it came
  from.
- **memory size** — refuses to write memory files past the configured character cap, so
  a runaway write cannot blow the index budget.

## Install

Install just this plugin:

```sh
dsh plugin --profile web add dsh-hub-tool-policy
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

```yaml
- insert:
    - id: ai-agent-hub-tool-policy
      name: 'dsh-hub-tool-policy'
      config:
        shellAsk: false          # true = also ask before plain shell calls
        fsSpecialChannels: false # true = also check special filesystem channels
        memorySizeCheck: true    # enforce the memory-file character cap
```

## License

MIT
