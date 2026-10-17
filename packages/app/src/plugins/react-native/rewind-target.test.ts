import { describe, expect, test } from "vitest";
import type { SessionState } from "@/stores/session-store";
import { selectPluginRewindCapabilities } from "./rewind-target";

const claude = {
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};
const codex = {
  supportsRewindConversation: true,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

function session(
  agents: Record<string, object>,
  details: Record<string, object> = {},
): SessionState {
  const toMap = (entries: Record<string, object>) =>
    new Map(Object.entries(entries).map(([id, capabilities]) => [id, { id, capabilities }]));
  return { agents: toMap(agents), agentDetails: toMap(details) } as unknown as SessionState;
}

describe("selectPluginRewindCapabilities", () => {
  test("reads the agent's own provider capabilities on the given host", () => {
    const sessions = { a: session({ claude: claude }), b: session({ codex: codex }) };
    expect(selectPluginRewindCapabilities(sessions, "a", "claude")).toBe(claude);
    expect(selectPluginRewindCapabilities(sessions, "b", "codex")).toBe(codex);
  });

  test("falls back to agent details, as other plugin surfaces do", () => {
    expect(
      selectPluginRewindCapabilities({ a: session({}, { archived: codex }) }, "a", "archived"),
    ).toBe(codex);
  });

  test("is null for an unknown host or agent", () => {
    const sessions = { a: session({ claude: claude }) };
    expect(selectPluginRewindCapabilities(sessions, "missing", "claude")).toBeNull();
    expect(selectPluginRewindCapabilities(sessions, "a", "missing")).toBeNull();
  });
});
