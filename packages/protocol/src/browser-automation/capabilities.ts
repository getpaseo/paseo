import { z } from "zod";
import { BrowserAutomationCommandNameSchema } from "./rpc-schemas.js";

export const BrowserAutomationHostCapabilitySchema = z
  .object({
    supportedCommands: z.array(BrowserAutomationCommandNameSchema).default([]),
    hostKind: z.string().min(1).default("browser host"),
  })
  .passthrough();

export type BrowserAutomationHostCapability = z.infer<typeof BrowserAutomationHostCapabilitySchema>;
