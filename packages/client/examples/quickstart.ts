import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });

await client.connect();

try {
  const agent = await client.agents.create({
    config: {
      provider: "codex/gpt-5.5",
    },
    cwd: process.cwd(),
    prompt: "Inspect this repository and name the next useful task.",
  });

  const result = await agent.waitForFinish();
  if (result.status !== "idle") {
    throw new Error(result.error ?? `Agent stopped with status: ${result.status}`);
  }

  console.log(result.lastMessage);
} finally {
  await client.close();
}
