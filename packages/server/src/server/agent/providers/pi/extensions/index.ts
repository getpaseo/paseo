import { PiExtensionHost } from "./host.js";
import { piExtensions } from "./registry.js";

export function createPiExtensionHost(): PiExtensionHost {
  return new PiExtensionHost(piExtensions);
}
