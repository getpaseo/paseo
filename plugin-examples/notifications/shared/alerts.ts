import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const sendBuildAlert = defineRpc({
  name: "alerts.send",
  input: z.object({
    buildId: z.string(),
    title: z.string(),
    body: z.string(),
    key: z.string().optional(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("sent"),
      notificationId: z.string(),
    }),
    z.object({
      status: z.literal("deduplicated"),
    }),
    z.object({
      status: z.literal("rate_limited"),
    }),
  ]),
});
