import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Sends one frame back to the daemon, which reports what arrived. */
export const checkFrame = defineRpc({
  name: "media.frame.check",
  input: z.instanceof(Uint8Array),
  output: z.object({ bytes: z.number(), sha256: z.string() }),
});
