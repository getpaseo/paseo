import { UUID } from "builder-util-runtime";
import { z } from "zod";

export type AppReleaseChannel = "stable" | "beta";
export type AppUpdateCheckIntent = "automatic" | "manual";

export const rolloutManifestSchema = z.object({
  rolloutHours: z
    .union([z.number(), z.string().transform(Number)])
    .pipe(z.number().finite().nonnegative())
    .optional()
    .catch(undefined),
  releaseDate: z.string().optional().catch(undefined),
});

export function shouldAdmitAppUpdate(args: {
  channel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  if (args.intent === "manual") return true;
  if (args.channel !== "stable") return true;
  if (args.rolloutHours == null) return true;
  if (args.rolloutHours === 0) return true;
  if (!args.releaseDate) return true;

  const releaseTime = new Date(args.releaseDate).getTime();
  if (Number.isNaN(releaseTime)) return true;

  const ageHours = (args.now - releaseTime) / 3_600_000;
  if (ageHours < 0) return false;

  const pct = Math.min(100, (ageHours / args.rolloutHours) * 100);
  return args.bucket * 100 < pct;
}

export function bucketFromStagingUserId(stagingUserId: string): number {
  return UUID.parse(stagingUserId).readUInt32BE(12) / 0x100000000;
}
