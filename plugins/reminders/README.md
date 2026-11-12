# dsh-hub-reminders

Injects reminder text into every turn by running **Python hook scripts** on session
events. Each script prints a JSON payload with `hookSpecificOutput.additionalContext`,
and that text is prepended to the next model step.

This is the mechanism behind "read your memory on session start", "clean up test
sessions", "state what you actually verified", and similar standing instructions: the
rules live in plain `.py` files you can edit, not in the prompt.

## Install

Install just this plugin:

```sh
dsh plugin --profile web add dsh-hub-reminders
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
    - id: ai-agent-hub-reminders
      name: 'dsh-hub-reminders'
      config:
        hooksDir: ~/path/to/your/hooks   # directory holding the .py scripts
        pythonCommand: python            # interpreter (auto-detected when omitted)
        timeoutMs: 30000                 # per-script timeout
        maxBufferBytes: 1048576          # per-script output cap
        scripts:                         # allowlist — only these files run
          - session_memory_check.py
          - memory_update_reminder.py
```

`hooksDir` is optional. When it is missing or the directory has no allowed scripts,
the plugin loads normally and simply injects nothing; it does not refuse to start.
Only files named in `scripts` are executed, and a name that resolves outside
`hooksDir` is rejected.

## Script contract

A script receives `--trigger <event>` on the command line, reads the event payload as
JSON on stdin, and may print:

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "…" } }
```

Anything else on stdout, or a non-zero exit, is ignored for injection purposes and
logged. Scripts are spawned hidden (`windowsHide`) so they never flash a console
window on Windows.

## License

MIT
