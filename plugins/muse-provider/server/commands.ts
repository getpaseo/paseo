import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { TurnStartParams } from "./msp.js";
import { MspConnection } from "./connection.js";
import { ackSchema, skillsSchema } from "./wire.js";
import { MuseError } from "./errors.js";

export class Commands {
  private selectors = new Set<string>();
  constructor(
    private readonly host: MspConnection,
    private readonly sessionId: string,
    private readonly id: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  async refresh(): Promise<void> {
    const { skills } = await this.host.request(
      "skill/list",
      { sessionId: this.sessionId },
      skillsSchema,
    );
    this.selectors = new Set(skills.map((skill) => skill.selector));
    this.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: [
        { name: "compact", description: "Compact conversation context" },
        ...skills
          .filter((skill) => skill.selector !== "compact")
          .map((skill) => ({
            name: skill.selector,
            description: skill.description,
            argumentHint: skill.argumentHint,
          })),
      ],
    });
  }
  async compact(prompt: ProviderPrompt): Promise<boolean> {
    if (prompt.input.type !== "command" || prompt.input.name !== "compact") return false;
    await this.host.command("session/compact", { sessionId: this.sessionId }, ackSchema);
    this.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "completed" },
    });
    return true;
  }
  input(
    command: Extract<ProviderPrompt["input"], { type: "command" }>,
  ): TurnStartParams["input"][number] {
    if (!this.selectors.has(command.name))
      throw new MuseError("unknownCommand", `Muse skill is unavailable: ${command.name}`);
    return { type: "skill", selector: command.name, arguments: command.arguments };
  }
}
