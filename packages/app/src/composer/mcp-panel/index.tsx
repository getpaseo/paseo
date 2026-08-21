import { useCallback, useEffect, useState, type ReactElement } from "react";
import { McpServersPanel } from "./panel";
import { useAgentMcpServers } from "./use-agent-mcp-servers";

export interface McpServersControlProps {
  serverId: string;
  agentId: string;
  glyphSize: number;
  /**
   * False for a background tab. Retained panes stay mounted and the menu is portalled
   * out of the hidden subtree, so without this a panel opened in one tab would keep
   * rendering — and keep fetching — after you switched away from it.
   */
  isPaneFocused: boolean;
}

/**
 * The MCP servers control: a plug in the composer's right rail, and the panel behind it.
 *
 * The status is fetched only while the panel is open. Asking eagerly on mount looked
 * harmless until it was measured against a real Codex agent: `mcpServerStatus/list`
 * returns every server's full tool schemas — 1.1 MB and ~3.5s — far too much to spend
 * on every agent someone clicks on. Claude answers the same question in 3ms, but gating
 * on the provider would put one provider's quirk into shared app logic, so the cheap
 * case waits with the expensive one.
 */
export function McpServersControl({
  serverId,
  agentId,
  glyphSize,
  isPaneFocused,
}: McpServersControlProps): ReactElement | null {
  const [isOpen, setIsOpen] = useState(false);
  const open = isOpen && isPaneFocused;
  const { view, refresh, canFetch } = useAgentMcpServers(serverId, agentId, { enabled: open });
  const handleRefresh = useCallback(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // `isOpen` drives the fetch, so it must never outlive the menu it describes. A panel
  // that unmounts — because the agent changed, or the view became unsupported — never
  // reports itself closed, and a stale `true` would make the next agent fetch behind a
  // closed menu, which is the exact cost this gating exists to avoid.
  useEffect(() => {
    setIsOpen(false);
  }, [serverId, agentId]);

  // Losing focus closes it for real rather than only hiding it, so returning to the tab
  // does not reopen a panel the user never asked for again.
  useEffect(() => {
    if (!isPaneFocused) setIsOpen(false);
  }, [isPaneFocused]);

  // The panel hides itself for an unsupported view; this only skips the agents whose
  // capabilities rule it out before a request is worth making.
  if (!canFetch) {
    return null;
  }

  return (
    <McpServersPanel
      open={open}
      onOpenChange={setIsOpen}
      view={view}
      onRefresh={handleRefresh}
      glyphSize={glyphSize}
    />
  );
}
