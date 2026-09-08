# Lifecycle logger

Registers all eleven server lifecycle hooks and logs their data as JSON. It observes agent creation,
session opening, turns, permissions, archive, and workspace creation/archive. Before hooks return
the request unchanged. Environment values are redacted; prompts and timeline content are logged.

Install it on a daemon where plugins are enabled:

```bash
paseo plugin install /absolute/path/to/plugin-examples/lifecycle-logger
paseo plugin logs lifecycle-logger
```

The same entries appear in the target daemon's `daemon.log`. The plugin log viewer retains a bounded
tail; use the daemon log for longer captures. Log lines are capped at 16 KiB, so a large timeline can
be truncated.

See the [lifecycle reference](../../public-docs/plugins/v0.8/reference.md#lifecycle-hooks) for callback
shapes and delivery rules. The real-provider test in
`packages/server/src/server/plugins/lifecycle.real.e2e.test.ts` runs both examples on an isolated daemon
and saves evidence under `.dev/lifecycle-proof/`.

Run it from `packages/server` on Linux with Claude configured:

```bash
npx vitest run src/server/plugins/lifecycle.real.e2e.test.ts --bail=1
```

The test uses real provider calls and a temporary daemon home. Its failure check uses Linux `/proc`
to identify and terminate only its own Claude subprocess. The credits check asks the real agent to
emit the matching phrase; it does not exhaust an account's credits.
