# code-review-graph compatibility

This doc tracks the crg surface (CLI flags, MCP tool names, arguments, return shapes) that the daemon depends on, and how to handle upstream changes.

## Currently tested

| Field | Value |
|---|---|
| crg version | **2.3.2** |
| FastMCP transport | stdio (default) |
| Install method | `pipx install code-review-graph` |
| Python | 3.10+ (tested on 3.14) |

## Known breaking changes across versions

### From 2.2.x → 2.3.x

| Change | Where we adapted |
|---|---|
| CLI flag `serve --stdio` removed — stdio is now the only/default transport | `packages/server/src/server/indexing/process-manager.ts` (`DEFAULT_ARGS = ["serve"]`) |
| All MCP tool names gained `_tool` suffix (`build_or_update_graph` → `build_or_update_graph_tool`) | `packages/server/src/server/indexing/mcp-client.ts` (`resolveToolName` falls back to `<name>_tool` using cached manifest) |
| Arg name `repo_path` renamed to `repo_root` in `build_or_update_graph_tool` | `packages/server/src/server/bootstrap.ts` (triggerReindex passes `{ repo_root: cwd }`) |
| Return shape: prose summary → JSON dict with `files_parsed` / `total_nodes` / `total_edges` / `files_updated` | `packages/server/src/server/bootstrap.ts` (JSON parse with regex fallback) |
| `build_or_update_graph_tool` incremental response reports only `files_updated` (files that changed this run), **not** total graph size. Must call `list_graph_stats_tool` after every build to get authoritative counts | `packages/server/src/server/bootstrap.ts` (follows `crg_build_or_update_graph` with `crg_list_graph_stats`) |
| Tool cache must be refreshed **before** announcing `phase: connected` or the first call after reconnect races against the cache | `packages/server/src/server/indexing/mcp-client.ts:connect` awaits `refreshTools()` before `transition({ phase: "connected" })` |
| First build of a workspace must pass `full_rebuild: true`. Default `incremental` diffs against `HEAD~1` and can yield zero nodes if the last commit only touched non-parseable files (markdown, images) — the graph stays empty despite "ready" state | `packages/server/src/server/bootstrap.ts` (`isFirstBuild = !prior?.indexing?.status?.lastIndexedAt`) |
| crg tools default `repo_root` to the subprocess cwd (the daemon's, not the agent's workspace). Must inject `repo_root` at the MCP bridge so agents query their own repo, not whatever is beside the daemon | `packages/server/src/server/indexing/mcp-tool-bridge.ts` (`getWorkspaceCwd` injected when tool accepts `repo_root`) |
| `build_or_update_graph_tool` does NOT compute embeddings — only signatures/FTS/flows/communities. Embeddings require a separate `embed_graph_tool` call after each build | `packages/server/src/server/bootstrap.ts` (auto-calls `crg_embed_graph` after successful build when `embeddingProvider.kind !== "none"`) |
| **crg 2.3.2 lacks an OpenAI-compatible embedding provider** despite Hubcode's env vars (`CRG_OPENAI_BASE_URL`, `CRG_HUBCODE_LOCAL`) suggesting otherwise. Only `sentence-transformers`, `Google`, and `MiniMax` providers are implemented. UI options "Hubcode Local" and "OpenAI-compatible" currently result in 0 embeddings | Workaround: `pipx inject code-review-graph sentence-transformers` and select "sentence-transformers" in the UI. Upstream fix: add OpenAI-compat provider to crg (see `MiniMaxEmbeddingProvider` for reference). |

## Unrelated but adjacent bug lessons

- **Never put `listQuery` / `useQuery` objects in a WS subscription `useEffect` dep array.** The query object gets a new reference on every render, so the subscription thrashes (unsub → resub) on every tick and drops messages mid-swap. Use stable references (`queryClient`, `queryKey`) and invalidate via `queryClient.invalidateQueries({ queryKey })` when you need a refetch.
- **`DaemonClient.on(type, handler)` dispatches by EXACT type, not by category.** `client.on("status", …)` matches only `{ type: "status" }` — NOT `"indexing/status"` or any other slashed variant. Pass the full type string. Filtering inside the handler with `if (msg.type !== X) return` looks correct but hides the fact that the handler was registered on the wrong bucket and never fires for the intended events.
- **`??` (nullish coalescing) does NOT treat empty arrays/strings as missing.** An explicit `[]` passes through `deps.ignorePatterns ?? DEFAULT_IGNORES` unchanged, effectively disabling all defaults. `.code-review-graph/` self-watching then creates an infinite reindex loop because every graph write triggers a fresh reindex. Fix: separate "essential ignores" (always applied) from "default ignores" (opt-out-able), and treat empty arrays as "user wants defaults" at the caller.

### Older (pre-2.2, historical)

Not tracked here — if you find yourself supporting a user on pre-2.3, bump the minimum detected version in `packages/server/src/server/indexing/detector.ts` instead.

## What the daemon depends on (surface area)

### Process invocation

- Binary name: `code-review-graph` (detected via PATH in `detector.ts`).
- Spawn: `code-review-graph serve` (MCP stdio server, from `process-manager.ts`).
- Environment: `CRG_HUBCODE_LOCAL`, `CRG_RECURSE_SUBMODULES`, embedding provider vars (see `embedding-env.ts`).

### MCP tools called explicitly

Two today:

- `build_or_update_graph_tool(repo_root, full_rebuild?, base?, postprocess?, recurse_submodules?)` — returns dict with status, build_type, files_parsed, files_updated, total_nodes, total_edges, summary. **Incremental variant only reports diff counts**, not graph totals — always follow with `list_graph_stats_tool`.
- `list_graph_stats_tool(repo_root)` — returns `{ files_count, total_nodes, total_edges, last_updated, embeddings_count, ... }`. Authoritative source of truth for UI counters.

All other tools are discovered via `listTools()` and passed through to agents verbatim (no hardcoded dependency on name/schema).

### On-disk layout

- Index directory: `<cwd>/.code-review-graph/` (read by `index-size.ts` for `indexBytes`).
- Gitignore rule: written by `gitignore.ts` as `.code-review-graph/`.

## What to check when upstream crg updates

Run through this checklist on every minor/major crg bump:

1. **CLI sanity** — `code-review-graph --help` and `code-review-graph serve --help`. Flag removed or renamed? Update `DEFAULT_ARGS` in `process-manager.ts`.
2. **Tool registration** — spawn `code-review-graph serve`, connect via any MCP client, call `tools/list`. Check that `build_or_update_graph_tool` (or whatever name) still exists. Our `resolveToolName` handles `_tool` suffix flips automatically, but entirely new names require hardcoding.
3. **Tool signature** — call `build_or_update_graph_tool` with `{ repo_root: "/tmp/test-repo" }`. Validation error on an unknown arg? Check `python -c "from code_review_graph.main import build_or_update_graph_tool; import inspect; print(inspect.signature(build_or_update_graph_tool))"` and update the call site.
4. **Return shape** — trigger a reindex on a small repo and check `daemon.log` for `rawResultPreview` (we log first 200 chars of every reindex response). If the keys we parse (`files_parsed`, `total_nodes`) disappear or rename, update the parser block in `triggerReindex`.
5. **Index directory** — verify crg still writes to `<cwd>/.code-review-graph/`. If it moves (e.g. `~/.cache/crg/<hash>/`), update `CRG_DIR` in `gitignore.ts` and `CRG_INDEX_DIR` in `index-size.ts`.
6. **Python deps** — does crg now require a Python version we haven't allowed? Check `detector.ts` minimum.

## How to diagnose in prod without crg source access

The daemon logs three things that make upstream compat issues visible in seconds:

| Symptom | Signal in `daemon.log` |
|---|---|
| Tool renamed | `crg tool name resolved via cached manifest` (debug) — `requested=X` → `resolved=X_tool` |
| Tool arg renamed | `Reindex completed` with `rawResultPreview="1 validation error for call[...] <arg>\nUnexpected keyword argument"` |
| Tool returned error | `Reindex failed` with message `crg tool error: ...` (isError path) |
| Subprocess crashes | `crg subprocess exited` + `crg stderr: ...` (ring buffer visible in UI via "View logs") |
| Reindex hangs | `Reindex still running after 60s/180s/300s` + hard timeout at 10 min (`HUBCODE_CRG_REINDEX_TIMEOUT_MS` to override) |

## Files to touch when adapting

Canonical list — if you modify anything else for a version bump, consider whether it belongs in one of these:

- `packages/server/src/server/indexing/process-manager.ts` — spawn args
- `packages/server/src/server/indexing/mcp-client.ts` — tool name resolution
- `packages/server/src/server/indexing/detector.ts` — binary detection + version min
- `packages/server/src/server/indexing/gitignore.ts` — index dir path (gitignore side)
- `packages/server/src/server/indexing/index-size.ts` — index dir path (size calc)
- `packages/server/src/server/bootstrap.ts` (`triggerReindex`) — call args + response parse

## Bumping the supported version

When you confirm a new crg version works:

1. Run the checklist above.
2. Update the "Currently tested" table at the top of this doc with the new version.
3. Add a row to "Known breaking changes across versions" if anything broke.
4. Bump the detector's minimum if necessary (`detector.ts`).
5. Smoke test: empty repo, small repo (<100 files), medium repo (~1k files), reindex on file change. Confirm `fileCount`/`nodeCount`/`indexBytes` all populate in the UI.
