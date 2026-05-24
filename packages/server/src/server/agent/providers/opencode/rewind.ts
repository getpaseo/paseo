import { toDiagnosticErrorMessage } from "../diagnostic-utils.js";

export interface OpenCodeRewindClient {
  session: {
    revert(input: {
      sessionID: string;
      directory: string;
      messageID: string;
    }): Promise<{ error?: unknown }>;
  };
}

export async function revertOpenCodeConversationAndFiles(input: {
  client: OpenCodeRewindClient;
  sessionId: string;
  cwd: string;
  messageId: string;
}): Promise<void> {
  // OpenCode keeps unrevert available only until a later prompt triggers its cleanup,
  // which permanently drops reverted messages. Paseo v1 only exposes revert.
  const response = await input.client.session.revert({
    sessionID: input.sessionId,
    directory: input.cwd,
    messageID: input.messageId,
  });
  if (response.error) {
    throw new Error(toDiagnosticErrorMessage(response.error));
  }
}
