import { z } from "zod";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  type BrowserAutomationCommandName,
} from "./rpc-schemas.js";

const KNOWN_BROWSER_AUTOMATION_COMMAND_NAMES = new Set<string>(BROWSER_AUTOMATION_COMMAND_NAMES);

export const BrowserAutomationHostCapabilitySchema = z
  .object({
    supportedCommands: z.array(z.string().min(1)).transform((commands, context) => {
      const supportedCommands: BrowserAutomationCommandName[] = [];
      const seen = new Set<BrowserAutomationCommandName>();

      for (const command of commands) {
        if (!isKnownBrowserAutomationCommandName(command) || seen.has(command)) {
          continue;
        }
        seen.add(command);
        supportedCommands.push(command);
      }

      if (supportedCommands.length === 0) {
        context.addIssue({
          code: "custom",
          message: "supportedCommands must include at least one known browser automation command",
        });
        return z.NEVER;
      }

      return supportedCommands;
    }),
    hostKind: z.string().min(1).default("browser host"),
  })
  .passthrough();

export type BrowserAutomationHostCapability = z.infer<typeof BrowserAutomationHostCapabilitySchema>;

function isKnownBrowserAutomationCommandName(value: string): value is BrowserAutomationCommandName {
  return KNOWN_BROWSER_AUTOMATION_COMMAND_NAMES.has(value);
}
