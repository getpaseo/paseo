import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginMcpBindRequest } from "@getpaseo/plugin/server";
import { writeJsonFileAtomic } from "../atomic-file.js";

const openingSchema = z.object({ id: z.string().uuid(), digest: z.string() }).strict();
const requestReceiptSchema = z
  .object({
    opening: openingSchema,
    fingerprint: z.string(),
    status: z.enum(["pending", "committed"]),
  })
  .strict();
const openingRecordSchema = z
  .object({
    opening: openingSchema,
    status: z.enum(["pending", "committed"]),
    requests: z.record(z.string(), requestReceiptSchema).optional(),
  })
  .strict();
type OpeningRecord = z.infer<typeof openingRecordSchema>;
export interface ManagedOpeningRequest {
  key: string;
  fingerprint: string;
}

export class ManagedOpeningReplayError extends Error {
  constructor(readonly opening: PluginMcpBindRequest["opening"]) {
    super(`Managed MCP opening ${opening.id} (${opening.digest}) was already committed`);
  }
}

/** Pending disposition never authorizes replay after losing the owning invocation. */
export class ManagedOpeningStore {
  constructor(private readonly directory: string) {}

  async assertUnusedIdentity(identity: string): Promise<void> {
    const previous = await this.read(this.file(identity));
    if (!previous) return;
    if (previous.status === "pending") this.unknown(previous.opening);
    throw new Error(
      "Managed MCP identity was already used; reconcile it and start a fresh execution",
    );
  }

  async checkRequest(
    agentId: string,
    request: ManagedOpeningRequest,
  ): Promise<PluginMcpBindRequest["opening"] | null> {
    return this.receipt(await this.read(this.file(agentId)), request);
  }

  async begin(
    agentId: string,
    opening: PluginMcpBindRequest["opening"],
    request?: ManagedOpeningRequest,
  ): Promise<() => Promise<void>> {
    const file = this.file(agentId);
    const previous = await this.read(file);
    const replay = request ? this.receipt(previous, request) : null;
    if (replay) throw new ManagedOpeningReplayError(replay);
    if (previous?.status === "pending") this.unknown(previous.opening);
    const requests = { ...previous?.requests };
    const key = request ? this.requestKey(request) : undefined;
    if (key && request)
      requests[key] = { opening, fingerprint: request.fingerprint, status: "pending" };
    await writeJsonFileAtomic(
      file,
      { opening, status: "pending", ...(Object.keys(requests).length ? { requests } : {}) },
      { durable: true },
    );
    return async () => {
      const current = await this.read(file);
      if (
        current?.opening.id !== opening.id ||
        current.opening.digest !== opening.digest ||
        current.status !== "pending"
      ) {
        throw new Error("Managed MCP opening commit conflict");
      }
      if (key && current.requests?.[key]) current.requests[key].status = "committed";
      await writeJsonFileAtomic(file, { ...current, status: "committed" }, { durable: true });
    };
  }

  private receipt(
    record: OpeningRecord | undefined,
    request: ManagedOpeningRequest,
  ): PluginMcpBindRequest["opening"] | null {
    const receipt = record?.requests?.[this.requestKey(request)];
    if (!receipt) return null;
    if (receipt.fingerprint !== request.fingerprint)
      throw new Error("Managed MCP opening request body conflicts with its receipt");
    if (record?.status === "pending" || receipt.status === "pending")
      this.unknown(record?.opening ?? receipt.opening);
    return receipt.opening;
  }

  private unknown(opening: PluginMcpBindRequest["opening"]): never {
    throw new Error(
      `Managed MCP opening ${opening.id} (${opening.digest}) has an unknown outcome; reconcile it and start a fresh execution`,
    );
  }

  private file(agentId: string): string {
    return path.join(this.directory, `${createHash("sha256").update(agentId).digest("hex")}.json`);
  }

  private requestKey(request: ManagedOpeningRequest): string {
    return createHash("sha256").update(request.key).digest("hex");
  }

  private async read(file: string): Promise<OpeningRecord | undefined> {
    try {
      return openingRecordSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }
}
