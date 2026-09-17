import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    groupBy: z.enum(["project", "workspace", "none"]).default("project"),
    showMetadata: z.boolean().default(true),
    title: z.string().trim().min(1, "Enter a title").max(40).default("Agent monitor"),
  }),
});
