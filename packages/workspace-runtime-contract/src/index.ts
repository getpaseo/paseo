import { z } from "zod";

export const COMMAND_RUNTIME_PROTOCOL_VERSION = 1 as const;

const ProtocolVersionSchema = z.literal(COMMAND_RUNTIME_PROTOCOL_VERSION);
const EnvironmentSchema = z.record(z.string(), z.string());
const OptionsSchema = z.record(z.string(), z.json());
const CommandSchema = z.array(z.string()).min(1);

export const CommandRuntimeProjectSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: z.string() }).strict(),
  z
    .object({
      kind: z.literal("git"),
      url: z.string(),
      revision: z.string(),
      subdirectory: z.string().optional(),
    })
    .strict(),
]);

const ResolvedWorktreeSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("branch-off"),
      baseBranch: z.string(),
      branchName: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("checkout-branch"), branchName: z.string() }).strict(),
  z
    .object({
      kind: z.enum(["checkout-change-request", "checkout-github-pr"]),
      forge: z.string().optional(),
      changeRequestNumber: z.number().optional(),
      githubPrNumber: z.number().optional(),
      headRef: z.string(),
      headRepositoryOwner: z.string().optional(),
      baseRefName: z.string(),
      checkoutRefs: z
        .array(z.object({ remoteName: z.string().optional(), remoteRef: z.string() }).strict())
        .optional(),
      localBranchName: z.string().optional(),
      pushRemoteUrl: z.string().optional(),
      trackOriginHead: z.boolean().optional(),
    })
    .strict(),
]);

export const CommandRuntimePlacementIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), relativeCwd: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal("branch"),
      branchName: z.string(),
      baseRef: z.string(),
      relativeCwd: z.string().optional(),
      worktreeSlug: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("checkout"),
      ref: z.string(),
      relativeCwd: z.string().optional(),
      worktreeSlug: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resolved-worktree"),
      source: ResolvedWorktreeSourceSchema,
      worktreeSlug: z.string(),
      relativeCwd: z.string().optional(),
    })
    .strict(),
]);

export const CommandRuntimeCreateInputSchema = z
  .object({
    workspaceId: z.string(),
    project: z
      .object({ projectId: z.string(), source: CommandRuntimeProjectSourceSchema })
      .strict(),
    placement: CommandRuntimePlacementIntentSchema,
    purpose: z.literal("discovery").optional(),
    markFirstAgentBranchAutoName: z.boolean().optional(),
    seedPaseoConfigFrom: z.string().optional(),
  })
  .strict();

export const CommandRuntimeLifecycleRequestSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    runtimeInstanceId: z.string().min(1),
    input: CommandRuntimeCreateInputSchema.optional(),
    options: OptionsSchema,
    workspaceIds: z.array(z.string()).optional(),
  })
  .strict();

export const CommandRuntimeStateSchema = z
  .object({
    workspaceId: z.string(),
    lifecycle: z.enum(["ready", "paused"]),
    lifecycleEnvironment: EnvironmentSchema.optional(),
  })
  .strict();

export const CommandRuntimePlacementSchema = z
  .object({
    cwd: z.string(),
  })
  .strict();

export const CommandRuntimeInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }).strict(),
  z
    .object({
      status: z.literal("paused"),
      state: CommandRuntimeStateSchema,
      placement: CommandRuntimePlacementSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      state: CommandRuntimeStateSchema,
      placement: CommandRuntimePlacementSchema,
    })
    .strict(),
  z.object({ status: z.literal("error"), message: z.string() }).strict(),
]);

export const CommandRuntimeLifecycleResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("state"),
      protocolVersion: ProtocolVersionSchema,
      state: CommandRuntimeStateSchema,
      placement: CommandRuntimePlacementSchema,
      materializedFreshContent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("inspection"),
      protocolVersion: ProtocolVersionSchema,
      inspection: CommandRuntimeInspectionSchema,
    })
    .strict(),
  z.object({ type: z.literal("ok"), protocolVersion: ProtocolVersionSchema }).strict(),
]);

export const CommandRuntimeDescribeResponseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    modes: z.array(z.enum(["pipes", "pty"])),
    reconcile: z.boolean().optional().default(false),
  })
  .strict();

export const CommandRuntimeProcessPurposeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.literal("terminal") }).strict(),
  z.object({ kind: z.literal("git") }).strict(),
  z.object({ kind: z.literal("discovery") }).strict(),
  z.object({ kind: z.literal("workspace-helper") }).strict(),
  z.object({ kind: z.literal("workspace-script") }).strict(),
  z.object({ kind: z.literal("setup") }).strict(),
  z.object({ kind: z.literal("archive") }).strict(),
]);

export const CommandRuntimeStdioSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pipes") }).strict(),
  z
    .object({
      kind: z.literal("pty"),
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
      term: z.string().optional(),
    })
    .strict(),
]);

export const CommandRuntimeSpawnEnvelopeSchema = z
  .object({
    type: z.literal("spawn"),
    protocolVersion: ProtocolVersionSchema,
    runtimeInstanceId: z.string().min(1),
    argv: CommandSchema,
    cwd: z.string().optional(),
    env: EnvironmentSchema,
    purpose: CommandRuntimeProcessPurposeSchema,
    options: OptionsSchema,
    execId: z.string().min(1),
    stdio: CommandRuntimeStdioSchema,
  })
  .strict();

export const CommandRuntimeControlSchema = z.discriminatedUnion("type", [
  CommandRuntimeSpawnEnvelopeSchema,
  z
    .object({
      type: z.literal("resize"),
      protocolVersion: ProtocolVersionSchema,
      id: z.number().int().nonnegative(),
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("signal"),
      protocolVersion: ProtocolVersionSchema,
      signal: z.string(),
    })
    .strict(),
]);

export const CommandRuntimeProcessEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), protocolVersion: ProtocolVersionSchema }).strict(),
  z.object({ type: z.literal("eof"), protocolVersion: ProtocolVersionSchema }).strict(),
  z
    .object({
      type: z.literal("resized"),
      protocolVersion: ProtocolVersionSchema,
      id: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("exit"),
      protocolVersion: ProtocolVersionSchema,
      code: z.number().int().nullable(),
      signal: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      protocolVersion: ProtocolVersionSchema,
      message: z.string(),
    })
    .strict(),
]);

export interface CommandRuntimeMessageSchema<T> {
  parse(value: unknown): T;
}

export function encodeCommandRuntimeMessage<T>(
  schema: CommandRuntimeMessageSchema<T>,
  value: unknown,
): string {
  return `${JSON.stringify(schema.parse(value))}\n`;
}

export function createCommandRuntimeMessageDecoder<T>(schema: CommandRuntimeMessageSchema<T>): {
  push(chunk: Uint8Array | string): T[];
  finish(): void;
} {
  const decoder = new TextDecoder();
  let pending = "";
  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const messages: T[] = [];
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) throw new Error("Command runtime message frame is empty");
        messages.push(schema.parse(JSON.parse(line)));
        newline = pending.indexOf("\n");
      }
      return messages;
    },
    finish() {
      pending += decoder.decode();
      if (pending.length > 0) throw new Error("Command runtime message ended before newline");
    },
  };
}

export function createCommandRuntimeProcessEventDecoder(mode: "pipes" | "pty"): {
  push(chunk: Uint8Array | string): CommandRuntimeProcessEvent[];
  finish(): void;
} {
  const framing = createCommandRuntimeMessageDecoder(CommandRuntimeProcessEventSchema);
  let phase: "waiting-started" | "started" | "eof" | "exit" = "waiting-started";

  return {
    push(chunk) {
      const events = framing.push(chunk);
      for (const event of events) advance(event);
      return events;
    },
    finish() {
      framing.finish();
      if (phase !== "exit") {
        throw new Error(
          `${mode} wrapper ended without a valid fd4 exit event: incomplete started -> eof -> exit sequence`,
        );
      }
    },
  };

  function advance(event: CommandRuntimeProcessEvent): void {
    if (phase === "exit") {
      if (event.type === "exit") throw new Error("Command runtime returned duplicate exit");
      throw new Error(`Command runtime event after exit: ${event.type}`);
    }

    if (event.type === "started") {
      if (phase !== "waiting-started")
        throw new Error("Command runtime returned duplicate started");
      phase = "started";
      return;
    }
    if (event.type === "eof") {
      if (phase === "waiting-started")
        throw new Error("Command runtime returned eof before started");
      if (phase === "eof") throw new Error("Command runtime returned duplicate eof");
      phase = "eof";
      return;
    }
    if (event.type === "exit") {
      if (phase === "waiting-started")
        throw new Error("Command runtime returned exit before started");
      if (phase === "started") throw new Error("Command runtime returned exit before eof");
      phase = "exit";
      return;
    }
    if (event.type === "resized") {
      if (mode === "pipes") throw new Error("pipes runtime returned resized event");
      if (phase === "waiting-started") {
        throw new Error("PTY runtime returned resized before started");
      }
      if (phase === "eof") throw new Error("PTY runtime returned resized after eof");
    }
  }
}

export type CommandRuntimeLifecycleRequest = z.infer<typeof CommandRuntimeLifecycleRequestSchema>;
export type CommandRuntimeLifecycleResponse = z.infer<typeof CommandRuntimeLifecycleResponseSchema>;
export type CommandRuntimeState = z.infer<typeof CommandRuntimeStateSchema>;
export type CommandRuntimeInspection = z.infer<typeof CommandRuntimeInspectionSchema>;
export type CommandRuntimeSpawnEnvelope = z.infer<typeof CommandRuntimeSpawnEnvelopeSchema>;
export type CommandRuntimeControl = z.infer<typeof CommandRuntimeControlSchema>;
export type CommandRuntimeProcessEvent = z.infer<typeof CommandRuntimeProcessEventSchema>;
