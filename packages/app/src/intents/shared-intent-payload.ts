import { z } from "zod";

const MAX_SHARED_TEXT_LENGTH = 100_000;

const SharedFileSchema = z.object({
  uri: z.string().min(1),
  mimeType: z.string().min(1),
  fileName: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
});

const SharedIntentPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("share"),
    text: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    files: z.array(SharedFileSchema).default([]),
    skippedFiles: z.number().int().nonnegative().default(0),
  }),
  z.object({
    kind: z.literal("process_text"),
    text: z.string().nullable().optional(),
  }),
]);

export type SharedIntentPayload = z.infer<typeof SharedIntentPayloadSchema>;
export type SharedIntentFile = z.infer<typeof SharedFileSchema>;

/** Validates what the native side handed over; anything malformed is dropped whole. */
export function parseSharedIntentPayload(raw: unknown): SharedIntentPayload | null {
  const result = SharedIntentPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_SHARED_TEXT_LENGTH);
}

/**
 * Turns a share into composer text. A subject that the shared text already
 * contains (browsers send the page title as both) is not repeated.
 */
export function buildSharedPromptText(payload: SharedIntentPayload): string {
  const text = normalizeText(payload.text);
  if (payload.kind !== "share") {
    return text;
  }
  const subject = normalizeText(payload.subject);
  if (!subject || text.includes(subject)) {
    return text;
  }
  return text ? `${subject}\n${text}` : subject;
}

export function isImageFile(file: SharedIntentFile): boolean {
  return file.mimeType.toLowerCase().startsWith("image/");
}
