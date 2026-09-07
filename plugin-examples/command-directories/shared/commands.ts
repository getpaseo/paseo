import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CommandDirectorySchema = z
  .object({
    relativeTo: z.enum(["workspace", "project", "absolute"]),
    path: z.string().trim().min(1),
  })
  .strict();

export type CommandDirectory = z.infer<typeof CommandDirectorySchema>;

export const CommandDescriptorSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    argumentHint: z.string(),
  })
  .strict();

const CommandContextSchema = z
  .object({
    workspaceDirectory: z.string().min(1),
    projectRootPath: z.string().min(1),
    directories: z.array(CommandDirectorySchema),
  })
  .strict();

export const listCommandsRpc = defineRpc({
  name: "commands.list",
  input: CommandContextSchema,
  output: z.object({ commands: z.array(CommandDescriptorSchema) }).strict(),
});

export const resolveCommandRpc = defineRpc({
  name: "commands.resolve",
  input: CommandContextSchema.extend({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    args: z.string(),
  }),
  output: z.object({ prompt: z.string() }).strict(),
});
