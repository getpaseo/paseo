import type { CommandDirectory } from "./commands";

export const configuredCommandDirectories = [
  { relativeTo: "workspace", path: ".commands" },
] satisfies CommandDirectory[];
