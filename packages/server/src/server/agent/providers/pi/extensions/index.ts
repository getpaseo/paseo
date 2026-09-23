import { PiExtensionHost } from "./host.js";
import { piExtensions } from "./registry.js";

export type { PiExtensionHost } from "./host.js";

export function createPiExtensionHost(): PiExtensionHost {
  return new PiExtensionHost(piExtensions);
}
