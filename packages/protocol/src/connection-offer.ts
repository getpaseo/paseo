import { z } from "zod";
export {
  decodeOfferFragmentPayload,
  parseConnectionOffer,
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
  type ConnectionOfferV2,
} from "./connection-offer-wire.js";

/**
 * Relay-only pairing offer.
 *
 * `serverId` is a stable daemon identifier scoped to `PASEO_HOME`, and is also
 * used as the relay session identifier.
 */
export const ConnectionOfferV2Schema = z.object({
  v: z.literal(2),
  serverId: z.string().min(1),
  daemonPublicKeyB64: z.string().min(1),
  relay: z.object({
    endpoint: z.string().min(1),
    useTls: z.boolean().optional(),
  }),
  // COMPAT(relayProtectedSecurity): added in v0.13.0. Present when the daemon requires
  // protected endpoint security; clients pin it before their first handshake.
  minimumSecurityMode: z.literal("protected").optional(),
});

export const ConnectionOfferSchema = ConnectionOfferV2Schema;
