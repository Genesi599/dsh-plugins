# dsh-hub-curator

Every N turns, asks the model one question: *is anything from the last few turns worth
keeping?* The answer is sorted into three buckets — **memory** (a durable fact),
**skill** (a reusable procedure), **hook** (a rule that should fire automatically) —
and written where that bucket lives.

The point is that lessons stop depending on someone remembering to say "记一下". The
curator pass only proposes; it does not edit your prompt or your files behind your
back beyond the bucket it decided on.

## Install

Install just this plugin:

```sh
dsh plugin --profile web add dsh-hub-curator
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
    - id: ai-agent-hub-curator
      name: 'dsh-hub-curator'
      config:
        intervalTurns: 5      # run once every N completed turns
        minIntervalMs: 60000  # and never more often than this
        recentTurns: 3        # how much history the model sees
        maxChars: 5000        # history cap fed to the model
        maxTokens: 800        # answer cap
        signalThreshold: true # skip turns with no durable signal
        runCurator: true
```

## License

MIT
