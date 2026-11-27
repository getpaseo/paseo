import type { AcpTransformer } from "@getpaseo/plugin/server/acp";

// Hermes offers each edit mode twice: as an ACP session mode and as a value of its
// `edit_approval_policy` config option (`acp_adapter/modes.py`). Agents created before Hermes was
// bundled saved the session mode ID; this provider uses the config option, as ACP prefers.
const POLICY_BY_SESSION_MODE = new Map([
  ["default", "ask"],
  ["accept_edits", "workspace_session"],
  ["dont_ask", "session"],
]);

/**
 * Applies a saved session mode ID as its edit approval policy. Passes the mode through unchanged
 * when Hermes still offers it or no longer offers the policy.
 */
// COMPAT(hermesProvider): added in v0.17.4, remove after 2027-05-23 once legacy agents have resumed.
export const legacyModes: AcpTransformer = {
  async configure(change, { apply, catalog }) {
    if (change.target !== "mode" || change.value === null) return "pass";
    const policy = POLICY_BY_SESSION_MODE.get(change.value);
    if (policy === undefined) return "pass";
    const { modes } = catalog();
    if (modes.some((mode) => mode.id === change.value)) return "pass";
    if (!modes.some((mode) => mode.id === policy)) return "pass";
    await apply({ target: "mode", value: policy });
    return "handled";
  },
};
