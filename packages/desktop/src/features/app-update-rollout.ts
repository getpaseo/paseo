import { createHash } from "node:crypto";
import { z } from "zod";

export type AppReleaseChannel = "stable" | "beta";
export type AppUpdateCheckIntent = "automatic" | "manual";

const HOUR_MS = 3_600_000;
const CANARY_PERCENT = 5;
const MAX_CANARY_HOURS = 8;
// A release date this far ahead of the local clock means the clock is wrong,
// not that the release is new. One hour of daylight-saving error stays inside.
const CLOCK_SKEW_TOLERANCE_HOURS = 2;

export const rolloutManifestSchema = z.object({
  rolloutHours: z
    .union([z.number(), z.string().transform(Number)])
    .pipe(z.number().finite().nonnegative())
    .optional()
    .catch(undefined),
  releaseDate: z.string().optional().catch(undefined),
});

/**
 * A paced release reaches automatic clients gradually. Every other release
 * (beta, `rolloutHours: 0`, or no usable `rolloutHours`) reaches them at once.
 */
export function isPacedRelease(args: {
  channel: AppReleaseChannel;
  rolloutHours: number | undefined;
}): boolean {
  return args.channel === "stable" && args.rolloutHours != null && args.rolloutHours > 0;
}

/**
 * Share of automatic clients admitted to a paced release: a canary hold at 5%,
 * then a linear ramp to 100% at `rolloutHours`.
 */
export function rolloutAdmissionPercent(args: { rolloutHours: number; ageHours: number }): number {
  const ageHours = Math.max(0, args.ageHours);
  if (ageHours >= args.rolloutHours) return 100;

  const canaryHours = Math.min(MAX_CANARY_HOURS, args.rolloutHours / 2);
  if (ageHours <= canaryHours) return CANARY_PERCENT;

  const rampProgress = (ageHours - canaryHours) / (args.rolloutHours - canaryHours);
  return Math.min(100, CANARY_PERCENT + (100 - CANARY_PERCENT) * rampProgress);
}

/**
 * Every branch that cannot place the client on the rollout curve admits it.
 * A client must never be refused a release because of bad metadata or a bad
 * local clock.
 */
export function shouldAdmitAppUpdate(args: {
  channel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  if (args.intent === "manual") return true;
  if (!isPacedRelease(args) || args.rolloutHours == null) return true;
  if (!args.releaseDate) return true;

  const releaseTime = new Date(args.releaseDate).getTime();
  if (Number.isNaN(releaseTime)) return true;

  const ageHours = (args.now - releaseTime) / HOUR_MS;
  if (Number.isNaN(ageHours)) return true;
  if (ageHours < -CLOCK_SKEW_TOLERANCE_HOURS) return true;

  const percent = rolloutAdmissionPercent({ rolloutHours: args.rolloutHours, ageHours });
  return args.bucket * 100 < percent;
}

/**
 * Position of one install in one release's rollout, in [0, 1). Salting with the
 * version gives every release a different canary group, so no install is first
 * for every release and none is last for every release.
 */
export function rolloutBucket(stagingUserId: string, version: string): number {
  const digest = createHash("sha256").update(`${stagingUserId}:${version}`).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}
