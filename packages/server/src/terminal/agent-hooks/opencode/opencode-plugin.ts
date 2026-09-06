import type { AgentHookPluginFileInstallStrategy } from "../agent-hook-installer.js";

// The plugin must load under both OpenCode generations because both read the
// same global config directory:
//
// - OpenCode 2 rejects V1 hook-object plugins and requires a default-exported
//   definition object with an id and a setup() function. Unknown keys are
//   ignored, so the 1.x server entrypoint below is inert there. Events arrive
//   through ctx.event.subscribe() as decoded payloads shaped { type, data }.
// - OpenCode 1 accepts a default-exported object exposing a callable server()
//   entrypoint (an id is required for path plugins). Bus events arrive through
//   the returned `event` hook as payloads shaped { type, properties }.
export const OPENCODE_PLUGIN_SOURCE = [
  "const STATUS_EVENTS = {",
  '  busy: "session.status.busy",',
  '  retry: "session.status.retry",',
  '  idle: "session.status.idle",',
  "};",
  "",
  "function paseoEventFor(type, statusType) {",
  '  if (type === "permission.asked") return "permission.asked";',
  '  if (type === "permission.replied") return "permission.replied";',
  '  if (type !== "session.status") return null;',
  "  return STATUS_EVENTS[statusType] ?? null;",
  "}",
  "",
  "function runPaseoHook(event) {",
  "  if (!process.env.PASEO_TERMINAL_ID) return;",
  "  try {",
  '    const child = Bun.spawn(["paseo", "hooks", "opencode", event], {',
  '      stdin: "ignore",',
  '      stdout: "ignore",',
  '      stderr: "ignore",',
  "    });",
  "    void child.exited.catch(() => {});",
  "  } catch {}",
  "}",
  "",
  "export default {",
  '  id: "paseo-terminal-activity",',
  "  server() {",
  "    return {",
  "      event: async ({ event }) => {",
  "        const paseoEvent = paseoEventFor(event?.type, event?.properties?.status?.type);",
  "        if (paseoEvent) runPaseoHook(paseoEvent);",
  "      },",
  "    };",
  "  },",
  "  setup(ctx) {",
  "    const controller = new AbortController();",
  "    void (async () => {",
  "      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {",
  "        const paseoEvent = paseoEventFor(event?.type, event?.data?.status?.type);",
  "        if (paseoEvent) runPaseoHook(paseoEvent);",
  "      }",
  "    })().catch(() => {});",
  "    return () => controller.abort();",
  "  },",
  "};",
  "",
].join("\n");

export function createOpenCodePluginInstallStrategy(): AgentHookPluginFileInstallStrategy {
  return {
    kind: "plugin-file",
    configDir: "opencode",
    configDirBase: "xdg-config",
    configFile: "plugins/paseo-terminal-activity.js",
    configDirEnvOverride: "OPENCODE_CONFIG_DIR",
    hookMarker: "paseo hooks opencode",
    source: OPENCODE_PLUGIN_SOURCE,
  };
}
