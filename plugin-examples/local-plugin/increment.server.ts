import type { output as ZodOutput } from "zod";
import { incrementRpc } from "./increment.shared";

export function increment(input: ZodOutput<typeof incrementRpc.input>) {
  return {
    value: input.value + 1,
    handledBy: "plugin subprocess",
  };
}
