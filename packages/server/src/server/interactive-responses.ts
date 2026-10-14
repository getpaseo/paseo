import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  InteractiveDocumentSchema,
  validateInteractiveSource,
  validateInteractiveState,
  type InteractiveDocument,
  type InteractiveState,
} from "@getpaseo/protocol/interactive-response";
import { writeJsonFileAtomic } from "./atomic-file.js";

// Keep the unfinished JavaScript runtime out of normal releases.
export function interactiveResponsesEnabled(): boolean {
  return process.env.PASEO_EXPERIMENTAL_INTERACTIVE_RESPONSES === "1";
}

export class InteractiveResponseStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private file(id: string): string {
    return path.join(this.directory, `${z.string().uuid().parse(id)}.json`);
  }
  private async load(agentId: string, id: string): Promise<InteractiveDocument> {
    const document = InteractiveDocumentSchema.parse(
      JSON.parse(await fs.readFile(this.file(id), "utf8")),
    );
    if (document.agentId !== agentId)
      throw new Error("Interactive document not found for this agent");
    validateInteractiveSource(document.source);
    validateInteractiveState(document.source, document.state);
    return document;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async create(
    agentId: string,
    input: Pick<InteractiveDocument, "title" | "summary" | "source">,
  ): Promise<InteractiveDocument> {
    validateInteractiveSource(input.source);
    const document = InteractiveDocumentSchema.parse({
      ...input,
      agentId,
      id: randomUUID(),
      state: {},
      revision: 0,
    });
    await writeJsonFileAtomic(this.file(document.id), document);
    return document;
  }
  async get(agentId: string, id: string): Promise<InteractiveDocument> {
    await this.queue;
    return this.load(agentId, id);
  }
  update(
    agentId: string,
    id: string,
    revision: number,
    state: InteractiveState,
  ): Promise<InteractiveDocument> {
    return this.serialize(async () => {
      const document = await this.load(agentId, id);
      if (revision !== document.revision)
        throw new Error("Interactive revision conflict; reload before retrying");
      const nextState = validateInteractiveState(document.source, state);
      await writeJsonFileAtomic(
        path.join(this.directory, "revisions", document.id, `${document.revision}.json`),
        document.state,
      );
      document.state = nextState;
      document.revision++;
      await writeJsonFileAtomic(this.file(id), document);
      return document;
    });
  }
  freezeContext(
    agentId: string,
    messageId: string,
    reference: string,
    text: string,
  ): Promise<string> {
    return this.serialize(async () => {
      const key = createHash("sha256")
        .update(JSON.stringify([agentId, messageId]))
        .digest("hex");
      const file = path.join(this.directory, "deepen", `${key}.json`);
      try {
        const prior = z
          .object({ reference: z.string(), text: z.string() })
          .parse(JSON.parse(await fs.readFile(file, "utf8")));
        if (prior.reference !== reference) throw new Error("Deepening message identity reused");
        return prior.text;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeJsonFileAtomic(file, { reference, text });
      return text;
    });
  }
  snapshot(
    agentId: string,
    reference: { documentId: string; revision: number },
    messageId: string,
  ): Promise<InteractiveDocument> {
    return this.serialize(async () => {
      const key = createHash("sha256")
        .update(JSON.stringify([agentId, messageId]))
        .digest("hex");
      const file = path.join(this.directory, "sent", `${key}.json`);
      try {
        const prior = InteractiveDocumentSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
        if (
          prior.id !== reference.documentId ||
          prior.revision !== reference.revision ||
          prior.agentId !== agentId
        )
          throw new Error("Interactive message identity reused");
        return prior;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const document = await this.load(agentId, reference.documentId);
      if (reference.revision > document.revision) throw new Error("Invalid interactive revision");
      if (document.revision !== reference.revision) {
        const state = JSON.parse(
          await fs.readFile(
            path.join(this.directory, "revisions", document.id, `${reference.revision}.json`),
            "utf8",
          ),
        );
        document.state = validateInteractiveState(document.source, state);
        document.revision = reference.revision;
      }
      await writeJsonFileAtomic(file, document);
      return document;
    });
  }
}
const stores = new Map<string, InteractiveResponseStore>();
export function interactiveResponsesForHome(home: string): InteractiveResponseStore {
  const directory = path.join(home, "conversation-ui");
  let store = stores.get(directory);
  if (!store) {
    store = new InteractiveResponseStore(directory);
    stores.set(directory, store);
  }
  return store;
}
