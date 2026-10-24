import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const incrementPreferenceCount = defineRpc({
  name: "preferences.increment-count",
  input: z.object({ amount: z.number().int().positive().default(1) }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved"), count: z.number().int() }),
    z.object({ status: z.literal("invalid"), code: z.string() }),
  ]),
});
