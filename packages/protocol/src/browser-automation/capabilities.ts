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

/**
 * What a host must be able to do before the daemon offers a mirror of its tabs.
 * A host that only drives an agent registers without these, and its tabs stay
 * out of the mirror UI rather than reaching a subscribe that cannot succeed.
 */
export const BROWSER_MIRROR_COMMAND_NAMES = [
  "input_at",
  "screencast_start",
  "screencast_stop",
] as const satisfies readonly BrowserAutomationCommandName[];

export function supportsBrowserMirror(
  supportedCommands: Iterable<BrowserAutomationCommandName>,
): boolean {
  const available = new Set<BrowserAutomationCommandName>(supportedCommands);
  return BROWSER_MIRROR_COMMAND_NAMES.every((command) => available.has(command));
}

function isKnownBrowserAutomationCommandName(value: string): value is BrowserAutomationCommandName {
  return KNOWN_BROWSER_AUTOMATION_COMMAND_NAMES.has(value);
}
