import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { AntigravityError } from "./wire.js";

interface EncodedPrompt {
  text: string;
  nativeText: string;
  /**
   * Whether `agy` must expand a leading `/name`: commands need expansion, a
   * message starting with `/` must reach the model literally, and any other
   * message works either way (`null`).
   */
  slashCommands: boolean | null;
}

/** Native `agy` slash commands that Paseo publishes for Antigravity sessions. */
export const commands = [
  {
    name: "goal",
    description: "Keep working until an objective is complete",
    argumentHint: "<objective>",
  },
];

export class PromptFiles {
  private directory: string | null = null;

  async encode(prompt: ProviderPrompt): Promise<EncodedPrompt> {
    if (prompt.delivery === "steer" || prompt.outputSchema !== undefined)
      throw new AntigravityError("Antigravity supports messages only");
    if (prompt.input.type === "command") {
      const { name } = prompt.input;
      if (!commands.some((command) => command.name === name))
        throw new AntigravityError(`Antigravity command is unavailable: /${name}`);
      const args = prompt.input.arguments.trim();
      const text = args ? `/${name} ${args}` : `/${name}`;
      return { text, nativeText: text, slashCommands: true };
    }
    if (prompt.input.type !== "message")
      throw new AntigravityError("Antigravity supports messages only");
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
    return {
      text: text.join("\n"),
      nativeText,
      slashCommands: nativeText.trimStart().startsWith("/") ? false : null,
    };
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
