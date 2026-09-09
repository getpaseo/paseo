/**
 * Forge-neutral check traits carried on the wire alongside the stable check
 * status union. Traits are open-ended by design (unknown values must be
 * ignored by consumers); these constants cover the traits the shipped forges
 * emit today so producers and the presentation layer cannot drift apart.
 */
export const CHECK_TRAIT_MANUAL = "manual";
export const CHECK_TRAIT_ACTION_REQUIRED = "action_required";
export const CHECK_TRAIT_WARNING = "warning";

export type KnownCheckTrait =
  | typeof CHECK_TRAIT_MANUAL
  | typeof CHECK_TRAIT_ACTION_REQUIRED
  | typeof CHECK_TRAIT_WARNING;
