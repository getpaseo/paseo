// Heuristic classification of MCP tool names into "read-only" vs
// "write/exec/side-effecting" buckets. Used by hubcode-agent to filter the
// tools list it advertises to the LLM when the user picks Plan Mode.
//
// MCP tool descriptors don't carry a structured `kind: "read" | "write"`
// field, so we have to lean on naming conventions. Hubcode's built-in tools
// (`list_agents`, `create_terminal`, `kill_terminal`, …) follow a consistent
// verb_object pattern and most external MCP servers (filesystem, git, github,
// etc.) do too. The classifier is intentionally conservative: anything we
// can't positively identify as read-only gets dropped in plan mode, so a
// disobedient model literally cannot call e.g. `write_file` from a server we
// don't recognize.
//
// Trade-off: a few harmless read-only tools whose names don't match a known
// prefix will get hidden in plan mode. That's the right default — false
// negatives in plan mode are recoverable (user switches mode, retries),
// false positives mean the model edits files when the user explicitly asked
// for read-only.

const FLAT_NAME_SEPARATOR = "__";

/** Strip the `<server>__` prefix used by `toFlatName` in hubcode-mcp-runtime. */
function bareToolName(flatName: string): string {
  const idx = flatName.indexOf(FLAT_NAME_SEPARATOR);
  if (idx < 0) return flatName;
  return flatName.slice(idx + FLAT_NAME_SEPARATOR.length);
}

const READ_PREFIXES = [
  "list_",
  "get_",
  "read_",
  "search_",
  "find_",
  "grep_",
  "view_",
  "cat_",
  "inspect_",
  "describe_",
  "show_",
  "status_",
  "info_",
  "query_",
  "fetch_",
  "head_",
  "peek_",
  "has_",
  "is_",
  "count_",
  "capture_",
  "wait_",
  "diff_",
] as const;

// Substrings that flag a tool as state-mutating *when found inside a name
// that already matched a read prefix* (the only path that consults this
// list). Guards against adversarial naming like `get_and_delete_record`.
// Kept narrow on purpose: words like "pull", "merge", "checkout", "bash",
// "shell" appear as nouns in legitimate read-only tool names
// (`get_pull_request`, `read_bash_history`) and would cause false
// positives if listed here.
const WRITE_TOKENS = [
  "write",
  "edit",
  "create",
  "update",
  "delete",
  "remove",
  "destroy",
  "kill",
  "archive",
  "uninstall",
  "_send",
  "_set_",
  "_cancel",
  "_pause",
  "_resume",
  "_trigger",
  "_respond",
] as const;

// Tools that are pure output / side-effect-free in a way the prefix
// heuristic can't capture, so they need an explicit allow.
const ALWAYS_ALLOW = new Set<string>([
  // Voice TTS to the user — output only, no state mutation.
  "speak",
]);

export function isReadOnlyTool(flatName: string): boolean {
  const bare = bareToolName(flatName).toLowerCase();
  if (ALWAYS_ALLOW.has(bare)) return true;
  if (READ_PREFIXES.some((p) => bare.startsWith(p))) {
    // Even a read prefix loses if the rest of the name contains a write
    // token (e.g. a hypothetical `get_and_delete_*`).
    if (WRITE_TOKENS.some((t) => bare.includes(t))) return false;
    return true;
  }
  return false;
}
