import type { CheckoutPrStatusResponse, ForgeAuthState } from "@getpaseo/protocol/messages";
import { parseForgeAuthState } from "@/git/forge";

type WireCheckoutPrStatusPayload = CheckoutPrStatusResponse["payload"];

export type CheckoutPrStatusPayload = Omit<WireCheckoutPrStatusPayload, "authState"> & {
  authState: ForgeAuthState;
};

export function normalizeCheckoutPrStatusPayload(
  payload: WireCheckoutPrStatusPayload,
): CheckoutPrStatusPayload {
  return {
    ...payload,
    // COMPAT(forgeAuthState): added in v0.1.106, remove after 2026-12-27 once
    // all supported daemons send authState.
    authState:
      parseForgeAuthState(payload.authState) ??
      (payload.githubFeaturesEnabled ? "authenticated" : "unauthenticated"),
  };
}
