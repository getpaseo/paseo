import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { extractLeadingCommandName } from "./commands.js";
import { AntigravityError } from "./wire.js";

export interface EncodedPrompt {
  text: string;
  nativeText: string;
  isSlashCommand: boolean;
}

export class PromptFiles {
  private directory: string | null = null;

  async encode(prompt: ProviderPrompt, knownCommands: ReadonlySet<string>): Promise<EncodedPrompt> {
    if (prompt.delivery === "steer" || prompt.outputSchema !== undefined)
      throw new AntigravityError("Antigravity supports messages and commands only");
    if (prompt.input.type === "command") {
      if (!knownCommands.has(prompt.input.name))
        throw new AntigravityError(
          `Unknown Antigravity command: ${prompt.input.name}`,
          "UNKNOWN_COMMAND",
        );
      const args = prompt.input.arguments.trim();
      const commandText = args ? `/${prompt.input.name} ${args}` : `/${prompt.input.name}`;
      return {
        text: commandText,
        nativeText: commandText,
        isSlashCommand: true,
      };
    }
    const parts = prompt.input.content.map((part) => {
      if (part.type === "text") return part;
      if (part.type === "image") return { ...part, extension: imageExtension(part.mimeType) };
      throw new AntigravityError("Antigravity supports text and image content only");
    });
    const text: string[] = [];
    const native: string[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        text.push(part.text);
        native.push(part.text);
      } else if (part.type === "image") {
        const extension = part.extension;
        if (this.directory === null) {
          this.directory = await mkdtemp(path.join(os.tmpdir(), "paseo-antigravity-images-"));
          await chmod(this.directory, 0o700);
        }
        const file = path.join(this.directory, `${randomUUID()}.${extension}`);
        await writeFile(file, Buffer.from(part.data, "base64"), { flag: "wx", mode: 0o600 });
        await chmod(file, 0o600);
        native.push(`Attached image: ${file}`);
      }
    }
    const nativeText = native.join("\n");
    const leadingCommand = extractLeadingCommandName(nativeText);
    const isSlashCommand = leadingCommand !== null && knownCommands.has(leadingCommand);
    return { text: text.join("\n"), nativeText, isSlashCommand };
  }

  async close(): Promise<void> {
    if (this.directory !== null) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = null;
    }
  }
}

function imageExtension(mimeType: string): string {
  const match = /^image\/([a-z0-9][a-z0-9.+-]*)$/i.exec(mimeType);
  if (!match) throw new AntigravityError(`Expected an image MIME type, received ${mimeType}`);
  const subtype = match[1].toLowerCase();
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  return subtype;
}
