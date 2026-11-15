import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentPromptInput, SubmittedMessageFingerprint } from "../agent/agent-sdk-types.js";
import { messageFingerprint } from "./fingerprint.js";

export interface SubmittedMessageIdentity {
  agentId: string;
  clientMessageId: string;
  prompt: AgentPromptInput;
}

export interface AcceptedSubmittedMessage extends SubmittedMessageFingerprint {
  agentId: string;
}

const AcceptanceSchema = z.object({
  agentId: z.string(),
  clientMessageId: z.string(),
  promptFingerprint: z.string(),
});

/** Provider acknowledgements, independent of receipt commits and replayable timeline rows. */
export class MessageAcceptanceStore {
  constructor(private readonly directory: string) {}

  async record(input: AcceptedSubmittedMessage): Promise<void> {
    await writeJsonFileAtomic(this.fileFor(input), input);
  }

  async has(input: SubmittedMessageIdentity): Promise<boolean> {
    const expected = this.recordFor(input);
    try {
      const actual = AcceptanceSchema.parse(
        JSON.parse(await readFile(this.fileFor(expected), "utf8")),
      );
      return (
        actual.agentId === expected.agentId &&
        actual.clientMessageId === expected.clientMessageId &&
        actual.promptFingerprint === expected.promptFingerprint
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private recordFor(input: SubmittedMessageIdentity): z.infer<typeof AcceptanceSchema> {
    return {
      agentId: input.agentId,
      clientMessageId: input.clientMessageId,
      promptFingerprint: messageFingerprint(input.prompt),
    };
  }

  private fileFor(record: z.infer<typeof AcceptanceSchema>): string {
    return path.join(this.directory, `${messageFingerprint(record)}.json`);
  }
}
