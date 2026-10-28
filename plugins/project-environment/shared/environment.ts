import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const variableName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/)
  .max(128);
export const variableMetadata = z.object({ name: variableName, description: z.string().max(500) });
export const variableInput = variableMetadata.extend({
  value: z
    .string()
    .min(1)
    .max(16384)
    .refine((value) => !value.includes("\0"), "Values cannot contain a null character"),
});
const workspace = z.object({ workspaceId: z.string().min(1) });
export const listVariables = defineRpc({
  name: "environment.list",
  input: workspace,
  output: z.object({ variables: z.array(variableMetadata) }),
});
export const saveVariable = defineRpc({
  name: "environment.save",
  input: workspace.extend({ variable: variableInput }),
  output: z.object({}),
});
export const removeVariable = defineRpc({
  name: "environment.remove",
  input: workspace.extend({ name: variableName }),
  output: z.object({}),
});
