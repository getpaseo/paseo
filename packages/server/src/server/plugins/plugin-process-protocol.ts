export type PluginProcessRequest =
  | { type: "initialize"; bundle: string }
  | { type: "invoke"; requestId: string; method: string; input: unknown }
  | { type: "shutdown" };

export type PluginProcessMessage =
  | { type: "ready"; methods: string[] }
  | { type: "result"; requestId: string; output: unknown }
  | { type: "error"; requestId: string; error: string }
  | { type: "fatal"; error: string };
