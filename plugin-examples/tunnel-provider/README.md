# Custom tunnel provider example

Registers a tunnel provider with `server.registerTunnelProvider()`.

## What it does

- Probes the local CLI in `status()` and returns `available` or `unavailable` with install guidance.
- Spawns the tunnel process in `open(target, { report, signal })`, parses the public HTTPS URL, and reports `connecting`, `ready`, and `closed` events.
- Terminates the child process cleanly when `signal` aborts.

## Install

```bash
paseo plugin install /absolute/path/to/plugin-examples/tunnel-provider
```
