import type { InitializeResponse } from "@agentclientprotocol/sdk";

/**
 * Stabilized ACP method (June 2026). Not typed on `@agentclientprotocol/sdk@0.17.1`.
 * COMPAT(acpSessionDelete): call via `ClientSideConnection.extMethod` until the
 * dependency floor includes typed `deleteSession` (sdk >= 1.2). Remove by 2026-12-25.
 */
export const ACP_SESSION_DELETE_METHOD = "session/delete";

/**
 * Agents advertise support by returning `sessionCapabilities.delete` as `{}`
 * (or any non-null object). Omitted / null means the client must not call delete.
 */
export function hasAcpSessionDeleteCapability(
  initialize: Pick<InitializeResponse, "agentCapabilities"> | { agentCapabilities?: unknown },
): boolean {
  const capabilities = initialize.agentCapabilities;
  if (!capabilities || typeof capabilities !== "object") {
    return false;
  }
  const sessionCapabilities = (capabilities as { sessionCapabilities?: unknown })
    .sessionCapabilities;
  if (!sessionCapabilities || typeof sessionCapabilities !== "object") {
    return false;
  }
  const deleteCapability = (sessionCapabilities as { delete?: unknown }).delete;
  return deleteCapability != null;
}
