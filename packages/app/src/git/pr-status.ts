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
    // COMPAT(forgeAuthState): normalize the legacy GitHub boolean for daemons
    // predating v0.2.0-beta.1. Remove after 2027-01-17 once the supported daemon
    // floor is >= v0.2.0.
    authState:
      parseForgeAuthState(payload.authState) ??
      (payload.githubFeaturesEnabled ? "authenticated" : "unauthenticated"),
  };
}
