import type { output as ZodOutput } from "zod";
import { incrementRpc } from "../shared/increment";

export function increment(input: ZodOutput<typeof incrementRpc.input>) {
  return {
    value: input.value + 1,
    handledBy: "plugin subprocess",
  };
}
