import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "intake",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    useSystemOne: z.boolean().default(true),
    unansweredAction: z.enum(["recommended", "current", "wait"]).default("recommended"),
    waitSeconds: z.number().int().min(5).max(3600).default(60),
    minimumConfidence: z.number().min(0.5).max(1).default(0.85),
    newProjectParent: z.string().default(""),
    daemonHome: z.string().default(""),
  }),
});

export type IntakePreferences = z.infer<typeof preferences.schema>;
