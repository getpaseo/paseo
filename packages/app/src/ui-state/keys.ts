/**
 * Map client draft-store keys (which include serverId) to daemon wire keys
 * (host-scoped, no serverId).
 *
 * Client shapes:
 * - agent:{serverId}:{agentId}
 * - draft:{serverId}:{draftId}
 * - new-workspace
 * - new-workspace:draft:{draftId}
 * - legacy new-workspace:{serverId}:{path...} (dropped / not synced)
 */
export function toWireComposerKey(clientDraftKey: string): string | null {
  const key = clientDraftKey.trim();
  if (!key) {
    return null;
  }

  if (key === "new-workspace") {
    return "new-workspace";
  }

  if (key.startsWith("new-workspace:draft:")) {
    return key;
  }

  // Legacy new-workspace keys include server + path — not portable across devices.
  if (key.startsWith("new-workspace:")) {
    return null;
  }

  if (key.startsWith("agent:")) {
    const parts = key.split(":");
    // agent : serverId : agentId  (agentId may contain colons — take rest after server)
    if (parts.length < 3) {
      return null;
    }
    const agentId = parts.slice(2).join(":").trim();
    if (!agentId) {
      return null;
    }
    return `agent:${agentId}`;
  }

  if (key.startsWith("draft:")) {
    const parts = key.split(":");
    if (parts.length < 3) {
      return null;
    }
    const draftId = parts.slice(2).join(":").trim();
    if (!draftId) {
      return null;
    }
    return `draft:${draftId}`;
  }

  return null;
}

/**
 * Build a review wire key from the same parts as buildReviewDraftKey, without serverId.
 * Prefer workspaceId when present.
 */
export function toWireReviewKey(input: {
  workspaceId?: string | null;
  cwd: string;
  mode: string;
  baseRef: string;
  ignoreWhitespace: boolean;
}): string {
  const workspaceId = input.workspaceId?.trim();
  const workspacePart = workspaceId
    ? `workspace=${encodeURIComponent(workspaceId)}`
    : `cwd=${encodeURIComponent(input.cwd.trim())}`;
  // Match buildReviewDraftKey order after stripping server=: workspace, mode, base, whitespace.
  return [
    "review",
    workspacePart,
    `mode=${input.mode}`,
    `base=${encodeURIComponent(input.baseRef)}`,
    `ignoreWhitespace=${input.ignoreWhitespace ? "true" : "false"}`,
  ].join(":");
}

/** Strip leading `review:server=...:` prefix from a client review draft key if present. */
export function clientReviewKeyToWireKey(clientReviewKey: string): string | null {
  const key = clientReviewKey.trim();
  if (!key.startsWith("review:")) {
    return null;
  }
  // Client key: review:server=...:workspace=...:mode=...:base=...:ignoreWhitespace=...
  const withoutPrefix = key.slice("review:".length);
  const segments = withoutPrefix.split(":");
  if (segments[0]?.startsWith("server=")) {
    const rest = segments.slice(1).join(":");
    return rest ? `review:${rest}` : null;
  }
  // Already wire-shaped (no server segment).
  return key;
}
