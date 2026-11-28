import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const RESERVED_NAMES =
  /^(?:\.git|\.gitignore|\.gitmodules|\.worktreeinclude|paseo\.json|(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?)$/i;

export const target = z.object({
  projectId: z.string().min(1).max(128),
  root: z.string().min(1).max(2048),
  name: z
    .string()
    .regex(/^[\w.-]{1,255}$/)
    .refine(
      (name) => !name.endsWith(".") && !RESERVED_NAMES.test(name),
      "Choose a regular project file with a supported filename.",
    ),
});

export const inspectDestination = defineRpc({
  name: "local-files.inspect",
  input: target,
  output: z.object({ path: z.string(), status: z.enum(["ready", "exists", "not-ignored"]) }),
});

export const reviewedTarget = target.extend({ path: z.string().min(1).max(2304) });

export const importFile = defineRpc({
  name: "local-files.import",
  input: z.instanceof(Uint8Array),
  output: z.object({ path: z.string() }),
});
