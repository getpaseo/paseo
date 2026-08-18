import { defineRpc } from "@paseo/plugin";
import { z } from "zod";

export const incrementRpc = defineRpc({
  name: "increment",
  input: z.object({ value: z.number() }),
  output: z.object({ value: z.number(), handledBy: z.string() }),
});
