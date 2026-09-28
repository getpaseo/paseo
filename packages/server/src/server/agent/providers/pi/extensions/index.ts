import { PiExtensionHost } from "./host.js";
import { piExtensions } from "./registry.js";
import type { Logger } from "pino";
import type { PiExtension } from "./contract.js";
import type { PiChildSessionScheduler } from "./child-session-follower.js";
import type { PiExtensionEventOutput, PiExtensionFollowOptions } from "./host.js";

export type {
  PiExtensionHost,
  PiExtensionEventOutput,
  PiExtensionFollowOptions,
  PiChildSessionScheduler,
};

export function createPiExtensionHost(
  logger?: Pick<Logger, "warn">,
  extensions: readonly PiExtension[] = piExtensions,
  hydrationByteBudget?: number,
  follow?: PiExtensionFollowOptions,
): PiExtensionHost {
  return new PiExtensionHost(extensions, logger, hydrationByteBudget, undefined, follow);
}
