// Kept free of Zod so configuration code can read tool groups without loading the wire schemas.
export const BUILTIN_TOOL_GROUPS = [
  "orchestration",
  "schedules",
  "changeRequests",
  "browser",
] as const;

export type BuiltInToolGroup = (typeof BUILTIN_TOOL_GROUPS)[number];

export const DEFAULT_DAEMON_TOOL_GROUPS = {
  orchestration: true,
  schedules: true,
  changeRequests: true,
  browser: false,
} as const satisfies Record<BuiltInToolGroup, boolean>;
