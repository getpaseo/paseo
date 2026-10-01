import type { OpenCodeClient } from "@opencode/client";

export interface V2Api {
  server: OpenCodeClient["server"];
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
  > & {
    form: Pick<OpenCodeClient["session"]["form"], "list" | "reply" | "cancel">;
  };
  plugin: Pick<OpenCodeClient["plugin"], "list">;
  model: OpenCodeClient["model"];
  provider: Pick<OpenCodeClient["provider"], "list">;
  agent: Pick<OpenCodeClient["agent"], "list">;
  command: OpenCodeClient["command"];
  skill: OpenCodeClient["skill"];
  message: OpenCodeClient["message"];
  mcp: Pick<OpenCodeClient["mcp"], "add" | "list">;
  permission: Pick<OpenCodeClient["permission"], "list" | "reply">;
  event: OpenCodeClient["event"];
}
