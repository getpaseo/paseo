import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const remoteFileRef = z.object({
  deviceSlug: z.string().min(1),
  locationId: z.string().min(1),
  relativePath: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  size: z.number().nonnegative().optional(),
  sha256: z.string().optional(),
});

export const spacedriveStatus = defineRpc({
  name: "spacedrive.status",
  input: z.object({}),
  output: z.object({ running: z.boolean(), managed: z.boolean(), port: z.number().int() }),
});

export const spacedriveSearch = defineRpc({
  name: "spacedrive.search",
  input: z.object({ libraryId: z.string().uuid(), query: z.string().min(1), limit: z.number().int().positive().max(100).default(20) }),
  output: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
});

export const spacedriveCopyToLocal = defineRpc({
  name: "spacedrive.copyToLocal",
  input: z.object({
    libraryId: z.string().uuid(),
    ref: remoteFileRef,
    destination: z.string().min(1),
    maxBytes: z.number().int().positive().max(2_000_000_000).default(200_000_000),
  }),
  output: z.object({ ok: z.boolean(), path: z.string().optional(), error: z.string().optional() }),
});
