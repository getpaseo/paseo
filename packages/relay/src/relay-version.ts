export type RelayProtocolVersion = "1" | "2";

export const LEGACY_RELAY_VERSION: RelayProtocolVersion = "1";
export const CURRENT_RELAY_VERSION: RelayProtocolVersion = "2";

export function resolveRelayVersion(rawValue: string | null): RelayProtocolVersion | null {
  if (rawValue == null) return LEGACY_RELAY_VERSION;
  const value = rawValue.trim();
  if (!value) return LEGACY_RELAY_VERSION;
  if (value === LEGACY_RELAY_VERSION || value === CURRENT_RELAY_VERSION) {
    return value;
  }
  return null;
}
