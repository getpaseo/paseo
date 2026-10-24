import pino from "pino";
// Isolated process fixture for restart/termination tests. Never targets a developer home.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { createTestAgentClients } from "./fake-agent-client.js";

const root = process.argv[2];
if (!root || !process.send) throw new Error("Expected isolated test home and IPC parent");
await mkdir(join(root, "static"), { recursive: true });
const held = Promise.withResolvers<void>();
const daemon = await createTestPaseoDaemon({
  paseoHomeRoot: root,
  staticDir: join(root, "static"),
  logger: pino({ level: "warn" }, pino.destination(join(root, "fixture.log"))),
  cleanup: false,
  mcpEnabled: true,
  agentClients: createTestAgentClients({
    onStartTurn: (prompt) => {
      if (String(prompt).includes('kind="agent-notification"')) {
        void appendFile(join(root, "parent-prompts.jsonl"), `${JSON.stringify(prompt)}\n`);
      }
    },
    beforeTurnComplete: (prompt) =>
      String(prompt).includes("HOLD_CHILD") ? held.promise : Promise.resolve(),
  }),
});
process.send({ port: daemon.port, paseoHome: daemon.paseoHome, cwd: daemon.staticDir });
process.on("message", (message) => {
  if (message === "finish") held.resolve();
  if (message === "stop") {
    void daemon.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  }
});
