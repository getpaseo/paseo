import { ClaudeAgentClient } from "./packages/server/src/server/agent/providers/claude-agent.js";

async function main() {
  const client = new ClaudeAgentClient();
  const results = await client.listPersistedAgents({ limit: 30 });
  console.log("Total results:", results.length);
  console.log("Results:");
  for (const r of results) {
    console.log(`  - ${r.sessionId.slice(0,8)} | ${r.cwd} | ${r.title?.slice(0,30)}`);
  }
  const target = results.find(r => r.sessionId.includes("0fea55e9"));
  if (target) {
    console.log("\nFound target session:", target.sessionId);
  } else {
    console.log("\nTarget session 0fea55e9 NOT FOUND in results");
  }
}
main().catch(console.error);
