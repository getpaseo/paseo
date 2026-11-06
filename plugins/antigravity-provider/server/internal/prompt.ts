import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { AntigravityError } from "./wire.js";

interface EncodedPrompt {
  text: string;
  nativeText: string;
}

const MAX_INLINE_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

export class PromptFiles {
  private directory: string | null = null;

  async encode(prompt: ProviderPrompt): Promise<EncodedPrompt> {
    if (
      prompt.input.type !== "message" ||
      prompt.delivery === "steer" ||
      prompt.outputSchema !== undefined
    )
      throw new AntigravityError("Antigravity supports messages only");

    const text: string[] = [];
    const native: string[] = [];

    for (const part of prompt.input.content) {
      if (part.type === "text") {
        text.push(part.text);
        native.push(part.text);
      } else if (part.type === "image") {
        const extension = imageExtension(part.mimeType);
        if (this.directory === null) {
          this.directory = await mkdtemp(path.join(os.tmpdir(), "paseo-antigravity-images-"));
          await chmod(this.directory, 0o700);
        }
        const file = path.join(this.directory, `${randomUUID()}.${extension}`);
        await writeFile(file, Buffer.from(part.data, "base64"), { flag: "wx", mode: 0o600 });
        await chmod(file, 0o600);
        native.push(`Attached image: ${file}`);
      } else if (part.type === "uploaded_file") {
        if (part.mimeType && part.mimeType.startsWith("image/")) {
          native.push(`Attached image: ${part.path}`);
        } else if (part.size > MAX_INLINE_FILE_BYTES) {
          const notice = `[Attached large file: ${part.fileName} at ${part.path} (${part.size} bytes)]`;
          text.push(notice);
          native.push(notice);
        } else {
          try {
            const content = await readFile(part.path, "utf8");
            const fileBlock = `[File: ${part.fileName}]\n${content}`;
            text.push(fileBlock);
            native.push(fileBlock);
          } catch {
            const notice = `[Attached file: ${part.fileName} at ${part.path}]`;
            text.push(notice);
            native.push(notice);
          }
        }
      } else {
        throw new AntigravityError(
          `Antigravity does not support content type: ${(part as { type?: string }).type ?? "unknown"}`,
        );
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
