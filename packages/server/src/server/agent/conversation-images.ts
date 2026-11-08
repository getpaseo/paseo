import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  TimelineImageIdSchema,
  StoredTimelineImageSchema,
  TimelineImageSchema,
  type TimelineImage,
} from "@getpaseo/protocol/timeline-image";
import type { AgentTimelineItem, UserImageSource } from "./agent-sdk-types.js";

import { MAX_PROVIDER_IMAGE_BYTES } from "./providers/provider-image-output.js";

const MAX_IMAGE_BYTES = MAX_PROVIDER_IMAGE_BYTES;
const BindingsSchema = z.record(z.string(), z.array(TimelineImageSchema));
const BindingRecordSchema = z.object({
  identities: z.array(z.string()),
  images: z.array(TimelineImageSchema),
});
interface BindingState {
  bindings: Map<string, TimelineImage[]>;
  nextSequence: bigint;
}
type UserMessage = Extract<AgentTimelineItem, { type: "user_message" }>;

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function inlineUserImages(
  content: string | readonly { type: string; data?: string; mimeType?: string }[],
): UserImageSource[] {
  if (typeof content === "string") return [];
  return content
    .filter((block) => block.type === "image")
    .map((block) => {
      const mimeType = block.mimeType ?? "image/png";
      if (!block.data || block.data.startsWith("blob:")) return { kind: "unavailable", mimeType };
      if (block.data.startsWith("data:")) return userImageUrl(block.data, mimeType);
      return { kind: "base64", data: block.data, mimeType };
    });
}

export function userImageUrl(url: string, mimeType = "image/png"): UserImageSource {
  const match = /^data:(image\/[^;,]+);base64,([\s\S]*)$/.exec(url);
  return match
    ? { kind: "base64", mimeType: match[1], data: match[2] }
    : { kind: "unavailable", mimeType };
}

const CodexImageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), url: z.string() }),
  z.object({ type: z.literal("localImage"), path: z.string() }),
]);

export function codexUserImages(content: unknown): UserImageSource[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): UserImageSource[] => {
    const image = CodexImageSchema.safeParse(block);
    if (!image.success) return [];
    return image.data.type === "image"
      ? [userImageUrl(image.data.url)]
      : [{ kind: "file", path: image.data.path, mimeType: "image/png" }];
  });
}

const ClaudeImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("base64"), data: z.string(), media_type: z.string() }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
});

export function claudeUserImages(content: unknown): UserImageSource[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): UserImageSource[] => {
    const parsed = ClaudeImageBlockSchema.safeParse(block);
    if (!parsed.success) return [];
    const source = parsed.data.source;
    return source.type === "base64"
      ? [{ kind: "base64", data: source.data, mimeType: source.media_type }]
      : [{ kind: "unavailable", mimeType: "image/png" }];
  });
}

export class ConversationImageStore {
  private readonly root: string;
  private readonly bindings = new Map<string, Promise<BindingState>>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(paseoHome: string) {
    this.root = path.join(paseoHome, "conversation-images");
  }

  private async atomicWrite(target: string, bytes: Uint8Array | string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  private load(agentId: string): Promise<BindingState> {
    const cached = this.bindings.get(agentId);
    if (cached) return cached;
    const loading = this.loadBindings(agentId).catch((error) => {
      this.bindings.delete(agentId);
      throw error;
    });
    this.bindings.set(agentId, loading);
    return loading;
  }

  private async loadBindings(agentId: string): Promise<BindingState> {
    const state: BindingState = { bindings: new Map(), nextSequence: 0n };
    // Existing manifests are a read-only seed; new binds never rewrite them.
    try {
      const seed = BindingsSchema.parse(JSON.parse(await readFile(this.manifest(agentId), "utf8")));
      for (const [identity, images] of Object.entries(seed)) state.bindings.set(identity, images);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    let filenames: string[];
    try {
      filenames = await readdir(this.records(agentId));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return state;
    }
    const records = filenames.filter((filename) => /^\d+\.json$/.test(filename));
    records.sort((left, right) => {
      const a = BigInt(left.slice(0, -5));
      const b = BigInt(right.slice(0, -5));
      if (a === b) return 0;
      return a < b ? -1 : 1;
    });
    for (const filename of records) {
      const record = BindingRecordSchema.parse(
        JSON.parse(await readFile(path.join(this.records(agentId), filename), "utf8")),
      );
      for (const identity of record.identities) state.bindings.set(identity, record.images);
      state.nextSequence = BigInt(filename.slice(0, -5)) + 1n;
    }
    return state;
  }

  private manifest(agentId: string): string {
    return path.join(this.root, "agents", `${digest(agentId)}.json`);
  }

  private records(agentId: string): string {
    return path.join(this.root, "agents", digest(agentId));
  }

  async bind(agentId: string, identities: string[], images: TimelineImage[]): Promise<void> {
    if (!images.length || !identities.length) return;
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.load(agentId);
      const serializedImages = JSON.stringify(images);
      if (identities.every((id) => JSON.stringify(state.bindings.get(id)) === serializedImages))
        return;
      // One record commits every alias together, with work proportional to this message only.
      await this.atomicWrite(
        path.join(this.records(agentId), `${state.nextSequence}.json`),
        JSON.stringify({ identities: [...new Set(identities)], images }),
      );
      state.nextSequence++;
      for (const identity of identities) state.bindings.set(identity, images);
      return;
    });
    this.tails.set(
      agentId,
      operation.catch(() => undefined),
    );
    await operation;
  }

  async normalize(agentId: string, item: UserMessage): Promise<UserMessage> {
    const { imageSources, ...message } = item;
    const { bindings } = await this.load(agentId);
    const existing = item.messageId ? bindings.get(item.messageId) : undefined;
    const hasDurableImages = existing?.every((image) => image.kind === "stored");
    const recovered = hasDurableImages
      ? existing
      : (item.images ?? (await this.capture(imageSources ?? [])));
    const images = existing
      ? existing.map((image, index) =>
          image.kind === "stored" ? image : (recovered[index] ?? image),
        )
      : recovered;
    await this.bind(agentId, item.messageId ? [item.messageId] : [], images);
    return images.length ? { ...message, images } : message;
  }

  async capture(sources: readonly UserImageSource[]): Promise<TimelineImage[]> {
    const images: TimelineImage[] = [];
    for (const source of sources) {
      if (source.kind === "unavailable") {
        images.push(source);
        continue;
      }
      let bytes: Buffer;
      if (source.kind === "base64") {
        if (source.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
          throw new Error("Image is too large");
        bytes = Buffer.from(source.data, "base64");
        if (bytes.toString("base64") !== source.data) throw new Error("Invalid image base64");
      } else {
        const recovered = await this.importInputFile(source.path);
        if (!recovered) {
          images.push({ kind: "unavailable", mimeType: source.mimeType });
          continue;
        }
        bytes = recovered;
      }
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is too large");
      const image = StoredTimelineImageSchema.parse({
        kind: "stored",
        id: digest(bytes),
        mimeType: source.mimeType,
        byteSize: bytes.length,
      });
      await this.atomicWrite(path.join(this.root, image.id), bytes);
      images.push(image);
    }
    return images;
  }

  private async importInputFile(filename: string): Promise<Buffer | null> {
    // Only Paseo's own provider input files are importable. Transcript paths are not authority.
    const parent = path.dirname(filename);
    const isInputFile =
      path.dirname(parent) === tmpdir() && path.basename(parent).startsWith("paseo-attachments-");
    const match = /^([0-9a-f]{64})\.[a-zA-Z0-9]+$/.exec(path.basename(filename));
    if (!isInputFile || !match) return null;
    let bytes: Buffer;
    try {
      return await this.read(match[1]);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      const directory = await lstat(parent);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
      bytes = await this.readRegular(filename);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    if (digest(bytes) !== match[1]) throw new Error("Image content does not match its id");
    return bytes;
  }

  private async readRegular(filename: string): Promise<Buffer> {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error("Invalid image file");
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async read(id: string): Promise<Buffer> {
    TimelineImageIdSchema.parse(id);
    const bytes = await this.readRegular(path.join(this.root, id));
    if (digest(bytes) !== id) throw new Error("Image content does not match its id");
    return bytes;
  }
}
