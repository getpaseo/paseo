import type { Logger } from "pino";
import type { McpPayload } from "./types.js";

/**
 * In-memory catalog of library MCPs the app has asked us to inject into
 * Hubcode-GUI agent sessions. The Library UI lives in auth-server DB, but
 * the daemon doesn't hold the user's session token — so the app pushes the
 * list over the WebSocket whenever the Library list changes and the daemon
 * merges them into each new Claude SDK session.
 *
 * Scope is process-global (one daemon = one user), cleared on restart; the
 * app republishes after reconnect. Entries are keyed by `name` — same slug
 * the Sync writer uses, so CLI and GUI stay consistent.
 */
export interface GuiMcpEntry {
  /** Slug used as the MCP server id in the SDK options. */
  name: string;
  payload: McpPayload;
}

export class GuiMcpRegistry {
  private entries = new Map<string, GuiMcpEntry>();
  private readonly logger: Logger;

  constructor(deps: { logger: Logger }) {
    this.logger = deps.logger.child({ module: "gui-mcp-registry" });
  }

  replaceAll(entries: GuiMcpEntry[]): void {
    this.entries.clear();
    for (const entry of entries) {
      if (!entry.name || !entry.payload) continue;
      this.entries.set(entry.name, entry);
    }
    this.logger.info({ count: this.entries.size }, "GUI MCP registry updated");
  }

  list(): GuiMcpEntry[] {
    return [...this.entries.values()];
  }
}
