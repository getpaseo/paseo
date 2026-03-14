# Paseo Doctor / Health Check

## Problem

Users need a way to diagnose their Paseo setup: are agent binaries installed, what versions are running, is the config valid? Currently there's no unified diagnostic — errors only surface when you try to launch an agent and it fails.

## Decision: Shared library + HTTP endpoint

The check logic lives as a pure module in `packages/server` (no daemon dependency). It inspects the local filesystem and runs `which`/`--version` commands.

- **Daemon** exposes it via `GET /api/doctor` (stateless, no WS session needed).
- **CLI** imports the module directly for offline use (`paseo doctor`), or calls the HTTP endpoint with `--remote`.
- **App** calls the HTTP endpoint from the settings screen.

## Data Model

```typescript
type CheckStatus = "ok" | "warn" | "error";

interface DoctorCheckResult {
  id: string;        // e.g. "provider.claude.binary"
  label: string;     // e.g. "Claude CLI"
  status: CheckStatus;
  detail: string;    // e.g. "/usr/local/bin/claude (v1.0.42)"
}

interface DoctorReport {
  checks: DoctorCheckResult[];
  summary: { ok: number; warn: number; error: number };
  timestamp: string;
}
```

## Checks

| ID | What it checks | ok | warn | error |
|---|---|---|---|---|
| provider.claude.binary | which claude | Found + path | — | Not found |
| provider.claude.version | claude --version | Version string | Parse failed | Binary missing |
| provider.codex.binary | which codex | Found + path | — | Not found |
| provider.codex.version | codex --version | Version string | Parse failed | Binary missing |
| provider.opencode.binary | which opencode | Found + path | — | Not found |
| provider.opencode.version | opencode --version | Version string | Parse failed | Binary missing |
| config.valid | Parse config.json | Valid | — | Parse/schema error |
| config.listen | Listen address format | Valid | — | Malformed |
| runtime.node | Node.js version | Version | — | Not found |
| runtime.paseo | Paseo daemon version | Version | — | Unknown |
