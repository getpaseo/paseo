import { z } from "zod";

const version = { protocolVersion: z.literal(1) };
const fileKind = z.enum(["text", "image", "binary"]);

export const describeSchema = z.object({
  ...version,
  version: z.literal(1),
  capabilities: z.array(z.enum(["files", "watch", "resolve-command"])),
});

export const resolvedCommandSchema = z.object({
  path: z.string().nullable(),
});

const readyFile = z.object({
  status: z.literal("ready"),
  path: z.string(),
  kind: fileKind,
  encoding: z.enum(["utf-8", "binary"]),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  revision: z.string(),
});

const fileStatValueSchema = z.discriminatedUnion("status", [
  readyFile,
  z.object({ status: z.literal("missing"), path: z.string() }),
  z.object({
    status: z.literal("error"),
    path: z.string(),
    error: z.string(),
  }),
]);

export const fileStatSchema = fileStatValueSchema.and(z.object(version)).transform((result) => {
  const { protocolVersion: _protocolVersion, ...value } = result;
  return value;
});

export const directorySchema = z
  .object({
    ...version,
    path: z.string(),
    entries: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        kind: z.enum(["file", "directory"]),
        size: z.number().int().nonnegative(),
        modifiedAt: z.string(),
      }),
    ),
  })
  .transform((result) => {
    const { protocolVersion: _protocolVersion, ...value } = result;
    return value;
  });

export const writeResultSchema = z
  .discriminatedUnion("status", [
    z.object({
      ...version,
      status: z.literal("written"),
      modifiedAt: z.string(),
      size: z.number().int().nonnegative(),
      revision: z.string(),
    }),
    z.object({ ...version, status: z.literal("conflict"), version: fileStatValueSchema }),
    z.object({ ...version, status: z.literal("error"), error: z.string() }),
  ])
  .transform((result) => {
    const { protocolVersion: _protocolVersion, ...value } = result;
    return value;
  });

export const watchEventSchema = z.discriminatedUnion("type", [
  z.object({ ...version, type: z.literal("ready") }),
  z.object({ ...version, type: z.literal("subscribed"), subscriptionId: z.string() }),
  z.object({ ...version, type: z.literal("unsubscribed"), subscriptionId: z.string() }),
  z.object({
    ...version,
    type: z.literal("changed"),
    subscriptionId: z.string(),
    paths: z.array(z.string()),
  }),
  z.object({ ...version, type: z.literal("overflow"), subscriptionId: z.string() }),
  z.object({
    ...version,
    type: z.literal("error"),
    subscriptionId: z.string().optional(),
    message: z.string(),
  }),
]);
