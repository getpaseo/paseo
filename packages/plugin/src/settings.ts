import { z } from "zod";
import type { ZodType } from "zod";
import { defineRpc } from "./rpc.js";

export interface SettingsDefinition<Schema extends ZodType = ZodType> {
  id: string;
  scope: "host";
  version: number;
  schema: Schema;
  /** Convert a previous stored version to the current schema. Runs on the host. */
  migrate?: (values: unknown, fromVersion: number) => unknown | Promise<unknown>;
}

export function defineSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsDefinition<Schema> {
  if (!/^[a-z][a-z0-9_-]*$/.test(definition.id)) throw new Error("Invalid settings ID");
  if (definition.scope !== "host") throw new Error("Only host-scoped settings are supported");
  if (!Number.isSafeInteger(definition.version) || definition.version < 1)
    throw new Error("Invalid settings version");
  return definition;
}

export const SettingsReadResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), revision: z.string(), values: z.json() }),
  z.object({ status: z.literal("invalid"), revision: z.string(), error: z.string() }),
]);
export const SettingsWriteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), revision: z.string(), values: z.json() }),
  z.object({ status: z.literal("conflict"), error: z.string() }),
  z.object({ status: z.literal("invalid"), error: z.string() }),
]);
export function settingsRpc(id: string) {
  return {
    read: defineRpc({
      name: `settings.${id}.read`,
      input: z.object({}),
      output: SettingsReadResultSchema,
    }),
    write: defineRpc({
      name: `settings.${id}.write`,
      input: z.object({ revision: z.string(), values: z.json() }),
      output: SettingsWriteResultSchema,
    }),
    reset: defineRpc({
      name: `settings.${id}.reset`,
      input: z.object({ revision: z.string() }),
      output: SettingsWriteResultSchema,
    }),
  };
}
