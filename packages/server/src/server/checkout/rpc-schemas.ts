import { z } from "zod";
import {
  CheckoutDiffCompareSchema,
  CheckoutErrorSchema,
  DiffHunkSchema,
} from "../../shared/messages.js";

export const DiffFileMetadataSchema = z.object({
  path: z.string(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  status: z.enum(["ok", "too_large", "binary"]).optional(),
  fingerprint: z.string(),
});

export type DiffFileMetadata = z.infer<typeof DiffFileMetadataSchema>;

export const CheckoutSubscribeDiffRequestSchema = z.object({
  type: z.literal("checkout/subscribe_diff"),
  requestId: z.string(),
  subscriptionId: z.string(),
  cwd: z.string(),
  compare: z.lazy(() => CheckoutDiffCompareSchema),
});

export const CheckoutUnsubscribeDiffRequestSchema = z.object({
  type: z.literal("checkout/unsubscribe_diff"),
  subscriptionId: z.string(),
});

export const CheckoutGetFileHunksRequestSchema = z.object({
  type: z.literal("checkout/get_file_hunks"),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  compare: z.lazy(() => CheckoutDiffCompareSchema),
});

export const CheckoutDiffSnapshotSchema = z.object({
  type: z.literal("checkout/diff_snapshot"),
  payload: z.object({
    subscriptionId: z.string(),
    requestId: z.string().optional(),
    cwd: z.string(),
    files: z.array(DiffFileMetadataSchema),
    error: z.lazy(() => CheckoutErrorSchema).nullable(),
  }),
});

export const CheckoutFileHunksResponseSchema = z.object({
  type: z.literal("checkout/file_hunks_response"),
  payload: z.object({
    requestId: z.string(),
    path: z.string(),
    hunks: z.array(z.lazy(() => DiffHunkSchema)),
    error: z.lazy(() => CheckoutErrorSchema).nullable(),
  }),
});
