import { z } from "zod";

// Luna Reserve is a separate allowance some ChatGPT accounts get once their ordinary
// Codex usage runs out. The Codex TUI moves a task onto it by itself. An app-server
// client has to opt in on `account/rateLimits/read` and then run the reserve model,
// which `model/list` does not return.

export const LUNA_RESERVE_MODEL = "gpt-reserve";
const LUNA_RESERVE_BANNER = "luna_reserve";
const LUNA_RESERVE_LIMIT_NAME = "gpt-reserve";

export const LUNA_RESERVE_RATE_LIMITS_PARAMS = {
  supportsLunaReserve: true,
  excludeResetCreditDetails: true,
} as const;

// The turn that hit the limit already recorded its input in the thread, so the reserve
// turn only asks the model to go on.
export const LUNA_RESERVE_CONTINUE_PROMPT = "Continue.";

const RateLimitSnapshotSchema = z
  .object({
    limitName: z.string().nullable().optional(),
    normalModelSlug: z.string().nullable().optional(),
    spendControlReached: z.boolean().nullable().optional(),
    rateLimitReachedType: z.unknown().optional(),
    credits: z
      .object({
        hasCredits: z.boolean().optional(),
        unlimited: z.boolean().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const RateLimitUpsellSchema = z
  .object({
    banner_type: z.string(),
    blocked_model_slug: z.string().nullable().optional(),
  })
  .passthrough();

const AccountRateLimitsSchema = z
  .object({
    ordinaryUsageAllowed: z.boolean().nullable().optional(),
    rateLimits: RateLimitSnapshotSchema.nullable().optional(),
    rateLimitsByLimitId: z
      .record(z.string(), RateLimitSnapshotSchema.nullable())
      .nullable()
      .optional(),
    rateLimitUpsell: z.unknown().optional(),
  })
  .passthrough();

export type CodexAccountRateLimits = z.infer<typeof AccountRateLimitsSchema>;

export function parseCodexAccountRateLimits(raw: unknown): CodexAccountRateLimits | null {
  const parsed = AccountRateLimitsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isCodexUsageLimitError(codexErrorInfo: unknown): boolean {
  return codexErrorInfo === "usageLimitExceeded";
}

/**
 * Whether the reserve can continue `model`. It stands in for one model only, the one
 * its quota is named after; an agent on any other model keeps failing at the limit
 * rather than silently moving to a smaller model.
 */
export function lunaReserveCovers(model: string, limits: CodexAccountRateLimits): boolean {
  if (limits.ordinaryUsageAllowed !== false) return false;
  const banner = RateLimitUpsellSchema.safeParse(limits.rateLimitUpsell);
  if (!banner.success || banner.data.banner_type !== LUNA_RESERVE_BANNER) return false;
  const blocked = banner.data.blocked_model_slug;
  if (blocked && blocked !== model) return false;
  const reserve = Object.values(limits.rateLimitsByLimitId ?? {}).find(
    (snapshot) => snapshot?.limitName === LUNA_RESERVE_LIMIT_NAME,
  );
  if (!reserve) return false;
  return reserve.normalModelSlug ? reserve.normalModelSlug === model : /(^|-)luna$/.test(model);
}

/**
 * Whether the account may use its ordinary allowance again. As in the Codex TUI, only
 * the backend's explicit permission counts, never a percentage or a reset time.
 */
export function ordinaryUsageRecovered(limits: CodexAccountRateLimits): boolean {
  const credits = limits.rateLimits?.credits;
  const hasCredits = credits?.unlimited === true || credits?.hasCredits === true;
  return (
    (limits.ordinaryUsageAllowed === true ||
      (limits.ordinaryUsageAllowed === false && hasCredits)) &&
    limits.rateLimitUpsell == null &&
    limits.rateLimits?.spendControlReached !== true &&
    limits.rateLimits?.rateLimitReachedType == null
  );
}
