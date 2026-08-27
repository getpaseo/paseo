import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

for await (const line of lines) {
  const command = JSON.parse(line);
  let data = {};
  if (command.type === "get_available_models") {
    data = {
      models: [
        {
          provider: "e2e",
          id: "pi-profile-model",
          name: "Pi profile model",
        },
      ],
    };
  } else if (command.type === "get_state") {
    data = {
      sessionId: "e2e-pi-session",
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }

  process.stdout.write(
    `${JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data,
    })}\n`,
  );
}
