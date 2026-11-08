import { z } from "zod";

export const TimelineImageIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const StoredTimelineImageSchema = z.object({
  kind: z.literal("stored"),
  id: TimelineImageIdSchema,
  mimeType: z.string().startsWith("image/"),
  byteSize: z.number().int().nonnegative(),
});

export const TimelineImageSchema = z.discriminatedUnion("kind", [
  StoredTimelineImageSchema,
  z.object({ kind: z.literal("unavailable"), mimeType: z.string() }),
]);

export type TimelineImage = z.infer<typeof TimelineImageSchema>;
