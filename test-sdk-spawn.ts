import { CodexAgentClient } from "@paseo/server/src/server/agent/providers/codex-agent.js";

async function test() {
  console.log("Creating CodexAgentClient...");
  const client = new CodexAgentClient();

  console.log("Creating session...");
  const session = await client.createSession({
    provider: "codex",
    cwd: process.cwd(),
    modeId: "full-access",
  });

  console.log("Session created:", session.id);
  console.log("\nNow check ps to see which codex binary is running!\n");

  // Run a simple prompt using stream to see all events
  console.log("Running test prompt...");
  console.log("Sleeping 30s - check ps for the args now!");
  await new Promise((resolve) => setTimeout(resolve, 30000));

  const events = session.stream('echo "test"');

  for await (const event of events) {
    if (event.type === "turn_completed") {
      console.log("Turn completed");
    }
  }

  await session.close();
  console.log("Session closed");
}

test().catch(console.error);
