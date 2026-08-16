import { fileURLToPath } from "node:url";

export const WORKSPACE_HELPER_PROTOCOL_VERSION = 1 as const;
export const workspaceHelperExecutable = fileURLToPath(
  new URL("./executable.mjs", import.meta.url),
);
