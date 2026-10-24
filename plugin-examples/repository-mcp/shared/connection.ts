import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const connection = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: z.object({ url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default("") }),
});
