/**
 * Compatibility exports for tests and non-visual derivations. Rich PR-pane
 * contributions now come from client forge modules and validate the open
 * `forgeSpecific` envelope at runtime.
 */
import type { CheckoutPrStatusResponse } from "@getpaseo/protocol/messages";
import type { Forge } from "@/git/forge";
import { CLIENT_FORGE_LOGIC_MODULES } from "@/git/forges";
import type { PrPaneCheck } from "./data";

type CheckoutPrStatus = NonNullable<CheckoutPrStatusResponse["payload"]["status"]>;

const CLIENT_NATIVE_FALLBACK_CONTRIBUTIONS = CLIENT_FORGE_LOGIC_MODULES.flatMap(
  (module) => module.facts?.nativeFallbackChecks ?? [],
);

/**
 * Fallback check rows for a status whose forge reports no individual checks.
 * Returns [] for forges that don't synthesize one.
 */
export function getNativeFallbackChecks(status: CheckoutPrStatus, forge: Forge): PrPaneCheck[] {
  const facts = status.forgeSpecific;
  if (!facts) {
    return [];
  }
  const checks: PrPaneCheck[] = [];
  for (const contribute of CLIENT_NATIVE_FALLBACK_CONTRIBUTIONS) {
    const check = contribute.contribute(facts, status, forge);
    if (check) {
      checks.push(check);
    }
  }
  return checks;
}
