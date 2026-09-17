import type { OpenCodeClient } from "@opencode/client";

export interface V2Api {
  health: OpenCodeClient["health"];
  session: Pick<
    OpenCodeClient["session"],
    | "create"
    | "get"
    | "list"
    | "active"
    | "remove"
    | "switchAgent"
    | "switchModel"
    | "environment"
    | "instructions"
    | "prompt"
    | "command"
    | "compact"
    | "wait"
    | "interrupt"
    | "revert"
    | "log"
  >;
  plugin: Pick<OpenCodeClient["plugin"], "awaitActivation" | "list">;
  model: OpenCodeClient["model"];
  provider: Pick<OpenCodeClient["provider"], "list">;
  agent: Pick<OpenCodeClient["agent"], "list">;
  command: OpenCodeClient["command"];
  skill: OpenCodeClient["skill"];
  message: OpenCodeClient["message"];
  mcp: Pick<OpenCodeClient["mcp"], "add" | "list">;
  permission: Pick<OpenCodeClient["permission"], "list" | "reply" | "rules">;
  form: Pick<OpenCodeClient["form"], "list" | "reply" | "cancel">;
  event: OpenCodeClient["event"];
}
