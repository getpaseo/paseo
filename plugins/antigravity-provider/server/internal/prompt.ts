import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { AntigravityError } from "./wire.js";

interface EncodedPrompt {
  text: string;
  nativeText: string;
}

export class PromptFiles {
  private directory: string | null = null;

  async encode(prompt: ProviderPrompt): Promise<EncodedPrompt> {
    if (
      prompt.input.type !== "message" ||
      prompt.delivery === "steer" ||
      prompt.outputSchema !== undefined
    )
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
    return { text: text.join("\n"), nativeText: native.join("\n") };
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
