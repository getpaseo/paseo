# Code Indexing

Hubcode integrates [code-review-graph](https://github.com/tirth8205/code-review-graph) (crg) to give agents a structural+semantic graph of the user's code: blast-radius, minimal-context, impact analysis, call graphs, inheritance, coverage, and (optional) semantic search across ~28 MCP tools.

This doc is the source of truth for the integration. Update it as decisions evolve.

---

## TL;DR

- **What**: a Python tool (`code-review-graph`) is auto-installed by Hubcode and runs as a stdio subprocess of the daemon. Its ~28 MCP tools are proxied through Hubcode's MCP server and exposed to enabled CLI/GUI agents.
- **Why phased**: structural graph delivers ~80% of the value with zero ML deps. Semantic search (embeddings) is opt-in and added later.
- **Defaults**: enabled per-project after user opt-in; all tools exposed to all detected agents; semantic search off until user enables.

---

## Architecture

### Process model

```
┌─────────────────────────────────────────────────────────────┐
│ Hubcode daemon (Node, port 6767)                            │
│                                                             │
│  ┌──────────────────────────────┐   ┌────────────────────┐  │
│  │ Indexing service             │   │ MCP proxy server   │  │
│  │ - lifecycle                  │◀─▶│ - tools/list filter│  │
│  │ - per-project state          │   │ - tools/call route │  │
│  │ - watchlist + fs watcher     │   └─────────┬──────────┘  │
│  └─────────────┬────────────────┘             │             │
│                │ stdio MCP                    │             │
│                ▼                              ▼             │
│  ┌──────────────────────────────┐   ┌────────────────────┐  │
│  │ code-review-graph subprocess │   │ Per-agent MCP cfg  │  │
│  │ (Python, pipx-installed)     │   │ writer             │  │
│  │ - SQLite per repo            │   │ (~/.claude/...,    │  │
│  │ - ~28 MCP tools              │   │  ~/.codex/..., …)  │  │
│  └──────────────────────────────┘   └────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                            CLI agents read MCP cfg → connect
                            back to Hubcode MCP proxy → tools
```

**Key choices:**
- **stdio, not a port**: crg runs as a child process of the daemon. No 6768 port, no auth layer, dies/restarts with the daemon.
- **One crg process** managed by Hubcode. crg's own multi-repo support handles all watched workspaces.
- **Proxy MCP** in Hubcode re-exposes crg's tools with namespace `crg_*`. Agents only ever talk to Hubcode.
- **Per-agent MCP config** is written using existing `agent-integrations.ts` infrastructure — same mechanism used today for skills/MCP marketplace.

### Why proxy (not direct MCP exposure)?

- Per-tool / per-agent enable-disable filtering happens in proxy (no client restart needed).
- Single auth surface (the existing daemon-agent auth).
- crg can be replaced/upgraded without touching agent configs.
- Future: combine crg tools with other internal tools under one namespace.

---

## Phased rollout

### Phase 1 — Structural indexing (MVP)

What ships:
- `pipx install code-review-graph` (no `[embeddings]` extra → no torch, no sentence-transformers, ~50MB)
- Per-project enable/disable
- ~20 structural tools (call graph, blast-radius, minimal-context, impact, inheritance, coverage, hints, refactor)
- Per-agent toggle (default on for all detected CLIs + Hubcode GUI)
- fs watcher → incremental reindex
- Status bar (bottom of app) for install/index progress

What's deferred:
- All 8 `semantic_*` tools
- Embedding provider picker
- Vector model download

### Phase 2 — Semantic search (opt-in)

User enables in settings. Provider options:

| Provider | Identity | Notes |
|---|---|---|
| **Hubcode Local** (default) | onnxruntime-node. Default model: `bge-small-en-v1.5` (384-dim, ~130MB, SOTA at this size on MTEB). Settings exposes a model dropdown — alternates: `all-MiniLM-L6-v2` (~90MB, lighter), `bge-base-en-v1.5` (~440MB, higher quality), and others curated in the embedding model catalog. | Reuses `model-downloader` + `download-toast`. Daemon exposes `http://localhost:PORT/v1/embeddings`, passes via `CRG_OPENAI_BASE_URL` to crg subprocess. Zero torch. |
| **OpenAI-compatible** | User-configured base URL + API key | crg env vars: `CRG_OPENAI_API_KEY`, `CRG_OPENAI_BASE_URL`, `CRG_OPENAI_MODEL`. Works with Ollama / LiteLLM / LocalAI / vLLM / OpenAI / Azure. |
| **sentence-transformers** | `pipx inject code-review-graph sentence-transformers` | Fallback for users who want crg's official path. ~500MB (torch). |

crg's `_is_localhost_url()` check skips its cloud-egress warning for localhost endpoints — the Hubcode Local path works seamlessly.

---

## Existing infra to reuse

(Found by codebase audit on 2026-04-22. There is **no pre-existing text-embedding infrastructure** in Hubcode — Sherpa's onnxruntime-node usage is voice-only (Pocket TTS). This is greenfield work, but several patterns transfer.)

| Existing | Location | Reuse for |
|---|---|---|
| Model downloader | `packages/server/src/server/speech/providers/local/sherpa/model-downloader.ts` | Phase 2 ONNX embedding model download. Generalize from speech-only to typed model registry. |
| Model catalog pattern | `…/sherpa/model-catalog.ts` | Phase 2 embedding model catalog (curated entries with HF URLs + integrity). |
| Download UX | `packages/app/src/stores/download-store.ts`, `components/download-toast.tsx` | Phase 2 model download progress. |
| External-dep settings UX | `packages/app/src/screens/settings/cli-agents-section.tsx` | Phase 1 install banner, status badge, copy-command flow. |
| Agent integration registry | `packages/server/src/server/library/agent-integrations.ts` | Per-agent MCP config writes (Phase 1). |
| onnxruntime-node | already in `packages/server/package.json` (^1.23.0) | Phase 2 local embedding inference (no new dep). |

### Embedding abstraction (forward-compatible)

The Phase 2 `EmbeddingProvider` interface MUST be designed so future Hubcode features can reuse it:
- Chat history semantic search (CHAT.md Phase 11 currently plans `tsvector`-only)
- Library/marketplace skill+MCP search
- Workspace-level "ask anything" assistants

Interface sketch:

```ts
interface EmbeddingProvider {
  readonly id: string;            // "hubcode-local:bge-small-en"
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
```

Hubcode Local provider exposes itself two ways:
1. Direct in-process API for Hubcode features.
2. OpenAI-compat HTTP endpoint on a loopback port, for crg subprocess.

Both modes share the same loaded ONNX session.

---

## Settings UX

New section in `packages/app/src/screens/settings-screen.tsx`:

```
{ id: "indexing", label: "Code Indexing", icon: Network }
```

Desktop-only (indexing requires the local daemon). Position: between **CLI Agents** and **Providers**.

### Layout

```
┌─ Code Indexing ─────────────────────────────────────┐
│ [BANNER if install failed]                          │
│  ⚠ Could not install code-review-graph              │
│  Run: pipx install code-review-graph                │
│  [Copy] [Re-check]                                  │
│                                                     │
│ ── Status ──                                        │
│ code-review-graph: ✓ v2.4.1                         │
│ Daemon process: ✓ Running                           │
│                                                     │
│ ── Semantic search ──         [PHASE 2]             │
│ [ ] Enable semantic search                          │
│     Provider: ( ) Hubcode Local (default)           │
│               ( ) OpenAI-compatible                 │
│               ( ) sentence-transformers             │
│     Model:    [bge-small-en-v1.5  ▾]                │
│       (dropdown — only shown for Hubcode Local /    │
│        sentence-transformers; OpenAI uses its own   │
│        model field)                                 │
│     [Download model]                                │
│                                                     │
│ ── Projects ──                                      │
│ ┌───────────────────────────────────────────────┐   │
│ │ hubcode            ✓ Ready  1240 nodes        │   │
│ │ /Users/.../hubcode             [⚙] [Rebuild]  │   │
│ ├───────────────────────────────────────────────┤   │
│ │ my-project         ⋯ Indexing 45%             │   │
│ ├───────────────────────────────────────────────┤   │
│ │ legacy-app         ○ Disabled        [Enable] │   │
│ └───────────────────────────────────────────────┘   │
│                                                     │
│ ── Per-project detail (modal) ──                    │
│ • Watchlist (ignore paths)                          │
│ • Available in: per-agent + per-tool toggles        │
│ • Last indexed timestamp, index size                │
└─────────────────────────────────────────────────────┘
```

### Per-project "Available in" card

Inside the project detail modal:

```
── Available in ──
┌─────────────────────────────────────────────────┐
│ ☑ Claude Code     28/28 tools     [Customize]   │
│ ☑ Codex           28/28 tools     [Customize]   │
│ ☑ OpenCode        28/28 tools     [Customize]   │
│ ☑ Cursor          28/28 tools     [Customize]   │
│ ☑ Hubcode chat    28/28 tools     [Customize]   │
└─────────────────────────────────────────────────┘
```

Only detected agents appear (filtered by `cli-agents-section` detection results).

`[Customize]` opens a modal with all 28 tools as checkboxes, all checked by default.

A mirror entry appears in `cli-agents-section` for each agent: collapsible "Hubcode tools" listing what is exposed to it. Same source of truth.

### Global status bar

New component `packages/app/src/components/indexing-status-bar.tsx`, mounted at app root, visible only during operations:

- `Installing code-review-graph… 45%`
- `Indexing my-project — 230/1240 files`
- `Downloading embedding model — 67%`
- Auto-hide after 3s idle.

---

## Toggle layers and defaults

Three independent switches. **All default ON** after the user opts a project in.

| Layer | Granularity | Default | Effect when off |
|---|---|---|---|
| 1. Per-project | one switch per workspace | off (opt-in) | crg ignores the repo |
| 2. Per-agent (master) | per workspace × agent | on (after L1 enabled) | proxy entry removed from agent's MCP config; agent restart needed |
| 3. Per-tool | per workspace × agent × tool | on | proxy filters `tools/list` and rejects `tools/call`; no agent restart |

Layer 3 is runtime-filtered in the proxy, so granular changes apply instantly.

---

## Persistence schema

Extend `PersistedWorkspaceRecord`:

```ts
interface IndexingState {
  enabled: boolean;
  embeddingProvider?: {
    kind: "none" | "hubcode-local" | "openai-compat" | "sentence-transformers";
    config?: {                              // openai-compat only
      baseUrl?: string;
      model?: string;
      apiKeyRef?: string;                   // pointer into secret store
      dimension?: number;
    };
  };
  watchlist: string[];                      // glob ignores
  exposeTo: Record<AgentId, {
    enabled: boolean;                       // default true
    enabledTools?: string[];                // undefined = all (default)
  }>;
  status: {
    phase: "idle" | "indexing" | "ready" | "error";
    nodeCount?: number;
    fileCount?: number;
    lastIndexedAt?: string;                 // ISO
    indexBytes?: number;
    error?: string;
  };
}
```

`AgentId` = `"claude" | "codex" | "cursor" | "gemini" | "opencode" | "copilot" | "hubcode-gui"`.

`exposeTo` defaults to `{}` and is interpreted as "all detected agents enabled, all tools enabled". Only persists on explicit user toggle.

---

## Cross-platform install

| OS | Strategy |
|---|---|
| **macOS** | Prefer Homebrew (`brew install pipx`). Fallback: download Python `.pkg` from python.org, run with progress. |
| **Linux** | Detect package manager (apt/dnf/pacman). UI shows "Copy command" + "I've installed it, re-check" — auto-sudo is too risky. |
| **Windows** | Try `winget install Python.Python.3.12`. Fallback: download Python embeddable (~25MB) into `$HUBCODE_HOME/python/`, isolated from system. |

Install detection order on every daemon start:
1. `code-review-graph --version` → use it
2. `pipx --version` → `pipx install code-review-graph`
3. `python3 --version` (≥3.10) → `python3 -m pip install --user pipx` then crg
4. None → bootstrap per OS

Errors surface via the indexing settings banner (copy-command + re-check button) and the global status bar.

---

## PR breakdown

| PR | Scope | Approx LOC |
|---|---|---|
| **PR1a** | Detector + workspace schema (`IndexingState`, `exposeTo`) + persistence migration | ~300 |
| **PR1b** | Cross-platform installer (macOS/Linux/Windows, `pipx` bootstrap) + install error banner with copy-command per OS | ~400 |
| **PR2** | crg subprocess lifecycle (stdio MCP, spawn/health/restart/crash recovery) + global status bar component | ~400 |
| **PR3** | MCP proxy: enumerate crg tools, namespace as `crg_*`, per-tool/per-agent filter on `tools/list` and `tools/call` | ~350 |
| **PR4** | Settings section UI (status, project list, per-project modal with "Available in" + Customize) + `cli-agents-section` mirror + fs watcher → incremental reindex | ~600 |
| **PR5** | Phase 2: provider picker + Hubcode Local ONNX embeddings (reuse `model-downloader`) + OpenAI-compat env passthrough + loopback `/v1/embeddings` server | ~700 |

**Total:** ~2750 LOC across 6 PRs. **MVP usable after PR4** (~2050 LOC, all structural tools).

---

## Open questions / future

- **Loopback embeddings server auth**: bind to `127.0.0.1` only, ephemeral port, single-token query param. crg passes via `CRG_OPENAI_API_KEY` (the value is ignored by us, just satisfies crg's env requirement).
- **Org sync (Phase 3?)**: 2a (local-only) confirmed for MVP. If demand, sync indexing preferences via auth-server later — schema is a strict subset.
- **Future reuse of embedding provider**: chat semantic search (CHAT.md Phase 11) and library/marketplace search are natural consumers. Design the Phase 2 `EmbeddingProvider` interface accordingly.

---

## Decisions log

- **2026-04-22**: Confirmed Option B (single crg process managed by Hubcode), auto-install, full UI, proxy MCP, local-per-workspace settings, Phase 1/2 split (structural first, semantic later), per-agent + per-tool toggles, defaults all-on after opt-in.
- **2026-04-22**: Confirmed no existing text-embedding infra in Hubcode — Sherpa's onnxruntime-node usage is voice-only and does not conflict.
- **2026-04-22**: Hubcode Local default embedding model = `bge-small-en-v1.5` (quality > size). Settings exposes a model dropdown so users can switch (e.g. `all-MiniLM-L6-v2` for lighter footprint, `bge-base-en-v1.5` for higher quality). Switching the model triggers a re-embed (crg's `provider.name` includes the model id).
- **2026-04-22**: On first project enable, auto-add `.code-review-graph/` to the repo's `.gitignore`. A toast confirms ("Added .code-review-graph/ to .gitignore — Undo").
